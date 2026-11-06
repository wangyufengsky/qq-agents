// @ts-check
import { SocialSessionPool } from "./social-sessions.mjs";
import { canonical } from "./session-contract.mjs";
import { boundedInference, socialProviderProfile } from "./social-budget.mjs";
import { safeToolFailure } from "../tools/errors.mjs";
import { mediaLease } from "../tools/media-lease.mjs";
import { assertSocialToolResult } from "./native-social.mjs";

/** Bridge-owned window history remains separate from ordinary backend sessions.
 * @param {any} params */
export async function runOpenAISocial(params) {
  const {
    binding,
    endpoint,
    model,
    profileId,
    budget,
    signal: callerSignal,
    beforeInput,
    callTool,
  } = params;
  const profile = budget
    ? socialProviderProfile(profileId, endpoint, model)
    : null;
  for (const n of [
    ...(budget ? [params.outputCap, params.maxInferences] : []),
    params.maxCallsPerInference,
    params.maxToolResultBytes,
  ])
    if (!Number.isSafeInteger(n) || n <= 0)
      throw Error("SOCIAL_BUDGET_INVALID");
  if (profile && params.outputCap > profile.maxOutput)
    throw Error("SOCIAL_BUDGET_INVALID");
  const tools = structuredClone(params.tools || []);
  const pool = params.sessionPool || new SocialSessionPool(async () => {});
  const capsule = await pool.acquire(
    binding,
    JSON.stringify(
      canonical({ endpoint, model, vision: params.vision === true, tools }),
    ),
  );
  const signal = AbortSignal.any([callerSignal, capsule.controller.signal]);
  /** @type {Array<{role: string, content?: any, tool_calls?: any[], tool_call_id?: string}>} */
  const messages = capsule.messages;
  if (!messages.length)
    messages.push({ role: "system", content: params.instructions });
  messages.push({ role: "user", content: params.prompt });
  let completed = false;
  const names = new Set(tools.map((/** @type {any} */ t) => t.function?.name));
  let inferences = 0;
  const check = async () => {
    if (signal.aborted) throw Error("ABORTED");
    await beforeInput(binding);
    if (signal.aborted) throw Error("ABORTED");
  };
  try {
    for (; !budget || inferences < params.maxInferences; inferences++) {
      await check();
      const current = params.limitsForInference?.() || {
        outputCap: params.outputCap,
        maxInferences: params.maxInferences,
      };
      if (budget && inferences >= current.maxInferences)
        throw Error("SOCIAL_INFERENCE_LIMIT");
      const outputCap = budget
        ? Math.min(params.outputCap, current.outputCap)
        : null;
      let consumption;
      const prepare = async () => {
        // Recheck immediately before every model request, including tool continuations.
        await check();
        consumption = params.captureInputConsumption?.();
        const options = {
          method: "POST",
          redirect: "error",
          signal,
          headers: params.headers(),
        };
        // A run is charged once before execution, independently of token settlement.
        await params.onRunStarted?.();
        return async () => {
          await check();
          // A later tool or callback may revoke an observation before its first input.
          for (const message of messages) {
            const lease = Reflect.get(message, mediaLease);
            if (typeof lease === "function" && !lease())
              message.content =
                "场景观察授权或版本已失效，文字与图片未交付；需要时重新读取。";
            if (Array.isArray(message.content))
              message.content = message.content.map((part) =>
                typeof part[mediaLease] === "function" && !part[mediaLease]()
                  ? {
                      type: "text",
                      text: "场景图片授权或版本已失效，未交付该图片；需要时重新读取。",
                    }
                  : part,
              );
          }
          const response = await (params.fetch || globalThis.fetch)(endpoint, {
            ...options,
            body: JSON.stringify({
              model,
              messages,
              store: false,
              n: 1,
              ...(profile ? { [profile.outputParameter]: outputCap } : {}),
              ...(tools.length
                ? { tools, tool_choice: "auto", parallel_tool_calls: false }
                : {}),
            }),
          });
          if (!response.ok) throw Error("SOCIAL_PROVIDER_FAILED");
          return response.json();
        };
      };
      const result = profile
        ? await boundedInference(
            budget,
            binding,
            inferences,
            profile.inputUpperBound,
            /** @type {number} */ (outputCap),
            prepare,
          )
        : await (
            await prepare()
          )();
      await check();
      const choice = result?.choices?.[0];
      if (["length", "content_filter"].includes(choice?.finish_reason))
        throw Error("SOCIAL_RESPONSE_INVALID");
      const message = choice?.message;
      if (!message || typeof message !== "object")
        throw Error("SOCIAL_RESPONSE_INVALID");
      const calls = message.tool_calls || [];
      if (!Array.isArray(calls) || calls.length > params.maxCallsPerInference)
        throw Error("SOCIAL_TOOL_LIMIT");
      if (
        calls.some(
          (call) =>
            call?.type !== "function" || !names.has(call.function?.name),
        )
      )
        throw Error("SOCIAL_TOOL_DENIED");
      if (
        calls.some((call) => typeof call.id !== "string" || !call.id) ||
        new Set(calls.map((call) => call.id)).size !== calls.length
      )
        throw Error("SOCIAL_RESPONSE_INVALID");
      // Only this request's already prepared input can be acknowledged. Tool
      // reads executed below belong to a later model request, never this one.
      await params.onInputConsumed?.(consumption);
      // Do not resend or retain pixel data after a successful model input.
      for (const prior of messages) {
        Reflect.deleteProperty(prior, mediaLease);
        if (Array.isArray(prior.content))
          prior.content = prior.content.map((part) =>
            part.type === "image_url"
              ? {
                  type: "text",
                  text: "本会话已看过场景图片；需要再看时重新调用 room_scene_view。",
                }
              : part,
          );
      }
      if (!calls.length) {
        messages.push({ role: "assistant", content: message.content ?? null });
        if (signal.aborted) throw Error("ABORTED");
        completed = true;
        return { status: "completed", inferences: inferences + 1 };
      }
      messages.push({
        role: "assistant",
        content: message.content ?? null,
        tool_calls: calls,
      });
      let sealed = false;
      const pendingImages = [];
      for (const call of calls) {
        if (sealed) {
          // A sealed batch still owes answers for every provider tool call.
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify({
              isError: true,
              code: "SOCIAL_TURN_CLOSED",
            }),
          });
          continue;
        }
        await check();
        if (call.type !== "function" || !names.has(call.function?.name))
          throw Error("SOCIAL_TOOL_DENIED");
        let args;
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          // JSON errors may quote private provider output; only emit our safe code.
          throw Error("SOCIAL_RESPONSE_INVALID");
        }
        let answer;
        try {
          answer = await callTool(call.function.name, args);
        } catch (error) {
          signal.throwIfAborted();
          answer = { isError: true, ...safeToolFailure(error) };
        }
        sealed = !!params.shouldStop?.();
        if (!sealed) await check();
        assertSocialToolResult(
          call.function.name,
          answer,
          params.maxToolResultBytes,
        );
        // Hard-budget profiles have no verified image-input bound; keep their budget intact.
        if (
          call.function.name === "room_scene_view" &&
          (budget || !params.formatToolResult) &&
          answer?.content?.some(
            (/** @type {any} */ part) => part.type === "image",
          )
        )
          answer = {
            imageAvailable: false,
            reason: "SOCIAL_BACKEND_UNSUPPORTED",
            notice: budget
              ? "当前显式硬预算尚无可信图片输入用量上限，仅返回文字；预算保持不变。"
              : "当前社交适配器未提供图片输入，仅返回文字；没有看见图片。",
          };
        if (
          call.function.name === "room_scene_view" &&
          params.formatToolResult
        ) {
          const formatted = await params.formatToolResult(call, answer, signal);
          messages.push(formatted.tool);
          pendingImages.push(...formatted.images);
        } else {
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify(answer),
          });
        }
      }
      if (!sealed && pendingImages.length)
        messages.push({ role: "user", content: pendingImages });
      if (sealed) {
        if (signal.aborted) throw Error("ABORTED");
        completed = true;
        return { status: "completed", inferences: inferences + 1 };
      }
    }
    throw Error("SOCIAL_INFERENCE_LIMIT");
  } finally {
    await pool.release(capsule, completed && !signal.aborted);
    tools.length = 0;
  }
}
