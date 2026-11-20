// @ts-check
import { createHash } from "node:crypto";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

/** @param {unknown} value @param {string[]} names
 * @param {{path: string, sha256: string, bytes: number}[]} [images]
 * @param {string} [epoch] @param {boolean} [nativeMcp] */
export function antigravityToolAllowed(
  value,
  names,
  images = [],
  epoch,
  nativeMcp = false,
) {
  const call = /** @type {any} */ (value);
  if (nativeMcp && names.some((name) => call?.name === `mcp_qq-agents_${name}`))
    return true;
  if (call?.name === "read_file" || call?.name === "view_file") {
    const pathKey = call.name === "read_file" ? "Path" : "AbsolutePath";
    const file = images.find((image) => image.path === call.args?.[pathKey]);
    if (!file || Object.keys(call.args).some((key) => key !== pathKey))
      return false;
    try {
      const stat = fs.lstatSync(file.path);
      return (
        stat.isFile() &&
        !stat.isSymbolicLink() &&
        stat.size === file.bytes &&
        stat.size <= 8 * 1024 * 1024 &&
        createHash("sha256")
          .update(fs.readFileSync(file.path))
          .digest("hex") === file.sha256
      );
    } catch {
      return false;
    }
  }
  if (epoch && call?.name === "call_mcp_tool") {
    const args = call.args?.Arguments;
    return Boolean(
      call.args?.ServerName === "qq-agents" &&
      call.args?.ToolName === "qq_turn_call" &&
      args?.epoch === epoch &&
      names.includes(args?.name) &&
      args.arguments &&
      typeof args.arguments === "object" &&
      !Array.isArray(args.arguments) &&
      Object.keys(args).every((key) =>
        ["epoch", "name", "arguments"].includes(key),
      ),
    );
  }
  return (
    call?.name === "finish" ||
    (call?.name === "call_mcp_tool" &&
      call.args?.ServerName === "qq-agents" &&
      names.includes(call.args?.ToolName))
  );
}

/** @param {any} input @param {any} catalogue */
function currentHookStep(input, catalogue) {
  return (
    !catalogue.turnEpoch ||
    (input?.conversationId === catalogue.conversationId &&
      Number.isSafeInteger(input.stepIdx) &&
      input.stepIdx > catalogue.minimumStep)
  );
}

/** A native finish/image reader has no MCP envelope. Bind it to the native step
 * watermark; prompt text can quote old epochs and cannot identify authority.
 * @param {any} input @param {any} catalogue */
function hookDenial(input, catalogue) {
  if (!input?.toolCall || typeof input.toolCall.name !== "string")
    return "ANTIGRAVITY_HOOK_INVALID_INPUT";
  if (catalogue.turnEpoch && !currentHookStep(input, catalogue)) {
    if (
      typeof input.conversationId !== "string" ||
      !Number.isSafeInteger(input.stepIdx)
    )
      return "ANTIGRAVITY_HOOK_INVALID_INPUT";
    return input.conversationId !== catalogue.conversationId
      ? "ANTIGRAVITY_HOOK_WRONG_CONVERSATION"
      : "ANTIGRAVITY_HOOK_STALE_STEP";
  }
  const tools = catalogue.turnTools ?? catalogue.tools;
  if (
    antigravityToolAllowed(
      input.toolCall,
      tools.map((/** @type {any} */ tool) => tool.name),
      catalogue.images || [],
      catalogue.turnEpoch,
      catalogue.nativeMcp === true,
    )
  )
    return null;
  return ["read_file", "view_file"].includes(input.toolCall.name)
    ? "ANTIGRAVITY_HOOK_IMAGE_DENIED"
    : "ANTIGRAVITY_HOOK_TOOL_DENIED";
}

/** @param {any} input @param {any} catalogue */
export function antigravityHookAllowed(input, catalogue) {
  return hookDenial(input, catalogue) === null;
}

/** @param {URL} endpoint @param {Record<string, string>} headers */
async function hookCatalogue(endpoint, headers) {
  const signal = AbortSignal.timeout(2000);
  try {
    const response = await fetch(new URL("/catalog", endpoint), {
      headers,
      signal,
      redirect: "error",
    });
    if (!response.ok) {
      if (response.status === 410)
        return { reason: "ANTIGRAVITY_TURN_INACTIVE" };
      if (response.status === 403)
        return { reason: "ANTIGRAVITY_HOOK_CATALOG_FORBIDDEN" };
      return { reason: "ANTIGRAVITY_HOOK_CATALOG_UNAVAILABLE" };
    }
    try {
      const catalogue = await response.json();
      const tools = catalogue?.turnTools ?? catalogue?.tools;
      if (
        Array.isArray(tools) &&
        tools.every((tool) => typeof tool?.name === "string") &&
        (catalogue.images === undefined || Array.isArray(catalogue.images)) &&
        (catalogue.turnEpoch === undefined ||
          (typeof catalogue.turnEpoch === "string" &&
            catalogue.turnEpoch.length > 0 &&
            typeof catalogue.conversationId === "string" &&
            Number.isSafeInteger(catalogue.minimumStep)))
      )
        return { catalogue };
    } catch {
      if (signal.aborted) return { reason: "ANTIGRAVITY_HOOK_CATALOG_TIMEOUT" };
    }
    return { reason: "ANTIGRAVITY_HOOK_CATALOG_INVALID" };
  } catch {
    return {
      reason: signal.aborted
        ? "ANTIGRAVITY_HOOK_CATALOG_TIMEOUT"
        : "ANTIGRAVITY_HOOK_CATALOG_UNAVAILABLE",
    };
  }
}

/** The hook and MCP child share a turn-scoped endpoint, never a model-visible token. */
export async function guardMain() {
  let reason = "ANTIGRAVITY_HOOK_INVALID_INPUT";
  try {
    const input = fs.readFileSync(0, "utf8");
    if (input.length > 1048576) throw Error();
    const value = JSON.parse(input);
    reason = "ANTIGRAVITY_ENDPOINT_INVALID";
    const endpoint = new URL(process.env.QQ_AGY_ENDPOINT || "");
    if (
      endpoint.protocol !== "http:" ||
      endpoint.hostname !== "127.0.0.1" ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      throw Error();
    const headers = {
      authorization: `Bearer ${process.env.QQ_AGY_TOKEN || ""}`,
    };
    const result = await hookCatalogue(endpoint, headers);
    const catalogue = result.catalogue;
    if (!catalogue) {
      reason = result.reason ?? "ANTIGRAVITY_HOOK_CATALOG_INVALID";
    } else {
      reason = "ANTIGRAVITY_HOOK_INVALID_INPUT";
      const denial = hookDenial(value, catalogue);
      reason = denial ?? "QQ_AGENTS_TOOL_ALLOWED";
      if (denial && currentHookStep(value, catalogue)) {
        // Attribute only current-turn denials, with no tool arguments or paths.
        const route = catalogue.turnEpoch
          ? `/hook-denied?epoch=${encodeURIComponent(catalogue.turnEpoch)}`
          : "/hook-denied";
        await fetch(new URL(route, endpoint), {
          method: "POST",
          headers: { ...headers, "x-qq-hook-reason": denial },
          signal: AbortSignal.timeout(1000),
          redirect: "error",
        }).catch(() => {});
      }
    }
  } catch {
    // Unexpected hook errors preserve the current failure category and fail closed.
  }
  process.stdout.write(
    JSON.stringify({
      decision: reason === "QQ_AGENTS_TOOL_ALLOWED" ? "auto_approve" : "deny",
      reason,
    }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await guardMain();
