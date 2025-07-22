import * as vscode from "vscode";
import * as uriHelpers from "./uri_helpers";
import { PathMapping, TypeScriptProject } from "./uri_helpers";
import * as Path from "path";
import * as ts from "typescript";
import { CompletionItemMap } from "./completion_item_map";

type Workspace = {
    workspaceFolder: vscode.WorkspaceFolder;
    projects: TypeScriptProject[];
    fileToProjectCache: Map<string, TypeScriptProject>;
};

export type CompletionItemsCache = {
    handleWorkspaceChange: (event: vscode.WorkspaceFoldersChangeEvent) => void;
    addFile: (uri: vscode.Uri) => void;
    deleteFile: (uri: vscode.Uri) => void;
    getCompletionList: (currentUri: vscode.Uri, query: string) => vscode.CompletionList | [];
};

export const CompletionItemsCache = {
    make: (workspaceFolders: readonly vscode.WorkspaceFolder[]): CompletionItemsCache => {
        return new CompletionItemsCacheImpl(workspaceFolders);
    },
};

/**
 * Creates a cache of module completion items backed by aa map that is split by the first character
 * of each module name
 *
 * TODO: Using this map makes intellisense quick even in large projects, but a more elegant
 * solution might be to implement some type of trie tree for CompletionItems
 */
export class CompletionItemsCacheImpl implements CompletionItemsCache {
    // Map from workspaceFolder.name -> cached workspace data
    private workspaceInfoByName: Record<string, Workspace> = {};

    constructor(workspaceFolders: ReadonlyArray<vscode.WorkspaceFolder>) {
        workspaceFolders.forEach(this.addWorkspace);
    }

    handleWorkspaceChange = (event: vscode.WorkspaceFoldersChangeEvent): void => {
        event.added.forEach(this.addWorkspace);
        event.removed.forEach(this.removeWorkspace);
    };

    addFile = (uri: vscode.Uri) => {
        const workspaceFolder = getWorkspaceFolderFromUri(uri);
        if (workspaceFolder === null) return;

        const workspace = this.workspaceInfoByName[workspaceFolder.name];
        if (workspace === undefined) {
            console.error("Cannot add item: Workspace has not been cached");
            return;
        }

        const project = findProjectForFile(uri, workspace);
        if (project === null) {
            console.warn(`No TypeScript project found for file: ${uri.path}`);
            return;
        }

        const item = uriHelpers.uriToCompletionItemForProject(uri, project);
        project.completionItemsMap.putItem(item);
        workspace.fileToProjectCache.set(uri.path, project);
    };

    deleteFile = (uri: vscode.Uri) => {
        const workspaceFolder = getWorkspaceFolderFromUri(uri);
        if (workspaceFolder === null) return;

        const workspace = this.workspaceInfoByName[workspaceFolder.name];
        if (workspace === undefined) return;

        const project = workspace.fileToProjectCache.get(uri.path) ?? findProjectForFile(uri, workspace);
        if (project === null) return;

        const item = uriHelpers.uriToCompletionItemForProject(uri, project);
        project.completionItemsMap.removeItem(item);
        workspace.fileToProjectCache.delete(uri.path);
    };

    getCompletionList = (currentUri: vscode.Uri, query: string): vscode.CompletionList | [] => {
        const workspaceFolder = getWorkspaceFolderFromUri(currentUri);
        if (workspaceFolder === null) return [];

        const workspace = this.workspaceInfoByName[workspaceFolder.name];
        if (workspace === undefined) {
            console.warn("Workspace was not in cache");
            return [];
        }

        const currentProject = workspace.fileToProjectCache.get(currentUri.path) ?? findProjectForFile(currentUri, workspace);
        if (currentProject === null) {
            console.warn(`No TypeScript project found for current file: ${currentUri.path}`);
            return [];
        }

        // Get completion items from current project
        const items = currentProject.completionItemsMap.getItemsAt(getPrefix(query));
        
        // Also get completion items from other projects that can be imported via path mappings
        const crossProjectItems = this.getCrossProjectCompletions(workspace, currentProject, query);
        
        return new vscode.CompletionList([...items, ...crossProjectItems], false);
    };

    private getCrossProjectCompletions = (workspace: Workspace, currentProject: TypeScriptProject, query: string): vscode.CompletionItem[] => {
        if (!currentProject.paths) return [];

        const crossProjectItems: vscode.CompletionItem[] = [];
        const prefix = getPrefix(query);

        // Look through the current project's path mappings to find cross-project references
        for (const [, mappings] of Object.entries(currentProject.paths)) {
            // Skip dummy patterns
            if (mappings.some(mapping => mapping.includes("dummy-value-so-nothing-is-resolved"))) {
                continue;
            }

            for (const mapping of mappings) {
                // Look for mappings that reference other projects (contain "../")
                if (mapping.startsWith("../")) {
                    const targetProject = this.findProjectByMapping(workspace, currentProject, mapping);
                    if (targetProject && targetProject !== currentProject) {
                        // Get completion items from the target project
                        const targetItems = targetProject.completionItemsMap.getItemsAt(prefix);
                        
                        // Create new completion items with cross-project import paths
                        for (const item of targetItems) {
                            const crossProjectItem = this.createCrossProjectCompletionItem(item, targetProject, currentProject);
                            if (crossProjectItem) {
                                crossProjectItems.push(crossProjectItem);
                            }
                        }
                    }
                }
            }
        }

        return crossProjectItems;
    };

    private findProjectByMapping = (workspace: Workspace, currentProject: TypeScriptProject, mapping: string): TypeScriptProject | null => {
        // Resolve the mapping path relative to the current project
        const absoluteMappingPath = Path.resolve(currentProject.rootPath, mapping.replace("/*", ""));
        
        // Find the project that contains this path
        return workspace.projects.find(project => {
            return absoluteMappingPath.startsWith(project.rootPath);
        }) ?? null;
    };

    private createCrossProjectCompletionItem = (
        originalItem: vscode.CompletionItem,
        targetProject: TypeScriptProject,
        currentProject: TypeScriptProject
    ): vscode.CompletionItem | null => {
        // Get the original file path from the completion item detail
        const originalImportPath = originalItem.detail;
        if (!originalImportPath) return null;

        // For cross-project imports, we need to find the correct pattern from current project's path mappings
        const crossProjectImportPath = this.generateCrossProjectImportPath(originalImportPath, targetProject, currentProject);
        if (!crossProjectImportPath) return null;

        const completionItem = new vscode.CompletionItem(originalItem.label, vscode.CompletionItemKind.Module);
        completionItem.detail = crossProjectImportPath;
        completionItem.additionalTextEdits = [
            vscode.TextEdit.insert(
                new vscode.Position(0, 0),
                `import * as ${originalItem.label} from "${crossProjectImportPath}";\n`,
            ),
        ];
        return completionItem;
    };

    private generateCrossProjectImportPath = (
        originalImportPath: string,
        targetProject: TypeScriptProject,
        currentProject: TypeScriptProject
    ): string | null => {
        if (!currentProject.paths) return null;

        // Extract just the filename from the original import path
        // originalImportPath might be "project1/add" but we just want "add"
        const filename = Path.basename(originalImportPath);

        // Look for a path mapping that points to the target project
        for (const [pattern, mappings] of Object.entries(currentProject.paths)) {
            for (const mapping of mappings) {
                if (mapping.startsWith("../")) {
                    // Check if this mapping resolves to the target project
                    const absoluteMapping = Path.resolve(currentProject.rootPath, mapping.replace("/*", ""));
                    const targetProjectSrc = Path.join(targetProject.rootPath, "src");
                    
                    if (absoluteMapping === targetProjectSrc) {
                        // This mapping points to our target project's src directory
                        // Replace the wildcard in the pattern with just the filename
                        return pattern.replace("*", filename);
                    }
                }
            }
        }

        return null;
    };

    private removeWorkspace = (workspaceFolder: vscode.WorkspaceFolder): void => {
        delete this.workspaceInfoByName[workspaceFolder.name];
    };

    private addWorkspace = async (workspaceFolder: vscode.WorkspaceFolder): Promise<void> => {
        let projects: Array<Omit<TypeScriptProject, "completionItemsMap">>;
        try {
            projects = await discoverTypeScriptProjectsAsync(workspaceFolder);
        } catch (error) {
            console.error(`Error discovering TypeScript projects: ${error}`);
            return;
        }

        const typescriptPattern = new vscode.RelativePattern(workspaceFolder, "**/*.{ts,tsx}");

        let uris: Array<vscode.Uri> = [];
        try {
            uris = await vscode.workspace.findFiles(typescriptPattern);
        } catch (error) {
            console.error(`Error creating cache: ${error}`);
            return;
        }

        const workspace: Workspace = {
            workspaceFolder,
            projects: projects.map(p => ({
                ...p,
                completionItemsMap: CompletionItemMap.make([], getItemPrefix),
            })),
            fileToProjectCache: new Map(),
        };

        // Assign each file to its appropriate project
        for (const uri of uris) {
            const project = findProjectForFile(uri, workspace);
            if (project === null) continue;

            const item = uriHelpers.uriToCompletionItemForProject(uri, project);
            project.completionItemsMap.putItem(item);
            workspace.fileToProjectCache.set(uri.path, project);
        }

        this.workspaceInfoByName[workspaceFolder.name] = workspace;
    };
}

async function discoverTypeScriptProjectsAsync(
    workspaceFolder: vscode.WorkspaceFolder
): Promise<Array<Omit<TypeScriptProject, "completionItemsMap">>> {
    const tsconfigPattern = new vscode.RelativePattern(workspaceFolder, "**/tsconfig.json");

    const tsconfigUris = await vscode.workspace.findFiles(tsconfigPattern);

    const projects = await Promise.all(
        tsconfigUris.map(async tsconfigUri => {
            let tsconfigDoc: vscode.TextDocument;
            try {
                tsconfigDoc = await vscode.workspace.openTextDocument(tsconfigUri);
            } catch (error) {
                console.error(`Error reading tsconfig at ${tsconfigUri.path}: ${error}`);
                return null;
            }

            const pathMapping = tsconfigDocumentToPathMapping(tsconfigDoc);

            const project: Omit<TypeScriptProject, "completionItemsMap"> = {
                tsconfigPath: tsconfigUri.path,
                rootPath: Path.dirname(tsconfigUri.path),
                workspaceFolder,
                baseUrl: pathMapping.baseUrl,
                paths: pathMapping.paths,
            };

            return project;
        })
    );

    const validProjects = projects.filter(p => p !== null) as TypeScriptProject[];

    // Sort by depth (deepest first) for proper nesting hierarchy
    return validProjects.sort(
        (a, b) => b.rootPath.split("/").length - a.rootPath.split("/").length
    );
}

function findProjectForFile(uri: vscode.Uri, workspace: Workspace): TypeScriptProject | null {
    return uriHelpers.findProjectForFile(uri, workspace.projects);
}

function getItemPrefix(item: vscode.CompletionItem): string {
    return typeof item.label === "string"
        ? getPrefix(item.label)
        : getPrefix(item.label.label);
}

function getPrefix(query: string): string {
    // TODO: is this always getting the first char? why?
    return query.substring(0, 1);
}

function tsconfigDocumentToPathMapping(tsconfigDoc: vscode.TextDocument): PathMapping {
    const parseResults = ts.parseConfigFileTextToJson(tsconfigDoc.fileName, tsconfigDoc.getText());
    const tsconfigObj = parseResults.config;
    const pathMapping: PathMapping = {};

    if ("compilerOptions" in tsconfigObj) {
        const compilerOptions = tsconfigObj["compilerOptions"];

        if ("baseUrl" in compilerOptions) {
            pathMapping.baseUrl = compilerOptions["baseUrl"] as string;
        }

        if ("paths" in compilerOptions) {
            pathMapping.paths = compilerOptions["paths"] as Record<string, Array<string>>;
        }
    }

    return pathMapping;
}

function getWorkspaceFolderFromUri(uri: vscode.Uri): vscode.WorkspaceFolder | null {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri) ?? null;
    if (workspaceFolder === null) {
        console.error("URI in undefined workspaceFolder", uri);
    }
    return workspaceFolder;
}
