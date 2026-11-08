// @ts-check
import timers from "node:timers";

/** @param {any} runtime @param {any} ctx */
function typingTransport(runtime, ctx) {
  if (ctx.internalDelivery || !/^private:\d+$/.test(ctx.conversation)) return;
  try {
    const agent = runtime.assertActive(ctx);
    const transport = runtime.transports.get(agent.connectionId);
    if (
      agent.behavior.typing?.indicator !== false &&
      transport?.connected &&
      typeof transport.setTyping === "function"
    )
      return transport;
  } catch {
    // Loss of turn authority also cancels this cosmetic request.
  }
}

// Arm one best-effort indication for the backend's processing lifetime.
// Local cancellation stops our work; the gateway owns how QQ clears the display.
/** @param {any} runtime @param {any} ctx @returns {() => void} */
export function startTypingIndicator(runtime, ctx) {
  if (!typingTransport(runtime, ctx)) return () => {};

  const controller = new AbortController();
  const signal = controller.signal;
  let cancel = () => {};
  let expire = () => {};
  const settled = new Promise((resolve, reject) => {
    cancel = () => resolve(undefined);
    expire = () => reject(Error("TYPING_INDICATOR_UNAVAILABLE"));
  });
  /** @type {NodeJS.Timeout | undefined} */
  let timeout;
  const stop = () => {
    if (signal.aborted) return;
    timers.clearTimeout(delay);
    timers.clearTimeout(timeout);
    ctx.controller.signal.removeEventListener("abort", stop);
    controller.abort();
    cancel();
  };
  const delay = timers.setTimeout(() => {
    const transport = typingTransport(runtime, ctx);
    if (!transport) return stop();

    timeout = timers.setTimeout(expire, 1000);
    timeout.unref?.();
    const request = (async () =>
      transport.setTyping(ctx.conversation, { signal }))();
    void Promise.race([request, settled])
      .catch(() => {
        if (!signal.aborted)
          runtime.diagnostics.report(Error("TYPING_INDICATOR_UNAVAILABLE"), {
            component: "transport",
            agentId: ctx.agentId,
            conversation: ctx.conversation,
          });
      })
      .finally(stop);
  }, 500);
  delay.unref?.();
  ctx.controller.signal.addEventListener("abort", stop, { once: true });
  return stop;
}
