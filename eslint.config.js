// eslint.config.js
import js from "@eslint/js";
import globals from "globals";

export default [
    js.configs.recommended,
    {
        // Ignore configuration
        ignores: [
            ".dev-server/**/*",
            ".dev-server/**/*.js",
            ".dev-server/**/*.json"
        ]
    },
    {
        // Main configuration
        files: ["**/*.js"],
        languageOptions: {
            ecmaVersion: 2020,
            sourceType: "module",
            globals: {
                ...globals.es2020,
                ...globals.node,
                ...globals.mocha,
                navigator: "readonly",
                window: "readonly",
                __REACT_DEVTOOLS_GLOBAL_HOOK__: "readonly"
            }
        },
        rules: {
            "indent": ["error", 4, { "SwitchCase": 1 }],
            "no-console": "off",
            "no-unused-vars": ["error", {
                "ignoreRestSiblings": true,
                "argsIgnorePattern": "^_",
                "varsIgnorePattern": "^_"
            }],
            "no-var": "error",
            "no-trailing-spaces": "error",
            "prefer-const": "error",
            "quotes": ["error", "double", {
                "avoidEscape": true,
                "allowTemplateLiterals": true
            }],
            "semi": ["error", "always"],
            "no-undef": "error",
            "no-prototype-builtins": "off",
            "no-constant-condition": ["error", {
                "checkLoops": false
            }],
            "no-empty": ["error", {
                "allowEmptyCatch": true
            }],
            "no-cond-assign": ["error", "except-parens"],
            "no-func-assign": "error",
            "no-useless-escape": "error",
            "no-fallthrough": "error"
        },
        linterOptions: {
            reportUnusedDisableDirectives: true
        }
    }
];