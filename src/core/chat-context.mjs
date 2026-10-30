// A model-facing projection. The full handoff and delivery ledger remain intact.
export function deliveryPage(
  memory,
  conversation,
  { offset = 0, limit = 20, unresolvedOnly = true } = {},
) {
  if (!/^(group|private):/.test(conversation))
    throw Error("CHAT_CONTEXT_REQUIRED");
  const where =
    "agent_id=? AND conversation=?" +
    (unresolvedOnly ? " AND status IN ('pending','unknown')" : "");
  const total = memory.db
    .prepare(`SELECT count(*) AS n FROM deliveries WHERE ${where}`)
    .get(memory.agentId, conversation).n;
  const items = memory.db
    .prepare(
      `SELECT request_id AS requestId,status,message_id AS messageId,created_at AS createdAt FROM deliveries WHERE ${where} ORDER BY created_at,request_id LIMIT ? OFFSET ?`,
    )
    .all(memory.agentId, conversation, limit, offset);
  const nextOffset =
    offset + items.length < total ? offset + items.length : null;
  return {
    items,
    total,
    offset,
    nextOffset,
    ...(nextOffset !== null
      ? {
          continuation: {
            tool: "qq_delivery_status",
            offset: nextOffset,
            limit,
            unresolvedOnly,
          },
        }
      : {}),
    notice:
      "只读投递账本，不会发送或更改状态；pending/unknown 不得换编号重发，需核对回传或由管理员在管理台确认。",
  };
}

export function chatHistory(history) {
  return {
    ...history,
    source: undefined,
    items: history.items.map((row) => {
      const keys = [
        "id",
        "seq",
        "type",
        "senderId",
        "senderName",
        "messageId",
        "occurredAt",
        "direction",
        "status",
        "epistemic",
        "body",
        "bodyTruncated",
        "summaryOmitted",
        "mentions",
        "replyToMessageIds",
        "voiceTranscript",
        "qqFaces",
        "corrections",
        "sourceEventId",
        "outcome",
        "notice",
      ];
      const item = Object.fromEntries(
        keys
          .filter(
            (key) =>
              row[key] !== undefined &&
              row[key] !== null &&
              (!Array.isArray(row[key]) || row[key].length),
          )
          .map((key) => [key, row[key]]),
      );
      if (row.bodyTruncated || row.summaryOmitted)
        item.continuation = { tool: "memory_read", id: row.id, offset: 0 };
      return item;
    }),
  };
}

export function chatHandoff(handoff, { replay = false } = {}) {
  if (!handoff) return null;
  const result = {};
  const sources = replay
    ? handoff.continuity.sources
        .filter(
          (s) =>
            ![
              "message.received",
              "message.sent",
              "message.send-attempt",
              "legacy.message-observation",
            ].includes(s.kind),
        )
        .map((s) => ({
          id: s.id,
          available: s.available,
          corrections: s.corrections,
          kind: s.kind,
          epistemic: s.epistemic,
          platform: s.platform,
          key: s.key,
          readingScope: s.readingScope,
          coverage: s.coverage,
          excerpt: s.excerpt?.slice(0, 200),
          excerptTruncated:
            !!s.excerptTruncated || (s.excerpt?.length || 0) > 200,
          sourceMayBeTruncated: s.sourceMayBeTruncated,
          continuation: s.continuation,
        }))
    : handoff.continuity.sources;
  if (sources.length)
    result.continuity = replay
      ? {
          sources,
          notice:
            "其他来源仅列线索，摘录最多200字，不是聊天原文；完整内容按 continuation 回查。",
        }
      : handoff.continuity;
  for (const key of ["notes", "intents", "scheduled"])
    if (handoff[key]?.length) result[key] = handoff[key];
  if (handoff.notesOverflow)
    Object.assign(result, {
      notesOverflow: handoff.notesOverflow,
      notice: handoff.notice,
    });
  if (handoff.intentsOverflow)
    Object.assign(result, {
      intentsOverflow: handoff.intentsOverflow,
      intentsContinuation: handoff.intentsContinuation,
    });
  return result;
}

export function chatStatus(runtime, ctx, history, handoff) {
  const memory = runtime.memory.bind(ctx.agentId),
    state = memory.state(ctx.conversation);
  const lines = [
    `处理水位：已处理至 seq=${state.readThroughSeq || 0}；本轮已展示的连续水位=${ctx.shownSeq || 0}。展示不等于处理，结束前只提交实际处理过的部分。`,
  ];
  const incomplete = history.items.filter(
    (x) => x.bodyTruncated || x.summaryOmitted,
  );
  if (incomplete.length)
    lines.push(
      `未完整读取（先按入口续读，不能当作已读全文）：${JSON.stringify(incomplete.map(({ id, seq }) => ({ id, seq, continuation: { tool: "memory_read", id, offset: 0 } })))}`,
    );
  if (history.truncated)
    lines.push(
      `还有未展示的消息：${JSON.stringify({ tool: "conversation_read", afterSeq: history.nextAfterSeq })}`,
    );
  if (handoff) {
    const receipts = deliveryPage(memory, ctx.conversation);
    if (receipts.total) lines.push(`待核对投递：${JSON.stringify(receipts)}`);
    else {
      const last = memory.db
        .prepare(
          "SELECT status,message_id AS messageId FROM deliveries WHERE agent_id=? AND conversation=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
        )
        .get(ctx.agentId, ctx.conversation);
      if (last)
        lines.push(
          `最近一次投递：${JSON.stringify(last)}。完整账本可用 qq_delivery_status 按需查询。`,
        );
    }
  }
  return lines;
}

export function wakeBackground(reasons) {
  const scheduled = reasons.filter(
    (r) => r.reason === "scheduled" && r.taskRunId,
  );
  const background = reasons.filter((r) => !scheduled.includes(r));
  return [
    scheduled.length
      ? `本轮定时任务（管理员已登记的任务说明，结合当前聊天执行）：${JSON.stringify(scheduled)}`
      : "",
    background.length
      ? `唤醒背景（只说明为何开始这一轮；主动意图不是待发送台词，是否采用由你结合现场决定）：${JSON.stringify(background)}`
      : "",
  ].filter(Boolean);
}
