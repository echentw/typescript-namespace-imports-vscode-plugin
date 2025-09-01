import * as u from './u';
import * as vscode from 'vscode';
import {CompletionItemsService, ExtensionSettings} from './completion_items_service';
import { Result } from './u';

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders === undefined) {
        console.warn('No workspace folder. typescript-namespace-imports-vscode-plugin will not work');
        return;
    }

    // Cache the quote style and update it when configuration changes
    let extensionSettings = fetchExtensionSettings();
    function fetchExtensionSettings(): ExtensionSettings {
        const config = vscode.workspace.getConfiguration('typescriptNamespaceImports');
        const value: string = config.get<ExtensionSettings['quoteStyle']>('quoteStyle', 'single');
        const result = u.parse.string.to.literalUnion(['single', 'double'])(value);
        if (!result.ok) {
            console.warn(`Failed to parse settings: "quoteStyle": ${result.err}`);
            return {
                quoteStyle: 'single',
            };
        }
        const quoteStyle = result.value;
        return {quoteStyle};
    }

    const service = CompletionItemsService.make(workspaceFolders);

    // Listen for configuration changes
    const configWatcher = vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('typescriptNamespaceImports.quoteStyle')) {
            extensionSettings = fetchExtensionSettings();
        }
    });

    // Whenever there is a change to the workspace folders refresh the cache
    const workspaceWatcher = vscode.workspace.onDidChangeWorkspaceFolders(service.handleWorkspaceChangedAsync);

    // Whenever a file is added or removed refresh the cache
    const fileSystemWatcher = vscode.workspace.createFileSystemWatcher('**/{tsconfig.json,*.ts,*.tsx}', false, false, false);
    fileSystemWatcher.onDidCreate(service.handleFileCreatedAsync);
    fileSystemWatcher.onDidDelete(service.handleFileDeletedAsync);
    fileSystemWatcher.onDidChange(service.handleFileChangedAsync);

    const provider = vscode.languages.registerCompletionItemProvider(
        [
            {scheme: 'file', language: 'typescript'},
            {scheme: 'file', language: 'typescriptreact'},
        ],
        {
            provideCompletionItems(doc: vscode.TextDocument, position: vscode.Position) {
                const wordRange = doc.getWordRangeAtPosition(position);
                // Don't provide completions if the cursor is inside a gql`` template literal to
                // avoid conflicting with fragment name completions from the GraphQL extension.
                if (wordRange === undefined || isInGraphQLTag(doc, position)) {
                    return new vscode.CompletionList([], true);
                }
                const word = doc.getText(wordRange);
                return service.getCompletionList(doc.uri, word, extensionSettings);
            },
        },
    );

    context.subscriptions.push(provider, fileSystemWatcher, workspaceWatcher, configWatcher);
}

// this method is called when your extension is deactivated
// eslint-disable-next-line @typescript-eslint/no-empty-function
export function deactivate() {}

/**
 * Returns an approximation for whether the cursor is inside a gql`` template literal by searching
 * backwards in the document. Returns true if "gql`" is encountered before a standalone "`" or
 * a semicolon.
 */
function isInGraphQLTag(doc: vscode.TextDocument, position: vscode.Position): boolean {
    const textBeforeCursor = doc.lineAt(position.line).text.slice(0, position.character);
    if (openGraphQLTag.test(textBeforeCursor)) {
        return true;
    }
    if (textBeforeCursor.includes('`') || textBeforeCursor.includes(';')) {
        return false;
    }
    for (let i = position.line - 1; i >= 0; i--) {
        const line = doc.lineAt(i).text;
        if (openGraphQLTag.test(line)) {
            return true;
        }
        if (line.includes('`') || line.includes(';')) {
            return false;
        }
    }
    return false;
}
const openGraphQLTag = /gql`[^`]*$/;
