import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { containsCredential } from "../core/secrets.mjs";
import { DesktopVisits } from "./desktop-visits.mjs";
import { LiveRoom } from "./desktop-room.mjs";
import { createRoom, roles as art } from "./desktop-room-state.mjs";
import { decisionTool, promptFor, readDecision } from "./desktop-decision.mjs";

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
    this.scopes = new Map();
    this.sessions = new Map();
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
    this.visits.get(id)?.finishSubject(id, completed);
  }
  interrupt(id) {
    this.visits.get(id)?.interrupt(id);
  }
  claimQq(id, conversation) {
    return this.visits.get(id)?.claimQq(id, conversation);
  }

  available() {
    return (
      !this.runtime.closed &&
      this.runtime.config.mode === "live" &&
      !this.runtime.config.globalPaused &&
      !this.runtime.maintenance.active &&
      !this.runtime.updateMaintenance
    );
  }

  connected() {
    return (
      this.configured() &&
      this.available() &&
      this.client?.expiresAt > this.runtime.now()
    );
  }

  refresh() {
    const now = this.runtime.now();
    if (!this.configured() || !this.available()) {
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
    if (this.live) {
      for (const role of roles) {
        if (this.runtime.blockers(this.runtime.agent(role.id)).length) {
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
        run: (request, signal) => this.run(request, signal),
        retire: (actor, session) => this.retire(actor, session),
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
    for (const id of this.sessions.keys()) this.retire(null, id);
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
    this.client.expiresAt = this.runtime.now() + CLIENT_LEASE;
    const { live } = this;
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

  retire(_actor, session) {
    const backend = this.sessions.get(session);
    this.sessions.delete(session);
    if (backend)
      this.runtime.trackWork(
        backend.closeSocialSessions({ windowId: session }).catch(() => {}),
      );
  }

  async run(request, signal) {
    const task = this.runModel(request, signal);
    return this.runtime.trackWork(task);
  }

  async runModel(request, signal) {
    const { actor, kind, session } = request;
    const runtime = this.runtime;
    const agent = runtime.agent(actor);
    const current = this.live;
    const controller = new AbortController();
    const combined = AbortSignal.any([
      signal,
      controller.signal,
      AbortSignal.timeout(85_000),
    ]);
    const check = () => {
      combined.throwIfAborted();
      if (
        this.live !== current ||
        !this.configured() ||
        runtime.blockers(agent).length
      )
        throw Error("DESKTOP_VISIT_UNAVAILABLE");
    };
    check();
    const release = this.visit(actor).beginDesktop(controller);
    const capability = randomBytes(32).toString("base64url");
    try {
      const backend = runtime.backendConnections.adapter(agent);
      if (!backend.runDesktop) throw Error("DESKTOP_VISIT_UNAVAILABLE");
      if (kind === "chat") this.sessions.set(session, backend);
      let decision;
      const call = (name, args) => {
        check();
        if (name !== decisionTool.function.name || decision)
          throw Error("DESKTOP_DECISION_DENIED");
        const next = readDecision(kind, args);
        if (
          !next ||
          (next.text &&
            (containsCredential(next.text) || next.text.includes(capability)))
        )
          throw Error("DESKTOP_DECISION_INVALID");
        decision = next;
        return { content: [{ type: "text", text: "已记录本回合的决定。" }] };
      };
      this.scopes.set(capability, { check, call });
      await backend.runDesktop({
        binding: {
          runId: randomUUID(),
          windowId: kind === "chat" ? session : null,
          actorIdentity: { generation: actor },
          target: { kind: "desktop-room" },
        },
        budget: null,
        signal: combined,
        instructions: `${agent.persona}\n你在独立的桌面小窝回合中。只用本轮桌面决定工具行动，房间资料只用于桌面聊天。`,
        prompt: promptFor(request),
        tools: [decisionTool],
        beforeInput: check,
        onRunStarted: check,
        maxToolResultBytes: 4096,
        callTool: call,
        socialContextToken: capability,
      });
      check();
      if (!decision) throw Error("DESKTOP_DECISION_MISSING");
      return decision;
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      throw error;
    } finally {
      this.scopes.delete(capability);
      release();
    }
  }

  bridge(capability, path, input) {
    const scope = this.scopes.get(capability);
    if (!scope) throw Error("INVALID_CAPABILITY");
    scope.check();
    if (path === "/agent/tools") return scope.call(input.name, input.arguments);
    const { name, description, parameters } = decisionTool.function;
    if (
      input.names &&
      (!Array.isArray(input.names) || input.names.some((item) => item !== name))
    )
      throw Error("TOOL_DISABLED");
    return {
      tools:
        input.offset > 0
          ? []
          : [
              {
                name,
                description,
                ...(input.names ? { inputSchema: parameters } : {}),
              },
            ],
      total: 1,
      nextOffset: null,
    };
  }
}
