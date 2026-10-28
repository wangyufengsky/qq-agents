import { SUBJECT } from "./lifecycle.mjs";
import { toolSpecs } from "../tools/specs.mjs";
import { runWithRecovery, failureSummary } from "../backends/turn-failure.mjs";
import { isConnectionFailure } from "./backend-connections.mjs";
import {
  saveSession,
  recordBackendTurn,
  retireSession,
} from "./session-records.mjs";

// Owns a model turn through finalization; done settles only after all bookkeeping.
export class TurnRunner {
  constructor(runtime) {
    this.runtime = runtime;
  }
  async runTurn(agentId, conversation, { reasons = [] } = {}) {
    const runtime = this.runtime;
    if (runtime.closed) throw Error("RUNTIME_CLOSING");
    const a = runtime.agent(agentId);
    if (!runtime.writable(a, conversation)) throw Error("AGENT_PAUSED");
    if (
      conversation !== SUBJECT &&
      !runtime.transports.get(a.connectionId)?.connected
    )
      throw Error("QQ_NOT_CONNECTED");
    const runKey = agentId + "|" + conversation;
    if (runtime.running.has(runKey)) return;
    const mem = runtime.memory.bind(agentId);
    runtime.protectedWork.prepareDaily(agentId, conversation);
    const freshSubject = runtime.contexts.startFreshSubject(
      agentId,
      conversation,
    );
    const ctx = runtime.makeContext(agentId, conversation),
      { token, controller } = ctx;
    ctx.freshSubject = freshSubject;
    let resolveDone;
    ctx.done = new Promise((resolve) => {
      resolveDone = resolve;
    });
    runtime.conversations.begin(ctx);
    runtime.subject.begin(ctx, reasons);
    ctx.scheduleRunId = reasons
      .map((r) => r.taskRunId)
      .find(
        (id) =>
          id &&
          runtime.scheduler
            .state(agentId)
            .history.some(
              (run) =>
                run.id === id &&
                run.target === conversation &&
                run.status === "queued",
            ),
      );
    ctx.allowedTools = runtime.toolsFor(a, conversation);
    runtime.running.set(runKey, ctx);
    const state = mem.state(conversation);
    state.lastWakeAt = runtime.now();
    state.pendingWake = false;
    mem.setState(conversation, state);
    const timer = setTimeout(() => {
      if (controller.signal.aborted) return;
      runtime.faults.set(agentId, "BACKEND_TURN_TIMEOUT");
      controller.abort();
    }, a.behavior.turnTimeoutMs);
    let outcome = "completed-no-send",
      backend;
    try {
      backend = runtime.backendConnections.adapter(a);
      const tools = toolSpecs(ctx.allowedTools);
      const prepared = runtime.contexts.prepare(ctx, backend, reasons, tools);
      if (ctx.initialSession)
        ctx.estimatedAdded += JSON.stringify(tools).length;
      await this.runBackend(ctx, backend, {
        agent: a,
        conversation,
        prompt: prepared.prompt,
        instructions: prepared.instructions,
        onUsage: (usage) =>
          !runtime.stopped && runtime.contexts.usage(ctx, usage),
        signal: controller.signal,
        tools,
        callTool: (name, args) => runtime.callTool(ctx, name, args),
        session: prepared.session,
        saveSession: (session) =>
          !runtime.stopped &&
          saveSession(mem, conversation, session, {
            turnId: ctx.turnId,
            backendId: a.backendId,
            at: runtime.now(),
            inactive:
              !runtime.capabilities.has(token) ||
              controller.signal.aborted ||
              runtime.closed,
            reason: controller.signal.aborted ? "cancelled" : "backend-failure",
          }),
        onBackendTurn: (reference) =>
          !runtime.stopped && recordBackendTurn(mem, ctx.turnId, reference),
        onImageSession: (id) =>
          !runtime.stopped && runtime.generatedImages.begin(ctx, id),
        onGeneratedImage: (id, item) =>
          !runtime.stopped &&
          runtime.generatedImages.capture(ctx, backend, id, item),
        onImageError: () => {
          if (!controller.signal.aborted) {
            ctx.imageRegistrationFailed = true;
            runtime.faults.set(agentId, "GENERATED_IMAGE_REGISTRATION_FAILED");
          }
        },
      });
      outcome = controller.signal.aborted
        ? "cancelled"
        : ctx.confirmedSends
          ? "sent"
          : "completed-no-send";
      if (!controller.signal.aborted && !ctx.imageRegistrationFailed)
        runtime.faults.delete(agentId);
    } catch (e) {
      outcome = controller.signal.aborted ? "cancelled" : "failed";
      if (!controller.signal.aborted)
        runtime.diagnostics.report(Error("BACKEND_TURN_FAILED", { cause: e }), {
          component: "runtime",
          agentId,
          conversation,
        });
      const failure = failureSummary(e);
      const classifiedFault =
        failure && failure.code !== "TURN_FAILED"
          ? (
              failure.backend +
              "_" +
              failure.code.replace(/([a-z])([A-Z])/g, "$1_$2")
            ).toUpperCase()
          : null;
      if (!controller.signal.aborted && isConnectionFailure(e))
        runtime.backendConnections.failed(a.backendId, e);
      // Administrative cancellation is an expected lifecycle transition. Keep
      // earlier genuine faults (including the deadline), but do not invent one.
      if (!controller.signal.aborted)
        runtime.faults.set(
          agentId,
          e.message === "AGENT_PAUSED_OR_EXPIRED"
            ? "PAUSED"
            : classifiedFault ||
                (/^DSH_[A-Z_]+$/.test(e.message)
                  ? e.message
                  : "BACKEND_TURN_FAILED"),
        );
    } finally {
      runtime.capabilities.delete(token);
      try {
        try {
          runtime.subject.finish(ctx, outcome);
          if (ctx.turnId) await runtime.contexts.finish(ctx, outcome, backend);
        } catch (error) {
          runtime.faults.set(agentId, "CONTEXT_FINALIZATION_FAILED");
          runtime.diagnostics.report(error, {
            component: "runtime",
            agentId,
            conversation,
          });
          if (ctx.turnId)
            retireSession(
              mem,
              conversation,
              "finalization-failed",
              runtime.now(),
              {
                turnId: ctx.turnId,
                backendId: a.backendId,
              },
            );
        }
        for (const reason of reasons)
          if (reason.taskRunId)
            runtime.scheduler.finish(agentId, reason.taskRunId, outcome);
        // Allow the next queued wake to start; ctx.done still covers all finalization.
        runtime.running.delete(runKey);
        if (
          !controller.signal.aborted &&
          !runtime.closed &&
          runtime.config.agents.some((a) => a.id === agentId) &&
          conversation !== SUBJECT
        )
          runtime.conversations.finish(ctx);
      } finally {
        clearTimeout(timer);
        if (runtime.running.get(runKey) === ctx) runtime.running.delete(runKey);
        resolveDone();
      }
    }
    return { status: outcome };
  }
  async runBackend(ctx, backend, params) {
    const runtime = this.runtime;
    const mem = runtime.memory.bind(ctx.agentId);
    try {
      const result = await runWithRecovery(backend, params, {
        onFailure: (error, attempt) => {
          const failure = failureSummary(error);
          if (!failure) return;
          const turn = mem.identity.get("model_turns", ctx.turnId);
          if (turn)
            mem.identity.put("model_turns", {
              ...turn,
              backendFailures: [
                ...(turn.backendFailures || []),
                { ...failure, attempt, at: runtime.now() },
              ],
            });
        },
        onRecovery: (error, attempt) => {
          runtime.assertActive(ctx);
          ctx.recoveryDeliveryBlocked =
            ctx.deliveryAttempted === true || ctx.pendingDeliveries > 0;
          error.deliveryBlocked = ctx.recoveryDeliveryBlocked;
          const turn = mem.identity.get("model_turns", ctx.turnId);
          if (turn)
            mem.identity.put("model_turns", {
              ...turn,
              recoveryAttempts: attempt,
              recoveryDeliveryBlocked: ctx.recoveryDeliveryBlocked,
            });
        },
      });
      return result;
    } catch (error) {
      ctx.retainBackendSession =
        failureSummary(error)?.sessionReusable === true &&
        !ctx.controller.signal.aborted &&
        runtime.capabilities.has(ctx.token);
      throw error;
    }
  }
}
