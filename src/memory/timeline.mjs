const kinds = "'message.received','message.sent','legacy.message-observation'";

export function timeBasis(occurredAt, payload, origin) {
  const p = typeof payload === "string" ? JSON.parse(payload) : payload;
  if (!Number.isFinite(Date.parse(occurredAt)) || p.timeKnown === false)
    return "unknown";
  if (p.timeBasis === "message") return "message";
  if (p.source === "previous-import" && p.previousPayload)
    return timeBasis(occurredAt, p.previousPayload, origin);
  if (
    p.timeBasis === "observation" ||
    ["social-v2", "bridge_cache", "confirmed_send_receipt"].includes(p.source)
  )
    return "observation";
  if (
    p.timeBasis === "unknown" ||
    (origin.startsWith("legacy") && p.timeKnown !== true)
  )
    return "unknown";
  if (
    p.raw?.post_type &&
    p.timeKnown !== true &&
    !(
      Number(p.raw.time) > 0 &&
      Number.isFinite(new Date(Number(p.raw.time) * 1000).getTime())
    )
  )
    return "observation";
  return "message";
}

// Derived data only. One classifier serves inserts, enrichment, backfill and
// restored records; observation timestamps never enter the message timeline.
export function migrateTimeline(db, version) {
  db.function("message_time", { deterministic: true }, (at, json, origin) =>
    timeBasis(at, json, origin) === "message" ? Date.parse(at) : null,
  );
  if (version >= 5) return;
  const insert = (prefix) => `INSERT INTO event_timeline
    SELECT ${prefix}.seq,${prefix}.agent_id,${prefix}.connection_id,${prefix}.conversation,
      message_time(${prefix}.occurred_at,${prefix}.payload,${prefix}.origin),${prefix}.id
    WHERE ${prefix}.kind IN (${kinds})
      AND message_time(${prefix}.occurred_at,${prefix}.payload,${prefix}.origin) IS NOT NULL;`;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS event_timeline(seq INTEGER PRIMARY KEY REFERENCES events(seq) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,connection_id TEXT NOT NULL,conversation TEXT NOT NULL,time_ms INTEGER NOT NULL,event_id TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS event_timeline_scope ON event_timeline(agent_id,connection_id,conversation,time_ms,event_id);
      DROP TRIGGER IF EXISTS event_timeline_insert;
      DROP TRIGGER IF EXISTS event_timeline_update;
      DROP TRIGGER IF EXISTS event_timeline_delete;
      CREATE TRIGGER event_timeline_insert AFTER INSERT ON events BEGIN ${insert("new")} END;
      CREATE TRIGGER event_timeline_update AFTER UPDATE OF occurred_at,payload,origin,connection_id,conversation,kind ON events BEGIN
        DELETE FROM event_timeline WHERE seq=old.seq; ${insert("new")} END;
      CREATE TRIGGER event_timeline_delete BEFORE DELETE ON events BEGIN DELETE FROM event_timeline WHERE seq=old.seq; END;
      DELETE FROM event_timeline;
      INSERT INTO event_timeline SELECT seq,agent_id,connection_id,conversation,message_time(occurred_at,payload,origin),id
        FROM events WHERE kind IN (${kinds}) AND message_time(occurred_at,payload,origin) IS NOT NULL;
      DROP TRIGGER IF EXISTS event_links_update;
      CREATE TRIGGER event_links_update AFTER UPDATE OF payload,connection_id,conversation,kind ON events BEGIN
        DELETE FROM event_links WHERE source_seq=old.seq;
        INSERT OR IGNORE INTO event_links
          SELECT new.seq,new.agent_id,new.connection_id,new.conversation,CAST(json_extract(value,'$.data.id') AS TEXT),'explicit-reply'
          FROM json_each(new.payload,'$.segments') WHERE json_extract(value,'$.type')='reply'
            AND json_extract(value,'$.data.id') IS NOT NULL AND new.kind IN (${kinds});
        INSERT OR IGNORE INTO event_links
          SELECT new.seq,new.agent_id,new.connection_id,new.conversation,CAST(json_extract(new.payload,'$.replyTo') AS TEXT),'explicit-reply'
          WHERE new.kind='message.sent' AND json_extract(new.payload,'$.replyTo') IS NOT NULL;
        INSERT OR IGNORE INTO event_links
          SELECT new.seq,new.agent_id,new.connection_id,new.conversation,CAST(json_extract(new.payload,'$.raw.message_id') AS TEXT),'recall-notice'
          WHERE json_extract(new.payload,'$.raw.notice_type') IN ('group_recall','friend_recall')
            AND json_extract(new.payload,'$.raw.message_id') IS NOT NULL;
      END;
      PRAGMA user_version=5; COMMIT;
    `);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function timelineAnchor(db, agentId, id) {
  return db
    .prepare(
      "SELECT t.* FROM events e JOIN event_timeline t ON t.seq=e.seq WHERE e.agent_id=? AND e.id=?",
    )
    .get(agentId, id);
}

export function timelineNeighbors(
  db,
  anchor,
  { direction, count, seconds, ceiling = Number.MAX_SAFE_INTEGER, cursor },
) {
  const before = direction === "before",
    edge = cursor || anchor;
  return db
    .prepare(
      `SELECT e.*,t.time_ms FROM event_timeline t JOIN events e ON e.seq=t.seq
    WHERE t.agent_id=? AND t.connection_id=? AND t.conversation=?
      AND t.time_ms BETWEEN ? AND ? AND (t.time_ms,t.event_id) ${before ? "<" : ">"} (?,?) AND t.seq<=?
    ORDER BY t.time_ms ${before ? "DESC" : "ASC"},t.event_id ${before ? "DESC" : "ASC"} LIMIT ?`,
    )
    .all(
      anchor.agent_id,
      anchor.connection_id,
      anchor.conversation,
      anchor.time_ms - seconds * 1000,
      anchor.time_ms + seconds * 1000,
      edge.time_ms,
      edge.event_id,
      ceiling,
      count,
    );
}
