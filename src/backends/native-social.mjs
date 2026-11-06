// @ts-check
import { SOCIAL_TOOLS } from "../home/social-tool-names.mjs";

const allowed = new Set([
  ...SOCIAL_TOOLS.filter((name) => name !== "home_social_process"),
  "self_read",
  "work_notes",
  "person_notes",
  "person_items",
  "mood_read",
]);

/** Native runs use fresh sessions and never retry a submitted prompt.
 * @param {any} backend @param {any} params
 * @param {(session: any) => Promise<void>} dispose */
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
  const controller = new AbortController();
  const signal = AbortSignal.any([params.signal, controller.signal]);
  let session = null,
    submitted = false,
    consumed = false;
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
      conversation: `@social:${params.binding.runId}`,
      instructions: params.instructions,
      prompt: params.prompt,
      tools,
      session: null,
      signal,
      saveSession: (/** @type {any} */ value) => {
        if (value) session = value;
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
        if (params.shouldStop?.()) controller.abort();
        else await check();
        return result;
      },
    });
    if (!params.shouldStop?.()) await consume();
    return { status: "completed" };
  } catch (error) {
    if (
      !params.signal.aborted &&
      params.shouldStop?.() &&
      controller.signal.aborted
    )
      return { status: "completed" };
    throw error;
  } finally {
    controller.abort();
    params.registerInputConsumer?.(null);
    await dispose(session);
    tools.length = 0;
    ticket = null;
  }
}
