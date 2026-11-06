// @ts-check
import { socialSessionPool } from "./social-sessions.mjs";
import { SOCIAL_TOOLS } from "../home/social-tool-names.mjs";

const allowed = new Set([
  ...SOCIAL_TOOLS.filter((name) => name !== "home_social_process"),
  "self_read",
  "work_notes",
  "person_notes",
  "person_items",
  "mood_read",
]);

/** Each window owns a separate session per actor; submitted prompts never retry.
 * @param {any} backend @param {any} params
 * @param {(session: any, conversation: string) => Promise<void>} dispose */
export async function runNativeSocial(backend, params, dispose) {
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
  if (tools.some((/** @type {any} */ tool) => !allowed.has(tool.name)))
    throw Error("SOCIAL_TOOL_DENIED");
  const names = new Set(tools.map((/** @type {any} */ tool) => tool.name));
  const pool = socialSessionPool(backend, dispose);
  const capsule = await pool.acquire(
    params.binding,
    backend.sessionSignature?.(tools) || JSON.stringify(tools),
  );
  const controller = capsule.controller;
  const signal = AbortSignal.any([params.signal, controller.signal]);
  let submitted = false,
    consumed = false,
    completed = false,
    invalidated = false;
  /** @type {any} */ let ticket;
  const check = async () => {
    signal.throwIfAborted();
    await params.beforeInput(params.binding);
    signal.throwIfAborted();
  };
  const consume = async () => {
    if (consumed || !submitted) return;
    await check();
    await params.onInputConsumed?.(ticket);
    consumed = true;
  };
  try {
    await check();
    await backend.run({
      social: true,
      conversation: capsule.conversation,
      instructions: capsule.session ? undefined : params.instructions,
      prompt: params.prompt,
      tools,
      session: capsule.session,
      signal,
      saveSession: (/** @type {any} */ value) => {
        if (value) capsule.session = value;
        else invalidated = true;
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
        const text = JSON.stringify(result);
        if (Buffer.byteLength(text || "") > params.maxToolResultBytes)
          throw Error("SOCIAL_TOOL_RESULT_LIMIT");
        if (!params.shouldStop?.()) await check();
        return result;
      },
    });
    if (!params.shouldStop?.()) await consume();
    if (capsule.windowId && (invalidated || !capsule.session))
      throw Error("SOCIAL_TURN_FAILED");
    signal.throwIfAborted();
    completed = true;
    return { status: "completed" };
  } finally {
    controller.abort();
    params.registerInputConsumer?.(null);
    await pool.release(capsule, completed);
    tools.length = 0;
    ticket = null;
  }
}
