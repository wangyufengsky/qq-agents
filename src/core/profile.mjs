// @ts-check
import { assertMessageAccount } from "../memory/message-ids.mjs";
import { taintMedia } from "../tools/legacy.mjs";
import { SUBJECT } from "./lifecycle.mjs";
import { inSilence } from "./config.mjs";

const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
const AVATAR_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

/** The account profile is public, so besides the role's own free time only an
 * owner's private chat may change it; no other chat can talk the role into it.
 * @param {any} agent @param {string} conversation
 */
export function profileConversation(agent, conversation) {
  return (
    conversation === SUBJECT ||
    (agent.ownerIds || []).some(
      (/** @type {string} */ id) => conversation === `private:${id}`,
    )
  );
}

/** @param {any} runtime @param {any} ctx */
function active(runtime, ctx) {
  const a = runtime.assertActive(ctx);
  if (!a.behavior.actions?.profile || !profileConversation(a, ctx.conversation))
    throw Error("TOOL_DISABLED");
  if (runtime.protectedWork?.context(ctx))
    throw Error("PROTECTED_WORK_OUTBOUND_DENIED");
  // A proactive intent or scheduled run would settle on this action instead of
  // the message it was created for.
  if (ctx.activeIntentId || ctx.intentOnly || ctx.scheduleRunId)
    throw Error("PROFILE_ORDINARY_TURN_REQUIRED");
  // Free-time review may run in quiet hours; a public account change must
  // honor them like chat output does. Pause and isolation already end the turn.
  if (ctx.conversation === SUBJECT && inSilence(a, runtime.clock()))
    throw Error("QUIET_HOURS");
  return a;
}

/** @param {any} runtime @param {any} ctx */
export async function readProfile(runtime, ctx) {
  const a = active(runtime, ctx),
    connection = runtime.connection(a.connectionId);
  assertMessageAccount(
    runtime.memory.bind(a.id),
    a.connectionId,
    connection.accountId,
  );
  const transport = runtime.transports.get(a.connectionId);
  if (!transport?.connected) throw Error("QQ_NOT_CONNECTED");
  if (typeof transport.profile !== "function")
    throw Error("PROFILE_UNSUPPORTED");
  return { accountId: connection.accountId, ...(await transport.profile()) };
}

/** @param {any} runtime @param {any} ctx @param {{requestId: string, nickname?: string, signature?: string, mediaId?: string}} args */
export async function updateProfile(runtime, ctx, args) {
  const a = active(runtime, ctx);
  const field =
    args.nickname !== undefined
      ? "nickname"
      : args.signature !== undefined
        ? "signature"
        : "avatar";
  /** @type {Buffer | undefined} */
  let image;
  let body, detail;
  if (field === "avatar") {
    const meta = runtime.media.metadata(a.id, args.mediaId);
    if (!meta) throw Error("MEDIA_NOT_FOUND");
    taintMedia(ctx, meta);
    if (!AVATAR_TYPES.has(meta.mimeType)) throw Error("PROFILE_AVATAR_INVALID");
    image = Buffer.from(runtime.media.read(a.id, args.mediaId).data, "base64");
    if (image.length > AVATAR_MAX_BYTES) throw Error("IMAGE_TOO_LARGE");
    body = "[更换头像]";
    detail = { profileMediaId: args.mediaId };
  } else {
    const value = /** @type {string} */ (args[field]);
    body = `[修改${field === "nickname" ? "昵称" : "签名"}] ${value}`;
    detail = { profileValue: value };
  }
  // Everyone who can see the account sees its profile, so recollections from
  // other chats need the same grant as an external call.
  runtime.assertDisclosure(ctx, { external: true });
  const actionBudget = {
    kind: "profile",
    maxPerDay: a.behavior.actions.profileMaxPerDay,
    errorCode: "PROFILE_RATE_LIMITED",
  };
  try {
    return await runtime.deliver(ctx, {
      requestId: args.requestId,
      intent: { kind: "profile", field, ...detail },
      body,
      metadata: { profileField: field, ...detail },
      action: true,
      actionBudget,
      validate: () => {
        actionBudget.maxPerDay = active(
          runtime,
          ctx,
        ).behavior.actions.profileMaxPerDay;
        if (
          typeof runtime.transports.get(a.connectionId)?.updateProfile !==
          "function"
        )
          throw Error("PROFILE_UNSUPPORTED");
        // An unconfirmed change may already be live; a new request ID must not
        // stack another change of the same field on top before it is reconciled.
        const pending = runtime.memory
          .bind(a.id)
          .db.prepare(
            `SELECT 1 FROM events e JOIN deliveries d ON d.agent_id=e.agent_id AND d.request_id=json_extract(e.payload,'$.requestId') WHERE e.agent_id=? AND e.kind='message.send-attempt' AND json_extract(e.payload,'$.actionKind')='profile' AND json_extract(e.payload,'$.profileField')=? AND d.status IN ('pending','unknown') LIMIT 1`,
          )
          .get(a.id, field);
        if (pending) throw Error("PROFILE_UPDATE_UNCONFIRMED");
      },
      send: (/** @type {any} */ transport) =>
        transport.updateProfile(
          field === "avatar"
            ? { image }
            : { [field]: /** @type {string} */ (args[field]) },
        ),
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "DELIVERY_FAILED" &&
      /** @type {any} */ (error.cause)?.reason === "ACTION_UNSUPPORTED"
    )
      throw Error("PROFILE_UNSUPPORTED", { cause: error });
    throw error;
  }
}
