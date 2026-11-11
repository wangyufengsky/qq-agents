import { randomUUID } from "node:crypto";
import { inSilence } from "../core/config.mjs";

export const DESKTOP_VISIT_TOOL = "desktop_visit_request";
const COOLDOWN = 30 * 60_000;
const KNOCK_TTL = 5 * 60_000;
const isQq = (conversation) => /^(private|group):\d+$/.test(conversation);

export class DesktopVisits {
  constructor(runtime, agentId, notify) {
    this.runtime = runtime;
    this.agentId = agentId;
    this.notify = notify;
    this.door = { open: false, epoch: 0 };
    this.lastRequestAt = -Infinity;
    this.qqClaims = 0;
  }

  allows(agent, conversation) {
    return agent.id === this.agentId && conversation === "@subject";
  }

  setDoor(open, epoch) {
    if (epoch < this.door.epoch) return;
    this.door = { open, epoch };
  }

  resetDoor() {
    this.door = { open: false, epoch: 0 };
    this.pending = null;
  }

  doorStatus() {
    if (!this.door.open) return "暂不接待";
    if (this.runtime.now() - this.lastRequestAt < COOLDOWN)
      return "最近已申请过来访";
    return "管理员的桌面小窝此刻欢迎敲门。如果你自己想去坐一会儿，可用 desktop_visit_request 申请。";
  }

  request(ctx) {
    const agent = this.runtime.assertActive(ctx);
    if (
      !this.allows(agent, ctx.conversation) ||
      ctx.runtimeKind === "functional-agent"
    )
      throw Error("DESKTOP_VISIT_UNAVAILABLE");
    const now = this.runtime.now();
    if (
      !this.door.open ||
      inSilence(agent, this.runtime.clock()) ||
      this.runtime.maintenance.active
    )
      return { status: "door-unavailable" };
    if (now - this.lastRequestAt < COOLDOWN) return { status: "cooldown" };
    const knock = {
      id: randomUUID(),
      actor: this.agentId,
      epoch: this.door.epoch,
      expiresAt: now + KNOCK_TTL,
    };
    this.lastRequestAt = now;
    this.pending = knock;
    return { status: "requested", expiresAt: knock.expiresAt };
  }

  finishSubject(agentId, completed) {
    if (agentId !== this.agentId || !this.pending) return;
    const knock = this.pending;
    this.pending = null;
    const agent = this.runtime.config.agents.find(({ id }) => id === agentId);
    if (
      completed &&
      agent &&
      !inSilence(agent, this.runtime.clock()) &&
      this.door.open &&
      knock.epoch === this.door.epoch &&
      knock.expiresAt > this.runtime.now() &&
      this.runtime.writable(agent, "@subject")
    )
      this.notify(knock);
  }

  pendingQq() {
    const { runtime, agentId } = this;
    const agent = runtime.agent(agentId);
    if (!runtime.transports.get(agent.connectionId)?.connected) return false;
    const rows = runtime.memory.db
      .prepare(
        "SELECT conversation FROM runtime WHERE agent_id=? AND (conversation LIKE 'private:%' OR conversation LIKE 'group:%') AND json_array_length(json_extract(value,'$.pendingWakes'))>0",
      )
      .all(agentId);
    return rows.some(({ conversation }) =>
      runtime.writable(agent, conversation),
    );
  }

  beginDesktop(controller) {
    const { runtime, agentId } = this;
    const agent = runtime.agent(agentId);
    if (this.qqClaims || this.pendingQq()) throw Error("DESKTOP_QQ_PRIORITY");
    if (
      runtime.blockers(agent).length ||
      runtime.games.busy(agent.backendId) ||
      [...runtime.running.values()].some((ctx) => ctx.agentId === agentId)
    )
      throw Error("DESKTOP_MODEL_BUSY");
    const release = runtime.subjectExecution.acquire(agentId, {});
    if (!release) throw Error("DESKTOP_MODEL_BUSY");
    let finish;
    const done = new Promise((resolve) => {
      finish = resolve;
    });
    this.desktop = { controller, done };
    return () => {
      this.desktop = null;
      release();
      finish();
    };
  }

  interrupt(agentId) {
    if (agentId === this.agentId)
      this.desktop?.controller.abort(Error("DESKTOP_QQ_PRIORITY"));
  }

  claimQq(agentId, conversation) {
    if (
      agentId !== this.agentId ||
      !isQq(conversation) ||
      !this.runtime.transports.get(this.runtime.agent(agentId).connectionId)
        ?.connected ||
      !this.runtime.writable(this.runtime.agent(agentId), conversation)
    )
      return null;
    this.qqClaims++;
    const drained = this.desktop?.done;
    this.interrupt(agentId);
    return {
      drained,
      release: () => {
        this.qqClaims--;
      },
    };
  }
}
