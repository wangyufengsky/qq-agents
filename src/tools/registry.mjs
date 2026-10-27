import { definitions } from "./definitions.mjs";
import { coreHandlers } from "./core-handlers.mjs";
import { appDefinitions, appTool } from "../apps/tools.mjs";
import { githubDefinitions, githubTool } from "../github/tools.mjs";
import { mindDefinitions, mindTool } from "./mind.mjs";
import { fileDefinitions, fileTool } from "./file-tools.mjs";
import { savedMediaDefinitions, savedMediaTool } from "./saved-media.mjs";
import { screenshotDefinitions, screenshotTool } from "./screenshots.mjs";
import { legacyDefinitions, legacyTool } from "./legacy.mjs";

// Discovery and dispatch use this same registry. Fail at load time on drift.
const handlers = { ...coreHandlers };
for (const [group, dispatch] of [
  [appDefinitions, appTool],
  [githubDefinitions, githubTool],
  [mindDefinitions, mindTool],
  [fileDefinitions, fileTool],
  [savedMediaDefinitions, savedMediaTool],
  [screenshotDefinitions, screenshotTool],
  [legacyDefinitions, legacyTool],
])
  for (const name of Object.keys(group)) {
    if (Object.hasOwn(handlers, name)) throw Error("DUPLICATE_TOOL_HANDLER");
    handlers[name] = (runtime, ctx, args) => dispatch(runtime, ctx, name, args);
  }
if (
  Object.keys(handlers).length !== Object.keys(definitions).length ||
  Object.keys(definitions).some((name) => typeof handlers[name] !== "function")
)
  throw Error("TOOL_REGISTRY_MISMATCH");
export const registry = Object.freeze(
  Object.fromEntries(
    Object.entries(definitions).map(([name, [description, schema]]) => [
      name,
      Object.freeze({ description, schema, handler: handlers[name] }),
    ]),
  ),
);
