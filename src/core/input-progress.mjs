// Only transport-authenticated human events can advance reply/request authority.
export function humanInput(runtime, ctx, id) {
  const a = runtime.agent(ctx.agentId);
  const row = runtime.memory
    .bind(a.id)
    .db.prepare(
      "SELECT * FROM events WHERE agent_id=? AND id=? AND conversation=? AND connection_id=?",
    )
    .get(a.id, id, ctx.conversation, a.connectionId);
  if (
    !row ||
    row.kind !== "message.received" ||
    row.direction !== "in" ||
    row.origin !== "live" ||
    row.status === "recalled" ||
    !/^\d+$/.test(row.sender_id || "") ||
    runtime.config.connections.some((c) => c.accountId === row.sender_id) ||
    JSON.parse(row.payload).trustedInput !== true
  )
    return null;
  return row;
}
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
    // A scheduled wake does not turn later human exchanges into scheduled sends.
    ctx.scheduleRunId = null;
    ctx.replyBatchSends = 0;
    mem.setState(ctx.conversation, {
      ...mem.state(ctx.conversation),
      replyInputSeq: latest,
      replyBatchSends: 0,
    });
  }
}
