// @ts-check
// The same event edges drive both the read projection and SQL erasure. A forwarded copy
// inherits the matched node's evidence only when its index and snapshot agree.
export const dreamEventParents = `CREATE VIEW IF NOT EXISTS dream_event_parents(agent_id,id,parent_id) AS
  SELECT agent_id,id,json_extract(payload,'$.sourceEventId') FROM events WHERE json_type(payload,'$.sourceEventId')='text'
  UNION ALL SELECT agent_id,id,json_extract(payload,'$.rootEventId') FROM events WHERE json_type(payload,'$.rootEventId')='text'
  UNION ALL SELECT agent_id,id,json_extract(payload,'$.app.source.eventId') FROM events WHERE json_type(payload,'$.app.source.eventId')='text'
  UNION ALL SELECT e.agent_id,e.id,ref.value FROM events e JOIN json_each(e.payload,'$.app.evidence') ref WHERE ref.type='text'
  UNION ALL SELECT agent_id,id,json_extract(payload,'$.confirmedEventId') FROM events WHERE kind='forward.node' AND json_type(payload,'$.confirmedEventId')='text'
  UNION ALL SELECT node.agent_id,node.id,ref.value FROM events node JOIN events sent
    ON sent.agent_id=node.agent_id AND sent.id=json_extract(node.payload,'$.confirmedEventId')
    JOIN json_each(sent.payload,'$.eventIds') ref ON ref.key=json_extract(node.payload,'$.index')
    LEFT JOIN json_each(sent.payload,'$.forwardSnapshot.messages') snap ON snap.key=ref.key
    WHERE node.kind='forward.node' AND sent.kind='message.sent' AND sent.direction='out' AND sent.status='confirmed'
      AND json_type(node.payload,'$.index')='integer' AND ref.type='text'
      AND CASE WHEN json_type(snap.value,'$.message')='array' THEN
        json_extract(snap.value,'$.message')=coalesce(json_extract(node.payload,'$.segments'),'[]')
        ELSE json_extract(node.payload,'$.source')='confirmed-send-sources' END`;

// Freeze IDs, revisions and scope names only. The source records retain their own content.
/** @param {any} memory @param {any} record */
export function correctionProvenance(memory, record) {
  const snapshots =
    /** @type {{id:string,revision?:number,conversation?:string,metadata?:{conversation?:string}}[]} */ ([
      ...(record.evidenceSnapshot?.references ?? []),
      ...(record.counterEvidenceSnapshot?.references ?? []),
    ]);
  const ids = new Set([
    ...(record.evidence ?? []),
    ...(record.counterEvidence ?? []),
    ...snapshots.map((ref) => ref.id),
  ]);
  const refs = [...ids].map((id) => ({
    id,
    revision:
      snapshots.find((ref) => ref.id === id && ref.revision)?.revision ??
      memory.db
        .prepare("SELECT revision FROM diaries WHERE id=? AND agent_id=?")
        .get(id, memory.agentId)?.revision ??
      0,
  }));
  const scopes = [
    record.conversation,
    record.writtenIn?.conversation ?? record.writtenIn,
    record.source,
    record.target,
    ...snapshots.map((ref) => ref.conversation ?? ref.metadata?.conversation),
  ].filter((value) => typeof value === "string");
  return { refs, scopes };
}
