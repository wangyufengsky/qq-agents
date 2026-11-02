// @ts-check
import { assertMessageAccount } from "../memory/message-ids.mjs";
import { profileConversation } from "./profile.mjs";

// Gateway failure causes that keep their own error code instead of the
// generic delivery failure; anything else stays DELIVERY_FAILED/UNKNOWN.
const QZONE_REASONS = /** @type {Record<string, string>} */ ({
  ACTION_UNSUPPORTED: "QZONE_UNSUPPORTED",
  QZONE_LOGIN_REQUIRED: "QZONE_LOGIN_REQUIRED",
  QZONE_REJECTED: "QZONE_REJECTED",
  QQ_ACCOUNT_MISMATCH: "QQ_ACCOUNT_MISMATCH",
});

/** QQ Zone posts are public like the profile, so they share its owner-only scope.
 * @param {any} runtime @param {any} ctx
 */
function active(runtime, ctx) {
  const a = runtime.assertActive(ctx);
  if (!a.behavior.actions?.qzone || !profileConversation(a, ctx.conversation))
    throw Error("TOOL_DISABLED");
  if (runtime.protectedWork?.context(ctx))
    throw Error("PROTECTED_WORK_OUTBOUND_DENIED");
  // A proactive intent or scheduled run would settle on this post instead of
  // the message it was created for.
  if (ctx.activeIntentId || ctx.intentOnly || ctx.scheduleRunId)
    throw Error("QZONE_ORDINARY_TURN_REQUIRED");
  return a;
}

/** @param {any} runtime @param {any} ctx @param {{limit?: number}} args */
export async function readQzone(runtime, ctx, args) {
  const a = active(runtime, ctx),
    connection = runtime.connection(a.connectionId);
  assertMessageAccount(
    runtime.memory.bind(a.id),
    a.connectionId,
    connection.accountId,
  );
  const transport = runtime.transports.get(a.connectionId);
  if (!transport?.connected) throw Error("QQ_NOT_CONNECTED");
  if (typeof transport.qzoneRecent !== "function")
    throw Error("QZONE_UNSUPPORTED");
  try {
    return {
      accountId: connection.accountId,
      posts: await transport.qzoneRecent({ limit: args.limit ?? 5 }),
    };
  } catch (error) {
    const reason = /** @type {any} */ (error)?.reason;
    // Only the sanitized code may leave: a raw failure from the web endpoint
    // can echo cookies or page markup.
    // eslint-disable-next-line preserve-caught-error -- see above.
    throw Error(QZONE_REASONS[reason] || "QZONE_READ_FAILED");
  }
}

/** @param {any} runtime @param {any} ctx @param {{requestId: string, content: string}} args */
export async function postQzone(runtime, ctx, args) {
  const a = active(runtime, ctx);
  // Everyone who can see the account sees its posts, so recollections from
  // other chats need the same grant as an external call.
  runtime.assertDisclosure(ctx, { external: true });
  const actionBudget = {
    kind: "qzone",
    maxPerDay: a.behavior.actions.qzoneMaxPerDay,
    errorCode: "QZONE_RATE_LIMITED",
  };
  try {
    return await runtime.deliver(ctx, {
      requestId: args.requestId,
      intent: { kind: "qzone", content: args.content },
      body: `[发说说] ${args.content}`,
      metadata: { qzoneVisibility: "public" },
      action: true,
      actionBudget,
      validate: () => {
        actionBudget.maxPerDay = active(
          runtime,
          ctx,
        ).behavior.actions.qzoneMaxPerDay;
        if (
          typeof runtime.transports.get(a.connectionId)?.qzonePost !==
          "function"
        )
          throw Error("QZONE_UNSUPPORTED");
        // An unconfirmed post may already be public; a new request ID must not
        // publish a second copy before the administrator reconciles it.
        const pending = runtime.memory
          .bind(a.id)
          .db.prepare(
            `SELECT 1 FROM events e JOIN deliveries d ON d.agent_id=e.agent_id AND d.request_id=json_extract(e.payload,'$.requestId') WHERE e.agent_id=? AND e.kind='message.send-attempt' AND json_extract(e.payload,'$.actionKind')='qzone' AND d.status IN ('pending','unknown') LIMIT 1`,
          )
          .get(a.id);
        if (pending) throw Error("QZONE_POST_UNCONFIRMED");
      },
      send: (/** @type {any} */ transport) =>
        transport.qzonePost({ content: args.content }),
    });
  } catch (error) {
    const reason = /** @type {any} */ (error)?.cause?.reason;
    if (
      error instanceof Error &&
      error.message === "DELIVERY_FAILED" &&
      QZONE_REASONS[reason]
    )
      throw Error(QZONE_REASONS[reason], { cause: error });
    throw error;
  }
}
