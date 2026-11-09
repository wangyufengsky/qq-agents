import { createHash } from "node:crypto";
import { z } from "zod";
import { mergeProtection } from "../memory/protection.mjs";
import {
  assertDraftTool,
  canUseDraftTool,
  validateDraftInput,
} from "../core/draft-input.mjs";
import {
  assertDraftIdle,
  assertDraftOrigin,
  claimDraftExecution,
  draftCheckpointIntent,
  draftScope,
  releaseDraftExecution,
  repairDeliveryCheckpoint,
  rotateDraftReview,
} from "../core/draft-delivery.mjs";
import {
  attachReviewOriginals,
  snapshotReviewInput,
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
export const draftDefinitions = {
  qq_draft: [
    "查看当前聊天保存的待发草稿。list 列编号，read 按 position 展开一项，revise 修改未提交项，discard 放弃剩余未提交项，continue 明确核对并继续。修改、放弃和继续须填当前 expectedVersion。已发不重发，未知先核对，重启不会续发。读完新增输入后，用回执令牌继续该版本。",
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
        })
        .strict(),
      z.object({ action: z.literal("discard"), ...ref }).strict(),
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

function response(draft, { duplicate = false } = {}) {
  const summary = draftSummary(draft);
  const receipts = summary.items
    .filter((item) => item.status === "sent")
    .map((item) => ({
      status: "sent",
      requestId: item.requestId,
      messageId: item.messageId ?? null,
      ...(item.recordId ? { recordId: item.recordId } : {}),
      ...(duplicate ? { duplicate: true } : {}),
    }));
  return draft.items.every((item) => item.status === "sent")
    ? { status: "sent", receipts, draft: summary }
    : {
        status: "stopped",
        receipts,
        error: "QQ_DRAFT_CONTINUE_REQUIRED",
        draft: summary,
        doNotReplay: true,
      };
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
  const checkpointIntent =
    !prior && !legacyReceipt && readThroughSeq !== undefined
      ? draftCheckpointIntent(runtime, ctx, readThroughSeq)
      : undefined;
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
      receipts: [],
      failedIndex: 0,
      error: code,
      hint,
      doNotReplay: true,
    };
  }
  const pending = !prior && runtime.drafts.unresolved(scope);
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
    return readCheckpoint ? { ...receipt, readCheckpoint } : receipt;
  }
  if (!prior && ctx.recoveryDeliveryBlocked)
    throw Error("RECOVERY_DELIVERY_BLOCKED");
  const value = { ...(gapMs !== undefined ? { gapMs } : {}) };
  if (!prior) {
    const basis = snapshotReviewInput(runtime, ctx);
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
    if (burst) return response(draft, { duplicate: true });
    const item = draftSummary(draft).items[0];
    if (item.status === "sent") {
      const readCheckpoint =
        !draft.imported &&
        repairDeliveryCheckpoint(runtime, ctx, scope, item.requestId);
      return {
        ...item,
        messageId: item.messageId ?? null,
        duplicate: true,
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
  return runDraft(runtime, ctx, scope, draft, inputReview);
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

async function runDraft(
  runtime,
  ctx,
  scope,
  draft,
  inputReview,
  { explicit = false } = {},
) {
  const { execution, active, replay } = claimDraftExecution(
    runtime,
    ctx,
    scope,
    draft,
    inputReview,
    explicit,
  );
  if (active || replay) {
    const current = response(runtime.drafts.read(scope, draft.id), {
      duplicate: true,
    });
    if (!active) return current;
    return {
      status: "pending",
      draft: current.draft,
      receipts: current.receipts,
      doNotReplay: true,
    };
  }
  try {
    if (explicit) assertDraftOrigin(runtime, ctx, draft);
    if (runtime.drafts.unresolved(scope))
      throw Error("QQ_DRAFT_DELIVERY_UNRESOLVED");
    return await deliverDraft(runtime, ctx, scope, draft, execution);
  } finally {
    releaseDraftExecution(runtime, execution);
  }
}

async function deliverDraft(runtime, ctx, scope, draft, execution) {
  const burst = draft.toolName === "qq_send_burst";
  const receipts = [];
  for (const item of execution.manifest) {
    try {
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
        {
          resolving: false,
        },
      );
      const receipt = await deliverItem(
        runtime,
        ctx,
        draft.toolName,
        {
          ...args,
          requestId: item.requestId,
          inputReview: execution.inputReview,
        },
        {
          submission: { execution, item },
        },
      );
      receipts.push(receipt);
    } catch (error) {
      const saved = response(runtime.drafts.read(scope, draft.id));
      attachDraftFailure(error, saved.draft);
      if (!burst) throw error;
      rotateDraftReview(execution);
      attachReviewOriginals(runtime, ctx, error);
      const failure = safeToolFailure(error);
      const result = {
        status: "stopped",
        receipts: saved.receipts,
        failedIndex: item.position,
        error: failure.code,
        hint: failure.hint,
        ...(failure.matches ? { matches: failure.matches } : {}),
        ...(failure.inputReview ? { inputReview: failure.inputReview } : {}),
        draft: saved.draft,
        doNotReplay: true,
      };
      runtime.stageToolInput(ctx, result, () =>
        runtime.commitToolInput(ctx, error),
      );
      return result;
    }
  }
  const saved = runtime.drafts.read(scope, draft.id);
  if (!burst && receipts.length)
    return { ...receipts[0], draft: draftSummary(saved) };
  return response(saved);
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
  trackMindRecords(runtime, ctx, [draft.value], "qq-draft");
  if (args.action === "read") {
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
  runtime.drafts.assertEditable(scope, draft.id, args.expectedVersion);
  if (args.action === "revise") {
    const input = validateDraftInput(
      runtime,
      ctx,
      scope,
      draft.toolName,
      args.input,
    );
    runtime.assertDisclosure(ctx);
    const revised = runtime.drafts.revise(
      scope,
      draft.id,
      args.expectedVersion,
      [{ position: args.position, input }],
      mergeProtection(contextProtection(runtime, ctx), draft.value),
    );
    runtime.messageTiming?.mark(ctx.messageTimingId, "draftStored");
    return draftSummary(revised);
  }
  return runDraft(runtime, ctx, scope, draft, args.inputReview, {
    explicit: true,
  });
}
