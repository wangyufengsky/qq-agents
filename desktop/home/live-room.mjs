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
  roles,
  setIntervalMinutes,
  speak,
  startTurn,
} from "./room.mjs";

export class LiveRoom {
  constructor(room, runner, onChange) {
    this.room = room;
    this.runner = runner;
    this.onChange = onChange;
    this.supported = new Set(runner.roles);
    this.audienceStart = 0;
    this.visits = new Map();
    this.invites = new Map();
    this.active = null;
    this.closed = false;
  }

  context(cursor) {
    return this.room.messages
      .filter(({ id, actor }) => id > cursor && actor !== "system")
      .slice(-24)
      .map(({ actor, text }) => ({
        speaker: roles.find(({ id }) => id === actor)?.name ?? "管理员",
        text,
      }));
  }

  here() {
    return roles.filter(({ id }) => this.room.members[id] === "here");
  }

  addCandidates(excluded, first) {
    const candidates = this.here().filter(({ id }) => id !== excluded);
    const next = candidates.find(({ id }) => id === first);
    if (next) candidates.splice(candidates.indexOf(next), 1);
    if (next) candidates.unshift(next);
    for (const { id } of candidates) {
      if (!this.room.waiting.some(({ actor }) => actor === id))
        this.room.waiting.push({ actor: id });
    }
  }

  async invite(role) {
    if (this.closed || !this.supported.has(role.id)) return;
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
    try {
      const reply = await this.runner.run(
        {
          actor: role.id,
          kind: "invitation",
          session: randomUUID(),
          people: this.here().map(({ name }) => name),
        },
        controller.signal,
      );
      if (controller.signal.aborted || this.closed) return;
      if (reply.action === "accept" && arrive(this.room, role)) {
        // A wider audience starts a fresh model context for everyone in the room.
        this.audienceStart = this.room.sequence;
        this.room.waiting = [];
        this.room.turn = null;
        this.active?.controller.abort();
        for (const [id, visit] of this.visits)
          this.runner.retire(id, visit.session);
        for (const { id } of this.here()) this.visits.set(id, this.newVisit());
      } else decline(this.room, role);
    } catch {
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

  newVisit() {
    return { session: randomUUID(), cursor: this.audienceStart };
  }

  resetVisit(id, visit) {
    this.runner.retire(id, visit.session);
    if (this.visits.get(id) === visit) this.visits.set(id, this.newVisit());
  }

  leave(role, self = false) {
    if (!leave(this.room, role, Date.now(), self)) return;
    if (this.active?.actor === role.id) this.active.controller.abort();
    const visit = this.visits.get(role.id);
    if (visit) this.runner.retire(role.id, visit.session);
    this.visits.delete(role.id);
    this.onChange();
    void this.advance();
  }

  send(text) {
    if (this.closed || !speak(this.room, text, Date.now(), false)) return;
    if (this.active) {
      this.active.controller.abort();
      this.resetVisit(this.active.actor, this.active.visit);
    }
    const named = this.here().find(({ name, title }) =>
      [name, title].some((value) => text.includes(`@${value}`)),
    );
    this.addCandidates(null, named?.id);
    this.onChange();
    void this.advance();
  }

  tick(now = Date.now()) {
    if (refreshIfDue(this.room, now)) this.onChange();
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
    const controller = new AbortController();
    this.active = { actor, visit, controller };
    const cursor = this.room.sequence;
    this.onChange();
    try {
      const reply = await this.runner.run(
        {
          actor,
          kind: "chat",
          session: visit.session,
          people: this.here().map(({ name }) => name),
          messages: this.context(visit.cursor),
        },
        controller.signal,
      );
      if (
        controller.signal.aborted ||
        this.closed ||
        this.visits.get(actor) !== visit
      )
        return;
      visit.cursor = cursor;
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
          roles.find(({ id }) => id === actor),
          true,
        );
      if (reply.action === "say") this.addCandidates(actor);
    } catch {
      if (
        !controller.signal.aborted &&
        !this.closed &&
        this.visits.get(actor) === visit
      ) {
        this.resetVisit(actor, visit);
        finishTurn(this.room, turn, Date.now(), "");
        const role = roles.find(({ id }) => id === actor);
        addMessage(this.room, "system", `${role.name}这轮暂时没有连上。`);
      }
    } finally {
      this.active = null;
      this.onChange();
      void this.advance();
    }
  }

  close() {
    this.closed = true;
    this.active?.controller.abort();
    for (const { controller } of this.invites.values()) controller.abort();
    return this.runner.close();
  }
}
