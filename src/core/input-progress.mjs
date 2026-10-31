// @ts-check
import { observePeerInput } from "./peer-replies.mjs";
import { liveInput } from "./live-input.mjs";
// Only transport-authenticated human events can advance human request authority.
/** @param {any} runtime @param {any} ctx @param {string} id */
export function humanInput(runtime, ctx, id) {
  const row = liveInput(runtime, ctx.agentId, ctx.conversation, id);
  if (
    !row ||
    !/^\d+$/.test(row.sender_id || "") ||
    runtime.config.connections.some(
      (/** @type {any} */ c) => c.accountId === row.sender_id,
    )
  )
    return null;
  return row;
}
/** @param {any} runtime @param {any} ctx @param {any[]} items */
export function observeInput(runtime, ctx, items) {
  const mem = runtime.memory.bind(ctx.agentId);
  const state = mem.state(ctx.conversation);
  const baseline = Math.max(
    ctx.replyInputSeq || 0,
    state.replyInputSeq || 0,
    ctx.inputBaseline || 0,
  );
  let latest = baseline;
  for (const item of items) {
    if (
      item.summaryOmitted ||
      item.bodyTruncated ||
      item.conversation !== ctx.conversation
    )
      continue;
    const row = humanInput(runtime, ctx, item.id);
    if (!row || row.seq !== item.seq || row.seq <= baseline) continue;
    // A complete visible body is required; metadata/watermarks alone confer no authority.
    if (item.body !== row.body) continue;
    latest = Math.max(latest, row.seq);
    (ctx.requestEvents ??= new Set()).add(row.id);
  }
  if (latest > baseline) {
    ctx.replyInputSeq = latest;
    // A fresh, fully observed human exchange can turn an intent-only wake into
    // an ordinary reply. Cancelling an intent or rereading old input cannot.
    // Keep selected intents bound to their delivery/receipt until turn end.
    if (
      ctx.intentOnly &&
      !ctx.activeIntentId &&
      Number.isSafeInteger(ctx.intentSnapshotSeq) &&
      latest > ctx.intentSnapshotSeq
    )
      ctx.intentOnly = false;
    // A scheduled wake does not turn later human exchanges into scheduled sends.
    ctx.scheduleRunId = null;
    ctx.replyBatchSends = 0;
    mem.setState(ctx.conversation, {
      ...mem.state(ctx.conversation),
      replyInputSeq: latest,
      replyBatchSends: 0,
      replyBatchPeer: false,
    });
  }
  observePeerInput(runtime, ctx, items);
}
