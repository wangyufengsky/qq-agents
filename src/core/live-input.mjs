// @ts-check
// Recall notices are append-only. The original row keeps status=observed;
// consult its scoped notice links whenever live input is used as authority.
/** @param {any} runtime @param {string} agentId @param {string} conversation @param {string} id */
export function liveInput(runtime, agentId, conversation, id) {
  const a = runtime.agent(agentId),
    db = runtime.memory.bind(a.id).db;
  const row = db
    .prepare(
      "SELECT * FROM events WHERE agent_id=? AND id=? AND conversation=? AND connection_id=?",
    )
    .get(a.id, id, conversation, a.connectionId);
  if (
    !row ||
    row.kind !== "message.received" ||
    row.direction !== "in" ||
    row.origin !== "live" ||
    row.status === "recalled" ||
    JSON.parse(row.payload).trustedInput !== true
  )
    return null;
  const recalled = db
    .prepare(
      `SELECT 1 FROM event_links l JOIN events n ON n.seq=l.source_seq
    WHERE l.agent_id=? AND l.connection_id=? AND l.conversation=? AND l.target_message_id=?
      AND l.relation='recall-notice' AND n.kind='message.recalled' AND n.origin='live'
      AND json_extract(n.payload,'$.trustedInput')=1
      AND COALESCE(json_extract(n.payload,'$.messageNamespace'),'onebot')=? LIMIT 1`,
    )
    .get(
      a.id,
      a.connectionId,
      conversation,
      row.message_id,
      JSON.parse(row.payload).messageNamespace || "onebot",
    );
  return recalled ? null : row;
}
