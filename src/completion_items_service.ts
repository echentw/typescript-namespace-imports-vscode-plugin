import * as vscode from 'vscode';
import * as u from './u';
import {q, Result} from './u';
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
            await updateWorkspaceByNameInPlaceAsync(this.workspaceByName, workspaceFolders, []);
        });
    }

    handleWorkspaceChangedAsync = async (event: vscode.WorkspaceFoldersChangeEvent) => {
        await updateWorkspaceByNameInPlaceAsync(this.workspaceByName, event.added, event.removed);
    };

    handleFileCreatedAsync = async (uri: vscode.Uri) => {
        const checkResult = this.checkChangedFileAndGetWorkspace(uri);
        if (!checkResult.ok) {
            console.warn(`handleFileDeleted: ${checkResult.err}`);
            return;
        }
        const workspace = checkResult.value;

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
        const checkResult = this.checkChangedFileAndGetWorkspace(uri);
        if (!checkResult.ok) {
            console.warn(`handleFileDeleted: ${checkResult.err}`);
            return;
        }
        const workspace = checkResult.value;

        // Remove file from all projects that had it cached
        for (const [tsProjectPath, tsProject] of workspace.tsProjectByPath.entries()) {
            const value = uriHelpers.makeModuleNameAndCompletionItem(tsProjectPath, tsProject, uri);
            if (value !== null) {
                const [moduleName, completionItem] = value;
                const itemsInMap = tsProject.completionItemsByQueryFirstChar.get(u.firstChar(moduleName));
                if (itemsInMap !== undefined) {
                    tsProject.completionItemsByQueryFirstChar.set(
                        u.firstChar(moduleName),
                        itemsInMap.filter(itemInMap => itemInMap.detail !== completionItem.detail),
                    );
                }
            }
        }

        workspace.ownerTsProjectPathByTsFilePath.delete(uri.path);
    };

    getCompletionList = (uri: vscode.Uri, query: string): vscode.CompletionList | [] => {
        const checkResult = this.checkChangedFileAndGetWorkspace(uri);
        if (!checkResult.ok) {
            console.warn(`getCompletionList: ${checkResult.err}`);
            return [];
        }
        const workspace = checkResult.value;

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

    private checkChangedFileAndGetWorkspace(uri: vscode.Uri): Result<Workspace, string> {
        const workspaceFolder = getWorkspaceFolderFromUri(uri);
        if (workspaceFolder === null) return Result.err(`uri ${q(uri.path)}: failed to lookup workspace folder for uri`);

        const workspace = this.workspaceByName.get(workspaceFolder.name);
        if (workspace === undefined) return Result.err(`uri ${q(uri.path)}: workspace ${q(workspaceFolder.name)} not found in this.workspaceByName`);

        // Skip files that are in node_modules and outDir folders
        if (uri.path.includes('node_modules/') || isFileInOutDir(uri, workspace.tsProjectByPath)) {
            return Result.err(`uri ${q(uri.path)}: skipping because in node_modules/ or compilerOptions.outDir`);
        }

        return Result.ok(workspace);
    }
}

async function updateWorkspaceByNameInPlaceAsync(
    workspaceByName: Map<WorkspaceName, Workspace>,
    foldersToAdd: ReadonlyArray<vscode.WorkspaceFolder>,
    foldersToDelete: ReadonlyArray<vscode.WorkspaceFolder>,
): Promise<void> {
    for (const folder of foldersToAdd) {
        const result = await makeWorkspaceAsync(folder);
        if (result.ok) {
            workspaceByName.set(folder.name, result.value);
        } else {
            console.warn(result.err);
        }
    }
    for (const folder of foldersToDelete) {
        workspaceByName.delete(folder.name);
    }
    console.log('workspaceByName', u.stringify(workspaceByName));
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

    // Add each file to all projects that can access it via their path mappings
    for (const [tsProjectPath, tsProject] of tsProjectByPath) {
        for (const uri of uris) {
            const value = uriHelpers.makeModuleNameAndCompletionItem(tsProjectPath, tsProject, uri);
            if (value !== null) {
                // Only add the file if it can be imported from this project
                const [moduleName, completionItem] = value;
                u.map.getOrCreate(tsProject.completionItemsByQueryFirstChar, u.firstChar(moduleName), () => [])
                    .push(completionItem);
            }
        }
    }

    const ownerTsProjectPathByTsFilePath = new Map<TsFilePath, TsProjectPath>();
    for (const uri of uris) {
        // For file-to-project cache, use the project that physically contains the file
        const ownerTsProjectPath = uriHelpers.findOwnerTsProjectForTsFile(uri, tsProjectByPath.keys());
        if (ownerTsProjectPath !== null) {
            ownerTsProjectPathByTsFilePath.set(uri.path, ownerTsProjectPath);
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
