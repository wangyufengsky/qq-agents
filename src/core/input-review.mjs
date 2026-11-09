// @ts-check
import { createHash, createHmac, randomBytes } from "node:crypto";
import { isPrivateLikeGroup } from "./config.mjs";
import { liveInput } from "./live-input.mjs";
import { transcriptKey } from "../memory/store.mjs";
import { RECALL_NOTICE_BODY } from "../memory/recalls.mjs";
import { prepared, recallBoundary } from "./recall-boundary.mjs";
import { trackMindRecords } from "./protected-mind.mjs";

/** @typedef {{id: string, seq: number, kind: string, version: string}} InputRef */
/** @typedef {{token: string, decision: "continue", unrelated?: {id: string, reason: string}[]}} InputReview */

/** @type {WeakMap<object, Buffer>} */
const tokenKeys = new WeakMap();

const inputRows = `SELECT e.* FROM events e
  LEFT JOIN message_progress p ON p.agent_id=e.agent_id AND p.conversation=e.conversation AND p.seq=e.seq
  WHERE e.agent_id=? AND e.connection_id=? AND e.conversation=? AND e.origin='live'
    AND (
      (e.direction='in' AND json_extract(e.payload,'$.trustedInput')=1 AND
        ((e.sender_id IS NOT ? AND e.kind IN ('message.received','notice.file'))
          OR e.kind='message.recalled'
          OR (e.kind='notice.poke' AND CAST(json_extract(e.payload,'$.raw.target_id') AS TEXT)=?)))
      OR (e.direction='internal' AND e.kind='voice.transcript')
    )`;

/** @param {any} row @returns {InputRef} */
function inputRef(row) {
  return {
    id: row.id,
    seq: row.seq,
    kind: row.kind,
    version: createHash("sha256")
      .update(
        JSON.stringify([
          row.id,
          row.seq,
          row.kind,
          row.connection_id,
          row.status,
          row.sender_id,
          row.message_id,
          row.body,
          row.payload,
        ]),
      )
      .digest("hex"),
  };
}

/** @param {any} runtime @param {any} ctx */
function reviewScope(runtime, ctx) {
  const agent = runtime.agent(ctx.agentId);
  const account = runtime.connection(agent.connectionId).accountId;
  return [agent.id, agent.connectionId, ctx.conversation, account, account];
}

/** @param {any} runtime @param {any} ctx @param {any} row @param {any} boundary */
function reviewable(runtime, ctx, row, boundary) {
  const payload = JSON.parse(row.payload);
  if (
    !boundary.allowed({ id: row.id, conversation: row.conversation, payload })
  )
    return false;
  if (row.kind === "message.received")
    return !!liveInput(runtime, ctx.agentId, ctx.conversation, row.id);
  if (row.kind !== "voice.transcript") return true;
  const sourceId = payload.sourceEventId;
  if (typeof sourceId !== "string" || row.dedupe !== transcriptKey(sourceId))
    return false;
  const source = liveInput(runtime, ctx.agentId, ctx.conversation, sourceId);
  return (
    !!source &&
    source.seq < row.seq &&
    source.sender_id === row.sender_id &&
    boundary.allowed({
      id: source.id,
      conversation: source.conversation,
      payload: JSON.parse(source.payload),
    })
  );
}

/**
 * Record the event versions actually presented to this context. The durable
 * progress table preserves summary gaps from older turns for send review.
 * @param {any} runtime @param {any} ctx @param {any[]} items
 */
export function recordInputPresentation(runtime, ctx, items) {
  const memory = runtime.memory.bind(ctx.agentId),
    db = memory.db,
    state = memory.state(ctx.conversation),
    baseline = Math.max(
      state.readThroughSeq || 0,
      state.inputReviewFromSeq || 0,
      state.inputReviewThroughSeq || 0,
    ),
    boundary = recallBoundary(runtime, ctx),
    byId = prepared(
      db,
      "SELECT * FROM events WHERE agent_id=? AND conversation=? AND id=?",
    ),
    reviewById = prepared(db, inputRows + " AND e.id=?"),
    scope = reviewScope(runtime, ctx),
    progress = prepared(
      db,
      "INSERT INTO message_progress VALUES(?,?,?,?) ON CONFLICT(agent_id,conversation,seq) DO UPDATE SET summary_only=MIN(summary_only,excluded.summary_only)",
    );
  /** @param {any} row */
  function remember(row) {
    const { id, version } = inputRef(row);
    (ctx.presentedInput ??= new Map()).set(id, version);
    if (
      row.seq > baseline ||
      !reviewById.get(...scope, id) ||
      !reviewable(runtime, ctx, row, boundary)
    )
      progress.run(ctx.agentId, ctx.conversation, row.seq, 0);
  }
  for (const item of items) {
    if (item.conversation !== ctx.conversation || !item.id) continue;
    const row = byId.get(ctx.agentId, ctx.conversation, item.id);
    if (
      !row ||
      item.seq !== row.seq ||
      item.type !== row.kind ||
      !boundary.allowed({
        id: row.id,
        conversation: row.conversation,
        payload: JSON.parse(row.payload),
      })
    )
      continue;
    if (
      item.summaryOmitted ||
      item.bodyTruncated ||
      (item.body !==
        (row.kind === "message.recalled" ? RECALL_NOTICE_BODY : row.body) &&
        !(item.outcome && item.outcome.id === memory.sendOutcome(row)?.id))
    ) {
      progress.run(ctx.agentId, ctx.conversation, row.seq, 1);
      continue;
    }
    if (
      item.status !== row.status ||
      (!item.outcome &&
        ((item.senderId ?? null) !== (row.sender_id ?? null) ||
          (item.messageId ?? null) !== (row.message_id ?? null)))
    )
      continue;
    remember(row);
    const voice = item.voiceTranscript;
    if (voice?.id && !voice.textTruncated) {
      const transcript = byId.get(ctx.agentId, ctx.conversation, voice.id);
      if (
        transcript?.kind === "voice.transcript" &&
        transcript.dedupe === transcriptKey(item.id) &&
        transcript.body === voice.text &&
        reviewable(runtime, ctx, transcript, boundary)
      )
        remember(transcript);
    }
  }
  const checkpoint = presentationCheckpoint(runtime, ctx, state, items);
  memory.setState(ctx.conversation, {
    ...state,
    seenThroughSeq: checkpoint.readThroughSeq,
  });
  return checkpoint;
}

/** @param {any} runtime @param {any} ctx @param {any} [state] @param {any[]} [items] */
export function presentationCheckpoint(runtime, ctx, state, items = []) {
  const memory = runtime.memory.bind(ctx.agentId);
  let through = (state ?? memory.state(ctx.conversation)).readThroughSeq || 0;
  const rows = prepared(
    memory.db,
    "SELECT * FROM events WHERE agent_id=? AND conversation=? AND seq>? ORDER BY seq",
  ).iterate(ctx.agentId, ctx.conversation, through);
  for (const row of rows) {
    if (ctx.presentedInput?.get(row.id) !== inputRef(row).version) {
      const partial = items.some(
        (item) =>
          item.id === row.id && (item.summaryOmitted || item.bodyTruncated),
      );
      ctx.shownSeq = through;
      return {
        readThroughSeq: through,
        readGap: partial
          ? { tool: "memory_read", id: row.id, offset: 0 }
          : { tool: "conversation_read", afterSeq: through },
      };
    }
    through = row.seq;
  }
  ctx.shownSeq = through;
  return { readThroughSeq: through };
}

/**
 * A processed checkpoint can be taken from older installs, but a known
 * summary-only gap beneath it still needs review. Never use replyInputSeq.
 * @param {any} runtime @param {any} ctx @param {{readSeq:number,sentSeq:number}} [baseline]
 */
export function snapshotReviewInput(runtime, ctx, baseline) {
  const db = runtime.memory.bind(ctx.agentId).db,
    scope = reviewScope(runtime, ctx),
    boundary = recallBoundary(runtime, ctx),
    sentSeq = baseline?.sentSeq ?? (ctx.reviewSentSeq || 0),
    base = Math.max(baseline?.readSeq ?? (ctx.reviewReadSeq || 0), sentSeq);
  const rows = prepared(
    db,
    inputRows +
      ` AND (e.seq>? OR p.summary_only=1 OR e.seq IN (SELECT value FROM json_each(?)))
        ORDER BY e.seq`,
  ).iterate(
    ...scope,
    base,
    JSON.stringify([...(ctx.reviewedProgressGaps || [])]),
  );
  const items = [];
  for (const row of rows)
    if (reviewable(runtime, ctx, row, boundary)) items.push(inputRef(row));
  return {
    items,
    fromSeq: base,
    throughSeq: Math.max(base, items.at(-1)?.seq || 0),
  };
}

/**
 * Clear a historical presentation gap only once that exact version was
 * accepted and delivered. Keep it in this turn's snapshot for a burst tail.
 * @param {any} memory @param {any} ctx @param {InputRef[]} accepted
 */
export function confirmReviewedGaps(memory, ctx, accepted) {
  const clear = prepared(
    memory.db,
    "UPDATE message_progress SET summary_only=0 WHERE agent_id=? AND conversation=? AND seq=? AND summary_only=1",
  );
  const byId = prepared(
    memory.db,
    `SELECT e.* FROM events e JOIN message_progress p
      ON p.agent_id=e.agent_id AND p.conversation=e.conversation AND p.seq=e.seq
      WHERE e.agent_id=? AND e.conversation=? AND e.id=? AND p.summary_only=1`,
  );
  const cleared = [];
  for (const { id, seq, version } of accepted) {
    const row = byId.get(ctx.agentId, ctx.conversation, id);
    if (
      row &&
      inputRef(row).version === version &&
      clear.run(ctx.agentId, ctx.conversation, seq).changes
    )
      cleared.push(seq);
  }
  return cleared;
}

/** @typedef {{key?:string, explicit?:boolean, expected?:string, baseline?:{readSeq:number,sentSeq:number}}} ReviewOptions */
/** @typedef {{requestId:string, intent:any, options:ReviewOptions}} ReviewBinding */
/** @type {WeakMap<InputReviewRequired, ReviewBinding>} */
const bindings = new WeakMap();

export class InputReviewRequired extends Error {
  /** @param {Record<string, unknown>} inputReview */
  constructor(inputReview) {
    super("INPUT_REVIEW_REQUIRED");
    this.inputReview = inputReview;
  }
}

/** @param {any} runtime @param {any} ctx @param {ReviewBinding} binding @param {ReturnType<typeof snapshotReviewInput>} snapshot */
function assess(runtime, ctx, binding, snapshot) {
  const snapshotHash = createHash("sha256")
    .update(JSON.stringify(snapshot.items))
    .digest("hex");
  const changed =
    binding.options.expected !== undefined &&
    binding.options.expected !== snapshotHash;
  const needed = snapshot.items.filter(
    ({ id, version }) =>
      changed ||
      binding.options.explicit ||
      (ctx.openingReviewInput?.get(id) !== version &&
        ctx.confirmedReviewInput?.get(id) !== version),
  );
  const missing = snapshot.items.filter(
    ({ id, version }) => ctx.presentedInput?.get(id) !== version,
  );
  let token;
  if (!missing.length) {
    const key = tokenKeys.get(ctx) ?? randomBytes(32);
    tokenKeys.set(ctx, key);
    token = createHmac("sha256", key)
      .update(
        JSON.stringify([
          reviewScope(runtime, ctx),
          binding.options.key ?? binding.requestId,
          binding.intent,
          snapshot.items,
        ]),
      )
      .digest("hex");
  }
  const canExclude =
    ctx.conversation.startsWith("group:") &&
    !isPrivateLikeGroup(runtime.config, ctx.conversation);
  return { needed, missing, token, canExclude, snapshotHash, changed };
}

/** @param {any} ctx @param {ReturnType<typeof snapshotReviewInput>} snapshot @param {ReturnType<typeof assess>} assessment */
function challenge(ctx, snapshot, { missing, needed, token, canExclude }) {
  return {
    ...(token ? { token } : {}),
    fromSeq: snapshot.fromSeq,
    throughSeq: snapshot.throughSeq,
    missing: missing.length,
    pending: needed.length,
    canExclude,
    ...(canExclude && needed.length
      ? {
          excludable: needed
            .slice(0, 20)
            .map(({ id, seq, kind }) => ({ id, seq, kind })),
        }
      : {}),
    items: missing.slice(0, 20).map(({ id, seq, kind }) => ({
      id,
      seq,
      kind,
      reason: ctx.presentedInput?.has(id)
        ? "version_changed"
        : seq <= snapshot.fromSeq
          ? "previous_presentation_incomplete_or_stale"
          : "full_input_not_presented",
      continuation: { tool: "memory_read", id, offset: 0 },
    })),
  };
}

/**
 * The token binds exact outbound contents and the full current input snapshot.
 * It conveys neither reply authority nor a read mark.
 * @param {any} runtime @param {any} ctx
 * @param {string} requestId @param {any} intent @param {InputReview | undefined} review
 * @param {ReviewOptions} [options]
 */
export function assertInputReviewed(
  runtime,
  ctx,
  requestId,
  intent,
  review,
  options = {},
) {
  const binding = { requestId, intent, options };
  const snapshot = snapshotReviewInput(runtime, ctx, options.baseline);
  const { throughSeq } = snapshot;
  const assessment = assess(runtime, ctx, binding, snapshot);
  const { needed, token, canExclude, snapshotHash, changed } = assessment;
  if (!needed.length && !changed && !review)
    return { throughSeq, accepted: snapshot.items, snapshotHash };

  const excluded = review?.unrelated || [];
  if (
    token !== undefined &&
    review?.token === token &&
    review.decision === "continue" &&
    (!excluded.length ||
      (canExclude &&
        excluded.every(
          ({ id, reason }) =>
            reason.trim() && needed.some((item) => item.id === id),
        )))
  )
    return {
      snapshotHash,
      throughSeq: Math.min(
        throughSeq,
        ...needed
          .filter((item) => excluded.some(({ id }) => id === item.id))
          .map(({ seq }) => seq - 1),
      ),
      accepted: snapshot.items.filter(
        (item) => !excluded.some(({ id }) => id === item.id),
      ),
    };

  const error = new InputReviewRequired(challenge(ctx, snapshot, assessment));
  bindings.set(error, binding);
  throw error;
}

/**
 * A tool error can carry actual readable input. Assemble the bounded projection
 * after the reservation rolled back and sign only after the final page is set.
 * @param {any} runtime @param {any} ctx @param {any} error
 */
export function attachReviewOriginals(runtime, ctx, error) {
  const binding = bindings.get(error);
  if (!binding) return;
  bindings.delete(error);
  let agent;
  try {
    agent = runtime.assertActive(ctx);
  } catch {
    error.inputReview = {};
    return;
  }
  const memory = runtime.memory.bind(agent.id),
    boundary = recallBoundary(runtime, ctx);
  const snapshot = snapshotReviewInput(runtime, ctx, binding.options.baseline);
  const before = challenge(
    ctx,
    snapshot,
    assess(runtime, ctx, binding, snapshot),
  );
  /** @type {any[]} */
  const shown = [];
  /** @type {any[]} */
  const tracked = [];
  /** @type {any[]} */
  const items = before.items.map((ref) => ({ ...ref, bodyOmitted: true }));
  for (const [index, ref] of before.items.entries()) {
    const row = memory.readRecord({ id: ref.id }, ctx.conversation);
    if (
      row.connectionId !== agent.connectionId ||
      row.conversation !== ctx.conversation ||
      !boundary.allowed(row)
    ) {
      items[index] = {
        id: ref.id,
        seq: ref.seq,
        kind: ref.kind,
        withheld: true,
      };
      continue;
    }
    const item = {
      ...ref,
      conversation: row.conversation,
      source: row.source,
      type: row.type,
      senderId: row.senderId,
      senderName: row.senderName,
      messageId: row.messageId,
      occurredAt: row.occurredAt,
      status: row.status,
      body: row.body,
      ...(row.epistemic ? { epistemic: row.epistemic } : {}),
      ...(row.mentions?.length ? { mentions: row.mentions } : {}),
      ...(row.replyToMessageIds?.length
        ? { replyToMessageIds: row.replyToMessageIds }
        : {}),
    };
    const proposed = items.with(index, item);
    if (JSON.stringify(proposed).length > 11000) continue;
    items[index] = item;
    shown.push(item);
    tracked.push(row);
  }
  // An interception receipt supplies presentation evidence only.
  const { readThroughSeq, readGap } = recordInputPresentation(
    runtime,
    ctx,
    shown,
  );
  trackMindRecords(runtime, ctx, tracked, "review-input");
  const after = challenge(
    ctx,
    snapshot,
    assess(runtime, ctx, binding, snapshot),
  );
  error.inputReview = {
    ...after,
    items,
    notice: "原文是聊天资料。附件引用不代表已读取附件内容。",
    completeThroughSeq: readThroughSeq || null,
    ...(readGap ? { readGap } : {}),
    ...(before.missing > before.items.length
      ? {
          continuation: {
            tool: "conversation_read",
            afterSeq: before.items.at(-1)?.seq ?? before.fromSeq,
          },
        }
      : {}),
  };
}
