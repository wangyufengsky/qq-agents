import { ProtectedWork, isWorkScope } from "./protected-work.mjs";
import { recallBoundary } from "./recall-boundary.mjs";
import { containsCredential } from "./secrets.mjs";
import { sessionReference } from "./session-records.mjs";
import { isDeepStrictEqual } from "node:util";
import { DeliveryService } from "./delivery.mjs";
import { TurnRunner } from "./turn-runner.mjs";
import { runtimeStatus } from "./runtime-status.mjs";
import { observeInput } from "./input-progress.mjs";
import { AppCursors } from "../apps/cursors.mjs";
import { Diagnostics } from "./diagnostics.mjs";
import { GeneratedImages } from "./generated-images.mjs";
import { BackendConnections } from "./backend-connections.mjs";
import { backendCapabilities } from "../backends/capabilities.mjs";
import { ConnectionRecovery } from "./connection-recovery.mjs";
import {
  authorizeExternal,
  grantExternal,
  sourceClass,
} from "./outbound-policy.mjs";
import { toolAvailable } from "../tools/catalog.mjs";
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
import { commitConfig } from "./config-updates.mjs";
import { allowed, inSilence } from "./config.mjs";
import { normalizeEvent, OneBot } from "../transport/onebot.mjs";
import { BanterCoordinator } from "../../vendor/local-bridge/banter.mjs";
import { dispatchTool } from "../tools/index.mjs";
import { ConversationEngine } from "./conversations.mjs";
import { TaskScheduler } from "./scheduler.mjs";
import { Operations } from "./operations.mjs";
import { VoiceTranscription } from "./voice-transcription.mjs";

// Adds or removes a feature's tools while keeping the existing order, so saving
// an unchanged permission page does not count as a policy change.
const toggleTools = (tools, names, enabled) =>
  enabled
    ? [...tools, ...names.filter((n) => !tools.includes(n))]
    : tools.filter((n) => !names.includes(n));
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
    this.connectionRecovery = new ConnectionRecovery(this);
    // Replaced by main.mjs when the console starts with `--live --resume`.
    this.autoResume = new AutoResume(this);
    this.running = new Map();
    this.pending = new Map();
    this.capabilities = new Map();
    this.faults = new Map();
    this.jobs = new Set();
    this.work = new Set();
    this.retiredResources = new Set();
    this.closed = false;
    this.reconfiguringAgents = new Set();
    this.reconfiguringConnections = new Set();
    this.delivery = new DeliveryService(this);
    this.sendChains = this.delivery.chains;
    this.turns = new TurnRunner(this);
    this.conversations = new ConversationEngine(this);
    this.scheduler = new TaskScheduler(this);
    this.operations = new Operations(this);
    this.contexts = new ContextLifecycle(this);
    this.generatedImages = new GeneratedImages(this);
    this.subject = new SubjectCoordinator(this);
    this.transcripts = new VoiceTranscription(this);
    this.protectedWork = new ProtectedWork(this);
    this.protectedWork.recover();
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
    if (this.closed) return;
    if (!this.nextCursorCleanupAt || this.now() >= this.nextCursorCleanupAt) {
      new AppCursors(this.memory).cleanup(this.now());
      this.nextCursorCleanupAt = this.now() + 60000;
    }
    this.backendConnections.tick();
    this.connectionRecovery.tick();
    this.contexts.tick();
    this.subject.tick();
    this.conversations.tick();
    this.scheduler.tick();
    this.operations.expire();
  }
  makeContext(agentId, conversation) {
    if (this.closed) throw Error("RUNTIME_CLOSING");
    if (this.reconfiguringAgents.has(agentId)) throw Error("CONFIG_CONFLICT");
    const a = this.agent(agentId),
      mem = this.memory.bind(agentId);
    if (
      isWorkScope(conversation) &&
      !this.protectedWork.active(agentId, conversation)
    )
      throw Error("PROTECTED_WORK_NOT_ACTIVE");
    const recallGeneration =
      mem.state(conversation).recallRecovery?.generation || 0;
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
      const current = mem.state(conversation);
      if ((current.recallRecovery?.generation || 0) !== recallGeneration)
        return;
      mem.setState(conversation, {
        ...current,
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
    if (isWorkScope(conversation))
      return this.protectedWork.tools(a, conversation);
    const selected =
      conversation === SUBJECT
        ? [
            ...new Set([
              ...SUBJECT_TOOLS.filter(
                (n) =>
                  n.startsWith("self_") ||
                  n.startsWith("intent_") ||
                  n.startsWith("work_") ||
                  n.startsWith("person_") ||
                  n.startsWith("mood_") ||
                  n === "subject_log" ||
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
      backendCapabilities(
        this.config.backends.find((b) => b.id === a.backendId)?.type,
      ).imageGeneration
    )
      selected.push("generated_image_list");
    // Reading back one's own library goes with listing it: enabling files
    // grants both, and configurations saved before file_read existed get it
    // without an edit.
    if (selected.includes("file_list")) selected.push("file_read");
    return [...new Set(selected)].filter((name) =>
      toolAvailable(a, name, conversation),
    );
  }
  // Every gate that keeps an agent from speaking. Without a conversation, only
  // agent-wide gates are listed (for the console); writable() always passes one.
  blockers(a, conversation, ctx = null) {
    const codes = [];
    if (this.closed) codes.push("RUNTIME_CLOSING");
    if (this.reconfiguringAgents.has(a.id)) codes.push("RECONFIGURING");
    if (this.backendConnections.blocked.has(a.id))
      codes.push("BACKEND_UNAVAILABLE");
    if (conversation === SUBJECT) {
      if (!codes.length && !this.subject.internalAllowed(a))
        codes.push("SUBJECT_NOT_ALLOWED");
      return codes;
    }
    if (this.config.mode !== "live") codes.push("ISOLATED_MODE");
    if (this.config.globalPaused) codes.push("GLOBAL_PAUSED");
    if (a.paused) codes.push("AGENT_PAUSED");
    // Quiet hours govern QQ chatter; console-started protected work never speaks there.
    if (isWorkScope(conversation)) {
      if (!this.protectedWork.active(a.id, conversation))
        codes.push("NOT_ALLOWED");
      return codes;
    }
    if (inSilence(a, this.clock())) codes.push("QUIET_HOURS");
    if (conversation === undefined) return codes;
    if (!allowed(a, conversation)) codes.push("NOT_ALLOWED");
    const state = this.memory.bind(a.id).state(conversation);
    if (state.paused) codes.push("CONVERSATION_PAUSED");
    // The turn that chose to go quiet may still finish bookkeeping; deliverNow blocks its sends.
    if (state.silenceUntil > this.now() && ctx?.selfSilenced !== true)
      codes.push("CONVERSATION_SILENCED");
    return codes;
  }
  writable(a, conversation, ctx = null) {
    return (
      conversation !== undefined &&
      this.blockers(a, conversation, ctx).length === 0
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
    if (this.reconfiguringConnections.has(id)) throw Error("CONFIG_CONFLICT");
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
      if (
        this.transports.get(id) !== t ||
        this.closed ||
        this.reconfiguringConnections.has(id)
      )
        return;
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
    t.on("fault", (code) => {
      if (this.transports.get(id) !== t || this.closed) return;
      this.faults.set(id, code);
      this.connectionRecovery.lost(id, code);
    });
    try {
      await t.connect();
      if (this.closed || this.transports.get(id) !== t)
        throw Error("CONNECTION_CANCELLED");
      this.faults.delete(id);
      this.connectionRecovery.armed(id);
      for (const a of this.config.agents.filter((a) => a.connectionId === id))
        this.memory.due.rebuild(a.id);
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
    // An administrator disconnect is final until the next manual connect.
    this.connectionRecovery.disarm(id);
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
    this.transcripts.cancel(agentId);
    this.operations.revoke(agentId, false);
    await this.backends.get(agentId)?.cancel?.();
  }
  // Stops one conversation's turn; the agent's other conversations and owner grants continue.
  async cancelConversation(agentId, conversation) {
    const key = agentId + "|" + conversation;
    for (const [token, ctx] of this.capabilities)
      if (ctx.agentId === agentId && ctx.conversation === conversation) {
        ctx.controller.abort();
        this.capabilities.delete(token);
      }
    this.pending.delete(key);
    this.transcripts.cancel(agentId, conversation);
    this.conversations.notify(agentId, conversation);
    const ctx = this.running.get(key);
    if (ctx) {
      ctx.controller.abort();
      await ctx.done;
    }
  }
  async changeAppPermissions(agentId, policy, revision) {
    const apps = appsPolicySchema.parse(policy),
      next = structuredClone(this.config),
      agent = next.agents.find((a) => a.id === this.agent(agentId).id);
    agent.apps = apps;
    agent.tools = toggleTools(
      agent.tools,
      Object.keys(appDefinitions),
      apps.enabled,
    );
    await this.changeConfig(next, revision);
    return { revision: this.configStore.revision, apps };
  }
  async changeFilePermissions(agentId, policy, revision) {
    const files = filesSchema.parse(policy),
      next = structuredClone(this.config),
      agent = next.agents.find((a) => a.id === this.agent(agentId).id);
    agent.files = files;
    agent.tools = toggleTools(agent.tools, FILE_TOOL_NAMES, files.enabled);
    await this.changeConfig(next, revision);
    return { revision: this.configStore.revision, files };
  }
  changeConfig(...args) {
    return this.trackWork(this.commitConfig(...args));
  }
  commitConfig(next, revision) {
    return commitConfig(this, next, revision);
  }
  // Pause is a safety control: it waits out an in-flight edit rather than
  // failing with CONFIG_CONFLICT, then applies to the latest configuration.
  async pause(agentId, paused = true) {
    if (this.closed) throw Error("RUNTIME_CLOSING");
    if (agentId !== "all") this.agent(agentId);
    while (this.configChanging) await this.configSettled;
    const next = structuredClone(this.config);
    if (agentId === "all") next.globalPaused = paused;
    else {
      const a = next.agents.find((a) => a.id === agentId);
      if (!a) throw Error("UNKNOWN_AGENT");
      a.paused = paused;
    }
    await this.changeConfig(next, this.configStore.revision);
    return { paused };
  }
  // Going isolated is a safety control like pause: it waits out an in-flight
  // edit and applies to the latest revision. Going live must match the
  // revision the administrator reviewed.
  async setMode(mode, revision) {
    if (this.closed) throw Error("RUNTIME_CLOSING");
    if (mode === "isolated") {
      while (this.configChanging) await this.configSettled;
      revision = this.configStore.revision;
    }
    if (this.config.mode === mode) return { mode };
    await this.changeConfig(
      { ...structuredClone(this.config), mode },
      revision,
    );
    return { mode };
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
      if (ownEcho)
        mem.reconcileFromEcho({
          conversation: e.conversation,
          text: e.segments
            .filter((s) => s.type === "text")
            .map((s) => s.data?.text || "")
            .join(""),
          messageId: e.messageId,
        });
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
      // Received voice is transcribed beside intake, never awaited here.
      const voice = this.transcripts.observe(a, e, archived);
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
      const reason = this.conversations.reason(a, e, c.accountId),
        addressed = this.conversations.addressed(a, e, c.accountId);
      if (voice) voice.reason = reason;
      if (!reason) {
        this.conversations.extend(a.id, e.conversation, e.senderId);
        continue;
      }
      if (!this.writable(a, e.conversation)) {
        // Re-read: owner commands above may have yielded while other events updated this state.
        mem.setState(e.conversation, {
          ...mem.state(e.conversation),
          pendingWake: true,
        });
        this.conversations.request(a.id, e.conversation, reason, {
          seq: archived.seq,
          senderId: e.senderId,
          addressed,
        });
        continue;
      }
      const wake = this.conversations.request(a.id, e.conversation, reason, {
        seq: archived.seq,
        senderId: e.senderId,
        addressed,
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
    this.revokeCapabilities(agentId, conversation);
    const ctx = this.running.get(agentId + "|" + conversation);
    if (ctx) {
      ctx.controller.abort();
      await ctx.done;
    }
    await this.sendChains.get(a.connectionId)?.catch(() => {});
    this.contexts.retire(agentId, conversation, "administrator-reset");
  }
  async recoverProtectedConversation(agentId, conversation) {
    const a = this.agent(agentId),
      m = this.memory.bind(agentId);
    if (!allowed(a, conversation) || githubPrivateContext(a, conversation))
      throw Error("INVALID_CONVERSATION");
    const before = m.state(conversation);
    if (!before.paused) throw Error("RECOVERY_REQUIRES_PAUSED_CONVERSATION");
    const blocked = (before.disclosureTaint || []).some((id) =>
      ["operations", "private-repository"].includes(
        sourceClass(this, { agentId }, id),
      ),
    );
    if (!blocked) throw Error("RECOVERY_NOT_REQUIRED");
    await this.resetSession(agentId, conversation);
    return m.store.transaction(() => {
      const state = m.state(conversation);
      if (!state.paused || this.running.has(agentId + "|" + conversation))
        throw Error("RECOVERY_REQUIRES_PAUSED_CONVERSATION");
      const id = this.contexts.fence(m, conversation, {
        prefix: "recall-recovery",
        reason: "protected-recall-recovery",
        session: before.session ? sessionReference(before.session) : null,
      });
      return { recovered: true, paused: true, archiveId: id };
    });
  }
  revokeCapabilities(agentId, conversation) {
    for (const [token, active] of this.capabilities)
      if (active.agentId === agentId && active.conversation === conversation) {
        active.controller.abort();
        this.capabilities.delete(token);
      }
  }
  wake(...args) {
    return this.trackWork(this.runTurn(...args));
  }
  runTurn(...args) {
    return this.turns.runTurn(...args);
  }
  runBackend(...args) {
    return this.turns.runBackend(...args);
  }
  callTool(...args) {
    return this.trackWork(this.runTool(...args));
  }
  // Records name, outcome and duration of every call (never arguments or
  // results), so a turn's actual activity can be measured afterwards.
  async runTool(ctx, name, args = {}) {
    const startedAt = Date.now(),
      calls = (ctx.toolCalls ||= []);
    try {
      // Reserved before any await, so concurrent calls share one budget.
      if (ctx.conversation === SUBJECT && name !== "subject_log") {
        const limit = this.agent(ctx.agentId).subject.maxToolCallsPerTurn;
        if ((ctx.subjectToolReservations || 0) >= limit)
          throw Error("SUBJECT_TOOL_BUDGET");
        ctx.subjectToolReservations = (ctx.subjectToolReservations || 0) + 1;
      }
      const result = await this.executeTool(ctx, name, args);
      if (calls.length < 50)
        calls.push({ name, ok: true, ms: Date.now() - startedAt });
      return result;
    } catch (error) {
      if (calls.length < 50)
        calls.push({
          name,
          ok: false,
          code: /^[A-Z][A-Z0-9_]{2,80}$/.test(error?.message || "")
            ? error.message
            : "TOOL_FAILED",
          ms: Date.now() - startedAt,
        });
      throw error;
    }
  }
  async executeTool(ctx, name, args = {}) {
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
    const boundary = recallBoundary(this, ctx);
    for (const id of [
      args.id,
      args.eventId,
      args.recordId,
      args.aroundId,
      ...(args.eventIds || []),
      ...(args.evidence || []),
      ...(args.evidenceIds || []),
      ...(args.counterEvidence || []),
    ].filter((id) => typeof id === "string"))
      boundary.assertId(id);
    for (const [id, library] of [
      [args.fileId, this.files],
      [args.mediaId, this.media],
      [args.audioId || args.audioInput?.audioId, this.voices],
    ])
      if (id && library) boundary.assert(library.metadata(ctx.agentId, id));
    let result = await dispatchTool(this, ctx, name, args);
    if (this.protectedWork.context(ctx) && name !== "protected_work_submit")
      this.protectedWork.record(
        ctx,
        "tool",
        JSON.stringify({ name, result }).slice(0, 24000),
      );
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
    if (this.protectedWork?.context(ctx))
      throw Error("PROTECTED_WORK_OUTBOUND_DENIED");
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
    if (text.includes(ctx.token) || containsCredential(text))
      throw Error("SENSITIVE_OUTPUT_BLOCKED");
  }
  send(...args) {
    return this.delivery.send(...args);
  }
  deliver(...args) {
    return this.delivery.deliver(...args);
  }
  deliverNow(...args) {
    return this.delivery.deliverNow(...args);
  }
  status() {
    return runtimeStatus(this);
  }
  close() {
    if (this.closing) return this.closing;
    this.closed = true;
    clearInterval(this.ticker);
    this.autoResume.cancel("stopped");
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
import { AutoResume } from "./auto-resume.mjs";
import {
  assertMessageAccount,
  confirmedMessage,
} from "../memory/message-ids.mjs";
