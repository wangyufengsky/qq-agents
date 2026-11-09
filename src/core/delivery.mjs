import { assertHomeSceneMedia } from "../home/scene-media.mjs";
import { assertNoSocialDisclosure } from "./social-protection.mjs";
import { peerQzoneSources } from "./peer-qzone-protection.mjs";
import {
  assertDraftReview,
  DraftReviewInterrupted,
  assertInputReviewed,
} from "./input-review.mjs";
import { timedDeliveryFailure } from "./message-timing-runtime.mjs";
import {
  applyDeliveryCheckpoint,
  bindSubmission,
  draftScope,
  recoverDraftArchives,
} from "./draft-delivery.mjs";
import { recallBoundary } from "./recall-boundary.mjs";
import { containsCredential } from "./secrets.mjs";
import { beforeShareDelivery } from "../apps/sharing.mjs";
import { appService } from "../apps/tools.mjs";
import { privateGithubSources } from "../github/policy.mjs";
import { taintMedia } from "../tools/legacy.mjs";
import { qqMessage } from "../tools/qq-message.mjs";
import { checkTone } from "./tone-check.mjs";
import { checkSendBudget, reserveSendBudget } from "./send-budget.mjs";
import { replyPeers, peerReplyLastAttemptAt } from "./peer-replies.mjs";
import {
  resolveMessage,
  gatewayMessageId,
  assertMessageAccount,
} from "../memory/message-ids.mjs";

// What a reply could rest on when it left: the card of the person it
// addresses (the one at-mentioned, else the private peer) and the mood then in
// effect. References only, so a later look can tell a wrong address or tone
// from a card or mood that was itself wrong.
function sendBasis(mem, conversation, atUserId, now) {
  const personId = atUserId
    ? String(atUserId)
    : /^private:(\d+)$/.exec(conversation)?.[1];
  const card = personId ? mem.identity.personCard(personId) : null,
    mood = mem.identity.currentMood(now);
  return {
    ...(card
      ? {
          personCard: {
            id: card.id,
            personId: card.personId,
            revision: card.revision,
          },
        }
      : {}),
    ...(mood ? { moodId: mood.id } : {}),
  };
}

// Serializes deliveries per connection, and commits budget, outbox and receipts.
export class DeliveryService {
  constructor(runtime) {
    this.runtime = runtime;
    this.chains = new Map();
    this.queues = new Map();
    this.conversations = new Map();
    this.reconciled = new Set();
  }
  async send(
    ctx,
    {
      requestId,
      text,
      segments: requestedSegments,
      replyTo,
      atUserId,
      mediaId,
      inputReview,
    },
    { archiveBody, submission, replyEventId } = {},
  ) {
    const runtime = this.runtime;
    const a = runtime.assertActive(ctx),
      mem = runtime.memory.bind(a.id);
    if (runtime.protectedWork?.context(ctx))
      throw Error("PROTECTED_WORK_OUTBOUND_DENIED");
    assertNoSocialDisclosure(runtime, ctx);
    runtime.assertDisclosure(ctx);
    if (!text && requestedSegments === undefined && !mediaId)
      throw Error("INVALID_MESSAGE");
    const message = qqMessage({ text, segments: requestedSegments });
    runtime.assertSafeOutput(ctx, message.sourceText);
    text = message.text;
    runtime.assertSafeOutput(ctx, text);
    runtime.assertSafeOutput(ctx, message.body);
    if (!message.segments.length && !mediaId) throw Error("EMPTY_MESSAGE");
    // Existing receipts must retain their duplicate/conflict/unknown semantics;
    // only a new valid request can receive a pre-delivery wording reminder.
    if (
      typeof requestId === "string" &&
      requestId &&
      requestId.length <= 200 &&
      !mem.delivery(requestId)
    )
      checkTone(ctx, a, requestId, text);
    const segments = [];
    const connection = runtime.connection(a.connectionId),
      namespace = connection.messageIdNamespace || "onebot",
      requestedReplyTo = replyTo;
    assertMessageAccount(mem, a.connectionId, connection.accountId);
    if (replyTo) {
      const scope = {
        agentId: a.id,
        connectionId: a.connectionId,
        conversation: ctx.conversation,
      };
      const own = replyEventId
        ? mem.db
            .prepare(
              "SELECT * FROM events WHERE id=? AND agent_id=? AND connection_id=? AND conversation=?",
            )
            .get(
              replyEventId,
              scope.agentId,
              scope.connectionId,
              scope.conversation,
            )
        : resolveMessage(mem.db, scope, replyTo);
      if (!own) throw Error("UNKNOWN_REPLY_TARGET");
      replyTo = gatewayMessageId(
        mem.db,
        scope,
        own,
        namespace,
        connection.accountId,
      );
      segments.push({ type: "reply", data: { id: String(replyTo) } });
    }
    if (atUserId) {
      if (!/^\d+$/.test(String(atUserId))) throw Error("INVALID_PERSON");
      segments.push({ type: "at", data: { qq: String(atUserId) } });
    }
    segments.push(...message.segments);
    if (mediaId) {
      if (!runtime.media) throw Error("MEDIA_UNAVAILABLE");
      const meta = runtime.media.metadata(a.id, mediaId);
      recallBoundary(runtime, ctx).assert(meta);
      taintMedia(ctx, meta);
      segments.push(runtime.media.segment(a.id, mediaId));
    }
    return this.deliver(ctx, {
      requestId,
      intent: segments,
      body: archiveBody ?? message.body,
      inputReview,
      submission,
      metadata: {
        replyTo,
        requestedReplyTo,
        referenceNamespace: namespace,
        atUserId,
        mediaId,
        ...(requestedSegments !== undefined
          ? {
              // Media bytes already live in the owned media store, not in
              // replayable chat metadata or model-readable history payloads.
              segments: segments.map((part) =>
                part.type === "image"
                  ? { type: "image", data: { mediaId } }
                  : part,
              ),
            }
          : {}),
        // Fixed control text is not worded from a card or a mood.
        ...(ctx.internalDelivery
          ? {}
          : sendBasis(mem, ctx.conversation, atUserId, runtime.now())),
      },
      send: (transport) => transport.send(ctx.conversation, segments),
    });
  }
  async deliver(ctx, operation) {
    const runtime = this.runtime;
    const a = runtime.assertActive(ctx);
    const capture = runtime.messageTiming;
    const timingId = ctx.messageTimingId;
    let timingIndex;
    if (
      timingId !== undefined &&
      !ctx.internalDelivery &&
      ![
        "recall",
        "profile",
        "qzone",
        "official-collect",
        "official-remark",
      ].includes(operation.actionBudget?.kind || operation.intent?.kind)
    ) {
      timingIndex = capture.startDelivery(timingId);
      if (timingIndex !== undefined) operation = { ...operation, timingIndex };
    }
    ctx.pendingDeliveries = (ctx.pendingDeliveries || 0) + 1;
    // Drain tracking includes media preparation, before acquiring the connection queue.
    const previous = this.chains.get(a.connectionId);
    const key = a.connectionId + "|" + ctx.conversation;
    const priorConversation = this.conversations.get(key);
    // Preserve call order within a chat, without holding other chats behind preparation.
    const result = priorConversation
      ? priorConversation
          .catch(() => {})
          .then(() => this.enqueue(ctx, operation))
      : this.enqueue(ctx, operation);
    this.conversations.set(key, result);
    const drained = Promise.allSettled([previous, result]);
    this.chains.set(a.connectionId, drained);
    drained.then(() => {
      if (this.chains.get(a.connectionId) === drained)
        this.chains.delete(a.connectionId);
    });
    try {
      const receipt = await result;
      if (receipt?.duplicate)
        capture?.finishDelivery(timingId, timingIndex, "duplicate");
      return receipt;
    } catch (error) {
      capture?.finishDelivery(
        timingId,
        timingIndex,
        error instanceof DraftReviewInterrupted
          ? "review-required"
          : timedDeliveryFailure(error),
      );
      throw error;
    } finally {
      ctx.pendingDeliveries--;
      if (!ctx.pendingDeliveries && ctx.messageTimingTerminal)
        capture?.finishTurn(
          timingId,
          ctx.messageTimingTerminal,
          ctx.messageTimingToolOutcome,
        );
      if (this.conversations.get(key) === result)
        this.conversations.delete(key);
    }
  }
  review(ctx, operation, checked) {
    if (
      ctx.internalDelivery ||
      checked.contactFreeAction ||
      ["official-collect", "official-remark"].includes(operation.intent?.kind)
    )
      return undefined;
    const execution = operation.submission?.execution;
    if (execution)
      return assertDraftReview(
        this.runtime,
        ctx,
        execution.binding,
        execution.grant,
      );
    return assertInputReviewed(
      this.runtime,
      ctx,
      checked.requestId,
      operation.reviewIntent ?? operation.intent,
      operation.inputReview,
    );
  }
  async enqueue(ctx, operation) {
    const capture =
      operation.timingIndex === undefined
        ? undefined
        : this.runtime.messageTiming;
    capture?.markDelivery(
      ctx.messageTimingId,
      operation.timingIndex,
      "conversationReady",
    );
    const checked = this.checkDelivery(ctx, operation, { beforeQueue: true });
    if (!checked.receipt) {
      // Existing authorization and budget denials take precedence over a
      // review challenge. Preparation can itself be expensive or use QQ.
      let reviewError;
      try {
        this.review(ctx, operation, checked);
      } catch (error) {
        reviewError = error;
      }
      if (reviewError || operation.prepare) {
        const { state, now, transport } = this.checkSendPolicy(
          ctx,
          operation,
          checked,
        );
        checkSendBudget(
          checked.mem,
          checked.a.behavior,
          state.sendTimes,
          now,
          !this.reconciled.has(checked.a.id),
        );
        if (reviewError) throw reviewError;
        const started = capture?.clock();
        try {
          operation = {
            ...operation,
            prepared: await operation.prepare(transport),
          };
        } finally {
          if (started !== undefined)
            capture.interval(
              ctx.messageTimingId,
              "preparation",
              started,
              capture.clock(),
            );
        }
      }
    }
    const a = this.runtime.assertActive(ctx);
    const previous = this.queues.get(a.connectionId);
    capture?.markDelivery(
      ctx.messageTimingId,
      operation.timingIndex,
      "queueEntered",
    );
    const result = previous
      ? previous.catch(() => {}).then(() => this.deliverNow(ctx, operation))
      : this.deliverNow(ctx, operation);
    this.queues.set(a.connectionId, result);
    try {
      return await result;
    } finally {
      if (this.queues.get(a.connectionId) === result)
        this.queues.delete(a.connectionId);
    }
  }
  checkDelivery(
    ctx,
    {
      requestId,
      intent,
      body = "",
      metadata = {},
      action = false,
      actionBudget,
    },
    { beforeQueue = false } = {},
  ) {
    const runtime = this.runtime;
    const a = runtime.assertActive(ctx);
    const mem = runtime.memory.bind(a.id);
    assertMessageAccount(
      mem,
      a.connectionId,
      runtime.connection(a.connectionId).accountId,
    );
    if (mem.state(ctx.conversation).silenceUntil > runtime.now())
      throw Error("CONVERSATION_SILENCED");
    // Recall only removes an already-confirmed message, and a profile change
    // or QQ Zone post contacts nobody (both are also allowed in free time). A completed contact
    // intent must not prevent either; fresh outward actions still need the
    // ordinary intent decision and contact checks.
    const contactFreeAction =
      action && ["recall", "profile", "qzone"].includes(actionBudget?.kind);
    const proactive = contactFreeAction
      ? null
      : runtime.subject.beforeDelivery(ctx);
    if (proactive) requestId = "intent:" + proactive.id;
    if (typeof requestId !== "string" || !requestId || requestId.length > 200)
      throw Error("INVALID_REQUEST_ID");
    assertNoSocialDisclosure(runtime, ctx);
    runtime.assertDisclosure(ctx);
    beforeShareDelivery(appService(runtime), ctx, metadata);
    const serialized = JSON.stringify(intent);
    if (serialized.includes(ctx.token) || containsCredential(body))
      throw Error("SENSITIVE_OUTPUT_BLOCKED");
    const previous = mem.delivery(requestId);
    if (previous) {
      // An in-flight receipt may settle before our queue slot; skip preparation here.
      if (beforeQueue) return { receipt: previous };
      mem.reserveDelivery(requestId, ctx.conversation, intent);
      if (previous.status === "sent")
        return {
          receipt: {
            status: "sent",
            messageId: previous.message_id,
            duplicate: true,
          },
        };
      throw Error(
        "DELIVERY_ALREADY_ATTEMPTED_" + previous.status.toUpperCase(),
      );
    }
    // Recovery must not evade a sent/unknown/failed receipt by changing the
    // request ID, wording, media, action or target. Same-ID receipt reads above
    // remain available; new deliveries are fenced for this continuation.
    if (ctx.recoveryDeliveryBlocked) throw Error("RECOVERY_DELIVERY_BLOCKED");
    this.assertDraftDelivery(ctx, contactFreeAction);
    if (metadata.mediaId) {
      assertHomeSceneMedia(
        runtime,
        ctx,
        runtime.media.metadata(a.id, metadata.mediaId),
        { sharing: true },
      );
      runtime.generatedImages.assertDelivery(ctx, metadata.mediaId, requestId);
    }
    return { a, mem, proactive, requestId, contactFreeAction };
  }
  assertDraftDelivery(ctx, contactFreeAction) {
    if (
      !contactFreeAction &&
      this.runtime.drafts.unresolved(draftScope(this.runtime, ctx))
    )
      throw Error("QQ_DRAFT_DELIVERY_UNRESOLVED");
  }
  checkSendPolicy(ctx, operation, { a, mem, proactive }) {
    const { actionBudget, validate } = operation;
    const runtime = this.runtime;
    validate?.();
    const state = mem.state(ctx.conversation),
      now = runtime.now();
    const batchUsed = proactive
      ? 0
      : ctx.internalDelivery
        ? ctx.sendCount
        : ctx.scheduleRunId
          ? state.scheduleReplyCounts?.[ctx.scheduleRunId] || 0
          : state.replyBatchSends || 0;
    const ordinaryPeer =
      !proactive &&
      !ctx.internalDelivery &&
      !ctx.scheduleRunId &&
      replyPeers(runtime, ctx).length > 0 &&
      (ctx.conversation.startsWith("private:") ||
        state.replyBatchPeer === true);
    const batchLimit = Math.min(
      a.maxConsecutiveSends ?? a.maxSendsPerTurn,
      ordinaryPeer ? runtime.config.peerLimit.maxMessages : Infinity,
    );
    if (!actionBudget && batchUsed >= batchLimit)
      throw Error("REPLY_BURST_LIMIT");
    if (actionBudget) {
      for (const [duration, limit] of [
        [60000, actionBudget.maxPerMinute],
        [3600000, actionBudget.maxPerHour],
        [86400000, actionBudget.maxPerDay],
      ]) {
        if (limit == null) continue;
        const used = mem.db
          .prepare(
            "SELECT count(*) AS n FROM events WHERE agent_id=? AND kind='message.send-attempt' AND json_extract(payload,'$.actionKind')=? AND observed_at>?",
          )
          .get(
            a.id,
            actionBudget.kind,
            new Date(now - duration).toISOString(),
          ).n;
        if (used >= limit) throw Error(actionBudget.errorCode);
      }
    }
    const transport = runtime.transports.get(a.connectionId);
    if (!transport?.connected) throw Error("QQ_NOT_CONNECTED");
    return { state, now, batchUsed, transport };
  }
  async deliverNow(ctx, operation) {
    const runtime = this.runtime;
    const capture =
      operation.timingIndex === undefined ? undefined : runtime.messageTiming;
    const mark =
      capture &&
      ((phase) =>
        capture.markDelivery(
          ctx.messageTimingId,
          operation.timingIndex,
          phase,
        ));
    mark?.("queueLeft");
    const checked = this.checkDelivery(ctx, operation);
    const { a, mem, proactive, requestId, contactFreeAction, receipt } =
      checked;
    if (receipt) return receipt;
    const {
      intent,
      body = "",
      metadata = {},
      send,
      action = false,
      actionBudget,
    } = operation;
    const { state, now, batchUsed, transport } = this.checkSendPolicy(
      ctx,
      operation,
      checked,
    );
    const actionKind = action ? actionBudget?.kind || intent?.kind : null;
    const connectionId = a.connectionId;
    const connection = runtime.connection(connectionId);
    const messageNamespace = connection.messageIdNamespace || "onebot";
    const event = {
      connectionId,
      conversation: ctx.conversation,
      senderId: connection.accountId,
      direction: "out",
      body,
      payload: {
        requestId,
        ...metadata,
        messageNamespace,
        ...(action
          ? { deliveryType: "action", ...(actionKind ? { actionKind } : {}) }
          : {}),
        protectedPeerQzoneTargets: peerQzoneSources(runtime, ctx),
        protectedRepositories: privateGithubSources(ctx, runtime),
      },
    };
    const reservedEpoch = ctx.inputEpoch;
    let inputReview, submitted;
    mem.store.transaction(() => {
      // Intake writes and reservation share this database. Keep the last input
      // check inside its write transaction, with no await before gateway submission.
      this.assertDraftDelivery(ctx, contactFreeAction);
      const sendTimes = reserveSendBudget(
        mem,
        a.behavior,
        state.sendTimes,
        now,
        !this.reconciled.has(a.id),
      );
      inputReview = this.review(ctx, operation, checked);
      mem.reserveDelivery(requestId, ctx.conversation, intent);
      mem.setState(ctx.conversation, {
        ...state,
        sendTimes,
        // Control, scheduled and proactive openings have separate budgets.
        // Freeze legacy ordinary timing before they update shared send times;
        // a quick peer response must not restart an already-expired cooldown.
        ...(replyPeers(runtime, ctx).length &&
        state.replyBatchLastAttemptAt == null
          ? { replyBatchLastAttemptAt: peerReplyLastAttemptAt(state) }
          : {}),
        ...(!actionBudget && !proactive && !ctx.internalDelivery
          ? ctx.scheduleRunId
            ? {
                scheduleReplyCounts: {
                  ...Object.fromEntries(
                    Object.entries(state.scheduleReplyCounts || {}).slice(-99),
                  ),
                  [ctx.scheduleRunId]: batchUsed + 1,
                },
              }
            : {
                replyBatchSends: batchUsed + 1,
                replyBatchLastAttemptAt: now,
              }
          : {}),
      });
      if (operation.submission)
        submitted = bindSubmission(
          runtime,
          ctx,
          operation.submission,
          requestId,
          inputReview,
        );
      if (!contactFreeAction) runtime.subject.reserveContact(ctx, proactive);
      mem.append({
        ...event,
        dedupe: "send:" + requestId + ":pending",
        kind: "message.send-attempt",
        status: "pending",
        payload: {
          ...event.payload,
          ...(submitted
            ? { submission: submitted }
            : inputReview?.accepted.length
              ? {
                  deliveryReview: {
                    scope: inputReview.scope,
                    refs: inputReview.accepted,
                  },
                }
              : {}),
        },
      });
    });
    if (operation.submission) operation.submission.execution.reserved = true;
    mark?.("reserved");
    if (!actionBudget)
      ctx.replyBatchSends = (ctx.replyBatchSends ?? ctx.sendCount) + 1;
    ctx.deliveryAttempted = true;
    this.reconciled.add(a.id);
    if (!actionBudget) ctx.sendCount++;
    try {
      runtime.assertActive(ctx);
    } catch (e) {
      // Paused or cancelled before the gateway call: nothing left the process.
      mem.store.transaction(() => {
        mem.completeDelivery(requestId, "failed");
        if (!contactFreeAction) runtime.subject.delivered(ctx, "failed");
      });
      mem.append({
        ...event,
        dedupe: "send:" + requestId + ":failed",
        kind: "message.send-result",
        status: "failed",
        payload: { ...event.payload, reason: "CANCELLED_BEFORE_SEND" },
      });
      throw e;
    }
    let acknowledged = false;
    try {
      mark?.("submitted");
      const receipt = await send(transport, operation.prepared);
      if (action ? receipt?.confirmed !== true : receipt?.messageId == null)
        throw Error("DELIVERY_UNCONFIRMED");
      acknowledged = true;
      const reportAuditFailure = (error) =>
        runtime.diagnostics.report(
          Error("DELIVERY_CONFIRMED_AUDIT_FAILED", { cause: error }),
          {
            component: "runtime",
            agentId: a.id,
            conversation: event.conversation,
          },
        );
      try {
        mark?.("gatewayConfirmed");
      } catch (error) {
        reportAuditFailure(error);
      }
      // Record confirmed delivery even if the user pauses while its network request is in flight.
      const messageId =
        receipt.messageId == null ? null : String(receipt.messageId);
      const confirmation = {
        action,
        messageNamespace,
        ...(receipt.fileId ? { gatewayFileId: receipt.fileId } : {}),
      };
      const draftLinked = mem.confirmDelivery(
        requestId,
        messageId,
        confirmation,
        runtime.drafts,
      );
      let reviewed = [],
        reviewRecorded = true;
      try {
        reviewed = mem.projectConfirmedDeliveryReview(requestId);
      } catch (error) {
        reviewRecorded = false;
        reportAuditFailure(error);
      }
      if (!contactFreeAction) {
        try {
          mem.store.transaction(() => runtime.subject.delivered(ctx, "sent"));
        } catch (error) {
          reportAuditFailure(error);
        }
      }
      const readCheckpoint = applyDeliveryCheckpoint(
        runtime,
        ctx,
        submitted?.checkpoint,
        operation.submission?.execution.epoch,
      );
      try {
        mark?.("ledgerConfirmed");
        capture?.finishDelivery(
          ctx.messageTimingId,
          operation.timingIndex,
          "confirmed",
        );
      } catch (error) {
        reportAuditFailure(error);
      }
      if (ctx.inputEpoch === reservedEpoch)
        for (const { id, version } of reviewed)
          (ctx.confirmedReviewInput ??= new Map()).set(id, version);
      if (!actionBudget) {
        ctx.confirmedSends = (ctx.confirmedSends || 0) + 1;
        try {
          runtime.conversations.sent(ctx);
        } catch (error) {
          reportAuditFailure(error);
        }
      }
      let record;
      try {
        if (draftLinked) {
          record = recoverDraftArchives(
            runtime.memory,
            runtime.drafts,
            a.id,
            requestId,
          );
        } else
          record = mem.append({
            ...event,
            dedupe: "send:" + requestId + ":sent",
            messageId,
            payload: {
              ...event.payload,
              messageNamespace,
              ...(receipt.fileId ? { gatewayFileId: receipt.fileId } : {}),
            },
            kind: action ? "action.confirmed" : "message.sent",
            status: "confirmed",
          });
      } catch (error) {
        reportAuditFailure(error);
      }
      return {
        status: "sent",
        messageId,
        ...(reviewRecorded ? {} : { reviewRecorded: false }),
        ...(submitted ? { requestId } : {}),
        // The archived record, which mind tools accept as evidence.
        ...(record?.id
          ? { recordId: record.id }
          : draftLinked
            ? { archivePending: true }
            : {}),
        ...(action ? { actionConfirmed: true } : {}),
        ...(readCheckpoint ? { readCheckpoint } : {}),
        ...(receipt.fileId ? { gatewayFileId: receipt.fileId } : {}),
      };
    } catch (e) {
      // A gateway timeout is not a refusal: QQ may still deliver the message.
      const status =
        e.message === "ONEBOT_REJECTED" && e.reason !== "GATEWAY_TIMEOUT"
          ? "failed"
          : "unknown";
      const reason = (status === "failed"
        ? ["PACKET_BACKEND_DISABLED", "PACKET_BACKEND_UNAVAILABLE"]
        : ["GATEWAY_TIMEOUT"]
      ).includes(e.reason)
        ? e.reason
        : undefined;
      // A later audit failure must never downgrade an already-confirmed receipt.
      if (acknowledged)
        throw Error("DELIVERY_CONFIRMED_AUDIT_FAILED", { cause: e });
      mem.store.transaction(() => {
        mem.completeDelivery(requestId, status);
        if (!contactFreeAction) runtime.subject.delivered(ctx, status);
      });
      capture?.finishDelivery(
        ctx.messageTimingId,
        operation.timingIndex,
        status,
      );
      mem.append({
        ...event,
        dedupe: "send:" + requestId + ":" + status,
        kind: "message.send-result",
        status,
        payload: { ...event.payload, ...(reason ? { reason } : {}) },
      });
      if (
        status === "failed" &&
        e.reason === "ACTION_UNSUPPORTED" &&
        actionBudget?.kind === "recall"
      )
        throw Error("RECALL_UNSUPPORTED", { cause: e });
      throw Error(
        "DELIVERY_" +
          status.toUpperCase() +
          (status === "failed" && reason ? "_" + reason : ""),
        { cause: e },
      );
    }
  }
}
