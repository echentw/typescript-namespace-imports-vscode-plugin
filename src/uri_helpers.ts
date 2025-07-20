import * as vscode from "vscode";
import * as Path from "path";
import * as _ from "lodash";

export function uriToImportPath(
    uri: vscode.Uri, 
    baseUrlMap: Record<string, string>,
    pathMappings?: Record<string, any>
): string {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    const workspaceFolderPath = workspaceFolder === undefined ? "" : workspaceFolder.uri.path;
    const uriRelativePath = Path.relative(workspaceFolderPath, uri.path);
    
    console.log(`[Path Mapping Debug] Processing file: ${uriRelativePath}`);
    console.log(`[Path Mapping Debug] PathMappings available:`, pathMappings ? Object.keys(pathMappings) : 'none');
    
    // First try path mappings, then fall back to baseUrl
    const maybePathWithMapping = pathMappings ? _lookForPathWithMapping(uriRelativePath, pathMappings) : null;
    console.log(`[Path Mapping Debug] Path mapping result: ${maybePathWithMapping}`);
    
    const maybePathWithBaseUrl = maybePathWithMapping || _lookForPathWithBaseUrl(uriRelativePath, baseUrlMap);
    const importPath = maybePathWithBaseUrl ? maybePathWithBaseUrl : uriRelativePath;
    
    console.log(`[Path Mapping Debug] Final import path: ${importPath}`);
    return importPath.slice(0, importPath.length - Path.extname(importPath).length);
}

function _lookForPathWithMapping(uriPath: string, pathMappings: Record<string, any>): string | null {
    console.log(`[Path Mapping Debug] Looking for mapping for: ${uriPath}`);
    let dirname = uriPath;
    let suffix = "";
    
    while (dirname !== ".") {
        suffix = Path.join(Path.basename(dirname), suffix);
        dirname = Path.dirname(dirname);
        
        if (dirname in pathMappings) {
            console.log(`[Path Mapping Debug] Found mapping for dirname: ${dirname}`);
            const mapping = pathMappings[dirname];
            console.log(`[Path Mapping Debug] Mapping details:`, mapping);
            if (mapping.paths) {
                // Try to match against path patterns
                const matchedPath = _matchPathPattern(uriPath, mapping.paths, mapping.baseUrl || "");
                if (matchedPath) {
                    console.log(`[Path Mapping Debug] Matched path: ${matchedPath}`);
                    return matchedPath;
                }
            }
        }
    }
    
    // Check root level mappings (empty string key for workspace root)
    if ("" in pathMappings) {
        console.log(`[Path Mapping Debug] Checking root level mappings (empty string key)`);
        const rootMapping = pathMappings[""];
        console.log(`[Path Mapping Debug] Root mapping:`, rootMapping);
        if (rootMapping.paths) {
            const matchedPath = _matchPathPattern(uriPath, rootMapping.paths, rootMapping.baseUrl || "");
            if (matchedPath) {
                console.log(`[Path Mapping Debug] Root matched path: ${matchedPath}`);
                return matchedPath;
            }
        }
    }
    
    // Also check for "." key as fallback
    if ("." in pathMappings) {
        console.log(`[Path Mapping Debug] Checking root level mappings (dot key)`);
        const rootMapping = pathMappings["."];
        console.log(`[Path Mapping Debug] Root mapping:`, rootMapping);
        if (rootMapping.paths) {
            const matchedPath = _matchPathPattern(uriPath, rootMapping.paths, rootMapping.baseUrl || "");
            if (matchedPath) {
                console.log(`[Path Mapping Debug] Root matched path: ${matchedPath}`);
                return matchedPath;
            }
        }
    }
    
    console.log(`[Path Mapping Debug] No path mapping found for: ${uriPath}`);
    return null;
}

function _matchPathPattern(filePath: string, paths: Record<string, string[]>, baseUrl: string): string | null {
    console.log(`[Path Mapping Debug] Matching file: ${filePath} against paths:`, paths, `baseUrl: ${baseUrl}`);
    
    for (const [pattern, mappings] of Object.entries(paths)) {
        console.log(`[Path Mapping Debug] Checking pattern: ${pattern} -> mappings:`, mappings);
        
        for (const mapping of mappings) {
            // Resolve mapping relative to baseUrl if needed
            const resolvedMapping = baseUrl ? Path.join(baseUrl, mapping) : mapping;
            console.log(`[Path Mapping Debug] Resolved mapping: ${resolvedMapping}`);
            
            // Handle wildcard patterns like "@/*" -> ["src/*"]
            if (pattern.includes("*") && resolvedMapping.includes("*")) {
                // Create regex from mapping (right side) to match against file path
                const mappingRegex = resolvedMapping.replace(/\*/g, "(.*)");
                const regex = new RegExp(`^${mappingRegex}$`);
                console.log(`[Path Mapping Debug] Testing regex: ${regex} against: ${filePath}`);
                const match = filePath.match(regex);
                console.log(`[Path Mapping Debug] Regex match result:`, match);
                
                if (match && match[1] !== undefined) {
                    // Replace wildcard in pattern (left side) with matched content
                    const result = pattern.replace(/\*/g, match[1]);
                    console.log(`[Path Mapping Debug] Generated import path: ${result}`);
                    return result;
                }
            }
            // Handle exact matches (no wildcards)
            else if (!pattern.includes("*") && !resolvedMapping.includes("*")) {
                console.log(`[Path Mapping Debug] Checking exact match: ${filePath} starts with ${resolvedMapping}?`);
                if (filePath.startsWith(resolvedMapping)) {
                    const relativePath = Path.relative(resolvedMapping, filePath);
                    const result = relativePath ? Path.join(pattern, relativePath) : pattern;
                    console.log(`[Path Mapping Debug] Exact match result: ${result}`);
                    return result;
                }
            }
        }
    }
    
    console.log(`[Path Mapping Debug] No pattern matched for: ${filePath}`);
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
    pathMappings?: Record<string, any>
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
