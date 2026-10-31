import { isPrivateLikeGroup } from "./config.mjs";
import { liveInput } from "./live-input.mjs";
// Private chats and private-like groups renew bounded peer replies after a quiet
// interval. It never supplies human request, disclosure or intent authority.
export function replyPeers(runtime, ctx) {
  const a = runtime.agent(ctx.agentId);
  return runtime.config.connections.filter(
    (c) =>
      c.id !== a.connectionId &&
      (ctx.conversation === "private:" + c.accountId ||
        isPrivateLikeGroup(runtime.config, ctx.conversation)) &&
      runtime.config.agents.some((peer) => peer.connectionId === c.id),
  );
}

// Older states predate the ordinary-attempt clock. Keep their conservative
// timestamp until delivery can persist it before an independent send changes it.
export function peerReplyLastAttemptAt(state) {
  return (
    state.replyBatchLastAttemptAt ??
    Math.max(state.lastAiReplyAt || 0, ...(state.sendTimes || []))
  );
}

export function observePeerInput(runtime, ctx, items) {
  const peers = replyPeers(runtime, ctx);
  if (
    !peers.length ||
    ctx.intentOnly ||
    ctx.activeIntentId ||
    ctx.scheduleRunId ||
    ctx.internalDelivery
  )
    return;
  const mem = runtime.memory.bind(ctx.agentId),
    state = mem.state(ctx.conversation),
    baseline = Math.max(state.peerReplyInputSeq || 0, ctx.inputBaseline || 0),
    now = runtime.now();
  const notBefore =
    Math.max(state.peerReplyWindowAt || 0, peerReplyLastAttemptAt(state)) +
    runtime.config.peerLimit.cooldownMs;
  let latest = baseline,
    renew = false;
  for (const item of items) {
    if (
      item.summaryOmitted ||
      item.bodyTruncated ||
      item.conversation !== ctx.conversation
    )
      continue;
    const row = liveInput(runtime, ctx.agentId, ctx.conversation, item.id);
    if (
      !row ||
      row.seq !== item.seq ||
      row.seq <= baseline ||
      (isPrivateLikeGroup(runtime.config, ctx.conversation) &&
        row.seq <= (state.replyInputSeq || 0)) ||
      !peers.some((peer) => row.sender_id === peer.accountId) ||
      item.body !== row.body
    )
      continue;
    latest = Math.max(latest, row.seq);
    const receivedAt = Date.parse(row.observed_at);
    if (receivedAt >= notBefore && receivedAt <= now && now >= notBefore)
      renew = true;
  }
  if (latest <= baseline) return;
  mem.setState(ctx.conversation, {
    ...state,
    // Consume even inputs received during cooldown: reading them again later
    // cannot manufacture a new conversation opportunity.
    peerReplyInputSeq: latest,
    ...(renew
      ? { peerReplyWindowAt: now, replyBatchSends: 0, replyBatchPeer: true }
      : {}),
  });
  if (renew) ctx.replyBatchSends = 0;
}
