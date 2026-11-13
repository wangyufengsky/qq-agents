import { randomUUID } from "node:crypto";

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export class DesktopPerception {
  events = [];
  sample;

  constructor(room, now, policy) {
    this.room = room;
    this.now = now;
    this.policy = policy;
  }

  clear() {
    this.events = [];
    this.sample = undefined;
  }

  update(view) {
    this.sample = view;
  }

  view() {
    if (this.sample?.until > this.now()) return this.sample;
  }

  position(id, visit) {
    const point = this.view()?.residents.get(id);
    if (point?.visit === visit) return point;
  }

  nearby(a, b) {
    return (
      a &&
      b &&
      a.displayId === b.displayId &&
      distance(a, b) <= this.policy().nearbyDip
    );
  }

  add(kind, actor, options = {}) {
    if (!this.room.publicEnabled()) return;
    const {
      target,
      action,
      position,
      audiences,
      urgent = false,
      urgentActors,
      replyTo,
      interaction,
    } = options;
    const now = this.now();
    const policy = this.policy();
    const source = this.room.visits.get(actor);
    const origin = this.position(actor, source);
    const point =
      origin && position
        ? {
            ...origin,
            ...position,
            x: position.x + origin.halfWidth,
            y: position.y + origin.halfHeight,
          }
        : origin;
    if (kind === "action" && !point) return;
    const recipient = this.room.visits.get(target);
    const audience =
      audiences ??
      [...this.room.visits].filter(
        ([id, visit]) =>
          id !== actor &&
          (id === target || this.nearby(point, this.position(id, visit))),
      );
    const sourceName = this.room.room.roles.find(
      ({ id }) => id === actor,
    )?.name;
    const targetName = this.room.room.roles.find(
      ({ id }) => id === target,
    )?.name;
    const opportunities = new Set(
      replyTo
        ? []
        : audience
            .filter(
              ([id]) =>
                urgentActors?.has(id) ||
                (urgent && (target === undefined || id === target)),
            )
            .map(([, visit]) => visit),
    );
    if (!audience.length) return;
    this.prune();
    const mergeMs = policy.mergeSeconds * 1000;
    for (const prior of this.events) {
      if (
        prior.kind === kind &&
        prior.target === target &&
        prior.interaction?.id === interaction?.id &&
        prior.interaction?.stage === interaction?.stage &&
        now - prior.at <= mergeMs
      )
        for (const visit of prior.consumed) opportunities.delete(visit);
    }
    const door = this.view()?.door;
    const event = {
      id: randomUUID(),
      at: now,
      kind,
      actor,
      source,
      sourceName,
      target,
      recipient,
      targetName,
      action,
      replyTo,
      interaction,
      ...(kind === "action" &&
        this.nearby(point, door) && {
          location: "小门附近",
        }),
      until:
        now +
        (kind === "arrival" ? policy.arrivalSeconds : policy.greetingSeconds) *
          1000,
      audience: new Set(audience.map(([, visit]) => visit)),
      opportunities,
      consumed: new Set(),
    };
    this.events.push(event);
    if (this.events.length > 240) this.events.shift();
    return event;
  }

  prune() {
    const earliest = this.now() - this.policy().recentMinutes * 60_000;
    this.events = this.events.filter(({ at }) => at > earliest);
  }

  opportunities(actor, visit, now) {
    this.prune();
    return this.events
      .filter(
        (event) =>
          event.opportunities.has(visit) &&
          now < event.until &&
          (!event.interaction ||
            (this.room.interaction?.id === event.interaction.id &&
              this.room.interaction?.stage === event.interaction.stage)) &&
          (event.kind === "departure" ||
            this.room.visits.get(event.actor) === event.source) &&
          (!event.target || this.room.visits.get(actor) === event.recipient),
      )
      .map(({ id, kind, target, until }) => ({
        id,
        kind,
        target,
        until,
        direct: target === actor,
      }))
      .sort((a, b) => Number(b.direct) - Number(a.direct));
  }

  consume(actor, visit, trigger) {
    if (!trigger) return;
    const eligible = new Set(
      this.opportunities(actor, visit, this.now()).map(({ id }) => id),
    );
    const events = this.events.filter(({ id }) => eligible.has(id));
    const root = events.find(({ id }) => id === trigger);
    if (!root) return;
    const mergeMs = this.policy().mergeSeconds * 1000;
    for (const event of events)
      if (
        event.id === trigger ||
        (event.kind === root.kind &&
          event.target === root.target &&
          Math.abs(event.at - root.at) <= mergeMs)
      ) {
        event.opportunities.delete(visit);
        event.consumed.add(visit);
      }
  }

  greeting(actor, visit, id) {
    const event = this.events.find((event) => event.id === id);
    if (
      event?.kind === "greeting" &&
      !event.replyTo &&
      event.target === actor &&
      event.recipient === visit &&
      event.until > this.now() &&
      this.room.visits.get(event.actor) === event.source &&
      !event.replied
    )
      return event;
  }

  incomingGreeting(actor, visit, from) {
    return this.events.findLast(
      (event) => event.actor === from && this.greeting(actor, visit, event.id),
    );
  }

  context(actor, visit, trigger) {
    if (!this.room.publicEnabled() || !visit) return;
    this.prune();
    const point = this.position(actor, visit);
    const door = this.view()?.door;
    const relation = (position) => {
      if (!position) return;
      if (point && position.displayId !== point.displayId) return "另一块屏幕";
      if (door && this.nearby(position, door)) return "小门附近";
      if (point && position !== point && this.nearby(point, position))
        return "你附近";
      return position.pose === "sit" ? "坐着" : "在桌面上";
    };
    const latestAction = new Map();
    const mergeMs = this.policy().mergeSeconds * 1000;
    const visible = this.events
      .filter(({ audience }) => audience.has(visit))
      .reverse()
      .filter((event) => {
        if (event.kind !== "action") return true;
        const newer = latestAction.get(event.source);
        if (newer !== undefined && newer - event.at <= mergeMs) return false;
        latestAction.set(event.source, event.at);
        return true;
      })
      .reverse();
    const recent = visible
      .sort(
        (a, b) =>
          Number(a.id === trigger) - Number(b.id === trigger) || a.at - b.at,
      )
      .slice(-this.policy().recentLimit)
      .map((event) => ({
        id: event.id,
        kind: event.kind,
        actor: event.sourceName,
        actorId: event.actor,
        ...(event.action && { action: event.action }),
        ...(event.location && { location: event.location }),
        ...(event.target && {
          target: event.target === actor ? "你" : event.targetName,
        }),
        secondsAgo: Math.max(0, Math.floor((this.now() - event.at) / 1000)),
        ...(this.greeting(actor, visit, event.id) && { canReply: true }),
      }));
    return {
      ...(point && {
        self: {
          location: relation(point),
          pose: point.pose,
          facing: point.facing,
        },
      }),
      residents: this.room
        .here()
        .filter(({ id }) => id !== actor)
        .map(({ id, name }) => ({
          id,
          name,
          location: relation(this.position(id, this.room.visits.get(id))),
        })),
      recent,
    };
  }
}
