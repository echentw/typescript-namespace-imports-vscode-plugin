import * as vscode from 'vscode';
import * as pathUtil from 'path';
import * as _ from 'lodash';
import * as u from './u';
import {TsConfigJson, TsProject, TsProjectPath} from './namespace_import_service';

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

type ModuleEvaluationForTsProject =
    | {type: 'bareImport'; moduleName: string; importPath: string}
    | {type: 'relativeImport'; moduleName: string}
    | {type: 'importDisallowed'};

// TODO: Looks like TsProject is needed to get the workspaceFolder.
// Could we just pass the workspaceFolder directly in as a separate parameter?
// Then we could... pass in tsConfigJson instead of TsProject, and remove the 'workspaceFolder' property
// from TsProject potentially.
export function evaluateModuleForTsProject(
    tsProjectPath: TsProjectPath,
    tsProject: TsProject,
    moduleUri: vscode.Uri,
): ModuleEvaluationForTsProject {
    const moduleName = makeModuleName(moduleUri);

    const bareImportPath = makeBareImportPath(tsProjectPath, tsProject, moduleUri);
    if (bareImportPath !== null) {
        return {
            type: 'bareImport',
            moduleName,
            importPath: bareImportPath,
        };
    }

    if (moduleUri.path.startsWith(tsProjectPath)) {
        return {
            type: 'relativeImport',
            moduleName,
        };
    }

    return {type: 'importDisallowed'};
}

export function makeCompletionItem(
    moduleName: string,
    importStatement: string,
): vscode.CompletionItem {
    const completionItem = new vscode.CompletionItem(moduleName, vscode.CompletionItemKind.Module);
    completionItem.detail = moduleName;
    completionItem.additionalTextEdits = [
        vscode.TextEdit.insert(new vscode.Position(0, 0), importStatement),
    ];
    return completionItem;
}

function makeModuleName(uri: vscode.Uri): string {
    const fileName = pathUtil.basename(uri.path, uri.path.endsWith('ts') ? '.ts' : '.tsx');
    return _.camelCase(fileName);
}

function makeBareImportPath(
    tsProjectPath: TsProjectPath,
    tsProject: TsProject,
    moduleUri: vscode.Uri,
): string | null {
    const matchedPath = matchPathPatternForProject(tsProjectPath, tsProject, moduleUri);
    if (matchedPath !== null) {
        return u.pathWithoutExt(matchedPath);
    }

    if (tsProject.tsConfigJson.baseUrl !== null) {
        const baseUrlPath = pathUtil.resolve(tsProjectPath, tsProject.tsConfigJson.baseUrl);
        if (moduleUri.path.startsWith(baseUrlPath)) {
            const moduleRelativePath = pathUtil.relative(baseUrlPath, moduleUri.path);

            if (!doesImportPathViaBaseUrlConflictWithPathsMapping(moduleRelativePath, tsProject.tsConfigJson)) {
                return u.pathWithoutExt(moduleRelativePath);
            }
        }
    }

    return null;
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

            if (pattern.includes('*')) {
                // Handle wildcard: "src/*" matches "src/components/Button"
                const patternPrefix = pattern.replace('*', '');
                const mappingPrefix = workspaceRelativeMapping.replace('*', '');

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

function doesImportPathViaBaseUrlConflictWithPathsMapping(
    moduleRelativePath: string,
    tsConfigJson: TsConfigJson,
): boolean {
    if (tsConfigJson.paths === null) return false;

    // Make sure this doesn't conflict with `paths`
    for (let pattern of Object.keys(tsConfigJson.paths)) {
        if (pattern.includes('*')) {
            pattern = pattern.replace('*', '');
        }
        if (moduleRelativePath.startsWith(pattern)) {
            return true;
        }
    }
    return false;
}
