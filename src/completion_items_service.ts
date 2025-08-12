import * as vscode from 'vscode';
import * as u from './u';
import {Result} from './u';
import * as uriHelpers from './uri_helpers';
import {TsConfigInfo, TypeScriptProject} from './uri_helpers';
import * as pathUtil from 'path';
import * as ts from 'typescript';
import { CompletionItemMap } from './completion_item_map';

type Workspace = {
    tsProjects: Array<TypeScriptProject>;
    ownerTsProjectByTsFilePath: Map<TsFilePath, TypeScriptProject>;
};

// type Workspace = {
// 	tsProjectByPath: Map<TsProjectPath, TsProject>;
// 	tsProjectPathByTsFilePath: Map<TsFilePath, TsProjectPath>;
// };
//
// type TsProject = {
// 	completionItemsByQueryFirstChar: Map<Char, Array<vscode.CompletionItem>>;
// 	tsConfigJson: TsConfigJson;
// };
//
// type TsConfigJson = {
// 	paths: Record<string, string>;
// 	baseUrl: string | null;
// };

type Char = string;
type WorkspaceName = string;
type TsFilePath = string; // relative to workspace root
type TsProjectPath = string; // relative to workspace root

export type CompletionItemsService = {
    getCompletionList: (uri: vscode.Uri, query: string) => vscode.CompletionList | [];

    handleWorkspaceChangedAsync: (event: vscode.WorkspaceFoldersChangeEvent) => Promise<void>;
    handleFileCreatedAsync: (uri: vscode.Uri) => Promise<void>;
    handleFileDeleted: (uri: vscode.Uri) => void;
};

export const CompletionItemsService = {
    make: (workspaceFolders: readonly vscode.WorkspaceFolder[]): CompletionItemsService => {
        return new CompletionItemsServiceImpl(workspaceFolders);
    },
};

// TODO: Using this map makes intellisense quick even in large projects, but a more elegant
// solution might be to implement some type of trie tree for CompletionItems
export class CompletionItemsServiceImpl implements CompletionItemsService {
    // Map from workspaceFolder.name -> cached workspace data
    private workspaceByName: Map<WorkspaceName, Workspace>;

    constructor(workspaceFolders: ReadonlyArray<vscode.WorkspaceFolder>) {
        this.workspaceByName = new Map();

        u.fireAndForget(async () => {
            for (const folder of workspaceFolders) {
                const result = await makeWorkspaceAsync(folder);
                if (result.ok) {
                    this.workspaceByName.set(folder.name, result.value);
                } else {
                    console.warn(result.err);
                }
            }
        });
    }

    handleWorkspaceChangedAsync = async (event: vscode.WorkspaceFoldersChangeEvent) => {
        for (const folder of event.added) {
            const result = await makeWorkspaceAsync(folder);
            if (result.ok) {
                this.workspaceByName.set(folder.name, result.value);
            } else {
                console.warn(result.err);
            }
        }
        for (const folder of event.removed) {
            this.workspaceByName.delete(folder.name);
        }
    };

    handleFileCreatedAsync = async (uri: vscode.Uri) => {
        const workspaceFolder = getWorkspaceFolderFromUri(uri);
        if (workspaceFolder === null) return;

        const workspace = this.workspaceByName.get(workspaceFolder.name);
        if (workspace === undefined) {
            console.error('Cannot add item: Workspace has not been cached');
            return;
        }

        // Skip files that are in node_modules and outDir folders
        if (uri.path.includes('node_modules/') || isFileInOutDir(uri, workspace.tsProjects)) {
            return;
        }

        // Add file to all projects that can access it
        for (const project of workspace.tsProjects) {
            const item = uriHelpers.uriToCompletionItemForProject(uri, project);
            if (item !== null) {
                project.completionItemsMap.putItem(item);
            }
        }

        const ownerProject = findProjectForFile(uri, workspace);
        if (ownerProject === null) {
            console.warn(`No TypeScript project found for file: ${uri.path}`);
            return;
        }
        workspace.ownerTsProjectByTsFilePath.set(uri.path, ownerProject);
    };

    handleFileDeleted = (uri: vscode.Uri) => {
        const workspaceFolder = getWorkspaceFolderFromUri(uri);
        if (workspaceFolder === null) return;

        const workspace = this.workspaceByName.get(workspaceFolder.name);
        if (workspace === undefined) return;

        // Remove file from all projects that had it cached
        for (const project of workspace.tsProjects) {
            const item = uriHelpers.uriToCompletionItemForProject(uri, project);
            if (item !== null) {
                project.completionItemsMap.removeItem(item);
            }
        }

        workspace.ownerTsProjectByTsFilePath.delete(uri.path);
    };

    getCompletionList = (uri: vscode.Uri, query: string): vscode.CompletionList | [] => {
        const workspaceFolder = getWorkspaceFolderFromUri(uri);
        if (workspaceFolder === null) return [];

        const workspace = this.workspaceByName.get(workspaceFolder.name);
        if (workspace === undefined) {
            console.warn('Workspace was not in cache');
            return [];
        }

        const currentProject = workspace.ownerTsProjectByTsFilePath.get(uri.path) ?? findProjectForFile(uri, workspace);
        if (currentProject === null) {
            console.warn(`No TypeScript project found for current file: ${uri.path}`);
            return [];
        }

        // Get completion items from current project (now includes all accessible files)
        const items = currentProject.completionItemsMap.getItemsAt(getPrefix(query));
        
        return new vscode.CompletionList(items, false);
    };
}

async function makeWorkspaceAsync(workspaceFolder: vscode.WorkspaceFolder): Promise<Result<Workspace, string>> {
    let projects: Array<TypeScriptProject>;
    try {
        projects = await discoverTsProjectsAsync(workspaceFolder);
    } catch (error) {
        return Result.err(`Failed finding typescript projects: ${error}`);
    }

    const includePattern = new vscode.RelativePattern(workspaceFolder, "**/*.{ts,tsx}");

    const excludePatterns = projects.flatMap(project => {
        const folder = getAbsoluteOutDir(project);
        return folder === null
            ? []
            : [pathUtil.relative(workspaceFolder.uri.path, folder) + "/**"];
    });
    const excludePattern = new vscode.RelativePattern(
        workspaceFolder,
        `{**/node_modules/**,${excludePatterns.join(",")}}`
    );

    let uris: Array<vscode.Uri> = [];
    try {
        uris = await vscode.workspace.findFiles(includePattern, excludePattern);
    } catch (error) {
        return Result.err(`Error creating cache: ${error}`);
    }

    const workspace: Workspace = {
        tsProjects: projects,
        ownerTsProjectByTsFilePath: new Map(),
    };

    // Add each file to all projects that can access it via their path mappings
    for (const project of workspace.tsProjects) {
        for (const uri of uris) {
            const item = uriHelpers.uriToCompletionItemForProject(uri, project);
            if (item !== null) {
                // Only add the file if it can be imported from this project
                project.completionItemsMap.putItem(item);

                // For file-to-project cache, use the project that physically contains the file
                const ownerProject = findProjectForFile(uri, workspace);
                if (ownerProject !== null) {
                    workspace.ownerTsProjectByTsFilePath.set(uri.path, ownerProject);
                }
            }
        }
    }

    return Result.ok(workspace);
}

async function discoverTsProjectsAsync(
    workspaceFolder: vscode.WorkspaceFolder
): Promise<Array<TypeScriptProject>> {
    const tsconfigPattern = new vscode.RelativePattern(workspaceFolder, '**/tsconfig.json');
    const excludePattern = new vscode.RelativePattern(workspaceFolder, '**/node_modules/**');

    const tsconfigUris = await vscode.workspace.findFiles(tsconfigPattern, excludePattern);

    const projects = await Promise.all(
        tsconfigUris.map(async tsconfigUri => {
            let tsconfigDoc: vscode.TextDocument;
            try {
                tsconfigDoc = await vscode.workspace.openTextDocument(tsconfigUri);
            } catch (error) {
                console.error(`Error reading tsconfig at ${tsconfigUri.path}: ${error}`);
                return null;
            }

            const pathMapping = parseTsConfig(tsconfigDoc);

            const project: TypeScriptProject = {
                tsconfigPath: tsconfigUri.path,
                rootPath: pathUtil.dirname(tsconfigUri.path),
                workspaceFolder,
                baseUrl: pathMapping.baseUrl,
                paths: pathMapping.paths,
                outDir: pathMapping.outDir,
                completionItemsMap: CompletionItemMap.make([], getItemPrefix),
            };

            return project;
        })
    );

    const validProjects = projects.filter(p => p !== null) as TypeScriptProject[];

    // Sort by depth (deepest first) for proper nesting hierarchy
    return validProjects.sort(
        (a, b) => b.rootPath.split('/').length - a.rootPath.split('/').length
    );
}

function findProjectForFile(uri: vscode.Uri, workspace: Workspace): TypeScriptProject | null {
    return uriHelpers.findProjectForFile(uri, workspace.tsProjects);
}

function getItemPrefix(item: vscode.CompletionItem): string {
    return typeof item.label === 'string'
        ? getPrefix(item.label)
        : getPrefix(item.label.label);
}

function getPrefix(query: string): string {
    return query.substring(0, 1);
}

function parseTsConfig(tsconfigDoc: vscode.TextDocument): TsConfigInfo {
    const parseResults = ts.parseConfigFileTextToJson(tsconfigDoc.fileName, tsconfigDoc.getText());
    const tsconfigObj = parseResults.config;

    const info: TsConfigInfo = {};
    if ('compilerOptions' in tsconfigObj) {
        const compilerOptions = tsconfigObj['compilerOptions'];

        if ('baseUrl' in compilerOptions) {
            info.baseUrl = compilerOptions['baseUrl'] as string;
        }

        if ('paths' in compilerOptions) {
            info.paths = compilerOptions['paths'] as Record<string, Array<string>>;
        }

        if ('outDir' in compilerOptions) {
            info.outDir = compilerOptions['outDir'] as string;
        }
    }

    return info;
}

function isFileInOutDir(uri: vscode.Uri, projects: TypeScriptProject[]): boolean {
    for (const project of projects) {
        const outDir = getAbsoluteOutDir(project);
        if (outDir !== null) {
            if (uri.path.startsWith(outDir)) {
                return true;
            }
        }
    }
    return false;
}

function getAbsoluteOutDir(project: TypeScriptProject): string | null {
    if (project.outDir === undefined) return null;

    return pathUtil.isAbsolute(project.outDir)
        ? project.outDir
        : pathUtil.resolve(project.rootPath, project.outDir);
}

function getWorkspaceFolderFromUri(uri: vscode.Uri): vscode.WorkspaceFolder | null {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri) ?? null;
    if (workspaceFolder === null) {
        console.error('URI in undefined workspaceFolder', uri);
    }
    return workspaceFolder;
}
