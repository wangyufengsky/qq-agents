const validId = (s) =>
  typeof s === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(s);

export function validateConnections(map, subjectMap) {
  if (!map || typeof map !== "object" || Array.isArray(map))
    throw Error("INVALID_CONNECTION_MAP");
  const agents = new Set(),
    connections = new Set();
  for (const [accountId, binding] of Object.entries(map)) {
    if (
      !/^\d+$/.test(accountId) ||
      !binding ||
      !validId(binding.agentId) ||
      !validId(binding.connectionId) ||
      Object.keys(binding).some((k) => !["agentId", "connectionId"].includes(k))
    )
      throw Error("INVALID_CONNECTION_MAP");
    if (agents.has(binding.agentId) || connections.has(binding.connectionId))
      throw Error("AMBIGUOUS_CONNECTION_MAP");
    if (
      subjectMap[accountId] &&
      subjectMap[accountId].agentId !== binding.agentId
    )
      throw Error("CONTRADICTORY_CONNECTION_MAP");
    agents.add(binding.agentId);
    connections.add(binding.connectionId);
  }
}

export function mappedConnection(binding, accountId, agentId) {
  const selected = binding.connectionMap?.[accountId];
  if (!accountId || !selected)
    throw Error("EXPLICIT_ACCOUNT_CONNECTION_REQUIRED");
  if (selected.agentId !== agentId) throw Error("CONTRADICTORY_CONNECTION_MAP");
  return selected.connectionId;
}

// Runs inside the same import transaction. No UUID, ledger seq, payload source
// observation or runtime progress is rewritten to repair the destination link.
export function bindLegacyConnections(memory, plan) {
  const binding = plan.connectionBinding;
  if (!binding) return 0;
  const { accountId, connectionId } = binding;
  for (const row of memory.db
    .prepare(
      "SELECT agent_id,value FROM runtime WHERE conversation='@migration-binding'",
    )
    .all()) {
    const old = JSON.parse(row.value);
    if (
      (row.agent_id === memory.agentId &&
        (old.accountId !== accountId || old.connectionId !== connectionId)) ||
      (row.agent_id !== memory.agentId &&
        (old.accountId === accountId || old.connectionId === connectionId))
    )
      throw Error("EXISTING_CONNECTION_BINDING_CONFLICT");
  }
  const rows = memory.db
    .prepare(
      "SELECT * FROM events WHERE agent_id=? AND kind='legacy.message-observation' AND connection_id=''",
    )
    .all(memory.agentId);
  for (const row of rows) {
    if (
      row.message_id &&
      memory.db
        .prepare(
          "SELECT 1 FROM events WHERE agent_id=? AND connection_id IN ('',?) AND conversation=? AND message_id=? AND kind='legacy.message-observation' AND id!=?",
        )
        .get(
          memory.agentId,
          connectionId,
          row.conversation,
          row.message_id,
          row.id,
        )
    )
      throw Error("EXISTING_DUPLICATE_MESSAGE_ID_REQUIRES_RECONCILIATION");
    const p = JSON.parse(row.payload),
      accounts = new Set(
        [
          p.robotQQ,
          ...(p.migration?.sources || []).map(
            (s) => s.observation?.accountId || s.observation?.robotQQ,
          ),
        ]
          .filter(Boolean)
          .map(String),
      );
    if (accounts.size > 1 || (accounts.size && !accounts.has(accountId)))
      throw Error("AMBIGUOUS_LEGACY_CONNECTION");
    if (!accounts.size) {
      const replay = plan.events.filter(
        (e) =>
          e.kind === row.kind &&
          e.conversation === row.conversation &&
          (e.legacyDedupe === row.dedupe ||
            (row.message_id && e.messageId === row.message_id)),
      );
      if (
        !replay.length ||
        replay.some(
          (e) =>
            e.accountId !== accountId ||
            (row.sender_id && e.senderId && row.sender_id !== e.senderId) ||
            (row.direction !== "unknown" &&
              e.direction !== "unknown" &&
              row.direction !== e.direction),
        )
      )
        throw Error("LEGACY_CONNECTION_REQUIRES_SOURCE_EVIDENCE");
    }
    memory.db
      .prepare("UPDATE events SET connection_id=? WHERE seq=?")
      .run(connectionId, row.seq);
    memory.setState(row.conversation, {
      ...memory.state(row.conversation),
      paused: true,
    });
  }
  memory.setState("@migration-binding", binding);
  return rows.length;
}
