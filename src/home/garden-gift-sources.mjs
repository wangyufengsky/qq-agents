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

export function recordGardenItemGift(runtime, gift) {
  const { recipient, giver, at } = gift;
  if (recipient.kind !== "agent") return;
  const role = runtime.agent(recipient.id);
  const timestamp = new Date(at).toISOString();
  // Retain an experience citation without copying the participants' private paper note into memory.
  runtime.memory.bind(role.id).append({
    dedupe: "garden-item-gift:" + gift.id,
    kind: "garden.item_gift",
    direction: "internal",
    origin: "garden",
    conversation: "@garden",
    connectionId: role.connectionId,
    occurredAt: timestamp,
    observedAt: timestamp,
    body: `${giver.name} 送了你一份${gift.name}。来历和赠言可在花园的个人物品栏中查看。`,
    payload: { transferId: gift.id, generation: recipient.generation },
  });
}

export function gardenGiftSources(runtime, agentId) {
  if (!runtime.home.garden.initialized()) return [];
  const memory = runtime.memory.bind(agentId);
  return memory.db
    .prepare(
      `SELECT e.id,e.body,e.occurred_at FROM events e
       WHERE e.agent_id=? AND e.conversation='@garden'
       AND e.origin='garden' AND json_extract(e.payload,'$.generation')=?
       AND (
         (e.kind='garden.gift' AND EXISTS (
           SELECT 1 FROM garden_gifts g WHERE g.id=json_extract(e.payload,'$.giftId')
             AND g.recipient_kind='agent' AND g.recipient_id=e.agent_id
         )) OR (e.kind='garden.item_gift' AND EXISTS (
           SELECT 1 FROM garden_item_transfers t
           WHERE t.id=json_extract(e.payload,'$.transferId')
             AND t.recipient=json_array('agent',e.agent_id,json_extract(e.payload,'$.generation'))
         ))
       ) ORDER BY e.seq DESC LIMIT 12`,
    )
    .all(agentId, runtime.home.generation(agentId))
    .map((row) => ({
      evidenceId: row.id,
      text: row.body,
      at: row.occurred_at,
    }));
}
