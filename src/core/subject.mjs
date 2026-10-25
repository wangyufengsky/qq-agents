import { randomUUID } from "node:crypto";
import { allowed, inSilence } from "./config.mjs";
import { SUBJECT } from "./lifecycle.mjs";
const terminal = new Set([
  "completed",
  "cancelled",
  "expired",
  "failed",
  "unknown",
]);
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
          if (delivery) {
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
                eligibleAt: runtime.now() + a.subject.contactCooldownMs,
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
  contactOpportunity(a, target) {
    const r = this.runtime,
      m = this.memory(a.id),
      s = m.state(SUBJECT),
      now = r.now();
    return (
      this.internalAllowed(a) &&
      this.targetAllowed(a, target) &&
      r.writable(a, target) &&
      !!r.transports.get(a.connectionId)?.connected &&
      (m.state(target).proactiveCooldownUntil || 0) <= now &&
      (s.lastContactAt || 0) + a.subject.contactCooldownMs <= now &&
      (s.contacts || []).filter((t) => t > now - 86400000).length <
        a.subject.maxContactsPerDay
    );
  }
  save(id, value) {
    return this.memory(id).identity.put("intentions", value);
  }
  enabled(a) {
    return a.subject.enabled || a.behavior.proactive.enabled;
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
    if (!allowed(a, target)) return false;
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
  transition(agentId, item, status, reason, extra = {}) {
    return this.save(agentId, {
      ...item,
      ...extra,
      status,
      revision: item.revision + 1,
      history: [...item.history, { status, reason, at: this.runtime.now() }],
    });
  }
  create(ctx, args) {
    const r = this.runtime,
      a = r.agent(ctx.agentId),
      m = this.memory(a.id),
      now = r.now();
    if (!this.targetAllowed(a, args.target))
      throw Error("PROACTIVE_TARGET_NOT_ENABLED");
    m.identity.sources(args.evidence || []);
    if (
      args.expiresAt <= now ||
      args.expiresAt > now + 7 * 86400000 ||
      (args.eligibleAt || now) >= args.expiresAt
    )
      throw Error("INVALID_INTENT_TIME");
    const duplicate = m.identity
      .list("intentions")
      .find(
        (i) => !terminal.has(i.status) && norm(i.topic) === norm(args.topic),
      );
    if (duplicate) return { ...duplicate, duplicate: true };
    const i = {
      id: randomUUID(),
      revision: 1,
      status: "waiting",
      createdAt: now,
      createdIn: ctx.conversation,
      ...args,
      createdAfterSeq: this.incomingCeiling(a.id, args.target),
      eligibleAt: args.eligibleAt || now,
      evidence: args.evidence || [],
      history: [{ status: "waiting", at: now }],
    };
    return this.save(a.id, i);
  }
  update(ctx, args) {
    const m = this.memory(ctx.agentId),
      i = m.identity.get("intentions", args.id);
    if (i.revision !== args.expectedRevision) throw Error("REVISION_CONFLICT");
    if (terminal.has(i.status)) throw Error("INTENT_CLOSED");
    if (
      ctx.conversation !== SUBJECT &&
      ctx.conversation !== i.createdIn &&
      ctx.conversation !== i.target
    )
      throw Error("INTENT_SCOPE");
    if (args.action === "cancel")
      return this.transition(ctx.agentId, i, "cancelled", args.reason);
    if (!["waiting", "deferred"].includes(i.status))
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
      m = this.memory(ctx.agentId),
      i = m.identity.get("intentions", args.id);
    if (ctx.conversation !== i.target) throw Error("TARGET_CHAT_REQUIRED");
    if (i.revision !== args.expectedRevision) throw Error("REVISION_CONFLICT");
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
      return this.transition(ctx.agentId, i, "completed", args.reason, {
        responseEvidence: args.evidence,
      });
    }
    if (i.status !== "handedoff" || !ctx.intentIds?.includes(i.id))
      throw Error("INTENT_NOT_IN_TURN");
    if (args.action === "send") {
      this.assertFresh(ctx, i);
      if (ctx.activeIntentId && ctx.activeIntentId !== i.id)
        throw Error("ONE_INTENT_PER_TURN");
      ctx.activeIntentId = i.id;
      return this.transition(ctx.agentId, i, "selected", args.reason);
    }
    if (args.action === "cancel")
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
    if (
      !this.enabled(a) ||
      !this.targetAllowed(a, i.target) ||
      !r.writable(a, i.target) ||
      i.expiresAt <= r.now() ||
      !["handedoff", "selected"].includes(i.status)
    )
      throw Error("INTENT_NO_LONGER_ALLOWED");
    if (
      (m.state(i.target).lastReceivedSeq || 0) !== (ctx.intentSnapshotSeq || 0)
    )
      throw Error("INTENT_STALE_REFRESH_REQUIRED");
    return i;
  }
  beforeDelivery(ctx) {
    if (ctx.conversation === SUBJECT) throw Error("SUBJECT_CANNOT_SEND_QQ");
    if (ctx.intentOnly && !ctx.activeIntentId)
      throw Error("INTENT_DECISION_REQUIRED");
    if (!ctx.activeIntentId) return null;
    const i = this.assertFresh(ctx);
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
    if (!item || item.contactChargedAt !== undefined) return;
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
    ctx.intentIds = reasons.filter((x) => x.intentId).map((x) => x.intentId);
    ctx.intentOnly = !!ctx.intentIds.length && reasons.every((x) => x.intentId);
    ctx.intentSnapshotSeq = m.state(ctx.conversation).lastReceivedSeq || 0;
    ctx.activityThroughSeq = Math.max(
      0,
      ...reasons.flatMap((r) => (r.activities || []).map((e) => e.seq)),
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
          "deferred",
          "target turn ended without delivery",
          { eligibleAt: this.runtime.now() + a.subject.contactCooldownMs },
        );
    }
  }
  tick() {
    const r = this.runtime,
      now = r.now();
    for (const a of r.config.agents) {
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
          this.contactOpportunity(a, i.target)
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
      if (!this.internalAllowed(a) || r.running.has(a.id + "|" + SUBJECT))
        continue;
      const s = m.state(SUBJECT);
      if (!s.nextCheckAt) {
        m.setState(SUBJECT, { ...s, nextCheckAt: now + a.subject.intervalMs });
        continue;
      }
      if (s.nextCheckAt > now) continue;
      const checks = (s.checks || []).filter((t) => t > now - 86400000);
      if (checks.length >= a.subject.maxChecksPerDay) continue;
      m.setState(SUBJECT, {
        ...s,
        nextCheckAt: now + a.subject.intervalMs,
        checks: [...checks, now],
        lastOpportunityAt: now,
      });
      const activities = m.db
        .prepare(
          "SELECT id,seq,conversation,kind,occurred_at AS occurredAt FROM events WHERE agent_id=? AND direction='in' AND seq>? ORDER BY seq LIMIT 20",
        )
        .all(a.id, s.activityCursor || 0);
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
                "可不行动。activities 是本批实际来信引用，需按原始记录 ID 回查内容；溢出保留在事件库供后续机会读取。候选与未完成意图可按需读取；没有候选不做专门人格回顾。",
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
