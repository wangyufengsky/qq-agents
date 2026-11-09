// @ts-check
import { createHash, createHmac, randomBytes } from "node:crypto";
import { isPrivateLikeGroup } from "./config.mjs";
import { recordedInput } from "./live-input.mjs";
import { transcriptKey } from "../memory/store.mjs";
import { RECALL_NOTICE_BODY } from "../memory/recalls.mjs";
import { prepared, recallBoundary } from "./recall-boundary.mjs";
import {
  inputScope,
  inputBelongsToScope,
  refreshInput,
  findInput,
  processingInputRows,
  reviewInputRows,
  writeProcessed,
  writeReviewed,
  readInputDisposition,
} from "../memory/input-state.mjs";
import { trackMindRecords } from "./protected-mind.mjs";

/** @typedef {{id: string, seq: number, kind: string, version: string}} InputRef */
/** @typedef {{token: string, decision: "continue", unrelated?: {id: string, reason: string}[]}} InputReview */

/** @type {WeakMap<object, Buffer>} */
const tokenKeys = new WeakMap();

/** @param {any} row @returns {InputRef} */
function inputRef(row) {
  return { id: row.id, seq: row.seq, kind: row.kind, version: row.version };
}

/** @param {any} runtime @param {any} ctx */
function inputs(runtime, ctx) {
  const scope = inputScope(runtime, ctx);
  const memory = runtime.memory.bind(ctx.agentId);
  const state = refreshInput(memory, scope);
  return { memory, scope, state, db: memory.db };
}
/** @param {any} runtime @param {any} ctx @param {any} row */
function eligible(runtime, ctx, row) {
  if (row.kind === "message.received")
    return !!recordedInput(runtime, ctx.agentId, ctx.conversation, row.id);
  if (row.kind !== "voice.transcript") return true;
  const sourceId = JSON.parse(row.payload).sourceEventId;
  if (typeof sourceId !== "string" || row.dedupe !== transcriptKey(sourceId))
    return false;
  const source = recordedInput(
    runtime,
    ctx.agentId,
    ctx.conversation,
    sourceId,
  );
  return (
    !!source &&
    source.seq < row.seq &&
    source.sender_id === row.sender_id &&
    inputBelongsToScope(
      source,
      JSON.parse(inputScope(runtime, ctx)),
      runtime.memory.db,
    )
  );
}

/** @param {any} runtime @param {any} ctx @param {any} row @param {any} boundary */
function visible(runtime, ctx, row, boundary) {
  const payload = JSON.parse(row.payload);
  if (
    !boundary.allowed({ id: row.id, conversation: row.conversation, payload })
  )
    return false;
  if (row.kind !== "voice.transcript") return true;
  const source = recordedInput(
    runtime,
    ctx.agentId,
    ctx.conversation,
    payload.sourceEventId,
  );
  return (
    !!source &&
    boundary.allowed({
      id: source.id,
      conversation: source.conversation,
      payload: JSON.parse(source.payload),
    })
  );
}

/** @param {any} runtime @param {any} ctx @param {any[]} items */
export function describeInputPresentation(runtime, ctx, items) {
  const { db, scope } = inputs(runtime, ctx);
  const boundary = recallBoundary(runtime, ctx);
  const byId = prepared(
    db,
    "SELECT * FROM events WHERE agent_id=? AND conversation=? AND id=?",
  );
  /** @type {Map<string,string>} */
  const proofs = new Map();
  for (const item of items) {
    if (
      item.conversation !== ctx.conversation ||
      !item.id ||
      item.summaryOmitted ||
      item.bodyTruncated
    )
      continue;
    const version = findInput(db, scope, item.id);
    const row = version && byId.get(ctx.agentId, ctx.conversation, item.id);
    if (
      !row ||
      item.seq !== row.seq ||
      item.type !== row.kind ||
      item.status !== row.status ||
      item.body !==
        (row.kind === "message.recalled" ? RECALL_NOTICE_BODY : row.body) ||
      (item.senderId ?? null) !== (row.sender_id ?? null) ||
      (item.messageId ?? null) !== (row.message_id ?? null) ||
      !eligible(runtime, ctx, row) ||
      !visible(runtime, ctx, row, boundary)
    )
      continue;
    proofs.set(item.id, version.version);
    const voice = item.voiceTranscript;
    if (!voice?.id || voice.textTruncated) continue;
    const transcriptVersion = findInput(db, scope, voice.id);
    const transcript =
      transcriptVersion && byId.get(ctx.agentId, ctx.conversation, voice.id);
    if (
      transcriptVersion &&
      transcript?.kind === "voice.transcript" &&
      transcript.dedupe === transcriptKey(item.id) &&
      transcript.body === voice.text &&
      eligible(runtime, ctx, transcript) &&
      visible(runtime, ctx, transcript, boundary)
    )
      proofs.set(voice.id, transcriptVersion.version);
  }
  return proofs;
}

/** @param {any} runtime @param {any} ctx @param {Map<string,string>} proofs */
export function commitInputPresentation(runtime, ctx, proofs) {
  const { db, scope } = inputs(runtime, ctx);
  const boundary = recallBoundary(runtime, ctx);
  const byId = prepared(
    db,
    "SELECT * FROM events WHERE agent_id=? AND conversation=? AND id=?",
  );
  for (const [id, version] of proofs) {
    const current = findInput(db, scope, id);
    const row =
      current?.version === version &&
      byId.get(ctx.agentId, ctx.conversation, id);
    if (
      row &&
      eligible(runtime, ctx, row) &&
      visible(runtime, ctx, row, boundary)
    )
      (ctx.presentedInput ??= new Map()).set(id, version);
  }
  return presentationCheckpoint(runtime, ctx);
}

/** @param {any} runtime @param {any} ctx @param {any[]} items @param {Map<string,string>} proofs */
export function inputProjection(runtime, ctx, items, proofs) {
  const checkpoint = presentationCheckpoint(runtime, ctx, proofs, items);
  for (const item of items) {
    const version = proofs.get(item.id);
    if (version) item.inputRef = { id: item.id, version };
    const transcript = item.voiceTranscript;
    if (transcript?.id && proofs.has(transcript.id))
      transcript.inputRef = {
        id: transcript.id,
        version: proofs.get(transcript.id),
      };
  }
  return checkpoint;
}

/** @param {any} runtime @param {any} ctx @param {Map<string,string>} [provisional] @param {any[]} [items] */
export function presentationCheckpoint(runtime, ctx, provisional, items = []) {
  const { db, scope, state } = inputs(runtime, ctx);
  const boundary = recallBoundary(runtime, ctx);
  let through = state.processed_through;
  let gap;
  for (const row of processingInputRows(db, scope)) {
    if (!eligible(runtime, ctx, row)) continue;
    if (!visible(runtime, ctx, row, boundary)) {
      through = Math.min(through, row.seq - 1);
      gap = { reason: "restricted_input" };
      break;
    }
    if (
      (provisional?.get(row.id) ?? ctx.presentedInput?.get(row.id)) !==
      row.version
    ) {
      through = Math.min(through, row.seq - 1);
      const partial = items.some(
        (item) =>
          item.id === row.id && (item.summaryOmitted || item.bodyTruncated),
      );
      gap = partial
        ? { tool: "memory_read", id: row.id, offset: 0 }
        : {
            tool: "conversation_read",
            afterSeq: Math.min(through, row.seq - 1),
          };
      break;
    }
    through = Math.max(through, row.seq);
  }
  if (!provisional) ctx.shownSeq = through;
  return { readThroughSeq: through, ...(gap ? { readGap: gap } : {}) };
}

/** @param {any} runtime @param {any} ctx @param {number} through */
export function assertReadCheckpoint(runtime, ctx, through) {
  if (
    !Number.isSafeInteger(through) ||
    through < 0 ||
    !Number.isSafeInteger(ctx.shownSeq) ||
    ctx.shownSeq < 0 ||
    through > presentationCheckpoint(runtime, ctx).readThroughSeq
  )
    throw Error("UNSEEN_WATERMARK");
}

/** @typedef {{scope:string, throughSeq:number, refs: {id:string,version:string}[]}} FrozenCheckpoint */

/** @param {any} runtime @param {any} ctx @param {number} throughSeq @returns {FrozenCheckpoint} */
export function freezeInputCheckpoint(runtime, ctx, throughSeq) {
  assertReadCheckpoint(runtime, ctx, throughSeq);
  const { db, scope } = inputs(runtime, ctx);
  const refs = [...processingInputRows(db, scope, throughSeq)]
    .filter((row) => eligible(runtime, ctx, row))
    .map((row) => ({ id: row.id, version: row.version }));
  return { scope, throughSeq, refs };
}

/** @param {any} runtime @param {any} ctx @param {number} through @param {{id:string,version:string}[]} [noReply] @param {FrozenCheckpoint} [expected] */
export function processInput(runtime, ctx, through, noReply = [], expected) {
  const { memory, db, scope, state } = inputs(runtime, ctx);
  const boundary = recallBoundary(runtime, ctx);
  return memory.store.transaction(() => {
    refreshInput(memory, scope);
    const rows = [...processingInputRows(db, scope, through)].filter((row) =>
      eligible(runtime, ctx, row),
    );
    const byId = prepared(
      db,
      "SELECT * FROM events WHERE agent_id=? AND conversation=? AND id=?",
    );
    if (expected) {
      const refs = new Map(
        expected.refs.map(({ id, version }) => [id, version]),
      );
      if (
        expected.scope !== scope ||
        expected.throughSeq !== through ||
        rows.some((row) => refs.get(row.id) !== row.version) ||
        expected.refs.some(({ id, version }) => {
          const row = byId.get(ctx.agentId, ctx.conversation, id);
          return (
            !row ||
            row.seq > through ||
            findInput(db, scope, id)?.version !== version ||
            !eligible(runtime, ctx, row) ||
            !visible(runtime, ctx, row, boundary)
          );
        })
      )
        throw Error("UNSEEN_WATERMARK");
    }
    if (
      rows.some(
        (row) =>
          !visible(runtime, ctx, row, boundary) ||
          ctx.presentedInput?.get(row.id) !== row.version,
      )
    )
      throw Error("UNSEEN_WATERMARK");
    for (const row of rows) writeProcessed(db, scope, inputRef(row));
    for (const ref of noReply) {
      const row = byId.get(ctx.agentId, ctx.conversation, ref.id);
      const current = row && findInput(db, scope, ref.id);
      if (
        !current ||
        current.seq > through ||
        current.version !== ref.version ||
        ctx.presentedInput?.get(ref.id) !== ref.version ||
        !eligible(runtime, ctx, row) ||
        !visible(runtime, ctx, row, boundary)
      )
        throw Error("UNSEEN_WATERMARK");
      writeProcessed(db, scope, ref, ctx.inputEpoch);
    }
    const readThroughSeq = Math.max(through, state.processed_through);
    prepared(
      db,
      "UPDATE input_scopes SET processed_through=? WHERE scope=?",
    ).run(readThroughSeq, scope);
    // Other history projections still use the cursor; decisions use versioned rows.
    memory.setState(ctx.conversation, {
      ...memory.state(ctx.conversation),
      readThroughSeq,
    });
    return { readThroughSeq };
  });
}

/** @param {any} runtime @param {any} ctx */
export function processingPending(runtime, ctx) {
  const { db, scope } = inputs(runtime, ctx);
  const boundary = recallBoundary(runtime, ctx);
  const items = [];
  for (const row of processingInputRows(db, scope)) {
    if (eligible(runtime, ctx, row) && visible(runtime, ctx, row, boundary))
      items.push(inputRef(row));
    if (items.length === 30) break;
  }
  return items;
}

/** @param {any} runtime @param {any} ctx @param {InputRef} ref */
export function inputDisposition(runtime, ctx, ref) {
  const { db, scope } = inputs(runtime, ctx);
  return readInputDisposition(db, scope, ref);
}

/** @typedef {{readSeq?:number,sentSeq?:number,revision?:number,ids?:string[]}} ReviewBaseline */
/** @param {any} runtime @param {any} ctx @param {ReviewBaseline} [baseline] */
export function snapshotReviewInput(runtime, ctx, baseline) {
  const { db, scope, state } = inputs(runtime, ctx);
  const boundary = recallBoundary(runtime, ctx);
  const keep = [
    ...new Set([
      ...(baseline?.ids || []),
      ...(ctx.confirmedReviewInput?.keys() || []),
    ]),
  ];
  const rows = reviewInputRows(
    db,
    scope,
    keep,
    ctx.inputEpoch,
    baseline?.revision,
  );
  const items = [];
  const observedIds = [];
  let blocked = state.history_required ? "history_baseline_required" : null;
  for (const row of rows) {
    if (!eligible(runtime, ctx, row)) continue;
    observedIds.push(row.id);
    if (!visible(runtime, ctx, row, boundary)) {
      blocked ||= "restricted_input";
      continue;
    }
    items.push(inputRef(row));
  }
  return {
    items,
    fromSeq: state.closed_through,
    throughSeq: Math.max(state.closed_through, items.at(-1)?.seq || 0),
    revision: state.revision,
    scope,
    observedIds,
    blocked,
  };
}

/** @param {any} memory @param {string} scope @param {string} deliveryId @param {InputRef[]} accepted */
export function recordReviewedDelivery(memory, scope, deliveryId, accepted) {
  for (const ref of accepted) writeReviewed(memory.db, scope, deliveryId, ref);
}

/** @typedef {{key?:string, explicit?:boolean, expected?:string, baseline?:ReviewBaseline, generation?:number}} ReviewOptions */
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

/** @param {any} runtime @param {any} ctx @param {ReviewBinding} binding @param {ReturnType<typeof snapshotReviewInput>} snapshot @param {Map<string,string>} [provisional] */
function assess(runtime, ctx, binding, snapshot, provisional) {
  const snapshotHash = createHash("sha256")
    .update(JSON.stringify([snapshot.revision, snapshot.items]))
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
    ({ id, version }) =>
      (provisional?.get(id) ?? ctx.presentedInput?.get(id)) !== version,
  );
  let token;
  if (!missing.length && !snapshot.blocked) {
    const key = tokenKeys.get(ctx) ?? randomBytes(32);
    tokenKeys.set(ctx, key);
    token = createHmac("sha256", key)
      .update(
        JSON.stringify([
          inputScope(runtime, ctx),
          ctx.inputEpoch,
          binding.options.key ?? binding.requestId,
          binding.options.generation ?? 0,
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
    ...(snapshot.blocked ? { blocked: snapshot.blocked } : {}),
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
  if (!snapshot.blocked && !needed.length && !changed && !review)
    return {
      throughSeq,
      scope: snapshot.scope,
      accepted: snapshot.items,
      snapshotHash,
    };

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
      scope: snapshot.scope,
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
  const versions = new Map(
    snapshot.items.map(({ id, version }) => [id, version]),
  );
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
      inputRef: { id: ref.id, version: versions.get(ref.id) },
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
  // The temporary proofs can describe the outgoing challenge; only delivery
  // makes them available to a subsequent tool call.
  const proofs = describeInputPresentation(runtime, ctx, shown);
  const { readThroughSeq, readGap } = inputProjection(
    runtime,
    ctx,
    shown,
    proofs,
  );
  runtime.stageToolInput(ctx, error, () => {
    runtime.contexts.commitSeen(ctx, { items: shown, proofs });
    trackMindRecords(runtime, ctx, tracked, "review-input");
  });
  const after = challenge(
    ctx,
    snapshot,
    assess(runtime, ctx, binding, snapshot, proofs),
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
