import * as vscode from 'vscode';
import * as u from './u';
import {Result} from './u';
import * as uriHelpers from './uri_helpers';
import * as pathUtil from 'path';
import * as ts from 'typescript';

type Workspace = {
    tsProjectByPath: Map<TsProjectPath, TsProject>;
    ownerTsProjectPathByTsFilePath: Map<TsFilePath, TsProjectPath>;
};

export type TsProject = {
    tsConfigJson: TsConfigJson;
    workspaceFolder: vscode.WorkspaceFolder;
    completionItemsByQueryFirstChar: Map<string, Array<vscode.CompletionItem>>;
};

export type TsConfigJson = {
    baseUrl: string | null;
    paths: Record<string, Array<string>> | null;
    outDir: string | null;
};

type WorkspaceName = string;
type TsFilePath = string;
export type TsProjectPath = string;

// type TsProject = {
// 	completionItemsByQueryFirstChar: Map<Char, Array<vscode.CompletionItem>>;
// 	tsConfigJson: TsConfigJson;
// };

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
            console.log('this.workspaceByName', u.stringify(this.workspaceByName))
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
        if (uri.path.includes('node_modules/') || isFileInOutDir(uri, workspace.tsProjectByPath)) {
            return;
        }

        // Add file to all projects that can access it
        for (const [tsProjectPath, tsProject] of workspace.tsProjectByPath.entries()) {
            const value = uriHelpers.makeModuleNameAndCompletionItem(tsProjectPath, tsProject, uri);
            if (value !== null) {
                const [moduleName, completionItem] = value;
                u.map.getOrCreate(tsProject.completionItemsByQueryFirstChar, u.firstChar(moduleName), () => [])
                    .push(completionItem);
            }
        }

        const ownerTsProjectPath = uriHelpers.findOwnerTsProjectForTsFile(uri, workspace.tsProjectByPath.keys());
        if (ownerTsProjectPath === null) {
            console.warn(`No TypeScript project found for file: ${uri.path}`);
            return;
        }
        workspace.ownerTsProjectPathByTsFilePath.set(uri.path, ownerTsProjectPath);
    };

    handleFileDeleted = (uri: vscode.Uri) => {
        const workspaceFolder = getWorkspaceFolderFromUri(uri);
        if (workspaceFolder === null) return;

        const workspace = this.workspaceByName.get(workspaceFolder.name);
        if (workspace === undefined) return;

        // Remove file from all projects that had it cached
        for (const [tsProjectPath, tsProject] of workspace.tsProjectByPath.entries()) {
            const value = uriHelpers.makeModuleNameAndCompletionItem(tsProjectPath, tsProject, uri);
            if (value !== null) {
                const [moduleName, completionItem] = value;
                const itemsInMap = tsProject.completionItemsByQueryFirstChar.get(moduleName);
                if (itemsInMap !== undefined) {
                    tsProject.completionItemsByQueryFirstChar.set(
                        u.firstChar(moduleName),
                        // TODO: I think there's a bug here. We shouldn't be comparing by reference?
                        itemsInMap.filter(itemInMap => itemInMap !== completionItem),
                    );
                }
            }
        }

        workspace.ownerTsProjectPathByTsFilePath.delete(uri.path);
    };

    getCompletionList = (uri: vscode.Uri, query: string): vscode.CompletionList | [] => {
        const workspaceFolder = getWorkspaceFolderFromUri(uri);
        if (workspaceFolder === null) return [];

        const workspace = this.workspaceByName.get(workspaceFolder.name);
        if (workspace === undefined) {
            console.warn('Workspace was not in cache');
            return [];
        }

        const currentProjectPath = workspace.ownerTsProjectPathByTsFilePath.get(uri.path) ?? null;
        if (currentProjectPath === null) {
            console.warn(`No TypeScript project found for current file: ${uri.path}`);
            return [];
        }
        const currentProject = u.map.getOrThrow(workspace.tsProjectByPath, currentProjectPath);

        // Get completion items from current project (now includes all accessible files)
        const items = currentProject.completionItemsByQueryFirstChar.get(u.firstChar(query)) ?? [];
        return new vscode.CompletionList(items, false);
    };
}

async function makeWorkspaceAsync(
    workspaceFolder: vscode.WorkspaceFolder,
): Promise<Result<Workspace, string>> {
    const discoverResult = await discoverTsConfigJsonsAsync(workspaceFolder);
    if (!discoverResult.ok) return discoverResult;
    const tsConfigJsonWithPaths = discoverResult.value;

    const includePattern = new vscode.RelativePattern(workspaceFolder, '**/*.{ts,tsx}');
    const excludePatterns = tsConfigJsonWithPaths.flatMap(tsConfigJsonWithPath => {
        const folder = getAbsoluteOutDir(tsConfigJsonWithPath);
        return folder === null ? [] : [pathUtil.relative(workspaceFolder.uri.path, folder) + '/**'];
    });
    const excludePattern = new vscode.RelativePattern(
        workspaceFolder,
        `{**/node_modules/**,${excludePatterns.join(',')}}`,
    );

    let uris: Array<vscode.Uri> = [];
    try {
        uris = await vscode.workspace.findFiles(includePattern, excludePattern);
    } catch (error) {
        return Result.err(`Error creating cache: ${error}`);
    }

    const tsProjectByPath: Map<TsProjectPath, TsProject> = u.map.fromEntries(
        tsConfigJsonWithPaths.map(({tsProjectPath, tsConfigJson}) => [
            tsProjectPath,
            {
                tsConfigJson,
                workspaceFolder,
                completionItemsByQueryFirstChar: new Map(),
            },
        ])
    );
    const ownerTsProjectPathByTsFilePath = new Map<TsFilePath, TsProjectPath>();

    // Add each file to all projects that can access it via their path mappings
    for (const [tsProjectPath, tsProject] of tsProjectByPath) {
        for (const uri of uris) {
            const value = uriHelpers.makeModuleNameAndCompletionItem(tsProjectPath, tsProject, uri);
            if (value !== null) {
                // Only add the file if it can be imported from this project

                const [moduleName, completionItem] = value;
                u.map.getOrCreate(tsProject.completionItemsByQueryFirstChar, u.firstChar(moduleName), () => [])
                    .push(completionItem);

                // For file-to-project cache, use the project that physically contains the file
                const ownerProjectPath = uriHelpers.findOwnerTsProjectForTsFile(uri, tsProjectByPath.keys());
                if (ownerProjectPath !== null) {
                    ownerTsProjectPathByTsFilePath.set(uri.path, ownerProjectPath);
                }
            }
        }
    }

    const workspace: Workspace = {
        tsProjectByPath,
        ownerTsProjectPathByTsFilePath,
    };
    return Result.ok(workspace);
}

type TsConfigJsonWithPath = {
    tsProjectPath: TsProjectPath;
    tsConfigJson: TsConfigJson;
};

async function discoverTsConfigJsonsAsync(
    workspaceFolder: vscode.WorkspaceFolder,
): Promise<Result<Array<TsConfigJsonWithPath>, string>> {
    const tsconfigPattern = new vscode.RelativePattern(workspaceFolder, '**/tsconfig.json');
    const excludePattern = new vscode.RelativePattern(workspaceFolder, '**/node_modules/**');

    let tsconfigUris: Array<vscode.Uri>;
    try {
        tsconfigUris = await vscode.workspace.findFiles(tsconfigPattern, excludePattern);
    } catch (error) {
        return Result.err(`Failed finding tsconfig.json files: ${error}`);
    }

    const tsConfigJsonWithPaths: Array<TsConfigJsonWithPath> = [];
    for (const tsConfigUri of tsconfigUris) {
        let tsConfigDoc: vscode.TextDocument;
        try {
            tsConfigDoc = await vscode.workspace.openTextDocument(tsConfigUri);
        } catch (error) {
            console.error(`Error reading tsconfig at ${tsConfigUri.path}: ${error}`);
            continue;
        }

        tsConfigJsonWithPaths.push({
            tsProjectPath: pathUtil.dirname(tsConfigUri.path),
            tsConfigJson: parseTsConfigJson(tsConfigDoc),
        });
    }

    // Sort by depth (deepest first) for proper nesting hierarchy
    return Result.ok(
        u.sort(
            tsConfigJsonWithPaths,
            u.cmp.transform(
                x => -x.tsProjectPath.split('/').length,
                u.cmp.number,
            ),
        ),
    );
}

function parseTsConfigJson(tsconfigDoc: vscode.TextDocument): TsConfigJson {
    const parseResults = ts.parseConfigFileTextToJson(tsconfigDoc.fileName, tsconfigDoc.getText());
    const tsconfigObj = parseResults.config;

    let baseUrl: string | null = null;
    let paths: Record<string, Array<string>> | null = null;
    let outDir: string | null = null;
    if ('compilerOptions' in tsconfigObj) {
        const compilerOptions = tsconfigObj['compilerOptions'];

        if ('baseUrl' in compilerOptions) {
            baseUrl = compilerOptions['baseUrl'] as string;
        }
        if ('paths' in compilerOptions) {
            paths = compilerOptions['paths'] as Record<string, Array<string>>;
        }
        if ('outDir' in compilerOptions) {
            outDir = compilerOptions['outDir'] as string;
        }
    }

    return {baseUrl, paths, outDir};
}

function isFileInOutDir(uri: vscode.Uri, tsProjectByPath: Map<TsProjectPath, TsProject>): boolean {
    return u.iter.some(tsProjectByPath, ([tsProjectPath, {tsConfigJson}]) => {
        const outDir = getAbsoluteOutDir({tsProjectPath, tsConfigJson});
        return outDir !== null && uri.path.startsWith(outDir);
    });
}

function getAbsoluteOutDir({tsProjectPath, tsConfigJson}: TsConfigJsonWithPath): string | null {
    if (tsConfigJson.outDir === null) return null;

    return pathUtil.isAbsolute(tsConfigJson.outDir)
        ? tsConfigJson.outDir
        : pathUtil.resolve(tsProjectPath, tsConfigJson.outDir);
}

function getWorkspaceFolderFromUri(uri: vscode.Uri): vscode.WorkspaceFolder | null {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri) ?? null;
    if (workspaceFolder === null) {
        console.error('URI in undefined workspaceFolder', uri);
    }
    return workspaceFolder;
}
