import js from "@eslint/js";
import globals from "globals";
// Incremental boundary: new coordination, persistence and dispatch modules.
export default [
  {
    files: [
      "src/core/{runtime,config-impact,config-updates,default-config,delivery,turn-runner,runtime-status,conversations,lifecycle}.mjs",
      "src/memory/{conversation-due,conversation-state}.mjs",
      "src/tools/{index,specs,definitions,registry,core-handlers,catalog}.mjs",
      "src/main.mjs",
      "scripts/{default-config,scheduling-benchmark}.mjs",
      "test/{due-scheduling,config-updates,package-startup,tool-registry}.test.mjs",
      "eslint.config.mjs",
    ],
    languageOptions: {
      globals: globals.node,
      ecmaVersion: "latest",
      sourceType: "module",
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-unused-vars": [
        "error",
        {
          args: "none",
          varsIgnorePattern: "^_",
          caughtErrors: "none",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
];
