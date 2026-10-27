import { observeInput } from "./input-progress.mjs";
import { Diagnostics } from "./diagnostics.mjs";
import { runWithRecovery, failureSummary } from "../backends/turn-failure.mjs";
import { GeneratedImages } from "./generated-images.mjs";
import {
  BackendConnections,
  isConnectionFailure,
} from "./backend-connections.mjs";
import {
  authorizeExternal,
  grantExternal,
  sourceCounts,
} from "./outbound-policy.mjs";
import { toolAvailable } from "../tools/catalog.mjs";
import { beforeShareDelivery } from "../apps/sharing.mjs";
import { appService } from "../apps/tools.mjs";
import { appsPolicySchema } from "../apps/policy.mjs";
import { appDefinitions } from "../apps/tools.mjs";
import { ContextLifecycle, SUBJECT } from "./lifecycle.mjs";
import { SubjectCoordinator } from "./subject.mjs";
import { CHAT_MIND_TOOLS, SUBJECT_TOOLS } from "../tools/mind.mjs";
import {
  githubPrivateContext,
  githubMarker,
  privateGithubSources,
} from "../github/policy.mjs";
import { FILE_TOOL_NAMES } from "../tools/file-tools.mjs";
import { filesSchema } from "./policy.mjs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { allowed, inSilence, validateConfig } from "./config.mjs";
import { normalizeEvent, OneBot } from "../transport/onebot.mjs";
import { BanterCoordinator } from "../../vendor/local-bridge/banter.mjs";
import { toolSpecs, dispatchTool } from "../tools/index.mjs";
import { taintMedia } from "../tools/legacy.mjs";
import { mdToPlain } from "../../vendor/dsh-qq/md-to-plain.js";
import { ConversationEngine } from "./conversations.mjs";
import { TaskScheduler } from "./scheduler.mjs";
import { Operations } from "./operations.mjs";
import { SlangLearner } from "./slang.mjs";
import {
  saveSession,
  recordBackendTurn,
  retireSession,
} from "./session-records.mjs";

const digest = (x) =>
  createHash("sha256").update(JSON.stringify(x)).digest("hex");
const disclosureGrant = z
  .object({
    approvalId: z.uuid(),
    agentId: z.string().min(1).max(64),
    conversation: z.string().min(1).max(120),
    ids: z.array(z.string().min(1)),
    requestId: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export class Runtime {
  constructor({
    configStore,
    memory,
    backendFactory,
    transportFactory = (c) => new OneBot(c),
    clock = () => new Date(),
    random = Math.random,
    diagnostics = new Diagnostics(),
  }) {
    Object.assign(this, {
      configStore,
      memory,
      backendFactory,
      transportFactory,
      clock,
      random,
      diagnostics,
    });
    this.transports = new Map();
    this.connecting = new Set();
    this.backends = new Map();
    this.backendConnections = new BackendConnections(this);
    this.running = new Map();
    this.pending = new Map();
    this.capabilities = new Map();
    this.faults = new Map();
    this.jobs = new Set();
    this.work = new Set();
    this.retiredResources = new Set();
    this.closed = false;
    this.sendChains = new Map();
    this.conversations = new ConversationEngine(this);
    this.scheduler = new TaskScheduler(this);
    this.operations = new Operations(this);
    this.learner = new SlangLearner(this);
    this.contexts = new ContextLifecycle(this);
    this.generatedImages = new GeneratedImages(this);
    this.subject = new SubjectCoordinator(this);
    for (const a of this.config.agents)
      this.memory.bind(a.id).identity.initialize(a, this.now());
    this.banter = new BanterCoordinator({
      botIds: this.config.connections.map((c) => c.accountId),
      ...this.config.peerLimit,
    });
  }
  get config() {
    return this.configStore.value;
  }
  now() {
    return +this.clock();
  }
  trackWork(job) {
    const pending = Promise.resolve(job);
    this.work.add(pending);
    const remove = () => this.work.delete(pending);
    pending.then(remove, remove);
    return pending;
  }
  trackJob(job, id) {
    const tracked = Promise.resolve(job).catch((cause) => {
      this.faults.set(id, "BACKGROUND_JOB_FAILED");
      this.diagnostics.report(Error("BACKGROUND_JOB_FAILED", { cause }), {
        component: "runtime",
        agentId: id,
      });
    });
    this.jobs.add(tracked);
    tracked.then(() => this.jobs.delete(tracked));
    return tracked;
  }
  startTimers() {
    if (this.closed || this.ticker) return;
    this.ticker = setInterval(() => {
      try {
        this.tick();
      } catch (cause) {
        this.faults.set("scheduler", "SCHEDULER_TICK_FAILED");
        this.diagnostics.report(Error("SCHEDULER_TICK_FAILED", { cause }), {
          component: "scheduler",
        });
      }
    }, 1000);
    this.ticker.unref?.();
  }
  tick() {
    if (this.closed || this.configChanging) return;
    this.backendConnections.tick();
    this.contexts.tick();
    this.subject.tick();
    this.conversations.tick();
    this.scheduler.tick();
    this.operations.expire();
    this.learner.tick();
  }
  makeContext(agentId, conversation) {
    if (this.closed) throw Error("RUNTIME_CLOSING");
    if (this.configChanging) throw Error("CONFIG_CONFLICT");
    const a = this.agent(agentId),
      mem = this.memory.bind(agentId);
    const ctx = {
      token: randomBytes(32).toString("base64url"),
      agentId,
      conversation,
      expires: Date.now() + a.behavior.turnTimeoutMs,
      controller: new AbortController(),
      privateRead: new Set(mem.state(conversation).disclosureTaint || []),
      grants: new Set(),
      sendCount: 0,
      replyBatchSends: mem.state(conversation).replyBatchSends || 0,
      inputBaseline: Math.max(
        mem.state(conversation).readThroughSeq || 0,
        mem.state(conversation).replyInputSeq || 0,
      ),
      requestEvents: new Set(),
      externalGrants: new Map(),
      confirmedSends: 0,
      shownSeq: 0,
    };
    ctx.persistTaint = () => {
      mem.setState(conversation, {
        ...mem.state(conversation),
        disclosureTaint: [...ctx.privateRead],
      });
      this.generatedImages.taint(ctx);
    };
    this.capabilities.set(ctx.token, ctx);
    return ctx;
  }
  withContext(...args) {
    return this.trackWork(this.runWithContext(...args));
  }
  async runWithContext(agentId, conversation, fn) {
    const ctx = this.makeContext(agentId, conversation);
    // Deterministic owner/scheduler control replies have their own invocation budget.
    ctx.internalDelivery = true;
    try {
      this.assertActive(ctx);
      return await fn(ctx);
    } finally {
      ctx.controller.abort();
      this.capabilities.delete(ctx.token);
    }
  }
  agent(id) {
    const a = this.config.agents.find((a) => a.id === id);
    if (!a) throw Error("UNKNOWN_AGENT");
    return a;
  }
  connection(id) {
    const c = this.config.connections.find((c) => c.id === id);
    if (!c) throw Error("UNKNOWN_CONNECTION");
    return c;
  }
  toolsFor(a, conversation) {
    const selected =
      conversation === SUBJECT
        ? [
            ...new Set([
              ...SUBJECT_TOOLS.filter(
                (n) =>
                  n.startsWith("self_") ||
                  n.startsWith("intent_") ||
                  n.startsWith("work_") ||
                  a.tools.includes(n),
              ),
              ...a.subject.readTools.filter((n) => a.tools.includes(n)),
            ]),
          ]
        : [
            ...new Set([
              ...a.tools.filter(
                (n) => n !== "self_update" && n !== "self_review",
              ),
              ...CHAT_MIND_TOOLS,
            ]),
          ];
    if (
      conversation !== SUBJECT &&
      selected.includes("qq_send") &&
      this.config.backends.find((b) => b.id === a.backendId)?.type === "codex"
    )
      selected.push("generated_image_list");
    return [...new Set(selected)].filter((name) =>
      toolAvailable(a, name, conversation),
    );
  }
  writable(a, conversation, ctx = null) {
    if (this.closed || this.configChanging) return false;
    if (this.backendConnections.blocked.has(a.id)) return false;
    if (conversation === SUBJECT) return this.subject.internalAllowed(a);
    const state = this.memory.bind(a.id).state(conversation);
    return (
      !this.closed &&
      this.config.mode === "live" &&
      !this.config.globalPaused &&
      !a.paused &&
      allowed(a, conversation) &&
      !inSilence(a, this.clock()) &&
      !state.paused &&
      // The turn that chose to go quiet may still finish bookkeeping; deliverNow blocks its sends.
      (!(state.silenceUntil > this.now()) || ctx?.selfSilenced === true)
    );
  }
  assertActive(ctx) {
    const stored = this.capabilities.get(ctx.token);
    if (
      stored !== ctx ||
      ctx.controller.signal.aborted ||
      ctx.expires < Date.now() ||
      !this.writable(this.agent(ctx.agentId), ctx.conversation, ctx)
    )
      throw Error("AGENT_PAUSED_OR_EXPIRED");
    return this.agent(ctx.agentId);
  }
  capability(token) {
    const ctx = this.capabilities.get(token);
    if (!ctx) throw Error("INVALID_CAPABILITY");
    this.assertActive(ctx);
    return ctx;
  }
  startConnection(...args) {
    return this.trackWork(this.connectConnection(...args));
  }
  async connectConnection(id) {
    if (this.closed) throw Error("RUNTIME_CLOSING");
    if (this.configChanging) throw Error("CONFIG_CONFLICT");
    if (this.config.mode !== "live") throw Error("ISOLATED_MODE");
    const config = this.connection(id);
    if (!config.enabled) throw Error("CONNECTION_DISABLED");
    if (this.connecting.has(id)) throw Error("CONNECTION_IN_PROGRESS");
    const previous = this.transports.get(id);
    if (previous?.connected) throw Error("CONNECTION_ALREADY_STARTED");
    // A dropped socket leaves a disconnected transport behind; replace it instead of blocking reconnect.
    if (previous) {
      previous.close();
      this.transports.delete(id);
    }
    const t = this.transportFactory(config);
    this.transports.set(id, t);
    this.connecting.add(id);
    t.on("event", (raw) => {
      const job = this.ingest(id, raw).catch((cause) => {
        this.faults.set(id, "EVENT_PROCESSING_FAILED");
        if (!this.closed)
          this.diagnostics.report(Error("EVENT_PROCESSING_FAILED", { cause }), {
            component: "transport",
          });
      });
      this.jobs.add(job);
      job.finally(() => this.jobs.delete(job));
    });
    t.on("fault", (code) => this.faults.set(id, code));
    try {
      await t.connect();
      if (this.closed || this.transports.get(id) !== t)
        throw Error("CONNECTION_CANCELLED");
      this.faults.delete(id);
    } catch (e) {
      t.close();
      if (this.transports.get(id) === t) this.transports.delete(id);
      this.faults.set(id, "CONNECTION_FAILED");
      throw e;
    } finally {
      this.connecting.delete(id);
    }
    return { connected: true };
  }
  async stopConnection(id) {
    this.transports.get(id)?.close();
    this.transports.delete(id);
    for (const a of this.config.agents.filter((a) => a.connectionId === id))
      await this.cancel(a.id);
  }
  async cancel(agentId) {
    for (const ctx of this.running.values())
      if (ctx.agentId === agentId) ctx.controller.abort();
    for (const [token, ctx] of this.capabilities)
      if (ctx.agentId === agentId) {
        ctx.controller.abort();
        this.capabilities.delete(token);
      }
    this.pending.forEach((v, k) => {
      if (k.startsWith(agentId + "|")) this.pending.delete(k);
    });
    this.conversations.cancel(agentId);
    this.operations.revoke(agentId, false);
    await this.backends.get(agentId)?.cancel?.();
  }
  async changeAppPermissions(agentId, policy, revision) {
    if (this.closed) throw Error("RUNTIME_CLOSING");
    if (this.configChanging) throw Error("CONFIG_CONFLICT");
    this.agent(agentId);
    const apps = appsPolicySchema.parse(policy);
    if (revision !== this.configStore.revision) throw Error("CONFIG_CONFLICT");
    const next = structuredClone(this.config),
      agent = next.agents.find((a) => a.id === agentId);
    agent.apps = apps;
    const names = Object.keys(appDefinitions);
    agent.tools = [
      ...new Set([
        ...agent.tools.filter((n) => !names.includes(n)),
        ...(apps.enabled ? names : []),
      ]),
    ];
    this.configStore.save(next, revision);
    await this.cancel(agentId);
    return { revision: this.configStore.revision, apps };
  }
  async changeFilePermissions(agentId, policy, revision) {
    if (this.closed) throw Error("RUNTIME_CLOSING");
    if (this.configChanging) throw Error("CONFIG_CONFLICT");
    this.agent(agentId);
    const files = filesSchema.parse(policy);
    if (revision !== this.configStore.revision) throw Error("CONFIG_CONFLICT");
    const next = structuredClone(this.config);
    const agent = next.agents.find((a) => a.id === agentId);
    agent.files = files;
    agent.tools = [
      ...new Set([
        ...agent.tools.filter((name) => !FILE_TOOL_NAMES.includes(name)),
        ...(files.enabled ? FILE_TOOL_NAMES : []),
      ]),
    ];
    this.configStore.save(next, revision);
    await this.cancel(agentId);
    return { revision: this.configStore.revision, files };
  }
  changeConfig(...args) {
    return this.trackWork(this.commitConfig(...args));
  }
  async commitConfig(next, revision) {
    if (this.closed) throw Error("RUNTIME_CLOSING");
    if (this.configChanging) throw Error("CONFIG_CONFLICT");
    next = validateConfig(next);
    if (revision !== this.configStore.revision) throw Error("CONFIG_CONFLICT");
    // These scheduling values only affect future opportunities. Permission,
    // identity and backend edits still require full capability invalidation.
    const withNextRates = structuredClone(this.config);
    const intervals = [];
    for (const a of withNextRates.agents) {
      const candidate = next.agents.find((item) => item.id === a.id);
      if (!candidate) continue;
      a.wake.participation = candidate.wake.participation;
      if (a.subject.intervalMs !== candidate.subject.intervalMs)
        intervals.push(a.id);
      a.subject.intervalMs = candidate.subject.intervalMs;
      a.subject.maxChecksPerDay = candidate.subject.maxChecksPerDay;
    }
    if (isDeepStrictEqual(withNextRates, next)) {
      this.configStore.save(next, revision);
      let failed = false;
      for (const id of intervals) {
        try {
          const m = this.memory.bind(id),
            s = m.state(SUBJECT);
          m.setState(SUBJECT, {
            ...s,
            nextCheckAt:
              (s.lastOpportunityAt || this.now()) +
              this.agent(id).subject.intervalMs,
          });
        } catch (cause) {
          failed = true;
          this.diagnostics.report(
            Error("CONFIG_RECONFIGURE_FAILED", { cause }),
            { component: "config", agentId: id },
          );
        }
      }
      return {
        saved: true,
        reconnectRequired: false,
        ...(failed ? { warnings: ["CONFIG_RECONFIGURE_FAILED"] } : {}),
      };
    }
    if (this.backendConnections.operations.size)
      throw Error("BACKEND_OPERATION_IN_PROGRESS");
    if (this.lifecycle?.owned.size)
      throw Error("STOP_MANAGED_QQ_PROCESSES_BEFORE_CONFIG_EDIT");
    // A failed disk commit must not cancel the still-current configuration.
    this.configStore.save(next, revision);
    // No await between commit and invalidation: late tool calls cannot send.
    for (const ctx of this.capabilities.values()) ctx.controller.abort();
    for (const ctx of this.running.values()) ctx.controller.abort();
    this.capabilities.clear();
    this.pending.clear();
    this.configChanging = true;
    let failed = false;
    const apply = async (fn, resource = false) => {
      try {
        await fn();
      } catch (cause) {
        failed = true;
        if (resource) this.retiredResources.add(fn);
        this.diagnostics.report(Error("CONFIG_RECONFIGURE_FAILED", { cause }), {
          component: "config",
        });
      }
    };
    try {
      for (const a of this.config.agents)
        await apply(() =>
          this.memory.bind(a.id).identity.initialize(a, this.now()),
        );
      await Promise.all(
        [...this.backends.values()].map((b) => apply(() => b.close?.(), true)),
      );
      this.backends.clear();
      this.backendConnections.states.clear();
      await apply(() => this.learner.close());
      // Failed old adapters remain owned for a shutdown retry, but cannot be
      // reused by the learner under the newly committed configuration.
      for (const b of this.learner.backends.values())
        this.retiredResources.add(() => b.close?.());
      this.learner.backends.clear();
      this.operations.levels.clear();
      this.operations.pending.clear();
      for (const t of this.transports.values())
        await apply(() => t.close(), true);
      this.transports.clear();
      this.banter = new BanterCoordinator({
        botIds: this.config.connections.map((c) => c.accountId),
        ...this.config.peerLimit,
      });
      return {
        saved: true,
        reconnectRequired: true,
        ...(failed ? { warnings: ["CONFIG_RECONFIGURE_FAILED"] } : {}),
      };
    } finally {
      this.configChanging = false;
    }
  }

  async pause(agentId, paused = true) {
    if (this.closed) throw Error("RUNTIME_CLOSING");
    const next = structuredClone(this.config);
    if (agentId === "all") next.globalPaused = paused;
    else {
      const a = next.agents.find((a) => a.id === agentId);
      if (!a) throw Error("UNKNOWN_AGENT");
      a.paused = paused;
    }
    this.configStore.save(next, this.configStore.revision);
    if (paused) {
      if (agentId === "all")
        await Promise.allSettled(
          this.config.agents.map((a) => this.cancel(a.id)),
        );
      else await this.cancel(agentId);
    }
    return { paused };
  }
  ingest(...args) {
    return this.trackWork(this.ingestEvent(...args));
  }
  async ingestEvent(connectionId, raw) {
    if (this.closed) throw Error("RUNTIME_CLOSING");
    const c = this.connection(connectionId),
      e = normalizeEvent(raw, c);
    if (!e) return { ignored: true };
    // Only message events can be echoes; a recall notice of our own message must still be archived.
    const ownEcho =
      e.kind === "message.received" &&
      e.messageId != null &&
      (e.direction === "out" || e.senderId === c.accountId);
    // The gateway may echo our own send before its HTTP receipt lands; let that delivery finish first.
    if (ownEcho) await this.sendChains.get(connectionId)?.catch(() => {});
    const results = [];
    for (const a of this.config.agents.filter(
      (a) => a.connectionId === connectionId,
    )) {
      if (!allowed(a, e.conversation)) continue;
      const mem = this.memory.bind(a.id);
      assertMessageAccount(mem, connectionId, c.accountId);
      if (
        ownEcho &&
        confirmedMessage(
          mem.db,
          {
            agentId: a.id,
            connectionId,
            conversation: e.conversation,
            namespace: c.messageIdNamespace || "onebot",
          },
          e.messageId,
        )
      ) {
        results.push({ agentId: a.id, duplicate: true, ownEcho: true });
        continue;
      }
      const key = e.messageId
        ? `${connectionId}:${c.messageIdNamespace || "onebot"}:${e.conversation}:${e.kind}:${e.messageId}`
        : `${connectionId}:${e.kind}:${digest(raw)}`;
      const redactConfirmation =
        e.conversation.startsWith("private:") &&
        (a.ownerIds.includes(e.senderId) || e.senderId === c.accountId) &&
        /确认\s+\d{6}/.test(e.body);
      const archived = mem.append({
        ...e,
        ...(redactConfirmation
          ? { body: "[管理员确认；验证码不进入记忆]" }
          : {}),
        connectionId,
        dedupe: key,
        payload: redactConfirmation
          ? {
              trustedInput: true,
              messageNamespace: c.messageIdNamespace || "onebot",
              accountId: c.accountId,
              redacted: "owner-confirmation",
              timeKnown: e.timeKnown,
            }
          : {
              trustedInput: true,
              messageNamespace: c.messageIdNamespace || "onebot",
              segments: e.segments,
              raw: e.raw,
              timeKnown: e.timeKnown,
            },
      });
      mem.person(e.senderId, e.senderName);
      if (!archived.inserted) {
        results.push({ agentId: a.id, duplicate: true });
        continue;
      }
      const state = mem.state(e.conversation);
      state.lastReceivedSeq = archived.seq;
      state.lastObservedAt = e.occurredAt;
      if (e.direction !== "out" && e.senderId !== c.accountId)
        state.lastIncomingAt = this.now();
      mem.setState(e.conversation, state);
      if (e.direction !== "out" && e.senderId !== c.accountId) {
        const subject = mem.state(SUBJECT);
        mem.setState(SUBJECT, {
          ...subject,
          lastActivitySeq: archived.seq,
        });
      }
      this.conversations.notify(a.id, e.conversation);
      this.learner.observe(a, e, archived);
      if (
        ![
          "message.received",
          "notice.poke",
          "notice.join",
          "notice.file",
        ].includes(e.kind) ||
        e.direction === "out" ||
        e.senderId === c.accountId
      )
        continue;
      const peer = this.config.connections.some(
        (c) => c.accountId === e.senderId,
      );
      if (e.conversation.startsWith("group:")) {
        const decision = this.banter.observe({
          groupId: e.conversation.split(":")[1],
          messageId: e.messageId || key,
          senderId: e.senderId,
        });
        if (!decision.allow || (peer && !a.wake.peers)) continue;
      }
      if (
        e.kind === "message.received" &&
        e.conversation.startsWith("private:") &&
        a.ownerIds.includes(e.senderId)
      ) {
        if (await this.operations.command(a, e, archived)) continue;
        if (await this.scheduler.command(a, e, archived)) continue;
      }
      const reason = this.conversations.reason(a, e, c.accountId);
      if (!reason) continue;
      if (!this.writable(a, e.conversation)) {
        // Re-read: owner commands above may have yielded while other events updated this state.
        mem.setState(e.conversation, {
          ...mem.state(e.conversation),
          pendingWake: true,
        });
        this.conversations.request(a.id, e.conversation, reason, {
          seq: archived.seq,
        });
        continue;
      }
      const wake = this.conversations.request(a.id, e.conversation, reason, {
        seq: archived.seq,
      });
      results.push({ agentId: a.id, ...wake });
    }
    return results;
  }
  // A command cannot be answered while paused or silenced. It is never replayed later
  // (approvals and schedules would be stale); leave a visible record and wake on resume.
  skipOwnerCommand(a, e, archived, source) {
    this.memory.bind(a.id).append({
      dedupe: "owner-command-skipped:" + archived.id,
      connectionId: a.connectionId,
      conversation: e.conversation,
      kind: "owner-command.skipped",
      direction: "internal",
      status: "observed",
      body: "[暂停或静默期间收到的主人命令未执行，也不会自动补执行；如仍需要，请主人重新发送]",
      payload: { source, commandEventId: archived.id },
    });
    this.conversations.request(a.id, e.conversation, "private", {
      seq: archived.seq,
    });
    return true;
  }
  async resetSession(agentId, conversation) {
    const a = this.agent(agentId);
    if (conversation !== SUBJECT && !allowed(a, conversation))
      throw Error("INVALID_CONVERSATION");
    for (const [token, active] of this.capabilities)
      if (active.agentId === agentId && active.conversation === conversation) {
        active.controller.abort();
        this.capabilities.delete(token);
      }
    const ctx = this.running.get(agentId + "|" + conversation);
    if (ctx) {
      ctx.controller.abort();
      await ctx.done;
    }
    await this.sendChains.get(a.connectionId)?.catch(() => {});
    this.contexts.retire(agentId, conversation, "administrator-reset");
  }
  wake(...args) {
    return this.trackWork(this.runTurn(...args));
  }
  async runTurn(agentId, conversation, { reasons = [] } = {}) {
    if (this.closed) throw Error("RUNTIME_CLOSING");
    const a = this.agent(agentId);
    if (!this.writable(a, conversation)) throw Error("AGENT_PAUSED");
    if (
      conversation !== SUBJECT &&
      !this.transports.get(a.connectionId)?.connected
    )
      throw Error("QQ_NOT_CONNECTED");
    const runKey = agentId + "|" + conversation;
    if (this.running.has(runKey)) return;
    const mem = this.memory.bind(agentId);
    const ctx = this.makeContext(agentId, conversation),
      { token, controller } = ctx;
    let resolveDone;
    ctx.done = new Promise((resolve) => {
      resolveDone = resolve;
    });
    this.conversations.begin(ctx);
    this.subject.begin(ctx, reasons);
    ctx.scheduleRunId = reasons
      .map((r) => r.taskRunId)
      .find(
        (id) =>
          id &&
          this.scheduler
            .state(agentId)
            .history.some(
              (run) =>
                run.id === id &&
                run.target === conversation &&
                run.status === "queued",
            ),
      );
    ctx.allowedTools = this.toolsFor(a, conversation);
    this.running.set(runKey, ctx);
    const state = mem.state(conversation);
    state.lastWakeAt = this.now();
    state.pendingWake = false;
    mem.setState(conversation, state);
    const timer = setTimeout(() => {
      if (controller.signal.aborted) return;
      this.faults.set(agentId, "BACKEND_TURN_TIMEOUT");
      controller.abort();
    }, a.behavior.turnTimeoutMs);
    let outcome = "completed-no-send",
      backend;
    try {
      backend = this.backendConnections.adapter(a);
      const tools = toolSpecs(ctx.allowedTools);
      const prepared = this.contexts.prepare(ctx, backend, reasons, tools);
      if (ctx.initialSession)
        ctx.estimatedAdded += JSON.stringify(tools).length;
      await this.runBackend(ctx, backend, {
        agent: a,
        conversation,
        prompt: prepared.prompt,
        instructions: prepared.instructions,
        onUsage: (usage) => !this.stopped && this.contexts.usage(ctx, usage),
        signal: controller.signal,
        tools,
        callTool: (name, args) => this.callTool(ctx, name, args),
        session: prepared.session,
        saveSession: (session) =>
          !this.stopped &&
          saveSession(mem, conversation, session, {
            turnId: ctx.turnId,
            backendId: a.backendId,
            at: this.now(),
            inactive:
              !this.capabilities.has(token) ||
              controller.signal.aborted ||
              this.closed,
            reason: controller.signal.aborted ? "cancelled" : "backend-failure",
          }),
        onBackendTurn: (reference) =>
          !this.stopped && recordBackendTurn(mem, ctx.turnId, reference),
        onImageSession: (id) =>
          !this.stopped && this.generatedImages.begin(ctx, id),
        onGeneratedImage: (id, item) =>
          !this.stopped && this.generatedImages.capture(ctx, backend, id, item),
        onImageError: () => {
          if (!controller.signal.aborted) {
            ctx.imageRegistrationFailed = true;
            this.faults.set(agentId, "GENERATED_IMAGE_REGISTRATION_FAILED");
          }
        },
      });
      outcome = controller.signal.aborted
        ? "cancelled"
        : ctx.confirmedSends
          ? "sent"
          : "completed-no-send";
      if (!controller.signal.aborted && !ctx.imageRegistrationFailed)
        this.faults.delete(agentId);
    } catch (e) {
      outcome = controller.signal.aborted ? "cancelled" : "failed";
      if (!controller.signal.aborted)
        this.diagnostics.report(Error("BACKEND_TURN_FAILED", { cause: e }), {
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
        this.backendConnections.failed(a.backendId, e);
      // Administrative cancellation is an expected lifecycle transition. Keep
      // earlier genuine faults (including the deadline), but do not invent one.
      if (!controller.signal.aborted)
        this.faults.set(
          agentId,
          e.message === "AGENT_PAUSED_OR_EXPIRED"
            ? "PAUSED"
            : classifiedFault ||
                (/^DSH_[A-Z_]+$/.test(e.message)
                  ? e.message
                  : "BACKEND_TURN_FAILED"),
        );
    } finally {
      this.capabilities.delete(token);
      try {
        try {
          this.subject.finish(ctx, outcome);
          if (ctx.turnId) await this.contexts.finish(ctx, outcome, backend);
        } catch (error) {
          this.faults.set(agentId, "CONTEXT_FINALIZATION_FAILED");
          this.diagnostics.report(error, {
            component: "runtime",
            agentId,
            conversation,
          });
          if (ctx.turnId)
            retireSession(
              mem,
              conversation,
              "finalization-failed",
              this.now(),
              {
                turnId: ctx.turnId,
                backendId: a.backendId,
              },
            );
        }
        for (const reason of reasons)
          if (reason.taskRunId)
            this.scheduler.finish(agentId, reason.taskRunId, outcome);
        // Allow the next queued wake to start; ctx.done still covers all finalization.
        this.running.delete(runKey);
        if (
          !controller.signal.aborted &&
          !this.closed &&
          this.config.agents.some((a) => a.id === agentId) &&
          conversation !== SUBJECT
        )
          this.conversations.finish(ctx);
      } finally {
        clearTimeout(timer);
        if (this.running.get(runKey) === ctx) this.running.delete(runKey);
        resolveDone();
      }
    }
    return { status: outcome };
  }
  async runBackend(ctx, backend, params) {
    const mem = this.memory.bind(ctx.agentId);
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
                { ...failure, attempt, at: this.now() },
              ],
            });
        },
        onRecovery: (error, attempt) => {
          this.assertActive(ctx);
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
        this.capabilities.has(ctx.token);
      throw error;
    }
  }
  callTool(...args) {
    return this.trackWork(this.runTool(...args));
  }
  async runTool(ctx, name, args = {}) {
    const a = this.assertActive(ctx);
    for (const repo of privateGithubSources(ctx, this))
      ctx.privateRead.add(githubMarker(repo));
    ctx.persistTaint?.();
    if (
      !(ctx.allowedTools || this.toolsFor(a, ctx.conversation)).includes(
        name,
      ) ||
      !toolAvailable(a, name, ctx.conversation)
    )
      throw Error("TOOL_DISABLED");
    if (
      ctx.conversation === SUBJECT &&
      name === "external_tool" &&
      !a.subject.externalReads.some(
        (x) => x.serverId === args.serverId && x.tool === args.tool,
      )
    )
      throw Error("SUBJECT_EXTERNAL_TOOL_NOT_READ_ALLOWED");
    let result = await dispatchTool(this, ctx, name, args);
    if (
      ["web_fetch", "social_read", "social_search", "social_comments"].includes(
        name,
      ) ||
      (ctx.conversation === SUBJECT && name === "external_tool")
    ) {
      this.assertActive(ctx);
      const mem = this.memory.bind(a.id),
        record = mem.append({
          dedupe: "tool-read:" + randomBytes(12).toString("hex"),
          conversation: ctx.conversation,
          kind: "external.read",
          direction: "internal",
          status: "observed",
          body: JSON.stringify(result).slice(0, 20000),
          payload: {
            tool: name,
            request: args,
            epistemic: "external-source-claim",
            truncated: JSON.stringify(result).length > 20000,
          },
        });
      result = result?.content
        ? {
            ...result,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  sourceRecordId: record.id,
                  notice:
                    "Actual tool result; source claims are not verified facts.",
                }),
              },
              ...result.content,
            ],
          }
        : { sourceRecordId: record.id, result };
    }
    ctx.estimatedAdded =
      (ctx.estimatedAdded || 0) +
      JSON.stringify(args).length +
      (result?.content
        ? result.content
            .filter((c) => c.type === "text")
            .reduce((n, c) => n + c.text.length, 0)
        : JSON.stringify(result ?? null).length);
    return result;
  }
  assertDisclosure(ctx, { external = false } = {}) {
    for (const repo of privateGithubSources(ctx, this))
      ctx.privateRead.add(githubMarker(repo));
    ctx.persistTaint?.();
    const ids = [...ctx.privateRead].filter(
      (id) =>
        !ctx.grants.has(id) &&
        (external ||
          /^(operations|operations-result):/.test(id) ||
          (id.startsWith("github-private:") &&
            !githubPrivateContext(this.agent(ctx.agentId), ctx.conversation))),
    );
    if (!ids.length) return;
    this.requestDisclosure(ctx, {
      reason: external ? "external-service" : "operations-content",
      records: ids,
    });
    throw Error(
      external
        ? "PRIVATE_RECOLLECTION_EXTERNAL_CALL_BLOCKED"
        : "PRIVATE_RECOLLECTION_REQUIRES_DISCLOSURE_GRANT",
    );
  }
  authorizeExternal(ctx, request, options) {
    return authorizeExternal(this, ctx, request, options);
  }
  observeInput(ctx, items) {
    observeInput(this, ctx, items);
  }
  requestDisclosure(ctx, details) {
    const candidate = {
      ...structuredClone(details),
      records: [...details.records].sort(),
      binding: {
        agentId: ctx.agentId,
        conversation: ctx.conversation,
        expires: ctx.expires,
        sourceIds: [...ctx.privateRead].sort(),
      },
    };
    const { approvalId, ...previous } = ctx.disclosureRequest || {};
    if (!approvalId || !isDeepStrictEqual(previous, candidate))
      ctx.disclosureRequest = { ...candidate, approvalId: randomUUID() };
  }
  currentDisclosure(ctx) {
    const pending = ctx.disclosureRequest;
    if (!pending) return false;
    try {
      this.assertActive(ctx);
    } catch {
      return false;
    }
    return isDeepStrictEqual(pending.binding, {
      agentId: ctx.agentId,
      conversation: ctx.conversation,
      expires: ctx.expires,
      sourceIds: [...ctx.privateRead].sort(),
    });
  }
  grant(input) {
    const { approvalId, agentId, conversation, ids, requestId } =
      disclosureGrant.parse(input);
    const ctx = [...this.capabilities.values()].find(
      (c) => c.disclosureRequest?.approvalId === approvalId,
    );
    if (
      !ctx ||
      !this.currentDisclosure(ctx) ||
      ctx.agentId !== agentId ||
      ctx.conversation !== conversation
    )
      throw Error("INVALID_DISCLOSURE_GRANT");
    const pending = ctx.disclosureRequest;
    if (!isDeepStrictEqual([...ids].sort(), pending.records))
      throw Error("INVALID_DISCLOSURE_GRANT");
    let result;
    if (pending.requestId || requestId)
      result = grantExternal(ctx, ids, requestId);
    else {
      ids.forEach((id) => ctx.grants.add(id));
      result = { granted: ids, conversation: ctx.conversation };
    }
    // The public ID names one pending approval, never a model capability.
    ctx.disclosureRequest = undefined;
    return result;
  }
  assertSafeOutput(ctx, text) {
    if (
      text.includes(ctx.token) ||
      /(?:sk-|gh[pousr]_|github_pat_|Bearer\s)[a-zA-Z0-9_-]{16,}/.test(text)
    )
      throw Error("SENSITIVE_OUTPUT_BLOCKED");
  }
  async send(
    ctx,
    { requestId, text = "", replyTo, atUserId, mediaId },
    { archiveBody } = {},
  ) {
    const a = this.assertActive(ctx),
      mem = this.memory.bind(a.id);
    this.assertDisclosure(ctx);
    if (typeof text !== "string" || text.length > 8000 || (!text && !mediaId))
      throw Error("INVALID_MESSAGE");
    this.assertSafeOutput(ctx, text);
    text = mdToPlain(text);
    if (!text && !mediaId) throw Error("EMPTY_MESSAGE");
    const segments = [];
    const connection = this.connection(a.connectionId),
      namespace = connection.messageIdNamespace || "onebot",
      requestedReplyTo = replyTo;
    assertMessageAccount(mem, a.connectionId, connection.accountId);
    if (replyTo) {
      const scope = {
        agentId: a.id,
        connectionId: a.connectionId,
        conversation: ctx.conversation,
      };
      const own = resolveMessage(mem.db, scope, replyTo);
      if (!own) throw Error("UNKNOWN_REPLY_TARGET");
      replyTo = gatewayMessageId(
        mem.db,
        scope,
        own,
        namespace,
        connection.accountId,
      );
      segments.push({ type: "reply", data: { id: String(replyTo) } });
    }
    if (atUserId) {
      if (!/^\d+$/.test(String(atUserId))) throw Error("INVALID_PERSON");
      segments.push({ type: "at", data: { qq: String(atUserId) } });
    }
    if (text) segments.push({ type: "text", data: { text } });
    if (mediaId) {
      if (!this.media) throw Error("MEDIA_UNAVAILABLE");
      const meta = this.media.metadata(a.id, mediaId);
      taintMedia(ctx, meta);
      segments.push(this.media.segment(a.id, mediaId));
    }
    return this.deliver(ctx, {
      requestId,
      intent: segments,
      body: archiveBody ?? text,
      metadata: {
        replyTo,
        requestedReplyTo,
        referenceNamespace: namespace,
        atUserId,
        mediaId,
      },
      send: (transport) => transport.send(ctx.conversation, segments),
    });
  }
  async deliver(ctx, operation) {
    const a = this.assertActive(ctx);
    ctx.pendingDeliveries = (ctx.pendingDeliveries || 0) + 1;
    const previous = this.sendChains.get(a.connectionId);
    const result = previous
      ? previous.catch(() => {}).then(() => this.deliverNow(ctx, operation))
      : this.deliverNow(ctx, operation);
    this.sendChains.set(a.connectionId, result);
    try {
      return await result;
    } finally {
      ctx.pendingDeliveries--;
      if (this.sendChains.get(a.connectionId) === result)
        this.sendChains.delete(a.connectionId);
    }
  }
  async deliverNow(
    ctx,
    { requestId, intent, body = "", metadata = {}, send, action = false },
  ) {
    const a = this.assertActive(ctx),
      mem = this.memory.bind(a.id);
    assertMessageAccount(
      mem,
      a.connectionId,
      this.connection(a.connectionId).accountId,
    );
    if (mem.state(ctx.conversation).silenceUntil > this.now())
      throw Error("CONVERSATION_SILENCED");
    const proactive = this.subject.beforeDelivery(ctx);
    if (proactive) requestId = "intent:" + proactive.id;
    if (typeof requestId !== "string" || !requestId || requestId.length > 200)
      throw Error("INVALID_REQUEST_ID");
    this.assertDisclosure(ctx);
    beforeShareDelivery(appService(this), ctx, metadata);
    const serialized = JSON.stringify(intent);
    if (
      serialized.includes(ctx.token) ||
      /(?:sk-|gh[pousr]_|Bearer\s)[a-zA-Z0-9_-]{16,}/.test(body)
    )
      throw Error("SENSITIVE_OUTPUT_BLOCKED");
    const previous = mem.delivery(requestId);
    if (previous) {
      mem.reserveDelivery(requestId, ctx.conversation, intent);
      if (previous.status === "sent")
        return {
          status: "sent",
          messageId: previous.message_id,
          duplicate: true,
        };
      throw Error(
        "DELIVERY_ALREADY_ATTEMPTED_" + previous.status.toUpperCase(),
      );
    }
    // Recovery must not evade a sent/unknown/failed receipt by changing the
    // request ID, wording, media, action or target. Same-ID receipt reads above
    // remain available; new deliveries are fenced for this continuation.
    if (ctx.recoveryDeliveryBlocked) throw Error("RECOVERY_DELIVERY_BLOCKED");
    if (metadata.mediaId)
      this.generatedImages.assertDelivery(ctx, metadata.mediaId, requestId);
    const state = mem.state(ctx.conversation),
      now = this.now();
    const batchUsed = proactive
      ? 0
      : ctx.internalDelivery
        ? ctx.sendCount
        : ctx.scheduleRunId
          ? state.scheduleReplyCounts?.[ctx.scheduleRunId] || 0
          : state.replyBatchSends || 0;
    if (batchUsed >= (a.maxConsecutiveSends ?? a.maxSendsPerTurn))
      throw Error("REPLY_BURST_LIMIT");
    const times = (state.sendTimes || []).filter((x) => now - x < 3600000);
    if (
      times.length >= a.behavior.maxSendPerHour ||
      times.filter((x) => now - x < 60000).length >= a.behavior.maxSendPerMinute
    )
      throw Error("SEND_RATE_LIMIT");
    const transport = this.transports.get(a.connectionId);
    if (!transport?.connected) throw Error("QQ_NOT_CONNECTED");
    const event = {
      connectionId: a.connectionId,
      conversation: ctx.conversation,
      senderId: this.connection(a.connectionId).accountId,
      direction: "out",
      body,
      payload: {
        requestId,
        ...metadata,
        protectedRepositories: privateGithubSources(ctx, this),
      },
    };
    mem.store.transaction(() => {
      mem.reserveDelivery(requestId, ctx.conversation, intent);
      mem.setState(ctx.conversation, {
        ...state,
        sendTimes: [...times, now],
        ...(!proactive && !ctx.internalDelivery
          ? ctx.scheduleRunId
            ? {
                scheduleReplyCounts: {
                  ...Object.fromEntries(
                    Object.entries(state.scheduleReplyCounts || {}).slice(-99),
                  ),
                  [ctx.scheduleRunId]: batchUsed + 1,
                },
              }
            : { replyBatchSends: batchUsed + 1 }
          : {}),
      });
      this.subject.reserveContact(ctx, proactive);
      mem.append({
        ...event,
        dedupe: "send:" + requestId + ":pending",
        kind: "message.send-attempt",
        status: "pending",
      });
    });
    ctx.replyBatchSends = (ctx.replyBatchSends ?? ctx.sendCount) + 1;
    ctx.deliveryAttempted = true;
    ctx.sendCount++;
    try {
      this.assertActive(ctx);
      const receipt = await send(transport);
      if (action ? receipt?.confirmed !== true : receipt?.messageId == null)
        throw Error("DELIVERY_UNCONFIRMED");
      // Record confirmed delivery even if the user pauses while its network request is in flight.
      const messageId =
        receipt.messageId == null ? null : String(receipt.messageId);
      mem.store.transaction(() => {
        mem.completeDelivery(requestId, "sent", messageId);
        this.subject.delivered(ctx, "sent");
      });
      ctx.confirmedSends = (ctx.confirmedSends || 0) + 1;
      this.conversations.sent(ctx);
      mem.append({
        ...event,
        dedupe: "send:" + requestId + ":sent",
        messageId,
        payload: {
          ...event.payload,
          messageNamespace:
            this.connection(a.connectionId).messageIdNamespace || "onebot",
          ...(receipt.fileId ? { gatewayFileId: receipt.fileId } : {}),
        },
        kind: action ? "action.confirmed" : "message.sent",
        status: "confirmed",
      });
      return {
        status: "sent",
        messageId,
        ...(action ? { actionConfirmed: true } : {}),
        ...(receipt.fileId ? { gatewayFileId: receipt.fileId } : {}),
      };
    } catch (e) {
      const status = e.message === "ONEBOT_REJECTED" ? "failed" : "unknown";
      const reason =
        status === "failed" &&
        ["PACKET_BACKEND_DISABLED", "PACKET_BACKEND_UNAVAILABLE"].includes(
          e.reason,
        )
          ? e.reason
          : undefined;
      // A later audit failure must never downgrade an already-confirmed receipt.
      if (mem.delivery(requestId)?.status === "sent")
        throw Error("DELIVERY_CONFIRMED_AUDIT_FAILED");
      mem.store.transaction(() => {
        mem.completeDelivery(requestId, status);
        this.subject.delivered(ctx, status);
      });
      mem.append({
        ...event,
        dedupe: "send:" + requestId + ":" + status,
        kind: "message.send-result",
        status,
        payload: { ...event.payload, ...(reason ? { reason } : {}) },
      });
      throw Error(
        "DELIVERY_" + status.toUpperCase() + (reason ? "_" + reason : ""),
      );
    }
  }
  status() {
    return {
      recentErrors: this.diagnostics.snapshot(),
      mode: this.config.mode,
      globalPaused: this.config.globalPaused,
      backends: this.backendConnections.list(),
      connections: this.config.connections.map((c) => ({
        id: c.id,
        connected: !!this.transports.get(c.id)?.connected,
        process: this.lifecycle?.status(c.id),
        error: this.faults.get(c.id) || null,
      })),
      agents: this.config.agents.map((a) => ({
        id: a.id,
        paused: a.paused,
        activeTurns: [...this.running.values()].filter(
          (c) => c.agentId === a.id,
        ).length,
        error: this.faults.get(a.id) || null,
      })),
      disclosureRequests: [...this.capabilities.values()]
        .filter((c) => this.currentDisclosure(c))
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
          sourceClasses: sourceCounts(this, c),
          records: c.disclosureRequest.requestId
            ? c.disclosureRequest.records
            : c.disclosureRequest.records.filter((id) => !c.grants.has(id)),
          granted: [...c.grants],
        })),
    };
  }
  close() {
    if (this.closing) return this.closing;
    this.closed = true;
    clearInterval(this.ticker);
    this.closing = this.closeResources();
    return this.closing;
  }
  async closeResources() {
    let failures = 0;
    const cleanup = async (fn) => {
      try {
        await fn();
      } catch (error) {
        failures++;
        this.diagnostics.report(error, { component: "shutdown" });
      }
    };
    // Include contexts belonging to an agent removed by a committed config edit.
    for (const ctx of [...this.capabilities.values(), ...this.running.values()])
      ctx.controller.abort();
    this.capabilities.clear();
    this.pending.clear();
    // Pending handshakes cannot carry a delivery, and must settle before HTTP drains.
    for (const id of this.connecting)
      await cleanup(() => this.transports.get(id)?.close());
    // Start backend close even if a cancel operation does not respond.
    await Promise.all([
      ...this.config.agents.map((a) => cleanup(() => this.cancel(a.id))),
      ...[...this.backends.values()].map((b) => cleanup(() => b.close?.())),
      cleanup(() => this.learner.close()),
      cleanup(() => this.backendConnections.drain()),
    ]);
    while (this.jobs.size || this.work.size || this.sendChains.size)
      await Promise.allSettled([
        ...this.jobs,
        ...this.work,
        ...this.sendChains.values(),
      ]);
    for (const transport of this.transports.values())
      await cleanup(() => transport.close());
    for (const close of this.retiredResources) await cleanup(close);
    this.retiredResources.clear();
    await cleanup(() => this.lifecycle?.close());
    this.stopped = true;
    return { ok: failures === 0, failures };
  }
}
import {
  resolveMessage,
  gatewayMessageId,
  assertMessageAccount,
  confirmedMessage,
} from "../memory/message-ids.mjs";
