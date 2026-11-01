// @ts-check
import {
  resolveMessage,
  gatewayMessageId,
  assertMessageAccount,
} from "../memory/message-ids.mjs";

// Resolve only owned archive entries. Never accept a model-supplied wire ID
// without the current role, connection, conversation and confirmed ledger proof.
/** @param {any} runtime @param {any} ctx @param {{ requestId: string, messageRef: string }} input */
export async function recallMessage(runtime, ctx, { requestId, messageRef }) {
  const agent = runtime.assertActive(ctx);
  if (!agent.behavior.actions?.recall) throw Error("TOOL_DISABLED");
  if (runtime.protectedWork?.context(ctx))
    throw Error("PROTECTED_WORK_OUTBOUND_DENIED");
  const mem = runtime.memory.bind(agent.id),
    connection = runtime.connection(agent.connectionId);
  assertMessageAccount(mem, agent.connectionId, connection.accountId);
  const scope = {
    agentId: agent.id,
    connectionId: agent.connectionId,
    conversation: ctx.conversation,
    namespace: undefined,
  };
  const exact = mem.db
    .prepare(
      "SELECT * FROM events WHERE id=? AND agent_id=? AND connection_id=? AND conversation=?",
    )
    .get(messageRef, agent.id, agent.connectionId, ctx.conversation);
  const target = exact || resolveMessage(mem.db, scope, messageRef);
  if (
    !target ||
    target.direction !== "out" ||
    target.sender_id !== connection.accountId
  )
    throw Error("RECALL_NOT_OWN");
  const targetRequestId = JSON.parse(target.payload).requestId;
  const ledger =
    typeof targetRequestId === "string" ? mem.delivery(targetRequestId) : null;
  if (
    target.kind !== "message.sent" ||
    target.status !== "confirmed" ||
    !target.message_id ||
    ledger?.status !== "sent" ||
    ledger.conversation !== ctx.conversation ||
    ledger.message_id !== target.message_id
  )
    throw Error("RECALL_NOT_SENT");
  const messageId = gatewayMessageId(
    mem.db,
    scope,
    target,
    connection.messageIdNamespace || "onebot",
    connection.accountId,
  );
  const actionBudget = {
    kind: "recall",
    maxPerHour: agent.behavior.actions.recallMaxPerHour,
    errorCode: "RECALL_RATE_LIMITED",
  };
  return runtime.deliver(ctx, {
    requestId,
    intent: { kind: "recall", messageId },
    body: "[撤回自己的消息]",
    metadata: { recalledEventId: target.id },
    action: true,
    actionBudget,
    validate: () => {
      const policy = runtime.agent(agent.id).behavior.actions;
      if (!policy?.recall) throw Error("TOOL_DISABLED");
      actionBudget.maxPerHour = policy.recallMaxPerHour;
      // Recheck inside the serialized delivery chain: queued work can expire,
      // or a concurrent request can already have attempted this exact target.
      const elapsed = runtime.now() - Date.parse(ledger.updated_at);
      if (
        !Number.isFinite(elapsed) ||
        elapsed < 0 ||
        elapsed > runtime.agent(agent.id).behavior.actions.recallWindowMs
      )
        throw Error("RECALL_TOO_LATE");
      if (
        mem.db
          .prepare(
            "SELECT 1 FROM events WHERE agent_id=? AND conversation=? AND kind='message.send-attempt' AND json_extract(payload,'$.recalledEventId')=? LIMIT 1",
          )
          .get(agent.id, ctx.conversation, target.id)
      )
        throw Error("RECALL_ALREADY_ATTEMPTED");
    },
    send: (/** @type {any} */ transport) => transport.recall(messageId),
  });
}
