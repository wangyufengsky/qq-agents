// @ts-check
import {
  resolveMessage,
  scopeFor,
  referenceNamespaceSql,
} from "./message-ids.mjs";
// Derived indexes only: raw events and diary history are never rewritten.
/** @param {import("node:sqlite").DatabaseSync} db @param {number} version */
export function migrateSearch(db, version) {
  if (version >= 3) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (version < 2)
      db.exec(`
      CREATE INDEX IF NOT EXISTS events_agent_seq ON events(agent_id,seq);
      CREATE INDEX IF NOT EXISTS events_time ON events(agent_id,occurred_at,seq);
      CREATE INDEX IF NOT EXISTS events_connection_time ON events(agent_id,connection_id,conversation,occurred_at,seq);
      CREATE VIRTUAL TABLE events_fts USING fts5(body,content='events',content_rowid='seq',tokenize='trigram');
      CREATE TRIGGER events_fts_insert AFTER INSERT ON events BEGIN
        INSERT INTO events_fts(rowid,body) VALUES(new.seq,new.body);
      END;
      CREATE TRIGGER events_fts_delete AFTER DELETE ON events BEGIN
        INSERT INTO events_fts(events_fts,rowid,body) VALUES('delete',old.seq,old.body);
      END;
      CREATE TRIGGER events_fts_update AFTER UPDATE OF body ON events BEGIN
        INSERT INTO events_fts(events_fts,rowid,body) VALUES('delete',old.seq,old.body);
        INSERT INTO events_fts(rowid,body) VALUES(new.seq,new.body);
      END;
      INSERT INTO events_fts(events_fts) VALUES('rebuild');
      CREATE TABLE event_links(source_seq INTEGER NOT NULL REFERENCES events(seq),agent_id TEXT NOT NULL,connection_id TEXT NOT NULL,conversation TEXT NOT NULL,target_message_id TEXT NOT NULL,relation TEXT NOT NULL,PRIMARY KEY(source_seq,target_message_id,relation));
      CREATE INDEX event_links_target ON event_links(agent_id,connection_id,conversation,target_message_id,source_seq);
      CREATE TRIGGER event_links_insert AFTER INSERT ON events BEGIN
        INSERT OR IGNORE INTO event_links
        SELECT new.seq,new.agent_id,new.connection_id,new.conversation,CAST(json_extract(value,'$.data.id') AS TEXT),'explicit-reply'
        FROM json_each(new.payload,'$.segments')
        WHERE json_extract(value,'$.type')='reply' AND json_extract(value,'$.data.id') IS NOT NULL
          AND new.kind IN ('message.received','message.sent','legacy.message-observation');
        INSERT OR IGNORE INTO event_links
        SELECT new.seq,new.agent_id,new.connection_id,new.conversation,CAST(json_extract(new.payload,'$.raw.message_id') AS TEXT),'recall-notice'
        WHERE json_extract(new.payload,'$.raw.notice_type') IN ('group_recall','friend_recall') AND json_extract(new.payload,'$.raw.message_id') IS NOT NULL;
      END;
      INSERT OR IGNORE INTO event_links
      SELECT e.seq,e.agent_id,e.connection_id,e.conversation,CAST(json_extract(j.value,'$.data.id') AS TEXT),'explicit-reply'
      FROM events e,json_each(e.payload,'$.segments') j
      WHERE json_extract(j.value,'$.type')='reply' AND json_extract(j.value,'$.data.id') IS NOT NULL
        AND e.kind IN ('message.received','message.sent','legacy.message-observation');
      INSERT OR IGNORE INTO event_links
      SELECT seq,agent_id,connection_id,conversation,CAST(json_extract(payload,'$.raw.message_id') AS TEXT),'recall-notice'
      FROM events WHERE json_extract(payload,'$.raw.notice_type') IN ('group_recall','friend_recall') AND json_extract(payload,'$.raw.message_id') IS NOT NULL;
    `);
    // Confirmed bot replies use payload.replyTo; gateway echoes are optional.
    // Upgrade existing schema 2 indexes without rebuilding the FTS table.
    db.exec(`
      DROP TRIGGER IF EXISTS event_links_sent_insert;
      CREATE TRIGGER event_links_sent_insert AFTER INSERT ON events
      WHEN new.kind='message.sent' AND json_extract(new.payload,'$.replyTo') IS NOT NULL
      BEGIN
        INSERT OR IGNORE INTO event_links
        VALUES(new.seq,new.agent_id,new.connection_id,new.conversation,CAST(json_extract(new.payload,'$.replyTo') AS TEXT),'explicit-reply');
      END;
      INSERT OR IGNORE INTO event_links
      SELECT seq,agent_id,connection_id,conversation,CAST(json_extract(payload,'$.replyTo') AS TEXT),'explicit-reply'
      FROM events WHERE kind='message.sent' AND json_extract(payload,'$.replyTo') IS NOT NULL;
      PRAGMA user_version=3;
      COMMIT;
    `);
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/**
 * @param {any} memory Bound AgentMemory.
 * @param {{id: string, afterSeq?: number, limit?: number, maxChars?: number}} options
 * @param {any} current
 */
export function related(
  memory,
  { id, afterSeq = 0, limit = 10, maxChars = 6000 },
  current,
) {
  if (
    !Number.isSafeInteger(afterSeq) ||
    afterSeq < 0 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50 ||
    !Number.isInteger(maxChars) ||
    maxChars < 512 ||
    maxChars > 16000
  )
    throw Error("INVALID_BUDGET");
  const db = memory.db,
    anchor = db
      .prepare("SELECT * FROM events WHERE agent_id=? AND id=?")
      .get(memory.agentId, id);
  if (!anchor) throw Error("RECORD_NOT_FOUND");
  const sources = db
    .prepare(
      `SELECT DISTINCT l.source_seq FROM event_links l JOIN events e ON e.seq=l.source_seq WHERE l.agent_id=? AND l.connection_id=? AND l.conversation=? AND (l.source_seq=? OR EXISTS(SELECT 1 FROM message_identities i WHERE i.agent_id=l.agent_id AND i.connection_id=l.connection_id AND i.conversation=l.conversation AND i.message_id=l.target_message_id AND (${referenceNamespaceSql("e")} IS NULL OR i.namespace=${referenceNamespaceSql("e")}) GROUP BY i.message_id HAVING COUNT(DISTINCT i.event_id)=1 AND MIN(i.event_id)=?)) AND l.source_seq>? ORDER BY l.source_seq LIMIT ?`,
    )
    .all(
      memory.agentId,
      anchor.connection_id,
      anchor.conversation,
      anchor.seq,
      anchor.id,
      afterSeq,
      limit + 1,
    );
  const links = sources.flatMap((/** @type {any} */ { source_seq }) =>
    db
      .prepare(
        `SELECT e.*,l.relation,l.target_message_id FROM event_links l JOIN events e ON e.seq=l.source_seq WHERE l.source_seq=? ORDER BY l.target_message_id`,
      )
      .all(source_seq),
  );
  const groups = new Map();
  for (const link of links) {
    if (!groups.has(link.seq))
      groups.set(link.seq, {
        record: memory.event(link, current, true),
        links: [],
      });
    const target = resolveMessage(db, scopeFor(link), link.target_message_id);
    groups.get(link.seq).links.push({
      relation: link.relation,
      fromId: link.id,
      toMessageId: link.target_message_id,
      toId: target?.id ?? null,
      status: target ? "observed" : "unavailable",
    });
  }
  const items = [];
  for (const group of groups.values()) {
    if (items.length >= limit) break;
    // Keep complete source groups so a seq cursor never skips an edge.
    if (JSON.stringify([...items, group]).length > maxChars) {
      if (!items.length)
        items.push({
          record: {
            id: group.record.id,
            seq: group.record.seq,
            conversation: group.record.conversation,
            disclosure: group.record.disclosure,
          },
          linksOmitted: true,
          expand: { tool: "memory_read", id: group.record.id },
        });
      break;
    }
    items.push(group);
  }
  return {
    anchorId: id,
    items,
    nextAfterSeq:
      groups.size > items.length
        ? (items.at(-1)?.record.seq ?? afterSeq)
        : null,
    notice:
      "Explicit reply and recall edges only, across time in the same source. A reply is not necessarily a correction, agreement or cause; a recall does not establish truth. Read both original records. No edge does not prove no later update.",
  };
}
