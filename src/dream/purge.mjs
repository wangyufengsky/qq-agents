// @ts-check

/** @param {import("node:sqlite").DatabaseSync} db */
export function initializeDreamPurge(db) {
  // Diary-to-diary references can be ordered by revision rowid, including
  // same-millisecond writes. Other records use their stored reference time.
  const dependencyClosure = `sources(id,since_at,until_at,seq,until_seq,revision) AS (
    SELECT NEW.source_id,NULL,NULL,NULL,NULL,NULL WHERE NEW.source_type<>'cognition'
    UNION
    SELECT d.source_id,CASE WHEN d.seq IS NOT NULL THEN d.used_at END,d.until_at,d.seq,d.until_seq,d.revision
    FROM sources s JOIN dream_source_dependencies d
      ON d.agent_id=NEW.agent_id AND d.parent_id=s.id
    WHERE CASE
      WHEN s.revision IS NOT NULL AND d.parent_revision IS NOT NULL THEN s.revision=d.parent_revision
      WHEN s.seq IS NOT NULL AND d.seq IS NOT NULL THEN s.seq<d.seq AND (s.until_seq IS NULL OR d.seq<s.until_seq)
      WHEN d.used_at IS NULL THEN 1
      ELSE (s.since_at IS NULL OR s.since_at<=d.used_at)
        AND (s.until_at IS NULL OR d.used_at<=s.until_at)
    END
  )`;
  db.exec(`
    CREATE VIEW IF NOT EXISTS dream_source_dependencies(
      agent_id,source_id,parent_id,used_at,until_at,seq,until_seq,revision,parent_revision
    ) AS
    SELECT agent_id,id,json_extract(payload,'$.sourceEventId'),observed_at,NULL,NULL,NULL,NULL,NULL FROM events
    WHERE json_type(payload,'$.sourceEventId')='text'
    UNION ALL
    SELECT d.agent_id,d.id,parent.value,r.written_at,next.written_at,r.rowid,next.rowid,r.revision,NULL
    FROM diaries d JOIN diary_revisions r ON r.id=d.id
    LEFT JOIN diary_revisions next ON next.id=r.id AND next.revision=(
      SELECT min(other.revision) FROM diary_revisions other WHERE other.id=r.id AND other.revision>r.revision
    )
    JOIN json_each(r.metadata,'$.evidence') parent
    WHERE parent.type='text' AND parent.value NOT LIKE 'context:%'
    UNION ALL
    SELECT agent_id,id,json_extract(value,'$.sourceId'),json_extract(value,'$.createdAt'),NULL,NULL,NULL,NULL,NULL
    FROM memory_corrections WHERE json_type(value,'$.sourceId')='text'
    UNION ALL
    SELECT c.agent_id,c.id,json_extract(target.value,'$.id'),json_extract(c.value,'$.createdAt'),NULL,NULL,NULL,NULL,
      CASE WHEN json_extract(target.value,'$.type')='diary' THEN NULLIF(json_extract(target.value,'$.revision'),0) END
    FROM memory_corrections c JOIN json_each(c.value,'$.targets') target
    WHERE json_extract(target.value,'$.type') IN ('event','diary');

    CREATE VIEW IF NOT EXISTS dream_privacy_purge(agent_id,source_id,source_type) AS
    SELECT NULL,NULL,NULL WHERE 0;

    CREATE TRIGGER IF NOT EXISTS dream_privacy_purge_apply
    INSTEAD OF INSERT ON dream_privacy_purge BEGIN
      -- A revision's text and reason cannot be partially verified after one of
      -- its inputs is erased. Follow subsequent revisions and the exact merge.
      UPDATE cognition_revisions SET before_json=NULL,after_json='null',reason=''
      WHERE agent_id=NEW.agent_id AND (cognition_id,version) IN (
        WITH RECURSIVE
        ${dependencyClosure},
        affected(id,version) AS MATERIALIZED (
          SELECT e.cognition_id,e.cognition_version FROM cognition_evidence e
          JOIN sources s ON e.source_id=s.id
          WHERE e.agent_id=NEW.agent_id AND (s.id<>NEW.source_id OR e.source_type=NEW.source_type)
          AND (s.since_at IS NULL OR s.since_at<=e.created_at)
          AND (s.until_at IS NULL OR e.created_at<=s.until_at)
          UNION
          SELECT cognition_id,version FROM cognition_revisions
          WHERE agent_id=NEW.agent_id AND cognition_id=NEW.source_id AND NEW.source_type='cognition'
          UNION
          SELECT r.cognition_id,r.version FROM affected a JOIN cognition_revisions r
            ON r.agent_id=NEW.agent_id AND r.cognition_id=a.id AND r.version=(
              SELECT MIN(next.version) FROM cognition_revisions next
              WHERE next.agent_id=NEW.agent_id AND next.cognition_id=a.id AND next.version>a.version
            )
          UNION
          SELECT peer.cognition_id,peer.version FROM affected a
          JOIN cognition_revisions changed ON changed.agent_id=NEW.agent_id
            AND changed.cognition_id=a.id AND changed.version=a.version AND changed.op='MERGE'
          JOIN cognition_revisions peer ON peer.agent_id=NEW.agent_id
            AND peer.run_id=changed.run_id AND peer.op='MERGE'
            AND COALESCE(json_extract(peer.after_json,'$.merged_into'),peer.cognition_id)
              =COALESCE(json_extract(changed.after_json,'$.merged_into'),changed.cognition_id)
        )
        SELECT id,version FROM affected
      );

      UPDATE dream_checkpoints
      SET cognition_version=(SELECT MAX(c.cognition_version)+1 FROM dream_checkpoints c WHERE c.agent_id=NEW.agent_id),
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE agent_id=NEW.agent_id AND EXISTS (
        SELECT 1 FROM cognition_revisions WHERE agent_id=NEW.agent_id AND after_json='null'
      );

      DELETE FROM cognition_links
      WHERE agent_id=NEW.agent_id AND (
        NEW.source_type='cognition' AND NEW.source_id IN (from_id,to_id)
        OR EXISTS (
          SELECT 1 FROM cognitions c JOIN cognition_revisions r
          ON r.agent_id=c.agent_id AND r.cognition_id=c.id AND r.version=c.version
          WHERE c.agent_id=NEW.agent_id AND r.after_json='null' AND c.id IN (from_id,to_id)
        )
      );

      -- Carry surviving source references forward without vouching for the
      -- deleted synthesis or its unsupported source scopes.
      INSERT INTO cognition_evidence
      SELECT e.agent_id,e.cognition_id,e.cognition_version+1,e.source_id,e.source_type,e.scope_id,e.relation,e.created_at
      FROM cognition_evidence e JOIN cognitions c ON c.agent_id=e.agent_id AND c.id=e.cognition_id
        AND c.version=e.cognition_version
      JOIN cognition_revisions r ON r.agent_id=c.agent_id AND r.cognition_id=c.id AND r.version=c.version
      WHERE e.agent_id=NEW.agent_id AND r.after_json='null'
      AND NOT EXISTS (
        WITH RECURSIVE ${dependencyClosure}
        SELECT 1 FROM sources s WHERE s.id=e.source_id
          AND (s.since_at IS NULL OR s.since_at<=e.created_at)
          AND (s.until_at IS NULL OR e.created_at<=s.until_at)
      );

      UPDATE cognitions SET version=version+1,content='',subject_key='purged:'||id,
        status='disputed',epistemic_status='disputed',importance=0,confidence=0,
        source_scopes_json='[]',merged_into=NULL,valid_to=NULL,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE agent_id=NEW.agent_id AND (id,version) IN (
        SELECT cognition_id,version FROM cognition_revisions WHERE agent_id=NEW.agent_id AND after_json='null'
      );

      INSERT INTO cognition_revisions
      SELECT c.agent_id,c.id,c.version,'PURGE_REBUILD',NULL,json_object(
        'id',c.id,'agent_id',c.agent_id,'scope_id',c.scope_id,'category',c.category,
        'subject_key',c.subject_key,'content',c.content,'epistemic_status',c.epistemic_status,
        'importance',c.importance,'confidence',c.confidence,'status',c.status,'version',c.version,
        'from_private',c.from_private,'source_scopes_json',c.source_scopes_json,
        'merged_into',c.merged_into,'valid_from',c.valid_from,'valid_to',c.valid_to,
        'created_at',c.created_at,'updated_at',c.updated_at
      ),NULL,'system-purge','Source erased',c.updated_at
      FROM cognitions c JOIN cognition_revisions r ON r.agent_id=c.agent_id AND r.cognition_id=c.id
        AND r.version=c.version-1
      WHERE c.agent_id=NEW.agent_id AND r.after_json='null';

      DELETE FROM cognition_evidence WHERE agent_id=NEW.agent_id AND (cognition_id,cognition_version) IN (
        SELECT cognition_id,version FROM cognition_revisions WHERE agent_id=NEW.agent_id AND after_json='null'
      );
      DELETE FROM cognition_revisions WHERE agent_id=NEW.agent_id AND after_json='null';

      -- Rebuild only prior, still-live projections in cached order. This stays
      -- within the original summary budget and cannot reintroduce erased text.
      UPDATE awakening_contexts SET cognition_version=MAX(cognition_version+1,coalesce((
        SELECT max(cognition_version) FROM dream_checkpoints WHERE agent_id=NEW.agent_id
      ),0)), (summary,source_refs_json)=(
        SELECT coalesce(group_concat(content,char(10)),''),json_group_array(json(ref))
        FROM (
          SELECT c.content,j.value AS ref FROM json_each(awakening_contexts.source_refs_json) j
          JOIN cognitions c ON c.agent_id=NEW.agent_id AND c.id=json_extract(j.value,'$.id')
            AND c.version=json_extract(j.value,'$.version') AND c.status='active'
          ORDER BY j.key
        )
      )
      WHERE agent_id=NEW.agent_id AND EXISTS (
        SELECT 1 FROM json_each(awakening_contexts.source_refs_json) j
        WHERE NOT EXISTS (
          SELECT 1 FROM cognitions c WHERE c.agent_id=NEW.agent_id AND c.id=json_extract(j.value,'$.id')
            AND c.version=json_extract(j.value,'$.version') AND c.status='active'
        )
      );
      DELETE FROM awakening_contexts WHERE agent_id=NEW.agent_id AND summary='';
    END;

    CREATE TRIGGER IF NOT EXISTS dream_privacy_event_delete AFTER DELETE ON events BEGIN
      DELETE FROM event_links WHERE source_seq=OLD.seq;
      DELETE FROM message_aliases WHERE event_id=OLD.id;
      DELETE FROM message_observations WHERE event_id=OLD.id;
      INSERT INTO dream_privacy_purge VALUES(OLD.agent_id,OLD.id,'event');
    END;

    CREATE TRIGGER IF NOT EXISTS dream_privacy_diary_delete AFTER DELETE ON diaries BEGIN
      DELETE FROM diary_revisions WHERE id=OLD.id;
      INSERT INTO dream_privacy_purge VALUES(OLD.agent_id,OLD.id,'diary');
    END;

    CREATE TRIGGER IF NOT EXISTS dream_privacy_correction_delete AFTER DELETE ON memory_corrections BEGIN
      INSERT INTO dream_privacy_purge VALUES(OLD.agent_id,OLD.id,'correction');
    END;

    CREATE TRIGGER IF NOT EXISTS dream_privacy_cognition_delete AFTER DELETE ON cognitions BEGIN
      INSERT INTO dream_privacy_purge VALUES(OLD.agent_id,OLD.id,'cognition');
      DELETE FROM cognition_evidence WHERE agent_id=OLD.agent_id AND cognition_id=OLD.id;
      DELETE FROM cognition_revisions WHERE agent_id=OLD.agent_id AND cognition_id=OLD.id;
      UPDATE cognitions SET merged_into=NULL WHERE agent_id=OLD.agent_id AND merged_into=OLD.id;
    END;
  `);
}

// Older exports can contain references to a source deleted before the
// SQLite triggers existed. Apply the same redaction after all rows load.
/** @param {import("node:sqlite").DatabaseSync} db @param {string} agentId */
export function reconcileDreamPurges(db, agentId) {
  if (
    !db
      .prepare("SELECT 1 FROM cognition_evidence WHERE agent_id=? LIMIT 1")
      .get(agentId)
  )
    return;
  const missing = db
    .prepare(
      `SELECT DISTINCT source_id,source_type FROM cognition_evidence e WHERE agent_id=? AND (
      (source_type='event' AND NOT EXISTS(SELECT 1 FROM events WHERE agent_id=e.agent_id AND id=e.source_id))
      OR (source_type='diary' AND NOT EXISTS(SELECT 1 FROM diaries WHERE agent_id=e.agent_id AND id=e.source_id))
      OR (source_type='correction' AND NOT EXISTS(SELECT 1 FROM memory_corrections WHERE agent_id=e.agent_id AND id=e.source_id))
    )
    UNION
    SELECT d.parent_id,'unknown' FROM dream_source_dependencies d
    WHERE d.agent_id=? AND d.parent_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM events WHERE agent_id=d.agent_id AND id=d.parent_id
      UNION ALL
      SELECT 1 FROM diaries WHERE agent_id=d.agent_id AND id=d.parent_id
    )`,
    )
    .all(agentId, agentId);
  const purge = db.prepare("INSERT INTO dream_privacy_purge VALUES(?,?,?)");
  for (const { source_id, source_type } of missing)
    purge.run(agentId, source_id, source_type);
}
