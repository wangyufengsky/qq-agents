import {
  DesktopActivity,
  DESKTOP_ACTIVITY_TIMEOUT,
} from "./desktop-activity.mjs";
import { DesktopPerception } from "./desktop-perception.mjs";
import { DesktopPublicActivity } from "./desktop-public-activity.mjs";
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
const INTERACTION_TTL = 10 * 60_000;
const interactionSteps = {
  approach: ["move", "wave"],
  wave: ["wave", "wave"],
  together: ["move", "sit"],
};

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
      this.activity = new DesktopActivity(
        runner.activityStarts,
        runner.activityMinutes,
      );
    this.visits = new Map();
    this.invites = new Map();
    this.foreground = null;
    this.activities = new Map();
    if (runner.publicPolicy) {
      this.publicActivity = new DesktopPublicActivity(
        runner.publicStarts,
        runner.publicPolicy,
        runner.activityMinutes,
      );
      this.perception = new DesktopPerception(
        this,
        runner.now,
        runner.publicPolicy,
      );
    }
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

  get active() {
    return this.foreground ?? this.activities.values().next().value;
  }

  publicEnabled() {
    return (
      this.runner.publicPolicy?.().enabled === true &&
      this.runner.publicAllowed()
    );
  }

  turnFor(actor) {
    return (
      this.activities.get(actor)?.turn ??
      (this.room.turn?.actor === actor ? this.room.turn : undefined)
    );
  }

  activityDue(visit) {
    return this.publicEnabled() && visit.publicActivity
      ? this.publicActivity.dueAt(visit)
      : this.activity.dueAt(visit);
  }

  resumeActivity() {
    if (!this.publicEnabled()) return;
    for (const visit of this.visits.values())
      this.publicActivity.resume(visit, this.runner.now());
  }

  get subjectActors() {
    return (
      this.runner.subjectActors ??
      (this.runner.subjectActor ? [this.runner.subjectActor] : [])
    );
  }

  get welcomesVisits() {
    return this.doorMode === "welcome" || this.doorMode === "always";
  }

  publishDoor() {
    for (const actor of this.subjectActors) {
      const open =
        !this.closed &&
        this.welcomesVisits &&
        this.room.members[actor] === "home" &&
        !this.knock;
      const mode = open ? this.doorMode : "off";
      const old = this.doors.get(actor);
      if (mode === old?.mode) continue;
      const epoch = (old?.epoch ?? 0) + 1;
      this.doors.set(actor, { mode, epoch });
      this.runner.setDoor(open, epoch, actor, mode === "always");
    }
  }

  receiveKnock(knock) {
    if (
      this.closed ||
      !this.welcomesVisits ||
      this.knock ||
      !this.subjectActors.includes(knock.actor) ||
      !this.supported.has(knock.actor) ||
      this.room.members[knock.actor] !== "home" ||
      knock.epoch !== this.doors.get(knock.actor)?.epoch ||
      knock.expiresAt <= Date.now()
    )
      return;
    const role = this.room.roles.find(({ id }) => id === knock.actor);
    this.handleVisitRequest(role, {
      ...knock,
      text: "申请来访，想来桌边坐一会儿。",
    });
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
      thinking: room.turn?.actor ?? null,
      ...(this.activity && {
        activityActor: this.activities.keys().next().value ?? null,
        activityActors: [...this.activities.keys()],
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

  addCandidates(excluded, first, addressed = [], messageId) {
    const candidates = this.here().filter(
      ({ id }) => id !== excluded && !this.qqDeferred.has(id),
    );
    if (first) {
      candidates.sort(
        (a, b) => Number(b.id === first) - Number(a.id === first),
      );
      const index = this.room.waiting.findIndex(
        ({ actor, windowTask }) => actor === first && !windowTask,
      );
      if (index > 0)
        this.room.waiting.unshift(this.room.waiting.splice(index, 1)[0]);
    }
    for (const { id } of candidates) {
      const resting =
        this.publicEnabled() &&
        this.publicActivity.resting(this.visits.get(id), this.runner.now());
      const direct = addressed.includes(id) && messageId !== undefined;
      if (resting && !direct) continue;
      const queued = this.room.waiting.find(({ actor }) => actor === id);
      if (queued && direct) queued.direct = messageId;
      if (direct && this.publicEnabled()) this.cancelActivity(id);
      if (!queued) {
        this.room.waiting.push({
          actor: id,
          ...(direct && { direct: messageId }),
        });
      }
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
      const previous = this.activities.get(role.id) ?? this.foreground;
      if (previous?.actor === role.id) await previous.done;
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
      startCursor: this.room.archiveSeq ?? this.room.sequence,
    });
    const visit = this.visits.get(role.id);
    this.activity?.arrive(visit, this.runner.now(), role.id);
    this.publicActivity?.arrive(visit, this.runner.now());
    this.perception?.add("arrival", role.id, {
      audiences: [...this.visits].filter(([id]) => id !== role.id),
      urgent: true,
    });
  }

  setDoorMode(mode, now = Date.now()) {
    if (
      !["off", "welcome", "always", "busy"].includes(mode) ||
      this.doorMode === mode
    )
      return;
    this.doorMode = mode;
    if (this.knock || this.opportunity)
      this.room.notice = this.welcomesVisits
        ? "门牌已切换，之前的来访申请已结束。"
        : mode === "busy"
          ? "正在忙，主动来访已暂停。"
          : "主动敲门已关闭。";
    this.opportunity?.controller.abort();
    this.knock = null;
    if (this.welcomesVisits)
      this.nextOpportunityAt = Math.max(
        this.nextOpportunityAt,
        now + OPPORTUNITY_GAP,
      );
    this.onChange();
  }

  handleVisitRequest(role, knock) {
    if (this.doorMode === "always") {
      if (invite(this.room, role)) this.admit(role);
      return;
    }
    this.knock = knock;
    this.room.notice = `${role.name}在门外等你。`;
  }

  async offerOpportunity({ now = Date.now(), trial = false } = {}) {
    if (
      this.closed ||
      this.subjectActors.length ||
      !this.welcomesVisits ||
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
          directVisit: this.doorMode === "always",
          session: randomUUID(),
          people: this.here().map(({ name }) => name),
        },
        controller.signal,
      );
      if (
        controller.signal.aborted ||
        this.closed ||
        !this.welcomesVisits ||
        this.room.members[role.id] !== "home" ||
        this.invites.has(role.id)
      )
        return;
      if (reply.action === "knock") {
        this.handleVisitRequest(role, {
          actor: role.id,
          text: reply.text,
          expiresAt: Date.now() + KNOCK_TTL,
        });
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
    const pendingTask = this.room.waiting.find(
      ({ windowTask }) => windowTask?.actor === role.id,
    )?.windowTask;
    if (!leave(this.room, role, Date.now(), self)) return;
    const peers =
      this.interaction?.stage >= 0 &&
      this.interaction.people.some(({ id }) => id === role.id)
        ? new Set(this.interaction.people.map(({ id }) => id))
        : new Set();
    this.perception?.add("departure", role.id, {
      audiences: [...this.visits].filter(([id]) => id !== role.id),
      urgentActors: peers,
    });
    this.cancelInteraction(role.id);
    pendingTask?.finish("inactive");
    if (this.active?.windowTask?.actor === role.id)
      this.cancelWindowTask(this.active.windowTask);
    this.visits.delete(role.id);
    this.cancelActivity(role.id);
    this.onChange();
    void this.advance();
  }

  send(text, attachments = []) {
    const pendingTask = this.room.waiting.find(
      ({ windowTask }) => windowTask,
    )?.windowTask;
    if (this.closed || !speak(this.room, text, Date.now(), false, attachments))
      return false;
    pendingTask?.finish("inactive");
    if (this.active?.windowTask) this.cancelWindowTask(this.active.windowTask);
    if (!this.publicEnabled()) this.cancelActivity();
    this.qqDeferred.clear();
    const named = this.here().find(({ name, title }) =>
      [name, title].some((value) => text.includes(`@${value}`)),
    );
    const message = this.room.messages.at(-1);
    const addressed = message.targets ?? [];
    this.addCandidates(
      null,
      addressed[0] ?? named?.id,
      addressed,
      message.messageId,
    );
    this.onChange();
    void this.advance();
    return true;
  }

  sendWindowTask(task) {
    if (
      this.closed ||
      !this.room.budget ||
      !this.visits.has(task.actor) ||
      !task.current()
    )
      return false;
    this.room.waiting.push({ actor: task.actor, windowTask: task });
    this.cancelActivity(this.publicEnabled() ? task.actor : undefined);
    this.onChange();
    void this.advance();
    return true;
  }

  cancelWindowTask(task) {
    this.room.waiting = this.room.waiting.filter(
      ({ windowTask }) => windowTask !== task,
    );
    if (this.active?.windowTask === task)
      this.active.controller.abort(Error("DESKTOP_VISIT_UNAVAILABLE"));
  }

  tick(now = Date.now()) {
    if (refreshIfDue(this.room, now)) this.onChange();
    if (this.knock && now >= this.knock.expiresAt) this.answerKnock(false);
    if (this.welcomesVisits && now >= this.nextOpportunityAt)
      void this.offerOpportunity({ now });
  }

  cancelActivity(actor) {
    for (const active of this.activities.values())
      if (actor === undefined || active.actor === actor)
        active.controller.abort(Error("DESKTOP_VISIT_UNAVAILABLE"));
  }

  pauseActivity(paused) {
    if (!this.activity) return;
    this.activity.paused = paused;
    if (paused) {
      this.cancelInteraction();
      this.cancelActivity();
    } else this.resumeActivity();
    this.onChange();
  }

  canInteract(actor) {
    return (
      !this.closed &&
      !this.activity.paused &&
      this.visits.has(actor) &&
      this.runner.interactionCurrent?.(actor)
    );
  }

  cancelInteraction(actor) {
    if (
      actor === undefined ||
      this.interaction?.people.some(({ id }) => id === actor)
    )
      this.interaction = undefined;
  }

  maintainInteraction() {
    const current = this.interaction;
    if (
      current &&
      (this.runner.now() >= current.expiresAt ||
        current.people.some(
          ({ id, visit }) =>
            this.visits.get(id) !== visit || !this.canInteract(id),
        ))
    )
      this.cancelInteraction();
    return this.interaction;
  }

  interactionFor(actor) {
    if (!this.canInteract(actor)) return;
    const current = this.maintainInteraction();
    if (!current) {
      const recipients = this.here()
        .filter(({ id }) => id !== actor && this.canInteract(id))
        .map(({ id, name }) => ({ id, name }));
      if (recipients.length) return { recipients };
      return;
    }
    const [proposer, recipient] = current.people;
    if (current.stage === -1 && actor === recipient.id) {
      const { id, kind } = current;
      return { offer: { id, kind, name: proposer.name } };
    }
    const step = this.interactionStep(actor, current.id);
    if (step) {
      const { id, kind } = current;
      return { step: { id, kind, action: step.step, name: step.peer.name } };
    }
  }

  interactionStep(actor, id) {
    const current = this.maintainInteraction();
    if (
      !current ||
      current.id !== id ||
      current.people[current.stage]?.id !== actor
    )
      return;
    return {
      kind: current.kind,
      peer: current.people[1 - current.stage],
      step: interactionSteps[current.kind][current.stage],
    };
  }

  interruptInteractionMovement(actor) {
    if (this.interaction?.stage >= 0) this.cancelInteraction(actor);
  }

  finishInteraction(actor, opportunity, decision, receipt, visits) {
    if (!opportunity) return;
    const current = this.maintainInteraction();
    if (opportunity.step && current?.id === opportunity.step.id) {
      if (receipt?.status === "completed" && current.stage === 0) {
        current.stage = 1;
        this.queueInteractionStep(current);
      } else this.cancelInteraction();
      return;
    }
    if (opportunity.offer && current?.id === opportunity.offer.id) {
      if (decision?.action === "accept") {
        current.stage = 0;
        current.expiresAt = this.runner.now() + INTERACTION_TTL;
        this.queueInteractionStep(current);
      } else this.cancelInteraction();
      return;
    }
    if (
      current ||
      decision?.action !== "propose" ||
      !this.canInteract(actor) ||
      !this.canInteract(decision.recipient) ||
      this.visits.get(decision.recipient) !== visits.get(decision.recipient)
    )
      return;
    this.interaction = {
      id: randomUUID(),
      kind: decision.kind,
      // A visit object cannot be reused by a character who leaves and returns.
      people: [actor, decision.recipient].map((id) => ({
        id,
        name: this.room.roles.find((role) => role.id === id).name,
        visit: this.visits.get(id),
      })),
      stage: -1,
      expiresAt:
        this.runner.now() +
        (this.publicEnabled()
          ? this.runner.publicPolicy().greetingSeconds * 1000
          : INTERACTION_TTL),
    };
    this.perception?.add("invitation", actor, {
      target: decision.recipient,
      action: decision.kind,
      urgent: true,
      interaction: { id: this.interaction.id, stage: -1 },
    });
  }

  queueInteractionStep(interaction) {
    if (!this.publicEnabled()) return;
    const [next, peer] =
      interaction.stage === 0
        ? interaction.people
        : [...interaction.people].reverse();
    this.perception.add("interaction-step", peer.id, {
      target: next.id,
      action: interaction.kind,
      urgent: true,
      interaction: { id: interaction.id, stage: interaction.stage },
    });
  }

  noteOwnerTouch(visit, kind) {
    (visit.ownerTouches ??= new Map()).set(kind, {
      until: this.runner.now() + 30 * 60_000,
    });
  }

  ownerTouchInput(visit) {
    const touches = visit.ownerTouches
      ? [...visit.ownerTouches].filter(
          ([, touch]) => touch.until > this.runner.now(),
        )
      : [];
    return {
      ownerTouches: touches.map(([kind]) => kind),
      seenTouches: () => {
        for (const [kind, touch] of touches)
          if (visit.ownerTouches.get(kind) === touch)
            visit.ownerTouches.delete(kind);
      },
    };
  }

  observationWaiting(actor, ready) {
    if (!ready) return { reason: "target" };
    const state = this.visits.get(actor)?.publicActivity;
    const now = this.runner.now();
    if (state?.rest > now) return { reason: "rest", until: state.rest };
    if (state?.wait > now) return { reason: "wait", until: state.wait };
    if (
      this.foreground?.actor === actor ||
      this.room.waiting.some((entry) => entry.actor === actor)
    )
      return { reason: "chat" };
    if (this.publicEnabled() && !this.publicActivity.hasIdleBudget(actor, now))
      return { reason: "quota" };
  }

  async advanceActivity(now) {
    if (!this.activity || this.closed || this.activity.paused) return;
    if (!this.publicEnabled()) {
      if (this.active || this.room.turn || this.room.waiting.length) return;
      const turn = this.activity.next(
        this.room.roles,
        this.visits,
        now,
        this.runner.activity,
      );
      if (turn) await this.runActivity(turn);
      return;
    }

    const jobs = [];
    for (const [actor, visit] of this.visits) {
      if (this.activities.has(actor)) continue;
      if (
        this.foreground?.actor === actor ||
        this.room.waiting.some((entry) => entry.actor === actor) ||
        !this.runner.activity(actor)
      ) {
        this.publicActivity.resume(visit, now);
        continue;
      }
      const events = this.perception.opportunities(actor, visit, now);
      const grant = this.runner.observation?.(actor)?.grant;
      const interaction = this.interactionFor(actor);
      const extra =
        grant?.opportunity === "waiting" &&
        !interaction?.offer &&
        !interaction?.step;
      const turn = this.publicActivity.take(actor, visit, now, events, extra);
      if (!turn) continue;
      this.perception.consume(actor, visit, turn.trigger);
      jobs.push(this.runActivity(turn));
    }
    void this.advance();
    await Promise.all(jobs);
  }

  async runActivity(turn) {
    const publicTurn = Object.hasOwn(turn, "idle");
    const visit = this.visits.get(turn.actor);
    if (publicTurn) delete visit.activity.pendingReason;
    const observationOffer = this.runner.observation?.(turn.actor);
    let observation =
      observationOffer?.direct && !turn.trigger
        ? observationOffer.grant
        : undefined;
    const interaction = observation
      ? undefined
      : this.interactionFor(turn.actor);
    const interactionVisits = interaction?.recipients && new Map(this.visits);
    const offer =
      interaction?.offer || interaction?.step || turn.trigger
        ? undefined
        : observationOffer;
    const display = offer?.grant.scope === "display" ? offer.grant : undefined;
    const once = display?.opportunity === "waiting";
    const offered = () =>
      this.runner.observation?.(turn.actor)?.grant === display;
    let interactionDecision, interactionReceipt, activityReply;
    let completed = false;
    let acted = false;
    const controller = new AbortController();
    const { promise: done, resolve: drained } = Promise.withResolvers();
    const active = {
      turn,
      actor: turn.actor,
      kind: turn.kind,
      observation,
      controller,
      done,
    };
    this.activities.set(turn.actor, active);
    const isCurrent = () =>
      !this.closed &&
      !this.activity.paused &&
      this.visits.get(turn.actor) === visit &&
      this.activities.get(turn.actor) === active &&
      (!publicTurn || this.publicEnabled()) &&
      this.runner.activityCurrent(turn.actor);
    this.onChange();
    try {
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(DESKTOP_ACTIVITY_TIMEOUT),
      ]);
      const run = () => {
        const { ownerTouches, seenTouches } = this.ownerTouchInput(visit);
        return this.runner.run(
          {
            ...turn,
            observation,
            interaction: observation ? undefined : interaction,
            observationAvailable: Boolean(offer && !observation),
            observationChoice: Boolean(display && !observation),
            ownerTouches,
            onInputSubmitted: () => {
              seenTouches();
              if (
                !observation &&
                once &&
                display.opportunity === "waiting" &&
                offered()
              )
                display.opportunity = "deciding";
            },
            ...(offer?.grant.scope === "display" && {
              observationTarget: "display",
            }),
            canObserve: () =>
              !acted &&
              this.runner.observation?.(turn.actor)?.grant === offer?.grant,
            people: this.here().map(({ name }) => name),
            messages: [],
            ...(publicTurn && {
              publicContext: this.perception.context(
                turn.actor,
                visit,
                turn.trigger,
              ),
              heard: this.runner.heard(turn.actor, visit.startCursor),
              activityPolicy: this.runner.publicPolicy(),
            }),
            isCurrent,
            onBodyResult: (result) => {
              acted = true;
              if (!observation)
                this.activity.finish(visit, { lastResult: result });
            },
            onInteractionResult: (result) => {
              interactionReceipt = result;
            },
          },
          signal,
          isCurrent,
        );
      };
      let reply = await run();
      if (display && offered() && isCurrent() && !signal.aborted) {
        if (reply.action === "skip-observation")
          display.opportunity = "declined";
        else if (
          once &&
          display.opportunity === "deciding" &&
          reply.action !== "observe"
        )
          display.opportunity = "incomplete";
      }
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
        if (display) display.opportunity = "capturing";
        active.observation = observation;
        this.onChange();
        reply = await run();
      }
      if (!isCurrent() || signal.aborted) return;
      if (observation) this.runner.finishObservation?.(observation, reply);
      else interactionDecision = reply.interaction;
      completed = !observation && reply.action !== "leave";
      if (publicTurn) activityReply = reply;
      else this.activity.finish(visit, { reply, now: this.runner.now() });
      if (reply.action === "leave")
        this.leave(
          this.room.roles.find(({ id }) => id === turn.actor),
          true,
        );
    } catch {
      // Admission was already counted; a failure must wait for the next cooldown.
    } finally {
      if (
        display?.opportunity === "deciding" ||
        display?.opportunity === "capturing"
      )
        display.opportunity = "incomplete";
      this.finishInteraction(
        turn.actor,
        interaction,
        interactionDecision,
        completed ? interactionReceipt : undefined,
        interactionVisits,
      );
      if (publicTurn)
        this.publicActivity.finish(
          turn.actor,
          visit,
          turn,
          this.runner.now(),
          activityReply,
        );
      this.activities.delete(turn.actor);
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
    if (
      this.closed ||
      this.foreground ||
      (!this.publicEnabled() && this.activities.size)
    )
      return;
    this.room.waiting = this.room.waiting.filter(
      ({ actor, direct, windowTask }) => {
        if (
          this.publicEnabled() &&
          this.publicActivity.resting(
            this.visits.get(actor),
            this.runner.now(),
          ) &&
          !direct &&
          !windowTask
        )
          return false;
        if (this.room.budget && (!windowTask || windowTask.current()))
          return true;
        windowTask?.finish("inactive");
        return false;
      },
    );
    if (this.publicEnabled()) {
      const ready = this.room.waiting.findIndex(
        ({ actor }) =>
          !this.activities.has(actor) && this.runner.chatReady(actor),
      );
      if (ready < 0) return;
      if (ready > 0)
        this.room.waiting.unshift(this.room.waiting.splice(ready, 1)[0]);
    }
    const turn = startTurn(this.room);
    if (!turn) return;
    const actor = turn.actor;
    const { windowTask } = turn;
    const visit = this.visits.get(actor);
    const session = windowTask ? undefined : this.sessionFor(actor);
    const controller = new AbortController();
    const { promise: done, resolve: drained } = Promise.withResolvers();
    this.foreground = { actor, controller, done, windowTask };
    const isCurrent = () =>
      this.visits.get(actor) === visit &&
      (!windowTask || (this.room.turn === turn && windowTask.current()));
    this.onChange();
    try {
      const resting =
        this.publicEnabled() &&
        this.publicActivity.resting(visit, this.runner.now());
      const archived = windowTask
        ? []
        : this.room.opening?.(actor, visit.cursor);
      const { messages, through } = archived
        ? {
            messages: archived,
            through: archived.at(-1)?.roomSeq ?? visit.cursor,
          }
        : this.context(visit.cursor);
      const { ownerTouches, seenTouches } = this.ownerTouchInput(visit);
      const reply = await this.runner.run(
        {
          actor,
          kind: "chat",
          ...(!windowTask && { ownerTouches }),
          session,
          windowTask,
          people: this.here().map(({ name }) => name),
          messages,
          ...(this.publicEnabled() &&
            !windowTask && {
              publicContext: this.perception.context(actor, visit),
              resting,
            }),
          onInputSubmitted: () => {
            if (!windowTask) {
              visit.cursor = Math.max(visit.cursor, through);
              seenTouches();
            }
          },
          isCurrent,
        },
        controller.signal,
        () => isCurrent() && this.room.turn === turn,
      );
      if (controller.signal.aborted || this.closed || !isCurrent()) return;
      if (!windowTask && !this.room.publishMessage)
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
      if (reply.action === "say" && !windowTask)
        this.addCandidates(actor, this.room.messages.at(-1)?.targets?.[0]);
    } catch (error) {
      if (!windowTask && error.desktopSessionUntouched !== true)
        this.retire(actor, session);
      if (
        !controller.signal.aborted &&
        !this.closed &&
        this.visits.get(actor) === visit &&
        this.room.turn === turn
      ) {
        finishTurn(this.room, turn, Date.now(), "");
        if (windowTask) return;
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
      if (windowTask && this.room.turn === turn) this.room.turn = null;
      this.foreground = null;
      if (windowTask)
        windowTask.finish(
          Object.hasOwn(windowTask, "failure")
            ? windowTask.failure
            : "action-unconfirmed",
        );
      drained();
      this.onChange();
      void this.advance();
    }
  }

  close() {
    this.closed = true;
    this.cancelInteraction();
    this.foreground?.controller.abort();
    this.cancelActivity();
    this.opportunity?.controller.abort();
    for (const { controller } of this.invites.values()) controller.abort();
    return this.runner.close();
  }
}
