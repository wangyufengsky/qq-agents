// @ts-check
import { socialSessionPool } from "./social-sessions.mjs";
import { sessionWasUnchanged } from "./turn-failure.mjs";
import {
  DESKTOP_DECISION,
  DESKTOP_HISTORY,
  DESKTOP_MEMORY_TOOLS,
} from "../tools/names.mjs";
import { desktopToolCandidate } from "../tools/desktop-policy.mjs";
import { SOCIAL_TOOLS } from "../home/social-tool-names.mjs";

const allowed = new Set([
  ...SOCIAL_TOOLS.filter((name) => name !== "home_social_process"),
  "room_scene_view",
  "self_read",
  "work_notes",
  "person_notes",
  "person_items",
  "mood_read",
]);
const desktopAllowed = new Set([
  DESKTOP_DECISION,
  DESKTOP_HISTORY,
  ...DESKTOP_MEMORY_TOOLS,
]);
const desktopMedia = new Set(["qq_image_read", "sticker_read"]);
const desktopImageTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/** Only registered image readers may add pixels outside the text quota.
 * @param {string} name @param {any} result @param {number} maxTextBytes
 * @param {boolean} [desktop] */
export function assertSocialToolResult(
  name,
  result,
  maxTextBytes,
  desktop = false,
) {
  const content = Array.isArray(result?.content) ? result.content : [],
    images = content.filter((/** @type {any} */ item) => item.type === "image");
  if (images.length) {
    const regularImage = desktop && desktopMedia.has(name);
    const imageLimit = (regularImage ? 8 : 4) * 1024 * 1024;
    if (
      (regularImage
        ? images.length > 12
        : name !== "room_scene_view" || images.length !== 1) ||
      images.some(
        (/** @type {any} */ image) =>
          !(regularImage
            ? desktopImageTypes.has(image.mimeType)
            : image.mimeType === "image/png") ||
          typeof image.data !== "string" ||
          image.data.length > Math.ceil(imageLimit / 3) * 4,
      ) ||
      images.reduce(
        (/** @type {number} */ bytes, /** @type {any} */ image) =>
          bytes + Buffer.byteLength(image.data, "base64"),
        0,
      ) > imageLimit
    )
      throw Error("SOCIAL_TOOL_RESULT_LIMIT");
  }
  const text = JSON.stringify(
    images.length
      ? {
          ...result,
          content: content.map((/** @type {any} */ item) =>
            item.type === "image" ? { ...item, data: "" } : item,
          ),
        }
      : result,
  );
  if (Buffer.byteLength(text || "") > maxTextBytes)
    throw Error("SOCIAL_TOOL_RESULT_LIMIT");
}

/** Each window owns a separate session per actor; submitted prompts never retry.
 * @param {any} backend @param {any} params
 * @param {(session: any, conversation: string) => Promise<void>} dispose
 * @param {"social" | "desktop"} [surface] */
export async function runNativeSocial(
  backend,
  params,
  dispose,
  surface = "social",
) {
  if (
    params.budget !== null ||
    params.outputCap != null ||
    params.maxInferences != null
  )
    throw Error("SOCIAL_BACKEND_UNSUPPORTED");
  if (!params.binding?.runId || !Array.isArray(params.tools))
    throw Error("SOCIAL_RESPONSE_INVALID");
  const tools = params.tools.map((/** @type {any} */ tool) => ({
    name: tool.function?.name,
    description: tool.function?.description,
    inputSchema: tool.function?.parameters,
  }));
  const permitted = surface === "desktop" ? desktopAllowed : allowed;
  if (
    tools.some(
      (/** @type {any} */ tool) =>
        !permitted.has(tool.name) &&
        !(surface === "desktop" && desktopToolCandidate(tool.name)),
    )
  )
    throw Error("SOCIAL_TOOL_DENIED");
  const names = new Set(tools.map((/** @type {any} */ tool) => tool.name));
  const managed = surface === "desktop" ? params.managedContext : undefined;
  const pool = managed ? null : socialSessionPool(backend, dispose);
  const capsule =
    managed ??
    (await pool.acquire(
      params.binding,
      backend.sessionSignature?.(tools) || JSON.stringify(tools),
    ));
  const controller = managed ? new AbortController() : capsule.controller;
  const signal = AbortSignal.any([params.signal, controller.signal]);
  let submitted = false,
    consumed = false,
    completed = false,
    invalidated = false,
    unchanged = false;
  /** @type {any} */ let ticket;
  const check = async () => {
    signal.throwIfAborted();
    await params.beforeInput(params.binding);
    if (!submitted) params.assertCanStart?.();
    signal.throwIfAborted();
  };
  const consume = async () => {
    if (consumed || !submitted) return;
    await check();
    await params.onInputConsumed?.(ticket);
    if (managed) params.onInputSubmitted?.();
    consumed = true;
  };
  try {
    await check();
    await backend.run({
      social: true,
      desktop: surface === "desktop",
      conversation: capsule.conversation,
      instructions: capsule.session ? undefined : params.instructions,
      prompt: params.prompt,
      inputImages: surface === "desktop" ? params.inputImages : undefined,
      tools,
      session: capsule.session,
      signal,
      onUsage: managed?.onUsage,
      onBackendTurn: managed?.onBackendTurn,
      onTiming: managed?.onTiming,
      onDiagnostic: managed?.onDiagnostic,
      onInputSubmitted: managed ? params.onInputSubmitted : undefined,
      finalizeToolOutput: managed ? params.finalizeToolOutput : undefined,
      commitToolOutput: managed ? params.commitToolOutput : undefined,
      saveSession: (/** @type {any} */ value) => {
        if (value) capsule.session = value;
        else invalidated = true;
        managed?.saveSession(value);
      },
      beforeInputSubmitted: async () => {
        await check();
        ticket = params.captureInputConsumption?.();
        await params.onRunStarted();
        await check();
        submitted = true;
        params.registerInputConsumer?.(consume);
      },
      callTool: async (/** @type {string} */ name, /** @type {any} */ args) => {
        await check();
        if (!names.has(name)) throw Error("SOCIAL_TOOL_DENIED");
        // A current-turn tool request proves consumption of the initial prompt,
        // never of tool results that have not reached a later model request.
        await consume();
        const result = await params.callTool(name, args);
        assertSocialToolResult(
          name,
          result,
          params.maxToolResultBytes,
          surface === "desktop",
        );
        if (!params.shouldStop?.()) await check();
        return result;
      },
    });
    if (!params.shouldStop?.()) await consume();
    if ((managed || capsule.windowId) && (invalidated || !capsule.session))
      throw Error("SOCIAL_TURN_FAILED");
    signal.throwIfAborted();
    completed = true;
    return { status: "completed" };
  } catch (error) {
    unchanged = !submitted && sessionWasUnchanged(error);
    throw error;
  } finally {
    controller.abort();
    params.registerInputConsumer?.(null);
    if (pool) await pool.release(capsule, completed);
    else if (!completed && !unchanged && capsule.session)
      await dispose(capsule.session, capsule.conversation);
    tools.length = 0;
    ticket = null;
  }
}
