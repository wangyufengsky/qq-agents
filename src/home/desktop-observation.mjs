import { randomUUID } from "node:crypto";
import { z } from "zod";
import { supportsMessageImages } from "../backends/capabilities.mjs";
import { DesktopObservationSummaries } from "../memory/desktop-observation-summaries.mjs";
import { observationRoles } from "./desktop-home-policy.mjs";
import { DESKTOP_CONVERSATION } from "./desktop-decision.mjs";
import {
  DesktopLocalGrant,
  localRevokeSchema,
} from "./desktop-local-grant.mjs";
import { DESKTOP_SCREEN_VIEW } from "../tools/names.mjs";

const OBSERVATION_TTL = 15 * 60_000;
const OBSERVATION_LIMIT = 4;
const TARGET_LEASE = 5_000;
const agentId = z.string().min(1).max(64);
const uuid = z.string().uuid();

export const observationStateSchema = localRevokeSchema
  .extend({
    state: z.enum(["ready", "minimized", "unavailable", "permission"]),
  })
  .strict();
const verifyResultSchema = observationStateSchema
  .extend({ client: uuid, requestId: uuid })
  .strict();
const reviewInput = z.discriminatedUnion("action", [
  z.object({ client: uuid, action: z.literal("status") }).strict(),
  z
    .object({
      client: uuid,
      action: z.enum(["publish", "save", "discard"]),
      id: uuid,
    })
    .strict(),
  z
    .object({
      client: uuid,
      action: z.literal("list"),
      agentId: agentId.optional(),
    })
    .strict(),
  z
    .object({ client: uuid, action: z.literal("delete"), agentId, id: uuid })
    .strict(),
]);
const exportInput = z
  .object({
    action: z.enum(["export", "restore"]),
    agentId,
    data: z.unknown().optional(),
  })
  .strict();

export class DesktopObservation extends DesktopLocalGrant {
  constructor(host) {
    super(host, DESKTOP_SCREEN_VIEW, "DESKTOP_SCREEN_UNAVAILABLE");
    this.summaries = new DesktopObservationSummaries(host.runtime.memory, () =>
      host.runtime.now(),
    );
  }

  eligible() {
    const { runtime, live } = this.host;
    const policy = runtime.config.desktopHome;
    if (!policy.autonomousObservation || live?.activity.paused) return [];
    return (live?.here() ?? []).filter(({ id }) => !this.ineligibleReason(id));
  }

  ineligibleReason(id) {
    const { runtime } = this.host;
    const policy = runtime.config.desktopHome;
    if (
      !policy.activityRoles.includes(id) ||
      !observationRoles(policy).includes(id)
    )
      return "activity";
    if (!policy.toolRoles.includes(id) || !policy.screenView.enabled)
      return "screen";
    const agent = runtime.agent(id);
    const backend = this.host.backendFor(agent);
    if (
      !agent.behavior.imageInput.enabled ||
      !backend ||
      !supportsMessageImages(backend)
    )
      return "image";
    if (runtime.blockers(agent, DESKTOP_CONVERSATION).length) return "blocked";
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
      this.grant.targetState = "checking";
      this.note(this.grant, "observation-granted");
    }
  }

  state() {
    const status = super.state();
    const grant = this.grant;
    if (grant?.targetState === "ready" && !this.targetReady(grant)) {
      grant.targetState = "checking";
      this.candidate = undefined;
      this.cancel(grant);
    }
    const { runtime, live } = this.host;
    const ineligible =
      runtime.config.desktopHome.autonomousObservation && !live?.activity.paused
        ? (live?.here() ?? []).flatMap(({ id }) => {
            const reason = this.ineligibleReason(id);
            return reason ? [{ id, reason }] : [];
          })
        : [];
    return {
      ...status,
      ...(ineligible.length && { ineligible }),
      ...(this.grant && {
        expiresAt: this.grant.expiresAt,
        remaining: OBSERVATION_LIMIT - this.grant.attempts,
        targetState: this.targetReady(this.grant)
          ? "ready"
          : this.grant.targetState === "minimized"
            ? "minimized"
            : "checking",
      }),
    };
  }

  clear() {
    const grant = this.grant;
    super.clear();
    this.candidate = undefined;
    this.published = undefined;
    if (!grant) return;
    this.cancel(grant);
  }

  cancel(grant) {
    this.host.screen.cancel(grant);
    if (this.verifying?.grant === grant) this.verifying.fail();
    if (this.host.live?.activities.get(grant.agentId)?.observation === grant)
      this.host.live.cancelActivity(grant.agentId);
  }

  note(grant, reason) {
    const live = this.host.live;
    live?.activity.note(grant.visit, reason);
  }

  updateTarget({ grantId, roomEpoch, state }) {
    const grant = this.grant;
    if (
      !this.current(grant) ||
      grant.grantId !== grantId ||
      grant.roomEpoch !== roomEpoch
    )
      return;
    if (state === "unavailable" || state === "permission") {
      this.clear();
      return;
    }
    const previous = grant.targetState;
    grant.targetState = state;
    if (state === "ready")
      grant.targetReadyUntil = this.host.runtime.now() + TARGET_LEASE;
    if (previous !== state)
      this.note(
        grant,
        state === "ready" ? "observation-ready" : "observation-minimized",
      );
    if (state === "minimized") {
      this.candidate = undefined;
      this.cancel(grant);
    }
  }

  targetReady(grant) {
    return (
      grant.targetState === "ready" &&
      grant.targetReadyUntil > this.host.runtime.now()
    );
  }

  forActor(agentId) {
    const grant = this.grant;
    if (
      grant?.agentId === agentId &&
      grant.attempts < OBSERVATION_LIMIT &&
      this.current(grant) &&
      this.targetReady(grant)
    )
      return {
        grant,
        direct:
          this.host.runtime.config.desktopHome.observationRoles === undefined,
      };
  }

  verifyWork() {
    const pending = this.verifying;
    if (pending && !pending.signal.aborted && this.current(pending.grant))
      return pending.request;
  }

  async verifyForDelivery(grant, signal) {
    if (this.verifying || !this.current(grant) || !this.targetReady(grant))
      throw Error("DESKTOP_SCREEN_UNAVAILABLE");
    const { promise, resolve, reject } = Promise.withResolvers();
    const fail = () => reject(Error("DESKTOP_SCREEN_UNAVAILABLE"));
    const { roomEpoch, grantId } = grant;
    this.verifying = {
      grant,
      signal,
      resolve,
      fail,
      request: { roomEpoch, grantId, requestId: randomUUID() },
    };
    signal.addEventListener("abort", fail, { once: true });
    if (signal.aborted) fail();
    const timer = setTimeout(fail, 7000);
    try {
      await promise;
    } finally {
      this.verifying = undefined;
      clearTimeout(timer);
      signal.removeEventListener("abort", fail);
    }
  }

  verifyResult(input) {
    const parsed = verifyResultSchema.safeParse(input);
    if (!parsed.success) throw Error("INVALID_REQUEST");
    const { client, requestId, roomEpoch, grantId, state } = parsed.data;
    const pending = this.verifying;
    if (
      !pending ||
      pending.signal.aborted ||
      !this.current(pending.grant) ||
      this.host.client.id !== client ||
      pending.request.requestId !== requestId ||
      pending.request.roomEpoch !== roomEpoch ||
      pending.request.grantId !== grantId
    )
      throw Error("DESKTOP_SCREEN_UNAVAILABLE");
    this.updateTarget(parsed.data);
    if (state === "ready") pending.resolve();
    return { accepted: true };
  }

  finish(grant, { response, summary }) {
    if (
      (!response && !summary) ||
      !this.current(grant) ||
      !this.targetReady(grant)
    )
      return;
    const { agentId, grantId, expiresAt } = grant;
    if (summary)
      grant.prior = {
        summary,
        grantId,
        source: "desktop-observation",
        createdAt: this.host.runtime.now(),
      };
    this.candidate = {
      id: randomUUID(),
      agentId,
      expiresAt,
      response,
      summary,
    };
  }

  maintain() {
    const now = this.host.runtime.now();
    const days = this.host.runtime.config.desktopHome.observationRetentionDays;
    if (days !== this.retentionDays) {
      this.summaries.applyRetention(days);
      this.retentionDays = days;
      this.nextPurge = now + 60_000;
    } else if (now >= this.nextPurge) {
      this.summaries.purge();
      this.nextPurge = now + 60_000;
    }
  }

  review(input) {
    const parsed = reviewInput.safeParse(input);
    if (!parsed.success) throw Error("INVALID_REQUEST");
    const { client, action, id, agentId } = parsed.data;
    if (
      !this.host.refresh() ||
      !this.host.connected() ||
      this.host.client.id !== client ||
      this.host.runtime.updateMaintenance
    )
      throw Error("DESKTOP_SCREEN_UNAVAILABLE");
    const { runtime } = this.host;
    const days = runtime.config.desktopHome.observationRetentionDays;
    if (agentId) runtime.agent(agentId);
    if (action === "list")
      return {
        records: this.summaries.visible(
          agentId ? [agentId] : runtime.config.agents.map(({ id }) => id),
        ),
      };
    if (action === "delete")
      return { deleted: this.summaries.delete(agentId, id) };
    if (action !== "status") {
      const candidate = this.candidate;
      if (
        !this.current(this.grant) ||
        !this.targetReady(this.grant) ||
        candidate?.id !== id
      )
        throw Error("DESKTOP_OBSERVATION_REVIEW_UNAVAILABLE");
      if (action === "publish") {
        if (!candidate.response)
          throw Error("DESKTOP_OBSERVATION_REVIEW_UNAVAILABLE");
        this.published = {
          id,
          agentId: candidate.agentId,
          text: candidate.response,
        };
        delete candidate.response;
      }
      if (action === "save") {
        if (!candidate.summary)
          throw Error("DESKTOP_OBSERVATION_REVIEW_UNAVAILABLE");
        this.summaries.save(
          candidate.agentId,
          { id, summary: candidate.summary },
          days,
        );
        delete candidate.summary;
      }
      if (
        action === "discard" &&
        candidate.summary === this.grant.prior?.summary
      )
        this.grant.prior = undefined;
      if (action === "discard" || (!candidate.response && !candidate.summary))
        this.candidate = undefined;
    }
    return {
      ...(this.grant &&
        this.targetReady(this.grant) &&
        this.candidate && { candidate: { ...this.candidate } }),
      published: this.published,
    };
  }

  transfer(input) {
    const parsed = exportInput.safeParse(input);
    if (!parsed.success) throw Error("INVALID_REQUEST");
    const { action, agentId, data } = parsed.data;
    const { runtime } = this.host;
    runtime.agent(agentId);
    this.maintain();
    const days = runtime.config.desktopHome.observationRetentionDays;
    if (action === "export" && data === undefined)
      return this.summaries.export(agentId, days);
    if (action === "restore" && data !== undefined)
      return this.summaries.restore(agentId, data, days);
    throw Error("INVALID_REQUEST");
  }

  async capture(ctx, grant) {
    const current = () =>
      this.host.runtime.capabilities.get(ctx.token) === ctx &&
      !ctx.controller.signal.aborted &&
      this.current(grant) &&
      this.targetReady(grant);
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
