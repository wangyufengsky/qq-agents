import { randomUUID } from "node:crypto";
import { rhythmStatus } from "../core/rhythm.mjs";
import { roleRest, roleTurnBusy } from "../core/role-rest.mjs";

export const DESKTOP_INVITATION_TOOL = "desktop_invitation_decide";
const SUBJECT = "@subject";
const INVITATION_TTL = 5 * 60_000;
const unavailable = () => Error("DESKTOP_VISIT_UNAVAILABLE");

export class DesktopInvitations {
  constructor(host) {
    this.host = host;
    this.pending = new Map();
  }

  request({ actor }, signal) {
    const { runtime } = this.host;
    if (
      signal.aborted ||
      !this.host.connected() ||
      !runtime.subject.enabled(runtime.agent(actor)) ||
      !runtime
        .toolsFor(runtime.agent(actor), SUBJECT)
        .includes(DESKTOP_INVITATION_TOOL) ||
      this.pending.has(actor)
    )
      throw unavailable();

    const invitation = {
      id: randomUUID(),
      expiresAt: runtime.now() + INVITATION_TTL,
      room: this.host.live,
    };
    const result = new Promise((resolve, reject) => {
      const abort = () => invitation.finish();
      invitation.finish = (decision) => {
        if (this.pending.get(actor) !== invitation) return;
        this.pending.delete(actor);
        signal.removeEventListener("abort", abort);
        if (decision) resolve({ action: decision });
        else reject(unavailable());
      };
      this.pending.set(actor, invitation);
      signal.addEventListener("abort", abort, { once: true });
    });
    this.dispatch();
    return result;
  }

  current(actor, invitation) {
    const { runtime } = this.host;
    return (
      invitation &&
      invitation.expiresAt > runtime.now() &&
      invitation.room === this.host.live &&
      this.host.connected() &&
      invitation.room.room.members[actor] === "invited"
    );
  }

  dispatch() {
    const { runtime } = this.host;
    for (const [actor, invitation] of this.pending) {
      if (!this.current(actor, invitation)) {
        invitation.finish();
        continue;
      }
      const agent = runtime.agent(actor);
      if (
        invitation.started ||
        !runtime.writable(agent, SUBJECT) ||
        runtime.games.busy(agent.backendId) ||
        roleTurnBusy(runtime, actor) ||
        roleRest(runtime, agent) ||
        rhythmStatus(runtime, agent, true).state === "sleeping"
      )
        continue;
      invitation.started = true;
      runtime.trackJob(
        runtime
          .wake(actor, SUBJECT, { reasons: [{ reason: "desktop-invitation" }] })
          .finally(() => invitation.finish()),
        actor,
      );
    }
  }

  material(ctx) {
    const invitation = this.pending.get(ctx.agentId);
    if (
      !invitation?.started ||
      !this.current(ctx.agentId, invitation) ||
      !ctx.allowedTools?.includes(DESKTOP_INVITATION_TOOL)
    )
      return undefined;
    ctx.desktopInvitationId = invitation.id;
    return {
      id: invitation.id,
      from: "管理员",
      present: invitation.room.here().map(({ name }) => name),
      expiresAt: invitation.expiresAt,
      notice:
        "管理员邀请你去桌面小窝。请由你自己决定，用 desktop_invitation_decide 同意或婉拒。同意后框架会安排你的桌面 Agent 入场。",
    };
  }

  decide(ctx, { id, action }) {
    const { runtime } = this.host;
    runtime.assertActive(ctx);
    const invitation = this.pending.get(ctx.agentId);
    if (
      ctx.conversation !== SUBJECT ||
      ctx.runtimeKind === "functional-agent" ||
      ctx.backendInputEpoch !== ctx.inputEpoch ||
      ctx.desktopInvitationId !== id ||
      invitation?.id !== id ||
      !this.current(ctx.agentId, invitation)
    )
      throw unavailable();
    if (invitation.decision && invitation.decision !== action)
      throw Error("DESKTOP_DECISION_DENIED");
    invitation.decision = action;
    return { status: "recorded", action };
  }

  finish(actor, completed) {
    const invitation = this.pending.get(actor);
    if (!invitation?.started) return;
    const agent = this.host.runtime.config.agents.find(
      ({ id }) => id === actor,
    );
    invitation.finish(
      completed &&
        agent &&
        this.current(actor, invitation) &&
        this.host.runtime.writable(agent, SUBJECT)
        ? invitation.decision
        : undefined,
    );
  }
}
