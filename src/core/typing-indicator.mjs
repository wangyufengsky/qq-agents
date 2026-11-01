// @ts-check
import timers from "node:timers";

// This signal is cosmetic: it must never extend typing or acquire delivery authority.
/** @param {any} runtime @param {any} ctx @returns {() => void} */
export function startTypingIndicator(runtime, ctx) {
  let agent;
  try {
    agent = runtime.assertActive(ctx);
  } catch {
    return () => {};
  }
  const transport = runtime.transports.get(agent.connectionId);
  if (
    ctx.internalDelivery ||
    !/^private:\d+$/.test(ctx.conversation) ||
    agent.behavior.typing?.enabled === false ||
    agent.behavior.typing?.indicator === false ||
    !transport?.connected ||
    typeof transport.setTyping !== "function"
  )
    return () => {};
  const controller = new AbortController();
  const signal = AbortSignal.any([ctx.controller.signal, controller.signal]);
  let cancelled = false;
  /** @type {(reason?: any) => void} */
  let stop = () => {};
  const deadline = new Promise((_, reject) => {
    stop = reject;
  });
  const timeout = timers.setTimeout(() => {
    controller.abort();
    stop(Error("TYPING_INDICATOR_UNAVAILABLE"));
  }, 1000);
  timeout.unref?.();
  const cleanup = () => {
    if (cancelled) return;
    cancelled = true;
    timers.clearTimeout(timeout);
    ctx.controller.signal.removeEventListener("abort", cleanup);
    controller.abort();
    stop(controller.signal.reason);
  };
  ctx.controller.signal.addEventListener("abort", cleanup, { once: true });
  const request = Promise.resolve().then(() => {
    // A pause may arrive between scheduling this cosmetic request and starting it.
    try {
      runtime.assertActive(ctx);
    } catch {
      return;
    }
    if (!signal.aborted)
      return transport.setTyping(ctx.conversation, { signal });
  });
  void Promise.race([request, deadline])
    .catch(() => {
      if (!cancelled && !ctx.controller.signal.aborted)
        runtime.diagnostics.report(Error("TYPING_INDICATOR_UNAVAILABLE"), {
          component: "transport",
          agentId: ctx.agentId,
          conversation: ctx.conversation,
        });
    })
    .finally(() => {
      timers.clearTimeout(timeout);
      ctx.controller.signal.removeEventListener("abort", cleanup);
    });
  return cleanup;
}
