// @ts-check
import { createHash, createHmac, randomBytes } from "node:crypto";
import { isPrivateLikeGroup } from "./config.mjs";
import { liveInput, recordedInput } from "./live-input.mjs";
import { quotedMessage, references } from "./person-cards.mjs";
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
  readInputDisposition,
} from "../memory/input-state.mjs";
import { isDeepStrictEqual } from "node:util";
import { trackMindRecords } from "./protected-mind.mjs";

/** @typedef {{id: string, seq: number, kind: string, version: string}} InputRef */
/** @typedef {{token: string, decision: "continue", unrelated?: {id: string, reason: string}[]}} InputReview */

/** @param {any} row @returns {InputRef} */
function inputRef(row) {
  return { id: row.id, seq: row.seq, kind: row.kind, version: row.version };
}

/** @param {any} runtime @param {any} ctx */
function usesInlineChatInput(runtime, ctx) {
  const { backendId } = runtime.agent(ctx.agentId);
  const backend = runtime.config.backends.find(
    (/** @type {any} */ backend) => backend.id === backendId,
  );
  return backend?.type === "antigravity" && backend.cliProtocol === "acp";
}

/**
 * Leave room for ACP's serialized JSON, page metadata and read proof.
 * @param {any} runtime @param {any} ctx @param {number} [requested]
 */
export function inlineChatInputChars(runtime, ctx, requested) {
  return usesInlineChatInput(runtime, ctx)
    ? Math.min(requested ?? 1600, 1600)
    : requested;
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

/** @param {any} runtime @param {any} ctx @param {any} db @param {string} scope @param {any[]} rows @param {any} boundary @param {number} through @param {FrozenCheckpoint} expected */
function assertFrozenRows(
  runtime,
  ctx,
  db,
  scope,
  rows,
  boundary,
  through,
  expected,
) {
  const refs = new Map(expected.refs.map(({ id, version }) => [id, version]));
  const byId = prepared(
    db,
    "SELECT * FROM events WHERE agent_id=? AND conversation=? AND id=?",
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

/** @param {any} runtime @param {any} ctx @param {FrozenCheckpoint} expected */
export function assertFrozenInputCheckpoint(runtime, ctx, expected) {
  assertReadCheckpoint(runtime, ctx, expected.throughSeq);
  const { db, scope } = inputs(runtime, ctx);
  const rows = [...processingInputRows(db, scope, expected.throughSeq)].filter(
    (row) => eligible(runtime, ctx, row),
  );
  assertFrozenRows(
    runtime,
    ctx,
    db,
    scope,
    rows,
    recallBoundary(runtime, ctx),
    expected.throughSeq,
    expected,
  );
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
    if (expected)
      assertFrozenRows(
        runtime,
        ctx,
        db,
        scope,
        rows,
        boundary,
        through,
        expected,
      );
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

/** @param {any} runtime @param {any} ctx */
export function focusedGroupReplyEnabled(runtime, ctx) {
  return (
    ctx.conversation.startsWith("group:") &&
    isPrivateLikeGroup(runtime.config, ctx.conversation) &&
    runtime.agent(ctx.agentId).behavior.focusedGroupReply === true &&
    ctx.allowedTools?.includes("qq_send") &&
    !ctx.activeIntentId &&
    !ctx.scheduleRunId
  );
}

/** @param {string} toolName @param {any} input */
export function textReplyEvent(toolName, input) {
  return toolName === "qq_send" && !input?.mediaId && !input?.atUserId
    ? input?.replyEventId
    : undefined;
}

/** @param {any} db @param {any} row @param {any} focus @param {Set<string>} related */
function inFocusedReview(db, row, focus, related) {
  if (row.id === focus.id) return true;
  if (row.seq <= focus.seq) return false;
  if (row.kind === "voice.transcript")
    return related.has(JSON.parse(row.payload).sourceEventId);
  // A recall replaces the follow-up's visible text, but keeps its membership
  // in this review. Resolve the original in the notice's gateway namespace.
  const source =
    row.kind === "message.recalled" && row.message_id
      ? quotedMessage(db, row, row.message_id)
      : row;
  if (
    source?.kind !== "message.received" ||
    source.seq <= focus.seq ||
    !references(source).replies.includes(focus.message_id) ||
    quotedMessage(db, source, focus.message_id)?.id !== focus.id
  )
    return false;
  related.add(source.id);
  return true;
}

/** @typedef {{readSeq?:number,sentSeq?:number,revision?:number,ids?:string[]}} ReviewBaseline */
/** @param {any} runtime @param {any} ctx @param {ReviewBaseline} [baseline] @param {string} [replyEventId] */
export function snapshotReviewInput(runtime, ctx, baseline, replyEventId) {
  const { db, scope, state } = inputs(runtime, ctx);
  const boundary = recallBoundary(runtime, ctx);
  const focus =
    replyEventId &&
    replyEventId === ctx.focusedReplyId &&
    focusedGroupReplyEnabled(runtime, ctx)
      ? liveInput(runtime, ctx.agentId, ctx.conversation, replyEventId)
      : null;
  const related = new Set(focus ? [focus.id] : []);
  const keep = [
    ...new Set([
      ...(baseline?.ids || []),
      ...(ctx.confirmedReviewInput?.keys() || []),
      ...related,
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
    if (focus && !inFocusedReview(db, row, focus, related)) continue;
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
    focus: focus?.id ?? null,
    scope,
    observedIds,
    blocked,
  };
}

/** @typedef {{draftId:string, version:number, content:unknown, baseline?:ReviewBaseline, checkpoint?:any, replyEventId?:string}} DraftBinding */
/** @typedef {ReturnType<typeof snapshotReviewInput>} ReviewSnapshot */
/** @typedef {{scope:string, throughSeq:number, accepted:InputRef[], snapshotHash:string}} ReviewedInput */
/** @typedef {{binding:DraftBinding, epoch:string, snapshot:ReviewSnapshot, policy:boolean, checkpoint:any, generation:number, generations:Map<string,number>, review?:ReviewedInput, executionId?:string, original?:DraftGrant, confirmation?:string}} DraftGrant */
/** @type {WeakMap<object, {epoch:string, draft:Map<string,DraftGrant>, generations:Map<string,number>, legacy:Map<string,string>, legacyKey:Buffer}>} */
const grants = new WeakMap();

/** @param {any} ctx */
function grantState(ctx) {
  const state = grants.get(ctx);
  if (state?.epoch === ctx.inputEpoch && state) return state;
  const next = {
    epoch: ctx.inputEpoch,
    draft: new Map(),
    generations: new Map(),
    legacy: new Map(),
    legacyKey: randomBytes(32),
  };
  grants.set(ctx, next);
  return next;
}

/** @param {ReviewSnapshot} snapshot */
function snapshotDigest(snapshot) {
  return (
    createHash("sha256")
      // Unrelated arrivals still advance the conversation revision. A quoted
      // reply binds only the live target and the input versions in its scope.
      .update(
        JSON.stringify([snapshot.focus ?? snapshot.revision, snapshot.items]),
      )
      .digest("hex")
  );
}

/** @param {any} runtime @param {any} ctx */
function allowsExclusion(runtime, ctx) {
  return (
    ctx.conversation.startsWith("group:") &&
    !isPrivateLikeGroup(runtime.config, ctx.conversation)
  );
}

/** @param {any} ctx @param {ReviewSnapshot} snapshot */
function missingInput(ctx, snapshot) {
  return snapshot.items.filter(
    ({ id, version }) => ctx.presentedInput?.get(id) !== version,
  );
}

/** @param {ReviewSnapshot} snapshot @param {InputReview["unrelated"]} excluded */
function reviewed(snapshot, excluded = []) {
  const rejected = new Set(excluded.map(({ id }) => id));
  return {
    snapshotHash: snapshotDigest(snapshot),
    scope: snapshot.scope,
    throughSeq: Math.min(
      snapshot.throughSeq,
      ...snapshot.items
        .filter(({ id }) => rejected.has(id))
        .map(({ seq }) => seq - 1),
    ),
    accepted: snapshot.items.filter(({ id }) => !rejected.has(id)),
  };
}

/** @param {InputReview|undefined} confirmation @param {boolean} policy @param {InputRef[]} needed */
function validConfirmation(confirmation, policy, needed) {
  return (
    confirmation?.decision === "continue" &&
    (!confirmation.unrelated?.length ||
      (policy &&
        confirmation.unrelated.every(
          ({ id, reason }) =>
            reason.trim() && needed.some((item) => item.id === id),
        )))
  );
}

/** @param {ReviewSnapshot} snapshot */
function blockedReason(snapshot) {
  if (!snapshot.blocked) return null;
  return snapshot.blocked.toUpperCase();
}

/** @param {any} runtime @param {any} ctx @param {DraftGrant} grant @param {DraftBinding} binding */
function grantMismatch(runtime, ctx, grant, binding) {
  if (grant.epoch !== ctx.inputEpoch) return "CONTEXT_CHANGED";
  if (
    grant.binding.draftId !== binding.draftId ||
    grant.binding.version !== binding.version ||
    !isDeepStrictEqual(grant.binding.content, binding.content) ||
    !isDeepStrictEqual(grant.binding.baseline, binding.baseline)
  )
    return "DRAFT_CHANGED";
  if (grant.policy !== allowsExclusion(runtime, ctx)) return "POLICY_CHANGED";
  const current = snapshotReviewInput(
    runtime,
    ctx,
    binding.baseline,
    binding.replyEventId,
  );
  if (current.scope !== grant.snapshot.scope) return "CONTEXT_CHANGED";
  if (current.focus !== grant.snapshot.focus) return "POLICY_CHANGED";
  if (current.blocked) return blockedReason(current);
  if (snapshotDigest(current) !== snapshotDigest(grant.snapshot)) {
    const versions = new Map(
      grant.snapshot.items.map(({ id, version }) => [id, version]),
    );
    return current.items.some(
      ({ id, version }) => versions.has(id) && versions.get(id) !== version,
    )
      ? "INPUT_VERSION_CHANGED"
      : "NEW_INPUT";
  }
  return null;
}

export class DraftReviewInterrupted extends Error {
  /** @param {string} reason */
  constructor(reason) {
    super("INPUT_REVIEW_REQUIRED");
    this.reason = reason;
  }
}

export class InputReviewRequired extends Error {
  /** @param {Record<string, unknown>} inputReview */
  constructor(inputReview) {
    super("INPUT_REVIEW_REQUIRED");
    this.inputReview = inputReview;
  }
}

/** @param {any} runtime @param {any} ctx @param {DraftBinding} binding @param {ReviewSnapshot} snapshot @returns {DraftGrant} */
function draftGrant(runtime, ctx, binding, snapshot) {
  const { generations } = grantState(ctx);
  return {
    binding,
    epoch: ctx.inputEpoch,
    snapshot,
    generations,
    generation: generations.get(binding.draftId) ?? 0,
    policy: allowsExclusion(runtime, ctx),
    checkpoint: binding.checkpoint,
  };
}

/** @param {any} runtime @param {any} ctx @param {DraftBinding} binding */
export function initialDraftReview(runtime, ctx, binding) {
  const snapshot = snapshotReviewInput(
    runtime,
    ctx,
    binding.baseline,
    binding.replyEventId,
  );
  if (
    snapshot.blocked ||
    (ctx.requiresInputSubmission && !ctx.openingCommitted) ||
    snapshot.items.some(
      ({ id, version }) => ctx.openingReviewInput?.get(id) !== version,
    )
  )
    return null;
  const grant = draftGrant(runtime, ctx, binding, snapshot);
  grant.review = reviewed(snapshot);
  return grant;
}

/** @param {any} runtime @param {any} ctx @param {DraftBinding} binding @param {InputReview|undefined} confirmation */
export function validateDraftGrant(runtime, ctx, binding, confirmation) {
  const grant = confirmation && grantState(ctx).draft.get(confirmation.token);
  if (!grant) return { reason: "CONTEXT_CHANGED" };
  if (
    grant.binding.draftId !== binding.draftId ||
    grant.binding.version !== binding.version ||
    !isDeepStrictEqual(grant.binding.content, binding.content)
  )
    return { reason: "DRAFT_CHANGED" };
  if (!validConfirmation(confirmation, grant.policy, grant.snapshot.items))
    return { reason: "INVALID_CONFIRMATION" };
  const decision = JSON.stringify(confirmation?.unrelated ?? []);
  if (grant.executionId)
    return grant.confirmation === decision
      ? { replay: grant.executionId }
      : { reason: "INVALID_CONFIRMATION" };
  if ((grant.generations.get(binding.draftId) ?? 0) !== grant.generation)
    return { reason: "DRAFT_CHANGED" };
  const reason = grantMismatch(runtime, ctx, grant, binding);
  if (reason) return { reason };
  if (missingInput(ctx, grant.snapshot).length) return { reason: "READ_GAP" };
  const review = reviewed(grant.snapshot, confirmation?.unrelated);
  return {
    grant: { ...grant, original: grant, review, confirmation: decision },
    review,
  };
}

/** @param {DraftGrant} grant @param {string} executionId */
export function claimDraftGrant(grant, executionId) {
  const original = grant.original ?? grant;
  original.executionId = executionId;
  original.confirmation = grant.confirmation;
  original.generations.set(original.binding.draftId, original.generation + 1);
}

/** @param {any} runtime @param {any} ctx @param {DraftBinding} binding @param {DraftGrant|null} grant */
export function assertDraftReview(runtime, ctx, binding, grant) {
  if (!grant?.review) throw new DraftReviewInterrupted("READ_GAP");
  const reason = grantMismatch(runtime, ctx, grant, binding);
  if (reason) throw new DraftReviewInterrupted(reason);
  if (missingInput(ctx, grant.snapshot).length)
    throw new DraftReviewInterrupted("READ_GAP");
  return grant.review;
}

/** @param {any} runtime @param {any} ctx @param {string} id */
export function presentationVersion(runtime, ctx, id) {
  const { db, scope } = inputs(runtime, ctx);
  return findInput(db, scope, id)?.version;
}

/** @param {any} runtime @param {any} ctx @param {InputRef[]} missing */
function reviewMaterials(runtime, ctx, missing) {
  const agent = runtime.assertActive(ctx);
  const memory = runtime.memory.bind(agent.id);
  const boundary = recallBoundary(runtime, ctx);
  const items = [];
  const tracked = [];
  let bytes = 0;
  for (const ref of missing.slice(0, 20)) {
    const row = memory.readRecord({ id: ref.id }, ctx.conversation);
    if (
      row.connectionId !== agent.connectionId ||
      row.conversation !== ctx.conversation ||
      !boundary.allowed(row)
    )
      continue;
    const item = {
      id: ref.id,
      seq: ref.seq,
      kind: ref.kind,
      conversation: row.conversation,
      source: row.source,
      type: row.type,
      senderId: row.senderId,
      senderName: row.senderName,
      messageId: row.messageId,
      occurredAt: row.occurredAt,
      status: row.status,
      body: row.body,
      inputRef: { id: ref.id, version: ref.version },
      ...(row.epistemic ? { epistemic: row.epistemic } : {}),
      ...(row.mentions?.length ? { mentions: row.mentions } : {}),
      ...(row.replyToMessageIds?.length
        ? { replyToMessageIds: row.replyToMessageIds }
        : {}),
    };
    const size = Buffer.byteLength(JSON.stringify(item));
    if (bytes + size > 11000) continue;
    bytes += size;
    items.push(item);
    tracked.push(row);
  }
  return {
    items,
    tracked,
    proofs: describeInputPresentation(runtime, ctx, items),
  };
}

/** @param {any} ctx @param {InputRef[]} missing @param {number} [limit] */
function missingItems(ctx, missing, limit = 20) {
  return missing.slice(0, limit).map(({ id, seq, kind, version }) => {
    const page = ctx.inputPages?.get(id);
    return {
      id,
      seq,
      kind,
      reason: ctx.presentedInput?.has(id)
        ? "INPUT_VERSION_CHANGED"
        : "READ_GAP",
      continuation: {
        tool: "memory_read",
        id,
        offset: page?.inputVersion === version ? page.offset : 0,
      },
    };
  });
}

/** @param {any} runtime @param {any} ctx @param {any} result @param {DraftBinding} binding @param {{reason?:string, currentReason?:() => string|null}} [options] */
export function prepareDraftReview(
  runtime,
  ctx,
  result,
  binding,
  { reason, currentReason } = {},
) {
  const snapshot = snapshotReviewInput(
    runtime,
    ctx,
    binding.baseline,
    binding.replyEventId,
  );
  const blocked = blockedReason(snapshot);
  if (blocked) {
    result.preparation = { state: "blocked", reason: blocked };
    return result;
  }
  const grant = draftGrant(runtime, ctx, binding, snapshot);
  const token = randomBytes(32).toString("hex");
  const missing = missingInput(ctx, snapshot);
  const materials = reviewMaterials(runtime, ctx, missing);
  // Reserve room for complete originals instead of repeating a long list of
  // pointers on every page. The grant still covers the entire input snapshot.
  const inline = usesInlineChatInput(runtime, ctx);
  const pointerLimit = inline ? 6 : 20;
  const change = () =>
    grantMismatch(runtime, ctx, grant, binding) ||
    ((grant.generations.get(binding.draftId) ?? 0) !== grant.generation
      ? "DRAFT_CHANGED"
      : (currentReason?.() ?? null));
  const current = () => !change();
  /** @param {typeof materials} shown @param {string} [candidateToken] */
  function preparation(shown, candidateToken) {
    const remaining = missing.filter(
      ({ id, version }) => shown.proofs.get(id) !== version,
    );
    return {
      state: candidateToken ? "ready" : "needs_input",
      ...(candidateToken ? { token: candidateToken } : {}),
      reason:
        reason ?? (remaining.length ? "READ_GAP" : "REVIEW_DECISION_REQUIRED"),
      missing: missingItems(ctx, remaining, pointerLimit),
      ...(inline && remaining.length && shown.proofs.size
        ? {
            hint: "本页已附部分原文。用同一草稿的 qq_draft prepare 继续；若一页没有原文，按 missing 中的入口补读。",
          }
        : {}),
      pendingDecision: snapshot.items.length,
      ...(binding.checkpoint
        ? { readThroughSeq: binding.checkpoint.throughSeq }
        : {}),
      items: shown.items,
      fromSeq: snapshot.fromSeq,
      throughSeq: snapshot.throughSeq,
      canExclude: grant.policy,
      ...(grant.policy
        ? {
            excludable: snapshot.items
              .slice(0, pointerLimit)
              .map(({ id, seq, kind }) => ({ id, seq, kind })),
          }
        : {}),
    };
  }
  const empty = { items: [], tracked: [], proofs: new Map() };
  result.preparation = preparation(empty);
  const variants = [];
  const ready = missing.every(
    ({ id, version }) => materials.proofs.get(id) === version,
  );
  // Keep complete material that fits. A trimmed candidate always loses its token.
  for (let length = materials.items.length; length >= 0; length--) {
    const items = materials.items.slice(0, length);
    const ids = new Set(items.map(({ id }) => id));
    const shown = {
      items,
      tracked: materials.tracked.slice(0, length),
      proofs: new Map([...materials.proofs].filter(([id]) => ids.has(id))),
    };
    const canGrant = ready && length === materials.items.length;
    const value = {
      ...result,
      preparation: preparation(shown, canGrant ? token : undefined),
    };
    variants.push({
      value,
      expected: JSON.parse(JSON.stringify(value)),
      current,
      commit: () => {
        if (!current()) return false;
        if (shown.items.length) {
          runtime.contexts.commitSeen(ctx, shown);
          trackMindRecords(runtime, ctx, shown.tracked, "review-input");
        }
        if (canGrant && !missingInput(ctx, snapshot).length)
          grantState(ctx).draft.set(token, grant);
        return true;
      },
    });
  }
  variants.push({
    render: () => ({
      ...result,
      preparation: {
        state: "blocked",
        reason: change() || "TOOL_OUTPUT_INCOMPLETE",
      },
    }),
  });
  runtime.stageToolOutput(ctx, result, variants);
  return result;
}

/**
 * Compatibility projection for non-draft sends. Grant activation still uses
 * the same final tool delivery as ordinary reads and draft preparation.
 * @param {any} runtime @param {any} ctx @param {string} requestId @param {any} intent
 * @param {InputReview|undefined} review
 */
export function assertInputReviewed(runtime, ctx, requestId, intent, review) {
  const snapshot = snapshotReviewInput(runtime, ctx);
  const digest = snapshotDigest(snapshot);
  const policy = allowsExclusion(runtime, ctx);
  const needed = snapshot.items.filter(
    ({ id, version }) =>
      ctx.openingReviewInput?.get(id) !== version &&
      ctx.confirmedReviewInput?.get(id) !== version,
  );
  if (!snapshot.blocked && !needed.length && !review) return reviewed(snapshot);
  const missing = missingInput(ctx, snapshot);
  const binding = JSON.stringify([
    snapshot.scope,
    digest,
    policy,
    requestId,
    intent,
  ]);
  if (
    !snapshot.blocked &&
    !missing.length &&
    validConfirmation(review, policy, needed) &&
    grantState(ctx).legacy.get(review?.token || "") === binding
  )
    return reviewed(snapshot, review?.unrelated);

  const challenge = {
    ...(snapshot.blocked ? { blocked: snapshot.blocked } : {}),
    fromSeq: snapshot.fromSeq,
    throughSeq: snapshot.throughSeq,
    missing: missing.length,
    pending: needed.length,
    canExclude: policy,
    ...(policy && needed.length
      ? {
          excludable: needed
            .slice(0, 20)
            .map(({ id, seq, kind }) => ({ id, seq, kind })),
        }
      : {}),
    items: missingItems(ctx, missing).map((item) => ({
      ...item,
      reason: ctx.presentedInput?.has(item.id)
        ? "version_changed"
        : item.seq <= snapshot.fromSeq
          ? "previous_presentation_incomplete_or_stale"
          : "full_input_not_presented",
    })),
  };
  const error = new InputReviewRequired(challenge);
  if (snapshot.blocked) throw error;
  const shown = reviewMaterials(runtime, ctx, missing);
  const remaining = missing.filter(
    ({ id, version }) => shown.proofs.get(id) !== version,
  );
  const token = !remaining.length
    ? createHmac("sha256", grantState(ctx).legacyKey)
        .update(binding)
        .digest("hex")
    : undefined;
  const materialById = new Map(shown.items.map((item) => [item.id, item]));
  const expanded = new InputReviewRequired({
    ...challenge,
    ...(token ? { token } : {}),
    missing: remaining.length,
    items: challenge.items.map(
      (item) => materialById.get(item.id) ?? { ...item, bodyOmitted: true },
    ),
  });
  const current = () => {
    const now = snapshotReviewInput(runtime, ctx);
    return (
      !now.blocked &&
      now.scope === snapshot.scope &&
      digest === snapshotDigest(now) &&
      policy === allowsExclusion(runtime, ctx)
    );
  };
  runtime.stageToolOutput(ctx, error, [
    {
      value: expanded,
      matches: (/** @type {any} */ actual) =>
        actual?.code === "INPUT_REVIEW_REQUIRED" &&
        isDeepStrictEqual(
          JSON.parse(JSON.stringify(expanded.inputReview)),
          actual.inputReview,
        ),
      current,
      commit: () => {
        if (!current()) return false;
        if (shown.items.length) {
          runtime.contexts.commitSeen(ctx, shown);
          trackMindRecords(runtime, ctx, shown.tracked, "review-input");
        }
        if (token && !missingInput(ctx, snapshot).length)
          grantState(ctx).legacy.set(token, binding);
        return true;
      },
    },
    {
      value: error,
      matches: (/** @type {any} */ actual) =>
        actual?.code === "INPUT_REVIEW_REQUIRED" &&
        isDeepStrictEqual(challenge, actual.inputReview),
    },
  ]);
  throw error;
}
