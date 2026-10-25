import { createHash } from "node:crypto";

// Deliberate allowlist: never persist RPC errors, connection URLs, credentials,
// capability tokens, prompts or arbitrary backend session metadata here.
export function sessionReference(session) {
  if (!session?.id || typeof session.id !== "string" || session.id.length > 512)
    throw Error("INVALID_BACKEND_SESSION_REFERENCE");
  return {
    id: session.id,
    ...(typeof session.backend === "string"
      ? { backend: session.backend.slice(0, 64) }
      : {}),
    ...(typeof session.signature === "string"
      ? { signature: session.signature.slice(0, 128) }
      : {}),
  };
}
const place = (scope) =>
  scope.startsWith("learner:")
    ? { conversation: scope.slice(8), learner: true }
    : { conversation: scope, learner: false };
function stateAt(memory, scope) {
  const p = place(scope),
    state = memory.state(p.conversation);
  return { ...p, state, value: p.learner ? state.slang || {} : state };
}
function writeAt(memory, p, value) {
  memory.setState(
    p.conversation,
    p.learner ? { ...p.state, slang: value } : value,
  );
}
function turnRecord(memory, id) {
  return (
    id &&
    memory.db
      .prepare("SELECT value FROM model_turns WHERE agent_id=? AND id=?")
      .get(memory.agentId, id)
  );
}
function patchTurn(memory, id, patch) {
  const row = turnRecord(memory, id);
  if (row)
    memory.identity.put("model_turns", { ...JSON.parse(row.value), ...patch });
}
function archive(
  memory,
  scope,
  session,
  { turnId, backendId, reason, at, ...extra },
) {
  const reference = sessionReference(session);
  const id =
    "session:" +
    createHash("sha256")
      .update(
        JSON.stringify([
          scope,
          reference.backend,
          reference.id,
          turnId || null,
        ]),
      )
      .digest("hex");
  if (
    !memory.db
      .prepare("SELECT 1 FROM session_history WHERE agent_id=? AND id=?")
      .get(memory.agentId, id)
  )
    memory.identity.put("session_history", {
      id,
      conversation: scope,
      session: reference,
      turnId: turnId || null,
      backendId: backendId || null,
      reason,
      at,
      ...extra,
    });
  patchTurn(memory, turnId, {
    backendSession: reference,
    sessionHistoryId: id,
  });
  return id;
}

export function retireSession(
  memory,
  scope,
  reason,
  at,
  { turnId, backendId, session, ...extra } = {},
) {
  return memory.store.transaction(() => {
    const p = stateAt(memory, scope),
      owner = turnId ?? p.value.lastTurnId;
    const owns =
      !turnId || !p.value.lastTurnId || p.value.lastTurnId === turnId;
    const record = turnRecord(memory, owner);
    const previous =
      session ||
      (owns ? p.value.session : null) ||
      (record && JSON.parse(record.value).backendSession);
    if (previous)
      archive(memory, scope, previous, {
        turnId: owner,
        backendId: backendId || (record && JSON.parse(record.value).backendId),
        reason,
        at,
        ...extra,
      });
    if (owns)
      writeAt(memory, p, {
        ...p.value,
        session: null,
        ...(!p.learner
          ? { feedThroughSeq: p.value.readThroughSeq || 0, usage: null }
          : {}),
        lifecycle: { status: "retired", reason, at },
      });
  });
}

export function saveSession(
  memory,
  scope,
  session,
  { turnId, backendId, at, inactive = false, reason = "backend-failure" },
) {
  if (!session)
    return retireSession(memory, scope, reason, at, { turnId, backendId });
  const reference = sessionReference(session);
  memory.store.transaction(() => {
    const p = stateAt(memory, scope);
    patchTurn(memory, turnId, { backendSession: reference, backendId });
    if (inactive || p.value.lastTurnId !== turnId) {
      archive(memory, scope, reference, {
        turnId,
        backendId,
        reason: "cancelled-during-session-creation",
        at,
      });
      return;
    }
    writeAt(memory, p, { ...p.value, session: reference });
  });
}

export function recordBackendTurn(memory, turnId, reference) {
  if (typeof reference?.turnId !== "string" || reference.turnId.length > 512)
    return;
  patchTurn(memory, turnId, { backendTurnId: reference.turnId });
}
