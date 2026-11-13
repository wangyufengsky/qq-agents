import { DESKTOP_CONVERSATION } from "./desktop-decision.mjs";
import { DesktopLocalGrant } from "./desktop-local-grant.mjs";
import { DESKTOP_SCREEN_VIEW } from "../tools/names.mjs";

const OBSERVATION_TTL = 15 * 60_000;
const OBSERVATION_LIMIT = 4;

export class DesktopObservation extends DesktopLocalGrant {
  constructor(host) {
    super(host, DESKTOP_SCREEN_VIEW, "DESKTOP_SCREEN_UNAVAILABLE");
  }

  eligible() {
    const { runtime, live } = this.host;
    const policy = runtime.config.desktopHome;
    if (!policy.autonomousObservation || live?.activity.paused) return [];
    return super
      .eligible()
      .filter(
        ({ id }) =>
          policy.activityRoles.includes(id) &&
          !runtime.blockers(runtime.agent(id), DESKTOP_CONVERSATION).length,
      );
  }

  current(grant) {
    return (
      super.current(grant) &&
      this.host.activityCurrent(grant.agentId) &&
      grant.expiresAt > this.host.runtime.now()
    );
  }

  change(revoking, value) {
    super.change(revoking, value);
    if (!revoking) {
      this.grant.expiresAt = this.host.runtime.now() + OBSERVATION_TTL;
      this.grant.attempts = 0;
    }
  }

  state() {
    const status = super.state();
    return {
      ...status,
      ...(this.grant && {
        expiresAt: this.grant.expiresAt,
        remaining: OBSERVATION_LIMIT - this.grant.attempts,
      }),
    };
  }

  clear() {
    const grant = this.grant;
    super.clear();
    if (!grant) return;
    this.host.screen.cancel(grant);
    if (this.host.live?.active?.observation === grant)
      this.host.live.cancelActivity();
  }

  forActor(agentId) {
    const grant = this.grant;
    if (
      grant?.agentId === agentId &&
      grant.attempts < OBSERVATION_LIMIT &&
      this.current(grant)
    )
      return grant;
  }

  async capture(ctx, grant) {
    const current = () =>
      this.host.runtime.capabilities.get(ctx.token) === ctx &&
      !ctx.controller.signal.aborted &&
      this.current(grant);
    if (!current() || grant.attempts >= OBSERVATION_LIMIT)
      throw Error("DESKTOP_SCREEN_UNAVAILABLE");
    grant.attempts++;
    const agent = this.host.runtime.agent(ctx.agentId);
    const frame = await this.host.screen.capture(
      ctx,
      agent,
      grant,
      current,
      "observation",
    );
    if (!current()) throw Error("DESKTOP_SCREEN_UNAVAILABLE");
    return frame;
  }
}
