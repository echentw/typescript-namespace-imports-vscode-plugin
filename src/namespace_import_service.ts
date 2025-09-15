import * as vscode from 'vscode';
import * as u from './u';
import {q, Result} from './u';
import * as uriHelpers from './uri_helpers';
import * as pathUtil from 'path';
import * as ts from 'typescript';

type Workspace = {
    workspaceFolder: vscode.WorkspaceFolder;
    tsProjectByPath: Map<TsProjectPath, TsProject>;
    ownerTsProjectPathByTsFilePath: Map<TsFilePath, TsProjectPath>;
};

export type TsProject = {
    tsConfigJson: TsConfigJson;
    workspaceFolder: vscode.WorkspaceFolder;
    modulesForBareImportByQueryFirstChar: Map<string, Array<ModuleForBareImport>>;
    modulesForRelativeImportByQueryFirstChar: Map<string, Array<ModuleForRelativeImport>>;
};

export type TsConfigJson = {
    baseUrl: string | null;
    paths: Record<string, Array<string>> | null;
    outDir: string | null;
};

type ModuleForBareImport = {
    moduleName: string;
    tsFilePath: TsFilePath;
    importPath: string;
};

type ModuleForRelativeImport = {
    moduleName: string;
    tsFilePath: TsFilePath;
};

type WorkspaceName = string;
export type TsFilePath = string;
export type TsProjectPath = string;


export type CompletionItemsService = {
    getModulesForCompletion: (uri: vscode.Uri, query: string) => Array<ModuleForCompletion>;

    handleWorkspaceChangedAsync: (event: vscode.WorkspaceFoldersChangeEvent) => Promise<void>;
    handleFileCreatedAsync: (uri: vscode.Uri) => Promise<void>;
    handleFileDeletedAsync: (uri: vscode.Uri) => Promise<void>;
    handleFileChangedAsync: (uri: vscode.Uri) => Promise<void>;
};

export type ModuleForCompletion = {
    moduleName: string;
    importPath: string;
};

export const CompletionItemsService = {
    make: (workspaceFolders: ReadonlyArray<vscode.WorkspaceFolder>): CompletionItemsService => {
        return new CompletionItemsServiceImpl(workspaceFolders);
    },
};

// TODO: Using this map makes intellisense quick even in large projects, but a more elegant
// solution might be to implement some type of trie tree for CompletionItems
export class CompletionItemsServiceImpl implements CompletionItemsService {
    private workspaceByName: Map<WorkspaceName, Workspace>;

    constructor(workspaceFolders: ReadonlyArray<vscode.WorkspaceFolder>) {
        this.workspaceByName = new Map();

        u.fireAndForget(async () => {
            await this.resetAsync(workspaceFolders);
        });
    }

    private resetAsync = async (workspaceFolders: ReadonlyArray<vscode.WorkspaceFolder>): Promise<void> => {
        const workspaceByName = new Map<WorkspaceName, Workspace>();
        await updateWorkspaceByNameInPlaceAsync(workspaceByName, workspaceFolders, []);
        this.workspaceByName = workspaceByName;
    }

    handleWorkspaceChangedAsync = async (event: vscode.WorkspaceFoldersChangeEvent) => {
        await updateWorkspaceByNameInPlaceAsync(this.workspaceByName, event.added, event.removed);
    };

    handleFileCreatedAsync = async (uri: vscode.Uri) => {
        if (pathUtil.basename(uri.path) === 'tsconfig.json') {
            await this.resetAsync(
                Array.from(this.workspaceByName.values()).map(workspace => workspace.workspaceFolder),
            );
            return;
        }
        if (!isTsFile(uri)) return;

        const checkResult = this.checkChangedFileAndGetWorkspace(uri);
        if (!checkResult.ok) {
            console.warn(`handleFileCreated: ${checkResult.err}`);
            return;
        }
        const workspace = checkResult.value;

        // Add file to all projects that can access it
        for (const [tsProjectPath, tsProject] of workspace.tsProjectByPath.entries()) {
            const evalResult = uriHelpers.evaluateModuleForTsProject(tsProjectPath, tsProject, uri);
            switch (evalResult.type) {
                case 'bareImport': {
                    const {moduleName, importPath} = evalResult;
                    u.map.getOrCreate(tsProject.modulesForBareImportByQueryFirstChar, u.firstChar(moduleName), () => [])
                        .push({moduleName, importPath, tsFilePath: uri.path});
                    break;
                }
                case 'relativeImport': {
                    const {moduleName} = evalResult;
                    u.map.getOrCreate(tsProject.modulesForRelativeImportByQueryFirstChar, u.firstChar(moduleName), () => [])
                        .push({moduleName, tsFilePath: uri.path});
                    break;
                }
                case 'importDisallowed': break;
                default: throw u.impossible(evalResult);
            }
        }

        const ownerTsProjectPath = uriHelpers.findOwnerTsProjectForTsFile(uri, workspace.tsProjectByPath.keys());
        if (ownerTsProjectPath === null) {
            console.warn(`No TypeScript project found for file: ${uri.path}`);
            return;
        }
        workspace.ownerTsProjectPathByTsFilePath.set(uri.path, ownerTsProjectPath);
    };

    handleFileDeletedAsync = async (uri: vscode.Uri) => {
        const checkResult = this.checkChangedFileAndGetWorkspace(uri);
        if (!checkResult.ok) {
            console.warn(`handleFileDeleted: ${checkResult.err}`);
            return;
        }
        const workspace = checkResult.value;

        if (pathUtil.extname(uri.path) === '') {
            // If 'uri' looks like a directory...

            for (const tsProjectPath of workspace.tsProjectByPath.keys()) {
                if (tsProjectPath.startsWith(uri.path)) {
                    await this.resetAsync(
                        Array.from(this.workspaceByName.values()).map(workspace => workspace.workspaceFolder),
                    );
                    return;
                }
            }

            for (const tsProject of workspace.tsProjectByPath.values()) {
                for (const [key, modules] of tsProject.modulesForBareImportByQueryFirstChar) {
                    tsProject.modulesForBareImportByQueryFirstChar.set(
                        key,
                        modules.filter(module => !module.tsFilePath.startsWith(uri.path)),
                    );
                }
                for (const [key, modules] of tsProject.modulesForRelativeImportByQueryFirstChar) {
                    tsProject.modulesForRelativeImportByQueryFirstChar.set(
                        key,
                        modules.filter(module => !module.tsFilePath.startsWith(uri.path)),
                    );
                }
            }

            const toRemove: Array<TsFilePath> = [];
            for (const tsFilePath of workspace.ownerTsProjectPathByTsFilePath.keys()) {
                if (tsFilePath.startsWith(uri.path)) {
                    toRemove.push(tsFilePath);
                }
            }
            for (const tsFilePath of toRemove) {
                workspace.ownerTsProjectPathByTsFilePath.delete(tsFilePath);
            }
        } else {
            if (pathUtil.basename(uri.path) === 'tsconfig.json') {
                await this.resetAsync(
                    Array.from(this.workspaceByName.values()).map(workspace => workspace.workspaceFolder),
                );
                return;
            }
            if (!isTsFile(uri)) return;

            // Remove file from all projects that had it cached
            for (const [tsProjectPath, tsProject] of workspace.tsProjectByPath.entries()) {
                const evalResult = uriHelpers.evaluateModuleForTsProject(tsProjectPath, tsProject, uri);
                switch (evalResult.type) {
                    case 'bareImport': {
                        const {moduleName} = evalResult;
                        const itemsInMap = tsProject.modulesForBareImportByQueryFirstChar.get(u.firstChar(moduleName));
                        if (itemsInMap !== undefined) {
                            tsProject.modulesForBareImportByQueryFirstChar.set(
                                u.firstChar(moduleName),
                                itemsInMap.filter(itemInMap => itemInMap.tsFilePath !== uri.path),
                            );
                        }
                        break;
                    }
                    case 'relativeImport': {
                        const {moduleName} = evalResult;
                        const modulesInMap = tsProject.modulesForRelativeImportByQueryFirstChar.get(u.firstChar(moduleName));
                        if (modulesInMap !== undefined) {
                            tsProject.modulesForRelativeImportByQueryFirstChar.set(
                                u.firstChar(moduleName),
                                modulesInMap.filter(module => module.tsFilePath !== uri.path),
                            );
                        }
                        break;
                    }
                    case 'importDisallowed': break;
                    default: throw u.impossible(evalResult);
                }
            }

            workspace.ownerTsProjectPathByTsFilePath.delete(uri.path);
        }
    };

    handleFileChangedAsync = async (uri: vscode.Uri): Promise<void> => {
        if (pathUtil.basename(uri.path) === 'tsconfig.json') {
            await this.resetAsync(
                Array.from(this.workspaceByName.values()).map(workspace => workspace.workspaceFolder),
            );
        }
    };

    getModulesForCompletion = (
        uri: vscode.Uri,
        query: string,
    ): Array<ModuleForCompletion> => {
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

        const firstChar = u.firstChar(query);
        const modulesForCompletion: Array<ModuleForCompletion> = [];

        const modulesForBareImport = currentProject.modulesForBareImportByQueryFirstChar.get(firstChar) ?? [];
        for (const {moduleName, importPath, tsFilePath} of modulesForBareImport) {
            if (tsFilePath === uri.path) continue;
            modulesForCompletion.push({moduleName, importPath});
        }

        const currentFileDirPath = pathUtil.dirname(uri.path);
        const modulesForRelativeImport = currentProject.modulesForRelativeImportByQueryFirstChar.get(firstChar) ?? [];
        for (const {moduleName, tsFilePath} of modulesForRelativeImport) {
            if (tsFilePath === uri.path) continue;

            let importPathWithExt = pathUtil.relative(currentFileDirPath, tsFilePath);
            if (!importPathWithExt.startsWith('..')) {
                importPathWithExt = './' + importPathWithExt;
            }
            const importPath = u.pathWithoutExt(importPathWithExt);
            modulesForCompletion.push({moduleName, importPath});
        }

        return modulesForCompletion;
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
    // console.log('workspaceByName', u.stringify(workspaceByName));
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
                modulesForBareImportByQueryFirstChar: new Map(),
                modulesForRelativeImportByQueryFirstChar: new Map(),
            },
        ])
    );

    // Add each file to all projects that can access it via their path mappings
    for (const [tsProjectPath, tsProject] of tsProjectByPath) {
        for (const uri of uris) {
            const evalResult = uriHelpers.evaluateModuleForTsProject(tsProjectPath, tsProject, uri);
            switch (evalResult.type) {
                case 'bareImport': {
                    const {moduleName, importPath} = evalResult;
                    u.map.getOrCreate(tsProject.modulesForBareImportByQueryFirstChar, u.firstChar(moduleName), () => [])
                        .push({moduleName, importPath, tsFilePath: uri.path});
                    break;
                }
                case 'relativeImport': {
                    const {moduleName} = evalResult;
                    u.map.getOrCreate(tsProject.modulesForRelativeImportByQueryFirstChar, u.firstChar(moduleName), () => [])
                        .push({moduleName, tsFilePath: uri.path});
                    break;
                }
                case 'importDisallowed': break;
                default: throw u.impossible(evalResult);
            }
        }
    }

    const ownerTsProjectPathByTsFilePath = new Map<TsFilePath, TsProjectPath>();
    for (const uri of uris) {
        const ownerTsProjectPath = uriHelpers.findOwnerTsProjectForTsFile(uri, tsProjectByPath.keys());
        if (ownerTsProjectPath !== null) {
            ownerTsProjectPathByTsFilePath.set(uri.path, ownerTsProjectPath);
        }
    }

    const workspace: Workspace = {
        workspaceFolder,
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

function isTsFile(uri: vscode.Uri): boolean {
    return uri.path.endsWith('.ts') || uri.path.endsWith('.tsx');
}
