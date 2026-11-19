import { DESKTOP_CONVERSATION } from "../home/desktop-decision.mjs";
import { needsSubjectReview } from "./subject-inbox-sources.mjs";
import { refreshAgentRhythm, rhythmStatus } from "./rhythm.mjs";
import { roleRest, settleRoleRest, subjectInboxEnabled } from "./role-rest.mjs";
import { randomUUID } from "node:crypto";
import { allowed, inSilence } from "./config.mjs";
import { SUBJECT } from "./lifecycle.mjs";
import { freezeEvidence } from "../memory/evidence.mjs";
import { mergeProtection } from "../memory/protection.mjs";
import { contextProtection, trackMindRecords } from "./protected-mind.mjs";
import { recallBoundary } from "./recall-boundary.mjs";
import { liveInput } from "./live-input.mjs";
const terminal = new Set([
  "completed",
  "cancelled",
  "expired",
  "failed",
  "unknown",
]);
const checksWithinDay = (state, at) =>
  (state.checks || []).filter((t) => t > at - 86400000);
const norm = (s) => s.trim().toLocaleLowerCase().replace(/\s+/g, " ");
export class SubjectCoordinator {
  constructor(runtime) {
    this.runtime = runtime;
    for (const a of runtime.config.agents) {
      const m = runtime.memory.bind(a.id);
      const state = m.state(SUBJECT);
      if (state.activityCursor === undefined) {
        const pending = (state.opportunities || [])
          .map(
            (o) =>
              m.db
                .prepare("SELECT seq FROM events WHERE agent_id=? AND id=?")
                .get(a.id, o.id)?.seq,
          )
          .filter(Number.isSafeInteger);
        const latest =
          m.db
            .prepare("SELECT MAX(seq) AS seq FROM events WHERE agent_id=?")
            .get(a.id).seq || 0;
        m.setState(SUBJECT, {
          ...state,
          activityCursor: pending.length ? Math.min(...pending) - 1 : latest,
          opportunities: undefined,
        });
      }
      m.store.transaction(() => {
        const contacts = [];
        for (const original of m.identity.list("intentions")) {
          let i = original;
          if (!Number.isSafeInteger(i.createdAfterSeq))
            i = this.save(a.id, {
              ...i,
              createdAfterSeq: Number.isSafeInteger(i.handoffSeq)
                ? i.handoffSeq
                : this.incomingCeiling(a.id, i.target),
              creationBaselineOrigin: "legacy-recovery",
            });
          const delivery = m.delivery("intent:" + i.id);
          if (delivery && !i.reminder) {
            const at =
              i.contactChargedAt ??
              (Date.parse(delivery.created_at) || runtime.now());
            i = this.save(a.id, { ...i, contactChargedAt: at });
            contacts.push(at);
            const target = m.state(i.target);
            m.setState(i.target, {
              ...target,
              proactiveCooldownUntil: Math.max(
                target.proactiveCooldownUntil || 0,
                at +
                  (i.expectsResponse
                    ? a.subject.unansweredCooldownMs
                    : a.subject.contactCooldownMs),
              ),
              replyCheckAt:
                Math.max(
                  target.proactiveCooldownUntil || 0,
                  at +
                    (i.expectsResponse
                      ? a.subject.unansweredCooldownMs
                      : a.subject.contactCooldownMs),
                ) > runtime.now()
                  ? null
                  : target.replyCheckAt,
            });
          }
          if (["handedoff", "selected"].includes(i.status)) {
            this.transition(
              a.id,
              i,
              delivery
                ? delivery.status === "sent"
                  ? i.expectsResponse
                    ? "awaiting-response"
                    : "completed"
                  : delivery.status === "failed"
                    ? "failed"
                    : "unknown"
                : "waiting",
              "process-recovery",
              {
                eligibleAt:
                  runtime.now() +
                  (i.reminder ? 0 : a.subject.contactCooldownMs),
                ...(delivery
                  ? {
                      deliveryId: delivery.request_id,
                      sentAt:
                        delivery.status === "sent"
                          ? Date.parse(delivery.updated_at)
                          : null,
                    }
                  : {}),
              },
            );
          }
        }
        const subject = m.state(SUBJECT);
        m.setState(SUBJECT, {
          ...subject,
          contacts: contacts.filter((t) => t > runtime.now() - 86400000),
          lastContactAt: Math.max(subject.lastContactAt || 0, ...contacts),
        });
      });
    }
  }
  memory(id) {
    return this.runtime.memory.bind(id);
  }
  incomingCeiling(id, conversation) {
    return (
      this.memory(id)
        .db.prepare(
          "SELECT MAX(seq) AS seq FROM events WHERE agent_id=? AND conversation=? AND direction='in'",
        )
        .get(id, conversation).seq || 0
    );
  }
  contactOpportunity(a, target, item) {
    const r = this.runtime,
      m = this.memory(a.id),
      s = m.state(SUBJECT),
      now = r.now();
    return (
      this.internalAllowed(a) &&
      !roleRest(r, a) &&
      !r.subjectInbox.focus(a) &&
      rhythmStatus(r, a, true).state !== "sleeping" &&
      this.targetAllowed(a, target) &&
      r.writable(a, target) &&
      !!r.transports.get(a.connectionId)?.connected &&
      (item?.reminder
        ? item.reminder.wakeStartedAt != null &&
          !r.subjectExecution.busy(a.id) &&
          this.reminderAllowed(a, item)
        : (m.state(target).proactiveCooldownUntil || 0) <= now &&
          (s.lastContactAt || 0) + a.subject.contactCooldownMs <= now &&
          (s.contacts || []).filter((t) => t > now - 86400000).length <
            a.subject.maxContactsPerDay)
    );
  }
  save(id, value) {
    return this.memory(id).identity.put("intentions", value);
  }
  enabled(a) {
    return a.subject.enabled || a.behavior.proactive.enabled;
  }
  checkStatus(a) {
    const r = this.runtime,
      now = r.now(),
      s = this.memory(a.id).state(SUBJECT);
    const checks = checksWithinDay(s, now).sort((a, b) => a - b);
    const limit = a.subject.maxChecksPerDay;
    // If the limit was lowered, more than one old check may need to expire.
    const budgetReadyAt =
      checks.length >= limit ? checks[checks.length - limit] + 86400000 : now;
    const nextEligibleAt = Math.max(
      s.nextCheckAt || now + a.subject.intervalMs,
      budgetReadyAt,
    );
    let state;
    if (r.closed || r.config.mode !== "live") state = "inactive";
    else if (!this.enabled(a)) state = "disabled";
    else if (r.config.globalPaused || a.paused) state = "paused";
    else if (
      !a.subject.offlineReview &&
      !r.transports.get(a.connectionId)?.connected
    )
      state = "offline";
    else if (!a.subject.reviewInSilence && inSilence(a, r.clock()))
      state = "silenced";
    else if (r.backendConnections.blocked.has(a.id)) state = "recovering";
    else if (r.running.has(a.id + "|" + SUBJECT)) state = "running";
    else if (roleRest(r, a) || rhythmStatus(r, a).state === "sleeping")
      state = "sleeping";
    else if (checks.length >= limit) state = "budget-exhausted";
    else state = nextEligibleAt > now ? "waiting" : "due";
    return {
      state,
      used: checks.length,
      limit,
      remaining: Math.max(0, limit - checks.length),
      nextEligibleAt: ["budget-exhausted", "waiting", "due"].includes(state)
        ? nextEligibleAt
        : null,
    };
  }
  scheduleNextWake(ctx, { minutes, note }) {
    const r = this.runtime,
      a = r.assertActive(ctx);
    if (ctx.conversation !== SUBJECT) throw Error("TOOL_DISABLED");
    r.assertSafeOutput(ctx, note);
    const m = this.memory(a.id),
      state = m.state(SUBJECT),
      nextCheckAt = r.now() + minutes * 60000;
    if (checksWithinDay(state, nextCheckAt).length >= a.subject.maxChecksPerDay)
      throw Error("SUBJECT_CHECK_BUDGET");
    m.setState(SUBJECT, { ...state, nextCheckAt, nextCheckNote: note });
    return { nextCheckAt };
  }
  beginOpportunity(a) {
    const m = this.memory(a.id),
      state = m.state(SUBJECT),
      now = this.runtime.now(),
      checks = checksWithinDay(state, now);
    if (
      !state.nextCheckAt ||
      state.nextCheckAt > now ||
      checks.length >= a.subject.maxChecksPerDay ||
      roleRest(this.runtime, a) ||
      rhythmStatus(this.runtime, a, true).state === "sleeping"
    )
      return null;
    const { nextCheckNote, ...remaining } = state;
    m.setState(SUBJECT, {
      ...remaining,
      nextCheckAt: now + a.subject.intervalMs,
      checks: [...checks, now],
      lastOpportunityAt: now,
    });
    return { nextCheckNote };
  }
  internalAllowed(a) {
    const r = this.runtime;
    return (
      !r.closed &&
      r.config.mode === "live" &&
      !r.config.globalPaused &&
      !a.paused &&
      this.enabled(a) &&
      (a.subject.offlineReview ||
        r.transports.get(a.connectionId)?.connected) &&
      (a.subject.reviewInSilence || !inSilence(a, r.clock()))
    );
  }
  targetAllowed(a, target) {
    if (!allowed(a, target, this.runtime.config)) return false;
    const [kind, id] = target.split(":");
    const peers = this.runtime.config.connections
      .filter((c) => c.id !== a.connectionId)
      .map((c) => c.accountId);
    return kind === "group"
      ? a.subject.groups.includes(id)
      : a.subject.users.includes(id) ||
          (a.subject.owners && a.ownerIds.includes(id)) ||
          (a.subject.peers && peers.includes(id));
  }
  // Who free time may reach, labelled so the model knows who each target is.
  reachableTargets(a) {
    const c = this.runtime.config,
      peers = c.agents
        .filter((p) => p.id !== a.id)
        .map((p) => ({
          name: p.name,
          accountId: c.connections.find((x) => x.id === p.connectionId)
            ?.accountId,
        }))
        .filter((p) => p.accountId);
    const seen = new Set();
    return [
      ...(a.subject.owners ? a.ownerIds : []).map((id) => ({
        target: "private:" + id,
        who: "owner",
      })),
      ...(a.subject.peers ? peers : []).map((p) => ({
        target: "private:" + p.accountId,
        who: "peer",
        name: p.name,
      })),
      ...a.subject.users.map((id) => ({
        target: "private:" + id,
        who: "user",
      })),
      ...a.subject.groups.map((id) => ({
        target: "group:" + id,
        who: "group",
      })),
    ].filter(
      (x) =>
        !seen.has(x.target) &&
        seen.add(x.target) &&
        this.targetAllowed(a, x.target),
    );
  }
  transition(agentId, item, status, reason, extra = {}) {
    return this.save(agentId, {
      ...item,
      ...extra,
      status,
      revision: item.revision + 1,
      history: [...item.history, { status, reason, at: this.runtime.now() }],
    });
  }
  reminderSource(a, target, eventId) {
    const r = this.runtime;
    const row = liveInput(r, a.id, target, eventId);
    return row &&
      a.ownerIds.includes(row.sender_id) &&
      row.sender_id !== r.connection(a.connectionId).accountId &&
      !JSON.parse(row.payload).redacted
      ? row
      : null;
  }
  reminderAllowed(a, item, ctx) {
    const r = this.runtime;
    return (
      subjectInboxEnabled(a) &&
      this.canAutoDisclose(a, item) &&
      !roleRest(r, a) &&
      rhythmStatus(r, a, true).state !== "sleeping" &&
      this.targetAllowed(a, item.target) &&
      r.writable(a, item.target, ctx) &&
      !!this.reminderSource(a, item.target, item.reminder.eventId)
    );
  }
  approveReminder(ctx, item) {
    const r = this.runtime,
      a = r.agent(ctx.agentId),
      m = this.memory(a.id),
      now = r.now();
    const { dueAt, expiresAt } = item.reminder;
    const { eventId, note } = item.proposal;
    if (expiresAt <= now) throw Error("SUBJECT_REMINDER_EXPIRED");
    if (!this.reminderSource(a, item.source, eventId))
      throw Error("SUBJECT_REMINDER_SOURCE_DENIED");
    const reminders = m.identity.list("intentions").filter((i) => i.reminder);
    if (reminders.some((i) => i.reminder.eventId === eventId))
      throw Error("SUBJECT_REMINDER_ALREADY_PLANNED");
    if (reminders.some((i) => !terminal.has(i.status) && i.expiresAt > now))
      throw Error("SUBJECT_REMINDER_PENDING");
    if (
      checksWithinDay(m.state(SUBJECT), Math.max(dueAt, now)).length >=
      a.subject.maxChecksPerDay
    )
      throw Error("SUBJECT_CHECK_BUDGET");
    return this.create(
      ctx,
      {
        target: item.source,
        topic: "管理员托付的提醒",
        reason: note,
        background:
          "这是已批准的定时提醒。结合原始托付，在本会话送达一次简短提醒。",
        evidence: [eventId],
        eligibleAt: dueAt,
        expiresAt,
        expectsResponse: false,
      },
      { eventId, dueAt },
    );
  }
  beginReminder(a, id) {
    const m = this.memory(a.id),
      item = m.identity.get("intentions", id),
      now = this.runtime.now(),
      state = m.state(SUBJECT),
      checks = checksWithinDay(state, now);
    if (
      !item?.reminder ||
      item.status !== "waiting" ||
      item.reminder.wakeStartedAt != null ||
      item.eligibleAt > now ||
      item.expiresAt <= now ||
      checks.length >= a.subject.maxChecksPerDay ||
      !this.reminderAllowed(a, item)
    )
      return null;
    m.store.transaction(() => {
      this.save(a.id, {
        ...item,
        reminder: { ...item.reminder, wakeStartedAt: now },
      });
      m.setState(SUBJECT, { ...state, checks: [...checks, now] });
    });
    return {
      target: item.target,
      note: item.reason,
      eventId: item.reminder.eventId,
      instruction:
        "管理员托付的提醒已到期，框架会把已批准的提醒交回来源 QQ 会话投递。",
    };
  }
  create(ctx, args, reminder) {
    const r = this.runtime,
      a = r.agent(ctx.agentId),
      m = this.memory(a.id),
      now = r.now();
    if (!this.targetAllowed(a, args.target))
      throw Error("PROACTIVE_TARGET_NOT_ENABLED");
    const proof = freezeEvidence(m, args.evidence || [], now, {
      allowProtected: true,
    });
    if (
      args.expiresAt <= now ||
      args.expiresAt > now + 7 * 86400000 ||
      (args.eligibleAt || now) >= args.expiresAt
    )
      throw Error("INVALID_INTENT_TIME");
    const duplicate = m.identity
      .list("intentions")
      .find(
        (i) =>
          !reminder &&
          !i.reminder &&
          !terminal.has(i.status) &&
          norm(i.topic) === norm(args.topic),
      );
    if (duplicate) {
      recallBoundary(r, ctx).assert(duplicate);
      trackMindRecords(r, ctx, [duplicate], "intent");
      return { ...duplicate, duplicate: true };
    }
    const i = {
      id: randomUUID(),
      revision: 1,
      status: "waiting",
      createdAt: now,
      createdIn: ctx.conversation,
      ...args,
      ...(reminder && { reminder }),
      createdAfterSeq: this.incomingCeiling(a.id, args.target),
      eligibleAt: args.eligibleAt || now,
      evidence: args.evidence || [],
      history: [{ status: "waiting", at: now }],
      ...mergeProtection(
        contextProtection(r, ctx),
        ...proof.references.map((ref) => ref.metadata),
      ),
    };
    if (subjectInboxEnabled(a) && needsSubjectReview(i))
      i.subjectReview = { reviewAt: now };
    const saved = this.save(a.id, i);
    trackMindRecords(r, ctx, [saved], "intent");
    return saved;
  }
  update(ctx, args) {
    const m = this.memory(ctx.agentId);
    let i = m.identity.get("intentions", args.id);
    if (i.revision !== args.expectedRevision) throw Error("REVISION_CONFLICT");
    if (terminal.has(i.status)) throw Error("INTENT_CLOSED");
    if (
      ctx.conversation !== SUBJECT &&
      ctx.conversation !== i.createdIn &&
      ctx.conversation !== i.target
    )
      throw Error("INTENT_SCOPE");
    i = { ...i, ...mergeProtection(i, contextProtection(this.runtime, ctx)) };
    trackMindRecords(this.runtime, ctx, [i], "intent");
    if (args.action === "cancel")
      return this.transition(ctx.agentId, i, "cancelled", args.reason);
    if (i.reminder || !["waiting", "deferred"].includes(i.status))
      throw Error("INTENT_ALREADY_HANDED_OFF");
    const now = this.runtime.now(),
      eligibleAt =
        args.eligibleAt ||
        now + this.runtime.agent(ctx.agentId).subject.contactCooldownMs;
    if (eligibleAt >= i.expiresAt) throw Error("INVALID_INTENT_TIME");
    return this.transition(ctx.agentId, i, "deferred", args.reason, {
      eligibleAt,
    });
  }
  decide(ctx, args) {
    const r = this.runtime,
      m = this.memory(ctx.agentId);
    let i = m.identity.get("intentions", args.id);
    if (ctx.conversation !== i.target) throw Error("TARGET_CHAT_REQUIRED");
    if (i.revision !== args.expectedRevision) throw Error("REVISION_CONFLICT");
    i = { ...i, ...mergeProtection(i, contextProtection(r, ctx)) };
    trackMindRecords(r, ctx, [i], "intent");
    if (args.action === "complete" && i.reminder) throw Error("INTENT_STATE");
    if (args.action === "complete") {
      if (
        !["awaiting-response", "handedoff", "deferred", "waiting"].includes(
          i.status,
        )
      )
        throw Error("INTENT_STATE");
      const records = (args.evidence || []).map((id) =>
        m.db
          .prepare("SELECT * FROM events WHERE agent_id=? AND id=?")
          .get(ctx.agentId, id),
      );
      if (
        !records.length ||
        records.some(
          (e) =>
            !e ||
            e.conversation !== i.target ||
            e.direction !== "in" ||
            !Number.isSafeInteger(i.createdAfterSeq) ||
            e.seq <= Math.max(i.createdAfterSeq, i.handoffSeq || 0),
        )
      )
        throw Error("INTENT_RESPONSE_EVIDENCE_REQUIRED");
      const proof = freezeEvidence(m, args.evidence, r.now(), {
        allowProtected: true,
      });
      i = {
        ...i,
        ...mergeProtection(i, ...proof.references.map((ref) => ref.metadata)),
      };
      return this.transition(ctx.agentId, i, "completed", args.reason, {
        responseEvidence: args.evidence,
      });
    }
    if (i.status !== "handedoff" || !ctx.intentIds?.includes(i.id))
      throw Error("INTENT_NOT_IN_TURN");
    if (args.action === "send") {
      r.assertDisclosure(ctx);
      this.assertFresh(ctx, i);
      if (ctx.activeIntentId && ctx.activeIntentId !== i.id)
        throw Error("ONE_INTENT_PER_TURN");
      ctx.activeIntentId = i.id;
      return this.transition(ctx.agentId, i, "selected", args.reason);
    }
    if (args.action === "cancel" || i.reminder)
      return this.transition(ctx.agentId, i, "cancelled", args.reason);
    return this.transition(ctx.agentId, i, "deferred", args.reason, {
      eligibleAt: r.now() + r.agent(ctx.agentId).subject.contactCooldownMs,
    });
  }
  assertFresh(ctx, item) {
    const r = this.runtime,
      a = r.agent(ctx.agentId),
      m = this.memory(a.id),
      i = item || m.identity.get("intentions", ctx.activeIntentId);
    if (m.corrections.blocksIntent(i.id))
      throw Error("INTENT_CORRECTION_REVIEW_REQUIRED");
    if (
      !this.enabled(a) ||
      !this.targetAllowed(a, i.target) ||
      !r.writable(a, i.target, ctx) ||
      i.expiresAt <= r.now() ||
      (i.reminder && !this.reminderAllowed(a, i, ctx)) ||
      !["handedoff", "selected"].includes(i.status)
    )
      throw Error("INTENT_NO_LONGER_ALLOWED");
    if (
      (m.state(i.target).lastReceivedSeq || 0) !== (ctx.intentSnapshotSeq || 0)
    )
      throw Error("INTENT_STALE_REFRESH_REQUIRED");
    return i;
  }
  beforeDelivery(ctx, evidence = ctx) {
    if (
      ctx.conversation === SUBJECT ||
      ctx.conversation === DESKTOP_CONVERSATION
    )
      throw Error("SUBJECT_CANNOT_SEND_QQ");
    if (ctx.intentOnly && !ctx.activeIntentId)
      throw Error("INTENT_DECISION_REQUIRED");
    if (!ctx.activeIntentId) return null;
    const i = this.assertFresh(ctx);
    trackMindRecords(this.runtime, evidence, [i], "intent");
    if (i.reminder) return i;
    const s = this.memory(ctx.agentId).state(SUBJECT),
      a = this.runtime.agent(ctx.agentId),
      now = this.runtime.now();
    if (
      (this.memory(ctx.agentId).state(i.target).proactiveCooldownUntil || 0) >
        now ||
      (s.lastContactAt || 0) + a.subject.contactCooldownMs > now
    )
      throw Error("PROACTIVE_COOLDOWN");
    if (
      (s.contacts || []).filter((t) => t > now - 86400000).length >=
      a.subject.maxContactsPerDay
    )
      throw Error("SUBJECT_CONTACT_BUDGET");
    return i;
  }
  delivered(ctx, status) {
    if (!ctx.activeIntentId) return;
    const m = this.memory(ctx.agentId),
      i = m.identity.get("intentions", ctx.activeIntentId),
      now = this.runtime.now();
    this.transition(
      ctx.agentId,
      i,
      status === "sent"
        ? i.expectsResponse
          ? "awaiting-response"
          : "completed"
        : status,
      "outbox receipt",
      { deliveryId: "intent:" + i.id, sentAt: status === "sent" ? now : null },
    );
  }
  reserveContact(ctx, item) {
    if (!item || item.reminder || item.contactChargedAt !== undefined) return;
    const m = this.memory(ctx.agentId),
      now = this.runtime.now(),
      a = this.runtime.agent(ctx.agentId);
    // Called in the same SQLite transaction as the outbox reservation, before network I/O.
    // An unknown receipt still represents a contact attempt and must consume its budget.
    this.save(ctx.agentId, { ...item, contactChargedAt: now });
    const s = m.state(SUBJECT);
    m.setState(SUBJECT, {
      ...s,
      lastContactAt: now,
      contacts: [...(s.contacts || []).filter((t) => t > now - 86400000), now],
    });
    const c = m.state(item.target);
    m.setState(item.target, {
      ...c,
      proactiveCooldownUntil:
        now +
        (item.expectsResponse
          ? a.subject.unansweredCooldownMs
          : a.subject.contactCooldownMs),
      replyCheckAt: null,
    });
  }

  begin(ctx, reasons) {
    const m = this.memory(ctx.agentId);
    ctx.intentIds = reasons
      .filter(
        (x) =>
          x.intentId &&
          recallBoundary(this.runtime, ctx).allowed(
            m.identity.get("intentions", x.intentId),
          ),
      )
      .map((x) => x.intentId);
    for (const reason of reasons)
      if (reason.subjectReminderId && ctx.conversation === SUBJECT) {
        ctx.privateRead.add(`context:${reason.target}`);
        ctx.privateRead.add(reason.eventId);
      }
    ctx.intentOnly = reasons.length > 0 && reasons.every((x) => x.intentId);
    ctx.intentSnapshotSeq = m.state(ctx.conversation).lastReceivedSeq || 0;
    ctx.activityThroughSeq = Math.max(
      0,
      ...reasons.flatMap((r) => (r.activities || []).map((e) => e.seq)),
    );
  }
  trackForTurn(ctx) {
    const records = (ctx.intentIds || []).map((id) =>
      this.memory(ctx.agentId).identity.get("intentions", id),
    );
    if (records.some((i) => i.target !== ctx.conversation))
      throw Error("TARGET_CHAT_REQUIRED");
    trackMindRecords(
      this.runtime,
      ctx,
      recallBoundary(this.runtime, ctx).rows(records),
      "intent",
    );
  }
  canAutoDisclose(agent, item) {
    return (
      !item.protectedOperations &&
      !item.protectedRepositories?.length &&
      !item.protectedSocialSources?.length &&
      !item.protectedPeerQzoneTargets?.length
    );
  }
  finish(ctx, outcome) {
    const m = this.memory(ctx.agentId),
      a = this.runtime.config.agents.find((a) => a.id === ctx.agentId);
    if (
      ctx.conversation === SUBJECT &&
      ["sent", "completed-no-send"].includes(outcome)
    ) {
      const s = m.state(SUBJECT);
      m.setState(SUBJECT, {
        ...s,
        activityCursor: Math.max(
          s.activityCursor || 0,
          ctx.activityThroughSeq || 0,
        ),
      });
    }
    if (!a) return;
    for (const id of ctx.intentIds || []) {
      const i = m.identity.get("intentions", id);
      if (["handedoff", "selected"].includes(i.status))
        this.transition(
          a.id,
          i,
          i.reminder ? "cancelled" : "deferred",
          "target turn ended without delivery",
          { eligibleAt: this.runtime.now() + a.subject.contactCooldownMs },
        );
    }
  }
  tick() {
    const r = this.runtime,
      now = r.now();
    for (const a of r.config.agents) {
      if (subjectInboxEnabled(a) && settleRoleRest(r, a))
        refreshAgentRhythm(r, a);
      const m = this.memory(a.id);
      // Terminal intentions accumulate forever; the 1 Hz tick only needs open ones.
      const open = m.db
        .prepare(
          `SELECT value FROM intentions WHERE agent_id=? AND json_extract(value,'$.status') NOT IN (${[...terminal].map(() => "?").join(",")}) ORDER BY rowid DESC`,
        )
        .all(a.id, ...terminal)
        .map((row) => JSON.parse(row.value));
      for (const i of open) {
        if (!terminal.has(i.status) && i.expiresAt <= now)
          this.transition(a.id, i, "expired", "validity elapsed");
        else if (
          ["waiting", "deferred"].includes(i.status) &&
          i.eligibleAt <= now &&
          !(
            (subjectInboxEnabled(a) || i.subjectReview) &&
            needsSubjectReview(i)
          ) &&
          this.canAutoDisclose(a, i) &&
          this.contactOpportunity(a, i.target, i)
        ) {
          const c = m.state(i.target);
          if (r.running.has(a.id + "|" + i.target)) continue;
          const handed = this.transition(
            a.id,
            i,
            "handedoff",
            "target opportunity",
            { handoffSeq: c.lastReceivedSeq || 0 },
          );
          r.conversations.request(a.id, i.target, "intent", {
            intentId: i.id,
            instruction: JSON.stringify(handed),
            immediate: true,
          });
        }
      }
      if (r.subjectInbox.dispatch(a)) continue;
      if (
        !r.writable(a, SUBJECT) ||
        roleRest(r, a) ||
        rhythmStatus(r, a, true).state === "sleeping" ||
        r.running.has(a.id + "|" + SUBJECT) ||
        r.subjectExecution?.busy(a.id) ||
        r.games.busy(a.backendId)
      )
        continue;
      const s = m.state(SUBJECT);
      const reminder = open.find(
        (i) =>
          i.reminder &&
          i.reminder.wakeStartedAt == null &&
          i.status === "waiting" &&
          i.eligibleAt <= now &&
          i.expiresAt > now &&
          this.reminderAllowed(a, i),
      );
      if (
        reminder &&
        checksWithinDay(s, now).length < a.subject.maxChecksPerDay
      ) {
        r.trackJob(
          r.wake(a.id, SUBJECT, {
            reasons: [
              { reason: "subject-reminder", subjectReminderId: reminder.id },
            ],
          }),
          a.id,
        );
        continue;
      }
      if (
        r.config.desktopHome?.enabled === true &&
        r.desktopRoleMailbox.pending(a.id, SUBJECT).length &&
        (this.nextRoleMailWake?.get(a.id) ?? 0) <= now
      ) {
        // A provider that fails before submitting input leaves its mail pending.
        // Let ordinary subject triggers continue between retries.
        (this.nextRoleMailWake ??= new Map()).set(a.id, now + 30_000);
        r.trackJob(
          r.wake(a.id, SUBJECT, { reasons: [{ reason: "desktop-role-mail" }] }),
          a.id,
        );
        continue;
      }
      if (!s.nextCheckAt) {
        m.setState(SUBJECT, { ...s, nextCheckAt: now + a.subject.intervalMs });
        continue;
      }
      if (s.nextCheckAt > now) continue;
      if (checksWithinDay(s, now).length >= a.subject.maxChecksPerDay) continue;
      // Busy chats outpace one batch an hour; reading the oldest first left
      // free time a day behind. Show the newest and let older rows be skipped.
      const activities = m.db
        .prepare(
          "SELECT id,seq,conversation,kind,occurred_at AS occurredAt FROM events WHERE agent_id=? AND direction='in' AND seq>? ORDER BY seq DESC LIMIT 20",
        )
        .all(a.id, s.activityCursor || 0)
        .reverse();
      const pending = this.pendingActivities(a.id);
      const candidates = m.identity
        .list("self_candidates")
        .filter(
          (c) =>
            ["pending", "observing"].includes(c.status) && c.reviewAfter <= now,
        )
        .map((c) => c.id);
      r.trackJob(
        r.wake(a.id, SUBJECT, {
          reasons: [
            {
              reason: "subject-opportunity",
              candidateIds: candidates,
              activities,
              activityOverflow: Math.max(0, pending - activities.length),
              instruction:
                "空闲时间开始。activities 是上次空闲以来最新的一批来信原始记录 ID（按时间先后），需要时按 ID 回查；更早的 activityOverflow 条没有列出，不必补读，仍在事件库里可按会话检索。候选与未完成意图可按需读取；没有到期候选不必专门回顾人格。",
            },
          ],
        }),
        a.id,
      );
    }
  }
  pendingActivities(agentId) {
    const m = this.memory(agentId);
    return m.db
      .prepare(
        "SELECT COUNT(*) AS n FROM events WHERE agent_id=? AND direction='in' AND seq>?",
      )
      .get(agentId, m.state(SUBJECT).activityCursor || 0).n;
  }
}
