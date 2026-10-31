import { allowedGroups } from "./config.mjs";
import { defaultConfig } from "./default-config.mjs";

// The go-live checklist the console shows first. It only reads config and the
// public status view; every fix still goes through the existing admin APIs.
const shipped = defaultConfig();
const placeholderAccounts = new Set(
  shipped.connections.map((c) => c.accountId),
);
const placeholderAgentNames = new Set(shipped.agents.map((a) => a.name));
const placeholderPersonas = new Set(shipped.agents.map((a) => a.persona));
// Gates the checklist explains itself; anything else in blockers is listed apart.
const covered = new Set([
  "ISOLATED_MODE",
  "GLOBAL_PAUSED",
  "AGENT_PAUSED",
  "BACKEND_UNAVAILABLE",
  "CONNECTION_DISABLED",
  "QQ_NOT_CONNECTED",
]);

export const isPlaceholderConnection = (c) =>
  placeholderAccounts.has(String(c?.accountId));
export const isPlaceholderAgent = (a) =>
  placeholderAgentNames.has(a?.name) || placeholderPersonas.has(a?.persona);

const step = (id, done, blocking, extra = {}) => ({
  id,
  done: !!done,
  blocking: !done && blocking,
  ...extra,
});

function agentSteps(config, status, a) {
  const c = config.connections.find((x) => x.id === a.connectionId),
    cs = status.connections?.find((x) => x.id === a.connectionId),
    b = config.backends.find((x) => x.id === a.backendId),
    bs = status.backends?.find((x) => x.id === a.backendId),
    as = status.agents?.find((x) => x.id === a.id),
    backendState = bs?.state || "unchecked",
    ids = { agentId: a.id, connectionId: a.connectionId };
  return [
    // A live connection has had its login account verified, placeholder or not.
    step("account", c && (cs?.connected || !isPlaceholderConnection(c)), true, {
      ...ids,
      detail: { accountId: c?.accountId ?? null, missing: !c },
    }),
    step("connection-enabled", c?.enabled, true, ids),
    step("connection-connected", cs?.connected, true, {
      ...ids,
      detail: {
        error: cs?.error || null,
        recovery: cs?.recovery?.state || null,
      },
    }),
    step(
      "whitelist",
      allowedGroups(a, config).length + a.allow.users.length > 0,
      true,
      {
        ...ids,
        detail: {
          groups: allowedGroups(a, config).length,
          users: a.allow.users.length,
        },
      },
    ),
    step("global-pause", !config.globalPaused, true),
    step("agent-pause", !a.paused, true, ids),
    // Unchecked is advisory: the first turn probes the backend anyway.
    step("backend", backendState === "ready", backendState !== "unchecked", {
      ...ids,
      backendId: a.backendId,
      detail: {
        state: backendState,
        error: bs?.error || null,
        type: b?.type || null,
      },
    }),
  ].concat(
    (as?.blockers || [])
      .filter((code) => !covered.has(code))
      .map((code) => step("other", false, true, { ...ids, detail: { code } })),
  );
}

/**
 * @param {any} config validated configuration
 * @param {any} status runtime.status()
 * @param {{allowLive?: boolean}} [options]
 */
export function readiness(config, status, { allowLive = false } = {}) {
  const global = [
    step("live-flag", allowLive, true),
    step("mode", config.mode === "live", true),
  ];
  const agents = config.agents.map((a) => {
    const steps = [...global, ...agentSteps(config, status, a)];
    return {
      agentId: a.id,
      ready: steps.every((s) => s.done),
      done: steps.filter((s) => s.done).length,
      steps,
    };
  });
  // Focus on the agent closest to speaking; config order breaks ties.
  const focus = agents.reduce(
    (best, a) => (!best || a.done > best.done ? a : best),
    null,
  );
  const steps = focus
    ? focus.steps
    : [
        ...global,
        step("agent", false, true),
        step("global-pause", !config.globalPaused, true),
      ];
  return {
    ready: agents.some((a) => a.ready),
    focusAgentId: focus?.agentId ?? null,
    steps,
    agents: agents.map(({ done: _done, ...a }) => a),
    placeholders: {
      agents: config.agents.filter(isPlaceholderAgent).map((a) => a.id),
      connections: config.connections
        .filter(isPlaceholderConnection)
        .map((c) => c.id),
    },
  };
}
