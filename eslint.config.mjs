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
    "agentDefaults",
    "api",
    "area",
    "blockerLabels",
    "check",
    "config",
    "conversationLabel",
    "disabledAttr",
    "disabledHints",
    "disabledReason",
    "esc",
    "fillIds",
    "find",
    "fold",
    "icon",
    "ids",
    "input",
    "load",
    "notice",
    "operate",
    "range",
    "readConversation",
    "readMemory",
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
  "document-reader.js": [
    "openDocument",
    "documentMarkdown",
    "downloadDocument",
  ],
  "mind-ui.js": ["mindAgentId", "renderMind"],
  "projects-ui.js": [
    "projectAgentId",
    "renderProjects",
    "openProject",
    "projectActor",
  ],
  "mood-ui.js": ["bindMood", "moodMarkup"],
  "people-ui.js": [
    "bindPeople",
    "bindPersonCards",
    "openPersonCard",
    "peopleMarkup",
    "personCallText",
    "personCardButton",
  ],
  "updates-ui.js": ["renderUpdates", "renderUpdateBadge"],
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
];
