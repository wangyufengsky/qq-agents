import { subjectInboxEnabled } from "../core/role-rest.mjs";
import { DESKTOP_CONVERSATION } from "../home/desktop-decision.mjs";
import { videoVision } from "../video/policy.mjs";
import { supportsMessageImages } from "../backends/capabilities.mjs";
import {
  DESKTOP_BROWSER_CONTROL,
  DESKTOP_BODY_CONTROL,
  DESKTOP_NATIVE_CONTROL,
  DESKTOP_SCREEN_VIEW,
} from "./names.mjs";

const desktopToolNames = new Set([
  DESKTOP_BODY_CONTROL,
  DESKTOP_SCREEN_VIEW,
  DESKTOP_NATIVE_CONTROL,
  DESKTOP_BROWSER_CONTROL,
  "self_read",
  "self_propose",
  "memory_related",
  "diary_write",
  "diary_revise",
  "projects",
  "web_fetch",
  "app_search",
  "app_read",
  "app_capabilities",
  "media_list",
  "sticker_read",
  "video_read",
  "qq_image_read",
  "work_note",
  "work_notes",
  "file_list",
  "file_read",
  "file_download",
  "file_create",
  "file_revise",
  "subject_inbox_submit",
  "subject_inbox_list",
]);

export function desktopRoleToolsEnabled(config, agent) {
  return (
    config.desktopHome?.enabled === true &&
    config.desktopHome.toolRoles?.includes(agent.id) === true
  );
}

export function desktopToolCandidate(name) {
  return desktopToolNames.has(name);
}

export function isDesktopToolContext(ctx) {
  return (
    ctx.runtimeKind === "desktop" && ctx.conversation === DESKTOP_CONVERSATION
  );
}

export function desktopToolAvailable(agent, name, config) {
  if (name === DESKTOP_BODY_CONTROL)
    return (
      config.desktopHome?.enabled === true &&
      config.desktopHome.bodyControlRoles?.includes(agent.id) === true
    );
  if (!desktopRoleToolsEnabled(config, agent) || !desktopToolCandidate(name))
    return false;
  if (name === "video_read")
    return agent.tools.includes(name) && videoVision(agent, config);
  if (name === DESKTOP_BROWSER_CONTROL)
    return config.desktopHome.browserControl?.enabled === true;
  if (name === DESKTOP_NATIVE_CONTROL)
    return config.desktopHome.nativeControl?.enabled === true;
  if (name === DESKTOP_SCREEN_VIEW) {
    const backend = config.backends.find(({ id }) => id === agent.backendId);
    return (
      config.desktopHome.screenView?.enabled === true &&
      agent.behavior.imageInput.enabled &&
      Boolean(backend && supportsMessageImages(backend))
    );
  }
  if (name.startsWith("app_") && !agent.apps?.enabled) return false;
  if (name.startsWith("file_") && !agent.files?.enabled) return false;
  if (name === "file_create" || name === "file_revise") {
    if (!agent.files.create) return false;
  }
  if (name === "file_download" && !agent.files.download && !agent.files.receive)
    return false;
  if (name === "file_read" && agent.tools.includes("file_list")) return true;
  if (name === "file_revise" && agent.tools.includes("file_create"))
    return true;
  if (name.startsWith("subject_inbox_")) return subjectInboxEnabled(agent);
  return agent.tools.includes(name);
}
