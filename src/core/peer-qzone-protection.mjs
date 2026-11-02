// @ts-check

const statements = new WeakMap();

/** Durable markers survive deletion of a source event and session rotation.
 * @param {string} userId
 */
export const peerQzoneMarker = (userId) => "peer-qzone:" + userId;

/** Only the subject of the source may receive it without a disclosure grant.
 * @param {string[]} targets @param {string} conversation
 */
export const peerQzoneContext = (targets, conversation) =>
  targets.every((id) => conversation === `private:${id}`);

/** Resolve protection on stored derivatives as well as explicit markers.
 * @param {any} runtime @param {{agentId:string,privateRead:Iterable<string>}} ctx
 * @param {Iterable<string>} [ids]
 * @returns {string[]}
 */
export function peerQzoneSources(runtime, ctx, ids = ctx.privateRead) {
  const targets = new Set();
  const db = runtime.memory.db;
  let lookup = statements.get(db);
  if (!lookup) {
    lookup = db.prepare(
      "SELECT payload AS metadata FROM events WHERE agent_id=? AND id=? UNION ALL SELECT metadata FROM diaries WHERE agent_id=? AND id=? UNION ALL SELECT value AS metadata FROM work_notes WHERE agent_id=? AND id=? UNION ALL SELECT value AS metadata FROM intentions WHERE agent_id=? AND id=? UNION ALL SELECT value AS metadata FROM self_candidates WHERE agent_id=? AND id=?",
    );
    statements.set(db, lookup);
  }
  for (const id of ids) {
    if (id.startsWith("peer-qzone:")) targets.add(id.slice(11));
    for (const row of lookup.all(
      ctx.agentId,
      id,
      ctx.agentId,
      id,
      ctx.agentId,
      id,
      ctx.agentId,
      id,
      ctx.agentId,
      id,
    ))
      for (const target of JSON.parse(row.metadata).protectedPeerQzoneTargets ||
        [])
        targets.add(target);
  }
  return [...targets].sort();
}

/** @param {any} ctx @param {any} record */
export function trackPeerQzone(ctx, record) {
  for (const id of record?.protectedPeerQzoneTargets || [])
    ctx.privateRead.add(peerQzoneMarker(id));
}
