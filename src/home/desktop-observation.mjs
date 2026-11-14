import { randomUUID } from "node:crypto";
import { z } from "zod";
import { supportsMessageImages } from "../backends/capabilities.mjs";
import { DesktopObservationSummaries } from "../memory/desktop-observation-summaries.mjs";
import { observationRoles } from "./desktop-home-policy.mjs";
import { DESKTOP_CONVERSATION } from "./desktop-decision.mjs";
import {
  DesktopLocalGrant,
  localGrantSchema,
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
export const displayObservationGrantSchema = localGrantSchema
  .extend({
    scope: z.literal("display"),
    limits: z
      .object({
        minutes: z.number().int(),
        attempts: z.number().int(),
      })
      .strict(),
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
      grantId: uuid.optional(),
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
  displayHistory = new Map();
  displayGrantIds = new WeakMap();
  constructor(host) {
    super(host, DESKTOP_SCREEN_VIEW, "DESKTOP_SCREEN_UNAVAILABLE");
    this.displays = new Map();
    this.verifying = new Map();
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
      grant &&
      this.find(grant.grantId) === grant &&
      this.host.connected() &&
      this.host.live.room.epoch === grant.roomEpoch &&
      this.host.live.visits.get(grant.agentId) === grant.visit &&
      this.eligible().some(({ id }) => id === grant.agentId) &&
      (grant.scope !== "display" ||
        (this.host.client.displayObservation &&
          this.host.runtime.config.desktopHome.displayObservation.attempts >=
            grant.limit &&
          this.host.runtime.config.desktopHome.displayObservation.minutes >=
            grant.minutes)) &&
      this.host.activityCurrent(grant.agentId) &&
      grant.expiresAt > this.host.runtime.now()
    );
  }

  find(grantId) {
    if (!grantId) return;
    if (this.grant?.grantId === grantId) return this.grant;
    return [...this.displays.values()].find(
      (grant) => grant.grantId === grantId,
    );
  }

  grants() {
    return [this.grant, ...this.displays.values()].filter(Boolean);
  }

  canGrantDisplay(value) {
    const { client, runtime } = this.host;
    const { minutes, attempts } = runtime.config.desktopHome.displayObservation;
    const existing = this.find(value.grantId);
    const visit = this.host.live?.visits.get(value.agentId);
    return (
      visit &&
      (!this.displayGrantIds.get(visit)?.has(value.grantId) || existing) &&
      client.observationProtocol === 2 &&
      client.displayObservation &&
      client.activityVisibleUntil > runtime.now() &&
      value.limits.minutes === minutes &&
      value.limits.attempts === attempts &&
      (!existing ||
        (existing.scope === "display" &&
          existing.agentId === value.agentId &&
          this.current(existing)))
    );
  }

  change(revoking, value) {
    const { live, runtime } = this.host;
    if (value.roomEpoch !== live.room.epoch) throw Error(this.unavailable);
    if (revoking) {
      const grant = this.find(value.grantId);
      if (grant)
        this.clear(
          grant,
          grant.expiresAt <= runtime.now() ? "expired" : "revoked",
        );
      return;
    }
    if (!this.eligible().some(({ id }) => id === value.agentId))
      throw Error(this.unavailable);
    const display = value.scope === "display";
    const { minutes, attempts } = runtime.config.desktopHome.displayObservation;
    if (display && !this.canGrantDisplay(value)) throw Error(this.unavailable);
    const existing = this.find(value.grantId);
    if (existing) {
      if (
        existing.scope !== value.scope ||
        existing.agentId !== value.agentId ||
        !this.current(existing)
      )
        throw Error(this.unavailable);
      return;
    }
    const previous = display ? this.displays.get(value.agentId) : this.grant;
    if (previous) this.clear(previous);
    const grant = {
      ...value,
      visit: live.visits.get(value.agentId),
      expiresAt: runtime.now() + (display ? minutes * 60_000 : OBSERVATION_TTL),
      limit: display ? attempts : OBSERVATION_LIMIT,
      ...(display && { minutes, opportunity: "waiting" }),
      attempts: 0,
      targetState: "checking",
    };
    if (display) {
      const ids = this.displayGrantIds.get(grant.visit) ?? new Set();
      ids.add(grant.grantId);
      this.displayGrantIds.set(grant.visit, ids);
      this.displayHistory.delete(value.agentId);
      this.displays.set(value.agentId, grant);
    } else this.grant = grant;
    this.note(grant, "observation-granted");
  }

  grantState(grant) {
    const { agentId, grantId, expiresAt } = grant;
    return {
      agentId,
      grantId,
      expiresAt,
      remaining: grant.limit - grant.attempts,
      ...(grant.scope === "display" && {
        opportunity: grant.opportunity,
        ...(grant.opportunity === "waiting" && {
          waiting: this.host.live.observationWaiting(
            grant.agentId,
            this.targetReady(grant),
          ),
        }),
      }),
      targetState: this.targetReady(grant) ? "ready" : grant.targetState,
    };
  }

  state() {
    for (const grant of this.grants()) {
      if (!this.current(grant))
        this.clear(
          grant,
          grant.expiresAt <= this.host.runtime.now()
            ? "expired"
            : "unavailable",
        );
      else if (grant.targetState === "ready" && !this.targetReady(grant)) {
        grant.targetState = "checking";
        grant.candidate = undefined;
        this.cancel(grant);
      }
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
      eligible: this.eligible().map(({ id }) => id),
      grantedAgentId: this.grant?.agentId ?? null,
      ...(ineligible.length && { ineligible }),
      ...(this.grant && this.grantState(this.grant)),
      ...(this.host.client?.displayObservation && {
        displays: [...this.displays.values()].map((grant) =>
          this.grantState(grant),
        ),
        displayHistory: [...this.displayHistory.values()].flatMap(
          ({ visit, ...item }) =>
            live?.visits.get(item.agentId) === visit ? [item] : [],
        ),
        displayLimits: runtime.config.desktopHome.displayObservation,
      }),
    };
  }

  clear(grant, reason = "unavailable") {
    if (!grant) {
      for (const current of this.grants()) this.clear(current, reason);
      if (!this.host.connected()) this.displayHistory.clear();
      return;
    }
    if (grant.scope === "display") {
      if (this.displays.get(grant.agentId) !== grant) return;
      this.displays.delete(grant.agentId);
      this.displayHistory.set(grant.agentId, {
        agentId: grant.agentId,
        visit: grant.visit,
        state: reason,
        opportunity: ["deciding", "capturing"].includes(grant.opportunity)
          ? "incomplete"
          : grant.opportunity,
      });
    } else this.grant = null;
    if (this.published?.grantId === grant.grantId) this.published = undefined;
    this.cancel(grant);
  }

  cancel(grant) {
    this.host.screen.cancel(grant);
    this.verifying.get(grant.grantId)?.fail();
    if (this.host.live?.activities.get(grant.agentId)?.observation === grant)
      this.host.live.cancelActivity(grant.agentId);
  }

  note(grant, reason) {
    const live = this.host.live;
    live?.activity.note(grant.visit, reason);
  }

  updateTarget({ grantId, roomEpoch, state }) {
    const grant = this.find(grantId);
    if (!this.current(grant) || grant.roomEpoch !== roomEpoch) return;
    if (state === "unavailable" || state === "permission") {
      this.clear(grant);
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
      grant.candidate = undefined;
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
    const choices = [this.displays.get(agentId), this.grant];
    for (const grant of choices) {
      if (
        grant?.agentId === agentId &&
        grant.attempts < grant.limit &&
        grant.opportunity !== "declined" &&
        this.current(grant) &&
        this.targetReady(grant)
      )
        return {
          grant,
          direct:
            grant.scope !== "display" &&
            this.host.runtime.config.desktopHome.observationRoles === undefined,
        };
    }
  }

  verifyWork() {
    return [...this.verifying.values()]
      .filter(({ grant, signal }) => !signal.aborted && this.current(grant))
      .map(({ request }) => request);
  }

  async verifyForDelivery(grant, signal) {
    if (
      this.verifying.has(grant.grantId) ||
      !this.current(grant) ||
      !this.targetReady(grant)
    )
      throw Error("DESKTOP_SCREEN_UNAVAILABLE");
    const { promise, resolve, reject } = Promise.withResolvers();
    const fail = () => reject(Error("DESKTOP_SCREEN_UNAVAILABLE"));
    const { roomEpoch, grantId } = grant;
    this.verifying.set(grantId, {
      grant,
      signal,
      resolve,
      fail,
      request: { roomEpoch, grantId, requestId: randomUUID() },
    });
    signal.addEventListener("abort", fail, { once: true });
    if (signal.aborted) fail();
    const timer = setTimeout(fail, 7000);
    try {
      await promise;
    } finally {
      this.verifying.delete(grantId);
      clearTimeout(timer);
      signal.removeEventListener("abort", fail);
    }
  }

  verifyResult(input) {
    const parsed = verifyResultSchema.safeParse(input);
    if (!parsed.success) throw Error("INVALID_REQUEST");
    const { client, requestId, roomEpoch, grantId, state } = parsed.data;
    const pending = this.verifying.get(grantId);
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
    grant.candidate = {
      id: randomUUID(),
      agentId,
      expiresAt,
      grantId,
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
    const { client, action, id, agentId, grantId } = parsed.data;
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
    const candidates = this.grants().filter(
      (grant) =>
        this.current(grant) && this.targetReady(grant) && grant.candidate,
    );
    if (action !== "status") {
      const grant = candidates.find(
        (entry) =>
          entry.candidate?.id === id &&
          (grantId
            ? entry.grantId === grantId
            : entry.scope !== "display" || action === "discard"),
      );
      if (!grant) throw Error("DESKTOP_OBSERVATION_REVIEW_UNAVAILABLE");
      const { candidate } = grant;
      if (action === "publish") {
        if (!candidate.response)
          throw Error("DESKTOP_OBSERVATION_REVIEW_UNAVAILABLE");
        this.published = {
          id,
          agentId: candidate.agentId,
          grantId: grant.grantId,
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
      if (action === "discard" && candidate.summary === grant.prior?.summary)
        grant.prior = undefined;
      if (action === "discard" || (!candidate.response && !candidate.summary))
        grant.candidate = undefined;
    }
    const candidate = candidates.find((grant) => grant.candidate)?.candidate;
    return {
      candidate: candidate && { ...candidate },
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
    if (!current() || grant.attempts >= grant.limit)
      throw Error("DESKTOP_SCREEN_UNAVAILABLE");
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
