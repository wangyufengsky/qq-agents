import { randomUUID } from "node:crypto";
import { DESKTOP_ADMINISTRATOR } from "./desktop-archive.mjs";

const MINUTE = 60_000;

export const DESKTOP_ROOM_DEFAULTS = Object.freeze({
  maxTurns: 6,
  refreshMinutes: 10,
  autonomousMinutes: 10,
});

export class DesktopTurnQueue {
  #visits = new Map();
  #running = new Map();
  #published = 0;
  #refreshedAt;
  #policy;
  #now;

  constructor({ policy = () => DESKTOP_ROOM_DEFAULTS, now = Date.now } = {}) {
    this.#policy = policy;
    this.#now = now;
    this.#refreshedAt = this.#now();
  }

  enter(actor) {
    const existing = this.#visits.get(actor);
    if (existing) return existing.id;
    this.#visits.set(actor, {
      id: randomUUID(),
      events: [],
      accepted: new Set(),
      lastAutonomousAt: this.#now(),
      wakeAt: undefined,
    });
    return this.#visits.get(actor).id;
  }

  leave(actor) {
    return this.#visits.delete(actor);
  }

  visit(actor) {
    return this.#visits.get(actor)?.id;
  }

  enqueue(actor, event, visitId = this.visit(actor)) {
    const visit = this.#visits.get(actor);
    if (!visit || visit.id !== visitId) return false;
    if (event.eventId && visit.accepted.has(event.eventId)) return true;
    if (event.eventId) visit.accepted.add(event.eventId);
    visit.events.push(event);
    return true;
  }

  #refresh(now) {
    const { refreshMinutes } = this.#policy();
    if (
      refreshMinutes > 0 &&
      now >= this.#refreshedAt + refreshMinutes * MINUTE
    ) {
      this.#published = 0;
      this.#refreshedAt = now;
    }
  }

  remaining() {
    this.#refresh(this.#now());
    return Math.max(0, this.#policy().maxTurns - this.#published);
  }

  publish(actor, write) {
    const owner = actor === DESKTOP_ADMINISTRATOR;
    if (!owner && !this.#visits.has(actor)) return { status: "away" };
    if (!owner && !this.remaining()) return { status: "awaiting-refresh" };
    const present = [...this.#visits.keys()];
    // Recording and the audience snapshot must happen before any wake can run.
    const message = write(present);
    if (owner) {
      this.#published = 0;
      this.#refreshedAt = this.#now();
    } else this.#published++;
    for (const recipient of present) {
      if (recipient !== actor)
        this.enqueue(recipient, {
          kind: "message",
          speaker: owner ? "administrator" : "agent",
          messageId: message.messageId,
        });
    }
    return { status: "published", message };
  }

  #wakeDue(visit, now) {
    if (visit.wakeAt !== undefined) return now >= visit.wakeAt;
    const { autonomousMinutes } = this.#policy();
    return (
      autonomousMinutes > 0 &&
      now >= visit.lastAutonomousAt + autonomousMinutes * MINUTE
    );
  }

  take(actor) {
    const visit = this.#visits.get(actor);
    if (!visit || this.#running.has(actor)) return;
    const now = this.#now();
    const autonomous = this.#wakeDue(visit, now);
    if (!autonomous && !visit.events.length) return;

    const events = visit.events;
    visit.events = [];
    if (autonomous) {
      events.push({ kind: "autonomous" });
      visit.lastAutonomousAt = now;
      visit.wakeAt = undefined;
    }
    const turn = { actor, visitId: visit.id, events };
    this.#running.set(actor, turn);
    return turn;
  }

  current(turn) {
    return (
      this.#running.get(turn.actor) === turn &&
      this.visit(turn.actor) === turn.visitId
    );
  }

  scheduleWake(actor, wakeAt, visitId = this.visit(actor)) {
    const visit = this.#visits.get(actor);
    if (!visit || visit.id !== visitId || !Number.isFinite(wakeAt))
      return false;
    visit.wakeAt = wakeAt;
    return true;
  }

  finish(turn, { submitted = false } = {}) {
    if (this.#running.get(turn.actor) !== turn) return false;
    if (!submitted && this.current(turn)) {
      const visit = this.#visits.get(turn.actor);
      visit.events = [...turn.events, ...visit.events];
    }
    this.#running.delete(turn.actor);
    return true;
  }
}
