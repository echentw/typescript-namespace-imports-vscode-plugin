import * as vscode from "vscode";
import { uriToCompletionItem } from "./uri_helpers";
import * as Path from "path";
import * as ts from "typescript";
import { CompletionItemsCache } from "./completion_items_cache";
import { CompletionItemMap } from "./completion_item_map";
import { CompletionItemMapImpl } from "./completion_item_map_impl";

interface PathMapping {
    baseUrl?: string;
    paths?: Record<string, string[]>;
}

interface Workspace {
    baseUrlMap: Record<string, string>;
    pathMappings: Record<string, PathMapping>;
    completionItemsMap: CompletionItemMap;
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
                const item = uriToCompletionItem(uri, workspace.baseUrlMap, workspace.pathMappings);
                workspace.completionItemsMap.putItem(item);
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
                const item = uriToCompletionItem(uri, workspace.baseUrlMap, workspace.pathMappings);
                workspace.completionItemsMap.removeItem(item);
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

        const items = workspace.completionItemsMap.getItemsAt(this._getPrefix(query));

        return new vscode.CompletionList(items, false);
    };

    private _removeWorkspace = (workspaceFolder: vscode.WorkspaceFolder): void => {
        delete this._cache[workspaceFolder.name];
    };

    private _addWorkspace = (workspaceFolder: vscode.WorkspaceFolder): void => {
        const typescriptPattern = new vscode.RelativePattern(workspaceFolder, "**/*.{ts,tsx}");
        this._getWorkspacePathMappings(workspaceFolder).then(({ baseUrlMap, pathMappings }) => {
            vscode.workspace.findFiles(typescriptPattern).then(
                uris => {
                    const completionItems: vscode.CompletionItem[] = [];
                    for (const uri of uris) {
                        completionItems.push(uriToCompletionItem(uri, baseUrlMap, pathMappings));
                    }
                    this._cache[workspaceFolder.name] = {
                        baseUrlMap,
                        pathMappings,
                        completionItemsMap: new CompletionItemMapImpl(
                            completionItems,
                            this._getItemPrefix
                        ),
                    };
                },
                error => {
                    console.error(`Error creating cache: ${error}`);
                }
            );
        });
    };

    private _getWorkspacePathMappings = (
        workspace: vscode.WorkspaceFolder
    ): Thenable<{ baseUrlMap: Record<string, string>; pathMappings: Record<string, PathMapping> }> => {
        const tsconfigPattern = new vscode.RelativePattern(workspace, "**/tsconfig.json");

        return vscode.workspace
            .findFiles(tsconfigPattern)
            .then(this._tsconfigUrisToPathMappings(workspace), error => {
                console.error(`Error while working with **/tsconfig.json files ${error}`);
                return { baseUrlMap: {}, pathMappings: {} };
            });
    };

    private _getItemPrefix = (item: vscode.CompletionItem): string => {
        if (typeof item.label === "string") {
            return this._getPrefix(item.label);
        }

        return this._getPrefix(item.label.label);
    };

    private _getPrefix = (query: string): string => query.substring(0, 1);

    private _tsconfigUrisToPathMappings =
        (workspaceFolder: vscode.WorkspaceFolder) =>
        (uris: vscode.Uri[]): Thenable<{ baseUrlMap: Record<string, string>; pathMappings: Record<string, PathMapping> }> => {
            const recordPromises = Promise.all(
                uris.map(tsconfigUri =>
                    vscode.workspace.openTextDocument(tsconfigUri).then(
                        tsconfigDoc => {
                            const pathMapping = this._tsconfigDocumentToPathMapping(tsconfigDoc);
                            const relativePath = Path.relative(
                                workspaceFolder.uri.path,
                                Path.dirname(tsconfigUri.path)
                            );
                            
                            return pathMapping.baseUrl || pathMapping.paths
                                ? {
                                      baseUrlEntry: pathMapping.baseUrl ? { [relativePath]: pathMapping.baseUrl } : null,
                                      pathMappingEntry: { [relativePath]: pathMapping },
                                  }
                                : null;
                        },
                        error => {
                            console.error(`Error working with ${tsconfigUri.path}: ${error}`);
                        }
                    )
                )
            );

            return recordPromises.then(records => {
                const baseUrlMap: Record<string, string> = {};
                const pathMappings: Record<string, PathMapping> = {};
                
                records.forEach(r => {
                    if (r) {
                        if (r.baseUrlEntry) {
                            Object.assign(baseUrlMap, r.baseUrlEntry);
                        }
                        Object.assign(pathMappings, r.pathMappingEntry);
                    }
                });
                
                return { baseUrlMap, pathMappings };
            });
        };

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
