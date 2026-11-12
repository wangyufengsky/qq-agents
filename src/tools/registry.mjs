import { reactionDefinitions, reactionTool } from "./reactions.mjs";
import { groupReadDefinitions, groupReadTool } from "./group-read.mjs";
import { profileDefinitions, profileTool } from "./profile.mjs";
import { qzoneDefinitions, qzoneTool } from "./qzone.mjs";
import { gameDefinitions, gameTool } from "../games/framework/tools.mjs";
import { definitions } from "./definitions.mjs";
import {
  DESKTOP_DECISION,
  DESKTOP_HISTORY,
  DESKTOP_SCREEN_VIEW,
  DESKTOP_NATIVE_CONTROL,
  DESKTOP_BROWSER_CONTROL,
  FUNCTIONAL_AGENT_RESULT,
  TOOL_NAMES,
} from "./names.mjs";
import { coreHandlers } from "./core-handlers.mjs";
import { recallFromChat } from "../core/memory-recall.mjs";
import { draftDefinitions, draftTool } from "./qq-drafts.mjs";
import { appDefinitions, appTool } from "../apps/tools.mjs";
import { githubDefinitions, githubTool } from "../github/tools.mjs";
import { mindDefinitions, mindTool } from "./mind.mjs";
import { fileDefinitions, fileTool } from "./file-tools.mjs";
import { savedMediaDefinitions, savedMediaTool } from "./saved-media.mjs";
import { screenshotDefinitions, screenshotTool } from "./screenshots.mjs";
import { legacyDefinitions, legacyTool } from "./legacy.mjs";
import { homeDefinitions, homeTool } from "./home.mjs";
import { socialDefinitions, socialTool } from "./home-social.mjs";
import { boardDefinitions, boardTool } from "./board.mjs";

// Discovery and dispatch use this same registry. Fail at load time on drift.
const handlers = {
  ...coreHandlers,
  [DESKTOP_HISTORY]: (runtime, ctx, args) =>
    runtime.desktopVisits.history(ctx, args),
  [DESKTOP_BROWSER_CONTROL]: (runtime, ctx, args) =>
    runtime.desktopVisits.browser.run(ctx, args),
  [DESKTOP_NATIVE_CONTROL]: (runtime, ctx, args) =>
    runtime.desktopVisits.native.run(ctx, args),
  [DESKTOP_SCREEN_VIEW]: (runtime, ctx) =>
    runtime.desktopVisits.screen.view(ctx),
  memory_recall: recallFromChat,
  [DESKTOP_DECISION]: (_runtime, ctx, args) => {
    if (ctx.runtimeKind !== "desktop") throw Error("TOOL_DISABLED");
    return ctx.desktopDecision(args);
  },
  [FUNCTIONAL_AGENT_RESULT]: (runtime, ctx, args) => {
    runtime.validateFunctionalEvidence(ctx, args.evidenceIds);
    if (args.contribution) runtime.assertSafeOutput(ctx, args.contribution);
    return runtime.functionalDelegation.submit(ctx, args);
  },
  protected_work_submit: (runtime, ctx, args) =>
    runtime.protectedWork.submit(ctx, args),
};
for (const [group, dispatch] of [
  [appDefinitions, appTool],
  [gameDefinitions, gameTool],
  [reactionDefinitions, reactionTool],
  [groupReadDefinitions, groupReadTool],
  [profileDefinitions, profileTool],
  [qzoneDefinitions, qzoneTool],
  [githubDefinitions, githubTool],
  [mindDefinitions, mindTool],
  [fileDefinitions, fileTool],
  [savedMediaDefinitions, savedMediaTool],
  [screenshotDefinitions, screenshotTool],
  [legacyDefinitions, legacyTool],
  [draftDefinitions, draftTool],
  [boardDefinitions, boardTool],
  [homeDefinitions, homeTool],
  [socialDefinitions, socialTool],
])
  for (const name of Object.keys(group)) {
    if (Object.hasOwn(handlers, name)) throw Error("DUPLICATE_TOOL_HANDLER");
    handlers[name] = (runtime, ctx, args) => dispatch(runtime, ctx, name, args);
  }
const registeredNames = [
  ...TOOL_NAMES,
  FUNCTIONAL_AGENT_RESULT,
  DESKTOP_DECISION,
];
if (
  new Set(registeredNames).size !== registeredNames.length ||
  registeredNames.length !== Object.keys(definitions).length ||
  registeredNames.some((name) => !Object.hasOwn(definitions, name)) ||
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
