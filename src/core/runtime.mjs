import { beforeShareDelivery } from "../apps/sharing.mjs";
import { appService } from "../apps/tools.mjs";
import { appsPolicySchema } from "../apps/policy.mjs";
import { appDefinitions } from "../apps/tools.mjs";
import { ContextLifecycle, SUBJECT } from "./lifecycle.mjs";
import { SubjectCoordinator } from "./subject.mjs";
import { CHAT_MIND_TOOLS, SUBJECT_TOOLS } from "../tools/mind.mjs";
import { FILE_TOOL_NAMES } from "../tools/file-tools.mjs";
import { filesSchema } from "./policy.mjs";
import { createHash, randomBytes } from "node:crypto";
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

const digest = (x) =>
  createHash("sha256").update(JSON.stringify(x)).digest("hex");
export class Runtime {
  constructor({
    configStore,
    memory,
    backendFactory,
    transportFactory = (c) => new OneBot(c),
    clock = () => new Date(),
    random = Math.random,
  }) {
    Object.assign(this, {
      configStore,
      memory,
      backendFactory,
      transportFactory,
      clock,
      random,
    });
    this.transports = new Map();
    this.backends = new Map();
    this.running = new Map();
    this.pending = new Map();
    this.capabilities = new Map();
    this.faults = new Map();
    this.jobs = new Set();
    this.closed = false;
    this.sendChains = new Map();
    this.conversations = new ConversationEngine(this);
    this.scheduler = new TaskScheduler(this);
    this.operations = new Operations(this);
    this.learner = new SlangLearner(this);
    this.contexts = new ContextLifecycle(this);
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
  trackJob(job, id) {
    const tracked = Promise.resolve(job).catch(() => {
      this.faults.set(id, "BACKGROUND_JOB_FAILED");
    });
    this.jobs.add(tracked);
    tracked.then(() => this.jobs.delete(tracked));
    return tracked;
  }
  startTimers() {
    if (this.ticker) return;
    this.ticker = setInterval(() => {
      try {
        this.tick();
      } catch {
        this.faults.set("scheduler", "SCHEDULER_TICK_FAILED");
      }
    }, 1000);
    this.ticker.unref?.();
  }
  tick() {
    if (this.closed) return;
    this.contexts.tick();
    this.subject.tick();
    this.conversations.tick();
    this.scheduler.tick();
    this.operations.expire();
    this.learner.tick();
  }
  makeContext(agentId, conversation) {
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
      confirmedSends: 0,
      shownSeq: 0,
    };
    ctx.persistTaint = () =>
      mem.setState(conversation, {
        ...mem.state(conversation),
        disclosureTaint: [...ctx.privateRead],
      });
    this.capabilities.set(ctx.token, ctx);
    return ctx;
  }
  async withContext(agentId, conversation, fn) {
    const ctx = this.makeContext(agentId, conversation);
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
    return conversation === SUBJECT
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
  }
  writable(a, conversation) {
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
      !(state.silenceUntil > this.now())
    );
  }
  assertActive(ctx) {
    const stored = this.capabilities.get(ctx.token);
    if (
      stored !== ctx ||
      ctx.controller.signal.aborted ||
      ctx.expires < Date.now() ||
      !this.writable(this.agent(ctx.agentId), ctx.conversation)
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
  async startConnection(id) {
    if (this.config.mode !== "live") throw Error("ISOLATED_MODE");
    const config = this.connection(id);
    if (!config.enabled) throw Error("CONNECTION_DISABLED");
    if (this.transports.has(id)) throw Error("CONNECTION_ALREADY_STARTED");
    const t = this.transportFactory(config);
    this.transports.set(id, t);
    t.on("event", (raw) => {
      const job = this.ingest(id, raw).catch(() => {
        this.faults.set(id, "EVENT_PROCESSING_FAILED");
      });
      this.jobs.add(job);
      job.finally(() => this.jobs.delete(job));
    });
    t.on("fault", (code) => this.faults.set(id, code));
    try {
      await t.connect();
      this.faults.delete(id);
    } catch (e) {
      t.close();
      this.transports.delete(id);
      this.faults.set(id, "CONNECTION_FAILED");
      throw e;
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
  async changeConfig(next, revision) {
    validateConfig(next);
    if (revision !== this.configStore.revision) throw Error("CONFIG_CONFLICT");
    if (this.lifecycle?.owned.size)
      throw Error("STOP_MANAGED_QQ_PROCESSES_BEFORE_CONFIG_EDIT");
    // Invalidate capabilities synchronously before awaiting cancellation: late tool calls cannot send.
    for (const ctx of this.capabilities.values()) ctx.controller.abort();
    for (const ctx of this.running.values()) ctx.controller.abort();
    this.capabilities.clear();
    this.pending.clear();
    this.configStore.save(next, revision);
    for (const a of this.config.agents)
      this.memory.bind(a.id).identity.initialize(a, this.now());
    await Promise.allSettled(
      [...this.backends.values()].map((b) => b.close?.()),
    );
    this.backends.clear();
    await this.learner.close();
    this.operations.levels.clear();
    this.operations.pending.clear();
    for (const t of this.transports.values()) t.close();
    this.transports.clear();
    this.banter = new BanterCoordinator({
      botIds: this.config.connections.map((c) => c.accountId),
      ...this.config.peerLimit,
    });
    return { saved: true, reconnectRequired: true };
  }
  async pause(agentId, paused = true) {
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
  async ingest(connectionId, raw) {
    const c = this.connection(connectionId),
      e = normalizeEvent(raw, c);
    if (!e) return { ignored: true };
    const results = [];
    for (const a of this.config.agents.filter(
      (a) => a.connectionId === connectionId,
    )) {
      if (!allowed(a, e.conversation)) continue;
      const mem = this.memory.bind(a.id),
        key = e.messageId
          ? `${connectionId}:${e.kind}:${e.messageId}`
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
          ? { redacted: "owner-confirmation", timeKnown: e.timeKnown }
          : { segments: e.segments, raw: e.raw, timeKnown: e.timeKnown },
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
        state.pendingWake = true;
        mem.setState(e.conversation, state);
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
  async resetSession(agentId, conversation) {
    const a = this.agent(agentId);
    if (conversation !== SUBJECT && !allowed(a, conversation))
      throw Error("INVALID_CONVERSATION");
    const ctx = this.running.get(agentId + "|" + conversation);
    if (ctx) {
      ctx.controller.abort();
      await ctx.done;
    }
    await this.sendChains.get(a.connectionId)?.catch(() => {});
    this.contexts.retire(agentId, conversation, "administrator-reset");
  }
  async wake(agentId, conversation, { reasons = [] } = {}) {
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
    ctx.allowedTools = this.toolsFor(a, conversation);
    this.running.set(runKey, ctx);
    const state = mem.state(conversation);
    state.lastWakeAt = this.now();
    state.pendingWake = false;
    mem.setState(conversation, state);
    const timer = setTimeout(
      () => controller.abort(),
      a.behavior.turnTimeoutMs,
    );
    let outcome = "completed-no-send",
      backend;
    try {
      backend = this.backends.get(agentId);
      if (!backend) {
        const bc = this.config.backends.find((b) => b.id === a.backendId);
        backend = this.backendFactory(
          { ...bc, model: a.model || bc.model, effort: a.effort || bc.effort },
          a,
        );
        this.backends.set(agentId, backend);
      }
      const tools = toolSpecs(ctx.allowedTools);
      const prepared = this.contexts.prepare(ctx, backend, reasons, tools);
      if (ctx.initialSession)
        ctx.estimatedAdded += JSON.stringify(tools).length;
      await backend.run({
        agent: a,
        conversation,
        prompt: prepared.prompt,
        instructions: prepared.instructions,
        onUsage: (usage) => this.contexts.usage(ctx, usage),
        signal: controller.signal,
        tools,
        callTool: (name, args) => this.callTool(ctx, name, args),
        session: prepared.session,
        saveSession: (session) => {
          if (controller.signal.aborted || this.closed) return;
          const latest = mem.state(conversation);
          mem.setState(conversation, { ...latest, session });
        },
      });
      outcome = controller.signal.aborted
        ? "cancelled"
        : ctx.confirmedSends
          ? "sent"
          : "completed-no-send";
    } catch (e) {
      outcome = controller.signal.aborted ? "cancelled" : "failed";
      this.faults.set(
        agentId,
        e.message === "AGENT_PAUSED_OR_EXPIRED"
          ? "PAUSED"
          : "BACKEND_TURN_FAILED",
      );
    } finally {
      this.capabilities.delete(token);
      try {
        this.subject.finish(ctx, outcome);
        if (ctx.turnId) {
          await this.contexts.finish(ctx, outcome, backend);
        }
      } catch {
        this.faults.set(agentId, "CONTEXT_FINALIZATION_FAILED");
      } finally {
        clearTimeout(timer);
        this.running.delete(runKey);
        resolveDone();
      }
      for (const reason of reasons)
        if (reason.taskRunId)
          this.scheduler.finish(agentId, reason.taskRunId, outcome);
      if (
        !controller.signal.aborted &&
        !this.closed &&
        this.config.agents.some((a) => a.id === agentId) &&
        conversation !== SUBJECT
      )
        this.conversations.finish(ctx);
    }
    return { status: outcome };
  }
  async callTool(ctx, name, args = {}) {
    const a = this.assertActive(ctx);
    if (
      !(ctx.allowedTools || this.toolsFor(a, ctx.conversation)).includes(name)
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
    const ids = [...ctx.privateRead].filter(
      (id) =>
        !ctx.grants.has(id) &&
        (external || /^(operations|operations-result):/.test(id)),
    );
    if (!ids.length) return;
    ctx.disclosureRequest = {
      reason: external ? "external-service" : "operations-content",
      records: ids,
    };
    throw Error(
      external
        ? "PRIVATE_RECOLLECTION_EXTERNAL_CALL_BLOCKED"
        : "PRIVATE_RECOLLECTION_REQUIRES_DISCLOSURE_GRANT",
    );
  }
  grant(token, ids) {
    const ctx = this.capability(token);
    if (!Array.isArray(ids) || ids.some((id) => !ctx.privateRead.has(id)))
      throw Error("INVALID_DISCLOSURE_GRANT");
    ids.forEach((id) => ctx.grants.add(id));
    return { granted: ids, conversation: ctx.conversation };
  }
  assertSafeOutput(ctx, text) {
    if (
      text.includes(ctx.token) ||
      /(?:sk-|gh[pousr]_|Bearer\s)[a-zA-Z0-9_-]{16,}/.test(text)
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
    if (replyTo) {
      const own = mem.db
        .prepare(
          "SELECT id FROM events WHERE agent_id=? AND conversation=? AND message_id=?",
        )
        .get(a.id, ctx.conversation, String(replyTo));
      if (!own) throw Error("UNKNOWN_REPLY_TARGET");
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
      metadata: { replyTo, atUserId, mediaId },
      send: (transport) => transport.send(ctx.conversation, segments),
    });
  }
  async deliver(ctx, operation) {
    const a = this.assertActive(ctx);
    const previous = this.sendChains.get(a.connectionId);
    const result = previous
      ? previous.catch(() => {}).then(() => this.deliverNow(ctx, operation))
      : this.deliverNow(ctx, operation);
    this.sendChains.set(a.connectionId, result);
    try {
      return await result;
    } finally {
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
    if (ctx.sendCount >= a.maxSendsPerTurn) throw Error("TURN_SEND_LIMIT");
    const state = mem.state(ctx.conversation),
      now = this.now();
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
      payload: { requestId, ...metadata },
    };
    mem.store.transaction(() => {
      mem.reserveDelivery(requestId, ctx.conversation, intent);
      mem.setState(ctx.conversation, { ...state, sendTimes: [...times, now] });
      this.subject.reserveContact(ctx, proactive);
      mem.append({
        ...event,
        dedupe: "send:" + requestId + ":pending",
        kind: "message.send-attempt",
        status: "pending",
      });
    });
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
      mode: this.config.mode,
      globalPaused: this.config.globalPaused,
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
        .filter((c) =>
          c.disclosureRequest?.records.some((id) => !c.grants.has(id)),
        )
        .map((c) => ({
          token: c.token,
          agentId: c.agentId,
          conversation: c.conversation,
          reason: c.disclosureRequest.reason,
          records: c.disclosureRequest.records.filter(
            (id) => !c.grants.has(id),
          ),
          granted: [...c.grants],
        })),
    };
  }
  async close() {
    this.closed = true;
    clearInterval(this.ticker);
    await Promise.allSettled(this.config.agents.map((a) => this.cancel(a.id)));
    for (const t of this.transports.values()) t.close();
    await Promise.allSettled(
      [...this.backends.values()].map((b) => b.close?.()),
    );
    await this.learner.close();
    await Promise.allSettled([...this.jobs]);
    await this.lifecycle?.close();
  }
}
