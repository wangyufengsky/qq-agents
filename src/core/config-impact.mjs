// @ts-check
import { isDeepStrictEqual } from "node:util";
import { backendSessionConfig } from "../backends/session-contract.mjs";
/** @typedef {{id: string, [key: string]: unknown}} Entity */
/** @typedef {ReturnType<typeof import("./config.mjs").validateConfig>} Configuration */
/** @typedef {Configuration["agents"][number]} Agent */
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
/** Recovery policy is read on each tick; editing it must not drop the socket.
 * @param {Entity} value */
function connectionOperational(value) {
  const {
    label: _label,
    recovery: _recovery,
    webUrl: _webUrl,
    ...rest
  } = value;
  return rest;
}
/** @param {Entity} value */
function connectionIdentity(value) {
  const {
    httpUrl: _h,
    wsUrl: _w,
    tokenEnv: _t,
    ...rest
  } = connectionOperational(value);
  return rest;
}
/** @param {Configuration} config @param {string} agentId */
function agentBackend(config, agentId) {
  const a = config.agents.find((a) => a.id === agentId);
  if (!a) return undefined;
  const b = config.backends.find((b) => b.id === a.backendId);
  if (!b) return undefined;
  return backendSessionConfig({ ...b, model: a.model || b.model });
}
/** @param {Agent} value */
function agentPolicy(value) {
  // Scheduling, display and limits do not revoke a transcript's authority.
  // Permission-bearing policies stay in the comparison and still cancel work.
  const {
    paused: _p,
    wake: _w,
    behavior: _b,
    contextPolicy: _c,
    selfPolicy: _s,
    persona: _persona,
    effort: _effort,
    model: _model,
    ...rest
  } = value;
  const {
    intervalMs: _i,
    maxChecksPerDay: _checks,
    maxContactsPerDay: _contacts,
    contactCooldownMs: _cooldown,
    unansweredCooldownMs: _unanswered,
    maxToolCallsPerTurn: _tools,
    sessionMode: _mode,
    ...subject
  } = value.subject;
  const {
    timezone: _tz,
    maxTasks: _max,
    perTaskPerDay: _task,
    totalPerDay: _total,
    perGroupPerDay: _group,
    minIntervalMin: _interval,
    missedGraceMin: _grace,
    jitterMin: _jitter,
    quietEnabled: _quiet,
    quietAllDay: _day,
    quietStart: _start,
    quietEnd: _end,
    holidays: _holidays,
    ...scheduler
  } = value.scheduler;
  return {
    ...rest,
    scheduler,
    tools: unordered(value.tools),
    ownerIds: unordered(value.ownerIds),
    aliases: unordered(value.aliases),
    allow: {
      groups: unordered(value.allow.groups),
      users: unordered(value.allow.users),
    },
    voice: { ...value.voice, tts: { enabled: value.voice.tts.enabled } },
    subject: {
      ...subject,
      groups: unordered(subject.groups),
      users: unordered(subject.users),
      readTools: unordered(subject.readTools),
    },
  };
}
/** @param {string[]} values */
const unordered = (values) => [...new Set(values)].sort();
/** Field names only: neither configuration values nor credentials enter history.
 * @param {Configuration} before @param {Configuration} after @param {string} id */
export function changedConfigFields(before, after, id) {
  const a = before.agents.find((a) => a.id === id),
    b = after.agents.find((a) => a.id === id);
  /** @param {string} kind @param {Record<string,unknown> | undefined} left @param {Record<string,unknown> | undefined} right */
  const fields = (kind, left, right) =>
    [...new Set([...Object.keys(left || {}), ...Object.keys(right || {})])]
      .filter((key) => !isDeepStrictEqual(left?.[key], right?.[key]))
      .map((key) => kind + "." + key);
  return [
    ...fields("agent", a, b),
    ...fields(
      "backend",
      before.backends.find((x) => x.id === a?.backendId),
      after.backends.find((x) => x.id === b?.backendId),
    ),
    ...fields(
      "connection",
      before.connections.find((x) => x.id === a?.connectionId),
      after.connections.find((x) => x.id === b?.connectionId),
    ),
    ...(before.mode !== after.mode ? ["mode"] : []),
  ];
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
  const backendIds = changed(
    before.backends,
    after.backends,
    backendSessionConfig,
  );
  const agentIds = changed(before.agents, after.agents, agentPolicy);
  const backendAgentIds = changed(before.agents, after.agents, backendPolicy);
  const {
    agents: _a,
    connections: _c,
    backends: _b,
    port: _p,
    globalPaused: _g,
    privateLikeGroups: _privateLikeGroups,
    peerLimit: _peerLimit,
    ...oldGlobal
  } = before;
  const {
    agents: _na,
    connections: _nc,
    backends: _nb,
    port: _np,
    globalPaused: _ng,
    privateLikeGroups: _newPrivateLikeGroups,
    peerLimit: _newPeerLimit,
    ...newGlobal
  } = after;
  const globalChanged = !isDeepStrictEqual(oldGlobal, newGlobal);
  const identityConnections = changed(
    before.connections,
    after.connections,
    connectionIdentity,
  );
  const drainAgentIds = new Set();
  for (const id of new Set(
    [...before.agents, ...after.agents].map((a) => a.id),
  )) {
    const a =
      after.agents.find((a) => a.id === id) ||
      before.agents.find((a) => a.id === id);
    if (!a) continue;
    const nativeChanged = !isDeepStrictEqual(
      agentBackend(before, id),
      agentBackend(after, id),
    );
    const revoked =
      globalChanged ||
      agentIds.has(id) ||
      identityConnections.has(a.connectionId) ||
      nativeChanged;
    if (revoked) {
      agentIds.add(id);
      backendAgentIds.add(id);
    } else if (connectionIds.has(a.connectionId)) {
      agentIds.add(id);
      drainAgentIds.add(id);
    }
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
  // A transaction containing revocation or pause keeps the immediate safety path.
  if (paused.size || [...agentIds].some((id) => !drainAgentIds.has(id)))
    drainAgentIds.clear();
  return {
    drainAgentIds,
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
