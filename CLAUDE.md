# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a VSCode extension that provides autocomplete support for TypeScript namespace imports. It automatically suggests camelCase module names from TypeScript files in the workspace and inserts the corresponding `import * as moduleName from 'path/to/module_name'` statement.

## Development Commands

### Build and Watch
- `npm run build` - Build with source maps using esbuild
- `npm run watch` - Build with source maps and watch for changes
- `npm run vscode:prepublish` - Production build with minification for publishing

### Type Checking
- `npm run tsc-build` - Run TypeScript compiler (type checking only)
- `npm run tsc-watch` - Run TypeScript compiler in watch mode

### Linting
- `npm run lint` - Run ESLint on TypeScript files

## Architecture

### Core Components

**Extension Entry Point (`src/extension.ts`)**
- Activates on TypeScript/React files
- Sets up file system watchers for `tsconfig.json`, `.ts`, and `.tsx` files
- Registers completion item provider
- Includes GraphQL tag detection to avoid conflicts with GraphQL extensions

**Completion Items Service (`src/completion_items_service.ts`)**
- Main service managing workspace-level caching of modules
- Maintains maps of available modules organized by first character for performance
- Handles workspace changes and file system events
- Supports both bare imports (via `baseUrl`/`paths` mappings) and relative imports
- Parses `tsconfig.json` files to understand project structure and path mappings

**URI Helpers (`src/uri_helpers.ts`)**
- Evaluates whether files can be imported as bare imports or relative imports
- Handles TypeScript path mapping resolution
- Creates VSCode completion items with auto-import functionality
- Converts file names to camelCase module names using lodash

**Utilities (`src/u.ts`)**
- Custom Result type for error handling
- Map and iteration utilities
- Path manipulation helpers
- Comparison and sorting functions

### Key Features

**Multi-Project Support**: Discovers and handles multiple `tsconfig.json` files in nested project structures, with deeper projects taking precedence.

**Path Mapping Resolution**: Supports TypeScript `baseUrl` and `paths` compiler options for resolving bare imports.

**Performance Optimization**: Uses first-character indexing to quickly filter completion suggestions, making the extension performant even in large codebases.

**File System Watching**: Automatically updates the module cache when files are added, removed, or moved.

**Import Conflict Avoidance**: Prevents suggesting imports for the current file and handles conflicts between path mappings and baseUrl resolutions.

## Extension Configuration

The extension activates on `typescript` and `typescriptreact` languages and requires VSCode ^1.63.1. It has no user-configurable settings currently.