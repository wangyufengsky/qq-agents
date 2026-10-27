import { sourceCounts } from "./outbound-policy.mjs";

// Explicit allowlist: capabilities and backend credentials never enter this view.
export function runtimeStatus(runtime) {
  return {
    recentErrors: runtime.diagnostics.snapshot(),
    mode: runtime.config.mode,
    globalPaused: runtime.config.globalPaused,
    backends: runtime.backendConnections.list(),
    connections: runtime.config.connections.map((c) => ({
      id: c.id,
      connected: !!runtime.transports.get(c.id)?.connected,
      process: runtime.lifecycle?.status(c.id),
      error: runtime.faults.get(c.id) || null,
    })),
    agents: runtime.config.agents.map((a) => ({
      id: a.id,
      paused: a.paused,
      activeTurns: [...runtime.running.values()].filter(
        (c) => c.agentId === a.id,
      ).length,
      error: runtime.faults.get(a.id) || null,
    })),
    disclosureRequests: [...runtime.capabilities.values()]
      .filter((c) => runtime.currentDisclosure(c))
      .filter((c) =>
        c.disclosureRequest?.requestId
          ? !c.externalGrants?.has(c.disclosureRequest.requestId)
          : c.disclosureRequest?.records.some((id) => !c.grants.has(id)),
      )
      .map((c) => ({
        approvalId: c.disclosureRequest.approvalId,
        agentId: c.agentId,
        conversation: c.conversation,
        reason: c.disclosureRequest.reason,
        requestId: c.disclosureRequest.requestId,
        request: c.disclosureRequest.request,
        sourceClasses: sourceCounts(runtime, c),
        records: c.disclosureRequest.requestId
          ? c.disclosureRequest.records
          : c.disclosureRequest.records.filter((id) => !c.grants.has(id)),
        granted: [...c.grants],
      })),
  };
}
