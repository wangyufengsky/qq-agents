import { randomUUID } from "node:crypto";
import {
  addMessage,
  arrive,
  cancelInvite,
  decline,
  finishTurn,
  invite,
  leave,
  refreshIfDue,
  setIntervalMinutes,
  speak,
  startTurn,
} from "./desktop-room-state.mjs";

const OPPORTUNITY_GAP = 30 * 60_000;
const KNOCK_TTL = 5 * 60_000;

export class LiveRoom {
  constructor(room, runner, onChange) {
    this.room = room;
    this.runner = runner;
    this.doors = new Map();
    this.onChange = () => {
      this.publishDoor();
      onChange();
    };
    runner.onKnock?.((knock) => this.receiveKnock(knock));
    this.supported = new Set(runner.roles);
    this.sessions = new Map();
    this.visits = new Map();
    this.invites = new Map();
    this.active = null;
    this.qqDeferred = new Set();
    this.closed = false;
    this.doorMode = "off";
    this.nextOpportunityAt = 0;
    this.opportunityIndex = 0;
    this.opportunity = null;
    this.knock = null;
    runner.ready?.then(
      (ids) => {
        if (this.closed) return;
        this.supported = new Set(ids);
        this.onChange();
      },
      () => this.onChange(),
    );
  }

  get subjectActors() {
    return (
      this.runner.subjectActors ??
      (this.runner.subjectActor ? [this.runner.subjectActor] : [])
    );
  }

  publishDoor() {
    for (const actor of this.subjectActors) {
      const open =
        !this.closed &&
        this.doorMode === "welcome" &&
        this.room.members[actor] === "home" &&
        !this.knock;
      const old = this.doors.get(actor);
      if (open === old?.open) continue;
      const epoch = (old?.epoch ?? 0) + 1;
      this.doors.set(actor, { open, epoch });
      this.runner.setDoor(open, epoch, actor);
    }
  }

  receiveKnock(knock) {
    if (
      this.closed ||
      this.doorMode !== "welcome" ||
      this.knock ||
      !this.subjectActors.includes(knock.actor) ||
      this.room.members[knock.actor] !== "home" ||
      knock.epoch !== this.doors.get(knock.actor)?.epoch ||
      knock.expiresAt <= Date.now()
    )
      return;
    const role = this.room.roles.find(({ id }) => id === knock.actor);
    this.knock = { ...knock, text: "申请来访，想来桌边坐一会儿。" };
    this.room.notice = `${role.name}在门外等你。`;
    this.onChange();
  }

  snapshot() {
    const { room } = this;
    return {
      live: true,
      subjectKnocks: this.subjectActors.length > 0,
      roles: room.roles.map(({ id, name, title, color, art }) => ({
        id,
        name,
        title,
        color,
        art: art ?? id,
        state: room.members[id],
        available: this.supported.has(id),
      })),
      doorMode: this.doorMode,
      knock: this.knock,
      messages: room.messages,
      budget: room.budget,
      maxTurns: room.maxTurns,
      minutes: room.minutes,
      nextRefill: room.nextRefill,
      thinking: room.turn?.actor ?? null,
      bubbles: room.bubbles,
      notice: room.notice,
    };
  }

  context(cursor) {
    return this.room.messages
      .filter(({ id, actor }) => id > cursor && actor !== "system")
      .slice(-24)
      .map(({ actor, text }) => ({
        speaker:
          this.room.roles.find(({ id }) => id === actor)?.name ?? "管理员",
        text,
      }));
  }

  here() {
    return this.room.roles.filter(({ id }) => this.room.members[id] === "here");
  }

  addCandidates(excluded, first) {
    const candidates = this.here().filter(
      ({ id }) => id !== excluded && !this.qqDeferred.has(id),
    );
    const next = candidates.find(({ id }) => id === first);
    if (next) candidates.splice(candidates.indexOf(next), 1);
    if (next) candidates.unshift(next);
    for (const { id } of candidates) {
      if (!this.room.waiting.some(({ actor }) => actor === id))
        this.room.waiting.push({ actor: id });
    }
  }

  async invite(role) {
    if (
      this.closed ||
      !this.supported.has(role.id) ||
      this.knock?.actor === role.id
    )
      return;
    const pending = this.invites.get(role.id);
    if (pending) {
      if (!pending.controller.signal.aborted) {
        cancelInvite(this.room, role);
        pending.controller.abort();
        this.onChange();
      }
      return;
    }
    if (!invite(this.room, role)) return;
    const controller = new AbortController();
    this.invites.set(role.id, { controller });
    this.onChange();
    const session = this.sessionFor(role.id);
    try {
      if (this.active?.actor === role.id) await this.active.done;
      if (controller.signal.aborted || this.closed) return;
      const reply = await this.runner.run(
        {
          actor: role.id,
          kind: "invitation",
          session,
          people: this.here().map(({ name }) => name),
        },
        controller.signal,
      );
      if (controller.signal.aborted || this.closed) return;
      if (reply.action === "accept") this.admit(role);
      else decline(this.room, role);
    } catch (error) {
      if (error.desktopSessionUntouched !== true) this.retire(role.id, session);
      if (
        !controller.signal.aborted &&
        !this.closed &&
        decline(this.room, role)
      )
        this.room.notice = `${role.name}暂时无法回应邀请。`;
    } finally {
      this.invites.delete(role.id);
      this.onChange();
    }
  }

  admit(role) {
    if (!arrive(this.room, role)) return;
    // Drop a pending reply addressed to the previous audience. The role's
    // own transcript stays intact, and a new guest starts at this cursor.
    this.room.waiting = [];
    this.room.turn = null;
    for (const visit of this.visits.values()) visit.cursor = this.room.sequence;
    this.visits.set(role.id, { cursor: this.room.sequence });
  }

  setDoorMode(mode, now = Date.now()) {
    if (!["off", "welcome", "busy"].includes(mode) || this.doorMode === mode)
      return;
    this.doorMode = mode;
    if (mode === "welcome") {
      this.nextOpportunityAt = Math.max(
        this.nextOpportunityAt,
        now + OPPORTUNITY_GAP,
      );
    } else {
      if (this.knock || this.opportunity)
        this.room.notice =
          mode === "busy" ? "正在忙，主动来访已暂停。" : "主动敲门已关闭。";
      this.opportunity?.controller.abort();
      this.knock = null;
    }
    this.onChange();
  }

  async offerOpportunity({ now = Date.now(), trial = false } = {}) {
    if (
      this.closed ||
      this.subjectActors.length ||
      this.doorMode !== "welcome" ||
      this.knock ||
      this.opportunity ||
      this.active ||
      (!trial && now < this.nextOpportunityAt) ||
      (trial &&
        this.lastOpportunityAt !== undefined &&
        now - this.lastOpportunityAt < OPPORTUNITY_GAP)
    )
      return;
    const candidates = this.room.roles.filter(
      ({ id }) =>
        this.supported.has(id) &&
        this.room.members[id] === "home" &&
        !this.invites.has(id),
    );
    if (!candidates.length) return;
    const role = candidates[this.opportunityIndex++ % candidates.length];
    const controller = new AbortController();
    this.lastOpportunityAt = now;
    this.nextOpportunityAt = now + OPPORTUNITY_GAP;
    this.opportunity = { actor: role.id, controller };
    this.onChange();
    try {
      const reply = await this.runner.run(
        {
          actor: role.id,
          kind: "opportunity",
          session: randomUUID(),
          people: this.here().map(({ name }) => name),
        },
        controller.signal,
      );
      if (
        controller.signal.aborted ||
        this.closed ||
        this.doorMode !== "welcome" ||
        this.room.members[role.id] !== "home" ||
        this.invites.has(role.id)
      )
        return;
      if (reply.action === "knock") {
        this.knock = {
          actor: role.id,
          text: reply.text,
          expiresAt: Date.now() + KNOCK_TTL,
        };
        this.room.notice = `${role.name}在门外等你。`;
      } else if (trial) this.room.notice = `${role.name}这次选择在家休息。`;
    } catch {
      if (trial && !controller.signal.aborted && !this.closed)
        this.room.notice = `${role.name}暂时无法决定是否来访。`;
    } finally {
      this.opportunity = null;
      this.onChange();
    }
  }

  answerKnock(accept) {
    const knock = this.knock;
    if (!knock) return;
    this.knock = null;
    const role = this.room.roles.find(({ id }) => id === knock.actor);
    if (
      accept &&
      this.doorMode === "welcome" &&
      Date.now() < knock.expiresAt &&
      invite(this.room, role)
    )
      this.admit(role);
    else this.room.notice = `${role.name}这次先回去了。`;
    this.onChange();
  }

  sessionFor(id) {
    if (!this.runner.retire) return;
    if (!this.sessions.has(id)) this.sessions.set(id, randomUUID());
    return this.sessions.get(id);
  }

  retire(id, session) {
    this.runner.retire?.(id, session);
    if (this.sessions.get(id) === session) this.sessions.delete(id);
  }

  leave(role, self = false) {
    if (!leave(this.room, role, Date.now(), self)) return;
    this.visits.delete(role.id);
    this.onChange();
    void this.advance();
  }

  send(text) {
    if (this.closed || !speak(this.room, text, Date.now(), false)) return;
    this.qqDeferred.clear();
    const named = this.here().find(({ name, title }) =>
      [name, title].some((value) => text.includes(`@${value}`)),
    );
    this.addCandidates(null, named?.id);
    this.onChange();
    void this.advance();
  }

  tick(now = Date.now()) {
    if (refreshIfDue(this.room, now)) this.onChange();
    if (this.knock && now >= this.knock.expiresAt) this.answerKnock(false);
    if (this.doorMode === "welcome" && now >= this.nextOpportunityAt)
      void this.offerOpportunity({ now });
  }

  interval(minutes) {
    setIntervalMinutes(this.room, minutes);
    this.onChange();
  }

  async advance() {
    if (this.closed || this.active) return;
    if (!this.room.budget) this.room.waiting = [];
    const turn = startTurn(this.room);
    if (!turn) return;
    const actor = turn.actor;
    const visit = this.visits.get(actor);
    const session = this.sessionFor(actor);
    const controller = new AbortController();
    const { promise: done, resolve: drained } = Promise.withResolvers();
    this.active = { actor, controller, done };
    const cursor = this.room.sequence;
    this.onChange();
    try {
      const reply = await this.runner.run(
        {
          actor,
          kind: "chat",
          session,
          people: this.here().map(({ name }) => name),
          messages: this.context(visit.cursor),
        },
        controller.signal,
        () => this.visits.get(actor) === visit && this.room.turn === turn,
      );
      if (
        controller.signal.aborted ||
        this.closed ||
        this.visits.get(actor) !== visit
      )
        return;
      visit.cursor = Math.max(visit.cursor, cursor);
      if (
        !finishTurn(
          this.room,
          turn,
          Date.now(),
          reply.action === "say" ? reply.text : "",
        )
      )
        return;
      if (reply.action === "leave")
        this.leave(
          this.room.roles.find(({ id }) => id === actor),
          true,
        );
      if (reply.action === "say") this.addCandidates(actor);
    } catch (error) {
      if (error.desktopSessionUntouched !== true) this.retire(actor, session);
      if (
        !controller.signal.aborted &&
        !this.closed &&
        this.visits.get(actor) === visit &&
        this.room.turn === turn
      ) {
        finishTurn(this.room, turn, Date.now(), "");
        const role = this.room.roles.find(({ id }) => id === actor);
        if (error.message === "DESKTOP_QQ_PRIORITY") {
          this.qqDeferred.add(actor);
          this.room.waiting = this.room.waiting.filter(
            (item) => item.actor !== actor,
          );
          addMessage(
            this.room,
            "system",
            `${role.name}先去处理 QQ 消息，仍坐在桌边。`,
          );
        } else
          addMessage(this.room, "system", `${role.name}这轮暂时没有连上。`);
      }
    } finally {
      this.active = null;
      drained();
      this.onChange();
      void this.advance();
    }
  }

  close() {
    this.closed = true;
    this.active?.controller.abort();
    this.opportunity?.controller.abort();
    for (const { controller } of this.invites.values()) controller.abort();
    return this.runner.close();
  }
}
