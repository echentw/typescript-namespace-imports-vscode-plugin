import * as vscode from "vscode";
import * as Path from "path";
import * as _ from "lodash";

export function uriToImportPath(
    uri: vscode.Uri,
    baseUrlMap: Record<string, string>,
    pathMappings?: Record<string, PathMapping>
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
    pathMappings: Record<string, PathMapping>
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