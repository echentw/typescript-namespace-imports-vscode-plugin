import * as vscode from 'vscode';
import * as pathUtil from 'path';
import * as _ from 'lodash';
import * as u from './u';
import {TsProject, TsProjectPath} from './completion_items_service';

export function findOwnerTsProjectForTsFile(
    uri: vscode.Uri,
    tsProjectPaths: Iterable<TsProjectPath>,
): TsProjectPath | null {
    // Find all projects that could contain this file
    const candidates = u.iter.filter(tsProjectPaths, tsProjectPath => uri.path.startsWith(tsProjectPath));
    if (candidates.length === 0) return null;

    // Return the project with the deepest (most specific) root path
    return u.max(candidates, u.cmp.transform(path => path.length, u.cmp.number));
}

// TODO: Looks like TsProject is needed to get the workspaceFolder.
// Could we just pass the workspaceFolder directly in as a separate parameter?
// Then we could... pass in tsConfigJson instead of TsProject, and remove the 'workspaceFolder' property
// from TsProject potentially.
export function makeModuleNameAndCompletionItem(
    tsProjectPath: TsProjectPath,
    tsProject: TsProject,
    moduleUri: vscode.Uri,
): [string, vscode.CompletionItem] | null {
    const moduleName = makeModuleName(moduleUri);
    const importPath = makeImportPath(tsProjectPath, tsProject, moduleUri);
    
    // Return null if this file can't be imported from this project
    if (importPath === null) return null;

    const completionItem = new vscode.CompletionItem(moduleName, vscode.CompletionItemKind.Module);

    // Right now the code in `.handleFileDeleted` relies on `.detail`
    // being a unique identifier for this module for this particular TS project.
    completionItem.detail = moduleName;

    completionItem.additionalTextEdits = [
        vscode.TextEdit.insert(
            new vscode.Position(0, 0),
            `import * as ${moduleName} from '${importPath}';\n`,
        ),
    ];

    return [moduleName, completionItem];
}

function makeModuleName(uri: vscode.Uri): string {
    const fileName = pathUtil.basename(uri.path, uri.path.endsWith('ts') ? '.ts' : '.tsx');
    return _.camelCase(fileName);
}

function makeImportPath(
    tsProjectPath: TsProjectPath,
    tsProject: TsProject,
    moduleUri: vscode.Uri,
): string | null {
    const workspaceFolderPath = tsProject.workspaceFolder.uri.path;
    const uriRelativePath = pathUtil.relative(workspaceFolderPath, moduleUri.path);

    // First try path mappings specific to this project
    if (tsProject.tsConfigJson.paths !== undefined) {
        const matchedPath = matchPathPatternForProject(tsProjectPath, tsProject, uriRelativePath);
        if (matchedPath !== null) {
            return matchedPath.slice(0, matchedPath.length - pathUtil.extname(matchedPath).length);
        }
    }

    // Fall back to baseUrl resolution
    if (tsProject.tsConfigJson.baseUrl !== null) {
        const projectRelativePath = pathUtil.relative(tsProjectPath, moduleUri.path);
        const baseUrlPath = pathUtil.join(tsProject.tsConfigJson.baseUrl, projectRelativePath);
        return baseUrlPath.slice(0, baseUrlPath.length - pathUtil.extname(baseUrlPath).length);
    }

    // Final fallback - relative to project root
    const projectRelativePath = pathUtil.relative(tsProjectPath, moduleUri.path);
    return projectRelativePath.slice(0, projectRelativePath.length - pathUtil.extname(projectRelativePath).length);
}

function matchPathPatternForProject(
    tsProjectPath: TsProjectPath,
    tsProject: TsProject,
    moduleRelativePath: string,
): string | null {
    if (!tsProject.tsConfigJson.paths) return null;

    const projectRelativeRoot = pathUtil.relative(tsProject.workspaceFolder.uri.path, tsProjectPath);

    for (const [pattern, mappings] of Object.entries(tsProject.tsConfigJson.paths)) {
        for (const mapping of mappings) {
            // Resolve the mapping relative to the project's baseUrl (which is ".")
            let resolvedMapping = mapping;
            if (mapping.startsWith("./")) {
                // "./src/*" becomes "project1/src/*" when project is at "project1/"
                resolvedMapping = pathUtil.join(projectRelativeRoot, mapping.slice(2));
            } else if (mapping.startsWith("../")) {
                // "../project1/src/*" gets resolved relative to current project
                const workspaceRoot = tsProject.workspaceFolder.uri.path;
                const absoluteMapping = pathUtil.resolve(tsProjectPath, mapping);
                resolvedMapping = pathUtil.relative(workspaceRoot, absoluteMapping);
            } else if (!pathUtil.isAbsolute(mapping)) {
                resolvedMapping = pathUtil.join(projectRelativeRoot, mapping);
            }

            // Handle wildcard patterns like "project1/*" -> "project1/src/*"
            if (pattern.includes("*") && resolvedMapping.includes("*")) {
                // Create regex from mapping (right side) to match against file path
                const mappingRegex = resolvedMapping.replace(/\*/g, "(.*)");
                const regex = new RegExp(`^${mappingRegex}$`);
                const match = moduleRelativePath.match(regex);

                if (match && match[1] !== undefined) {
                    // Replace wildcard in pattern (left side) with matched content
                    return pattern.replace(/\*/g, match[1]);
                }
            }
            // Handle exact matches (no wildcards)
            else if (!pattern.includes("*") && !resolvedMapping.includes("*")) {
                if (moduleRelativePath.startsWith(resolvedMapping)) {
                    const relativePath = pathUtil.relative(resolvedMapping, moduleRelativePath);
                    return relativePath ? pathUtil.join(pattern, relativePath) : pattern;
                }
            }
        }
    }

    return null;
}
