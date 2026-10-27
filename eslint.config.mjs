import js from "@eslint/js";
import globals from "globals";

const unusedVars = {
  args: "none",
  varsIgnorePattern: "^_",
  caughtErrors: "none",
  ignoreRestSiblings: true,
};

// public/*.js are classic `<script defer>` files (see public/index.html) that
// share one global scope. Each entry lists the top-level names a script defines
// for the others; every other browser script sees them as globals. Add a name
// here when a script starts using another script's top-level binding.
const browserScripts = {
  "app.js": [
    "$",
    "action",
    "advanced",
    "api",
    "area",
    "blockerLabels",
    "check",
    "config",
    "disabledAttr",
    "disabledHints",
    "disabledReason",
    "esc",
    "features",
    "find",
    "icon",
    "input",
    "load",
    "notice",
    "operate",
    "render",
    "revision",
    "roleId",
    "select",
    "setGlobalPaused",
    "status",
    "tab",
    "tag",
    "token",
    "tools",
  ],
  "activity-ui.js": ["activityAgentId", "renderActivity"],
  "agent-form.js": ["agentForm"],
  "apps-ui.js": ["appAgentId", "renderApps"],
  "files-ui.js": ["fileAgentId", "renderFilePermissions"],
  "mind-ui.js": ["mindAgentId", "renderMind"],
  "onboarding-ui.js": ["renderOnboarding"],
  "parity.js": ["parityAgentId", "renderParity"],
};
const sharedFrom = (except) =>
  Object.fromEntries(
    Object.entries(browserScripts)
      .filter(([file]) => file !== except)
      .flatMap(([, names]) => names.map((name) => [name, "writable"])),
  );

export default [
  {
    // Vendored upstream code keeps its own style.
    ignores: ["vendor/**", "node_modules/**"],
  },
  {
    files: ["**/*.{js,mjs}"],
    languageOptions: {
      globals: globals.node,
      ecmaVersion: "latest",
      sourceType: "module",
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-unused-vars": ["error", unusedVars],
    },
  },
  {
    files: ["public/**/*.js"],
    languageOptions: {
      sourceType: "script",
      globals: {
        ...globals.browser,
        // app.js declares top-level `status` and `find` (shared below), which
        // shadow the legacy window.status / window.find properties.
        status: "off",
        find: "off",
      },
    },
    rules: {
      // Top-level bindings are the scripts' shared interface (see above), so
      // only report unused variables inside functions.
      "no-unused-vars": ["error", { ...unusedVars, vars: "local" }],
    },
  },
  ...Object.keys(browserScripts).map((file) => ({
    files: [`public/${file}`],
    languageOptions: { globals: sharedFrom(file) },
  })),
  // Owned by the in-flight Docker support change; fix and drop these overrides
  // once it has merged.
  {
    files: ["src/server.mjs"],
    // Prettier's chosen layout for a computed member call on a new line.
    rules: { "no-unexpected-multiline": "off" },
  },
  {
    files: ["src/tools/public-screenshot.mjs"],
    // Rethrows sanitized SCREENSHOT_* codes without the browser error text.
    rules: { "preserve-caught-error": "off" },
  },
];
