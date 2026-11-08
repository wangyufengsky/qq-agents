// @ts-check

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
          ...JSON.parse(attempt.payload),
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
