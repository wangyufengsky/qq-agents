// @ts-check
import {
  resolveMessage,
  gatewayMessageId,
  assertMessageAccount,
} from "../memory/message-ids.mjs";
import { qqFace } from "../transport/qq-faces.mjs";

const messageKinds =
  "('message.received','message.sent','legacy.message-observation')";

/** Resolve only a message that belongs to this role, connection and chat.
 * @param {any} runtime @param {any} ctx @param {string} reference
 */
function targetMessage(runtime, ctx, reference) {
  const a = runtime.agent(ctx.agentId),
    memory = runtime.memory.bind(a.id),
    connection = runtime.connection(a.connectionId);
  assertMessageAccount(memory, a.connectionId, connection.accountId);
  const scope = {
    agentId: a.id,
    connectionId: a.connectionId,
    conversation: ctx.conversation,
    namespace: undefined,
  };
  const row =
    memory.db
      .prepare(
        `SELECT * FROM events WHERE agent_id=? AND connection_id=? AND conversation=? AND id=? AND kind IN ${messageKinds}`,
      )
      .get(a.id, a.connectionId, ctx.conversation, reference) ||
    resolveMessage(memory.db, scope, reference);
  if (!row) throw Error("REACT_UNKNOWN_MESSAGE");
  return {
    row,
    messageId: gatewayMessageId(
      memory.db,
      scope,
      row,
      connection.messageIdNamespace || "onebot",
      connection.accountId,
    ),
  };
}

/** @param {any} memory @param {any} connection @param {any} event */
export function ownsReactionTarget(memory, connection, event) {
  if (!event.reaction) return false;
  try {
    const row = resolveMessage(
      memory.db,
      {
        agentId: memory.agentId,
        connectionId: connection.id,
        conversation: event.conversation,
        namespace: connection.messageIdNamespace || "onebot",
      },
      event.reaction.messageId,
    );
    return (
      !!row && row.direction === "out" && row.sender_id === connection.accountId
    );
  } catch (error) {
    // An ambiguous target cannot establish that someone reacted to us. Other
    // storage errors must still reach diagnostics instead of silently losing data.
    if (error instanceof Error && error.message === "AMBIGUOUS_MESSAGE_ID")
      return false;
    throw error;
  }
}

/** @param {any} runtime @param {any} ctx @param {{requestId: string, messageRef: string, faceId: string}} args */
export async function react(runtime, ctx, args) {
  const active = () => {
    const a = runtime.assertActive(ctx);
    if (!a.behavior.actions?.react) throw Error("TOOL_DISABLED");
    if (runtime.protectedWork?.context(ctx))
      throw Error("PROTECTED_WORK_OUTBOUND_DENIED");
    return a;
  };
  const a = active(),
    face = qqFace({ id: args.faceId });
  if (!face.name || face.id === null) throw Error("REACT_FACE_UNKNOWN");
  const target = targetMessage(runtime, ctx, args.messageRef);
  const namespace =
    runtime.connection(a.connectionId).messageIdNamespace || "onebot";
  const actionBudget = {
    kind: "react",
    maxPerMinute: a.behavior.actions.reactMaxPerMinute,
    errorCode: "REACT_RATE_LIMITED",
  };
  try {
    return await runtime.deliver(ctx, {
      requestId: args.requestId,
      intent: { kind: "react", messageId: target.messageId, faceId: face.id },
      body: `[贴表情:${face.name}]`,
      metadata: {
        reactedEventId: target.row.id,
        reactedMessageId: target.messageId,
        reactionFaceId: face.id,
        referenceNamespace: namespace,
      },
      action: true,
      actionBudget,
      validate: () => {
        actionBudget.maxPerMinute = active().behavior.actions.reactMaxPerMinute;
        const current = targetMessage(runtime, ctx, args.messageRef);
        if (
          current.row.id !== target.row.id ||
          current.messageId !== target.messageId
        )
          throw Error("REACT_UNKNOWN_MESSAGE");
        if (typeof runtime.transports.get(a.connectionId)?.react !== "function")
          throw Error("REACT_UNSUPPORTED");
        const memory = runtime.memory.bind(a.id);
        // A new request ID must not replay an unconfirmed mutation of the same
        // message/face. This survives restart and is checked inside the send chain.
        const attempted = memory.db
          .prepare(
            `SELECT 1 FROM events e JOIN deliveries d ON d.agent_id=e.agent_id AND d.request_id=json_extract(e.payload,'$.requestId') WHERE e.agent_id=? AND e.connection_id=? AND e.conversation=? AND e.kind='message.send-attempt' AND (json_extract(e.payload,'$.reactedEventId')=? OR (json_extract(e.payload,'$.reactedMessageId')=? AND json_extract(e.payload,'$.referenceNamespace')=?)) AND json_extract(e.payload,'$.reactionFaceId')=? AND d.status IN ('pending','unknown') LIMIT 1`,
          )
          .get(
            a.id,
            a.connectionId,
            ctx.conversation,
            target.row.id,
            target.messageId,
            namespace,
            face.id,
          );
        if (attempted) throw Error("REACT_ALREADY_ATTEMPTED");
      },
      send: (/** @type {any} */ transport) =>
        transport.react(target.messageId, face.id),
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "DELIVERY_FAILED" &&
      /** @type {any} */ (error.cause)?.reason === "ACTION_UNSUPPORTED"
    )
      throw Error("REACT_UNSUPPORTED", { cause: error });
    throw error;
  }
}
