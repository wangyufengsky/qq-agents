// @ts-check
import { rhythmStatus } from "./rhythm.mjs";
import { sourceCounts } from "./outbound-policy.mjs";

// Explicit allowlist: capabilities and backend credentials never enter this view.
/** @param {any} runtime */
export function runtimeStatus(runtime) {
  return {
    recentErrors: runtime.diagnostics.snapshot(),
    mode: runtime.config.mode,
    globalPaused: runtime.config.globalPaused,
    maintenance: runtime.maintenance.snapshot(),
    autoResume: runtime.autoResume.snapshot(),
    backends: runtime.backendConnections.list(),
    connections: runtime.config.connections.map((/** @type {any} */ c) => ({
      id: c.id,
      connected: !!runtime.transports.get(c.id)?.connected,
      process: runtime.lifecycle?.status(c.id),
      error: runtime.faults.get(c.id) || null,
      recovery: runtime.connectionRecovery.snapshot(c.id),
    })),
    agents: runtime.config.agents.map((/** @type {any} */ a) => {
      const c = runtime.config.connections.find(
        (/** @type {any} */ c) => c.id === a.connectionId,
      );
      return {
        id: a.id,
        paused: a.paused,
        rhythm: rhythmStatus(runtime, a),
        activeTurns: [...runtime.running.values()].filter(
          (c) => c.agentId === a.id,
        ).length,
        error: runtime.faults.get(a.id) || null,
        blockers: [
          ...runtime.blockers(a),
          ...(!c?.enabled
            ? ["CONNECTION_DISABLED"]
            : runtime.transports.get(c.id)?.connected
              ? []
              : ["QQ_NOT_CONNECTED"]),
        ],
        unresolvedDeliveries: runtime.memory
          .bind(a.id)
          .unresolvedDeliveryCount(),
      };
    }),
    disclosureRequests: [...runtime.capabilities.values()]
      .filter((c) => runtime.currentDisclosure(c))
      .filter((c) =>
        c.disclosureRequest?.requestId
          ? !c.externalGrants?.has(c.disclosureRequest.requestId)
          : c.disclosureRequest?.records.some(
              (/** @type {string} */ id) => !c.grants.has(id),
            ),
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
          : c.disclosureRequest.records.filter(
              (/** @type {string} */ id) => !c.grants.has(id),
            ),
        granted: [...c.grants],
      })),
  };
}
