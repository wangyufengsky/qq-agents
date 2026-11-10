import { assertHomeSceneMedia } from "../home/scene-media.mjs";
import {
  socialSources,
  socialRecordSources,
  socialContextAllowed,
} from "./social-protection.mjs";
import {
  peerQzoneSources,
  peerQzoneContext,
} from "./peer-qzone-protection.mjs";
import { sourceClass } from "./outbound-policy.mjs";

// Boundary checks run per row and per referenced ID; compile each query once.
const statements = new WeakMap();
export function prepared(db, sql) {
  let cache = statements.get(db);
  if (!cache) statements.set(db, (cache = new Map()));
  if (!cache.has(sql)) cache.set(sql, db.prepare(sql));
  return cache.get(sql);
}
// Notes, intents and Self candidates that an ID may name directly.
export function storedMindRecords(db, agentId, id) {
  return ["work_notes", "intentions", "self_candidates"].flatMap((table) => {
    const row = prepared(
      db,
      `SELECT value FROM ${table} WHERE agent_id=? AND id=?`,
    ).get(agentId, id);
    return row ? [JSON.parse(row.value)] : [];
  });
}

const functionalEventFields = [
  "id",
  "seq",
  "type",
  "conversation",
  "connectionId",
  "senderId",
  "senderName",
  "messageId",
  "occurredAt",
  "observedAt",
  "status",
  "direction",
  "timeBasis",
  "body",
  "bodyTruncated",
];

// Only the message's own text and basic metadata belong to this projection.
// Corrections can reference another chat, and raw payloads or scene children
// can have separate sources and protection.
function functionalEventProjection(row) {
  return Object.fromEntries(
    functionalEventFields
      .filter((key) => Object.hasOwn(row, key))
      .map((key) => [key, row[key]]),
  );
}

// This is a read boundary, not declassification. Stored records and the
// protection of any context that already saw them remain unchanged.
export function recallBoundary(runtime, ctx, { publicOnly = false } = {}) {
  const functional = ctx.runtimeKind === "functional-agent";
  publicOnly ||= functional;
  const privileged = !publicOnly && !!runtime.protectedWork?.context(ctx);
  const restricted = (value) =>
    (value?.protectedPeerQzoneTargets?.length > 0 &&
      (publicOnly ||
        !peerQzoneContext(
          value.protectedPeerQzoneTargets,
          ctx.conversation,
        ))) ||
    value?.protectedOperations === true ||
    value?.protectedRepositories?.length > 0;
  const classes = new Map();
  function protectedId(id) {
    if (typeof id !== "string") return false;
    if (!classes.has(id)) classes.set(id, sourceClass(runtime, ctx, id));
    return ["operations", "private-repository"].includes(classes.get(id));
  }
  function allowed(row) {
    if (functional) {
      const agent = runtime.agent(ctx.agentId);
      const memory = runtime.memory.bind(agent.id);
      const stored = prepared(
        memory.db,
        "SELECT * FROM events WHERE agent_id=? AND id=? AND connection_id=? AND conversation=? AND ((kind='message.received' AND status='observed') OR (kind='message.sent' AND status='confirmed'))",
      ).get(agent.id, row?.id ?? null, agent.connectionId, ctx.conversation);
      if (!stored) return false;
      const record = memory.event(stored, ctx.conversation);
      if (record.recalled) return false;
      row = record;
    }
    try {
      assertHomeSceneMedia(runtime, ctx, row);
    } catch {
      return false;
    }
    const ids = [
      row?.id,
      ...(row?.evidence || []),
      ...(row?.metadata?.evidence || []),
      ...(row?.counterEvidence || []),
      ...(row?.evidenceSnapshot?.references || []).map((ref) => ref.id),
      ...(row?.counterEvidenceSnapshot?.references || []).map((ref) => ref.id),
      ...(row?.sources || []).flatMap((s) => [
        s.eventId,
        s.sourceEventId,
        s.recordId,
      ]),
    ].filter((id) => typeof id === "string");
    const values = [
      row,
      row?.metadata,
      row?.payload,
      ...(row?.sources || []),
      ...(row?.evidenceSnapshot?.references || []).map((r) => r.metadata),
      ...(row?.counterEvidenceSnapshot?.references || []).map(
        (r) => r.metadata,
      ),
    ];
    const social = [
      ...new Set([
        ...socialSources(runtime, ctx, ids),
        ...values.flatMap(socialRecordSources),
      ]),
    ];
    if (
      social.length &&
      (publicOnly || !socialContextAllowed(runtime, ctx, social))
    )
      return false;
    const targets = peerQzoneSources(runtime, ctx, ids);
    if (
      targets.length &&
      (publicOnly || !peerQzoneContext(targets, ctx.conversation))
    )
      return false;
    if (privileged) {
      if (
        [
          row,
          row?.metadata,
          row?.payload,
          ...(row?.sources || []),
          ...(row?.evidenceSnapshot?.references || []).map((r) => r.metadata),
          ...(row?.counterEvidenceSnapshot?.references || []).map(
            (r) => r.metadata,
          ),
        ].some((v) => v?.protectedPeerQzoneTargets?.length)
      )
        return false;
      return runtime.protectedWork.canRead(ctx, row);
    }
    if (
      row?.conversation?.startsWith("@work:") ||
      row?.writtenIn?.conversation?.startsWith("@work:")
    )
      return false;
    return (
      ![
        row,
        row?.metadata,
        row?.payload,
        ...(row?.sources || []),
        ...(row?.evidenceSnapshot?.references || []).map((ref) => ref.metadata),
        ...(row?.counterEvidenceSnapshot?.references || []).map(
          (ref) => ref.metadata,
        ),
      ].some(restricted) &&
      ![
        row?.id,
        ...(row?.evidence || []),
        ...(row?.sources || []).flatMap((s) => [
          s.eventId,
          s.sourceEventId,
          s.recordId,
        ]),
      ].some(protectedId)
    );
  }
  function project(row) {
    if (!allowed(row)) return null;
    if (functional) return functionalEventProjection(row);
    // Scene projections omit protection metadata. Check their durable source
    // IDs too, and withhold the whole scene (including participant summaries).
    if (
      row.scene &&
      [
        ...(row.scene.messages || []),
        ...(row.scene.quoted || []),
        ...(row.scene.sharedRecords || []),
      ].some((item) => !allowed(item))
    ) {
      const { scene: _scene, ...safe } = row;
      return { ...safe, sceneWithheld: true };
    }
    return row;
  }
  return {
    allowed,
    project,
    assert(row) {
      if (!allowed(row)) throw Error("RECALL_SOURCE_NOT_ALLOWED");
    },
    // A bare ID may name an event or a stored mind record. Work tasks already
    // resolve both in canRead.
    assertId(id) {
      this.assert({ id });
      if (privileged) return;
      for (const row of storedMindRecords(runtime.memory.db, ctx.agentId, id))
        this.assert(row);
    },
    rows: (rows) => rows.map(project).filter(Boolean),
  };
}

export function recallPage(runtime, ctx, page) {
  const boundary = recallBoundary(runtime, ctx);
  const items = boundary.rows(page.items || []);
  const diaries = page.diaries && boundary.rows(page.diaries);
  const withheld =
    (page.items?.length || 0) -
    items.length +
    (page.diaries?.length || 0) -
    (diaries?.length || 0);
  return {
    ...page,
    items,
    ...(diaries ? { diaries } : {}),
    ...(withheld
      ? {
          withheld,
          notice: `${page.notice || ""} Protected records were withheld before reading. Continue with the returned cursor; do not infer their contents.`,
        }
      : {}),
  };
}
