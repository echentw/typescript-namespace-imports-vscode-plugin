import * as vscode from "vscode";
import * as Path from "path";
import * as _ from "lodash";
import { CompletionItemMap } from "./completion_item_map";

export function uriToImportPath(
    uri: vscode.Uri,
    baseUrlMap: Record<string, string>,
    pathMappings: Record<string, PathMapping>,
): string {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    const workspaceFolderPath = workspaceFolder === undefined ? "" : workspaceFolder.uri.path;
    const uriRelativePath = Path.relative(workspaceFolderPath, uri.path);

    // First try path mappings, then fall back to baseUrl
    const maybePathWithMapping = pathMappings
        ? _lookForPathWithMapping(uriRelativePath, pathMappings)
        : null;
    const maybePathWithBaseUrl =
        maybePathWithMapping || _lookForPathWithBaseUrl(uriRelativePath, baseUrlMap);
    const importPath = maybePathWithBaseUrl ? maybePathWithBaseUrl : uriRelativePath;

    return importPath.slice(0, importPath.length - Path.extname(importPath).length);
}

function _lookForPathWithMapping(uriPath: string, pathMappings: Record<string, PathMapping>): string | null {
    let dirname = uriPath;
    let suffix = "";
    
    while (dirname !== ".") {
        suffix = Path.join(Path.basename(dirname), suffix);
        dirname = Path.dirname(dirname);
        
        if (dirname in pathMappings) {
            const mapping = pathMappings[dirname];
            if (mapping.paths) {
                // Try to match against path patterns
                const matchedPath = _matchPathPattern(uriPath, mapping.paths, mapping.baseUrl || "");
                if (matchedPath) {
                    return matchedPath;
                }
            }
        }
    }
    
    // Check root level mappings (empty string key for workspace root)
    if ("" in pathMappings) {
        const rootMapping = pathMappings[""];
        if (rootMapping.paths) {
            const matchedPath = _matchPathPattern(uriPath, rootMapping.paths, rootMapping.baseUrl || "");
            if (matchedPath) {
                return matchedPath;
            }
        }
    }
    
    // Also check for "." key as fallback
    if ("." in pathMappings) {
        const rootMapping = pathMappings["."];
        if (rootMapping.paths) {
            const matchedPath = _matchPathPattern(uriPath, rootMapping.paths, rootMapping.baseUrl || "");
            if (matchedPath) {
                return matchedPath;
            }
        }
    }
    
    return null;
}

function _matchPathPattern(filePath: string, paths: Record<string, string[]>, baseUrl: string): string | null {
    for (const [pattern, mappings] of Object.entries(paths)) {
        for (const mapping of mappings) {
            // Resolve mapping relative to baseUrl if needed
            const resolvedMapping = baseUrl ? Path.join(baseUrl, mapping) : mapping;
            
            // Handle wildcard patterns like "@/*" -> ["src/*"]
            if (pattern.includes("*") && resolvedMapping.includes("*")) {
                // Create regex from mapping (right side) to match against file path
                const mappingRegex = resolvedMapping.replace(/\*/g, "(.*)");
                const regex = new RegExp(`^${mappingRegex}$`);
                const match = filePath.match(regex);
                
                if (match && match[1] !== undefined) {
                    // Replace wildcard in pattern (left side) with matched content
                    return pattern.replace(/\*/g, match[1]);
                }
            }
            // Handle exact matches (no wildcards)
            else if (!pattern.includes("*") && !resolvedMapping.includes("*")) {
                if (filePath.startsWith(resolvedMapping)) {
                    const relativePath = Path.relative(resolvedMapping, filePath);
                    return relativePath ? Path.join(pattern, relativePath) : pattern;
                }
            }
        }
    }
    
    return null;
}

function _lookForPathWithBaseUrl(uriPath: string, baseUrlMap: Record<string, string>) {
    let dirname = uriPath;
    let suffix = "";
    while (dirname !== ".") {
        suffix = Path.join(Path.basename(dirname), suffix);
        dirname = Path.dirname(dirname);
        if (dirname in baseUrlMap) {
            return Path.join(baseUrlMap[dirname], suffix);
        }
    }
    return null;
}

export function uriToModuleName(uri: vscode.Uri): string {
    const fileName = Path.basename(uri.path, uri.path.endsWith("ts") ? ".ts" : ".tsx");
    return _.camelCase(fileName);
}

export function uriToCompletionItem(
    uri: vscode.Uri,
    baseUrlMap: Record<string, string>,
    pathMappings: Record<string, PathMapping>,
): vscode.CompletionItem {
    const moduleName = uriToModuleName(uri);
    const importPath = uriToImportPath(uri, baseUrlMap, pathMappings);
    const completionItem = new vscode.CompletionItem(moduleName, vscode.CompletionItemKind.Module);
    completionItem.detail = importPath;
    const importEdit = `import * as ${moduleName} from "${importPath}";\n`;
    completionItem.additionalTextEdits = [
        vscode.TextEdit.insert(new vscode.Position(0, 0), importEdit),
    ];
    return completionItem;
}

export interface PathMapping {
    baseUrl?: string;
    paths?: Record<string, string[]>;
}

export interface TypeScriptProject {
    tsconfigPath: string;
    rootPath: string;
    workspaceFolder: vscode.WorkspaceFolder;
    baseUrl?: string;
    paths?: Record<string, string[]>;
    completionItemsMap?: CompletionItemMap;
}

export function findProjectForFile(
    uri: vscode.Uri,
    projects: TypeScriptProject[]
): TypeScriptProject | undefined {
    const filePath = uri.path;
    
    // Find all projects that could contain this file
    const candidateProjects = projects.filter(project => 
        filePath.startsWith(project.rootPath)
    );
    
    if (candidateProjects.length === 0) {
        return undefined;
    }
    
    // Return the project with the deepest (most specific) root path
    return candidateProjects.reduce((deepest, current) => 
        current.rootPath.length > deepest.rootPath.length ? current : deepest
    );
}

export function uriToImportPathForProject(
    uri: vscode.Uri,
    project: TypeScriptProject
): string {
    const workspaceFolderPath = project.workspaceFolder.uri.path;
    const uriRelativePath = Path.relative(workspaceFolderPath, uri.path);

    // First try path mappings specific to this project
    if (project.paths) {
        const matchedPath = _matchPathPatternForProject(uriRelativePath, project);
        if (matchedPath) {
            return matchedPath.slice(0, matchedPath.length - Path.extname(matchedPath).length);
        }
    }

    // Fall back to baseUrl resolution
    if (project.baseUrl) {
        const projectRelativePath = Path.relative(project.rootPath, uri.path);
        const baseUrlPath = Path.join(project.baseUrl, projectRelativePath);
        return baseUrlPath.slice(0, baseUrlPath.length - Path.extname(baseUrlPath).length);
    }

    // Final fallback - relative to project root
    const projectRelativePath = Path.relative(project.rootPath, uri.path);
    return projectRelativePath.slice(0, projectRelativePath.length - Path.extname(projectRelativePath).length);
}

function _matchPathPatternForProject(filePath: string, project: TypeScriptProject): string | null {
    if (!project.paths) return null;

    const projectRelativeRoot = Path.relative(project.workspaceFolder.uri.path, project.rootPath);

    for (const [pattern, mappings] of Object.entries(project.paths)) {
        // Skip the dummy pattern that resolves nothing
        if (mappings.includes("dummy-value-so-nothing-is-resolved")) {
            continue;
        }

        for (const mapping of mappings) {
            // Resolve the mapping relative to the project's baseUrl (which is ".")
            let resolvedMapping = mapping;
            if (mapping.startsWith("./")) {
                // "./src/*" becomes "project1/src/*" when project is at "project1/"
                resolvedMapping = Path.join(projectRelativeRoot, mapping.slice(2));
            } else if (mapping.startsWith("../")) {
                // "../project1/src/*" gets resolved relative to current project
                const workspaceRoot = project.workspaceFolder.uri.path;
                const absoluteMapping = Path.resolve(project.rootPath, mapping);
                resolvedMapping = Path.relative(workspaceRoot, absoluteMapping);
            } else if (!Path.isAbsolute(mapping)) {
                resolvedMapping = Path.join(projectRelativeRoot, mapping);
            }

            // Handle wildcard patterns like "project1/*" -> "project1/src/*"
            if (pattern.includes("*") && resolvedMapping.includes("*")) {
                // Create regex from mapping (right side) to match against file path
                const mappingRegex = resolvedMapping.replace(/\*/g, "(.*)");
                const regex = new RegExp(`^${mappingRegex}$`);
                const match = filePath.match(regex);
                
                if (match && match[1] !== undefined) {
                    // Replace wildcard in pattern (left side) with matched content
                    return pattern.replace(/\*/g, match[1]);
                }
            }
            // Handle exact matches (no wildcards)
            else if (!pattern.includes("*") && !resolvedMapping.includes("*")) {
                if (filePath.startsWith(resolvedMapping)) {
                    const relativePath = Path.relative(resolvedMapping, filePath);
                    return relativePath ? Path.join(pattern, relativePath) : pattern;
                }
            }
        }
    }
    
    return null;
}

export function uriToCompletionItemForProject(
    uri: vscode.Uri,
    project: TypeScriptProject,
): vscode.CompletionItem {
    const moduleName = uriToModuleName(uri);
    const importPath = uriToImportPathForProject(uri, project);
    const completionItem = new vscode.CompletionItem(moduleName, vscode.CompletionItemKind.Module);
    completionItem.detail = importPath;
    const importEdit = `import * as ${moduleName} from "${importPath}";\n`;
    completionItem.additionalTextEdits = [
        vscode.TextEdit.insert(new vscode.Position(0, 0), importEdit),
    ];
    return completionItem;
}
