import { isPrivateLikeGroup, validateConfig } from "./config.mjs";
import { configImpact, changedConfigFields } from "./config-impact.mjs";
import { waitForDrain } from "../updates/drain.mjs";
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
  const finishing = [
    ...new Set([...runtime.capabilities.values(), ...runtime.running.values()]),
  ]
    .filter((ctx) => agentIds.has(ctx.agentId) && ctx.done)
    .map((ctx) => ctx.done);
  runtime.configChanging = true;
  let settle;
  // Lets a safety control (pause) wait out this commit instead of failing.
  runtime.configSettled = new Promise((resolve) => (settle = resolve));
  runtime.reconfiguringAgents = agentIds;
  runtime.reconfiguringConnections = connectionIds;
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
    if (impact.drainAgentIds.size) {
      const contexts = new Set(
        [...runtime.capabilities.values(), ...runtime.running.values()].filter(
          (ctx) => impact.drainAgentIds.has(ctx.agentId),
        ),
      );
      const pending = new Set(
        [...contexts].filter((ctx) => ctx.done).map((ctx) => ctx.done),
      );
      for (const promise of pending) {
        const done = () => pending.delete(promise);
        promise.then(done, done);
      }
      const controller = new AbortController();
      runtime.configDrain = {
        connectionIds,
        contexts,
        controller,
        deadline:
          Math.max(Date.now(), ...[...contexts].map((ctx) => ctx.expires)) +
          40000,
      };
      try {
        await waitForDrain(
          async () => ({
            active: true,
            deadline: runtime.configDrain.deadline,
            pending:
              pending.size +
              [...contexts].filter(
                (ctx) => !ctx.done && runtime.capabilities.has(ctx.token),
              ).length +
              [...connectionIds].filter((id) => runtime.sendChains.has(id))
                .length,
          }),
          controller.signal,
        );
      } catch (error) {
        controller.signal.throwIfAborted();
        if (error.message === "UPDATE_DRAIN_TIMEOUT")
          throw Error("CONFIG_DRAIN_TIMEOUT", { cause: error });
        throw error;
      }
      runtime.configDrain = null;
    }
    // Commit before revoking permissions; a failed disk write leaves old work usable.
    runtime.configStore.save(next, revision);
    for (const [token, ctx] of runtime.capabilities)
      if (agentIds.has(ctx.agentId)) {
        runtime.abortContext(
          ctx,
          "configuration",
          changedConfigFields(before, next, ctx.agentId),
        );
        runtime.capabilities.delete(token);
      }
    for (const ctx of runtime.running.values())
      if (agentIds.has(ctx.agentId))
        runtime.abortContext(
          ctx,
          "configuration",
          changedConfigFields(before, next, ctx.agentId),
        );
    for (const key of runtime.pending.keys())
      if (agentIds.has(key.split("|")[0])) runtime.pending.delete(key);
    await apply(() => {
      // Drop ordinary wakes created under the old group policy without replacing sessions
      // or resetting budgets. Delivery rechecks current admission even for active turns.
      for (const group of new Set([
        ...(before.privateLikeGroups || []),
        ...next.privateLikeGroups,
      ])) {
        const conversation = "group:" + group;
        if (
          isPrivateLikeGroup(before, conversation) ===
          isPrivateLikeGroup(next, conversation)
        )
          continue;
        runtime.banter.groups.delete(group);
        for (const a of next.agents) {
          const mem = runtime.memory.bind(a.id),
            state = mem.state(conversation);
          // Pre-switch arrivals are not new peer opportunities, including messages
          // read by a still-active turn while the ordinary policy was in effect.
          state.peerReplyInputSeq = Math.max(
            state.peerReplyInputSeq || 0,
            state.lastReceivedSeq || 0,
          );
          state.pendingWakes = (state.pendingWakes || []).filter(
            (wake) => wake.taskRunId || wake.intentId,
          );
          delete state.wakeBatchAt;
          delete state.wakeBatchSenders;
          if (!state.pendingWakes.length) delete state.wakeDueAt;
          mem.setState(conversation, state);
        }
      }
    });
    await Promise.all(
      [...impact.paused].map((id) =>
        apply(() =>
          runtime.cancel(
            id,
            next.globalPaused ? "global-pause" : "agent-pause",
          ),
        ),
      ),
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
    runtime.configDrain = null;
    runtime.reconfiguringAgents = new Set();
    runtime.reconfiguringConnections = new Set();
    runtime.configChanging = false;
    settle();
  }
}
