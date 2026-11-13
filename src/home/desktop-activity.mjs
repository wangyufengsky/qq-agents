const MINUTE = 60_000;
const COOLDOWN = 2 * MINUTE;
const HOUR = 60 * MINUTE;
const LIMIT = 4;

export const DESKTOP_ACTIVITY_TIMEOUT = 45_000;

export class DesktopActivity {
  // Retain the budget on the host, so reconnecting or revisiting cannot refill it.
  starts = new Map();
  cursor = 0;
  paused = false;

  constructor(starts = new Map(), activityMinutes = () => undefined) {
    this.starts = starts;
    this.activityMinutes = activityMinutes;
  }

  arrive(visit, now, actor) {
    visit.activity = { actor, since: now, waitUntil: 0, reason: "arrival" };
  }

  dueAt(visit) {
    const { actor, since, waitUntil } = visit.activity;
    return Math.max(
      waitUntil,
      since + Math.max(COOLDOWN, (this.activityMinutes(actor) ?? 2) * MINUTE),
    );
  }

  defer(visit, now) {
    if (!visit) return;
    visit.activity.since = now;
    visit.activity.reason = "manual-drag";
  }

  note(visit, reason) {
    if (visit?.activity) visit.activity.pendingReason = reason;
  }

  next(roles, visits, now, eligible) {
    if (this.paused || !roles.length) return;
    for (let offset = 0; offset < roles.length; offset++) {
      const index = (this.cursor + offset) % roles.length;
      const { id } = roles[index];
      const visit = visits.get(id);
      if (!visit || this.dueAt(visit) > now || !eligible(id)) continue;
      const starts = (this.starts.get(id) ?? []).filter(
        (entry) => (entry.at ?? entry) > now - HOUR,
      );
      if (
        starts.length >= LIMIT ||
        now < (starts.at(-1)?.at ?? starts.at(-1) ?? -Infinity) + COOLDOWN
      )
        continue;
      this.starts.set(id, [...starts, now]);
      this.cursor = (index + 1) % roles.length;
      const { reason, lastResult, pendingReason } = visit.activity;
      delete visit.activity.pendingReason;
      visit.activity.since = now;
      visit.activity.waitUntil = 0;
      visit.activity.reason = "idle";
      return {
        actor: id,
        kind: "activity",
        reason,
        ...(pendingReason && { recentEvent: pendingReason }),
        lastResult,
        startedAt: now,
      };
    }
  }

  finish(visit, { reply, lastResult, now }) {
    if (lastResult) {
      visit.activity.lastResult = lastResult;
      this.note(visit, "action-result");
    }
    if (reply?.action === "wait") {
      visit.activity.waitUntil = now + reply.waitMinutes * MINUTE;
      visit.activity.reason = "wait-ended";
    }
  }
}
