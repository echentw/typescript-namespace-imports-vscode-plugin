import * as vscode from "vscode";
import * as pathUtil from "path";
import * as _ from "lodash";
import { CompletionItemMap } from "./completion_item_map";

export type PathMapping = {
    baseUrl?: string;
    paths?: Record<string, Array<string>>;
}

export type TypeScriptProject = {
    tsconfigPath: string;
    rootPath: string;
    workspaceFolder: vscode.WorkspaceFolder;
    baseUrl?: string;
    paths?: Record<string, Array<string>>;
    completionItemsMap?: CompletionItemMap;
}

export function findProjectForFile(
    uri: vscode.Uri,
    projects: Array<TypeScriptProject>,
): TypeScriptProject | null {
    const filePath = uri.path;
    
    // Find all projects that could contain this file
    const candidateProjects = projects.filter(project => 
        filePath.startsWith(project.rootPath)
    );
    
    if (candidateProjects.length === 0) {
        return null;
    }
    
    // Return the project with the deepest (most specific) root path
    return candidateProjects.reduce((deepest, current) => 
        current.rootPath.length > deepest.rootPath.length ? current : deepest
    );
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

function uriToModuleName(uri: vscode.Uri): string {
    const fileName = pathUtil.basename(uri.path, uri.path.endsWith("ts") ? ".ts" : ".tsx");
    return _.camelCase(fileName);
}

function uriToImportPathForProject(
    uri: vscode.Uri,
    project: TypeScriptProject
): string {
    const workspaceFolderPath = project.workspaceFolder.uri.path;
    const uriRelativePath = pathUtil.relative(workspaceFolderPath, uri.path);

    // First try path mappings specific to this project
    if (project.paths) {
        const matchedPath = matchPathPatternForProject(uriRelativePath, project);
        if (matchedPath) {
            return matchedPath.slice(0, matchedPath.length - pathUtil.extname(matchedPath).length);
        }
    }

    // Fall back to baseUrl resolution
    if (project.baseUrl) {
        const projectRelativePath = pathUtil.relative(project.rootPath, uri.path);
        const baseUrlPath = pathUtil.join(project.baseUrl, projectRelativePath);
        return baseUrlPath.slice(0, baseUrlPath.length - pathUtil.extname(baseUrlPath).length);
    }

    // Final fallback - relative to project root
    const projectRelativePath = pathUtil.relative(project.rootPath, uri.path);
    return projectRelativePath.slice(0, projectRelativePath.length - pathUtil.extname(projectRelativePath).length);
}

function matchPathPatternForProject(filePath: string, project: TypeScriptProject): string | null {
    if (!project.paths) return null;

    const projectRelativeRoot = pathUtil.relative(project.workspaceFolder.uri.path, project.rootPath);

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
                resolvedMapping = pathUtil.join(projectRelativeRoot, mapping.slice(2));
            } else if (mapping.startsWith("../")) {
                // "../project1/src/*" gets resolved relative to current project
                const workspaceRoot = project.workspaceFolder.uri.path;
                const absoluteMapping = pathUtil.resolve(project.rootPath, mapping);
                resolvedMapping = pathUtil.relative(workspaceRoot, absoluteMapping);
            } else if (!pathUtil.isAbsolute(mapping)) {
                resolvedMapping = pathUtil.join(projectRelativeRoot, mapping);
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
                    const relativePath = pathUtil.relative(resolvedMapping, filePath);
                    return relativePath ? pathUtil.join(pattern, relativePath) : pattern;
                }
            }
        }
    }

    return null;
}
