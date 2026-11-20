import { randomUUID } from "node:crypto";
import { z } from "zod";
import { recallBoundary } from "../core/recall-boundary.mjs";
import { DESKTOP_NATIVE_CONTROL } from "../tools/names.mjs";
import {
  DESKTOP_CONVERSATION,
  DESKTOP_WINDOW_TASK_CONVERSATION,
} from "./desktop-decision.mjs";
import {
  DesktopControlGrants,
  DesktopLocalGrant,
} from "./desktop-local-grant.mjs";

const uuid = z.string().uuid();
const ref = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9_-]+$/);
const nativeActions = [
  z.object({ type: z.literal("observe") }).strict(),
  z.object({ type: z.literal("click"), ref }).strict(),
  z
    .object({ type: z.literal("set-value"), ref, text: z.string().max(1000) })
    .strict(),
  z
    .object({
      type: z.literal("scroll"),
      ref,
      direction: z.enum(["up", "down", "left", "right"]),
      amount: z.number().int().min(1).max(5).default(1),
    })
    .strict(),
];
export const legacyNativeActionSchema = z.discriminatedUnion(
  "type",
  nativeActions,
);
export const nativeActionSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("request"),
    target: z.enum(["window", "browser"]),
  }),
  ...nativeActions.map((schema) => schema.extend({ grantId: uuid.optional() })),
  z.strictObject({ type: z.literal("grants") }),
  z.strictObject({ type: z.literal("revoke"), grantId: uuid }),
]);
const observationSchema = z
  .object({
    elements: z
      .array(
        z
          .object({
            ref: ref.optional(),
            role: z
              .string()
              .max(100)
              .regex(/^[a-zA-Z0-9_ -]+$/),
            label: z.string().max(240).optional(),
          })
          .strict(),
      )
      .max(60),
    truncated: z.boolean().optional(),
  })
  .strict();
const actionResultSchema = z
  .object({
    ok: z.boolean(),
    delivery: z
      .string()
      .min(1)
      .max(40)
      .regex(/^[a-z_-]+$/),
    code: z
      .string()
      .max(80)
      .regex(/^[A-Z_]+$/)
      .optional(),
  })
  .strict();
const claimSchema = z
  .object({
    client: uuid,
    roomEpoch: uuid,
    grantId: uuid,
    requestId: uuid,
  })
  .strict();
const resultSchema = claimSchema
  .extend({
    result: z.union([observationSchema, actionResultSchema]).optional(),
  })
  .strict();

export const MAX_DESKTOP_NATIVE_BODY = 65536;
const REQUEST_MS = 12_000;
const CLAIM_MS = 2_000;

export class DesktopNative extends DesktopLocalGrant {
  constructor(host) {
    super(host, DESKTOP_NATIVE_CONTROL, "DESKTOP_NATIVE_UNAVAILABLE");
    this.unified = new DesktopControlGrants(this);
    this.controlRequests = new Map();
    this.targetOperations = new Map();
    this.targetHandoffs = new Map();
  }

  requestReceipts() {
    const live = this.host.live;
    for (const [id, item] of this.controlRequests) {
      if (
        !this.host.connected() ||
        live?.visits.get(item.agentId) !== item.visit
      )
        this.controlRequests.delete(id);
    }
    return [...this.controlRequests.values()].map(
      ({ requestId, agentId, target, status }) => ({
        requestId,
        agentId,
        target,
        status,
      }),
    );
  }

  requests() {
    return this.requestReceipts().filter((item) => item.status === "pending");
  }

  resolveRequest(requestId, status) {
    const item = this.controlRequests.get(requestId);
    if (item?.status === "pending") item.status = status;
  }

  state() {
    const state = super.state();
    if (
      this.handoff?.state === "pending" &&
      Date.now() >= this.handoff.pending.request.expiresAt
    )
      this.handoff = { state: "unconfirmed" };
    return {
      ...state,
      handoff: this.handoff?.state,
      ...this.unified.state(),
    };
  }

  change(revoking, value) {
    if (revoking) {
      if (value.roomEpoch !== this.host.live?.room.epoch)
        throw Error(this.unavailable);
      if (!this.revokeUnified(value.grantId)) super.change(true, value);
      return;
    }
    if (value.targetId) {
      if (
        value.requestId &&
        !this.requests().some(
          (item) =>
            item.requestId === value.requestId &&
            item.agentId === value.agentId,
        )
      )
        throw Error(this.unavailable);
      this.unified.change(value);
      this.resolveRequest(value.requestId, "granted");
      return;
    }
    this.state();
    if (this.grant) {
      if (
        this.grant.grantId === value.grantId &&
        this.current(this.grant) &&
        this.grant.agentId === value.agentId
      )
        return;
      throw Error(this.unavailable);
    }
    if (this.state().handoff === "pending") throw Error(this.unavailable);
    if (this.handoff?.state === "unconfirmed" && value.confirmed !== true)
      throw Error(this.unavailable);
    super.change(false, value);
    this.handoff = undefined;
  }

  revokeUnified(grantId, agentId) {
    const grant = this.unified.remove(grantId, agentId);
    if (!grant) return false;
    const pending = this.targetOperations.get(grant.targetId);
    if (pending?.grant === grant) {
      if (pending.claimed && !pending.received)
        this.targetHandoffs.set(grant.targetId, { state: "pending", pending });
      pending.reject(Error("DESKTOP_NATIVE_RESULT_UNKNOWN"));
    }
    this.host.notify();
    return true;
  }

  current(grant) {
    return grant?.unified ? this.unified.current(grant) : super.current(grant);
  }

  clear() {
    super.clear();
    if (this.pending?.claimed && !this.pending.received)
      this.handoff = { state: "pending", pending: this.pending };
    this.pending?.reject(Error("DESKTOP_NATIVE_RESULT_UNKNOWN"));
    this.pending = null;
  }

  request() {
    const pending = this.pending;
    if (pending?.current() && !pending.received) return pending.request;
  }

  clientWork() {
    const nativeRequests = [...this.targetOperations.values()]
      .filter((pending) => pending.current() && !pending.received)
      .map(({ request }) => request);
    const unified = nativeRequests.length ? { nativeRequests } : {};
    if (!this.current(this.grant)) return unified;
    const { runtime } = this.host;
    const id = this.grant.agentId + "|";
    const ctx =
      runtime.running.get(id + DESKTOP_WINDOW_TASK_CONVERSATION) ??
      runtime.running.get(id + DESKTOP_CONVERSATION);
    if (!ctx?.turnId || ctx.controller.signal.aborted) return unified;
    const nativeRequest = this.request();
    return {
      ...unified,
      nativeTurnId: ctx.turnId,
      ...(nativeRequest && { nativeRequest }),
    };
  }

  pendingFor({ client, roomEpoch, grantId, requestId }) {
    const pending =
      this.pending?.request.requestId === requestId
        ? this.pending
        : [...this.targetOperations.values()].find(
            ({ request }) => request.requestId === requestId,
          );
    if (
      !pending ||
      pending.received ||
      !pending.current() ||
      this.host.client.id !== client ||
      pending.request.roomEpoch !== roomEpoch ||
      pending.request.grantId !== grantId ||
      pending.request.requestId !== requestId
    )
      throw Error("DESKTOP_NATIVE_UNAVAILABLE");
    return pending;
  }

  claim(input) {
    const parsed = claimSchema.safeParse(input);
    if (!parsed.success) throw Error("DESKTOP_NATIVE_INVALID");
    const pending = this.pendingFor(parsed.data);
    if (pending.claimed || pending.request.action.type === "observe")
      throw Error("DESKTOP_NATIVE_UNAVAILABLE");
    pending.claimed = true;
    if (pending.ctx.desktopWindowTask)
      pending.ctx.desktopWindowTaskNativeClaimed = true;
    return {
      accepted: true,
      expiresAt: Math.min(Date.now() + CLAIM_MS, pending.request.expiresAt),
    };
  }

  receive(input) {
    const parsed = resultSchema.safeParse(input);
    if (!parsed.success) throw Error("DESKTOP_NATIVE_INVALID");
    const { result } = parsed.data;
    const matchingHandoff = [...this.targetHandoffs].find(
      ([, { pending }]) => pending?.request.requestId === parsed.data.requestId,
    );
    const targetId = matchingHandoff?.[0];
    const handoff = matchingHandoff?.[1] ?? this.handoff;
    const unsettled = handoff?.pending;
    if (
      handoff?.state === "pending" &&
      unsettled &&
      this.host.client?.id === parsed.data.client &&
      ["roomEpoch", "grantId", "requestId"].every(
        (key) => unsettled.request[key] === parsed.data[key],
      )
    ) {
      unsettled.received = true;
      this.setHandoff(
        targetId,
        result &&
          "delivery" in result &&
          ["delivered_verified", "not_delivered"].includes(result.delivery)
          ? undefined
          : targetId
            ? undefined
            : { state: "unconfirmed" },
      );
      return { accepted: true };
    }
    const pending = this.pendingFor(parsed.data);
    if (
      result &&
      !(pending.request.action.type === "observe"
        ? "elements" in result
        : "delivery" in result)
    )
      throw Error("DESKTOP_NATIVE_INVALID");
    if (
      result &&
      "delivery" in result &&
      !pending.claimed &&
      (result.ok || result.delivery !== "not_delivered")
    )
      throw Error("DESKTOP_NATIVE_UNAVAILABLE");
    pending.received = true;
    if (
      pending.claimed &&
      (!result ||
        !("delivery" in result) ||
        !["delivered_verified", "not_delivered"].includes(result.delivery))
    )
      this.setHandoff(
        pending.grant.targetId,
        pending.grant.unified ? undefined : { state: "unconfirmed" },
      );
    if (result) pending.resolve(result);
    else pending.reject(Error("DESKTOP_NATIVE_RESULT_UNKNOWN"));
    return { accepted: true };
  }

  setHandoff(targetId, value) {
    if (!targetId) this.handoff = value;
    else if (value) this.targetHandoffs.set(targetId, value);
    else this.targetHandoffs.delete(targetId);
  }

  unifiedGrant(ctx, agent, grantId) {
    const grant = this.unified.get(grantId, agent.id);
    const epoch = ctx.inputEpoch;
    const visit = this.host.live?.visits.get(agent.id);
    const client = this.host.client;
    const current = () => {
      try {
        this.host.runtime.assertActive(ctx);
        return (
          ctx.inputEpoch === epoch &&
          this.host.client === client &&
          this.host.live?.visits.get(agent.id) === visit &&
          this.current(grant)
        );
      } catch {
        return false;
      }
    };
    if (!current()) throw Error(this.unavailable);
    return { grant, current };
  }

  async run(ctx, action) {
    const { runtime } = this.host;
    const agent = runtime.assertActive(ctx);
    const unified =
      ctx.desktopUnified &&
      ctx.runtimeKind === "desktop" &&
      ctx.conversation === DESKTOP_CONVERSATION;
    if (action.type === "request") {
      if (!unified || !this.unified.eligible().includes(agent.id))
        throw Error(this.unavailable);
      const prior = this.requestReceipts().find(
        (item) => item.agentId === agent.id && item.target === action.target,
      );
      if (prior?.status === "pending")
        return { status: "pending", requestId: prior.requestId };
      if (prior) this.controlRequests.delete(prior.requestId);
      const requestId = randomUUID();
      this.controlRequests.set(requestId, {
        requestId,
        agentId: agent.id,
        target: action.target,
        status: "pending",
        visit: this.host.live.visits.get(agent.id),
      });
      this.host.notify();
      return { status: "pending", requestId };
    }
    if (action.type === "grants" || action.type === "revoke") {
      if (!unified) throw Error(this.unavailable);
      if (action.type === "grants") {
        const requests = this.requestReceipts().filter(
          (item) => item.agentId === agent.id,
        );
        return {
          grants: this.unified.list(agent.id),
          ...(requests.length && { requests }),
        };
      }
      return { revoked: this.revokeUnified(action.grantId, agent.id) };
    }
    if (!unified && action.grantId) throw Error(this.unavailable);
    const { grant, current } = unified
      ? this.unifiedGrant(ctx, agent, action.grantId)
      : this.activeGrant(ctx, agent);
    if (action.type === "set-value") {
      runtime.assertSafeOutput(ctx, action.text);
      recallBoundary(runtime, ctx, { publicOnly: true }).assert({
        evidence: [...ctx.privateRead],
      });
    }
    const { targetId } = grant;
    if (targetId) {
      const handoff = this.targetHandoffs.get(targetId);
      if (handoff && handoff.pending.request.expiresAt <= Date.now())
        this.targetHandoffs.delete(targetId);
      if (
        this.targetOperations.has(targetId) ||
        this.targetHandoffs.has(targetId)
      )
        throw Error(this.unavailable);
    } else if (this.pending || this.handoff) throw Error(this.unavailable);
    if (ctx.desktopWindowTask) {
      if (ctx.desktopWindowTaskActionStarted)
        throw Error("DESKTOP_NATIVE_UNAVAILABLE");
      if (action.type !== "observe") ctx.desktopWindowTaskActionStarted = true;
    }
    if ((ctx.desktopNativeCalls ?? 0) >= 12)
      throw Error("DESKTOP_NATIVE_LIMIT");
    ctx.desktopNativeCalls = (ctx.desktopNativeCalls ?? 0) + 1;
    const expiresAt = Date.now() + REQUEST_MS;
    const pending = {
      ...Promise.withResolvers(),
      ctx,
      grant,
      current: () => Date.now() < expiresAt && current(),
      request: {
        roomEpoch: targetId ? this.host.live.room.epoch : grant.roomEpoch,
        grantId: grant.grantId,
        requestId: randomUUID(),
        turnId: ctx.turnId,
        ...(targetId && { targetId }),
        ...(ctx.desktopWindowTask && {
          windowTaskId: ctx.desktopWindowTask.id,
        }),
        expiresAt,
        action: Object.fromEntries(
          Object.entries(action).filter(([key]) => key !== "grantId"),
        ),
      },
    };
    if (targetId) this.targetOperations.set(targetId, pending);
    else this.pending = pending;
    this.host.notify();
    const signal = ctx.controller.signal;
    const abort = () => pending.reject(Error("DESKTOP_NATIVE_RESULT_UNKNOWN"));
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, REQUEST_MS);
    try {
      const result = await pending.promise;
      if (!current()) throw Error("DESKTOP_NATIVE_RESULT_UNKNOWN");
      if (action.type === "observe") {
        ctx.desktopPrivateObservation = true;
        ctx.recordDesktopRestrictedGrant?.(DESKTOP_NATIVE_CONTROL, grant, this);
      }
      if (
        ctx.desktopWindowTask &&
        action.type !== "observe" &&
        result.ok &&
        result.delivery === "delivered_verified"
      )
        ctx.desktopWindowTaskUsed = true;
      runtime.stageToolOutput(ctx, result, [{ value: result, current }]);
      return result;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (targetId) this.targetOperations.delete(targetId);
      else if (this.pending === pending) this.pending = null;
      this.host.notify();
      if (pending.claimed && !pending.received) {
        if (targetId && Date.now() < expiresAt)
          this.setHandoff(targetId, { state: "pending", pending });
        else if (!targetId && !this.handoff)
          this.handoff = { state: "unconfirmed" };
      }
    }
  }
}
