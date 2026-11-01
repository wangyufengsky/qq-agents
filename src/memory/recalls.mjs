// @ts-check
// Projection-only annotations preserve immutable archive bodies and evidence digests.
/** @param {import("node:sqlite").DatabaseSync} db @param {string} agentId @param {string} id */
export function recallAnnotation(db, agentId, id) {
  const action = db
    .prepare(
      "SELECT id,observed_at FROM events WHERE agent_id=? AND kind='action.confirmed' AND status='confirmed' AND json_extract(payload,'$.recalledEventId')=? AND json_extract(payload,'$.actionKind')='recall' ORDER BY seq LIMIT 1",
    )
    .get(agentId, id);
  return action
    ? {
        recalled: {
          eventId: String(action.id),
          at: String(action.observed_at),
        },
        recallNotice: "（你已撤回）",
      }
    : {};
}
