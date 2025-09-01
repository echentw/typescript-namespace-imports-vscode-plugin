# Typescript Namespace Imports

A VSCode plugin that makes it easier to automatically include namespace imports.

A [namespace import](http://exploringjs.com/es6/ch_modules.html#_importing-styles) is an import like:
```
import * as moduleName from 'path/to/module_name';
```

## Features

This plugin offers the camelCase version of every typescript file in your workspace as a module inside of autocomplete.

For example if the file `module_name` exists in your
workspace, it will offer to import it as a module called
`moduleName`.

- As you type "moduleNa", you will see "moduleName" as an autocomplete suggestion.
- If you select it, then `import * as moduleName from 'path/to/module_name';` will automatically be added to the top of the file.

## Extension Settings

```
"typescriptNamespaceImports.quoteStyle": {
    "type": "string",
    "enum": [
        "single",
        "double"
    ],
    "default": "single",
    "description": "Whether the auto-inserted import statement should use single or double quotes."
}
```
