import * as vscode from "vscode";

export interface CompletionItemMap {
    putItem(item: vscode.CompletionItem): void;
    getItemsAt(key: string): vscode.CompletionItem[];
    removeItem(item: vscode.CompletionItem): void;
}

export const CompletionItemMap = {
    make: (
        items: vscode.CompletionItem[],
        getKey: (item: vscode.CompletionItem) => string,
    ): CompletionItemMap => {
        return new CompletionItemMapImpl(items, getKey);
    },
};

export class CompletionItemMapImpl implements CompletionItemMap {
    private _map: Record<string, vscode.CompletionItem[]> = {};

    constructor(
        items: vscode.CompletionItem[],
        private makeKey: (item: vscode.CompletionItem) => string
    ) {
        for (const item of items) {
            this.putItem(item);
        }
    }

    putItem = (item: vscode.CompletionItem): void => {
        const key = this.makeKey(item);
        if (this._map[key] === undefined) {
            this._map[key] = [item];
        } else {
            this._map[key].push(item);
        }
    };

    getItemsAt = (key: string): vscode.CompletionItem[] => {
        return this._map[key] ?? [];
    };

    removeItem = (item: vscode.CompletionItem): void => {
        const key = this.makeKey(item);
        const itemsInMap = this._map[key];
        if (itemsInMap !== undefined) {
            this._map[key] = itemsInMap.filter(itemInMap => itemInMap !== item);
        }
    };
}
