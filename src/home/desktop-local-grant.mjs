import { z } from "zod";
import { DESKTOP_CONVERSATION } from "./desktop-decision.mjs";

const uuid = z.string().uuid();
export const localRevokeSchema = z
  .object({ roomEpoch: uuid, grantId: uuid })
  .strict();
export const localGrantSchema = localRevokeSchema
  .extend({ agentId: z.string().min(1).max(64) })
  .strict();

export class DesktopLocalGrant {
  constructor(host, tool, unavailable) {
    this.host = host;
    this.tool = tool;
    this.unavailable = unavailable;
  }

  eligible() {
    const { live, runtime } = this.host;
    return (live?.here() ?? []).filter(({ id }) =>
      runtime
        .toolsFor(runtime.agent(id), DESKTOP_CONVERSATION)
        .includes(this.tool),
    );
  }

  current(grant) {
    return (
      grant &&
      this.grant === grant &&
      this.host.connected() &&
      this.host.live.room.epoch === grant.roomEpoch &&
      this.host.live.visits.get(grant.agentId) === grant.visit &&
      this.eligible().some(({ id }) => id === grant.agentId)
    );
  }

  state() {
    if (this.grant && !this.current(this.grant)) this.clear();
    return {
      eligible: this.eligible().map(({ id }) => id),
      grantedAgentId: this.grant?.agentId ?? null,
    };
  }

  clear() {
    this.grant = null;
  }

  change(revoking, value) {
    const { live } = this.host;
    if (value.roomEpoch !== live.room.epoch) throw Error(this.unavailable);
    if (revoking) {
      if (this.grant?.grantId === value.grantId) this.clear();
      return;
    }
    if (!this.eligible().some(({ id }) => id === value.agentId))
      throw Error(this.unavailable);
    this.clear();
    this.grant = { ...value, visit: live.visits.get(value.agentId) };
  }

  activeGrant(ctx, agent) {
    const { runtime } = this.host;
    const grant = this.grant;
    const epoch = ctx.inputEpoch;
    const current = () => {
      try {
        runtime.assertActive(ctx);
        return (
          ctx.inputEpoch === epoch &&
          ctx.runtimeKind === "desktop" &&
          grant?.agentId === agent.id &&
          (!ctx.desktopWindowTask ||
            (ctx.desktopWindowTaskReady &&
              ctx.desktopWindowTask.grantId === grant.grantId &&
              ctx.desktopWindowTask.current())) &&
          this.current(grant)
        );
      } catch {
        return false;
      }
    };
    if (!current()) throw Error(this.unavailable);
    return { grant, current };
  }
}
