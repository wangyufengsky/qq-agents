// @ts-check
// @ts-check
/** @typedef {{agent_id: string, conversation: string, next_due_at: number | null, state_version: number}} DueRow */
// Derived data is excluded from exports. Triggers cover every writer and
// restore, in the same transaction as the authoritative runtime state.
const chat =
  "(NEW.conversation GLOB 'group:[0-9]*' OR NEW.conversation GLOB 'private:[0-9]*')";
/** @param {string} value */
const next = (
  value,
) => `CASE WHEN json_extract(${value},'$.paused')=1 THEN NULL ELSE
  max((SELECT min(due) FROM (
    SELECT CASE WHEN json_extract(${value},'$.pendingWakes[0]') IS NOT NULL THEN coalesce(json_extract(${value},'$.wakeDueAt'),0) END AS due
    UNION ALL SELECT json_extract(${value},'$.wakeConfig.sleepUntil')
    UNION ALL SELECT CASE WHEN json_extract(${value},'$.replyCheckAt') IS NOT NULL THEN max(json_extract(${value},'$.replyCheckAt'),coalesce(json_extract(${value},'$.proactiveCooldownUntil'),0)) END
  )),coalesce(json_extract(${value},'$.silenceUntil'),0)) END`;
export class ConversationDue {
  /** @param {import("node:sqlite").DatabaseSync} db */
  constructor(db) {
    this.db = db;
  }
  initialize() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_due(agent_id TEXT NOT NULL,conversation TEXT NOT NULL,next_due_at INTEGER,state_version INTEGER NOT NULL,PRIMARY KEY(agent_id,conversation));
      CREATE INDEX IF NOT EXISTS conversation_due_time ON conversation_due(next_due_at,agent_id,conversation) WHERE next_due_at IS NOT NULL;
      CREATE TRIGGER IF NOT EXISTS conversation_due_insert AFTER INSERT ON runtime WHEN ${chat} BEGIN
        INSERT INTO conversation_due VALUES(NEW.agent_id,NEW.conversation,${next("NEW.value")},1)
        ON CONFLICT(agent_id,conversation) DO UPDATE SET next_due_at=excluded.next_due_at,state_version=state_version+1;
      END;
      CREATE TRIGGER IF NOT EXISTS conversation_due_update AFTER UPDATE OF value ON runtime WHEN ${chat} BEGIN
        INSERT INTO conversation_due VALUES(NEW.agent_id,NEW.conversation,${next("NEW.value")},1)
        ON CONFLICT(agent_id,conversation) DO UPDATE SET next_due_at=excluded.next_due_at,state_version=state_version+1;
      END;
      CREATE TRIGGER IF NOT EXISTS conversation_due_delete AFTER DELETE ON runtime BEGIN
        DELETE FROM conversation_due WHERE agent_id=OLD.agent_id AND conversation=OLD.conversation;
      END;
      CREATE INDEX IF NOT EXISTS runtime_organizing ON runtime(agent_id) WHERE json_extract(value,'$.lifecycle.status')='organizing' AND json_extract(value,'$.session') IS NOT NULL;
    `);
    this.rebuild();
  }
  /** @param {string} [agentId] */
  rebuild(agentId) {
    this.db.exec("SAVEPOINT rebuild_conversation_due");
    try {
      this.db
        .prepare(
          `DELETE FROM conversation_due${agentId ? " WHERE agent_id=?" : ""}`,
        )
        .run(...(agentId ? [agentId] : []));
      this.db
        .prepare(
          `INSERT INTO conversation_due SELECT agent_id,conversation,${next("value")},1 FROM runtime WHERE (conversation GLOB 'group:[0-9]*' OR conversation GLOB 'private:[0-9]*')${agentId ? " AND agent_id=?" : ""}`,
        )
        .run(...(agentId ? [agentId] : []));
      this.db.exec("RELEASE rebuild_conversation_due");
    } catch (error) {
      this.db.exec(
        "ROLLBACK TO rebuild_conversation_due; RELEASE rebuild_conversation_due",
      );
      throw error;
    }
  }
  /** @param {number} now @returns {DueRow[]} */
  ready(now, limit = 256) {
    return /** @type {DueRow[]} */ (
      this.db
        .prepare(
          "SELECT * FROM conversation_due WHERE next_due_at<=? ORDER BY next_due_at,agent_id,conversation LIMIT ?",
        )
        .all(now, limit)
    );
  }
  /** @param {string} agentId @param {string} conversation @returns {DueRow | undefined} */
  current(agentId, conversation) {
    return /** @type {DueRow | undefined} */ (
      this.db
        .prepare(
          "SELECT * FROM conversation_due WHERE agent_id=? AND conversation=?",
        )
        .get(agentId, conversation)
    );
  }
  /** @param {DueRow} row @param {number} until */
  defer(row, until) {
    this.db
      .prepare(
        "UPDATE conversation_due SET next_due_at=? WHERE agent_id=? AND conversation=? AND state_version=?",
      )
      .run(until, row.agent_id, row.conversation, row.state_version);
  }
}
