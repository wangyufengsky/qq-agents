// @ts-check
import { setTimeout as delay } from "node:timers/promises";

// Each poll is a bounded request. The drain deadline comes from admitted turn
// deadlines, rather than extending every upgrade RPC or cancelling on timeout.
/** @param {() => Promise<any>} request @param {AbortSignal} [signal] */
export async function waitForDrain(request, signal) {
  for (;;) {
    signal?.throwIfAborted();
    const state = await request();
    signal?.throwIfAborted();
    if (
      state?.active !== true ||
      !Number.isSafeInteger(state.pending) ||
      state.pending < 0 ||
      !Number.isFinite(state.deadline)
    )
      throw Error("UPDATE_RESPONSE_INVALID");
    if (!state.pending) return;
    if (Date.now() >= state.deadline) throw Error("UPDATE_DRAIN_TIMEOUT");
    await delay(250, undefined, { signal });
  }
}
