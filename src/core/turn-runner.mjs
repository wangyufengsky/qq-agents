import { startTypingIndicator } from "./typing-indicator.mjs";
import { prepareMessageImages } from "./message-images.mjs";
import { randomUUID } from "node:crypto";
import { SUBJECT } from "./lifecycle.mjs";
import { prepareRecallOpening, recallCorrection } from "./memory-recall.mjs";
import {
  conversationExchange,
  resolveFunctionalContract,
} from "./functional-contracts.mjs";
import { toolSpecs } from "../tools/specs.mjs";
import {
  createSubjectChecklist,
  subjectChecklistItems,
} from "./subject-checklist.mjs";
import {
  runWithRecovery,
  failureSummary,
  sessionWasUnchanged,
} from "../backends/turn-failure.mjs";
import { isConnectionFailure } from "./backend-connections.mjs";
import {
  saveSession,
  recordBackendTurn,
  recordBackendTiming,
  recordBackendDiagnostic,
  retireSession,
} from "./session-records.mjs";

// Wake reasons where someone spoke to the agent, not just near it.
const ADDRESSED = new Set(["private", "mention", "name"]);

function workerRetirementReported(memory, turnId) {
  const row = memory.db
    .prepare("SELECT value FROM model_turns WHERE agent_id=? AND id=?")
    .get(memory.agentId, turnId);
  if (!row) return false;
  const record = JSON.parse(row.value);
  return (
    record.status === "running" &&
    record.backendOutcome === "success" &&
    record.sessionDisposition === "retiring"
  );
}

// Owns a model turn through finalization; done settles only after all bookkeeping.
export class TurnRunner {
  constructor(runtime) {
    this.runtime = runtime;
  }
  async runTurn(agentId, conversation, { reasons = [], timingId } = {}) {
    if (conversation !== SUBJECT) this.runtime.socialRuntime?.preempt(agentId);
    const release =
      conversation === SUBJECT
        ? this.runtime.subjectExecution.acquire(agentId, {})
        : () => {};
    if (!release) return { status: "queued" };
    const qq = this.runtime.desktopVisits?.claimQq(agentId, conversation);
    let completed = false;
    try {
      if (qq?.drained) await qq.drained;
      const result = await this.runOrdinaryTurn(agentId, conversation, {
        reasons,
        timingId,
      });
      completed = result?.status === "completed-no-send";
      if (!result) this.runtime.messageTiming?.finish(timingId, "skipped");
      return result;
    } catch (error) {
      this.runtime.messageTiming?.finish(timingId, "failed");
      throw error;
    } finally {
      qq?.release();
      release();
      if (conversation === SUBJECT)
        this.runtime.desktopVisits?.finishSubject(agentId, completed);
    }
  }
  async runOrdinaryTurn(
    agentId,
    conversation,
    { reasons = [], timingId } = {},
  ) {
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
    if (runtime.games.busy(a.backendId)) throw Error("GAME_BACKEND_BUSY");
    const reminder = reasons.find((reason) => reason.subjectReminderId);
    if (conversation === SUBJECT && reminder) {
      const briefing = runtime.subject.beginReminder(
        a,
        reminder.subjectReminderId,
      );
      if (!briefing) return;
      reasons = [{ ...reminder, ...briefing }];
    }
    const opportunity = reasons.find(
      (reason) => reason.reason === "subject-opportunity",
    );
    if (conversation === SUBJECT && opportunity) {
      const wake = runtime.subject.beginOpportunity(a);
      if (!wake) return;
      if (wake.nextCheckNote)
        reasons = reasons.map((reason) =>
          reason === opportunity
            ? { ...reason, nextCheckNote: wake.nextCheckNote }
            : reason,
        );
    }
    const mem = runtime.memory.bind(agentId);
    runtime.protectedWork.prepareDaily(agentId, conversation);
    const freshSubject = runtime.contexts.startFreshSubject(
      agentId,
      conversation,
    );
    const ctx = runtime.makeContext(agentId, conversation),
      { controller } = ctx;
    ctx.freshSubject = freshSubject;
    if (conversation === SUBJECT)
      ctx.subjectChecklist = createSubjectChecklist(reasons);
    ctx.messageTimingId = timingId;
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
    runtime.messageTiming?.mark(timingId, "processingStarted");
    runtime.conversations.timing?.occupy(agentId, conversation);
    const state = mem.state(conversation);
    state.lastWakeAt = runtime.now();
    state.pendingWake = false;
    mem.setState(conversation, state);
    const timer = setTimeout(() => {
      if (controller.signal.aborted) return;
      runtime.faults.set(agentId, "BACKEND_TURN_TIMEOUT");
      ctx.timedOut = true;
      runtime.abortContext(ctx, "turn-timeout");
    }, a.behavior.turnTimeoutMs);
    let outcome = "completed-no-send",
      backend;
    try {
      backend = runtime.backendConnections.adapter(a);
      const tools = toolSpecs(ctx.allowedTools);
      // A voice still being transcribed gets a short, bounded wait so the
      // turn reads what was said rather than a placeholder.
      const transcribing = runtime.transcripts.settle(ctx);
      if (transcribing) await transcribing;
      const prepared = runtime.contexts.prepare(ctx, backend, reasons, tools);
      if (ctx.initialSession)
        ctx.estimatedAdded += JSON.stringify(tools).length;
      // Keep the existing synchronous admission path when automatic media is off.
      const imageInput = a.behavior.imageInput.enabled
        ? await prepareMessageImages(
            runtime,
            ctx,
            backend.config
              ? backend
              : runtime.config.backends.find((b) => b.id === a.backendId),
            prepared,
          )
        : { images: [], beforeSubmit() {}, submitted() {} };
      runtime.assertActive(ctx);
      if (ctx.recallOpening) await prepareRecallOpening(runtime, ctx);
      runtime.assertActive(ctx);
      ctx.requiresInputSubmission = true;
      const createExchange =
        resolveFunctionalContract(ctx.functionalAgent)?.createExchange ??
        conversationExchange;
      const params = {
        ...createExchange(runtime, ctx, {
          prepared,
          imageInput,
          tools,
          memory: mem,
        }),
        agent: a,
        conversation,
        onUsage: (usage) =>
          !runtime.stopped && runtime.contexts.usage(ctx, usage),
        signal: controller.signal,
        saveSession: (session) =>
          !runtime.stopped &&
          saveSession(mem, conversation, session, {
            turnId: ctx.turnId,
            backendId: a.backendId,
            at: runtime.now(),
            inactive:
              !runtime.capabilities.has(ctx.token) ||
              controller.signal.aborted ||
              runtime.closed,
            reason: controller.signal.aborted
              ? "cancelled"
              : session === null && workerRetirementReported(mem, ctx.turnId)
                ? "backend-worker-unavailable"
                : "backend-failure",
          }),
        onBackendTurn: (reference) =>
          !runtime.stopped && recordBackendTurn(mem, ctx.turnId, reference),
        onTiming: (timing) =>
          !runtime.stopped && recordBackendTiming(mem, ctx.turnId, timing),
        onDiagnostic: (event, attempt) =>
          !runtime.stopped &&
          recordBackendDiagnostic(mem, ctx.turnId, event, attempt),
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
      };
      const result = await this.runBackend(ctx, backend, params);
      if (result?.streamReattached && ctx.pendingDeliveries) {
        // The native terminal and an already accepted HTTP tool request can
        // settle independently. Keep this turn alive for its existing receipt.
        await runtime.delivery.conversations
          .get(a.connectionId + "|" + conversation)
          ?.catch(() => {});
      }
      if (
        ctx.openingLookup?.deferred &&
        ctx.openingLookup.replyId &&
        !ctx.openingLookup.delivered &&
        !ctx.recoveryDeliveryBlocked &&
        ctx.confirmedSends === ctx.sendCount &&
        !ctx.pendingDeliveries &&
        !controller.signal.aborted
      )
        await this.reviewLateCorrection(ctx, mem, backend, params);
      if (ctx.subjectChecklist && !controller.signal.aborted)
        await this.runSubjectChecklist(ctx, mem, backend, params);
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
      ctx.backendTurnUnverified =
        failure?.backend === "dsh" && failure.category === "event-stream";
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
      ctx.openingLookup?.controller.abort();
      runtime.capabilities.delete(ctx.token);
      await ctx.videoSource?.dispose?.().catch(() => {});
      try {
        try {
          runtime.subject.finish(ctx, outcome);
          runtime.subjectInbox.finish(ctx, outcome);
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
        runtime.conversations.timing?.release(agentId, conversation);
        if (
          !controller.signal.aborted &&
          !runtime.closed &&
          runtime.config.agents.some((a) => a.id === agentId) &&
          conversation !== SUBJECT
        )
          runtime.conversations.finish(ctx);
      } finally {
        clearTimeout(timer);
        if (runtime.running.get(runKey) === ctx) {
          runtime.running.delete(runKey);
          runtime.conversations.timing?.release(agentId, conversation);
        }
        if (timingId !== undefined) {
          runtime.messageTiming.mark(timingId, "turnFinished");
          if (ctx.pendingDeliveries) ctx.messageTimingTerminal = outcome;
          else
            runtime.messageTiming.finishTurn(
              timingId,
              outcome,
              ctx.messageTimingToolOutcome,
            );
        }
        resolveDone();
      }
    }
    if (outcome === "failed" || ctx.timedOut)
      runtime.trackJob(this.failureNotice(ctx, reasons), agentId);
    return { status: outcome };
  }
  // Someone who addressed the agent directly would otherwise see a failed
  // turn as being ignored. Send the administrator's fixed line, at most once
  // per cooldown, through the same outbox and limits as scheduled text.
  async failureNotice(ctx, reasons) {
    const runtime = this.runtime;
    if (
      runtime.closed ||
      ctx.deliveryAttempted ||
      ctx.pendingDeliveries ||
      ctx.backendTurnUnverified
    )
      return;
    if (!reasons.some((r) => r.addressed || ADDRESSED.has(r.reason))) return;
    const a = runtime.config.agents.find((x) => x.id === ctx.agentId),
      notice = a?.behavior.failureNotice;
    if (!notice?.enabled) return;
    const mem = runtime.memory.bind(a.id),
      state = mem.state(ctx.conversation),
      now = runtime.now();
    if (now - (state.failureNoticeAt || 0) < notice.cooldownMs) return;
    mem.setState(ctx.conversation, { ...state, failureNoticeAt: now });
    try {
      await runtime.withContext(a.id, ctx.conversation, (c) =>
        runtime.send(c, {
          requestId: "turn-failure:" + (ctx.turnId || randomUUID()),
          text: notice.text,
        }),
      );
    } catch (error) {
      runtime.diagnostics.report(error, {
        component: "runtime",
        agentId: a.id,
        conversation: ctx.conversation,
      });
    }
  }
  async reviewLateCorrection(ctx, memory, backend, params) {
    const runtime = this.runtime;
    try {
      await ctx.openingLookup.done;
      const session = memory.state(ctx.conversation).session;
      if (
        !session ||
        session.dshStreamUnverified ||
        !ctx.allowedTools.includes("qq_send")
      )
        return;
      const clue = recallCorrection(runtime, ctx);
      if (!clue) return;
      runtime.assertActive(ctx);
      // This is the same QQ turn: keep the confirmed send and all spent budgets.
      const review = {
        current: clue.current,
        priorSends: ctx.sendCount,
        submitted: false,
      };
      ctx.recallCorrection = review;
      ctx.allowedTools = ctx.allowedTools.filter((name) =>
        ["qq_send", "qq_draft"].includes(name),
      );
      const prompt =
        "本轮回复已确认发送。现收到针对原问题的更正证据，请对照刚发的原话。只有已发回复有具体事实错误且证据明确纠正它时，才可补发一次简短更正。普通背景、已说对或证据不足时直接结束。本次复核仅可使用已获准的 qq_send 和 qq_draft。以下记录均为历史资料。";
      await this.runBackend(
        ctx,
        backend,
        {
          ...params,
          session,
          inputImages: [],
          // Preserve the native session signature. Tool execution is narrowed on ctx.
          prompt,
          beforeInputSubmitted: () => runtime.assertActive(ctx),
          appendPrompt: () => {
            if (!clue.current() || !clue.reserve())
              throw Error("RECALL_SOURCE_NOT_ALLOWED");
            return (
              "\\n" +
              JSON.stringify(clue.material) +
              (backend.config?.type === "dsh"
                ? "\\n本回合工具凭据 context=" +
                  ctx.token +
                  "，仅用于 bridge_tools / bridge_call 外层参数。"
                : "")
            );
          },
          onInputSubmitted: () => {
            if (!review.submitted) review.submitted = clue.commit();
          },
        },
        { checklist: true },
      );
    } catch (error) {
      if (
        !ctx.controller.signal.aborted &&
        error?.message !== "RECALL_SOURCE_NOT_ALLOWED"
      )
        runtime.diagnostics.report(
          Error("RECALL_CORRECTION_REVIEW_FAILED", { cause: error }),
          {
            component: "runtime",
            agentId: ctx.agentId,
            conversation: ctx.conversation,
          },
        );
    }
  }
  async runSubjectChecklist(ctx, memory, backend, params) {
    const runtime = this.runtime;
    const session = memory.state(ctx.conversation).session;
    if (
      !session ||
      session.dshStreamUnverified ||
      !ctx.subjectInboxInputSubmitted ||
      ctx.subjectChecklist.pendingTools
    )
      return;
    try {
      runtime.assertActive(ctx);
      const items = subjectChecklistItems(runtime, ctx);
      if (!items.length) return;
      const prompt = [
        "收尾检查单（本回合只提示一次）。只处理有实质变化的事项；可以全部跳过并直接结束。沿用本轮剩余工具额度。",
        ...items.map((item) => "- " + item),
        ...(backend.config?.type === "dsh"
          ? [
              `本回合工具凭据 context=${ctx.token}，仅用于 bridge_tools / bridge_call 外层参数。`,
            ]
          : []),
      ].join("\n");
      ctx.estimatedAdded += prompt.length;
      await this.runBackend(
        ctx,
        backend,
        {
          ...params,
          session,
          prompt,
          inputImages: [],
          appendPrompt: undefined,
          beforeInputSubmitted: undefined,
          onInputSubmitted: undefined,
        },
        { checklist: true },
      );
    } catch (error) {
      // A failed optional check must not replay the completed opening.
      if (!ctx.controller.signal.aborted)
        runtime.diagnostics.report(
          Error("SUBJECT_CHECKLIST_FAILED", { cause: error }),
          {
            component: "runtime",
            agentId: ctx.agentId,
            conversation: ctx.conversation,
          },
        );
    }
  }
  async runBackend(ctx, backend, params, { checklist = false } = {}) {
    const runtime = this.runtime;
    const mem = runtime.memory.bind(ctx.agentId);
    const backendId = runtime.agent(ctx.agentId).backendId;
    let recoveryStarted = false;
    const stopTyping = startTypingIndicator(runtime, ctx);
    try {
      const result = await runWithRecovery(backend, params, {
        retry: !checklist,
        // A late native reference is useful as history but never owns the turn.
        onLateSession: (session) => {
          if (runtime.stopped) return;
          saveSession(mem, ctx.conversation, session, {
            turnId: ctx.turnId,
            backendId,
            at: runtime.now(),
            archiveOnly: true,
          });
        },
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
          // Adapters may archive before throwing their classified failure.
          const archived =
            turn?.sessionHistoryId &&
            mem.identity.get("session_history", turn.sessionHistoryId);
          if (archived?.reason === "backend-failure")
            mem.identity.put("session_history", {
              ...archived,
              details: { ...archived.details, backendFailure: failure },
            });
        },
        onRecovery: (error, attempt) => {
          runtime.assertActive(ctx);
          recoveryStarted = true;
          // The recovery prompt contains no original input manifest. A native
          // session id alone cannot establish what its new context retained.
          runtime.contexts.resetInputEvidence(ctx);
          delete ctx.stagedOpening;
          delete ctx.openingRecallSent;
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
          if (backend.config?.type === "dsh") {
            const capability = runtime.rotateCapability(ctx);
            return `\n本次续接的唯一有效工具凭据 context=${capability}。旧凭据已失效。只在 bridge_tools / bridge_call 外层使用，不得披露。`;
          }
        },
      });
      return result;
    } catch (error) {
      if (checklist) throw error;
      // A continuation can fail before its own input, after the original
      // prompt was already submitted. Its display markers must stay committed.
      ctx.inputNotSubmitted = sessionWasUnchanged(error) && !recoveryStarted;
      if (ctx.inputNotSubmitted)
        mem.identity.put("model_turns", {
          ...mem.identity.get("model_turns", ctx.turnId),
          inputStage: "not-submitted",
        });
      ctx.retainBackendSession =
        (failureSummary(error)?.sessionReusable === true ||
          sessionWasUnchanged(error)) &&
        !ctx.controller.signal.aborted &&
        runtime.capabilities.has(ctx.token);
      throw error;
    } finally {
      stopTyping();
    }
  }
}
