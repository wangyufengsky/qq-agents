import { createHash } from "node:crypto";
import { z } from "zod";
import { deliveryContentKey } from "../transport/delivery-content.mjs";
import { mergeProtection } from "../memory/protection.mjs";
import {
  assertDraftTool,
  canUseDraftTool,
  validateDraftInput,
} from "../core/draft-input.mjs";
import {
  activeDraftExecution,
  assertDraftCheckpoint,
  assertDraftIdle,
  assertDraftOrigin,
  claimDraftExecution,
  draftCheckpointIntent,
  draftReviewBinding,
  draftScope,
  deliveryGuard,
  releaseDraftExecution,
  repairDeliveryCheckpoint,
  replayDraftExecution,
} from "../core/draft-delivery.mjs";
import {
  DraftReviewInterrupted,
  initialDraftReview,
  prepareDraftReview,
  snapshotReviewInput,
  textReplyEvent,
  validateDraftGrant,
} from "../core/input-review.mjs";
import {
  contextProtection,
  trackMindRecords,
} from "../core/protected-mind.mjs";
import { recallBoundary } from "../core/recall-boundary.mjs";
import { burstDelay, waitTyping } from "../core/typing.mjs";
import { attachDraftFailure, safeToolFailure } from "./errors.mjs";
import { sendFile } from "./file-tools.mjs";
import { inputReviewSchema } from "./input-review.mjs";
import { sendVoice } from "./legacy.mjs";
import { qqMessage, qqSegmentsSchema } from "./qq-message.mjs";

const ref = { draftId: z.uuid(), expectedVersion: z.number().int().positive() };
const contents = z.union([
  z
    .object({
      text: z.string().max(8000).optional(),
      segments: qqSegmentsSchema.optional(),
      replyTo: z.string().max(200).optional(),
      atUserId: z.string().max(50).optional(),
      mediaId: z.string().max(200).optional(),
    })
    .strict(),
  z
    .object({
      audioId: z.string().min(1).max(200),
      volume: z.number().min(0.1).max(4).optional(),
      normalize: z.boolean().optional(),
      loudness: z
        .union([
          z.enum(["quiet", "normal", "loud"]),
          z.number().min(-40).max(-5),
        ])
        .optional(),
    })
    .strict(),
  z
    .object({
      fileId: z.string().regex(/^[a-f0-9]{64}$/),
      name: z.string().min(1).max(200).optional(),
    })
    .strict(),
]);
const position = z.number().int().min(0).max(9);
const readThroughSeq = z.number().int().nonnegative().optional();
export const draftDefinitions = {
  qq_draft: [
    "处理当前聊天的草稿。list 列出草稿，read 按 position 查看一项，prepare 核对当前版本和新增输入。revise 保存新版并返回该版的准备结果，discard 放弃剩余未提交项。准备结果为 needs_input 时按分页入口补齐，再调用 prepare；ready 时主体决定是否以 inputReview={token,decision:'continue'} 提交该版本。没有 token 的 continue 只核对。已发不重发，未知先核对。",
    z.discriminatedUnion("action", [
      z
        .object({
          action: z.literal("list"),
          offset: z.number().int().min(0).max(100000).optional(),
          includeSettled: z.boolean().optional(),
        })
        .strict(),
      z
        .object({
          action: z.literal("read"),
          draftId: ref.draftId,
          position: position.optional(),
        })
        .strict(),
      z
        .object({
          action: z.literal("revise"),
          ...ref,
          position,
          input: contents,
          readThroughSeq,
        })
        .strict(),
      z.object({ action: z.literal("discard"), ...ref }).strict(),
      z
        .object({ action: z.literal("prepare"), ...ref, readThroughSeq })
        .strict(),
      z
        .object({
          action: z.literal("continue"),
          ...ref,
          inputReview: inputReviewSchema,
        })
        .strict(),
    ]),
  ],
};

function draftSummary(draft) {
  return {
    draftId: draft.id,
    version: draft.revision,
    tool: draft.toolName,
    imported: draft.imported,
    expiresAt: draft.expiresAt,
    ...(draft.value.checkpointIntent?.checkpoint?.throughSeq !== undefined
      ? {
          requestedReadThroughSeq:
            draft.value.checkpointIntent.checkpoint.throughSeq,
        }
      : {}),
    items: draft.items.map(
      ({
        position: index,
        revision,
        status,
        requestId,
        deliveryRequestId,
        messageId,
        recordId,
      }) => ({
        index,
        version: revision,
        status,
        requestId: deliveryRequestId ?? requestId,
        ...(messageId ? { messageId } : {}),
        ...(recordId ? { recordId } : {}),
      }),
    ),
  };
}

export function draftHints(runtime, ctx, limit = 10) {
  const scope = draftScope(runtime, ctx);
  const agent = runtime.agent(ctx.agentId);
  const boundary = recallBoundary(runtime, ctx);
  const entries = runtime.drafts.list(scope, { limit });
  return {
    items: entries.items
      .filter(
        ({ toolName, value }) =>
          canUseDraftTool(agent, toolName) &&
          (!ctx.allowedTools || ctx.allowedTools.includes(toolName)) &&
          boundary.allowed(value),
      )
      .map(({ id }) => draftSummary(runtime.drafts.read(scope, id))),
    nextOffset: entries.nextOffset,
  };
}

function otherDrafts(runtime, ctx, currentId) {
  return draftHints(runtime, ctx, 4)
    .items.filter(
      ({ draftId, items }) =>
        draftId !== currentId &&
        items.some(({ status }) => status === "unsubmitted"),
    )
    .slice(0, 2)
    .map(({ draftId, version }) => ({ draftId, version }));
}

function scopedLegacyDelivery(runtime, ctx, scope, requestId) {
  const mem = runtime.memory.bind(scope.agentId);
  const row = mem.delivery(requestId);
  if (!row || row.conversation !== scope.conversation) return null;
  const attempt = mem.db
    .prepare(
      `
    SELECT *,json_type(payload,'$.submission') AS submission_type FROM events
    WHERE agent_id=? AND dedupe=? AND conversation=? AND kind='message.send-attempt' AND direction='out'
  `,
    )
    .get(scope.agentId, "send:" + requestId + ":pending", scope.conversation);
  if (!attempt) throw Error("IDEMPOTENCY_CONFLICT");
  // A legacy attempt can still be queried after a draft adopts its receipt.
  if (
    attempt.submission_type === "object" ||
    attempt.connection_id !== scope.connectionId ||
    attempt.sender_id !== scope.accountId
  )
    return null;
  recallBoundary(runtime, ctx).assert(mem.event(attempt, ctx.conversation));
  return row;
}

function recordedLegacy(runtime, ctx, scope, items) {
  const found = new Set();
  for (const item of items) {
    const row = scopedLegacyDelivery(runtime, ctx, scope, item.requestId);
    if (!row) continue;
    // The old burst sent exactly these normalized segments. Check the existing
    // ledger digest without reserving or changing the historical request.
    const digest = createHash("sha256")
      .update(JSON.stringify(qqMessage(item.input, 2000).segments))
      .digest("hex");
    if (row.conversation !== scope.conversation || row.payload_hash !== digest)
      throw Error("IDEMPOTENCY_CONFLICT");
    found.add(item.requestId);
  }
  return found;
}

export async function sendDraftTool(runtime, ctx, toolName, args) {
  const a = assertDraftTool(runtime, ctx, toolName);
  const scope = draftScope(runtime, ctx);
  const burst = toolName === "qq_send_burst";
  const { requestId, inputReview, readThroughSeq, gapMs, messages, ...input } =
    args;
  let prior = runtime.drafts.find(scope, toolName, requestId);
  let legacyReceipt =
    !prior && !burst && scopedLegacyDelivery(runtime, ctx, scope, requestId);
  let checkpointIntent;
  if (!prior && !legacyReceipt && readThroughSeq !== undefined) {
    try {
      checkpointIntent = draftCheckpointIntent(runtime, ctx, readThroughSeq);
    } catch (error) {
      const others = otherDrafts(runtime, ctx);
      if (others.length) attachDraftFailure(error, undefined, others);
      throw error;
    }
  }
  if (burst && requestId.length > 198) throw Error("INVALID_REQUEST_ID");
  if (!prior && burst && messages.length > a.behavior.burstMax)
    throw Error("BURST_LIMIT");
  const inputs = burst
    ? messages.map((message) =>
        typeof message === "string" ? { text: message } : message,
      )
    : [input];
  const items = inputs.map((part, index) => ({
    requestId: burst ? requestId + ":" + index : requestId,
    input:
      prior && (prior.creation_version != null || prior.tool_name !== toolName)
        ? part
        : validateDraftInput(runtime, ctx, scope, toolName, part),
  }));
  try {
    if (!prior) {
      runtime.subject.beforeDelivery(ctx);
      runtime.assertDisclosure(ctx);
    }
  } catch (error) {
    if (!burst) throw error;
    const { code, hint } = safeToolFailure(error);
    return {
      status: "stopped",
      actionResult: "not_sent",
      attemptedThisCall: false,
      receipts: [],
      failedIndex: 0,
      error: code,
      hint,
      doNotReplay: true,
    };
  }
  const pending =
    !prior && runtime.drafts.unresolved(scope, deliveryGuard(runtime, ctx));
  if (pending?.status === "pending") {
    const chain = runtime.delivery.conversations.get(
      scope.connectionId + "|" + ctx.conversation,
    );
    if (chain) await chain.catch(() => {});
    assertDraftTool(runtime, ctx, toolName);
    prior = runtime.drafts.find(scope, toolName, requestId);
    legacyReceipt =
      !prior && !burst && scopedLegacyDelivery(runtime, ctx, scope, requestId);
  }
  const legacyDeliveries =
    !prior && burst ? recordedLegacy(runtime, ctx, scope, items) : undefined;
  if (legacyReceipt) {
    const receipt = await deliverItem(runtime, ctx, toolName, {
      ...items[0].input,
      requestId,
      inputReview,
    });
    const readCheckpoint = repairDeliveryCheckpoint(
      runtime,
      ctx,
      scope,
      requestId,
    );
    return {
      ...receipt,
      actionResult: "sent",
      attemptedThisCall: false,
      ...(readCheckpoint ? { readCheckpoint } : {}),
    };
  }
  if (!prior && ctx.recoveryDeliveryBlocked)
    throw Error("RECOVERY_DELIVERY_BLOCKED");
  const value = { ...(gapMs !== undefined ? { gapMs } : {}) };
  if (!prior) {
    const basis = snapshotReviewInput(
      runtime,
      ctx,
      undefined,
      textReplyEvent(toolName, items[0].input),
    );
    Object.assign(value, {
      baseline: {
        revision: basis.revision,
        ids: basis.items.map(({ id }) => id),
      },
      basis: {
        fromSeq: basis.fromSeq,
        throughSeq: basis.throughSeq,
        count: basis.items.length,
        items: basis.items.slice(0, 30),
      },
      sources: items.flatMap(({ input }) =>
        input.replyEventId ? [{ eventId: input.replyEventId }] : [],
      ),
      ...(checkpointIntent ? { checkpointIntent } : {}),
      ...(ctx.activeIntentId || ctx.scheduleRunId
        ? {
            origin: {
              turnId: ctx.turnId,
              epoch: ctx.inputEpoch,
              intentId: ctx.activeIntentId,
              scheduleRunId: ctx.scheduleRunId,
            },
          }
        : {}),
      ...contextProtection(runtime, ctx),
    });
  }
  let staged;
  try {
    const guard = deliveryGuard(runtime, ctx);
    if (!prior && guard.freshInputSeq)
      for (const { input } of items) {
        const { mediaId, replyTo, atUserId, audioId, fileId } = input;
        const contentKey =
          mediaId || replyTo || atUserId || audioId || fileId
            ? null
            : deliveryContentKey(qqMessage(input).segments);
        if (runtime.drafts.unresolved(scope, { ...guard, mediaId, contentKey }))
          throw Error("QQ_DRAFT_DELIVERY_UNRESOLVED");
      }
    staged = runtime.drafts.stage(scope, {
      requestId,
      toolName,
      items,
      legacyDeliveries,
      creation: {
        items: inputs,
        gapMs: gapMs ?? null,
        readThroughSeq: readThroughSeq ?? null,
      },
      maxOpenDrafts: a.behavior.maxOpenDraftsPerConversation,
      deliveryGuard: guard,
      value,
    });
  } catch (error) {
    if (error.message === "DRAFT_LIMIT_REACHED")
      attachDraftFailure(error, undefined, draftHints(runtime, ctx, 16).items);
    if (error.message === "QQ_DRAFT_DELIVERY_UNRESOLVED")
      for (const item of items)
        if (item.input.mediaId)
          runtime.generatedImages.assertDelivery(ctx, item.input.mediaId);
    throw error;
  }
  const { draft, created, superseded } = staged;
  if (created) runtime.messageTiming?.mark(ctx.messageTimingId, "draftStored");
  if (!created || legacyDeliveries?.size) {
    recallBoundary(runtime, ctx).assert(draft.value);
    if (superseded) {
      const error = Error("QQ_DRAFT_SUPERSEDED");
      attachDraftFailure(error, draftSummary(draft));
      throw error;
    }
    if (burst) return currentOutcome(draft, true);
    const item = draftSummary(draft).items[0];
    if (item.status === "sent") {
      const readCheckpoint =
        !draft.imported &&
        repairDeliveryCheckpoint(runtime, ctx, scope, item.requestId);
      return {
        ...item,
        messageId: item.messageId ?? null,
        duplicate: true,
        actionResult: "sent",
        attemptedThisCall: false,
        ...(readCheckpoint ? { readCheckpoint } : {}),
      };
    }
    const error = Error(
      ["pending", "unknown", "failed"].includes(item.status)
        ? "DELIVERY_ALREADY_ATTEMPTED_" + item.status.toUpperCase()
        : "QQ_DRAFT_CONTINUE_REQUIRED",
    );
    attachDraftFailure(error, draftSummary(draft));
    throw error;
  }
  const binding = draftReviewBinding(draft, checkpointIntent?.checkpoint);
  const grant = inputReview ? null : initialDraftReview(runtime, ctx, binding);
  if (!grant)
    return prepareSavedDraft(runtime, ctx, scope, draft, {
      binding,
      draftRefs: otherDrafts(runtime, ctx, draft.id),
    });
  return runDraft(runtime, ctx, scope, draft, binding, grant);
}

function deliverItem(runtime, ctx, toolName, args, options) {
  if (toolName === "qq_send_voice")
    return sendVoice(runtime, ctx, args, options);
  if (toolName === "qq_send_file") return sendFile(runtime, ctx, args, options);
  return runtime.send(ctx, args, {
    ...options,
    replyEventId: args.replyEventId,
  });
}

function currentOutcome(draft, duplicate = false) {
  const summary = draftSummary(draft);
  const receipts = summary.items
    .filter((item) => item.status === "sent")
    .map(({ requestId, messageId, recordId }) => ({
      status: "sent",
      requestId,
      messageId: messageId ?? null,
      ...(recordId ? { recordId } : {}),
      ...(duplicate ? { duplicate: true } : {}),
    }));
  const status = summary.items.every((item) => item.status === "sent")
    ? "sent"
    : "stopped";
  const statuses = new Set(summary.items.map((item) => item.status));
  return {
    status,
    actionResult: statuses.has("unknown")
      ? "unknown"
      : statuses.has("pending")
        ? "pending"
        : status === "sent"
          ? "sent"
          : receipts.length
            ? "partially_sent"
            : statuses.has("failed")
              ? "failed"
              : "not_sent",
    attemptedThisCall: false,
    draft: summary,
    receipts,
    remaining: summary.items.filter(({ status }) => status === "unsubmitted"),
    ...(status !== "sent" ? { doNotReplay: true } : {}),
  };
}

function blockedReason(code) {
  switch (code) {
    case "AGENT_PAUSED_OR_EXPIRED":
    case "INPUT_EPOCH_CHANGED":
    case "QQ_DRAFT_TURN_EXPIRED":
      return "CONTEXT_CHANGED";
    case "QQ_DRAFT_SOURCE_RECALLED":
    case "UNKNOWN_REPLY_TARGET":
      return "SOURCE_CHANGED";
    case "TOOL_DISABLED":
    case "TOOL_NOT_ALLOWED":
      return "POLICY_CHANGED";
    case "UNSEEN_WATERMARK":
      return "READ_GAP";
    case "QQ_DRAFT_DELIVERY_UNRESOLVED":
    case "RECOVERY_DELIVERY_BLOCKED":
      return "DELIVERY_UNRESOLVED";
    case "QQ_DRAFT_REVISION_CONFLICT":
      return "DRAFT_CHANGED";
    default:
      return code;
  }
}

function assertPreparable(runtime, ctx, scope, draft) {
  assertDraftTool(runtime, ctx, draft.toolName);
  assertDraftIdle(runtime, draft.id);
  const current = runtime.drafts.assertEditable(
    scope,
    draft.id,
    draft.revision,
  );
  if (
    current.items.some(
      ({ status }, index) => status !== draft.items[index].status,
    )
  )
    throw Error("QQ_DRAFT_REVISION_CONFLICT");
  if (
    ctx.recoveryDeliveryBlocked ||
    runtime.drafts.unresolved(scope, {
      ...deliveryGuard(runtime, ctx),
      draftId: draft.id,
    })
  )
    throw Error("QQ_DRAFT_DELIVERY_UNRESOLVED");
  if (!draft.items.some(({ status }) => status === "unsubmitted"))
    throw Error("QQ_DRAFT_SETTLED");
  // Evaluate disclosure on a temporary evidence set. Only real output or
  // submission should write the turn's durable disclosure provenance.
  const evidence = {
    ...ctx,
    privateRead: new Set(ctx.privateRead),
    persistTaint: undefined,
  };
  trackMindRecords(runtime, evidence, [draft.value], "qq-draft");
  assertDraftOrigin(runtime, ctx, draft, evidence);
  for (const item of draft.items)
    if (item.status === "unsubmitted")
      validateDraftInput(runtime, ctx, scope, draft.toolName, item.value, {
        resolving: false,
        evidence,
      });
  runtime.assertDisclosure(evidence);
}

function prepareSavedDraft(
  runtime,
  ctx,
  scope,
  draft,
  {
    readThroughSeq,
    binding,
    reason,
    outcome,
    revisionApplied,
    expectedVersion,
    checkpointFailure,
    draftRefs = [],
  } = {},
) {
  const previous = currentOutcome(draft);
  const result = {
    ...(draft.toolName === "qq_send_burst" ? { status: "stopped" } : {}),
    draft: previous.draft,
    receipts: previous.receipts,
    remaining: previous.remaining,
    actionResult: "not_sent",
    attemptedThisCall: false,
    ...(revisionApplied ? { revisionApplied: true } : {}),
    ...(draftRefs.length
      ? {
          draftRefs,
          draftRefsHint:
            "本聊天还有待处理草稿。可用 qq_draft 按编号和版本继续处理。",
        }
      : {}),
    ...(["pending", "unknown"].includes(previous.actionResult)
      ? { actionResult: previous.actionResult }
      : {}),
    ...outcome,
  };
  try {
    if (checkpointFailure) throw checkpointFailure;
    if (expectedVersion !== undefined && expectedVersion !== draft.revision)
      throw Error("QQ_DRAFT_REVISION_CONFLICT");
    assertPreparable(runtime, ctx, scope, draft);
    const intent = draft.value.checkpointIntent;
    binding ??= draftReviewBinding(
      draft,
      readThroughSeq !== undefined
        ? draftCheckpointIntent(runtime, ctx, readThroughSeq).checkpoint
        : intent?.epoch === ctx.inputEpoch
          ? intent?.checkpoint
          : undefined,
    );
    assertDraftCheckpoint(runtime, ctx, binding.checkpoint);
  } catch (error) {
    const { code, hint, readCheckpoint } = safeToolFailure(error);
    return {
      ...result,
      preparation: {
        state: "blocked",
        reason: blockedReason(code),
        ...(hint ? { hint } : {}),
        ...(readCheckpoint ? { readCheckpoint } : {}),
      },
    };
  }
  return prepareDraftReview(runtime, ctx, result, binding, {
    reason,
    currentReason: () => {
      try {
        assertPreparable(runtime, ctx, scope, draft);
        assertDraftCheckpoint(runtime, ctx, binding.checkpoint);
        return null;
      } catch (error) {
        return blockedReason(safeToolFailure(error).code);
      }
    },
  });
}

async function runDraft(
  runtime,
  ctx,
  scope,
  draft,
  binding,
  grant,
  explicit = false,
) {
  trackMindRecords(runtime, ctx, [draft.value], "qq-draft");
  const execution = claimDraftExecution(
    runtime,
    ctx,
    scope,
    draft,
    binding,
    grant,
  );
  let result, interrupted;
  try {
    result = await deliverDraft(runtime, ctx, scope, draft, execution);
  } catch (error) {
    const saved = runtime.drafts.read(scope, draft.id);
    const facts = currentOutcome(saved);
    const { status, actionResult } = facts;
    if (error instanceof DraftReviewInterrupted) {
      interrupted = { draft: saved, reason: error.reason };
      result = {
        ...facts,
        actionResult: facts.receipts.length ? "partially_sent" : "not_sent",
        attemptedThisCall: execution.reserved,
      };
    } else {
      attachDraftFailure(error, facts.draft);
      const failedIndex = execution.failedIndex;
      if (!explicit && draft.toolName !== "qq_send_burst" && status !== "sent")
        throw error;
      const failure = safeToolFailure(error);
      result =
        status === "sent"
          ? { ...facts, attemptedThisCall: execution.reserved }
          : {
              ...facts,
              attemptedThisCall: execution.reserved,
              failedIndex,
              error: failure.code,
              ...(failure.hint ? { hint: failure.hint } : {}),
              ...(failure.matches ? { matches: failure.matches } : {}),
              ...(explicit && !execution.reserved && actionResult === "not_sent"
                ? {
                    preparation: {
                      state: "blocked",
                      reason: blockedReason(failure.code),
                    },
                  }
                : {}),
            };
    }
  } finally {
    // The old token can only query this execution, never its newly prepared tail.
    releaseDraftExecution(
      runtime,
      ctx,
      execution,
      explicit ? result : undefined,
    );
  }
  if (interrupted)
    return prepareSavedDraft(runtime, ctx, scope, interrupted.draft, {
      binding,
      reason: interrupted.reason,
      outcome: result,
    });
  return result;
}

async function deliverDraft(runtime, ctx, scope, draft, execution) {
  const burst = draft.toolName === "qq_send_burst";
  const receipts = [];
  for (const item of execution.manifest) {
    execution.failedIndex = item.position;
    const a = assertDraftTool(runtime, ctx, draft.toolName);
    if (receipts.length)
      await waitTyping(
        runtime,
        ctx,
        burstDelay(
          qqMessage(item.value).typingText,
          a.behavior,
          runtime.random,
          draft.value.gapMs,
        ),
      );
    const args = validateDraftInput(
      runtime,
      ctx,
      scope,
      draft.toolName,
      item.value,
      { resolving: false },
    );
    const receipt = await deliverItem(
      runtime,
      ctx,
      draft.toolName,
      { ...args, requestId: item.requestId },
      { submission: { execution, item } },
    );
    receipts.push(receipt);
  }
  const saved = runtime.drafts.read(scope, draft.id);
  const facts = currentOutcome(saved);
  return {
    ...facts,
    ...(!burst && receipts.length ? receipts[0] : {}),
    attemptedThisCall: execution.reserved,
  };
}

export async function draftTool(runtime, ctx, _toolName, args) {
  const scope = draftScope(runtime, ctx);
  const boundary = recallBoundary(runtime, ctx);
  if (args.action === "list") {
    const page = runtime.drafts.list(scope, {
      offset: args.offset,
      includeSettled: args.includeSettled,
    });
    return {
      ...page,
      items: page.items
        .filter(
          ({ toolName, value }) =>
            canUseDraftTool(runtime.agent(ctx.agentId), toolName) &&
            (!ctx.allowedTools || ctx.allowedTools.includes(toolName)) &&
            boundary.allowed(value),
        )
        .map(({ id }) => draftSummary(runtime.drafts.read(scope, id))),
    };
  }
  const draft = runtime.drafts.read(scope, args.draftId);
  assertDraftTool(runtime, ctx, draft.toolName);
  boundary.assert(draft.value);
  if (args.action === "read") {
    trackMindRecords(runtime, ctx, [draft.value], "qq-draft");
    const item =
      draft.items[
        args.position ??
          draft.items.findIndex(({ status }) => status === "unsubmitted")
      ] ?? draft.items[0];
    if (args.position !== undefined && !draft.items[args.position])
      throw Error("QQ_DRAFT_INVALID");
    return {
      ...draftSummary(draft),
      input: { index: item.position, ...item.value },
    };
  }
  if (args.action === "discard" || args.action === "revise")
    assertDraftIdle(runtime, draft.id);
  if (args.action === "discard")
    return draftSummary(
      runtime.drafts.discard(scope, draft.id, args.expectedVersion),
    );
  if (args.action === "revise") {
    trackMindRecords(runtime, ctx, [draft.value], "qq-draft");
    runtime.drafts.assertEditable(scope, draft.id, args.expectedVersion);
    const input = validateDraftInput(
      runtime,
      ctx,
      scope,
      draft.toolName,
      args.input,
    );
    runtime.assertDisclosure(ctx);
    let checkpointIntent, checkpointFailure;
    if (args.readThroughSeq !== undefined) {
      try {
        checkpointIntent = draftCheckpointIntent(
          runtime,
          ctx,
          args.readThroughSeq,
        );
      } catch (error) {
        checkpointIntent = null;
        checkpointFailure = error;
      }
    }
    const revised = runtime.drafts.revise(
      scope,
      draft.id,
      args.expectedVersion,
      [{ position: args.position, input }],
      mergeProtection(contextProtection(runtime, ctx), draft.value),
      checkpointIntent,
    );
    runtime.messageTiming?.mark(ctx.messageTimingId, "draftStored");
    return prepareSavedDraft(runtime, ctx, scope, revised, {
      revisionApplied: true,
      checkpointFailure,
    });
  }
  if (args.action === "prepare" || !args.inputReview)
    return prepareSavedDraft(runtime, ctx, scope, draft, args);

  const facts = currentOutcome(draft);
  const unresolved = ["unknown", "pending"].includes(facts.actionResult)
    ? { actionResult: facts.actionResult }
    : undefined;
  if (args.expectedVersion !== draft.revision)
    return prepareSavedDraft(runtime, ctx, scope, draft, {
      ...args,
      outcome: unresolved,
    });

  const binding = draftReviewBinding(draft);
  const validated = validateDraftGrant(runtime, ctx, binding, args.inputReview);
  if (validated.replay) {
    if (activeDraftExecution(runtime, draft.id)?.id === validated.replay)
      return {
        ...facts,
        status: "pending",
        actionResult: "pending",
        doNotReplay: true,
      };
    const replay = replayDraftExecution(ctx, validated.replay);
    if (replay) return { ...replay, attemptedThisCall: false, duplicate: true };
  }
  if (!validated.grant)
    return prepareSavedDraft(runtime, ctx, scope, draft, {
      reason: validated.reason,
      outcome: unresolved,
    });
  binding.checkpoint = validated.grant.checkpoint;
  try {
    assertPreparable(runtime, ctx, scope, draft);
    assertDraftCheckpoint(runtime, ctx, binding.checkpoint);
  } catch (error) {
    const { code } = safeToolFailure(error);
    return {
      ...facts,
      preparation: { state: "blocked", reason: blockedReason(code) },
    };
  }
  return runDraft(runtime, ctx, scope, draft, binding, validated.grant, true);
}
