import { QzoneApprovals } from "./qzone-approvals.mjs";
import { SubjectExecution } from "./subject-execution.mjs";
import { SocialRuntime } from "../home/social-runtime.mjs";
import { HOME_TOOLS } from "../home/policy.mjs";
import { HomeService } from "../home/service.mjs";
import {
  assertNoSocialDisclosure,
  socialSources,
  socialContextAllowed,
  assertSocialSend,
  trackSocial,
  assertRoomItemShareable,
} from "./social-protection.mjs";
import { contextProtection } from "./protected-mind.mjs";
import {
  peerQzoneSources,
  peerQzoneMarker,
  peerQzoneContext,
} from "./peer-qzone-protection.mjs";
import { ownsReactionTarget } from "./reactions.mjs";
import { GameHost, sensitiveGameMessage } from "../games/framework/host.mjs";
import { ProtectedWork, isWorkScope } from "./protected-work.mjs";
import { recallBoundary } from "./recall-boundary.mjs";
import { containsCredential } from "./secrets.mjs";
import { sessionReference, recordRetirementCause } from "./session-records.mjs";
import { isDeepStrictEqual } from "node:util";
import { DeliveryService } from "./delivery.mjs";
import { recoverDraftArchives } from "./draft-delivery.mjs";
import { QQDraftStore } from "../memory/qq-drafts.mjs";
import { inputScope } from "../memory/input-state.mjs";
import { safeToolFailure } from "../tools/errors.mjs";
import { TurnRunner } from "./turn-runner.mjs";
import { observeFamiliarity } from "./memory-recall.mjs";
import { SemanticRecall } from "./semantic-recall.mjs";
import { runtimeStatus } from "./runtime-status.mjs";
import { observeInput } from "./input-progress.mjs";
import { AppCursors } from "../apps/cursors.mjs";
import { Diagnostics } from "./diagnostics.mjs";
import { GeneratedImages } from "./generated-images.mjs";
import { resolveFunctionalAgent } from "./functional-agents.mjs";
import { FunctionalDelegation } from "./functional-delegation.mjs";
import { FUNCTIONAL_AGENT_RESULT } from "../tools/names.mjs";
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
import { SubjectInbox } from "./subject-inbox.mjs";
import { SubjectCoordinator } from "./subject.mjs";
import { CHAT_MIND_TOOLS, SUBJECT_TOOLS } from "../tools/mind.mjs";
import { BOARD_TOOLS } from "./board.mjs";
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
import { allowed, inSilence, isPrivateLikeGroup } from "./config.mjs";
import { normalizeEvent, OneBot } from "../transport/onebot.mjs";
import { BanterCoordinator } from "../../vendor/local-bridge/banter.mjs";
import { dispatchTool } from "../tools/index.mjs";
import { ConversationEngine } from "./conversations.mjs";
import { TaskScheduler } from "./scheduler.mjs";
import { Operations } from "./operations.mjs";
import { VoiceTranscription } from "./voice-transcription.mjs";
import { MaintenanceDrain } from "./maintenance.mjs";
import {
  isTimedSendTool,
  timedDeliveryFailure,
  timedStoppedSend,
} from "./message-timing-runtime.mjs";

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
    messageTiming = undefined,
  }) {
    Object.assign(this, {
      configStore,
      memory,
      backendFactory,
      transportFactory,
      clock,
      random,
      diagnostics,
      messageTiming,
    });
    this.transports = new Map();
    this.connecting = new Set();
    this.backends = new Map();
    this.backendConnections = new BackendConnections(this);
    this.connectionRecovery = new ConnectionRecovery(this);
    // Replaced by main.mjs when the console starts with `--live --resume`.
    this.autoResume = new AutoResume(this);
    this.running = new Map();
    this.subjectExecution = new SubjectExecution();
    this.pending = new Map();
    this.capabilities = new Map();
    this.faults = new Map();
    this.jobs = new Set();
    this.work = new Set();
    this.retiredResources = new Set();
    this.closed = false;
    this.configDrain = null;
    this.configChangesGroupAdmissionOnly = false;
    this.reconfiguringAgents = new Set();
    this.reconfiguringConnections = new Set();
    this.drafts = new QQDraftStore(memory, { clock: () => this.now() });
    this.delivery = new DeliveryService(this);
    this.sendChains = this.delivery.chains;
    this.maintenance = new MaintenanceDrain(this);
    this.turns = new TurnRunner(this);
    this.functionalDelegation = new FunctionalDelegation(this);
    this.semanticRecall = new SemanticRecall(this);
    this.conversations = new ConversationEngine(this);
    this.scheduler = new TaskScheduler(this);
    this.operations = new Operations(this);
    this.contexts = new ContextLifecycle(this);
    this.generatedImages = new GeneratedImages(this);
    this.subject = new SubjectCoordinator(this);
    this.subjectInbox = new SubjectInbox(this);
    this.transcripts = new VoiceTranscription(this);
    this.games = new GameHost(this);
    this.protectedWork = new ProtectedWork(this);
    this.protectedWork.recover();
    for (const a of this.config.agents) {
      const self = this.memory.bind(a.id).identity.initialize(a, this.now());
      this.contexts.upgradeInstructions(a, self);
    }
    this.home = new HomeService(this);
    this.homeSocialSources = {
      assertSend: assertSocialSend,
      trackSource: trackSocial,
      assertRoomItem: assertRoomItemShareable,
      sources: socialSources,
      allowed: socialContextAllowed,
    };
    this.socialSourceAllowed = socialContextAllowed;
    this.homeSocial = this.home.social;
    this.socialRuntime = new SocialRuntime(this);
    this.qzoneApprovals = new QzoneApprovals(this);
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
  // Constructing another service client is not a process restart. The owning
  // entry point runs this barrier before exposing APIs or starting dispatch.
  initializeRuntime() {
    if (this.runtimeInitialized) return { initialized: false };
    if (this.closed) throw Error("RUNTIME_CLOSING");
    if (this.homeSocial) this.homeSocial.store.interruptRuntime(randomUUID());
    try {
      recoverDraftArchives(this.memory, this.drafts);
    } catch (error) {
      this.diagnostics.report(error, { component: "runtime" });
    }
    this.runtimeInitialized = true;
    return { initialized: true };
  }
  startTimers() {
    if (this.closed || this.ticker) return;
    this.initializeRuntime();
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
    this.messageTiming?.sweep();
    try {
      this.games.tick();
      this.faults.delete("games");
    } catch (cause) {
      this.faults.set("games", "GAME_TICK_FAILED");
      this.diagnostics.report(Error("GAME_TICK_FAILED", { cause }), {
        component: "games",
      });
    }
    if (
      this.homeSocial?.maintain &&
      (!this.nextSocialMaintenanceAt ||
        this.now() >= this.nextSocialMaintenanceAt)
    ) {
      this.homeSocial.maintain();
      this.nextSocialMaintenanceAt = this.now() + 60000;
    }
    if (this.maintenance.active) {
      this.socialRuntime?.stop("maintenance");
      return;
    }
    if (this.homeSocial) this.socialRuntime.tick();
    if (!this.nextCursorCleanupAt || this.now() >= this.nextCursorCleanupAt) {
      new AppCursors(this.memory).cleanup(this.now());
      this.nextCursorCleanupAt = this.now() + 60000;
    }
    this.backendConnections.tick();
    this.connectionRecovery.tick();
    this.contexts.tick();
    this.subject.tick();
    this.conversations.tick();
    this.semanticRecall.tick();
    this.scheduler.tick();
    this.operations.expire();
  }
  makeContext(agentId, conversation) {
    if (this.closed) throw Error("RUNTIME_CLOSING");
    if (this.maintenance.active) throw Error("UPDATE_IN_PROGRESS");
    if (this.reconfiguringAgents.has(agentId)) throw Error("CONFIG_CONFLICT");
    if (this.backendConnections.blocked.has(agentId))
      throw Error("BACKEND_UNAVAILABLE");
    const a = this.agent(agentId),
      mem = this.memory.bind(agentId);
    if (
      isWorkScope(conversation) &&
      !this.protectedWork.active(agentId, conversation)
    )
      throw Error("PROTECTED_WORK_NOT_ACTIVE");
    const state = mem.state(conversation);
    const recallGeneration = state.recallRecovery?.generation || 0;
    const ctx = {
      token: randomBytes(32).toString("base64url"),
      agentId,
      conversation,
      functionalAgent: resolveFunctionalAgent(a, conversation),
      expires: Date.now() + a.behavior.turnTimeoutMs,
      subjectToolBudget: a.subject.maxToolCallsPerTurn,
      controller: new AbortController(),
      privateRead: new Set(mem.state(conversation).disclosureTaint || []),
      grants: new Set(),
      sendCount: 0,
      replyBatchSends: mem.state(conversation).replyBatchSends || 0,
      inputEpoch: randomUUID(),
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
      for (const marker of socialSources(this, ctx))
        ctx.privateRead.add(marker);
      for (const id of peerQzoneSources(this, ctx))
        ctx.privateRead.add(peerQzoneMarker(id));
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
  makeFunctionalContext(
    parent,
    {
      invocationId,
      profile,
      deadline,
      controller,
      assertCurrent,
      maxLookups,
      evidenceBeforeSeq,
    },
  ) {
    const a = this.assertActive(parent);
    const allowedTools = this.toolsFor(a, parent.conversation).filter(
      (name) =>
        profile.definition.tools.includes(name) &&
        (!parent.allowedTools || parent.allowedTools.includes(name)),
    );
    const ctx = {
      token: randomBytes(32).toString("base64url"),
      runtimeKind: "functional-agent",
      agentId: parent.agentId,
      conversation: parent.conversation,
      functionalAgent: profile,
      invocationId,
      controller,
      expires: deadline,
      inputEpoch: randomUUID(),
      allowedTools: [...allowedTools, FUNCTIONAL_AGENT_RESULT],
      privateRead: new Set(),
      grants: new Set(),
      maxLookups,
      evidenceBeforeSeq,
      lookups: 0,
      assertCurrent,
      requiresInputSubmission: true,
    };
    this.capabilities.set(ctx.token, ctx);
    return ctx;
  }
  closeFunctionalContext(ctx) {
    if (this.capabilities.get(ctx.token) === ctx)
      this.capabilities.delete(ctx.token);
  }
  callFunctionalTool(ctx, name, args) {
    return this.callTool(ctx, name, args, { deferInput: true });
  }
  validateFunctionalEvidence(ctx, evidenceIds) {
    this.assertActive(ctx);
    if (ctx.runtimeKind !== "functional-agent") throw Error("TOOL_DISABLED");
    const boundary = recallBoundary(this, ctx);
    for (const id of evidenceIds) {
      if (!ctx.privateRead.has(id)) throw Error("RECALL_SOURCE_NOT_ALLOWED");
      boundary.assertId(id);
    }
  }
  toolsForContext(agent, ctx) {
    if (ctx.runtimeKind !== "functional-agent")
      return this.toolsFor(agent, ctx.conversation);
    const current = this.toolsFor(agent, ctx.conversation);
    return ctx.allowedTools.filter(
      (name) => name === FUNCTIONAL_AGENT_RESULT || current.includes(name),
    );
  }
  withContext(...args) {
    return this.trackWork(this.runWithContext(...args));
  }
  async runWithContext(agentId, conversation, fn) {
    const ctx = this.makeContext(agentId, conversation);
    const done = Promise.withResolvers();
    ctx.done = done.promise;
    // Deterministic owner/scheduler control replies have their own invocation budget.
    ctx.internalDelivery = true;
    try {
      this.assertActive(ctx);
      return await fn(ctx);
    } finally {
      ctx.controller.abort();
      this.capabilities.delete(ctx.token);
      done.resolve();
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
    if (conversation?.startsWith("@social:"))
      return this.config.homeSocial?.enabled
        ? this.socialRuntime
            .tools({ conversation })
            .filter((n) => toolAvailable(a, n, conversation))
        : [];
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
                  n.startsWith("project") ||
                  n.startsWith("memory_correction") ||
                  [
                    "framework_read",
                    "deployment_info",
                    "diagnostics_read",
                  ].includes(n) ||
                  n.startsWith("subject_") ||
                  a.tools.includes(n),
              ),
              ...a.subject.readTools.filter((n) => a.tools.includes(n)),
              ...BOARD_TOOLS,
            ]),
          ]
        : [
            ...new Set([
              ...a.tools.filter(
                (n) => n !== "self_update" && n !== "self_review",
              ),
              ...CHAT_MIND_TOOLS,
              ...BOARD_TOOLS,
            ]),
          ];
    if (conversation === SUBJECT && this.config.homeSocial?.enabled)
      selected.push("home_social_capabilities", "home_social_process");
    const imageGeneration = backendCapabilities(
      this.config.backends.find((b) => b.id === a.backendId)?.type,
    ).imageGeneration;
    if (
      conversation !== SUBJECT &&
      selected.includes("qq_send") &&
      imageGeneration
    )
      selected.push("generated_image_list");
    // Reading back one's own library goes with listing it: enabling files
    // grants both, and configurations saved before file_read existed get it
    // without an edit.
    if (selected.includes("file_list")) selected.push("file_read");
    // Revising writes a new text file under the same create permission and
    // keeps the old one, so it goes with file_create, including older configs.
    if (selected.includes("file_create")) selected.push("file_revise");
    if (toolAvailable(a, "qq_draft", conversation)) selected.push("qq_draft");
    if (conversation !== SUBJECT && selected.includes("qq_send"))
      selected.push("qq_delivery_status");
    selected.push(...HOME_TOOLS);
    const configured = resolveFunctionalAgent(a, conversation)?.definition
      .tools;
    return [...new Set(selected)].filter(
      (name) =>
        (!configured || configured.includes(name)) &&
        toolAvailable(a, name, conversation, this.config) &&
        (!name.startsWith("game_") || this.config.games.enabled) &&
        // Every chat and free-time session may use the board once it is on;
        // like mind tools it does not depend on each role's saved list.
        (!name.startsWith("board_") || this.config.board.enabled) &&
        (name !== "generated_image_list" || imageGeneration),
    );
  }
  // Every gate that keeps an agent from speaking. Without a conversation, only
  // agent-wide gates are listed (for the console); writable() always passes one.
  blockers(a, conversation, ctx = null) {
    const codes = [];
    if (this.closed) codes.push("RUNTIME_CLOSING");
    if (this.maintenance.active && !this.maintenance.allows(ctx))
      codes.push("UPDATE_IN_PROGRESS");
    if (
      this.reconfiguringAgents.has(a.id) &&
      !this.configDrain?.contexts.has(ctx)
    )
      codes.push("RECONFIGURING");
    if (
      this.backendConnections.blocked.has(a.id) &&
      !this.backendConnections.drainingContexts.has(ctx)
    )
      codes.push("BACKEND_UNAVAILABLE");
    if (conversation === SUBJECT) {
      if (!codes.length && !this.subject.internalAllowed(a))
        codes.push("SUBJECT_NOT_ALLOWED");
      return codes;
    }
    if (
      ctx?.runtimeKind === "subject-social" &&
      conversation?.startsWith("@social:")
    ) {
      if (this.config.mode !== "live") codes.push("ISOLATED_MODE");
      if (this.config.globalPaused) codes.push("GLOBAL_PAUSED");
      if (a.paused) codes.push("AGENT_PAUSED");
      if (!this.config.homeSocial?.enabled) codes.push("SOCIAL_DISABLED");
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
    if (!allowed(a, conversation, this.config)) codes.push("NOT_ALLOWED");
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
    ctx.assertCurrent?.();
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
  rotateCapability(ctx) {
    this.assertActive(ctx);
    this.capabilities.delete(ctx.token);
    (ctx.retiredCapabilities ??= []).push(ctx.token);
    ctx.token = randomBytes(32).toString("base64url");
    this.capabilities.set(ctx.token, ctx);
    return ctx.token;
  }
  containsCapability(ctx, text) {
    return (
      text.includes(ctx.token) ||
      ctx.retiredCapabilities?.some((token) => text.includes(token))
    );
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
        (this.reconfiguringConnections.has(id) &&
          !this.configDrain?.connectionIds.has(id))
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
      await this.cancel(a.id, "connection-disconnect");
  }
  abortContext(ctx, source, changes = []) {
    try {
      if (!ctx.controller.signal.aborted)
        recordRetirementCause(this.memory.bind(ctx.agentId), ctx.turnId, {
          source,
          changes,
        });
    } catch (cause) {
      // Audit storage failure must not prevent revoking an active capability.
      this.diagnostics.report(
        Error("SESSION_RETIREMENT_DETAILS_FAILED", { cause }),
        { component: "runtime" },
      );
    }
    ctx.controller.abort();
  }
  async cancel(agentId, source = "administrator-cancel") {
    for (const ctx of this.running.values())
      if (ctx.agentId === agentId) this.abortContext(ctx, source);
    for (const [token, ctx] of this.capabilities)
      if (ctx.agentId === agentId) {
        this.abortContext(ctx, source);
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
  async cancelConversation(
    agentId,
    conversation,
    source = "conversation-pause",
    changes = [],
  ) {
    this.games.worker.cancel(agentId, conversation);
    const key = agentId + "|" + conversation;
    for (const [token, ctx] of this.capabilities)
      if (ctx.agentId === agentId && ctx.conversation === conversation) {
        this.abortContext(ctx, source, changes);
        this.capabilities.delete(token);
      }
    this.pending.delete(key);
    this.transcripts.cancel(agentId, conversation);
    this.conversations.notify(agentId, conversation);
    const ctx = this.running.get(key);
    if (ctx) {
      this.abortContext(ctx, source, changes);
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
    if (paused)
      this.configDrain?.controller.abort(Error("CONFIG_DRAIN_CANCELLED"));
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
      this.configDrain?.controller.abort(Error("CONFIG_DRAIN_CANCELLED"));
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
    const receivedAt = this.messageTiming?.clock();
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
      if (!allowed(a, e.conversation, this.config)) continue;
      const mem = this.memory.bind(a.id);
      assertMessageAccount(mem, connectionId, c.accountId);
      if (e.kind === "notice.reaction" && !ownsReactionTarget(mem, c, e))
        continue;
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
          connectionId,
          accountId: c.accountId,
          namespace: c.messageIdNamespace || "onebot",
          conversation: e.conversation,
          segments: e.segments,
          text: e.segments
            .filter((s) => s.type === "text")
            .map((s) => s.data?.text || "")
            .join(""),
          messageId: e.messageId,
        });
      const key = e.messageId
        ? `${connectionId}:${c.messageIdNamespace || "onebot"}:${e.conversation}:${e.kind}:${e.messageId}`
        : `${connectionId}:${e.kind}:${digest(raw)}`;
      const redactGame = sensitiveGameMessage(e.body);
      const redactConfirmation =
        e.conversation.startsWith("private:") &&
        (a.ownerIds.includes(e.senderId) || e.senderId === c.accountId) &&
        /确认\s+\d{6}/.test(e.body);
      const archived = mem.append({
        ...e,
        ...(redactConfirmation || redactGame
          ? {
              body: redactGame
                ? "[游戏身份确认或邀请；凭据不进入记忆]"
                : "[管理员确认；验证码不进入记忆]",
            }
          : {}),
        connectionId,
        dedupe: key,
        payload:
          redactConfirmation || redactGame
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
                ...(e.reaction ? { reaction: e.reaction } : {}),
                timeKnown: e.timeKnown,
              },
      });
      if (e.kind !== "notice.reaction") mem.person(e.senderId, e.senderName);
      if (!archived.inserted) {
        results.push({ agentId: a.id, duplicate: true });
        continue;
      }
      // Reactions remain readable observations. They do not advance new-message
      // watermarks, wake/quiet-window waiters, activity clocks or reply authority.
      if (e.kind === "notice.reaction") continue;
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
      if (
        e.kind === "message.received" &&
        !ownEcho &&
        e.direction === "in" &&
        e.senderId !== c.accountId &&
        !redactGame &&
        !redactConfirmation
      ) {
        try {
          observeFamiliarity(this, a, e.conversation, archived.id);
        } catch (cause) {
          this.diagnostics.report(Error("EVENT_PROCESSING_FAILED", { cause }), {
            component: "runtime",
            agentId: a.id,
            conversation: e.conversation,
          });
        }
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
      if (
        e.kind === "message.received" &&
        (await this.games.command(a, e, archived))
      )
        continue;
      // Received voice is transcribed beside intake, never awaited here.
      const voice = this.transcripts.observe(a, e, archived);
      const peer = this.config.connections.some(
        (c) => c.accountId === e.senderId,
      );
      if (
        e.conversation.startsWith("group:") &&
        !isPrivateLikeGroup(this.config, e.conversation)
      ) {
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
      const reason = this.conversations.reason(a, e, c.accountId, archived),
        addressed = this.conversations.addressed(a, e, c.accountId);
      if (voice) voice.reason = reason;
      const inboundAt =
        redactConfirmation || redactGame ? undefined : receivedAt;
      if (!reason) {
        this.conversations.extend(a.id, e.conversation, e.senderId, inboundAt);
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
          direct: this.conversations.direct(a, e, c.accountId, archived),
          inboundAt,
        });
        continue;
      }
      const wake = this.conversations.request(a.id, e.conversation, reason, {
        allowRestInterrupt: !redactConfirmation && !redactGame,
        seq: archived.seq,
        senderId: e.senderId,
        addressed,
        direct: this.conversations.direct(a, e, c.accountId, archived),
        inboundAt,
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
    if (conversation !== SUBJECT && !allowed(a, conversation, this.config))
      throw Error("INVALID_CONVERSATION");
    this.revokeCapabilities(agentId, conversation, "administrator-reset");
    const ctx = this.running.get(agentId + "|" + conversation);
    if (ctx) {
      this.abortContext(ctx, "administrator-reset");
      await ctx.done;
    }
    await this.sendChains.get(a.connectionId)?.catch(() => {});
    this.contexts.retire(
      agentId,
      conversation,
      "administrator-reset",
      undefined,
      { source: "administrator-reset" },
    );
  }
  async recoverProtectedConversation(agentId, conversation) {
    const a = this.agent(agentId),
      m = this.memory.bind(agentId);
    if (
      !allowed(a, conversation, this.config) ||
      githubPrivateContext(a, conversation)
    )
      throw Error("INVALID_CONVERSATION");
    const before = m.state(conversation);
    if (!before.paused) throw Error("RECOVERY_REQUIRES_PAUSED_CONVERSATION");
    const blocked = (before.disclosureTaint || []).some((id) =>
      ["operations", "private-repository", "peer-qzone"].includes(
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
  revokeCapabilities(agentId, conversation, source = "lifecycle") {
    for (const [token, active] of this.capabilities)
      if (active.agentId === agentId && active.conversation === conversation) {
        this.abortContext(active, source);
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
  stageToolInput(ctx, result, commit, records) {
    const expected = JSON.parse(JSON.stringify(result));
    const allowed = () => {
      const visible = recallBoundary(this, ctx).rows(records);
      return (
        visible.length === records.length &&
        visible.every((row, index) => row === records[index])
      );
    };
    this.stageToolOutput(ctx, result, [
      {
        value: result,
        expected,
        current: () => {
          if (!allowed()) throw Error("RECALL_SOURCE_NOT_ALLOWED");
          return true;
        },
        commit: commit && (() => allowed() && commit()),
      },
    ]);
  }
  stageToolOutput(ctx, result, variants) {
    (ctx.stagedToolOutputs ??= new WeakMap()).set(result, {
      epoch: ctx.inputEpoch,
      scope: /^(group|private):/.test(ctx.conversation)
        ? inputScope(this, ctx)
        : null,
      variants,
    });
  }
  activeOutputEpoch(ctx, epoch, scope) {
    return (
      this.capabilities.get(ctx.token) === ctx &&
      !ctx.controller.signal.aborted &&
      ctx.expires > Date.now() &&
      ctx.inputEpoch === epoch &&
      (!scope || inputScope(this, ctx) === scope)
    );
  }
  async finalizeToolOutput(ctx, original, { encode, maxBytes = Infinity }) {
    const plan = ctx.stagedToolOutputs?.get(original);
    if (!plan) {
      if (ctx.runtimeKind === "functional-agent") this.assertActive(ctx);
      const { wire } = await encode(original);
      if (ctx.runtimeKind === "functional-agent") this.assertActive(ctx);
      return { wire };
    }
    ctx.stagedToolOutputs.delete(original);
    const stale = () => !this.activeOutputEpoch(ctx, plan.epoch, plan.scope);
    if (stale()) throw Error("INPUT_EPOCH_CHANGED");

    for (const variant of plan.variants) {
      const { matches, commit, current } = variant;
      if (current && !current()) continue;
      const value = variant.render ? variant.render() : variant.value;
      const expected = variant.render
        ? JSON.parse(JSON.stringify(value))
        : variant.expected;
      const { wire, text } = await encode(value);
      if (stale()) throw Error("INPUT_EPOCH_CHANGED");
      const bytes = Buffer.byteLength(
        typeof wire === "string" ? wire : JSON.stringify(wire),
      );
      if (bytes > maxBytes || (current && !current())) continue;
      if (!expected && !matches) return { wire };
      let actual;
      try {
        actual = JSON.parse(text);
      } catch {
        // Only a structured, complete tool result can prove presentation.
      }
      if (!(matches ? matches(actual) : isDeepStrictEqual(expected, actual))) {
        if (plan.variants.length === 1 && value === original) return { wire };
        continue;
      }
      if (!commit) return { wire };
      const receipt = randomUUID();
      let pending = ctx.toolOutputReceipts;
      if (pending?.epoch !== plan.epoch)
        pending = ctx.toolOutputReceipts = {
          epoch: plan.epoch,
          entries: new Map(),
        };
      pending.entries.set(receipt, {
        digest: createHash("sha256").update(text).digest("hex"),
        scope: plan.scope,
        commit,
      });
      return { wire, receipt };
    }

    throw Error("TOOL_OUTPUT_INCOMPLETE");
  }
  commitToolOutput(ctx, receipt, observedText) {
    if (!receipt || typeof observedText !== "string") return false;
    return this.commitToolOutputDigest(
      ctx,
      receipt,
      createHash("sha256").update(observedText).digest("hex"),
    );
  }
  commitToolOutputDigest(ctx, receipt, digest) {
    const pending = ctx.toolOutputReceipts;
    const entry = pending?.entries.get(receipt);
    if (!entry) return false;
    pending.entries.delete(receipt);
    try {
      if (
        entry.digest !== digest ||
        !this.activeOutputEpoch(ctx, pending.epoch, entry.scope)
      )
        return false;
      return entry.commit() !== false;
    } catch (error) {
      this.contexts.resetInputEvidence(ctx);
      delete ctx.stagedOpening;
      this.diagnostics.report(
        Error("INPUT_PRESENTATION_COMMIT_FAILED", { cause: error }),
        {
          component: "runtime",
          agentId: ctx.agentId,
          conversation: ctx.conversation,
        },
      );
      return false;
    }
  }
  async directToolOutput(ctx, result) {
    if (!ctx.stagedToolOutputs?.has(result)) return result;
    const { wire, receipt } = await this.finalizeToolOutput(ctx, result, {
      encode: (value) => {
        const text = JSON.stringify(
          value instanceof Error ? safeToolFailure(value) : value,
        );
        return { wire: text, text };
      },
    });
    if (receipt) this.commitToolOutput(ctx, receipt, wire);
    const output = JSON.parse(wire);
    if (!(result instanceof Error)) return output;
    result.inputReview = output.inputReview;
    return result;
  }
  callTool(...args) {
    return this.trackWork(this.runTool(...args));
  }
  // Records name, outcome and duration of every call (never arguments or
  // results), so a turn's actual activity can be measured afterwards.
  async runTool(ctx, name, args = {}, { deferInput = false } = {}) {
    const epoch = ctx.inputEpoch;
    const startedAt = Date.now(),
      calls = (ctx.toolCalls ||= []);
    const tracedSend =
      ctx.messageTimingId !== undefined && isTimedSendTool(name, args);
    if (tracedSend)
      this.messageTiming.mark(ctx.messageTimingId, "sendRequested");
    try {
      // Reserved before any await, so concurrent calls share one budget.
      if (
        ctx.runtimeKind === "functional-agent" &&
        name !== FUNCTIONAL_AGENT_RESULT
      ) {
        this.assertActive(ctx);
        if (!this.toolsForContext(this.agent(ctx.agentId), ctx).includes(name))
          throw Error("TOOL_DISABLED");
        if (ctx.lookups >= ctx.maxLookups)
          throw Error("FUNCTIONAL_AGENT_TOOL_BUDGET");
        ctx.lookups++;
      }
      if (ctx.conversation === SUBJECT && name !== "subject_log") {
        const limit = ctx.subjectToolBudget;
        if ((ctx.subjectToolReservations || 0) >= limit)
          throw Error("SUBJECT_TOOL_BUDGET");
        ctx.subjectToolReservations = (ctx.subjectToolReservations || 0) + 1;
      }
      const result = await this.executeTool(ctx, name, args);
      if (ctx.runtimeKind === "functional-agent") this.assertActive(ctx);
      if (ctx.inputEpoch !== epoch) {
        ctx.stagedToolOutputs?.delete(result);
        throw Error("INPUT_EPOCH_CHANGED");
      }
      if (tracedSend && (result?.status === "stopped" || result?.preparation)) {
        const reason = timedStoppedSend(result, ctx.controller.signal.aborted);
        ctx.messageTimingToolOutcome = reason;
        this.messageTiming.stop(ctx.messageTimingId, reason);
      }
      if (calls.length < 50)
        calls.push({ name, ok: true, ms: Date.now() - startedAt });
      return deferInput ? result : await this.directToolOutput(ctx, result);
    } catch (error) {
      if (ctx.inputEpoch !== epoch)
        throw Error("INPUT_EPOCH_CHANGED", { cause: error });
      if (!deferInput) await this.directToolOutput(ctx, error);
      if (tracedSend)
        ctx.messageTimingToolOutcome = timedDeliveryFailure(error);
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
    if (ctx.runtimeKind === "subject-social")
      this.socialRuntime.assertToolAllowed(ctx, name);
    for (const repo of privateGithubSources(ctx, this))
      ctx.privateRead.add(githubMarker(repo));
    for (const marker of socialSources(this, ctx)) ctx.privateRead.add(marker);
    for (const id of peerQzoneSources(this, ctx))
      ctx.privateRead.add(peerQzoneMarker(id));
    ctx.persistTaint?.();
    const scoped =
      ctx.runtimeKind === "functional-agent" ||
      ctx.functionalAgent?.definition.tools;
    const current = scoped ? this.toolsForContext(a, ctx) : null;
    if (
      !(
        ctx.allowedTools ||
        current ||
        this.toolsFor(a, ctx.conversation)
      ).includes(name) ||
      (current
        ? !current.includes(name)
        : !toolAvailable(a, name, ctx.conversation, this.config))
    )
      throw Error("TOOL_DISABLED");
    let result = await dispatchTool(this, ctx, name, args, (validated) => {
      const boundary = recallBoundary(this, ctx);
      for (const id of [
        validated.id,
        validated.eventId,
        validated.recordId,
        validated.aroundId,
        ...(validated.eventIds || []),
        ...(validated.evidence || []),
        ...(validated.evidenceIds || []),
        ...(validated.counterEvidence || []),
      ].filter((id) => typeof id === "string"))
        boundary.assertId(id);
      for (const [id, library] of [
        // Deletion checks the live metadata under the file lock. Its own
        // tombstone must also be reachable to finish an interrupted delete.
        [name === "file_delete" ? undefined : validated.fileId, this.files],
        [validated.mediaId, this.media],
        [validated.audioId || validated.audioInput?.audioId, this.voices],
      ])
        if (id && library) boundary.assert(library.metadata(ctx.agentId, id));
    });
    if (this.protectedWork.context(ctx) && name !== "protected_work_submit")
      this.protectedWork.record(
        ctx,
        "tool",
        JSON.stringify({
          name,
          result:
            name === "room_scene_view"
              ? {
                  notice:
                    "受控场景观察仅交付当前回合，不在工具工作日志保留正文与图片。",
                }
              : result,
        }).slice(0, 24000),
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
            ...contextProtection(this, ctx),
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
    assertNoSocialDisclosure(this, ctx);
    if (this.protectedWork?.context(ctx))
      throw Error("PROTECTED_WORK_OUTBOUND_DENIED");
    for (const repo of privateGithubSources(ctx, this))
      ctx.privateRead.add(githubMarker(repo));
    for (const marker of socialSources(this, ctx)) ctx.privateRead.add(marker);
    for (const id of peerQzoneSources(this, ctx))
      ctx.privateRead.add(peerQzoneMarker(id));
    ctx.persistTaint?.();
    const ids = [...ctx.privateRead].filter(
      (id) =>
        !ctx.grants.has(id) &&
        (external ||
          /^(operations|operations-result):/.test(id) ||
          (id.startsWith("peer-qzone:") &&
            !peerQzoneContext([id.slice(11)], ctx.conversation)) ||
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
    if (this.containsCapability(ctx, text) || containsCredential(text))
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
    this.configDrain?.controller.abort(Error("RUNTIME_CLOSING"));
    this.updates?.close();
    clearInterval(this.ticker);
    this.autoResume.cancel("stopped");
    this.semanticRecall.close();
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
      this.abortContext(ctx, "service-stop");
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
    await cleanup(() => this.games.close());
    this.stopped = true;
    return { ok: failures === 0, failures };
  }
}
import { AutoResume } from "./auto-resume.mjs";
import {
  assertMessageAccount,
  confirmedMessage,
} from "../memory/message-ids.mjs";
