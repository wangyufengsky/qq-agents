// @ts-check
import { assertMessageAccount } from "../memory/message-ids.mjs";

/** @param {any} runtime @param {any} ctx */
function active(runtime, ctx) {
  const a = runtime.assertActive(ctx);
  if (runtime.protectedWork?.context(ctx))
    throw Error("PROTECTED_WORK_OUTBOUND_DENIED");
  if (
    !a.behavior.actions?.peerProfile ||
    !/^(private|group):[1-9][0-9]*$/.test(ctx.conversation)
  )
    throw Error("TOOL_DISABLED");
  return a;
}

/** @param {any} runtime @param {any} ctx @param {{userId?: string}} args */
export function resolvePeerTarget(runtime, ctx, args) {
  const a = runtime.assertActive(ctx);
  if (
    runtime.protectedWork?.context(ctx) ||
    !/^(private|group):[1-9][0-9]*$/.test(ctx.conversation)
  )
    throw Error("PEER_PROFILE_TARGET_DENIED");
  const [kind, id] = ctx.conversation.split(":");
  const userId = args.userId ?? (kind === "private" ? id : undefined);
  if (!userId || (kind === "private" && userId !== id))
    throw Error("PEER_PROFILE_TARGET_DENIED");
  const connection = runtime.connection(a.connectionId);
  assertMessageAccount(
    runtime.memory.bind(a.id),
    a.connectionId,
    connection.accountId,
  );
  const transport = runtime.transports.get(a.connectionId);
  if (!transport?.connected) throw Error("QQ_NOT_CONNECTED");
  return {
    agent: a,
    transport,
    userId,
    groupId: kind === "group" ? id : undefined,
  };
}

/** @param {any} runtime @param {any} ctx @param {{userId?: string}} args */
export async function readPeerProfile(runtime, ctx, args) {
  active(runtime, ctx);
  const { agent, transport, userId, groupId } = resolvePeerTarget(
    runtime,
    ctx,
    args,
  );
  const connectionId = agent.connectionId;
  const accountId = runtime.connection(connectionId).accountId;
  if (typeof transport.peerProfile !== "function")
    throw Error("PEER_PROFILE_UNSUPPORTED");
  const result = await transport.peerProfile({
    userId,
    groupId,
  });
  // A pause or permission edit while the gateway is answering must withhold the result.
  const current = active(runtime, ctx);
  if (
    current.connectionId !== connectionId ||
    runtime.connection(connectionId).accountId !== accountId ||
    runtime.transports.get(current.connectionId) !== transport
  )
    throw Error("PEER_PROFILE_IDENTITY_MISMATCH");
  if (
    String(result?.userId) !== userId ||
    (groupId && String(result?.groupId) !== groupId)
  )
    throw Error("PEER_PROFILE_IDENTITY_MISMATCH");
  const text = (/** @type {unknown} */ value) =>
    typeof value === "string" ? value.slice(0, 200) : null;
  return {
    userId,
    nickname: text(result.nickname),
    signature: groupId ? null : text(result.signature),
    ...(groupId
      ? {
          groupId,
          card: text(result.card),
          title: text(result.title),
          role: ["owner", "admin", "member"].includes(result.role)
            ? result.role
            : null,
        }
      : {}),
  };
}
