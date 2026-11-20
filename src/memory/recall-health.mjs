// @ts-check
// Legacy diagnostics carry only the turn start. Keep the indexed expressions
// identical on reads and writes so frequent status polling never scans history.
const completion = `coalesce(json_extract(value,'$.memoryRecall.completedAt'),
  CASE WHEN json_extract(value,'$.memoryRecall.opening.status') IN ('matched','empty','withheld')
         OR json_extract(value,'$.memoryRecall.active.status') IN ('matched','empty','withheld')
       THEN json_extract(value,'$.startedAt') END)`;
const delivery = `coalesce(json_extract(value,'$.memoryRecall.deliveredAt'),
  CASE WHEN json_extract(value,'$.memoryRecall.opening.presented') > 0
         OR json_extract(value,'$.memoryRecall.active.presented') > 0
       THEN json_extract(value,'$.startedAt') END)`;

/** @param {import("node:sqlite").DatabaseSync} db */
export function initializeRecallHealth(db) {
  db.exec(`CREATE INDEX IF NOT EXISTS recall_last_completion ON model_turns(agent_id,${completion} DESC) WHERE ${completion} IS NOT NULL;
           CREATE INDEX IF NOT EXISTS recall_last_delivery ON model_turns(agent_id,${delivery} DESC) WHERE ${delivery} IS NOT NULL;`);
}

/** @param {import("node:sqlite").DatabaseSync} db @param {string} agentId */
export function recallHealthHistory(db, agentId) {
  const completed = db
    .prepare(
      `SELECT ${completion} AS at,
    json_extract(value,'$.memoryRecall.completedAt') IS NULL AS estimated,
    coalesce(json_extract(value,'$.memoryRecall.completedResult'),
      CASE WHEN json_extract(value,'$.memoryRecall.active.status') IN ('empty','matched','withheld')
           THEN json_extract(value,'$.memoryRecall.active.status')
           ELSE json_extract(value,'$.memoryRecall.opening.status') END) AS result
    FROM model_turns WHERE agent_id=? AND ${completion} IS NOT NULL ORDER BY ${completion} DESC LIMIT 1`,
    )
    .get(agentId);
  const delivered = db
    .prepare(
      `SELECT ${delivery} AS at,
    json_extract(value,'$.memoryRecall.deliveredAt') IS NULL AS estimated
    FROM model_turns WHERE agent_id=? AND ${delivery} IS NOT NULL ORDER BY ${delivery} DESC LIMIT 1`,
    )
    .get(agentId);
  return {
    completed: completed
      ? {
          at: completed.at,
          estimated: Boolean(completed.estimated),
          empty: completed.result === "empty",
        }
      : null,
    delivered: delivered
      ? { at: delivered.at, estimated: Boolean(delivered.estimated) }
      : null,
  };
}
