import * as vscode from "vscode";
import * as u from "./u";
import { Result } from "./u";
import * as uriHelpers from "./uri_helpers";
import { TypeScriptProject } from "./uri_helpers";
import * as pathUtil from "path";
import * as ts from "typescript";

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

export type TsConfigJson = {
    rootPath: string;
    value: TsConfigJsonValue;
};

export type TsConfigJsonValue = {
    baseUrl: string | null;
    paths: Record<string, Array<string>> | null;
    outDir: string | null;
};

type WorkspaceName = string;
type TsFilePath = string; // relative to workspace root

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
            console.error("Cannot add item: Workspace has not been cached");
            return;
        }

        // Skip files that are in node_modules and outDir folders
        if (uri.path.includes("node_modules/") || isFileInOutDir(uri, workspace.tsProjects)) {
            return;
        }

        // Add file to all projects that can access it
        for (const project of workspace.tsProjects) {
            const item = uriHelpers.uriToCompletionItemForProject(uri, project);
            if (item !== null) {
                u.getOrCreate(
                    project.completionItemsByQueryFirstChar,
                    getItemPrefix(item),
                    () => []
                ).push(item);
            }
        }

        const ownerProject = uriHelpers.findProjectForFile(uri, workspace.tsProjects);
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
                const key = getItemPrefix(item);
                const itemsInMap = project.completionItemsByQueryFirstChar.get(key);
                if (itemsInMap !== undefined) {
                    project.completionItemsByQueryFirstChar.set(
                        key,
                        itemsInMap.filter(itemInMap => itemInMap !== item)
                    );
                }
            }
        }

        workspace.ownerTsProjectByTsFilePath.delete(uri.path);
    };

    getCompletionList = (uri: vscode.Uri, query: string): vscode.CompletionList | [] => {
        const workspaceFolder = getWorkspaceFolderFromUri(uri);
        if (workspaceFolder === null) return [];

        const workspace = this.workspaceByName.get(workspaceFolder.name);
        if (workspace === undefined) {
            console.warn("Workspace was not in cache");
            return [];
        }

        const currentProject = workspace.ownerTsProjectByTsFilePath.get(uri.path) ?? null;
        if (currentProject === null) {
            console.warn(`No TypeScript project found for current file: ${uri.path}`);
            return [];
        }

        // Get completion items from current project (now includes all accessible files)
        const items = currentProject.completionItemsByQueryFirstChar.get(u.firstChar(query)) ?? [];
        return new vscode.CompletionList(items, false);
    };
}

async function makeWorkspaceAsync(
    workspaceFolder: vscode.WorkspaceFolder
): Promise<Result<Workspace, string>> {
    const discoverResult = await discoverTsJsonsAsync(workspaceFolder);
    if (!discoverResult.ok) return discoverResult;
    const tsConfigJsons = discoverResult.value;

    const includePattern = new vscode.RelativePattern(workspaceFolder, "**/*.{ts,tsx}");
    const excludePatterns = tsConfigJsons.flatMap(tsConfigJson => {
        const folder = getAbsoluteOutDir(tsConfigJson);
        return folder === null ? [] : [pathUtil.relative(workspaceFolder.uri.path, folder) + "/**"];
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

    const tsProjects: Array<TypeScriptProject> = tsConfigJsons.map(tsConfigJson => ({
        tsConfigJson,
        workspaceFolder,
        completionItemsByQueryFirstChar: new Map(),
    }));
    const ownerTsProjectByTsFilePath = new Map<TsFilePath, TypeScriptProject>();

    // Add each file to all projects that can access it via their path mappings
    for (const project of tsProjects) {
        for (const uri of uris) {
            const item = uriHelpers.uriToCompletionItemForProject(uri, project);
            if (item !== null) {
                // Only add the file if it can be imported from this project
                u.getOrCreate(
                    project.completionItemsByQueryFirstChar,
                    getItemPrefix(item),
                    () => []
                ).push(item);

                // For file-to-project cache, use the project that physically contains the file
                const ownerProject = uriHelpers.findProjectForFile(uri, tsProjects);
                if (ownerProject !== null) {
                    ownerTsProjectByTsFilePath.set(uri.path, ownerProject);
                }
            }
        }
    }

    const workspace: Workspace = {
        tsProjects,
        ownerTsProjectByTsFilePath: new Map(),
    };
    return Result.ok(workspace);
}

async function discoverTsJsonsAsync(
    workspaceFolder: vscode.WorkspaceFolder
): Promise<Result<Array<TsConfigJson>, string>> {
    const tsconfigPattern = new vscode.RelativePattern(workspaceFolder, "**/tsconfig.json");
    const excludePattern = new vscode.RelativePattern(workspaceFolder, "**/node_modules/**");

    let tsconfigUris: Array<vscode.Uri>;
    try {
        tsconfigUris = await vscode.workspace.findFiles(tsconfigPattern, excludePattern);
    } catch (error) {
        return Result.err(`Failed finding tsconfig.json files: ${error}`);
    }

    const tsConfigJsons: Array<TsConfigJson> = [];
    for (const tsConfigUri of tsconfigUris) {
        let tsConfigDoc: vscode.TextDocument;
        try {
            tsConfigDoc = await vscode.workspace.openTextDocument(tsConfigUri);
        } catch (error) {
            console.error(`Error reading tsconfig at ${tsConfigUri.path}: ${error}`);
            continue;
        }

        tsConfigJsons.push({
            rootPath: pathUtil.dirname(tsConfigUri.path),
            value: parseTsConfig(tsConfigDoc),
        });
    }

    // Sort by depth (deepest first) for proper nesting hierarchy
    return Result.ok(
        tsConfigJsons.sort((a, b) => b.rootPath.split("/").length - a.rootPath.split("/").length)
    );
}

function getItemPrefix(item: vscode.CompletionItem): string {
    return typeof item.label === "string" ? getPrefix(item.label) : getPrefix(item.label.label);

    function getPrefix(query: string): string {
        return query.substring(0, 1);
    }
}

function parseTsConfig(tsconfigDoc: vscode.TextDocument): TsConfigJsonValue {
    const parseResults = ts.parseConfigFileTextToJson(tsconfigDoc.fileName, tsconfigDoc.getText());
    const tsconfigObj = parseResults.config;

    let baseUrl: string | null = null;
    let paths: Record<string, Array<string>> | null = null;
    let outDir: string | null = null;
    if ("compilerOptions" in tsconfigObj) {
        const compilerOptions = tsconfigObj["compilerOptions"];

        if ("baseUrl" in compilerOptions) {
            baseUrl = compilerOptions["baseUrl"] as string;
        }
        if ("paths" in compilerOptions) {
            paths = compilerOptions["paths"] as Record<string, Array<string>>;
        }
        if ("outDir" in compilerOptions) {
            outDir = compilerOptions["outDir"] as string;
        }
    }

    return { baseUrl, paths, outDir };
}

function isFileInOutDir(uri: vscode.Uri, projects: Array<TypeScriptProject>): boolean {
    for (const project of projects) {
        const outDir = getAbsoluteOutDir(project.tsConfigJson);
        if (outDir !== null) {
            if (uri.path.startsWith(outDir)) {
                return true;
            }
        }
    }
    return false;
}

function getAbsoluteOutDir(tsConfigJson: TsConfigJson): string | null {
    if (tsConfigJson.value.outDir === null) return null;

    return pathUtil.isAbsolute(tsConfigJson.value.outDir)
        ? tsConfigJson.value.outDir
        : pathUtil.resolve(tsConfigJson.rootPath, tsConfigJson.value.outDir);
}

function getWorkspaceFolderFromUri(uri: vscode.Uri): vscode.WorkspaceFolder | null {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri) ?? null;
    if (workspaceFolder === null) {
        console.error("URI in undefined workspaceFolder", uri);
    }
    return workspaceFolder;
}
