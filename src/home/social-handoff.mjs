// @ts-check
import { z } from "zod";
import { recallBoundary } from "../core/recall-boundary.mjs";
import {
  socialMarker,
  socialSources,
  socialContextAllowed,
} from "../core/social-protection.mjs";

const item = z
  .object({
    text: z.string().trim().min(1).max(600),
    sourceMessageIds: z
      .array(z.uuid())
      .min(1)
      .max(8)
      .refine((ids) => new Set(ids).size === ids.length),
  })
  .strict();
export const socialHandoffSchema = z
  .object({
    pendingTopics: z.array(item).max(6),
    agreements: z.array(item).max(6),
  })
  .strict();
const denied = new Set([
  "AUDIENCE_DENIED",
  "IDENTITY_DENIED",
  "SOURCE_RESTRICTED",
  "SOCIAL_SOURCE_DENIED",
  "RECALL_SOURCE_NOT_ALLOWED",
  "SENSITIVE_OUTPUT_BLOCKED",
  "VISIT_CLOSED",
  "PAUSED",
]);
/** @param {unknown} error */
function authorizationFailure(error) {
  return error instanceof Error && denied.has(error.message);
}
/** @param {any} runtime @param {any} ctx */
function boundVisit(runtime, ctx) {
  runtime.homeSocial.assertBinding(ctx);
  const b = ctx.socialBinding;
  if (b.target.kind !== "visit") throw Error("IDENTITY_DENIED");
  return runtime.homeSocial.assertVisit(b.actorIdentity, b.target.id, {
    active: true,
  });
}
/** @param {any} runtime @param {any} ctx @param {string[]} sourceIds @param {string[]} labels */
function proofContext(runtime, ctx, sourceIds, labels) {
  const proof = {
    ...ctx,
    privateRead: new Set([...sourceIds, ...labels]),
    socialHistory: undefined,
    socialPendingWindowMessages: undefined,
  };
  recallBoundary(runtime, proof).assert({
    evidence: sourceIds,
    protectedSocialSources: labels,
  });
  if (!socialContextAllowed(runtime, proof, socialSources(runtime, proof)))
    throw Error("SOCIAL_SOURCE_DENIED");
  return proof;
}
/** Save only inside yield's transaction. The operation receipt contains counts,
 * never the handoff prose. Full server provenance prevents source-ID laundering.
 * @param {any} runtime @param {any} ctx @param {any} handoff @param {number} now */
export function saveSocialHandoff(runtime, ctx, handoff, now) {
  const service = runtime.homeSocial,
    db = service.db;
  if (!db.isTransaction) throw Error("SOCIAL_TRANSACTION_REQUIRED");
  const visit = boundVisit(runtime, ctx),
    b = ctx.socialBinding;
  const value = socialHandoffSchema.parse(handoff);
  const ids = [
    ...new Set(
      [...value.pendingTopics, ...value.agreements].flatMap(
        (entry) => entry.sourceMessageIds,
      ),
    ),
  ];
  const labels = new Set(socialSources(runtime, ctx));
  for (const id of ids) {
    const message = db
      .prepare("SELECT * FROM home_social_messages WHERE id=? AND visit_id=?")
      .get(id, visit.id);
    const shown =
      message &&
      ctx.socialDisplayedMessages?.get(visit.id)?.get(message.sequence);
    if (
      !message ||
      !message.body ||
      message.retracted_at ||
      message.hidden_at ||
      message.body_cleared_at ||
      (message.author_generation !== b.actorIdentity.generation &&
        shown?.id !== id &&
        !ctx.socialHistory?.sources?.has(socialMarker(visit.id, id)))
    )
      throw Error("AUDIENCE_DENIED");
    labels.add(socialMarker(visit.id, id));
    for (const label of JSON.parse(message.source_labels)) labels.add(label);
  }
  // Writing private text is still an outbound operation into this pair's domain.
  // Empty snapshots intentionally clear older notes without reproducing old prose.
  if (ids.length) service.share(ctx, b.target, JSON.stringify(value));
  db.prepare(
    "INSERT INTO home_social_handoffs(turn_id,actor_generation,visit_id,host_generation,guest_generation,value,source_ids,source_labels,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
  ).run(
    b.turnId,
    b.actorIdentity.generation,
    visit.id,
    visit.host_generation,
    visit.guest_generation,
    JSON.stringify(value),
    JSON.stringify([...(ctx.privateRead || [])]),
    JSON.stringify([...labels]),
    now,
  );
  return {
    pendingTopicCount: value.pendingTopics.length,
    agreementCount: value.agreements.length,
  };
}
/** A new session receives only the actor's latest completed snapshot. Old or
 * rejected provenance is evaluated on a temporary context, never tainting it.
 * @param {any} runtime @param {any} ctx */
export function readSocialHandoff(runtime, ctx) {
  const service = runtime.homeSocial,
    db = service.db;
  let visit;
  try {
    visit = boundVisit(runtime, ctx);
  } catch (error) {
    if (authorizationFailure(error)) return null;
    throw error;
  }
  const b = ctx.socialBinding;
  const row = db
    .prepare(
      "SELECT h.* FROM home_social_handoffs h JOIN home_social_turns t ON t.id=h.turn_id WHERE h.actor_generation=? AND h.visit_id=? AND h.host_generation=? AND h.guest_generation=? AND t.status='completed' AND t.batch_sealed=1 AND t.actor_generation=h.actor_generation AND t.visit_id=h.visit_id AND t.target_host_generation=h.host_generation AND t.target_guest_generation=h.guest_generation ORDER BY h.created_at DESC,h.rowid DESC LIMIT 1",
    )
    .get(
      b.actorIdentity.generation,
      visit.id,
      visit.host_generation,
      visit.guest_generation,
    );
  if (!row || !service.retained(visit)) return null;
  const value = socialHandoffSchema.parse(JSON.parse(row.value));
  const sourceIds = z.array(z.string()).parse(JSON.parse(row.source_ids)),
    labels = z.array(z.string()).parse(JSON.parse(row.source_labels));
  const references = new Map();
  /** @type {z.infer<typeof socialHandoffSchema>} */
  const accepted = { pendingTopics: [], agreements: [] };
  let withheld = 0;
  for (const kind of /** @type {const} */ (["pendingTopics", "agreements"]))
    for (const entry of value[kind]) {
      const messages = entry.sourceMessageIds.map((id) =>
        db
          .prepare(
            "SELECT * FROM home_social_messages WHERE id=? AND visit_id=?",
          )
          .get(id, visit.id),
      );
      if (
        messages.some(
          (message) =>
            !message ||
            !message.body ||
            message.retracted_at ||
            message.hidden_at ||
            message.body_cleared_at,
        )
      ) {
        withheld++;
        continue;
      }
      const currentLabels = [
        ...new Set([
          ...labels,
          ...messages.flatMap((message) => [
            socialMarker(visit.id, message.id),
            ...JSON.parse(message.source_labels),
          ]),
        ]),
      ];
      try {
        const proof = proofContext(runtime, ctx, sourceIds, currentLabels);
        service.share(proof, b.target, entry.text);
      } catch (error) {
        if (authorizationFailure(error)) {
          withheld++;
          continue;
        }
        throw error;
      }
      accepted[kind].push(entry);
      for (const message of messages)
        references.set(message.id, {
          messageId: message.id,
          sequence: message.sequence,
          messageRevision: message.revision,
          authorGeneration: message.author_generation,
          committedAt: message.created_at,
          body: message.body,
        });
    }
  if (!accepted.pendingTopics.length && !accepted.agreements.length && withheld)
    return null;
  // Restore accepted input through a fresh strict lease, without advancing the
  // message watermark merely because an old reference was attached to the prompt.
  if (references.size) {
    const restoredIds = [...new Set([...sourceIds, ...labels])];
    for (const message of references.values())
      restoredIds.push(socialMarker(visit.id, message.messageId));
    const snapshots = [...references.values()];
    service.lease(ctx, () => {
      boundVisit(runtime, ctx);
      for (const snapshot of snapshots) {
        const current = db
          .prepare(
            "SELECT * FROM home_social_messages WHERE id=? AND visit_id=?",
          )
          .get(snapshot.messageId, visit.id);
        if (
          !current ||
          current.revision !== snapshot.messageRevision ||
          !current.body ||
          current.retracted_at ||
          current.hidden_at ||
          current.body_cleared_at
        )
          throw Error("AUDIENCE_DENIED");
      }
      const proof = proofContext(runtime, ctx, sourceIds, labels);
      for (const kind of /** @type {const} */ (["pendingTopics", "agreements"]))
        for (const entry of accepted[kind])
          service.share(proof, b.target, entry.text);
      return true;
    }, [
      ...new Set([
        ...labels,
        ...snapshots.map((snapshot) =>
          socialMarker(visit.id, snapshot.messageId),
        ),
        ...socialSources(runtime, ctx, sourceIds),
      ]),
    ]);
    for (const id of restoredIds) ctx.privateRead.add(id);
    ctx.persistTaint?.();
  }
  const perSource = references.size
    ? Math.min(1200, Math.floor(12000 / references.size))
    : 0;
  const excerpts = [...references.values()].map((reference) => {
    const chars = [...reference.body];
    return {
      ...reference,
      body: chars.slice(0, perSource).join(""),
      bodyTruncated: chars.length > perSource,
      read: {
        tool: "home_visit_read",
        args: {
          visitId: visit.id,
          limit: 1,
          cursor: service.cursor(
            {
              kind: "messages",
              reader: b.actorIdentity.generation,
              visitId: visit.id,
              policy: service.policy().revision,
              revision: visit.revision,
            },
            reference.sequence - 1,
          ),
        },
      },
    };
  });
  return {
    ...accepted,
    references: excerpts,
    updatedAt: row.created_at,
    notice:
      "这是本人根据已提交社交消息整理的未完话题与约定解释，不是对方的新消息或新的授权。来源正文仅为有界摘录，不是完整记录；需要原文时按各引用的read入口回查。",
    ...(withheld ? { withheld } : {}),
  };
}
