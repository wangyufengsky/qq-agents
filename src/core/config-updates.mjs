import { validateConfig } from "./config.mjs";
import { configImpact } from "./config-impact.mjs";
import { SUBJECT } from "./lifecycle.mjs";
import { BanterCoordinator } from "../../vendor/local-bridge/banter.mjs";

export async function commitConfig(runtime, next, revision) {
  if (runtime.closed) throw Error("RUNTIME_CLOSING");
  if (runtime.configChanging) throw Error("CONFIG_CONFLICT");
  next = validateConfig(next);
  if (revision !== runtime.configStore.revision) throw Error("CONFIG_CONFLICT");
  const before = runtime.config;
  const impact = configImpact(before, next);
  const { agentIds, connectionIds, backendIds } = impact;
  const affectedBackends = new Set(
    [...before.agents, ...next.agents]
      .filter((a) => agentIds.has(a.id))
      .map((a) => a.backendId),
  );
  for (const id of new Set([...affectedBackends, ...backendIds]))
    if (runtime.backendConnections.operations.has(id))
      throw Error("BACKEND_OPERATION_IN_PROGRESS");
  for (const id of connectionIds)
    if (runtime.lifecycle?.owned.has(id))
      throw Error("STOP_MANAGED_QQ_PROCESSES_BEFORE_CONFIG_EDIT");
  // Disk commit precedes revocation, with no await between the two.
  const finishing = [
    ...new Set([...runtime.capabilities.values(), ...runtime.running.values()]),
  ]
    .filter((ctx) => agentIds.has(ctx.agentId) && ctx.done)
    .map((ctx) => ctx.done);
  runtime.configStore.save(next, revision);
  runtime.configChanging = true;
  let settle;
  // Lets a safety control (pause) wait out this commit instead of failing.
  runtime.configSettled = new Promise((resolve) => (settle = resolve));
  runtime.reconfiguringAgents = agentIds;
  runtime.reconfiguringConnections = connectionIds;
  for (const [token, ctx] of runtime.capabilities)
    if (agentIds.has(ctx.agentId)) {
      ctx.controller.abort();
      runtime.capabilities.delete(token);
    }
  for (const ctx of runtime.running.values())
    if (agentIds.has(ctx.agentId)) ctx.controller.abort();
  for (const key of runtime.pending.keys())
    if (agentIds.has(key.split("|")[0])) runtime.pending.delete(key);
  let failed = false;
  const report = (cause, retry) => {
    failed = true;
    if (retry) runtime.retiredResources.add(retry);
    runtime.diagnostics.report(Error("CONFIG_RECONFIGURE_FAILED", { cause }), {
      component: "config",
    });
  };
  const apply = async (fn, resource = false) => {
    try {
      await fn();
    } catch (cause) {
      report(cause, resource ? fn : null);
    }
  };
  try {
    await Promise.all(
      [...impact.paused].map((id) => apply(() => runtime.cancel(id))),
    );
    for (const id of agentIds) {
      runtime.operations.revoke(id, false);
      const a = next.agents.find((a) => a.id === id);
      if (a)
        await apply(() =>
          runtime.memory.bind(id).identity.initialize(a, runtime.now()),
        );
      if (!impact.backendAgentIds.has(id)) continue;
      const backend = runtime.backends.get(id);
      runtime.backends.delete(id);
      if (backend) await apply(() => backend.close?.(), true);
    }
    await Promise.allSettled(finishing);
    for (const id of backendIds) runtime.backendConnections.states.delete(id);
    // Preserve other agents' health observations on a shared backend.
    for (const state of runtime.backendConnections.states.values())
      state.agents = state.agents.filter((a) => !agentIds.has(a.id));
    for (const id of impact.intervalIds)
      await apply(() => {
        const m = runtime.memory.bind(id),
          state = m.state(SUBJECT);
        m.setState(SUBJECT, {
          ...state,
          nextCheckAt:
            (state.lastOpportunityAt || runtime.now()) +
            runtime.agent(id).subject.intervalMs,
        });
      });
    for (const id of connectionIds) {
      // reconnectRequired: an edited connection waits for a manual connect.
      runtime.connectionRecovery.disarm(id);
      const transport = runtime.transports.get(id);
      runtime.transports.delete(id);
      if (transport) await apply(() => transport.close(), true);
    }
    if (impact.resetBanter)
      runtime.banter = new BanterCoordinator({
        botIds: next.connections.map((c) => c.accountId),
        ...next.peerLimit,
      });
    // No await between the final refresh and lifting the per-agent gates.
    for (const id of new Set([...agentIds, ...impact.resumed])) {
      try {
        runtime.memory.due.rebuild(id);
      } catch (cause) {
        report(cause);
      }
    }
    return {
      saved: true,
      affectedAgents: [...agentIds],
      reconnectRequired: connectionIds.size > 0,
      reconnectConnections: [...connectionIds].filter((id) =>
        next.connections.some((c) => c.id === id && c.enabled),
      ),
      restartRequired: impact.restartRequired,
      ...(failed ? { warnings: ["CONFIG_RECONFIGURE_FAILED"] } : {}),
    };
  } finally {
    runtime.reconfiguringAgents = new Set();
    runtime.reconfiguringConnections = new Set();
    runtime.configChanging = false;
    settle();
  }
}
