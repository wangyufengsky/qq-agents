// Retain source handles automatically, independently of optional model-written notes.
// A bounded excerpt is orientation, never an acknowledgement or a new evidence root.
function retainedSources(memory, conversation, state) {
  if (state.continuity) return state.continuity;
  const legacy = memory.db
    .prepare(
      "SELECT id FROM events WHERE agent_id=? AND conversation=? AND seq<=? ORDER BY seq DESC LIMIT 12",
    )
    .all(memory.agentId, conversation, state.readThroughSeq || 0)
    .reverse();
  return { anchors: [], recent: legacy.map((row) => row.id) };
}

export function rememberSources(memory, conversation, items) {
  const state = memory.state(conversation),
    old = retainedSources(memory, conversation, state),
    rows = items.filter(
      (item) => item.id && item.conversation === conversation,
    ),
    anchors = [...old.anchors];
  for (const row of rows)
    if (
      anchors.length < 4 &&
      row.direction === "in" &&
      !anchors.includes(row.id)
    )
      anchors.push(row.id);
  const incoming = rows.map((row) => row.id);
  const recent = [
    ...new Set([
      ...old.recent.filter((id) => !incoming.includes(id)),
      ...incoming,
    ]),
  ].slice(-12);
  memory.setState(conversation, { ...state, continuity: { anchors, recent } });
}

export function sourceHandoff(memory, conversation) {
  const state = memory.state(conversation);
  // Initialize before new observations can suppress the legacy fallback.
  const retained = retainedSources(memory, conversation, state);
  const ids = [...new Set([...retained.anchors, ...retained.recent])];
  const perSource = Math.min(1200, Math.floor(12000 / Math.max(1, ids.length)));
  const sources = ids.map((id) => {
    const row = memory.db
      .prepare(
        "SELECT * FROM events WHERE agent_id=? AND conversation=? AND id=?",
      )
      .get(memory.agentId, conversation, id);
    if (!row)
      return {
        id,
        available: false,
        notice: "原始来源已不可用，不能重建或猜测内容。",
      };
    const payload = JSON.parse(row.payload || "{}"),
      app = payload.app;
    const text = String(app?.text ?? row.body ?? "");
    const excerpt = text.slice(0, perSource);
    return {
      id,
      available: true,
      kind: row.kind,
      direction: row.direction,
      occurredAt: row.occurred_at,
      senderId: row.sender_id,
      status: row.status,
      epistemic:
        app || row.kind === "external.read"
          ? "external-source-claim"
          : row.direction === "in"
            ? "observed-speech"
            : "recorded-action",
      excerpt,
      excerptTruncated: excerpt.length < text.length,
      ...(app
        ? {
            platform: app.platform,
            key: app.key,
            url: app.url,
            readingScope: app.readingScope,
            coverage: app.coverage,
            sourceMayBeTruncated: app.sourceMayBeTruncated,
            parents: app.evidence || [],
          }
        : {}),
      continuation: app
        ? { tool: "app_record", recordId: id, offset: 0 }
        : { tool: "memory_read", id, offset: 0 },
    };
  });
  return {
    sources,
    bounded: true,
    maxExcerptChars: 12000,
    notice:
      "自动保留最早 4 条来信和最近 12 条已提供的来源，最多 12000 字；这是原始记录摘录，不是完整任务摘要，不代表已处理或发言为真。更早或截断内容按引用回查。",
    continuation: { tool: "conversation_read", conversation, afterSeq: 0 },
  };
}
