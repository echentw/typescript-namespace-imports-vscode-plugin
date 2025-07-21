import * as vscode from "vscode";
import { PathMapping, TypeScriptProject, findProjectForFile, uriToCompletionItemForProject } from "./uri_helpers";
import * as Path from "path";
import * as ts from "typescript";
import { CompletionItemsCache } from "./completion_items_cache";
import { CompletionItemMapImpl } from "./completion_item_map_impl";

interface Workspace {
    workspaceFolder: vscode.WorkspaceFolder;
    projects: TypeScriptProject[];
    fileToProjectCache: Map<string, TypeScriptProject>;
}

/**
 * Creates a cache of module completion items backed by aa map that is split by the first character
 * of each module name
 *
 * TODO: Using this map makes intellisense quick even in large projects, but a more elegant
 * solution might be to implement some type of trie tree for CompletionItems
 */
export class CompletionItemsCacheImpl implements CompletionItemsCache {
    // Map from workspaceFolder.name -> cached workspace data
    private _cache: Record<string, Workspace> = {};

    constructor(workspaceFolders: readonly vscode.WorkspaceFolder[]) {
        workspaceFolders.forEach(this._addWorkspace);
    }

    handleWorkspaceChange = (event: vscode.WorkspaceFoldersChangeEvent): void => {
        event.added.forEach(this._addWorkspace);
        event.removed.forEach(this._removeWorkspace);
    };

    addFile = (uri: vscode.Uri) => {
        const workspaceFolder = this._getWorkspaceFolderFromUri(uri);
        if (workspaceFolder) {
            const workspace = this._cache[workspaceFolder.name];

            if (workspace) {
                const project = this._findProjectForFile(uri, workspace);
                if (project && project.completionItemsMap) {
                    const item = uriToCompletionItemForProject(uri, project);
                    project.completionItemsMap.putItem(item);
                    workspace.fileToProjectCache.set(uri.path, project);
                } else {
                    console.warn(`No TypeScript project found for file: ${uri.path}`);
                }
            } else {
                console.error("Cannot add item: Workspace has not been cached");
            }
        }

        return;
    };

    deleteFile = (uri: vscode.Uri) => {
        const workspaceFolder = this._getWorkspaceFolderFromUri(uri);
        if (workspaceFolder) {
            const workspace = this._cache[workspaceFolder.name];

            if (workspace) {
                const project = workspace.fileToProjectCache.get(uri.path) || 
                                this._findProjectForFile(uri, workspace);
                
                if (project && project.completionItemsMap) {
                    const item = uriToCompletionItemForProject(uri, project);
                    project.completionItemsMap.removeItem(item);
                    workspace.fileToProjectCache.delete(uri.path);
                }
            }
        }

        return;
    };

    getCompletionList = (currentUri: vscode.Uri, query: string): vscode.CompletionList | [] => {
        const workspaceFolder = this._getWorkspaceFolderFromUri(currentUri);

        if (!workspaceFolder) {
            return [];
        }

        const workspace = this._cache[workspaceFolder.name];

        if (!workspace) {
            console.warn("Workspace was not in cache");
            return [];
        }

        const currentProject = workspace.fileToProjectCache.get(currentUri.path) ||
                              this._findProjectForFile(currentUri, workspace);

        if (!currentProject || !currentProject.completionItemsMap) {
            console.warn(`No TypeScript project found for current file: ${currentUri.path}`);
            return [];
        }

        const items = currentProject.completionItemsMap.getItemsAt(this._getPrefix(query));

        return new vscode.CompletionList(items, false);
    };

    private _removeWorkspace = (workspaceFolder: vscode.WorkspaceFolder): void => {
        delete this._cache[workspaceFolder.name];
    };

    private _addWorkspace = (workspaceFolder: vscode.WorkspaceFolder): void => {
        this._discoverTypeScriptProjects(workspaceFolder).then(projects => {
            const typescriptPattern = new vscode.RelativePattern(workspaceFolder, "**/*.{ts,tsx}");
            
            vscode.workspace.findFiles(typescriptPattern).then(
                uris => {
                    // Initialize completion item maps for each project
                    projects.forEach(project => {
                        project.completionItemsMap = new CompletionItemMapImpl([], this._getItemPrefix);
                    });

                    const workspace: Workspace = {
                        workspaceFolder,
                        projects,
                        fileToProjectCache: new Map<string, TypeScriptProject>()
                    };

                    // Assign each file to its appropriate project
                    for (const uri of uris) {
                        const project = this._findProjectForFile(uri, workspace);
                        if (project && project.completionItemsMap) {
                            const item = uriToCompletionItemForProject(uri, project);
                            project.completionItemsMap.putItem(item);
                            workspace.fileToProjectCache.set(uri.path, project);
                        }
                    }

                    this._cache[workspaceFolder.name] = workspace;
                },
                error => {
                    console.error(`Error creating cache: ${error}`);
                }
            );
        }).catch(error => {
            console.error(`Error discovering TypeScript projects: ${error}`);
        });
    };

    private _discoverTypeScriptProjects = (workspaceFolder: vscode.WorkspaceFolder): Promise<TypeScriptProject[]> => {
        const tsconfigPattern = new vscode.RelativePattern(workspaceFolder, "**/tsconfig.json");
        
        return Promise.resolve(vscode.workspace.findFiles(tsconfigPattern)).then(tsconfigUris => {
            return Promise.all(
                tsconfigUris.map(tsconfigUri => {
                    return vscode.workspace.openTextDocument(tsconfigUri).then(
                        tsconfigDoc => {
                            const pathMapping = this._tsconfigDocumentToPathMapping(tsconfigDoc);
                            
                            const project: TypeScriptProject = {
                                tsconfigPath: tsconfigUri.path,
                                rootPath: Path.dirname(tsconfigUri.path),
                                workspaceFolder,
                                baseUrl: pathMapping.baseUrl,
                                paths: pathMapping.paths
                            };
                            
                            return project;
                        },
                        error => {
                            console.error(`Error reading tsconfig at ${tsconfigUri.path}: ${error}`);
                            return null;
                        }
                    );
                })
            ).then(projects => {
                const validProjects = projects.filter(p => p !== null) as TypeScriptProject[];
                
                // Sort by depth (deepest first) for proper nesting hierarchy
                return validProjects.sort((a, b) => b.rootPath.split('/').length - a.rootPath.split('/').length);
            });
        });
    };

    private _findProjectForFile = (uri: vscode.Uri, workspace: Workspace): TypeScriptProject | undefined => {
        return findProjectForFile(uri, workspace.projects);
    };

    private _getItemPrefix = (item: vscode.CompletionItem): string => {
        if (typeof item.label === "string") {
            return this._getPrefix(item.label);
        }

        return this._getPrefix(item.label.label);
    };

    private _getPrefix = (query: string): string => query.substring(0, 1);

    private _tsconfigDocumentToPathMapping = (tsconfigDoc: vscode.TextDocument): PathMapping => {
        const parseResults = ts.parseConfigFileTextToJson(
            tsconfigDoc.fileName,
            tsconfigDoc.getText()
        );
        const tsconfigObj = parseResults.config;
        const pathMapping: PathMapping = {};
        
        if ("compilerOptions" in tsconfigObj) {
            const compilerOptions = tsconfigObj["compilerOptions"];
            
            if ("baseUrl" in compilerOptions) {
                pathMapping.baseUrl = <string>compilerOptions["baseUrl"];
            }
            
            if ("paths" in compilerOptions) {
                pathMapping.paths = <Record<string, string[]>>compilerOptions["paths"];
            }
        }
        
        return pathMapping;
    };

    private _getWorkspaceFolderFromUri = (uri: vscode.Uri): vscode.WorkspaceFolder | undefined => {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);

        if (workspaceFolder === undefined) {
            console.error("URI in undefined workspaceFolder", uri);
        }

        return workspaceFolder;
    };
}
