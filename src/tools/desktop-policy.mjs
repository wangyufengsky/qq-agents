import { subjectInboxEnabled } from "../core/role-rest.mjs";
import { DESKTOP_CONVERSATION } from "../home/desktop-decision.mjs";

const desktopToolNames = new Set([
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
  if (!desktopRoleToolsEnabled(config, agent) || !desktopToolCandidate(name))
    return false;
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
