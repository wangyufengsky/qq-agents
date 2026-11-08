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
          row.status,
          row.sender_id,
          row.message_id,
          row.body,
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
 * Track only complete material emitted by a current-chat read. Unlike the
 * reply authority and read watermark, this is per identity and version.
 * @param {any} runtime @param {any} ctx @param {any[]} items
 */
export function recordReviewPresentation(runtime, ctx, items) {
  if (!/^(group|private):/.test(ctx.conversation)) return;
  const db = runtime.memory.bind(ctx.agentId).db,
    scope = reviewScope(runtime, ctx),
    boundary = recallBoundary(runtime, ctx),
    byId = prepared(db, inputRows + " AND e.id=?");
  /** @param {any} row */
  function remember(row) {
    const { id, version } = inputRef(row);
    (ctx.presentedReviewInput ??= new Map()).set(id, version);
  }
  for (const item of items) {
    if (
      item.conversation !== ctx.conversation ||
      item.summaryOmitted ||
      item.bodyTruncated ||
      typeof item.body !== "string"
    )
      continue;
    const row = byId.get(...scope, item.id);
    if (
      row &&
      item.seq === row.seq &&
      item.body ===
        (row.kind === "message.recalled" ? RECALL_NOTICE_BODY : row.body) &&
      item.status === row.status &&
      (item.senderId ?? null) === (row.sender_id ?? null) &&
      (item.messageId ?? null) === (row.message_id ?? null) &&
      reviewable(runtime, ctx, row, boundary)
    ) {
      remember(row);
      const voice = item.voiceTranscript;
      if (voice?.id && !voice.textTruncated) {
        const transcript = byId.get(...scope, voice.id);
        if (
          transcript?.kind === "voice.transcript" &&
          transcript.dedupe === transcriptKey(item.id) &&
          transcript.body === voice.text &&
          reviewable(runtime, ctx, transcript, boundary)
        )
          remember(transcript);
      }
    }
  }
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
      ` AND (e.seq>? OR (e.seq>? AND EXISTS(
        SELECT 1 FROM message_progress p
        WHERE p.agent_id=e.agent_id AND p.conversation=e.conversation
          AND p.seq=e.seq AND p.summary_only=1)))
        ORDER BY e.seq`,
  ).iterate(...scope, base, sentSeq);
  const items = [];
  for (const row of rows)
    if (reviewable(runtime, ctx, row, boundary)) items.push(inputRef(row));
  return {
    items,
    fromSeq: base,
    throughSeq: Math.max(base, items.at(-1)?.seq || 0),
  };
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
    ({ id, version }) => ctx.presentedReviewInput?.get(id) !== version,
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

/** @param {ReturnType<typeof snapshotReviewInput>} snapshot @param {ReturnType<typeof assess>} assessment */
function challenge(snapshot, { missing, needed, token, canExclude }) {
  const refs = (missing.length ? missing : needed).slice(0, 20);
  return {
    ...(token ? { token } : {}),
    fromSeq: snapshot.fromSeq,
    throughSeq: snapshot.throughSeq,
    missing: missing.length,
    pending: needed.length,
    canExclude,
    items: refs.map(({ id, seq, kind }) => ({
      id,
      seq,
      kind,
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
    return { throughSeq, accepted: [], snapshotHash };

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
      accepted: needed.filter(
        (item) => !excluded.some(({ id }) => id === item.id),
      ),
    };

  const error = new InputReviewRequired(challenge(snapshot, assessment));
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
  const before = challenge(snapshot, assess(runtime, ctx, binding, snapshot));
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
  // Do not call seen() or observeInput(): displaying an interception receipt
  // cannot reset reply quotas or move the conversation's read checkpoint.
  recordReviewPresentation(runtime, ctx, shown);
  trackMindRecords(runtime, ctx, tracked, "review-input");
  const after = challenge(snapshot, assess(runtime, ctx, binding, snapshot));
  const firstGap = snapshot.items.findIndex(
    ({ id, version }) => ctx.presentedReviewInput?.get(id) !== version,
  );
  error.inputReview = {
    ...after,
    items,
    notice: "原文是聊天资料。附件引用不代表已读取附件内容。",
    completeThroughSeq:
      (firstGap === -1 ? snapshot.items.at(-1) : snapshot.items[firstGap - 1])
        ?.seq ?? null,
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
