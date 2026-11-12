import { z } from "zod";
import { SessionPreparationFailure } from "../backends/turn-failure.mjs";
import { recallBoundary } from "../core/recall-boundary.mjs";
import { containsCredential } from "../core/secrets.mjs";
import { DesktopVisits } from "./desktop-visits.mjs";
import { DesktopInvitations } from "./desktop-invitations.mjs";
import { LiveRoom } from "./desktop-room.mjs";
import { createRoom, roles as art } from "./desktop-room-state.mjs";
import { beginDesktopContext } from "./desktop-context.mjs";
import { DESKTOP_CONVERSATION, readDecision } from "./desktop-decision.mjs";

const requestSchema = z
  .object({
    client: z.string().uuid(),
    action: z.enum([
      "sync",
      "invite",
      "leave",
      "send",
      "door-mode",
      "knock-answer",
      "disconnect",
    ]),
    data: z.union([z.string().max(1000), z.boolean()]).optional(),
  })
  .strict();
const CLIENT_LEASE = 15_000;
const types = new Set(["codex", "antigravity", "dsh"]);

export class DesktopHost {
  constructor(runtime) {
    this.runtime = runtime;
    this.visits = new Map();
    this.invitations = new DesktopInvitations(this);
  }

  configured() {
    return this.runtime.config.desktopHome?.enabled === true;
  }

  backendFor(agent) {
    const backend = this.runtime.config.backends.find(
      ({ id }) => id === agent.backendId,
    );
    if (
      types.has(backend?.type) &&
      (backend.type !== "dsh" || backend.preset === "qq-unified")
    )
      return backend;
  }

  catalog() {
    return this.runtime.config.agents.flatMap((agent, index) => {
      const backend = this.backendFor(agent);
      if (!backend) return [];
      const style =
        art.find(({ id }) => id === agent.id) || art[index % art.length];
      return [
        {
          id: agent.id,
          name: agent.name,
          title: agent.name,
          color: style.color,
          art: style.id,
          contract: JSON.stringify([
            agent.connectionId,
            agent.persona,
            agent.model,
            agent.effort,
            backend,
          ]),
        },
      ];
    });
  }

  visit(id) {
    let value = this.visits.get(id);
    if (!value) {
      value = new DesktopVisits(this.runtime, id, (knock) =>
        this.live?.receiveKnock(knock),
      );
      this.visits.set(id, value);
    }
    return value;
  }

  allows(agent, conversation) {
    return (
      conversation === "@subject" &&
      this.configured() &&
      Boolean(this.backendFor(agent))
    );
  }

  doorStatus(id) {
    return this.visit(id).doorStatus();
  }
  request(ctx) {
    if (!this.allows(this.runtime.agent(ctx.agentId), ctx.conversation))
      throw Error("DESKTOP_VISIT_UNAVAILABLE");
    return this.visit(ctx.agentId).request(ctx);
  }
  finishSubject(id, completed) {
    this.invitations.finish(id, completed);
    this.visits.get(id)?.finishSubject(id, completed);
  }
  interrupt(id) {
    this.visits.get(id)?.interrupt(id);
  }
  claimQq(id, conversation) {
    return this.visits.get(id)?.claimQq(id, conversation);
  }

  operational() {
    return (
      !this.runtime.closed &&
      this.runtime.config.mode === "live" &&
      !this.runtime.config.globalPaused
    );
  }

  available(ctx) {
    return (
      this.operational() &&
      (!this.runtime.updateMaintenance || this.runtime.maintenance.allows(ctx))
    );
  }

  connected(ctx) {
    return (
      this.configured() &&
      this.available(ctx) &&
      this.client?.expiresAt > this.runtime.now()
    );
  }

  refresh() {
    const now = this.runtime.now();
    if (!this.configured() || !this.operational()) {
      this.reset();
      return false;
    }
    const roles = this.catalog();
    const policy = this.runtime.config.desktopHome;
    const signature = JSON.stringify(roles);
    if (
      this.client &&
      (now >= this.client.expiresAt || this.signature !== signature)
    )
      this.reset();
    // Maintenance keeps existing turn capabilities alive and stops admission.
    if (this.runtime.updateMaintenance) return Boolean(this.live);
    if (this.live) {
      for (const role of roles) {
        if (
          this.runtime.blockers(
            this.runtime.agent(role.id),
            DESKTOP_CONVERSATION,
          ).length
        ) {
          this.visits
            .get(role.id)
            ?.desktop?.controller.abort(Error("DESKTOP_VISIT_UNAVAILABLE"));
          this.live.leave(role);
        }
      }
      const room = this.live.room;
      if (room.maxTurns !== policy.maxTurns) {
        room.maxTurns = policy.maxTurns;
        room.budget = Math.min(room.budget, room.maxTurns);
      }
      if (room.minutes !== policy.refreshMinutes)
        this.live.interval(policy.refreshMinutes);
      for (const [id, message] of Object.entries(room.bubbles))
        if (now - message.now > 4900) delete room.bubbles[id];
      this.live.tick(now);
      this.invitations.dispatch();
    }
    return true;
  }

  open(client) {
    const roles = this.catalog();
    const policy = this.runtime.config.desktopHome;
    this.signature = JSON.stringify(roles);
    this.client = { id: client, expiresAt: this.runtime.now() + CLIENT_LEASE };
    const ids = roles.map(({ id }) => id);
    const room = createRoom(
      policy.refreshMinutes,
      this.runtime.now(),
      roles,
      policy.maxTurns,
    );
    this.live = new LiveRoom(
      room,
      {
        roles: ids,
        subjectActors: ids,
        requestInvitation: (request, signal) =>
          this.invitations.request(request, signal),
        run: (request, signal, canStart) => this.run(request, signal, canStart),
        setDoor: (open, epoch, actor) => this.visit(actor).setDoor(open, epoch),
        close: async () => {},
      },
      () => {},
    );
  }

  reset() {
    if (!this.live) return;
    const previous = this.live;
    this.live = null;
    this.client = null;
    for (const visit of this.visits.values()) visit.resetDoor();
    void previous.close();
  }

  command(input) {
    const parsed = requestSchema.safeParse(input);
    if (!parsed.success) throw Error("INVALID_REQUEST");
    const { client, action, data } = parsed.data;
    if (!this.refresh())
      return this.configured()
        ? { enabled: false }
        : { enabled: false, closed: true };
    if (this.client && this.client.id !== client)
      return { enabled: true, busy: true };
    if (action === "disconnect") {
      this.reset();
      return { enabled: true };
    }
    if (!this.client) {
      if (action !== "sync") return { enabled: true, reconnect: true };
      this.open(client);
    }
    if (!this.runtime.updateMaintenance || action === "sync")
      this.client.expiresAt = this.runtime.now() + CLIENT_LEASE;
    const { live } = this;
    if (this.runtime.updateMaintenance)
      return { enabled: true, room: live.snapshot() };
    const role = live.room.roles.find(({ id }) => id === data);
    if (action === "invite" && role) void live.invite(role);
    if (action === "leave" && role) live.leave(role);
    if (
      action === "send" &&
      typeof data === "string" &&
      !containsCredential(data)
    )
      live.send(data);
    if (action === "door-mode" && typeof data === "string")
      live.setDoorMode(data);
    if (action === "knock-answer" && typeof data === "boolean")
      live.answerKnock(data);
    return { enabled: true, room: live.snapshot() };
  }

  async run(request, signal, canStart) {
    const task = this.runModel(request, signal, canStart);
    return this.runtime.trackWork(task);
  }

  async runModel(request, signal, canStart) {
    const { actor, kind } = request;
    const runtime = this.runtime;
    const agent = runtime.agent(actor);
    const current = this.live;
    const controller = new AbortController();
    const external = AbortSignal.any([
      signal,
      AbortSignal.timeout(agent.behavior.turnTimeoutMs),
    ]);
    const abort = () => controller.abort(external.reason);
    if (external.aborted) abort();
    else external.addEventListener("abort", abort, { once: true });
    const check = () => {
      controller.signal.throwIfAborted();
      if (
        this.live !== current ||
        !this.connected(ctx) ||
        runtime.blockers(agent, DESKTOP_CONVERSATION, ctx).length
      )
        throw Error("DESKTOP_VISIT_UNAVAILABLE");
    };
    let ctx, release, exchange, failure, decision;
    const assertOutput = (text) => {
      if (!text) return;
      runtime.assertSafeOutput(ctx, text);
      recallBoundary(runtime, ctx, { publicOnly: true }).assert({
        evidence: [...ctx.privateRead],
      });
    };
    const key = actor + "|" + DESKTOP_CONVERSATION;
    const done = Promise.withResolvers();
    try {
      check();
      release = this.visit(actor).beginDesktop(controller);
      ctx = runtime.makeContext(actor, DESKTOP_CONVERSATION, {
        controller,
        assertCurrent: () => {
          check();
          if (request.isCurrent?.() === false)
            throw Error("DESKTOP_VISIT_UNAVAILABLE");
        },
        decide: (args) => {
          if (decision) throw Error("DESKTOP_DECISION_DENIED");
          const next = readDecision(kind, args);
          if (!next) throw Error("DESKTOP_DECISION_INVALID");
          assertOutput(next.text);
          decision = next;
          return { status: "recorded" };
        },
      });
      ctx.done = done.promise;
      runtime.running.set(key, ctx);
      const backend = runtime.backendConnections.adapter(agent);
      if (!backend.runDesktop) throw Error("DESKTOP_VISIT_UNAVAILABLE");
      exchange = beginDesktopContext(
        runtime,
        ctx,
        agent,
        backend,
        request,
        controller.signal,
      );
      await backend.runDesktop({
        ...exchange,
        binding: { runId: ctx.turnId },
        budget: null,
        signal: controller.signal,
        beforeInput: check,
        assertCanStart: () => {
          if (canStart && !canStart())
            throw new SessionPreparationFailure(
              Error("DESKTOP_VISIT_UNAVAILABLE"),
            );
        },
        onRunStarted: check,
        registerInputConsumer: (consume) => {
          ctx.desktopConsumeInput = consume;
        },
        maxToolResultBytes: 4096,
        socialContextToken: ctx.token,
      });
      check();
      if (request.isCurrent?.() === false) return { action: "silent" };
      if (!decision) throw Error("DESKTOP_DECISION_MISSING");
      assertOutput(decision.text);
      return decision;
    } catch (error) {
      failure = error;
      if (controller.signal.aborted) throw controller.signal.reason;
      throw error;
    } finally {
      try {
        if (ctx) runtime.capabilities.delete(ctx.token);
        if (exchange) await exchange.finish(failure);
      } finally {
        if (ctx && runtime.running.get(key) === ctx)
          runtime.running.delete(key);
        external.removeEventListener("abort", abort);
        release?.();
        done.resolve();
      }
    }
  }
}
