import { createHash, randomUUID } from "node:crypto";
import {
  recordBackendTurn,
  recoverSessions,
  retireSession,
  saveSession,
} from "../core/session-records.mjs";
import { sessionWasUnchanged } from "../backends/turn-failure.mjs";
import { decisionTool } from "./desktop-decision.mjs";

export function beginDesktopContext(
  runtime,
  agent,
  backend,
  instructions,
  prompt,
  signal,
) {
  const memory = runtime.memory.bind(agent.id);
  const now = runtime.now();
  const scope = "@desktop";
  recoverSessions(memory, now, scope);
  const self = memory.identity.initialize(agent, now);
  const { name, description, parameters } = decisionTool.function;
  const signature = backend.sessionSignature?.([
    { name, description, inputSchema: parameters },
  ]);
  const instructionsHash = createHash("sha256")
    .update(instructions)
    .digest("hex");
  let state = memory.state(scope);
  if (
    state.session &&
    (state.loadedSelfVersion !== self.version ||
      state.loadedInstructionsHash !== instructionsHash ||
      state.desktopBackendId !== agent.backendId ||
      (signature && state.session.signature !== signature))
  ) {
    const reason =
      state.loadedSelfVersion !== self.version
        ? "self-version-change"
        : state.loadedInstructionsHash !== instructionsHash
          ? "identity-or-protocol-change"
          : "backend-contract-change";
    retireSession(memory, scope, reason, now, {
      backendId: state.desktopBackendId,
    });
    state = memory.state(scope);
  }
  const turnId = randomUUID();
  const session = state.session;
  const ctx = {
    agentId: agent.id,
    conversation: scope,
    turnId,
    turnStartedAt: now,
    estimatedAdded: prompt.length + (session ? 0 : instructions.length),
    controller: { signal },
  };
  memory.store.transaction(() => {
    memory.setState(scope, {
      ...state,
      lastTurnId: turnId,
      loadedSelfVersion: self.version,
      loadedInstructionsHash: instructionsHash,
      desktopBackendId: agent.backendId,
    });
    memory.identity.put("model_turns", {
      id: turnId,
      conversation: scope,
      backendId: agent.backendId,
      backendSession: session ?? null,
      startedAt: now,
      status: "running",
      phase: "running",
      selfVersion: self.version,
    });
  });
  return {
    conversation: scope,
    session,
    saveSession: (value) =>
      saveSession(memory, scope, value, {
        turnId,
        backendId: agent.backendId,
        at: runtime.now(),
        inactive: signal.aborted,
      }),
    onUsage: (value) => runtime.contexts.usage(ctx, value),
    onBackendTurn: (value) => recordBackendTurn(memory, turnId, value),
    finish(error) {
      ctx.retainBackendSession = !signal.aborted && sessionWasUnchanged(error);
      return runtime.contexts.finish(
        ctx,
        signal.aborted ? "cancelled" : error ? "failed" : "completed-no-send",
        backend,
      );
    },
  };
}
