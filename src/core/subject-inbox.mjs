import { createHash } from "node:crypto";
import { homeRequestId } from "../home/policy.mjs";
import {
  contactItems,
  needsSubjectReview,
  roomItems,
  sourceFeedback,
} from "./subject-inbox-sources.mjs";
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
  submit(ctx, { requestId, proposal, usefulUntil, identityGeneration }) {
    const a = this.assertScope(ctx, false),
      now = this.runtime.now();
    this.assertSource(a, ctx);
    const state = this.state(a.id);
    const items = state.items || [];
    const id = `${ctx.conversation}/${requestId}`;
    const old = items.find((item) => item.id === id);
    if (
      proposal.kind === "room_scene_patch" ||
      proposal.kind === "room_publish"
    ) {
      if (
        !identityGeneration ||
        usefulUntil !== undefined ||
        !homeRequestId.safeParse(requestId).success
      )
        throw Error("INVALID_REQUEST");
      if (old) throw Error("IDEMPOTENCY_CONFLICT");
      const result = this.runtime.home.rooms.tool(ctx, "room_intent_submit", {
        requestId,
        identityGeneration,
        proposal,
      });
      return { ...result, id: `room:${result.intentId}` };
    }
    if (identityGeneration !== undefined) throw Error("INVALID_REQUEST");
    if (proposal.kind === "social") this.assertSocial(a, proposal.target);
    this.runtime.assertSafeOutput(ctx, JSON.stringify(proposal));
    if (
      a.home?.enabled &&
      this.runtime.home.rooms.intents.inboxRequestExists(
        a.id,
        ctx.conversation,
        requestId,
      )
    )
      throw Error("IDEMPOTENCY_CONFLICT");
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
    if (proposal.kind === "reflection") this.reflection(ctx, a, item);
    const reference = this.reference(a, item);
    if (proposal.kind === "handoff") {
      if (!reference) throw Error("RECORD_NOT_FOUND");
      this.assertSource(a, ctx, reference);
    }
    this.save(a.id, { ...state, items: [...items, item] });
    return { id, status: item.status };
  }
  pending(a, state, now) {
    return [
      ...(state.items || []),
      ...contactItems(this.runtime, a, now),
      ...roomItems(this.runtime, a, state, now),
    ].filter(
      (item) =>
        (item.status === "pending" ||
          (item.status === "accepted" && item.proposal.kind === "room")) &&
        (item.reviewAt == null || item.reviewAt <= now) &&
        allowed(a, item.source, this.runtime.config),
    );
  }
  view(ctx, items, now) {
    return items.map((item) => {
      if (item.proposal.kind !== "room")
        ctx.privateRead.add(`context:${item.source}`);
      return {
        ...item,
        ageMs: now - item.createdAt,
        pastUsefulUntil: item.usefulUntil != null && item.usefulUntil <= now,
      };
    });
  }
  list(ctx, { offset }) {
    const subject = ctx.conversation === SUBJECT;
    const a = this.assertScope(ctx, subject),
      now = this.runtime.now();
    this.assertSource(a, ctx);
    const items = subject
      ? this.pending(a, this.state(a.id), now)
      : this.feedbackItems(a, ctx.conversation, now);
    const page = items.slice(offset, offset + BATCH);
    return {
      items: subject ? this.view(ctx, page, now) : page.map(sourceFeedback),
      nextOffset: offset + BATCH < items.length ? offset + BATCH : null,
    };
  }
  offer(ctx, a) {
    if (!ctx.allowedTools?.includes("subject_inbox_decide")) return null;
    const now = this.runtime.now(),
      state = this.state(a.id);
    const pending = this.pending(a, state, now);
    const due = pending
      .filter((item) => item.reviewAt != null)
      .sort((a, b) => a.reviewAt - b.reviewAt);
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
  feedbackItems(a, source, now) {
    const state = this.state(a.id);
    return [
      ...(state.items || []).filter((item) => item.source === source),
      ...contactItems(this.runtime, a, now, source),
      ...roomItems(this.runtime, a, state, now, source),
    ]
      .filter((item) => item.decidedAt != null)
      .sort((a, b) => b.decidedAt - a.decidedAt)
      .slice(0, LIMIT);
  }
  feedback(ctx, a) {
    if (
      !chat.test(ctx.conversation) ||
      !ctx.allowedTools?.includes("subject_inbox_list")
    )
      return null;
    const memory = this.runtime.memory.bind(a.id);
    const shown = new Set(
      memory.state(ctx.conversation).subjectFeedbackShown || [],
    );
    const items = this.feedbackItems(a, ctx.conversation, this.runtime.now())
      .filter(
        (item) =>
          !shown.has(
            JSON.stringify([
              item.id,
              item.status,
              item.decision,
              item.decidedAt,
            ]),
          ),
      )
      .slice(0, BATCH);
    ctx.subjectFeedbackOffered = items.map((item) =>
      JSON.stringify([item.id, item.status, item.decision, item.decidedAt]),
    );
    return items.map(sourceFeedback);
  }
  finish(ctx, outcome) {
    if (
      !ctx.subjectInboxInputSubmitted ||
      !["completed-no-send", "sent"].includes(outcome)
    )
      return;
    const memory = this.runtime.memory.bind(ctx.agentId);
    if (ctx.subjectFeedbackOffered?.length) {
      const state = memory.state(ctx.conversation);
      const shown = new Set([
        ...(state.subjectFeedbackShown || []),
        ...ctx.subjectFeedbackOffered,
      ]);
      memory.setState(ctx.conversation, {
        ...state,
        subjectFeedbackShown: [...shown].slice(-128),
      });
    }
    if (!ctx.subjectInboxOffered?.length) return;
    const state = this.state(ctx.agentId);
    const now = this.runtime.now();
    const roomReview = { ...state.roomReview };
    for (const item of ctx.subjectInboxOffered) {
      if (item.proposal.kind === "room") {
        const id = item.id.slice(5);
        if (roomReview[id]?.reviewAt === item.reviewAt)
          roomReview[id] = { ...roomReview[id], shown: true };
        this.runtime.home.rooms.intents.inboxViewed(ctx.agentId, id, now);
      }
      if (item.proposal.kind === "outbound-contact") {
        const current = memory.identity.get("intentions", item.id.slice(8));
        if (current.revision === item.revision && needsSubjectReview(current))
          this.runtime.subject.save(ctx.agentId, {
            ...current,
            subjectReview: {
              ...current.subjectReview,
              shown: true,
              reviewAt: null,
            },
          });
      }
    }
    this.save(ctx.agentId, {
      ...state,
      roomReview,
      retryAt: null,
      items: (state.items || []).map((item) =>
        ctx.subjectInboxOffered.some(
          (offered) =>
            offered.id === item.id && offered.revision === item.revision,
        )
          ? { ...item, reviewAt: null }
          : item,
      ),
    });
  }
  focus(a) {
    if (!subjectInboxEnabled(a)) return null;
    const focus = this.runtime.memory.bind(a.id).state("@subject-focus").focus;
    return focus?.until > this.runtime.now() &&
      allowed(a, focus.source, this.runtime.config)
      ? focus
      : null;
  }
  reflection(ctx, a, item) {
    const memory = this.runtime.memory.bind(a.id);
    const evidence = [...new Set(item.proposal.evidence)];
    for (const id of evidence) {
      const row = memory.db
        .prepare(
          "SELECT conversation,payload FROM events WHERE agent_id=? AND id=?",
        )
        .get(a.id, id);
      if (!row || row.conversation !== item.source)
        throw Error("EVIDENCE_NOT_OWNED_OR_MISSING");
      this.assertSource(a, ctx, {
        id,
        conversation: row.conversation,
        payload: JSON.parse(row.payload),
        ...JSON.parse(row.payload),
      });
    }
    return evidence;
  }
  assertSocial(a, target) {
    const r = this.runtime;
    if (
      !r.config.homeSocial?.enabled ||
      !a.home?.enabled ||
      !a.home.social?.enabled
    )
      throw Error("SOCIAL_DISABLED");
    if (
      target.kind === "compose" &&
      !r.config.agents.some(
        (peer) =>
          peer.id === target.id &&
          peer.id !== a.id &&
          peer.home?.enabled &&
          peer.home.social?.enabled,
      )
    )
      throw Error("IDENTITY_DENIED");
  }
  decideRoom(ctx, a, args, now) {
    const state = this.state(a.id),
      id = args.id.slice(5);
    const rooms = this.runtime.home.rooms;
    const row = rooms.intents.inboxItem(a.id, id, now);
    if (!row || !allowed(a, row.source_session, this.runtime.config))
      throw Error("RECORD_NOT_FOUND");
    const item = {
      revision: row.state === "pending" ? 1 : row.state === "accepted" ? 2 : 3,
      status: row.state,
      usefulUntil: row.expires_at,
    };
    // A completed operation can be replayed with the revision that admitted it.
    const replay =
      (item.status === "executed" &&
        args.action === "execute" &&
        args.expectedRevision === 2) ||
      (item.status === "accepted" &&
        args.action === "accept" &&
        args.expectedRevision === 1) ||
      (item.status === "rejected" &&
        args.action === "dismiss" &&
        [1, 2].includes(args.expectedRevision));
    if (args.expectedRevision !== item.revision && !replay)
      throw Error("REVISION_CONFLICT");
    if (args.action === "defer") {
      if (!["pending", "accepted"].includes(item.status))
        throw Error("INTENT_STATE");
      this.checkReviewTime(args.reviewAt, now, item.usefulUntil);
      const openIds = new Set(
        rooms.intents.inboxRows(a.id, now).map((row) => row.id),
      );
      const review = Object.fromEntries(
        Object.entries(state.roomReview || {}).filter(([id]) =>
          openIds.has(id),
        ),
      );
      review[id] = { reviewAt: args.reviewAt, at: now, status: item.status };
      this.save(a.id, { ...state, roomReview: review });
      return {
        id: args.id,
        revision: item.revision,
        status: item.status,
        reviewAt: args.reviewAt,
      };
    }
    const action = { accept: "accept", dismiss: "reject", execute: "execute" }[
      args.action
    ];
    if (!action) throw Error("INTENT_STATE");
    const result = rooms.tool(ctx, "room_intent_resolve", {
      intentId: id,
      action,
      identityGeneration: this.runtime.home.generation(a.id),
      expectedLayoutRevision: args.expectedLayoutRevision,
      expectedItemRevision: args.expectedItemRevision,
    });
    return {
      ...result,
      id: args.id,
      status: result.status ?? "executed",
      revision: action === "accept" ? 2 : 3,
    };
  }
  decideContact(ctx, a, args, now) {
    const r = this.runtime,
      memory = r.memory.bind(a.id);
    const item = memory.identity.get("intentions", args.id.slice(8));
    if (!allowed(a, item.createdIn, r.config)) throw Error("RECORD_NOT_FOUND");
    this.assertSource(a, ctx, item);
    if (item.subjectReview?.decided)
      return {
        id: args.id,
        revision: item.revision,
        status: item.subjectReview.decided,
      };
    if (item.revision !== args.expectedRevision)
      throw Error("REVISION_CONFLICT");
    if (!needsSubjectReview(item) || item.expiresAt <= now)
      throw Error("INTENT_STATE");
    let decided;
    if (args.action === "accept") {
      if (!r.subject.targetAllowed(a, item.target))
        throw Error("PROACTIVE_TARGET_NOT_ENABLED");
      decided = "accepted";
    } else if (args.action === "dismiss") decided = "dismissed";
    else if (args.action === "defer")
      this.checkReviewTime(args.reviewAt, now, item.expiresAt);
    else throw Error("INTENT_STATE");
    const updated = r.subject.transition(
      a.id,
      item,
      decided === "dismissed" ? "cancelled" : item.status,
      "subject review",
      {
        subjectReview: {
          action: args.action,
          at: now,
          decided,
          reviewAt: args.action === "defer" ? args.reviewAt : null,
        },
      },
    );
    return {
      id: args.id,
      revision: updated.revision,
      status: decided || "pending",
    };
  }
  checkReviewTime(reviewAt, now, expiresAt = Infinity) {
    if (reviewAt <= now || reviewAt > now + 7 * DAY || reviewAt >= expiresAt)
      throw Error("INVALID_INTENT_TIME");
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
    if (args.id.startsWith("room:")) return this.decideRoom(ctx, a, args, now);
    if (args.id.startsWith("contact:"))
      return this.decideContact(ctx, a, args, now);
    const memory = r.memory.bind(a.id);
    const apply = () => {
      const state = this.state(a.id);
      const item = (state.items || []).find((value) => value.id === args.id);
      if (!item || !allowed(a, item.source, r.config))
        throw Error("RECORD_NOT_FOUND");
      if (item.status !== "pending") {
        if (item.status === "accepted" && item.proposal.kind === "reflection") {
          for (const id of this.reflection(ctx, a, item))
            ctx.privateRead.add(id);
        }
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
      } else if (args.action === "focus" && item.proposal.kind === "focus") {
        if (this.focus(a)) throw Error("SUBJECT_FOCUS_ACTIVE");
        const focus = {
          startedAt: now,
          until: now + args.durationMs,
          note: item.proposal.note,
          source: item.source,
        };
        memory.setState("@subject-focus", { focus });
        receipt = { focus: { startedAt: focus.startedAt, until: focus.until } };
      } else if (
        args.action === "take" &&
        item.proposal.kind === "reflection"
      ) {
        const evidence = this.reflection(ctx, a, item);
        for (const id of evidence) ctx.privateRead.add(id);
        receipt = { evidence };
      } else if (args.action === "social" && item.proposal.kind === "social") {
        const { target } = item.proposal;
        this.assertSocial(a, target);
        const requestId =
          "inbox_" + createHash("sha256").update(item.id).digest("hex");
        const queued = r.socialRuntime.process(
          ctx,
          { target, requestId },
          target.kind === "visit",
        );
        if (!queued.result.queued) throw Error("INTENT_STATE");
        receipt = { socialStatus: "queued" };
      } else if (args.action === "defer") {
        this.checkReviewTime(args.reviewAt, now);
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
        decidedAt: now,
        decision: args.action,
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
    };
    return args.action === "social" ? apply() : memory.store.transaction(apply);
  }
  rest(ctx, args) {
    const a = this.assertScope(ctx, true);
    this.assertSource(a, ctx);
    return beginRoleRest(this.runtime, a, args);
  }
}
