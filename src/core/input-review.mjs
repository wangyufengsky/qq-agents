// @ts-check
import { createHash, createHmac, randomBytes } from "node:crypto";
import { isPrivateLikeGroup } from "./config.mjs";
import { liveInput } from "./live-input.mjs";
import { transcriptKey } from "../memory/store.mjs";
import { prepared, recallBoundary } from "./recall-boundary.mjs";

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
      item.body === row.body &&
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
 * @param {any} runtime @param {any} ctx
 */
export function snapshotReviewInput(runtime, ctx) {
  const db = runtime.memory.bind(ctx.agentId).db,
    scope = reviewScope(runtime, ctx),
    boundary = recallBoundary(runtime, ctx),
    base = Math.max(ctx.reviewReadSeq || 0, ctx.reviewSentSeq || 0);
  const rows = prepared(
    db,
    inputRows +
      ` AND (e.seq>? OR (e.seq>? AND EXISTS(
        SELECT 1 FROM message_progress p
        WHERE p.agent_id=e.agent_id AND p.conversation=e.conversation
          AND p.seq=e.seq AND p.summary_only=1)))
        ORDER BY e.seq`,
  ).iterate(...scope, base, ctx.reviewSentSeq || 0);
  const items = [];
  for (const row of rows)
    if (reviewable(runtime, ctx, row, boundary)) items.push(inputRef(row));
  return {
    items,
    fromSeq: base,
    throughSeq: Math.max(base, items.at(-1)?.seq || 0),
  };
}

export class InputReviewRequired extends Error {
  /** @param {Record<string, unknown>} inputReview */
  constructor(inputReview) {
    super("INPUT_REVIEW_REQUIRED");
    this.inputReview = inputReview;
  }
}

/**
 * A token exists only after all current versions were completely displayed.
 * It authorizes a deliberate resubmission of these exact outbound contents
 * and this exact snapshot. It confers neither reply authority nor a read mark.
 * @param {any} runtime @param {any} ctx
 * @param {string} requestId @param {any} intent @param {InputReview | undefined} review
 */
export function assertInputReviewed(runtime, ctx, requestId, intent, review) {
  const { items, fromSeq, throughSeq } = snapshotReviewInput(runtime, ctx),
    needed = items.filter(
      ({ id, version }) =>
        ctx.openingReviewInput?.get(id) !== version &&
        ctx.confirmedReviewInput?.get(id) !== version,
    );
  if (!needed.length && !review) return { throughSeq, accepted: [] };

  const missing = items.filter(
    ({ id, version }) => ctx.presentedReviewInput?.get(id) !== version,
  );
  let token;
  if (!missing.length) {
    const key = tokenKeys.get(ctx) ?? randomBytes(32);
    tokenKeys.set(ctx, key);
    token = createHmac("sha256", key)
      .update(
        JSON.stringify([reviewScope(runtime, ctx), requestId, intent, items]),
      )
      .digest("hex");
  }
  const canExclude =
    ctx.conversation.startsWith("group:") &&
    !isPrivateLikeGroup(runtime.config, ctx.conversation);
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

  const refs = (missing.length ? missing : needed).slice(0, 20);
  throw new InputReviewRequired({
    ...(token ? { token } : {}),
    fromSeq,
    throughSeq,
    missing: missing.length,
    pending: needed.length,
    canExclude,
    items: refs.map(({ id, seq, kind }) => ({
      id,
      seq,
      kind,
      continuation: { tool: "memory_read", id, offset: 0 },
    })),
  });
}
