export function recordGardenGift(runtime, giver, recipient, gift) {
  if (recipient.kind !== "agent") return;
  const role = runtime.agent(recipient.id);
  const crop = runtime.home.garden.requireState().settings.crops[gift.cropId];
  const sender =
    giver.kind === "agent" ? runtime.agent(giver.id).name : "管理台管理员";
  const timestamp = new Date(runtime.now()).toISOString();
  runtime.memory.bind(role.id).append({
    dedupe: "garden-gift:" + gift.giftId,
    kind: "garden.gift",
    direction: "internal",
    origin: "garden",
    conversation: "@garden",
    connectionId: role.connectionId,
    occurredAt: timestamp,
    observedAt: timestamp,
    body: `${sender} 赠送了 ${gift.quantity} 份${crop.name}（花园收成）。`,
    payload: {
      giftId: gift.giftId,
      cropId: gift.cropId,
      quantity: gift.quantity,
      generation: runtime.home.generation(role.id),
    },
  });
}

export function gardenGiftSources(runtime, agentId) {
  if (!runtime.home.garden.initialized()) return [];
  const memory = runtime.memory.bind(agentId);
  return memory.db
    .prepare(
      `SELECT e.id,e.body,e.occurred_at FROM events e
       JOIN garden_gifts g ON g.id=json_extract(e.payload,'$.giftId')
       AND g.recipient_kind='agent' AND g.recipient_id=e.agent_id
       WHERE e.agent_id=? AND e.conversation='@garden'
       AND e.kind='garden.gift' AND e.origin='garden' AND json_extract(e.payload,'$.generation')=?
       ORDER BY e.seq DESC LIMIT 12`,
    )
    .all(agentId, runtime.home.generation(agentId))
    .map((row) => ({
      evidenceId: row.id,
      text: row.body,
      at: row.occurred_at,
    }));
}
