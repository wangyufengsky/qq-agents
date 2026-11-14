import { randomInt } from "node:crypto";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export class DesktopPublicActivity {
  constructor(starts, policy, minutes, choose = randomInt) {
    this.starts = starts;
    this.policy = policy;
    this.minutes = minutes;
    this.choose = choose;
  }

  delay(kind) {
    const policy = this.policy();
    return this.choose(policy[kind + "Min"], policy[kind + "Max"] + 1) * MINUTE;
  }

  arrive(visit, now) {
    visit.publicActivity = { due: now + this.delay("first"), wait: 0, rest: 0 };
  }

  dueAt(visit) {
    const { due, wait, rest } = visit.publicActivity;
    return Math.max(due, wait, rest);
  }

  resume(visit, now, force = false) {
    if (visit?.publicActivity && (force || this.dueAt(visit) <= now))
      visit.publicActivity.due = now + this.delay("resume");
  }

  resting(visit, now) {
    return visit?.publicActivity?.rest > now;
  }

  recent(actor, now) {
    return (this.starts.get(actor) ?? []).filter(
      (entry) => (entry.at ?? entry) > now - HOUR,
    );
  }

  hasIdleBudget(actor, now) {
    const entries = this.recent(actor, now);
    const policy = this.policy();
    return (
      entries.length < policy.totalLimit &&
      entries.filter((entry) => entry.idle !== false).length < policy.idleLimit
    );
  }

  take(actor, visit, now, events, extra = false) {
    const state = visit.publicActivity;
    const policy = this.policy();
    if (!state || state.rest > now) return;
    const entries = this.recent(actor, now);
    const idleCount = entries.filter((entry) => entry.idle !== false).length;
    const event = events.find(
      ({ until, direct }) => until > now && (state.wait <= now || direct),
    );
    const due = this.dueAt(visit);
    const idle =
      (due <= now || (extra && !event && state.wait <= now)) &&
      idleCount < policy.idleLimit;
    if (
      entries.length >= policy.totalLimit ||
      (!idle &&
        (!event || (!idleCount && entries.length === policy.totalLimit - 1)))
    )
      return;
    this.starts.set(actor, [...entries, { at: now, idle }]);
    if (idle) state.due = Infinity;
    return {
      actor,
      kind: "activity",
      startedAt: now,
      idle,
      reason: event?.kind ?? "idle",
      ...(idle && due > now && { observationPreviousDue: due }),
      ...(event && { trigger: event.id }),
      recentEvent: visit.activity.pendingReason,
      lastResult: visit.activity.lastResult,
    };
  }

  finish(actor, visit, turn, now, reply, submitted = true) {
    const state = visit.publicActivity;
    if (turn.observationPreviousDue !== undefined && !submitted) {
      this.starts.set(
        actor,
        this.recent(actor, now).filter(
          ({ at, idle }) => at !== turn.startedAt || !idle,
        ),
      );
      if (state.due === Infinity) state.due = turn.observationPreviousDue;
      return;
    }
    if (turn.idle) {
      const preference = this.minutes(actor);
      state.due = now + (preference ? preference * MINUTE : this.delay("idle"));
    }
    if (reply?.action === "wait" || reply?.action === "rest") {
      const until = now + reply.waitMinutes * MINUTE;
      state[reply.action] = until;
      if (reply.action === "wait") {
        state.rest = 0;
        state.due = until;
      } else state.wait = 0;
    }
  }
}
