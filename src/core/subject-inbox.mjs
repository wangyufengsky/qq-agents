import { isDeepStrictEqual } from "node:util";
import { allowed } from "./config.mjs";
import { contextProtection, trackMindRecords } from "./protected-mind.mjs";
import { recallBoundary } from "./recall-boundary.mjs";
import {
  beginRoleRest,
  roleRest,
  roleTurnBusy,
  subjectInboxEnabled,
} from "./role-rest.mjs";
import { rhythmStatus } from "./rhythm.mjs";

const SUBJECT = "@subject";
const INBOX = "@subject-inbox";
const BATCH = 8;
const LIMIT = 64;
const DAY = 86400000;
const chat = /^(group|private):\d+$/;

export class SubjectInbox {
  constructor(runtime) {
    this.runtime = runtime;
  }
  state(agentId) {
    return this.runtime.memory.bind(agentId).state(INBOX);
  }
  save(agentId, state) {
    this.runtime.memory.bind(agentId).setState(INBOX, state);
  }
  assertScope(ctx, subject) {
    const a = this.runtime.assertActive(ctx);
    if (
      !subjectInboxEnabled(a) ||
      (subject ? ctx.conversation !== SUBJECT : !chat.test(ctx.conversation)) ||
      ctx.intentOnly ||
      ctx.scheduleRunId
    )
      throw Error("TOOL_DISABLED");
    return a;
  }
  assertSource(a, ctx, record = {}) {
    if (
      !this.runtime.subject.canAutoDisclose(
        a,
        contextProtection(this.runtime, ctx),
      ) ||
      !this.runtime.subject.canAutoDisclose(a, record) ||
      !recallBoundary(this.runtime, ctx).allowed(record)
    )
      throw Error("SUBJECT_INBOX_SOURCE_DENIED");
  }
  reference(a, item) {
    const identity = this.runtime.memory.bind(a.id).identity;
    if (item.proposal.kind !== "handoff") return null;
    const { reference } = item.proposal;
    if (reference.type === "project") return identity.project(reference.id);
    return identity.notes(item.source).find((note) => note.id === reference.id);
  }
  take(ctx, a, item) {
    const reference = this.reference(a, item);
    if (!reference) throw Error("RECORD_NOT_FOUND");
    this.assertSource(a, ctx, reference);
    ctx.privateRead.add(`context:${item.source}`);
    trackMindRecords(this.runtime, ctx, [reference]);
    return reference;
  }
  submit(ctx, { requestId, proposal, usefulUntil }) {
    const a = this.assertScope(ctx, false),
      now = this.runtime.now();
    this.assertSource(a, ctx);
    this.runtime.assertSafeOutput(ctx, JSON.stringify(proposal));
    const state = this.state(a.id),
      items = state.items || [];
    const id = `${ctx.conversation}/${requestId}`;
    const old = items.find((item) => item.id === id);
    if (old) {
      if (
        !isDeepStrictEqual(old.proposal, proposal) ||
        old.usefulUntil !== usefulUntil
      )
        throw Error("IDEMPOTENCY_CONFLICT");
      return { id, status: old.status, duplicate: true };
    }
    if (items.filter((item) => item.status === "pending").length >= LIMIT)
      throw Error("SUBJECT_INBOX_FULL");
    if (
      proposal.kind === "contact" &&
      !this.runtime.subject.targetAllowed(a, proposal.target)
    )
      throw Error("PROACTIVE_TARGET_NOT_ENABLED");
    const item = {
      id,
      revision: 1,
      source: ctx.conversation,
      status: "pending",
      createdAt: now,
      reviewAt: now,
      usefulUntil,
      proposal,
    };
    const reference = this.reference(a, item);
    if (proposal.kind === "handoff") {
      if (!reference) throw Error("RECORD_NOT_FOUND");
      this.assertSource(a, ctx, reference);
    }
    this.save(a.id, { ...state, items: [...items, item] });
    return { id, status: item.status };
  }
  pending(a, state, now) {
    return (state.items || []).filter(
      (item) =>
        item.status === "pending" &&
        (item.reviewAt == null || item.reviewAt <= now) &&
        allowed(a, item.source, this.runtime.config),
    );
  }
  view(ctx, items, now) {
    return items.map((item) => {
      ctx.privateRead.add(`context:${item.source}`);
      return {
        ...item,
        ageMs: now - item.createdAt,
        pastUsefulUntil: item.usefulUntil != null && item.usefulUntil <= now,
      };
    });
  }
  list(ctx, { offset }) {
    const a = this.assertScope(ctx, true),
      now = this.runtime.now();
    this.assertSource(a, ctx);
    const items = this.pending(a, this.state(a.id), now);
    return {
      items: this.view(ctx, items.slice(offset, offset + BATCH), now),
      nextOffset: offset + BATCH < items.length ? offset + BATCH : null,
    };
  }
  offer(ctx, a) {
    if (!ctx.allowedTools?.includes("subject_inbox_decide")) return null;
    const now = this.runtime.now(),
      state = this.state(a.id);
    const pending = this.pending(a, state, now);
    const due = pending.filter((item) => item.reviewAt != null);
    const items = [
      ...due,
      ...pending.filter((item) => item.reviewAt == null),
    ].slice(0, BATCH);
    if (!items.length) return null;
    ctx.subjectInboxOffered = items.filter((item) => item.reviewAt != null);
    return {
      items: this.view(ctx, items, now),
      more: pending.length - items.length,
    };
  }
  finish(ctx, outcome) {
    if (
      !ctx.subjectInboxInputSubmitted ||
      !ctx.subjectInboxOffered?.length ||
      outcome !== "completed-no-send"
    )
      return;
    const state = this.state(ctx.agentId);
    this.save(ctx.agentId, {
      ...state,
      retryAt: null,
      items: state.items.map((item) =>
        ctx.subjectInboxOffered.some(
          (offered) =>
            offered.id === item.id && offered.revision === item.revision,
        )
          ? { ...item, reviewAt: null }
          : item,
      ),
    });
  }
  dispatch(a) {
    const r = this.runtime;
    if (
      !subjectInboxEnabled(a) ||
      !r.writable(a, SUBJECT) ||
      r.games.busy(a.backendId) ||
      roleTurnBusy(r, a.id) ||
      rhythmStatus(r, a, true).state === "sleeping" ||
      roleRest(r, a)
    )
      return false;
    const now = r.now(),
      state = this.state(a.id);
    if (
      state.retryAt > now ||
      !this.pending(a, state, now).some((item) => item.reviewAt != null)
    )
      return false;
    const attempts = (state.attempts || []).filter((at) => at > now - DAY);
    if (attempts.length >= 24) return false;
    // An unsuccessful model turn may retry later, with the same durable proposals.
    this.save(a.id, {
      ...state,
      attempts: [...attempts, now],
      retryAt: now + 30000,
    });
    const job = r.wake(a.id, SUBJECT, {
      reasons: [{ reason: "subject-inbox" }],
    });
    r.trackJob(job, a.id);
    return true;
  }
  decide(ctx, args) {
    const a = this.assertScope(ctx, true),
      r = this.runtime,
      now = r.now();
    this.assertSource(a, ctx);
    const memory = r.memory.bind(a.id);
    return memory.store.transaction(() => {
      const state = this.state(a.id);
      const item = (state.items || []).find((value) => value.id === args.id);
      if (!item || !allowed(a, item.source, r.config))
        throw Error("RECORD_NOT_FOUND");
      if (item.status !== "pending") {
        const replay =
          item.status === "accepted" &&
          args.action === "take" &&
          item.proposal.kind === "handoff";
        return {
          id: item.id,
          revision: item.revision,
          status: item.status,
          ...item.receipt,
          ...(replay ? { reference: this.take(ctx, a, item) } : {}),
        };
      }
      if (item.revision !== args.expectedRevision)
        throw Error("REVISION_CONFLICT");
      let receipt = {},
        reference;
      if (args.action === "rest" && item.proposal.kind === "rest") {
        receipt = { rest: beginRoleRest(r, a, args) };
      } else if (
        args.action === "contact" &&
        item.proposal.kind === "contact"
      ) {
        const target = item.proposal.target;
        // Carry a neutral contact cue across chats; the originating text stays in the inbox.
        const intent = r.subject.create(ctx, {
          target,
          topic: `问候 ${target}`,
          reason:
            "主人格决定主动问候。结合这个会话本身的近况判断是否适合开口。",
          background: "",
          expiresAt: args.expiresAt,
          eligibleAt: args.eligibleAt,
          expectsResponse: false,
        });
        receipt = { contactIntentId: intent.id };
      } else if (args.action === "take" && item.proposal.kind === "handoff") {
        reference = this.take(ctx, a, item);
      } else if (args.action === "defer") {
        if (args.reviewAt <= now || args.reviewAt > now + 7 * DAY)
          throw Error("INVALID_INTENT_TIME");
      } else if (args.action !== "dismiss") {
        throw Error("INTENT_STATE");
      }
      const next = {
        ...item,
        revision: item.revision + 1,
        status:
          args.action === "defer"
            ? "pending"
            : args.action === "dismiss"
              ? "dismissed"
              : "accepted",
        reviewAt: args.action === "defer" ? args.reviewAt : null,
        receipt,
      };
      const updated = state.items.map((value) =>
        value.id === item.id ? next : value,
      );
      const recent = updated
        .filter((value) => value.status !== "pending")
        .slice(-LIMIT);
      this.save(a.id, {
        ...state,
        items: [
          ...updated.filter((value) => value.status === "pending"),
          ...recent,
        ],
      });
      return {
        id: next.id,
        revision: next.revision,
        status: next.status,
        ...receipt,
        ...(reference ? { reference } : {}),
      };
    });
  }
  rest(ctx, args) {
    const a = this.assertScope(ctx, true);
    this.assertSource(a, ctx);
    return beginRoleRest(this.runtime, a, args);
  }
}
