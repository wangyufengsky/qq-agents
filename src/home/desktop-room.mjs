import {
  DesktopActivity,
  DESKTOP_ACTIVITY_TIMEOUT,
} from "./desktop-activity.mjs";
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
    if (runner.activity)
      this.activity = new DesktopActivity(runner.activityStarts);
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
      roomEpoch: room.epoch,
      budget: room.budget,
      maxTurns: room.maxTurns,
      minutes: room.minutes,
      nextRefill: room.nextRefill,
      thinking:
        room.turn?.kind === "activity" ? null : (room.turn?.actor ?? null),
      ...(this.activity && {
        activityActor: room.turn?.kind === "activity" ? room.turn.actor : null,
        activityPaused: this.activity.paused,
      }),
      bubbles: room.bubbles,
      notice: room.notice,
    };
  }

  context(cursor) {
    const rows = this.room.messages
      .filter(({ id, speakerType }) => id > cursor && speakerType !== "system")
      .slice(0, 24);
    return {
      through: rows.at(-1)?.id ?? cursor,
      messages: rows.map(
        ({ actor, text, speaker, speakerType, attachments }) => ({
          speaker:
            speaker ??
            (speakerType === "administrator"
              ? "管理员"
              : (this.room.roles.find(({ id }) => id === actor)?.name ??
                actor)),
          text,
          ...(attachments?.length ? { attachments } : {}),
        }),
      ),
    };
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
    const session = this.runner.requestInvitation
      ? undefined
      : this.sessionFor(role.id);
    try {
      if (this.active?.actor === role.id) await this.active.done;
      if (controller.signal.aborted || this.closed) return;
      const reply = this.runner.requestInvitation
        ? await this.runner.requestInvitation(
            { actor: role.id },
            controller.signal,
          )
        : await this.runner.run(
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
      if (
        !this.runner.requestInvitation &&
        error.desktopSessionUntouched !== true
      )
        this.retire(role.id, session);
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
    // Only the newcomer starts at the current cursor. Messages already queued
    // for other participants still belong to their visits.
    this.visits.set(role.id, {
      cursor: this.room.archiveSeq ?? this.room.sequence,
    });
    this.activity?.arrive(this.visits.get(role.id), this.runner.now());
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
    if (this.active?.actor === role.id) this.cancelActivity();
    this.onChange();
    void this.advance();
  }

  send(text, attachments = []) {
    if (this.closed || !speak(this.room, text, Date.now(), false, attachments))
      return false;
    this.cancelActivity();
    this.qqDeferred.clear();
    const named = this.here().find(({ name, title }) =>
      [name, title].some((value) => text.includes(`@${value}`)),
    );
    this.addCandidates(null, named?.id);
    this.onChange();
    void this.advance();
    return true;
  }

  tick(now = Date.now()) {
    if (refreshIfDue(this.room, now)) this.onChange();
    if (this.knock && now >= this.knock.expiresAt) this.answerKnock(false);
    if (this.doorMode === "welcome" && now >= this.nextOpportunityAt)
      void this.offerOpportunity({ now });
  }

  cancelActivity() {
    if (this.active?.kind === "activity") {
      if (this.room.turn?.kind === "activity") this.room.turn = null;
      this.active.controller.abort(Error("DESKTOP_VISIT_UNAVAILABLE"));
    }
  }

  pauseActivity(paused) {
    if (!this.activity) return;
    this.activity.paused = paused;
    if (paused) this.cancelActivity();
    this.onChange();
  }

  async advanceActivity(now) {
    if (
      !this.activity ||
      this.closed ||
      this.active ||
      this.room.turn ||
      this.room.waiting.length
    )
      return;
    const turn = this.activity.next(
      this.room.roles,
      this.visits,
      now,
      this.runner.activity,
    );
    if (!turn) return;
    const visit = this.visits.get(turn.actor);
    const offer = this.runner.observation?.(turn.actor);
    let observation = offer?.direct ? offer.grant : undefined;
    let acted = false;
    const controller = new AbortController();
    const { promise: done, resolve: drained } = Promise.withResolvers();
    this.room.turn = turn;
    this.active = {
      actor: turn.actor,
      kind: turn.kind,
      observation,
      controller,
      done,
    };
    const isCurrent = () =>
      !this.closed &&
      !this.activity.paused &&
      this.visits.get(turn.actor) === visit &&
      this.room.turn === turn &&
      this.runner.activityCurrent(turn.actor);
    this.onChange();
    try {
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(DESKTOP_ACTIVITY_TIMEOUT),
      ]);
      const run = () =>
        this.runner.run(
          {
            ...turn,
            observation,
            observationAvailable: Boolean(offer && !observation),
            canObserve: () =>
              !acted &&
              this.runner.observation?.(turn.actor)?.grant === offer?.grant,
            people: this.here().map(({ name }) => name),
            messages: [],
            isCurrent,
            onBodyResult: (result) => {
              acted = true;
              if (!observation)
                this.activity.finish(visit, { lastResult: result });
            },
          },
          signal,
          isCurrent,
        );
      let reply = await run();
      if (reply.action === "observe") {
        if (
          !isCurrent() ||
          signal.aborted ||
          acted ||
          !offer ||
          this.runner.observation?.(turn.actor)?.grant !== offer.grant
        )
          return;
        observation = offer.grant;
        this.active.observation = observation;
        this.onChange();
        reply = await run();
      }
      if (!isCurrent() || signal.aborted) return;
      if (observation) this.runner.finishObservation?.(observation, reply);
      this.activity.finish(visit, { reply, now: this.runner.now() });
      if (reply.action === "leave")
        this.leave(
          this.room.roles.find(({ id }) => id === turn.actor),
          true,
        );
    } catch {
      // Admission was already counted; a failure must wait for the next cooldown.
    } finally {
      if (this.room.turn === turn) this.room.turn = null;
      this.active = null;
      drained();
      this.onChange();
      void this.advance();
    }
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
    this.onChange();
    try {
      const archived = this.room.opening?.(actor, visit.cursor);
      const { messages, through } = archived
        ? {
            messages: archived,
            through: archived.at(-1)?.roomSeq ?? visit.cursor,
          }
        : this.context(visit.cursor);
      const reply = await this.runner.run(
        {
          actor,
          kind: "chat",
          session,
          people: this.here().map(({ name }) => name),
          messages,
          onInputSubmitted: () => {
            visit.cursor = Math.max(visit.cursor, through);
          },
          isCurrent: () => this.visits.get(actor) === visit,
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
      if (!this.room.publishMessage)
        visit.cursor = Math.max(visit.cursor, through);
      if (
        !finishTurn(
          this.room,
          turn,
          Date.now(),
          reply.action === "say" ? reply.text : "",
          reply.turnId,
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
