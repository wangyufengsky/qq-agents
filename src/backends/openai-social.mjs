// @ts-check
import { boundedInference, socialProviderProfile } from "./social-budget.mjs";

/** Stateless, bridge-owned loop: no ordinary backend session or file history.
 * @param {any} params */
export async function runOpenAISocial(params) {
  const {
    binding,
    endpoint,
    model,
    profileId,
    budget,
    signal,
    beforeInput,
    callTool,
  } = params;
  const profile = socialProviderProfile(profileId, endpoint, model);
  for (const n of [
    params.outputCap,
    params.maxInferences,
    params.maxCallsPerInference,
    params.maxToolResultBytes,
  ])
    if (!Number.isSafeInteger(n) || n <= 0)
      throw Error("SOCIAL_BUDGET_INVALID");
  if (params.outputCap > profile.maxOutput)
    throw Error("SOCIAL_BUDGET_INVALID");
  /** @type {Array<{role: string, content?: any, tool_calls?: any[], tool_call_id?: string}>} */
  const messages = [
    { role: "system", content: params.instructions },
    { role: "user", content: params.prompt },
  ];
  const tools = structuredClone(params.tools || []);
  const names = new Set(tools.map((/** @type {any} */ t) => t.function?.name));
  let inferences = 0;
  const check = async () => {
    if (signal.aborted) throw Error("ABORTED");
    await beforeInput(binding);
    if (signal.aborted) throw Error("ABORTED");
  };
  try {
    for (; inferences < params.maxInferences; inferences++) {
      await check();
      const result = await boundedInference(
        budget,
        binding,
        inferences,
        profile.inputUpperBound,
        params.outputCap,
        async () => {
          // Recheck after reservation: waiting for the store can cross a fence.
          await check();
          const options = {
            method: "POST",
            redirect: "error",
            signal,
            headers: params.headers(),
            body: JSON.stringify({
              model,
              messages,
              store: false,
              n: 1,
              [profile.outputParameter]: params.outputCap,
              ...(tools.length
                ? { tools, tool_choice: "auto", parallel_tool_calls: false }
                : {}),
            }),
          };
          return async () => {
            const response = await (params.fetch || globalThis.fetch)(
              endpoint,
              options,
            );
            if (!response.ok) throw Error("SOCIAL_PROVIDER_FAILED");
            return response.json();
          };
        },
      );
      await check();
      const message = result?.choices?.[0]?.message;
      if (!message || typeof message !== "object")
        throw Error("SOCIAL_RESPONSE_INVALID");
      const calls = message.tool_calls || [];
      if (!Array.isArray(calls) || calls.length > params.maxCallsPerInference)
        throw Error("SOCIAL_TOOL_LIMIT");
      if (!calls.length)
        return { status: "completed", inferences: inferences + 1 };
      messages.push({
        role: "assistant",
        content: message.content ?? null,
        tool_calls: calls,
      });
      for (const call of calls) {
        await check();
        if (call.type !== "function" || !names.has(call.function?.name))
          throw Error("SOCIAL_TOOL_DENIED");
        const args = JSON.parse(call.function.arguments || "{}");
        const answer = await callTool(call.function.name, args);
        const text = JSON.stringify(answer);
        if (Buffer.byteLength(text) > params.maxToolResultBytes)
          throw Error("SOCIAL_TOOL_RESULT_LIMIT");
        messages.push({ role: "tool", tool_call_id: call.id, content: text });
      }
    }
    throw Error("SOCIAL_INFERENCE_LIMIT");
  } finally {
    // Only the logical ledger survives; the next run reconstructs current input.
    messages.length = 0;
    tools.length = 0;
  }
}
