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
    ...(session.backend === "antigravity" &&
    typeof session.nativeSignature === "string" &&
    /^antigravity-tools-v3:contract-v[23]:[a-f0-9]{64}$/.test(
      session.nativeSignature,
    )
      ? { nativeSignature: session.nativeSignature }
      : {}),
    ...(typeof session.signature === "string"
      ? { signature: session.signature.slice(0, 128) }
      : {}),
  };
}
// Only called after the complete old contract was verified. The native binding
// may still carry that signature until the first successful post-upgrade turn.
export function upgradeSessionReference(session, signature) {
  return {
    ...session,
    signature,
    ...(session.backend === "antigravity" &&
    /:contract-v[23]:/.test(session.signature)
      ? { nativeSignature: session.signature }
      : {}),
  };
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
const diagnosticFields = {
  origin: new Set([
    "terminal",
    "process-exit",
    "stdin",
    "protocol",
    "finalization",
  ]),
  phase: new Set([
    "preparing",
    "running",
    "terminal-observed",
    "settling",
    "settled",
  ]),
  terminalStatus: new Set(["SUCCESS", "ERROR", "CANCELLED", "unrecognized"]),
  signal: new Set([
    "SIGABRT",
    "SIGALRM",
    "SIGBREAK",
    "SIGBUS",
    "SIGCHLD",
    "SIGCONT",
    "SIGFPE",
    "SIGHUP",
    "SIGILL",
    "SIGINT",
    "SIGKILL",
    "SIGPIPE",
    "SIGPOLL",
    "SIGPROF",
    "SIGPWR",
    "SIGQUIT",
    "SIGSEGV",
    "SIGSTOP",
    "SIGSYS",
    "SIGTERM",
    "SIGTRAP",
    "SIGTSTP",
    "SIGTTIN",
    "SIGTTOU",
    "SIGURG",
    "SIGUSR1",
    "SIGUSR2",
    "SIGVTALRM",
    "SIGWINCH",
    "SIGXCPU",
    "SIGXFSZ",
  ]),
  ioCode: new Set([
    "EACCES",
    "EAGAIN",
    "EBADF",
    "EBUSY",
    "ECONNRESET",
    "EEXIST",
    "EIO",
    "EISDIR",
    "EMFILE",
    "ENOENT",
    "ENOSPC",
    "ENOTDIR",
    "EPERM",
    "EPIPE",
    "ETIMEDOUT",
    "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
    "ERR_STREAM_DESTROYED",
    "ERR_STREAM_PREMATURE_CLOSE",
    "ERR_STREAM_WRITE_AFTER_END",
    "PROCESS_SPAWN_FAILED",
    "PROTOCOL_READ_FAILED",
    "STDIN_CLOSE_FAILED",
    "STDIN_WRITE_FAILED",
  ]),
  backendOutcome: new Set(["success", "failed", "cancelled"]),
  workerOutcome: new Set(["healthy", "recycled", "exit-warning"]),
  sessionDisposition: new Set(["retained", "retiring", "retired"]),
};
const diagnosticSummaryFields = [
  "backendOutcome",
  "workerOutcome",
  "sessionDisposition",
];

// Provider events can carry private text and nested payloads, so only copy
// primitive fields whose values have an explicit runtime allowlist.
export function sanitizeBackendDiagnostic(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  let descriptors;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return null;
  }
  const safe = {};
  for (const [field, allowed] of Object.entries(diagnosticFields)) {
    const descriptor = descriptors[field];
    if (!descriptor || !Object.hasOwn(descriptor, "value")) continue;
    if (typeof descriptor.value === "string" && allowed.has(descriptor.value))
      safe[field] = descriptor.value;
  }
  for (const field of ["trustedTerminal", "wrapperError"])
    if (
      descriptors[field] &&
      Object.hasOwn(descriptors[field], "value") &&
      typeof descriptors[field].value === "boolean"
    )
      safe[field] = descriptors[field].value;
  const exitCode = descriptors.exitCode?.value;
  if (
    descriptors.exitCode &&
    Object.hasOwn(descriptors.exitCode, "value") &&
    Number.isSafeInteger(exitCode) &&
    exitCode >= -2147483648 &&
    exitCode <= 2147483647
  )
    safe.exitCode = exitCode;
  const elapsedMs = descriptors.elapsedMs?.value;
  if (
    descriptors.elapsedMs &&
    Object.hasOwn(descriptors.elapsedMs, "value") &&
    Number.isFinite(elapsedMs) &&
    elapsedMs >= 0 &&
    elapsedMs <= 86400000
  )
    safe.elapsedMs = Math.round(elapsedMs);
  const attempt = descriptors.attempt?.value;
  if (
    descriptors.attempt &&
    Object.hasOwn(descriptors.attempt, "value") &&
    Number.isInteger(attempt) &&
    attempt >= 0 &&
    attempt <= 1
  )
    safe.attempt = attempt;
  return Object.keys(safe).length ? safe : null;
}

export function recordBackendDiagnostic(memory, turnId, event, attempt) {
  const diagnostic = sanitizeBackendDiagnostic(event);
  if (!diagnostic || typeof turnId !== "string" || !turnId) return false;
  if (Number.isInteger(attempt) && attempt >= 0 && attempt <= 1)
    diagnostic.attempt = attempt;
  return memory.store.transaction(() => {
    const row = turnRecord(memory, turnId);
    if (!row) return false;
    const record = JSON.parse(row.value);
    if (record.status !== "running") return false;
    const previous = Array.isArray(record.backendDiagnostics)
      ? record.backendDiagnostics.map(sanitizeBackendDiagnostic).filter(Boolean)
      : [];
    const next = {
      ...record,
      backendDiagnostics: [...previous.slice(-15), diagnostic],
    };
    for (const field of diagnosticSummaryFields) {
      const value = diagnostic[field] ?? record[field];
      if (diagnosticFields[field].has(value)) next[field] = value;
      else delete next[field];
    }
    memory.identity.put("model_turns", next);
    return true;
  });
}

const retirementSources = new Set([
  "configuration",
  "global-pause",
  "agent-pause",
  "conversation-pause",
  "administrator-cancel",
  "administrator-reset",
  "connection-disconnect",
  "service-stop",
  "turn-timeout",
  "backend",
  "lifecycle",
  "process-recovery",
  "protected-work",
]);
export function recordRetirementCause(
  memory,
  turnId,
  { source, changes = [] },
) {
  if (!retirementSources.has(source)) throw Error("INVALID_RETIREMENT_SOURCE");
  patchTurn(memory, turnId, {
    retirementCause: {
      source,
      changes: changes
        .filter((key) =>
          /^(?:agent|backend|connection)\.[A-Za-z]+$|^mode$/.test(key),
        )
        .sort(),
    },
  });
}
export function recordInputSubmission(memory, turnId) {
  const row = turnRecord(memory, turnId);
  if (row && JSON.parse(row.value).inputStage === "not-submitted")
    patchTurn(memory, turnId, { inputStage: "submission-attempted" });
}

// Store fixed timing fields only; provider events may contain private payloads.
export function recordBackendTiming(memory, turnId, timing) {
  const phases = new Set([
    "prepared",
    "inputSubmitted",
    "initialized",
    "firstResponse",
    "lastResponse",
    "terminal",
    "complete",
  ]);
  if (
    !timing ||
    !phases.has(timing.phase) ||
    !Number.isFinite(timing.elapsedMs) ||
    timing.elapsedMs < 0 ||
    timing.elapsedMs > 86400000
  )
    return;
  const row = turnRecord(memory, turnId);
  if (!row) return;
  const record = JSON.parse(row.value);
  if (record.status !== "running") return;
  const previous = record.backendTiming || { unit: "ms", phases: {} };
  patchTurn(memory, turnId, {
    backendTiming: {
      unit: "ms",
      phases: {
        ...previous.phases,
        [timing.phase]: Math.round(timing.elapsedMs),
      },
      ...(typeof timing.processReused === "boolean"
        ? { processReused: timing.processReused }
        : typeof previous.processReused === "boolean"
          ? { processReused: previous.processReused }
          : {}),
    },
  });
}

// Only call for scopes with no active owner (startup, or before the next turn).
// A failed archival/terminal write leaves running durable and retries here.
export function recoverSessions(memory, at, scope) {
  const rows = memory.db
    .prepare(
      "SELECT value FROM model_turns WHERE agent_id=? AND json_extract(value,'$.status')='running' AND (? IS NULL OR json_extract(value,'$.conversation')=?)",
    )
    .all(memory.agentId, scope ?? null, scope ?? null);
  for (const row of rows) {
    const t = JSON.parse(row.value);
    // Slang learner turns (removed in 0.5.3) keep their records, but nothing
    // owns their scope any more, so only the turn itself is closed.
    if (!t.conversation.startsWith("learner:"))
      retireSession(memory, t.conversation, "process-recovery", at, {
        turnId: t.id,
        backendId: t.backendId,
      });
    patchTurn(memory, t.id, { status: "interrupted", endedAt: at });
  }
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
  ) {
    const turn = turnRecord(memory, turnId);
    const record = turn && JSON.parse(turn.value);
    const source = record?.retirementCause?.source;
    const details = {
      source: retirementSources.has(source)
        ? source
        : ["backend-failure", "backend-worker-unavailable"].includes(reason)
          ? "backend"
          : reason === "process-recovery"
            ? "process-recovery"
            : "lifecycle",
      inputStage: [
        "not-submitted",
        "submission-attempted",
        "accepted",
      ].includes(record?.inputStage)
        ? record.inputStage
        : "unknown",
      changes: record?.retirementCause?.changes || [],
      ...(reason === "backend-failure" && record?.backendFailures?.length
        ? { backendFailure: record.backendFailures.at(-1) }
        : {}),
      ...extra.details,
    };
    memory.identity.put("session_history", {
      id,
      conversation: scope,
      session: reference,
      turnId: turnId || null,
      backendId: backendId || null,
      reason,
      at,
      ...extra,
      details,
    });
  }
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
    const value = memory.state(scope),
      owner = turnId ?? value.lastTurnId;
    const owns = !turnId || !value.lastTurnId || value.lastTurnId === turnId;
    const record = turnRecord(memory, owner);
    const recordValue = record && JSON.parse(record.value);
    const updateDisposition =
      recordValue &&
      (recordValue.sessionDisposition === "retiring" ||
        (Array.isArray(recordValue.backendDiagnostics) &&
          recordValue.backendDiagnostics.length > 0));
    const previous =
      session ||
      (owns ? value.session : null) ||
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
      memory.setState(scope, {
        ...value,
        session: null,
        feedThroughSeq: value.readThroughSeq || 0,
        usage: null,
        lifecycle: { status: "retired", reason, at },
      });
    // Persist the outcome only after archival and scope clearing both succeed.
    if (updateDisposition && (previous || owns)) {
      const current = turnRecord(memory, owner);
      if (current) {
        const turn = JSON.parse(current.value);
        if (turn.sessionDisposition !== "retired")
          memory.identity.put("model_turns", {
            ...turn,
            sessionDisposition: "retired",
          });
      }
    }
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
    const value = memory.state(scope);
    patchTurn(memory, turnId, { backendSession: reference, backendId });
    const turn = turnRecord(memory, turnId);
    if (
      inactive ||
      value.lastTurnId !== turnId ||
      (turn && JSON.parse(turn.value).status !== "running")
    ) {
      archive(memory, scope, reference, {
        turnId,
        backendId,
        reason: "cancelled-during-session-creation",
        at,
      });
      return;
    }
    memory.setState(scope, { ...value, session: reference });
  });
}

export function recordBackendTurn(memory, turnId, reference) {
  if (typeof reference?.turnId !== "string" || reference.turnId.length > 512)
    return;
  const row = turnRecord(memory, turnId);
  const record = row && JSON.parse(row.value);
  const ids =
    record?.backendTurnIds ||
    (record?.backendTurnId ? [record.backendTurnId] : []);
  patchTurn(memory, turnId, {
    ...(reference.inputAccepted !== false ? { inputStage: "accepted" } : {}),
    backendTurnId: reference.turnId,
    backendTurnIds: [...new Set([...ids, reference.turnId])].slice(-8),
  });
}
