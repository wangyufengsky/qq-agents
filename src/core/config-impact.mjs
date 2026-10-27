// @ts-check
import { isDeepStrictEqual } from "node:util";
/** @typedef {{id: string, [key: string]: unknown}} Entity */
/** @typedef {Entity & {connectionId: string, backendId: string, wake: {participation?: number, [key: string]: unknown}, subject: {intervalMs?: number, maxChecksPerDay?: number, [key: string]: unknown}}} Agent */
/** @typedef {{agents: Agent[], connections: Entity[], backends: Entity[], port: number, [key: string]: unknown}} Configuration */
/** @template {Entity} T
 * @param {T[]} before @param {T[]} after @param {(value: T) => unknown} project */
function changed(before, after, project) {
  const old = new Map(before.map((v) => [v.id, v]));
  const next = new Map(after.map((v) => [v.id, v]));
  return new Set(
    [...old.keys(), ...next.keys()].filter((id) => {
      const a = old.get(id),
        b = next.get(id);
      return !isDeepStrictEqual(
        a ? project(a) : undefined,
        b ? project(b) : undefined,
      );
    }),
  );
}
/** @param {Entity} value */
function operational(value) {
  const { label: _label, ...rest } = value;
  return rest;
}
/** Recovery policy is read on each tick; editing it must not drop the socket.
 * @param {Entity} value */
function connectionOperational(value) {
  const { label: _label, recovery: _recovery, ...rest } = value;
  return rest;
}
/** @param {Agent} value */
function agentPolicy(value) {
  const result = structuredClone(value);
  // Pause flags are controls handled by commitConfig, not policy changes.
  delete result.paused;
  delete result.wake.participation;
  delete result.subject.intervalMs;
  delete result.subject.maxChecksPerDay;
  // Read when each free-time turn starts.
  delete result.subject.maxToolCallsPerTurn;
  delete result.subject.sessionMode;
  return result;
}
/** Tools and app/file permissions are supplied with every turn, and a changed tool
 * set retires the session through the context lifecycle; the adapter can stay.
 * @param {Agent} value */
function backendPolicy(value) {
  const { tools: _t, apps: _a, files: _f, ...rest } = agentPolicy(value);
  return rest;
}
/** Scheduling rates affect future opportunities without revoking a live turn.
 * @param {Configuration} before @param {Configuration} after */
export function configImpact(before, after) {
  const connectionIds = changed(
    before.connections,
    after.connections,
    connectionOperational,
  );
  if (before.mode !== after.mode)
    for (const c of [...before.connections, ...after.connections])
      connectionIds.add(c.id);
  const backendIds = changed(before.backends, after.backends, operational);
  const agentIds = changed(before.agents, after.agents, agentPolicy);
  const backendAgentIds = changed(before.agents, after.agents, backendPolicy);
  const {
    agents: _a,
    connections: _c,
    backends: _b,
    port: _p,
    globalPaused: _g,
    ...oldGlobal
  } = before;
  const {
    agents: _na,
    connections: _nc,
    backends: _nb,
    port: _np,
    globalPaused: _ng,
    ...newGlobal
  } = after;
  const globalChanged = !isDeepStrictEqual(oldGlobal, newGlobal);
  for (const a of [...before.agents, ...after.agents])
    if (
      globalChanged ||
      connectionIds.has(a.connectionId) ||
      backendIds.has(a.backendId)
    ) {
      agentIds.add(a.id);
      backendAgentIds.add(a.id);
    }
  const intervalIds = after.agents
    .filter(
      (a) =>
        before.agents.find((b) => b.id === a.id)?.subject.intervalMs !==
        a.subject.intervalMs,
    )
    .map((a) => a.id);
  const resetBanter =
    !isDeepStrictEqual(before.peerLimit, after.peerLimit) ||
    !isDeepStrictEqual(
      before.connections.map((c) => c.accountId),
      after.connections.map((c) => c.accountId),
    );
  // Pausing cancels work; resuming refreshes due work. Neither restarts backends.
  const paused = new Set(),
    resumed = new Set();
  for (const a of after.agents) {
    const was = before.agents.find((b) => b.id === a.id)?.paused;
    if (
      (!before.globalPaused && after.globalPaused) ||
      (a.paused && was === false)
    )
      paused.add(a.id);
    if (
      (before.globalPaused && !after.globalPaused) ||
      (!a.paused && was === true)
    )
      resumed.add(a.id);
  }
  return {
    agentIds,
    backendAgentIds,
    connectionIds,
    backendIds,
    intervalIds,
    paused,
    resumed,
    resetBanter,
    restartRequired: before.port !== after.port,
  };
}
