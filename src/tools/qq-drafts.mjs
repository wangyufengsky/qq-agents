import { createHash } from "node:crypto";
import { z } from "zod";
import {
  assertMessageAccount,
  resolveMessage,
} from "../memory/message-ids.mjs";
import { mergeProtection } from "../memory/protection.mjs";
import { draftScope } from "../core/draft-delivery.mjs";
import {
  attachReviewOriginals,
  snapshotReviewInput,
} from "../core/input-review.mjs";
import { liveInput } from "../core/live-input.mjs";
import {
  contextProtection,
  trackMindRecords,
} from "../core/protected-mind.mjs";
import { recallBoundary } from "../core/recall-boundary.mjs";
import { burstDelay, waitTyping } from "../core/typing.mjs";
import { attachDraftFailure, safeToolFailure } from "./errors.mjs";
import { fileName } from "./files.mjs";
import { sendFile } from "./file-tools.mjs";
import { inputReviewSchema } from "./input-review.mjs";
import { sendVoice } from "./legacy.mjs";
import { qqMessage, qqSegmentsSchema } from "./qq-message.mjs";

export function canUseDraftTool(agent, tool) {
  return (
    ["qq_send", "qq_send_burst", "qq_send_voice", "qq_send_file"].includes(
      tool,
    ) &&
    agent.tools.includes(tool) &&
    (tool !== "qq_send_file" || (agent.files.enabled && agent.files.send))
  );
}

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

function permitted(runtime, ctx, toolName) {
  const agent = runtime.assertActive(ctx);
  if (
    !/^(private|group):\d+$/.test(ctx.conversation) ||
    !canUseDraftTool(agent, toolName) ||
    (ctx.allowedTools && !ctx.allowedTools.includes(toolName))
  )
    throw Error("TOOL_DISABLED");
  return agent;
}

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

export function draftHints(runtime, ctx) {
  const scope = draftScope(runtime, ctx);
  const agent = runtime.agent(ctx.agentId);
  const boundary = recallBoundary(runtime, ctx);
  const entries = runtime.drafts.list(scope, { limit: 10 });
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

function safeInput(runtime, ctx, toolName, input, { resolving = true } = {}) {
  const a = permitted(runtime, ctx, toolName);
  const scope = draftScope(runtime, ctx);
  const mem = runtime.memory.bind(a.id);
  const boundary = recallBoundary(runtime, ctx);
  runtime.assertSafeOutput(ctx, JSON.stringify(input));

  if (toolName === "qq_send_voice" || toolName === "qq_send_file") {
    const file = toolName === "qq_send_file";
    if (file ? !input.fileId : !input.audioId) throw Error("QQ_DRAFT_INVALID");
    const lib = file ? runtime.files : runtime.voices;
    if (!lib)
      throw Error(file ? "FILE_LIBRARY_UNAVAILABLE" : "VOICE_UNAVAILABLE");
    const meta = lib.metadata(a.id, file ? input.fileId : input.audioId);
    boundary.assert(meta);
    trackMindRecords(runtime, ctx, [meta], "draft-media");
    if (!file) {
      runtime.assertSafeOutput(ctx, meta.title || "");
      return input;
    }
    if (meta.bytes > a.files.maxBytes) throw Error("FILE_TOO_LARGE");
    const name = fileName(input.name || meta.name);
    runtime.assertSafeOutput(ctx, name);
    return { fileId: input.fileId, name };
  }

  if (input.audioId || input.fileId) throw Error("QQ_DRAFT_INVALID");
  const burst = toolName === "qq_send_burst";
  if (burst && (input.replyTo || input.atUserId || input.mediaId))
    throw Error("QQ_DRAFT_INVALID");
  const message = qqMessage(input, burst ? 2000 : 8000);
  for (const part of [message.sourceText, message.text, message.body])
    runtime.assertSafeOutput(ctx, part);
  if (!message.segments.length && !input.mediaId) throw Error("EMPTY_MESSAGE");
  if (input.atUserId && !/^\d+$/.test(input.atUserId))
    throw Error("INVALID_PERSON");
  if (input.mediaId) {
    if (!runtime.media) throw Error("MEDIA_UNAVAILABLE");
    const meta = runtime.media.metadata(a.id, input.mediaId);
    boundary.assert(meta);
    trackMindRecords(runtime, ctx, [meta], "draft-media");
  }
  if (!input.replyTo) return input;
  assertMessageAccount(mem, scope.connectionId, scope.accountId);
  const row = resolving
    ? resolveMessage(mem.db, scope, input.replyTo)
    : mem.db
        .prepare(
          `SELECT * FROM events WHERE id=? AND agent_id=? AND connection_id=? AND conversation=?`,
        )
        .get(
          input.replyEventId,
          scope.agentId,
          scope.connectionId,
          scope.conversation,
        );
  if (!row) throw Error("UNKNOWN_REPLY_TARGET");
  const source = mem.event(row, ctx.conversation);
  boundary.assert(source);
  if (
    source.recalled ||
    (row.kind === "message.received" &&
      row.origin === "live" &&
      JSON.parse(row.payload).trustedInput === true &&
      !liveInput(runtime, a.id, ctx.conversation, row.id))
  )
    throw Error("QQ_DRAFT_SOURCE_RECALLED");
  trackMindRecords(runtime, ctx, [source], "draft-reply");
  return { ...input, replyEventId: row.id };
}

function response(draft, { duplicate = false } = {}) {
  const summary = draftSummary(draft);
  const receipts = summary.items
    .filter((item) => item.status === "sent")
    .map((item) => ({
      status: "sent",
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

function recordedLegacy(runtime, scope, items) {
  const mem = runtime.memory.bind(scope.agentId);
  const found = new Set();
  for (const item of items) {
    const row = mem.delivery(item.requestId);
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

export async function sendDraftTool(
  runtime,
  ctx,
  toolName,
  args,
  { onReserve } = {},
) {
  const a = permitted(runtime, ctx, toolName);
  const scope = draftScope(runtime, ctx);
  const burst = toolName === "qq_send_burst";
  const {
    requestId,
    inputReview,
    readThroughSeq: _checkpoint,
    gapMs,
    messages,
    ...input
  } = args;
  if (burst && requestId.length > 198) throw Error("INVALID_REQUEST_ID");
  if (burst && messages.length > a.behavior.burstMax)
    throw Error("BURST_LIMIT");
  const inputs = burst
    ? messages.map((message) =>
        typeof message === "string" ? { text: message } : message,
      )
    : [input];
  const items = inputs.map((part, index) => ({
    requestId: burst ? requestId + ":" + index : requestId,
    input: safeInput(runtime, ctx, toolName, part),
  }));
  try {
    runtime.subject.beforeDelivery(ctx);
    runtime.assertDisclosure(ctx);
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
  const pending = runtime.drafts.unresolved(scope);
  if (pending?.status === "pending") {
    const chain = runtime.delivery.conversations.get(
      scope.connectionId + "|" + ctx.conversation,
    );
    if (chain) await chain.catch(() => {});
    permitted(runtime, ctx, toolName);
  }
  const legacyDeliveries = burst
    ? recordedLegacy(runtime, scope, items)
    : undefined;
  if (
    !burst &&
    !runtime.drafts.find(scope, toolName, requestId) &&
    runtime.memory.bind(a.id).delivery(requestId)
  )
    return deliverItem(
      runtime,
      ctx,
      toolName,
      { ...items[0].input, requestId, inputReview },
      { onReserve },
    );
  const baseline = {
    readSeq: ctx.reviewReadSeq || 0,
    sentSeq: ctx.reviewSentSeq || 0,
  };
  if (
    !runtime.drafts.find(scope, toolName, requestId) &&
    ctx.recoveryDeliveryBlocked
  )
    throw Error("RECOVERY_DELIVERY_BLOCKED");
  for (const item of items)
    if (item.input.mediaId)
      runtime.generatedImages.assertDelivery(
        ctx,
        item.input.mediaId,
        item.requestId,
      );
  const basis = snapshotReviewInput(runtime, ctx, baseline);
  const { draft, created } = runtime.drafts.stage(scope, {
    requestId,
    toolName,
    items,
    legacyDeliveries,
    value: {
      ...(gapMs !== undefined ? { gapMs } : {}),
      baseline,
      basis: {
        fromSeq: basis.fromSeq,
        throughSeq: basis.throughSeq,
        count: basis.items.length,
        items: basis.items.slice(0, 30),
      },
      sources: items.flatMap(({ input }) =>
        input.replyEventId ? [{ eventId: input.replyEventId }] : [],
      ),
      ...(ctx.activeIntentId || ctx.scheduleRunId
        ? {
            origin: {
              turnId: ctx.turnId,
              intentId: ctx.activeIntentId,
              scheduleRunId: ctx.scheduleRunId,
            },
          }
        : {}),
      ...contextProtection(runtime, ctx),
    },
  });
  if (created) runtime.messageTiming?.mark(ctx.messageTimingId, "draftStored");
  if (!created || legacyDeliveries?.size) {
    if (burst) return response(draft, { duplicate: true });
    const item = draftSummary(draft).items[0];
    if (item.status === "sent")
      return { ...item, messageId: item.messageId ?? null, duplicate: true };
    const error = Error(
      ["pending", "unknown", "failed"].includes(item.status)
        ? "DELIVERY_ALREADY_ATTEMPTED_" + item.status.toUpperCase()
        : "QQ_DRAFT_CONTINUE_REQUIRED",
    );
    attachDraftFailure(error, draftSummary(draft));
    throw error;
  }
  return runDraft(runtime, ctx, scope, draft, inputReview, { onReserve });
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
  { onReserve, explicit = false } = {},
) {
  const remaining = draft.items.filter((item) => item.status === "unsubmitted");
  const burst = draft.toolName === "qq_send_burst";
  const receipts = [];
  let snapshotHash;
  for (const item of remaining) {
    try {
      const a = permitted(runtime, ctx, draft.toolName);
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
      const args = safeInput(runtime, ctx, draft.toolName, item.value, {
        resolving: false,
      });
      const receipt = await deliverItem(
        runtime,
        ctx,
        draft.toolName,
        { ...args, requestId: item.requestId, inputReview },
        {
          reviewIntent: {
            draftId: draft.id,
            version: draft.revision,
            content: draft.items.map(({ revision, requestId }) => [
              revision,
              requestId,
            ]),
          },
          reviewOptions: {
            key: draft.id,
            baseline: draft.value.baseline,
            explicit,
            expected: snapshotHash,
          },
          onReserve: (requestId, reviewed) => {
            safeInput(runtime, ctx, draft.toolName, item.value, {
              resolving: false,
            });
            runtime.assertDisclosure(ctx);
            assertOrigin(runtime, ctx, draft);
            runtime.drafts.bindDelivery(
              scope,
              {
                id: draft.id,
                revision: draft.revision,
                position: item.position,
              },
              requestId,
            );
            snapshotHash = reviewed?.snapshotHash;
            onReserve?.(requestId);
          },
        },
      );
      receipts.push(receipt);
    } catch (error) {
      const saved = draftSummary(runtime.drafts.read(scope, draft.id));
      attachDraftFailure(error, saved);
      if (!burst) throw error;
      attachReviewOriginals(runtime, ctx, error);
      const failure = safeToolFailure(error);
      return {
        status: "stopped",
        receipts,
        failedIndex: item.position,
        error: failure.code,
        hint: failure.hint,
        ...(failure.matches ? { matches: failure.matches } : {}),
        ...(failure.inputReview ? { inputReview: failure.inputReview } : {}),
        draft: saved,
        doNotReplay: true,
      };
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
  permitted(runtime, ctx, draft.toolName);
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
  if (args.action === "discard")
    return draftSummary(
      runtime.drafts.discard(scope, draft.id, args.expectedVersion),
    );
  runtime.drafts.assertEditable(scope, draft.id, args.expectedVersion);
  if (args.action === "revise") {
    const input = safeInput(runtime, ctx, draft.toolName, args.input);
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
  assertOrigin(runtime, ctx, draft);
  if (runtime.drafts.unresolved(scope))
    throw Error("QQ_DRAFT_DELIVERY_UNRESOLVED");
  return runDraft(runtime, ctx, scope, draft, args.inputReview, {
    explicit: true,
  });
}

function assertOrigin(runtime, ctx, draft) {
  const origin = draft.value.origin;
  if (
    origin &&
    (!origin.turnId ||
      origin.turnId !== ctx.turnId ||
      origin.intentId !== ctx.activeIntentId ||
      origin.scheduleRunId !== ctx.scheduleRunId)
  )
    throw Error("QQ_DRAFT_TURN_EXPIRED");
  runtime.subject.beforeDelivery(ctx);
}
