import {
  stableInstructions,
  identityAnchors,
  turnEnvironment,
} from "./prompts.mjs";
export { stableInstructions } from "./prompts.mjs";
import { randomUUID, createHash } from "node:crypto";
import { githubMarker } from "../github/policy.mjs";
import { trackMindRecords } from "./protected-mind.mjs";
import { mergeProtection } from "../memory/protection.mjs";
import { rememberSources, sourceHandoff } from "./context-handoff.mjs";
import {
  retireSession,
  sessionReference,
  recoverSessions,
} from "./session-records.mjs";
export const SUBJECT = "@subject";
export class ContextLifecycle {
  constructor(runtime) {
    this.runtime = runtime;
    runtime.memory.db.exec(
      `CREATE TABLE IF NOT EXISTS message_progress(agent_id TEXT NOT NULL,conversation TEXT NOT NULL,seq INTEGER NOT NULL,summary_only INTEGER NOT NULL,PRIMARY KEY(agent_id,conversation,seq));`,
    );
    // A prior process cannot still own a local turn. Never replay pending network operations.
    runtime.memory.db
      .prepare("UPDATE deliveries SET status='unknown' WHERE status='pending'")
      .run();
    for (const a of runtime.memory.db
      .prepare(
        "SELECT DISTINCT agent_id AS id FROM model_turns WHERE json_extract(value,'$.status')='running'",
      )
      .all()) {
      const m = runtime.memory.bind(a.id);
      recoverSessions(m, runtime.now());
    }
  }
  seen(ctx, items) {
    const m = this.runtime.memory.bind(ctx.agentId),
      db = m.db;
    for (const row of items)
      if (
        row.conversation === ctx.conversation &&
        Number.isSafeInteger(row.seq)
      ) {
        db.prepare(
          "INSERT INTO message_progress VALUES(?,?,?,?) ON CONFLICT(agent_id,conversation,seq) DO UPDATE SET summary_only=MIN(summary_only,excluded.summary_only)",
        ).run(
          ctx.agentId,
          ctx.conversation,
          row.seq,
          +(!!row.summaryOmitted || !!row.bodyTruncated),
        );
      }
    this.runtime.observeInput(ctx, items);
    for (const row of items) {
      if (row.id && row.privacy !== "public") ctx.privateRead.add(row.id);
      for (const repo of row.protectedRepositories || [])
        ctx.privateRead.add(githubMarker(repo));
    }
    ctx.persistTaint?.();
    rememberSources(m, ctx.conversation, items);
    const state = m.state(ctx.conversation),
      baseline = state.readThroughSeq || 0;
    const gap = db
      .prepare(
        `SELECT MIN(e.seq) AS seq FROM events e LEFT JOIN message_progress p ON p.agent_id=e.agent_id AND p.conversation=e.conversation AND p.seq=e.seq WHERE e.agent_id=? AND e.conversation=? AND e.seq>? AND p.seq IS NULL`,
      )
      .get(ctx.agentId, ctx.conversation, baseline).seq;
    const through = Math.max(
      baseline,
      db
        .prepare(
          "SELECT MAX(seq) AS seq FROM message_progress WHERE agent_id=? AND conversation=? AND seq<?",
        )
        .get(ctx.agentId, ctx.conversation, gap || Number.MAX_SAFE_INTEGER)
        .seq || 0,
    );
    ctx.shownSeq = through;
    m.setState(ctx.conversation, { ...state, seenThroughSeq: through });
    return through;
  }
  handoff(agentId, conversation) {
    const m = this.runtime.memory.bind(agentId),
      s = m.state(conversation),
      notes = m.identity.notes(conversation);
    const important = notes.slice(0, 8);
    const subjectState = m.state(SUBJECT),
      a = this.runtime.config.agents.find((a) => a.id === agentId);
    const intents = m.identity
      .list("intentions")
      .filter(
        (x) =>
          (conversation === SUBJECT || x.target === conversation) &&
          !["cancelled", "completed", "expired", "failed", "unknown"].includes(
            x.status,
          ),
      );
    return {
      conversation,
      subjectState:
        conversation === SUBJECT
          ? {
              activityCursor: subjectState.activityCursor || 0,
              lastActivitySeq: subjectState.lastActivitySeq || 0,
              checksLast24h: (subjectState.checks || []).filter(
                (t) => t > this.runtime.now() - 86400000,
              ).length,
              contactsLast24h: (subjectState.contacts || []).filter(
                (t) => t > this.runtime.now() - 86400000,
              ).length,
              lastContactAt: subjectState.lastContactAt,
              nextCheckAt: subjectState.nextCheckAt,
              policy: a?.subject,
            }
          : undefined,
      processedThroughSeq: s.readThroughSeq || 0,
      seenThroughSeq: s.seenThroughSeq || 0,
      notes: important,
      notesOverflow: Math.max(0, notes.length - important.length),
      notice:
        notes.length > important.length
          ? "更多未完成笔记需 work_notes 读取，未静默删除。"
          : "笔记是带来源的工作解释；原始事件可回查。",
      continuity: sourceHandoff(m, conversation),
      intents: intents.slice(0, 30).map((i) => ({
        id: i.id,
        target: i.target,
        status: i.status,
        topic: i.topic,
        evidence: i.evidence,
        ...mergeProtection(i),
      })),
      intentsTotal: intents.length,
      intentsOverflow: Math.max(0, intents.length - 30),
      intentsContinuation:
        intents.length > 30
          ? {
              tool: "intent_list",
              offset: 30,
              activeOnly: true,
              ...(conversation === SUBJECT ? {} : { target: conversation }),
            }
          : null,
      deliveries: m.db
        .prepare(
          "SELECT request_id,status,message_id,conversation,created_at FROM deliveries WHERE agent_id=? AND (?='@subject' OR conversation=?) ORDER BY created_at DESC LIMIT 20",
        )
        .all(agentId, conversation, conversation),
      recentContacts:
        conversation === SUBJECT
          ? m.identity
              .list("intentions")
              .filter((i) =>
                i.history.some((h) =>
                  [
                    "awaiting-response",
                    "completed",
                    "failed",
                    "unknown",
                  ].includes(h.status),
                ),
              )
              .slice(0, 20)
              .map((i) => ({
                id: i.id,
                target: i.target,
                topic: i.topic,
                status: i.status,
                history: i.history.slice(-3),
                ...mergeProtection(i),
              }))
          : [],
      contactHistoryNotice:
        "最近联系结果最多 20 项；更早结果用 intent_list 分页回查。",
      summaryOnly: m.db
        .prepare(
          "SELECT seq FROM message_progress WHERE agent_id=? AND conversation=? AND summary_only=1 ORDER BY seq DESC LIMIT 30",
        )
        .all(agentId, conversation)
        .map((x) => x.seq),
      scheduled:
        this.runtime.scheduler
          ?.list(agentId)
          .filter(
            (t) =>
              conversation === SUBJECT ||
              t.ownerConversation === conversation ||
              t.targets?.includes(conversation),
          ) || [],
    };
  }
  retire(agentId, conversation, reason, owner = null) {
    if (
      this.runtime.running.has(agentId + "|" + conversation) &&
      this.runtime.running.get(agentId + "|" + conversation) !== owner
    )
      throw Error("SESSION_BUSY");
    const m = this.runtime.memory.bind(agentId),
      s = m.state(conversation);
    retireSession(m, conversation, reason, this.runtime.now(), {
      selfVersion: s.loadedSelfVersion,
      handoff: this.handoff(agentId, conversation),
    });
  }
  prepare(ctx, backend, reasons, tools = []) {
    if (ctx.controller.signal.aborted) throw Error("ABORTED");
    const r = this.runtime,
      a = r.agent(ctx.agentId),
      m = r.memory.bind(a.id);
    recoverSessions(m, r.now(), ctx.conversation);
    const self = m.identity.initialize(a, r.now());
    const backendType = r.config.backends.find(
      (b) => b.id === a.backendId,
    )?.type;
    const instructions = stableInstructions(
      a,
      self,
      ctx.conversation === SUBJECT,
      m.identity.anchors(a),
      {
        backendType,
        identity: identityAnchors(r.config, a),
        toolNames: tools.map((t) => t.name),
      },
    );
    const instructionsHash = createHash("sha256")
      .update(instructions)
      .digest("hex");
    let s = m.state(ctx.conversation);
    const signature = backend.sessionSignature?.(tools);
    const contractChanged = signature && s.session?.signature !== signature;
    if (
      s.session &&
      (s.loadedSelfVersion !== self.version ||
        s.loadedInstructionsHash !== instructionsHash ||
        contractChanged)
    ) {
      // Both protocols can preserve old text. Rebuild on identity changes until replacement is behaviorally verified.
      this.retire(
        a.id,
        ctx.conversation,
        s.loadedSelfVersion !== self.version
          ? "self-version-change"
          : contractChanged
            ? "backend-contract-change"
            : "identity-or-protocol-change",
        ctx,
      );
      s = m.state(ctx.conversation);
    }
    ctx.selfVersion = self.version;
    ctx.turnId = randomUUID();
    ctx.turnStartedAt = r.now();
    ctx.initialSession = !s.session;
    ctx.sourceStartSeq =
      m.db
        .prepare("SELECT MAX(seq) AS seq FROM events WHERE agent_id=?")
        .get(a.id).seq || 0;
    const history =
      ctx.conversation === SUBJECT
        ? { items: [] }
        : m.conversation(
            {
              conversation: ctx.conversation,
              afterSeq: (s.session ? s.feedThroughSeq : s.readThroughSeq) || 0,
              limit: 30,
              maxChars: 12000,
            },
            ctx.conversation,
          );
    this.seen(ctx, history.items);
    ctx.feedThroughSeq = history.nextAfterSeq || s.feedThroughSeq || 0;
    // Existing backend context and legacy handoffs may predate disclosure tracking.
    // Retain an explicit source boundary and every recoverable handoff handle.
    const handoff = ctx.initialSession
      ? this.handoff(a.id, ctx.conversation)
      : null;
    ctx.privateRead.add("context:" + ctx.conversation);
    for (const source of handoff?.continuity?.sources || [])
      ctx.privateRead.add(source.id);
    if (handoff) {
      trackMindRecords(r, ctx, handoff.notes);
      trackMindRecords(
        r,
        ctx,
        [...handoff.intents, ...handoff.recentContacts],
        "intent",
      );
    }
    r.subject.trackForTurn(ctx);
    ctx.persistTaint?.();
    const prompt = [
      `当前场景 ${ctx.conversation}。本回合采用 self v${self.version}。主人/管理员：${a.ownerIds.join(",") || "未设置"}。`,
      `唤醒原因（资料）: ${JSON.stringify(reasons)}`,
      turnEnvironment(r, a, ctx, backendType),
      ctx.initialSession ? `程序交接状态：${JSON.stringify(handoff)}` : "",
      `新增消息：${JSON.stringify(history)}`,
    ]
      .filter(Boolean)
      .join("\n\n");
    m.setState(ctx.conversation, {
      ...m.state(ctx.conversation),
      loadedSelfVersion: self.version,
      loadedInstructionsHash: instructionsHash,
      lastTurnId: ctx.turnId,
      lifecycle: {
        ...s.lifecycle,
        status: s.lifecycle?.status === "organizing" ? "organizing" : "active",
      },
    });
    m.identity.put("model_turns", {
      id: ctx.turnId,
      conversation: ctx.conversation,
      selfVersion: self.version,
      startedAt: r.now(),
      status: "running",
      reason: reasons.map((x) => x.reason),
      initialSession: ctx.initialSession,
      promptChars: prompt.length,
      instructionsChars: ctx.initialSession ? instructions.length : 0,
      instructionsHash,
      backendId: a.backendId,
      ...(s.session ? { backendSession: sessionReference(s.session) } : {}),
    });
    ctx.estimatedAdded =
      prompt.length + (ctx.initialSession ? instructions.length : 0);
    return { instructions, prompt, session: s.session };
  }
  usage(ctx, value) {
    const m = this.runtime.memory.bind(ctx.agentId),
      s = m.state(ctx.conversation);
    if (s.lastTurnId !== ctx.turnId) return;
    if (Number.isFinite(value?.contextTokens) && value.contextTokens >= 0)
      m.setState(ctx.conversation, {
        ...s,
        usage: { ...value, at: this.runtime.now() },
      });
  }
  async finish(ctx, outcome, backend) {
    const m = this.runtime.memory.bind(ctx.agentId);
    let terminal = outcome;
    try {
      await this.finishContext(ctx, outcome, backend);
    } catch (error) {
      terminal = "failed";
      ctx.retainBackendSession = false;
      throw error;
    } finally {
      if (ctx.controller.signal.aborted) terminal = "cancelled";
      if (
        terminal === "cancelled" ||
        (terminal === "failed" && !ctx.retainBackendSession)
      )
        retireSession(
          m,
          ctx.conversation,
          terminal === "failed" ? "backend-failure" : "cancelled",
          this.runtime.now(),
          { turnId: ctx.turnId },
        );
      // Keep running durable through all async finalization/compaction. On a
      // crash, recovery must still archive before removing the active mapping.
      m.identity.put("model_turns", {
        ...m.identity.get("model_turns", ctx.turnId),
        status: terminal,
        phase: "finished",
        endedAt: this.runtime.now(),
      });
    }
  }
  async finishContext(ctx, outcome, backend) {
    const r = this.runtime,
      m = r.memory.bind(ctx.agentId),
      a = r.config.agents.find((a) => a.id === ctx.agentId);
    rememberSources(
      m,
      ctx.conversation,
      m.db
        .prepare(
          "SELECT id,conversation,direction FROM events WHERE agent_id=? AND conversation=? AND seq>? AND kind IN ('app.observation','external.read','message.send-result') ORDER BY seq DESC LIMIT 12",
        )
        .all(ctx.agentId, ctx.conversation, ctx.sourceStartSeq || 0)
        .reverse(),
    );
    const s = m.state(ctx.conversation);
    const record = m.identity.get("model_turns", ctx.turnId);
    m.identity.put("model_turns", {
      ...record,
      status: "running",
      phase: "finalizing",
      modelOutcome: outcome,
      usage: s.usage,
      estimatedTextChars: ctx.estimatedAdded,
    });
    if (
      ["failed", "cancelled"].includes(outcome) ||
      ctx.controller.signal.aborted
    ) {
      if (
        outcome === "failed" &&
        ctx.retainBackendSession &&
        !ctx.controller.signal.aborted
      )
        return;
      retireSession(
        m,
        ctx.conversation,
        outcome === "failed" ? "backend-failure" : "cancelled",
        r.now(),
        { turnId: ctx.turnId, backendId: a?.backendId },
      );
      return;
    }
    if (!a) return;
    let usage = s.usage;
    if (!usage || usage.at < ctx.turnStartedAt)
      usage = {
        source: "estimated",
        contextTokens: (s.usage?.contextTokens || 0) + ctx.estimatedAdded,
        capacityTokens: a.contextPolicy.capacityTokens,
        at: r.now(),
        basis:
          "tracked text characters plus tool output; conservative estimate, excludes unknown backend overhead",
      };
    const capacity =
      usage.capacityTokens > 0
        ? usage.capacityTokens
        : a.contextPolicy.capacityTokens;
    const ratio =
      (usage.contextTokens + a.contextPolicy.reserveTokens) / capacity;
    const lifecycle = {
      ...s.lifecycle,
      status:
        ratio >= 0.75 ||
        (s.lifecycle?.status === "organizing" &&
          !(
            usage.source === "measured" && ratio <= a.contextPolicy.recoverRatio
          ))
          ? "organizing"
          : "active",
      ratio,
    };
    m.setState(ctx.conversation, {
      ...s,
      usage,
      lifecycle,
      feedThroughSeq: ctx.feedThroughSeq,
      lastTurnEndedAt: r.now(),
    });
    m.identity.put("model_turns", {
      ...m.identity.get("model_turns", ctx.turnId),
      usage,
    });
    if (lifecycle.status !== "organizing" || ctx.controller.signal.aborted)
      return;
    if (
      backend?.compact &&
      s.session &&
      r.now() - (s.lifecycle?.lastCompactAt || 0) >=
        a.contextPolicy.compactCooldownMs
    ) {
      try {
        m.identity.put("model_turns", {
          ...m.identity.get("model_turns", ctx.turnId),
          phase: "compacting",
        });
        const result = await backend.compact({
          session: s.session,
          signal: ctx.controller.signal,
        });
        if (ctx.controller.signal.aborted) {
          retireSession(
            m,
            ctx.conversation,
            "cancelled-during-compaction",
            r.now(),
            { turnId: ctx.turnId, backendId: a.backendId },
          );
          return;
        }
        if (result?.usage) this.usage(ctx, result.usage);
        if (result?.requiresReinitialize) {
          this.retire(
            a.id,
            ctx.conversation,
            "compacted-identity-reinitialize",
            ctx,
          );
          return;
        }
        const latest = m.state(ctx.conversation),
          current = latest.usage;
        const reduced =
          current?.source === "measured" &&
          (current.contextTokens + a.contextPolicy.reserveTokens) /
            (current.capacityTokens > 0 ? current.capacityTokens : capacity) <=
            a.contextPolicy.recoverRatio;
        m.setState(ctx.conversation, {
          ...latest,
          lifecycle: {
            ...lifecycle,
            lastCompactAt: r.now(),
            compactResult: reduced ? "recovered" : "no-confirmed-reduction",
            status: reduced ? "active" : "organizing",
            ratio: current
              ? (current.contextTokens + a.contextPolicy.reserveTokens) /
                (current.capacityTokens > 0 ? current.capacityTokens : capacity)
              : ratio,
          },
        });
        if (reduced) return;
      } catch (e) {
        const latest = m.state(ctx.conversation);
        m.setState(ctx.conversation, {
          ...latest,
          lifecycle: {
            ...lifecycle,
            lastCompactAt: r.now(),
            compactResult: "failed",
          },
        });
      }
    }
    if (ctx.controller.signal.aborted) {
      retireSession(
        m,
        ctx.conversation,
        "cancelled-during-compaction",
        r.now(),
        { turnId: ctx.turnId, backendId: a.backendId },
      );
      return;
    }
    // Called after running is removed; unknown deliveries are in handoff, not a retirement lock.
    if (
      ctx.conversation === SUBJECT ||
      m.state(ctx.conversation).lifecycle.ratio >= a.contextPolicy.hardRatio
    )
      this.retire(
        a.id,
        ctx.conversation,
        ctx.conversation === SUBJECT
          ? "subject-check-complete"
          : "capacity-guard",
        ctx,
      );
  }
  tick() {
    const r = this.runtime;
    for (const a of r.config.agents)
      for (const row of r.memory.db
        .prepare("SELECT conversation,value FROM runtime WHERE agent_id=?")
        .all(a.id)) {
        const s = JSON.parse(row.value);
        if (
          s.session &&
          s.lifecycle?.status === "organizing" &&
          r.now() - Math.max(s.lastIncomingAt || 0, s.lastTurnEndedAt || 0) >=
            a.contextPolicy.idleMs &&
          !r.running.has(a.id + "|" + row.conversation)
        )
          this.retire(a.id, row.conversation, "idle-after-pressure");
      }
  }
}
