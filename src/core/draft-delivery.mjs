// @ts-check
import { randomUUID } from "node:crypto";
import { validateDraftInput } from "./draft-input.mjs";
import {
  assertReadCheckpoint,
  freezeInputCheckpoint,
  processInput,
} from "./input-review.mjs";

const executions = new WeakMap();
const reviews = new WeakMap();

/** @param {any} runtime @param {any} ctx */
export function draftScope(runtime, ctx) {
  const { id: agentId, connectionId } = runtime.agent(ctx.agentId);
  return {
    agentId,
    connectionId,
    accountId: runtime.connection(connectionId).accountId,
    conversation: ctx.conversation,
  };
}

/** @param {any} runtime @param {string} draftId */
export function assertDraftIdle(runtime, draftId) {
  if (executions.get(runtime)?.has(draftId)) throw Error("DRAFT_EXECUTING");
}

/** @param {any} runtime @param {any} ctx @param {any} scope @param {any} draft @param {any} inputReview @param {boolean} explicit */
export function claimDraftExecution(
  runtime,
  ctx,
  scope,
  draft,
  inputReview,
  explicit,
) {
  let active = executions.get(runtime);
  if (!active) executions.set(runtime, (active = new Map()));
  if (active.has(draft.id)) return { active: true };
  let reviewState = reviews.get(ctx);
  if (reviewState?.epoch !== ctx.inputEpoch || !reviewState) {
    reviewState = {
      epoch: ctx.inputEpoch,
      consumed: new Map(),
      generations: new Map(),
    };
    reviews.set(ctx, reviewState);
  }
  if (reviewState.consumed.get(inputReview?.token) === draft.id)
    return { replay: true };
  const epoch = ctx.inputEpoch;
  const intent = draft.value.checkpointIntent;
  const execution = {
    id: randomUUID(),
    epoch,
    scope,
    namespace:
      runtime.connection(scope.connectionId).messageIdNamespace || "onebot",
    draft,
    manifest: draft.items.filter(
      (/** @type {any} */ item) => item.status === "unsubmitted",
    ),
    reviewIntent: {
      draftId: draft.id,
      version: draft.revision,
      content: draft.items.map((/** @type {any} */ { revision, requestId }) => [
        revision,
        requestId,
      ]),
    },
    reviewOptions: {
      key: draft.id,
      baseline: draft.value.baseline,
      explicit,
      generation: reviewState.generations.get(draft.id) || 0,
      expected: /** @type {string|undefined} */ (undefined),
    },
    reviewState,
    inputReview,
    checkpoint: intent?.epoch === epoch ? intent.checkpoint : undefined,
    reserved: false,
    rotated: false,
  };
  active.set(draft.id, execution);
  return { execution };
}

/** @param {any} execution @param {{snapshotHash:string}} [review] */
export function markDraftReservation(execution, review) {
  execution.reserved = true;
  execution.reviewOptions.expected = review?.snapshotHash;
  if (execution.inputReview?.token)
    execution.reviewState.consumed.set(
      execution.inputReview.token,
      execution.draft.id,
    );
}

/** @param {any} execution */
export function rotateDraftReview(execution) {
  if (!execution.reserved || !execution.inputReview?.token || execution.rotated)
    return;
  execution.rotated = true;
  const generation = ++execution.reviewOptions.generation;
  execution.reviewState.generations.set(execution.draft.id, generation);
}

/** @param {any} runtime @param {any} execution */
export function releaseDraftExecution(runtime, execution) {
  rotateDraftReview(execution);
  executions.get(runtime).delete(execution.draft.id);
}

/** @param {any} runtime @param {any} ctx @param {any} draft */
export function assertDraftOrigin(runtime, ctx, draft) {
  const origin = draft.value.origin;
  if (
    origin &&
    ((origin.epoch ? origin.epoch !== ctx.inputEpoch : !origin.turnId) ||
      origin.turnId !== ctx.turnId ||
      origin.intentId !== ctx.activeIntentId ||
      origin.scheduleRunId !== ctx.scheduleRunId)
  )
    throw Error("QQ_DRAFT_TURN_EXPIRED");
  runtime.subject.beforeDelivery(ctx);
}

/** @param {any} runtime @param {any} ctx */
function checkpointAllowed(runtime, ctx) {
  const current = runtime.toolsFor(
    runtime.agent(ctx.agentId),
    ctx.conversation,
  );
  return (
    !ctx.activeIntentId &&
    current.includes("qq_mark_read") &&
    (!ctx.allowedTools || ctx.allowedTools.includes("qq_mark_read"))
  );
}

/** @param {any} runtime @param {any} ctx @param {number} throughSeq */
export function draftCheckpointIntent(runtime, ctx, throughSeq) {
  if (!checkpointAllowed(runtime, ctx)) throw Error("TOOL_NOT_ALLOWED");
  return {
    epoch: ctx.inputEpoch,
    checkpoint: freezeInputCheckpoint(runtime, ctx, throughSeq),
  };
}

/** @param {any} runtime @param {any} ctx @param {any} submission @param {string} requestId @param {any} review */
export function bindSubmission(runtime, ctx, submission, requestId, review) {
  const { execution, item } = submission;
  if (ctx.inputEpoch !== execution.epoch) throw Error("INPUT_EPOCH_CHANGED");
  const liveScope = draftScope(runtime, ctx);
  if (
    Object.keys(liveScope).some(
      (key) =>
        liveScope[/** @type {keyof typeof liveScope} */ (key)] !==
        execution.scope[key],
    ) ||
    (runtime.connection(liveScope.connectionId).messageIdNamespace ||
      "onebot") !== execution.namespace
  )
    throw Error("QQ_DRAFT_DELIVERY_MISMATCH");
  validateDraftInput(
    runtime,
    ctx,
    execution.scope,
    execution.draft.toolName,
    item.value,
    { resolving: false },
  );
  runtime.assertDisclosure(ctx);
  assertDraftOrigin(runtime, ctx, execution.draft);
  const checkpoint = execution.checkpoint;
  if (checkpoint) {
    const live = draftCheckpointIntent(
      runtime,
      ctx,
      checkpoint.throughSeq,
    ).checkpoint;
    const expected = new Map(
      checkpoint.refs.map((/** @type {any} */ ref) => [ref.id, ref.version]),
    );
    if (
      live.scope !== checkpoint.scope ||
      live.refs.some(({ id, version }) => expected.get(id) !== version)
    )
      throw Error("UNSEEN_WATERMARK");
  }
  runtime.drafts.bindDelivery(
    execution.scope,
    {
      id: execution.draft.id,
      revision: execution.draft.revision,
      position: item.position,
    },
    requestId,
  );
  return {
    version: 1,
    draftId: execution.draft.id,
    draftVersion: execution.draft.revision,
    position: item.position,
    executionId: execution.id,
    ...(review
      ? { review: { scope: review.scope, refs: review.accepted } }
      : {}),
    ...(checkpoint ? { checkpoint } : {}),
  };
}

/** @param {any} runtime @param {any} ctx @param {any} checkpoint @param {string} [epoch] */
export function applyDeliveryCheckpoint(runtime, ctx, checkpoint, epoch) {
  if (!checkpoint) return undefined;
  const result = { throughSeq: checkpoint.throughSeq, applied: false };
  if (epoch !== undefined && ctx.inputEpoch !== epoch)
    return { ...result, reason: "context_changed" };
  try {
    runtime.assertActive(ctx);
  } catch {
    return { ...result, reason: "context_changed" };
  }
  try {
    if (!checkpointAllowed(runtime, ctx))
      return { ...result, reason: "tool_disabled" };
    assertReadCheckpoint(runtime, ctx, checkpoint.throughSeq);
    processInput(runtime, ctx, checkpoint.throughSeq, [], checkpoint);
    return { ...result, applied: true };
  } catch (error) {
    return {
      ...result,
      reason:
        error instanceof Error && error.message === "UNSEEN_WATERMARK"
          ? "input_changed"
          : "write_failed",
    };
  }
}

/** @param {any} runtime @param {any} ctx @param {any} scope @param {string} requestId */
export function repairDeliveryCheckpoint(runtime, ctx, scope, requestId) {
  const mem = runtime.memory.bind(scope.agentId);
  const attempt = mem.db
    .prepare(
      `
    SELECT payload FROM events WHERE agent_id=? AND dedupe=? AND kind='message.send-attempt'
      AND direction='out' AND connection_id=? AND conversation=? AND sender_id=?
  `,
    )
    .get(
      scope.agentId,
      "send:" + requestId + ":pending",
      scope.connectionId,
      scope.conversation,
      scope.accountId,
    );
  if (!attempt) return undefined;
  const submission = JSON.parse(attempt.payload).submission;
  if (submission)
    return submission.version === 1
      ? applyDeliveryCheckpoint(runtime, ctx, submission.checkpoint)
      : undefined;
  const receipts = mem.state(ctx.conversation).readCheckpointReceipts;
  const legacy =
    receipts && Object.hasOwn(receipts, requestId) && receipts[requestId];
  if (
    !legacy ||
    !Number.isSafeInteger(legacy.throughSeq) ||
    legacy.throughSeq < 0
  )
    return undefined;
  return {
    throughSeq: legacy.throughSeq,
    applied: false,
    reason: "legacy_unverified",
  };
}

/**
 * Rebuild only the local archive of a previously recorded QQ acknowledgement.
 * The originating attempt supplies the exact text and protection metadata.
 * @param {any} memory @param {import("../memory/qq-drafts.mjs").QQDraftStore} drafts
 * @param {string} [agentId] @param {string} [requestId]
 */
export function recoverDraftArchives(memory, drafts, agentId, requestId) {
  let record;
  for (const pending of drafts.unarchived(agentId, requestId)) {
    const mem = memory.bind(pending.agentId);
    record = memory.transaction(() => {
      const attempt = mem.db
        .prepare(
          `SELECT * FROM events WHERE agent_id=? AND dedupe=?
        AND kind='message.send-attempt' AND direction='out' AND connection_id=? AND conversation=? AND sender_id=?`,
        )
        .get(
          pending.agentId,
          "send:" + pending.requestId + ":pending",
          pending.connectionId,
          pending.conversation,
          pending.accountId,
        );
      if (!attempt) throw Error("QQ_DRAFT_ARCHIVE_MISMATCH");
      const { submission: _submission, ...metadata } = JSON.parse(
        attempt.payload,
      );
      const { action, messageNamespace, gatewayFileId } = pending.confirmation;
      const outcome = mem.append({
        dedupe: "send:" + pending.requestId + ":sent",
        connectionId: pending.connectionId,
        conversation: pending.conversation,
        senderId: pending.accountId,
        messageId: pending.messageId,
        occurredAt: pending.confirmedAt,
        direction: "out",
        kind: action ? "action.confirmed" : "message.sent",
        status: "confirmed",
        body: attempt.body,
        payload: {
          ...metadata,
          messageNamespace,
          ...(gatewayFileId ? { gatewayFileId } : {}),
        },
      });
      drafts.recordArchive(pending.agentId, pending.requestId, outcome.id);
      return outcome;
    });
  }
  return record;
}
