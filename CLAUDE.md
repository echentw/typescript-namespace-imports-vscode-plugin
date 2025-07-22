# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a VS Code extension that provides TypeScript namespace import autocompletion. It converts snake_case file names to camelCase import suggestions for namespace imports (e.g., `import * as fileToImport from "file_to_import"`).

## Development Commands

- **Build for development**: `npm run build` - Compiles with sourcemaps using esbuild
- **Watch mode**: `npm run watch` - Rebuilds automatically on file changes
- **Build for production**: `npm run vscode:prepublish` - Minified build for publishing
- **TypeScript build**: `npm run tsc-build` - TypeScript compiler build with strict type checking
- **Lint**: `npm run lint` - ESLint with TypeScript extensions
- **Format**: `npm run format` - Prettier formatting for all TypeScript files
- **TypeScript watch**: `npm run tsc-watch` - TypeScript compiler in watch mode

## Architecture

The extension follows a modular cache-based architecture:

### Core Components

1. **Extension Entry Point** (`src/extension.ts`): Registers completion providers and manages VS Code integration
2. **Completion Cache** (`src/completion_items_cache*.ts`): Interface and implementation for caching completion items across workspace folders
3. **Completion Item Map** (`src/completion_item_map*.ts`): Efficient storage and retrieval of completion items using prefix-based mapping
4. **URI Helpers** (`src/uri_helpers.ts`): Utilities for converting file URIs to completion items and handling path mappings

### Key Features

- **Multi-workspace support**: Handles multiple workspace folders with separate caches
- **File system monitoring**: Automatically updates cache when TypeScript files are added/removed
- **TypeScript configuration integration**: Respects `tsconfig.json` `baseUrl` and `paths` compiler options
- **GraphQL template literal detection**: Avoids conflicting with GraphQL fragment completions

### Caching Strategy

The extension uses a two-level caching system:
- Workspace-level cache containing base URL mappings and path mappings from tsconfig.json
- Prefix-based completion item map for fast lookups during autocompletion

### Build System

- **esbuild**: Used for fast bundling and minification
- **External dependencies**: VS Code API is marked as external
- **Output**: Single bundled file in `out/extension.js`