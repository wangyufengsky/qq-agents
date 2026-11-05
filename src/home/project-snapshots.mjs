// @ts-check
import { activityVersion } from "../tools/activities.mjs";
/** Server-only proof: missing legacy provenance never becomes safe by rewriting.
 * @param {any} runtime @param {any} ctx @param {any} old @param {any} args */
export function projectSnapshotProof(runtime, ctx, old, args) {
  try {
    if (ctx.conversation !== "@subject") return null;
    const evidence = new Set([
      ...ctx.privateRead,
      ...(args.evidence || []),
      ...(old?.homeSnapshotProvenance?.evidence || []),
    ]);
    if (args.files?.length || old?.files?.length) return null;
    if (old?.activity) {
      if (
        old.activity.mode !== "console" ||
        old.activity.conversation !== "@subject"
      )
        return null;
      const rows = runtime.memory.db
        .prepare(
          "SELECT value FROM activity_history WHERE agent_id=? AND project_id=?",
        )
        .all(ctx.agentId, old.id);
      if (!rows.length || rows.length > 500) return null;
      for (const row of rows) {
        const entry = JSON.parse(row.value);
        for (const id of [
          ...(entry.homeSnapshotProvenance?.evidence || []),
          ...(entry.previousProject?.homeSnapshotProvenance?.evidence || []),
        ])
          evidence.add(id);
        // Joining without supplying text is administrative participation, not authored material.
        if (
          entry.author === "administrator" &&
          entry.action === "join" &&
          !entry.draft &&
          entry.previousProject?.homeSnapshotProvenance?.version === 1
        )
          continue;
        if (entry.homeSnapshotProvenance?.version !== 1) return null;
      }
    } else if (old && old.homeSnapshotProvenance?.version !== 1) return null;
    runtime.home.rooms.shareable({ ...ctx, privateRead: evidence });
    return {
      version: 1,
      ownerAgentId: ctx.agentId,
      conversation: "@subject",
      evidence: [...evidence],
    };
  } catch {
    // Lack of display eligibility never prevents ordinary project authoring.
    return null;
  }
}
/** @param {any} rooms @param {any} ctx @param {any} source */
export function resolveProjectSnapshot(rooms, ctx, source) {
  const memory = rooms.runtime.memory.bind(ctx.agentId),
    project = memory.identity.project(source.id);
  if (!project) throw Error("HOME_SNAPSHOT_INVALID");
  if (
    project.createdIn !== "@subject" ||
    project.activity?.mode !== "console" ||
    project.activity?.conversation !== "@subject" ||
    project.files?.length ||
    project.protectedSocialSources?.length ||
    project.protectedOperations ||
    project.protectedRepositories?.length ||
    project.protectedPeerQzoneTargets?.length ||
    project.protectionUnknown
  )
    throw Error("HOME_SOURCE_DENIED");
  let entry;
  try {
    entry = activityVersion(memory, source.id, source.revision);
  } catch {
    throw Error("HOME_SNAPSHOT_INVALID");
  }
  if (
    entry.homeSnapshotProvenance?.version !== 1 ||
    entry.homeSnapshotProvenance.ownerAgentId !== ctx.agentId ||
    entry.draftAuthor !== "agent" ||
    !entry.draft ||
    entry.activity?.draftRevision !== source.revision ||
    entry.activity?.mode !== "console" ||
    entry.activity?.conversation !== "@subject"
  )
    throw Error("HOME_SOURCE_DENIED");
  // Recheck the source turn's proof and current source history; legacy or contributed drafts stay denied.
  const rows = memory.db
    .prepare(
      "SELECT value FROM activity_history WHERE agent_id=? AND project_id=?",
    )
    .all(ctx.agentId, source.id);
  if (rows.length > 500) throw Error("HOME_SOURCE_DENIED");
  for (const row of rows) {
    const prior = JSON.parse(row.value);
    if (
      prior.author === "administrator" &&
      prior.action === "join" &&
      !prior.draft &&
      prior.previousProject?.homeSnapshotProvenance?.version === 1
    )
      continue;
    if (prior.homeSnapshotProvenance?.version !== 1)
      throw Error("HOME_SOURCE_DENIED");
  }
  rooms.shareable({
    ...ctx,
    privateRead: new Set([
      ...ctx.privateRead,
      ...(entry.homeSnapshotProvenance.evidence || []),
      ...(project.steps || []).flatMap(
        (/** @type {any} */ step) => step.evidence || [],
      ),
      ...rows.flatMap(
        (/** @type {any} */ row) =>
          JSON.parse(row.value).homeSnapshotProvenance?.evidence || [],
      ),
    ]),
  });
  const title = entry.draft.title,
    body = entry.draft.text;
  if (
    typeof title !== "string" ||
    !title.trim() ||
    title.length > 80 ||
    typeof body !== "string" ||
    !body.trim() ||
    body.length > 6000
  )
    throw Error("HOME_SNAPSHOT_INVALID");
  rooms.runtime.assertSafeOutput(ctx, JSON.stringify({ title, body }));
  return {
    title,
    body,
    source: { type: "project-draft", id: source.id, revision: source.revision },
  };
}
