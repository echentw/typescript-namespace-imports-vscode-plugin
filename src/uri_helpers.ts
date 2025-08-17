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
    // First try path mappings specific to this project
    if (tsProject.tsConfigJson.paths !== null) {
        const matchedPath = matchPathPatternForProject(tsProjectPath, tsProject, moduleUri);
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
    moduleUri: vscode.Uri,
): string | null {
    if (!tsProject.tsConfigJson.paths) return null;

    const workspaceFolderPath = tsProject.workspaceFolder.uri.path;
    const moduleRelativePath = pathUtil.relative(workspaceFolderPath, moduleUri.path);

    const baseUrl = tsProject.tsConfigJson.baseUrl ?? ".";
    const basePath = pathUtil.resolve(tsProjectPath, baseUrl);

    for (const [pattern, mappings] of Object.entries(tsProject.tsConfigJson.paths)) {
        for (const mapping of mappings) {
            const resolvedMapping = pathUtil.resolve(basePath, mapping);
            const workspaceRelativeMapping = pathUtil.relative(workspaceFolderPath, resolvedMapping);

            if (pattern.includes("*")) {
                // Handle wildcard: "src/*" matches "src/components/Button"
                const patternPrefix = pattern.replace("*", "");
                const mappingPrefix = workspaceRelativeMapping.replace("*", "");
                
                if (moduleRelativePath.startsWith(mappingPrefix)) {
                    const suffix = moduleRelativePath.slice(mappingPrefix.length);
                    return patternPrefix + suffix;
                }
            } else if (moduleRelativePath === workspaceRelativeMapping) {
                return pattern;
            }
        }
    }

    return null;
}
