// @ts-check
import { socialSources, trackSocial } from "./social-protection.mjs";
import { peerQzoneSources, trackPeerQzone } from "./peer-qzone-protection.mjs";
import { githubMarker, privateGithubSources } from "../github/policy.mjs";
import { sourceClass } from "./outbound-policy.mjs";
import { recallBoundary } from "./recall-boundary.mjs";

// Protection from the entire context, not only model-selected evidence IDs.
/** @param {any} runtime @param {any} ctx */
export function contextProtection(runtime, ctx) {
  return {
    protectedSocialSources: socialSources(runtime, ctx),
    protectedPeerQzoneTargets: peerQzoneSources(runtime, ctx),
    protectedRepositories: privateGithubSources(ctx, runtime),
    protectedOperations: [...ctx.privateRead].some(
      (/** @type {string} */ id) =>
        sourceClass(runtime, ctx, id) === "operations",
    ),
  };
}
/** @param {any} runtime @param {any} ctx @param {any[]} notes */
export function trackMindRecords(runtime, ctx, notes, kind = "work-note") {
  // Every model-facing record return and implicit handoff restores durable
  // markers; deleting an original source cannot erase read protection.
  for (const note of notes || []) {
    if (!note || typeof note !== "object") continue;
    if (note.id) ctx.privateRead.add(note.id);
    trackPeerQzone(ctx, note);
    trackSocial(ctx, note);
    if (ctx.runtimeKind === "subject-social")
      for (const scope of [
        note.conversation,
        note.writtenIn?.conversation,
        typeof note.writtenIn === "string" ? note.writtenIn : null,
        note.createdIn?.conversation,
        typeof note.createdIn === "string" ? note.createdIn : null,
      ]) {
        if (typeof scope !== "string") continue;
        if (/^(private|group):/.test(scope))
          ctx.privateRead.add("context:" + scope);
        if (scope.startsWith("@work:"))
          ctx.privateRead.add("operations:" + scope);
      }
    for (const id of [
      ...(note.evidence || []),
      ...(note.counterEvidence || []),
      ...(note.metadata?.evidence || []),
      ...(note.evidenceSnapshot?.entryIds || []),
      ...(note.counterEvidenceSnapshot?.entryIds || []),
      ...(note.evidenceSnapshot?.references || []).map(
        (/** @type {any} */ r) => r.id,
      ),
      ...(note.counterEvidenceSnapshot?.references || []).map(
        (/** @type {any} */ r) => r.id,
      ),
      ...(note.sources || []).flatMap((/** @type {any} */ s) => [
        s.eventId,
        s.sourceEventId,
        s.recordId,
      ]),
      note.eventId,
      note.sourceEventId,
      note.recordId,
    ].filter((/** @type {any} */ id) => typeof id === "string"))
      ctx.privateRead.add(id);
    for (const reference of [
      ...(note.evidenceSnapshot?.references || []),
      ...(note.counterEvidenceSnapshot?.references || []),
    ]) {
      trackPeerQzone(ctx, reference.metadata);
      trackSocial(ctx, reference.metadata);
      for (const repo of reference.metadata?.protectedRepositories || [])
        ctx.privateRead.add(githubMarker(repo));
      if (reference.metadata?.protectedOperations)
        ctx.privateRead.add(
          "operations:" + kind + ":" + (reference.id || "frozen"),
        );
    }
    for (const repo of note.protectedRepositories || [])
      ctx.privateRead.add(githubMarker(repo));
    if (
      note.protectedOperations ||
      (note.evidence || []).some(
        (/** @type {string} */ id) =>
          sourceClass(runtime, ctx, id) === "operations",
      )
    )
      ctx.privateRead.add("operations:" + kind + ":" + (note.id || kind));
  }
  for (const repo of privateGithubSources(ctx, runtime))
    ctx.privateRead.add(githubMarker(repo));
  ctx.persistTaint?.();
}

/** Every actual returned memory shape is traversed, including nested card/item
 * history and mood recent arrays. Container IDs are not provenance IDs.
 * @param {any} runtime @param {any} ctx @param {any} result */
export function trackSocialMindOutput(runtime, ctx, result) {
  if (ctx.runtimeKind !== "subject-social") return;
  const pending = [result],
    seen = new Set(),
    records = [];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (seen.size > 1000) {
      ctx.socialSendingClosed = true;
      throw Error("SOCIAL_SOURCE_DENIED");
    }
    if (!Array.isArray(value)) records.push({ ...value, id: undefined });
    pending.push(
      ...Object.values(value).filter((v) => v && typeof v === "object"),
    );
  }
  trackMindRecords(runtime, ctx, records, "social-input");
  for (const value of records)
    try {
      recallBoundary(runtime, ctx).assert(value);
    } catch {
      ctx.socialSendingClosed = true;
      throw Error("SOCIAL_SOURCE_DENIED");
    }
}
