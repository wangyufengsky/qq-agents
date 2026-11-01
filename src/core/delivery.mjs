import { recallBoundary } from "./recall-boundary.mjs";
import { containsCredential } from "./secrets.mjs";
import { beforeShareDelivery } from "../apps/sharing.mjs";
import { appService } from "../apps/tools.mjs";
import { privateGithubSources } from "../github/policy.mjs";
import { taintMedia } from "../tools/legacy.mjs";
import { mdToPlain } from "../../vendor/dsh-qq/md-to-plain.js";
import { checkTone } from "./tone-check.mjs";
import { reserveSendBudget } from "./send-budget.mjs";
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
    this.reconciled = new Set();
  }
  async send(
    ctx,
    { requestId, text = "", replyTo, atUserId, mediaId },
    { archiveBody } = {},
  ) {
    const runtime = this.runtime;
    const a = runtime.assertActive(ctx),
      mem = runtime.memory.bind(a.id);
    if (runtime.protectedWork?.context(ctx))
      throw Error("PROTECTED_WORK_OUTBOUND_DENIED");
    runtime.assertDisclosure(ctx);
    if (typeof text !== "string" || text.length > 8000 || (!text && !mediaId))
      throw Error("INVALID_MESSAGE");
    runtime.assertSafeOutput(ctx, text);
    text = mdToPlain(text);
    if (!text && !mediaId) throw Error("EMPTY_MESSAGE");
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
      const own = resolveMessage(mem.db, scope, replyTo);
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
    if (text) segments.push({ type: "text", data: { text } });
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
      body: archiveBody ?? text,
      metadata: {
        replyTo,
        requestedReplyTo,
        referenceNamespace: namespace,
        atUserId,
        mediaId,
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
    ctx.pendingDeliveries = (ctx.pendingDeliveries || 0) + 1;
    const previous = this.chains.get(a.connectionId);
    const result = previous
      ? previous.catch(() => {}).then(() => this.deliverNow(ctx, operation))
      : this.deliverNow(ctx, operation);
    this.chains.set(a.connectionId, result);
    try {
      return await result;
    } finally {
      ctx.pendingDeliveries--;
      if (this.chains.get(a.connectionId) === result)
        this.chains.delete(a.connectionId);
    }
  }
  async deliverNow(
    ctx,
    { requestId, intent, body = "", metadata = {}, send, action = false },
  ) {
    const runtime = this.runtime;
    const a = runtime.assertActive(ctx),
      mem = runtime.memory.bind(a.id);
    assertMessageAccount(
      mem,
      a.connectionId,
      runtime.connection(a.connectionId).accountId,
    );
    if (mem.state(ctx.conversation).silenceUntil > runtime.now())
      throw Error("CONVERSATION_SILENCED");
    const proactive = runtime.subject.beforeDelivery(ctx);
    if (proactive) requestId = "intent:" + proactive.id;
    if (typeof requestId !== "string" || !requestId || requestId.length > 200)
      throw Error("INVALID_REQUEST_ID");
    runtime.assertDisclosure(ctx);
    beforeShareDelivery(appService(runtime), ctx, metadata);
    const serialized = JSON.stringify(intent);
    if (serialized.includes(ctx.token) || containsCredential(body))
      throw Error("SENSITIVE_OUTPUT_BLOCKED");
    const previous = mem.delivery(requestId);
    if (previous) {
      mem.reserveDelivery(requestId, ctx.conversation, intent);
      if (previous.status === "sent")
        return {
          status: "sent",
          messageId: previous.message_id,
          duplicate: true,
        };
      throw Error(
        "DELIVERY_ALREADY_ATTEMPTED_" + previous.status.toUpperCase(),
      );
    }
    // Recovery must not evade a sent/unknown/failed receipt by changing the
    // request ID, wording, media, action or target. Same-ID receipt reads above
    // remain available; new deliveries are fenced for this continuation.
    if (ctx.recoveryDeliveryBlocked) throw Error("RECOVERY_DELIVERY_BLOCKED");
    if (metadata.mediaId)
      runtime.generatedImages.assertDelivery(ctx, metadata.mediaId, requestId);
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
    if (batchUsed >= batchLimit) throw Error("REPLY_BURST_LIMIT");
    const transport = runtime.transports.get(a.connectionId);
    if (!transport?.connected) throw Error("QQ_NOT_CONNECTED");
    const event = {
      connectionId: a.connectionId,
      conversation: ctx.conversation,
      senderId: runtime.connection(a.connectionId).accountId,
      direction: "out",
      body,
      payload: {
        requestId,
        ...metadata,
        protectedRepositories: privateGithubSources(ctx, runtime),
      },
    };
    mem.store.transaction(() => {
      const sendTimes = reserveSendBudget(
        mem,
        a.behavior,
        state.sendTimes,
        now,
        !this.reconciled.has(a.id),
      );
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
        ...(!proactive && !ctx.internalDelivery
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
      runtime.subject.reserveContact(ctx, proactive);
      mem.append({
        ...event,
        dedupe: "send:" + requestId + ":pending",
        kind: "message.send-attempt",
        status: "pending",
      });
    });
    ctx.replyBatchSends = (ctx.replyBatchSends ?? ctx.sendCount) + 1;
    ctx.deliveryAttempted = true;
    this.reconciled.add(a.id);
    ctx.sendCount++;
    try {
      runtime.assertActive(ctx);
    } catch (e) {
      // Paused or cancelled before the gateway call: nothing left the process.
      mem.store.transaction(() => {
        mem.completeDelivery(requestId, "failed");
        runtime.subject.delivered(ctx, "failed");
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
    try {
      const receipt = await send(transport);
      if (action ? receipt?.confirmed !== true : receipt?.messageId == null)
        throw Error("DELIVERY_UNCONFIRMED");
      // Record confirmed delivery even if the user pauses while its network request is in flight.
      const messageId =
        receipt.messageId == null ? null : String(receipt.messageId);
      mem.store.transaction(() => {
        mem.completeDelivery(requestId, "sent", messageId);
        runtime.subject.delivered(ctx, "sent");
      });
      ctx.confirmedSends = (ctx.confirmedSends || 0) + 1;
      runtime.conversations.sent(ctx);
      const record = mem.append({
        ...event,
        dedupe: "send:" + requestId + ":sent",
        messageId,
        payload: {
          ...event.payload,
          messageNamespace:
            runtime.connection(a.connectionId).messageIdNamespace || "onebot",
          ...(receipt.fileId ? { gatewayFileId: receipt.fileId } : {}),
        },
        kind: action ? "action.confirmed" : "message.sent",
        status: "confirmed",
      });
      return {
        status: "sent",
        messageId,
        // The archived record, which mind tools accept as evidence.
        ...(record?.id ? { recordId: record.id } : {}),
        ...(action ? { actionConfirmed: true } : {}),
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
      if (mem.delivery(requestId)?.status === "sent")
        throw Error("DELIVERY_CONFIRMED_AUDIT_FAILED", { cause: e });
      mem.store.transaction(() => {
        mem.completeDelivery(requestId, status);
        runtime.subject.delivered(ctx, status);
      });
      mem.append({
        ...event,
        dedupe: "send:" + requestId + ":" + status,
        kind: "message.send-result",
        status,
        payload: { ...event.payload, ...(reason ? { reason } : {}) },
      });
      throw Error(
        "DELIVERY_" +
          status.toUpperCase() +
          (status === "failed" && reason ? "_" + reason : ""),
        { cause: e },
      );
    }
  }
}
