import { randomUUID } from "node:crypto";
import { z } from "zod";
import { recallBoundary } from "../core/recall-boundary.mjs";
import { DESKTOP_NATIVE_CONTROL } from "../tools/names.mjs";
import {
  DESKTOP_CONVERSATION,
  DESKTOP_WINDOW_TASK_CONVERSATION,
} from "./desktop-decision.mjs";
import { DesktopLocalGrant } from "./desktop-local-grant.mjs";

const uuid = z.string().uuid();
const ref = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9_-]+$/);
export const nativeActionSchema = z.discriminatedUnion("type", [
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
  }

  clear() {
    super.clear();
    this.pending?.reject(Error("DESKTOP_NATIVE_RESULT_UNKNOWN"));
    this.pending = null;
  }

  request() {
    const pending = this.pending;
    if (pending?.current() && !pending.received) return pending.request;
  }

  clientWork() {
    if (!this.current(this.grant)) return {};
    const { runtime } = this.host;
    const id = this.grant.agentId + "|";
    const ctx =
      runtime.running.get(id + DESKTOP_WINDOW_TASK_CONVERSATION) ??
      runtime.running.get(id + DESKTOP_CONVERSATION);
    if (!ctx?.turnId || ctx.controller.signal.aborted) return {};
    const nativeRequest = this.request();
    return {
      nativeTurnId: ctx.turnId,
      ...(nativeRequest && { nativeRequest }),
    };
  }

  pendingFor({ client, roomEpoch, grantId, requestId }) {
    const pending = this.pending;
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
    const pending = this.pendingFor(parsed.data);
    const { result } = parsed.data;
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
    if (result) pending.resolve(result);
    else pending.reject(Error("DESKTOP_NATIVE_RESULT_UNKNOWN"));
    return { accepted: true };
  }

  async run(ctx, action) {
    const { runtime } = this.host;
    const agent = runtime.assertActive(ctx);
    const { grant, current } = this.activeGrant(ctx, agent);
    if (action.type === "set-value") {
      runtime.assertSafeOutput(ctx, action.text);
      recallBoundary(runtime, ctx, { publicOnly: true }).assert({
        evidence: [...ctx.privateRead],
      });
    }
    if (this.pending) throw Error("DESKTOP_NATIVE_UNAVAILABLE");
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
      current: () => Date.now() < expiresAt && current(),
      request: {
        roomEpoch: grant.roomEpoch,
        grantId: grant.grantId,
        requestId: randomUUID(),
        turnId: ctx.turnId,
        ...(ctx.desktopWindowTask && {
          windowTaskId: ctx.desktopWindowTask.id,
        }),
        expiresAt,
        action,
      },
    };
    this.pending = pending;
    const signal = ctx.controller.signal;
    const abort = () => pending.reject(Error("DESKTOP_NATIVE_RESULT_UNKNOWN"));
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, REQUEST_MS);
    try {
      const result = await pending.promise;
      if (!current()) throw Error("DESKTOP_NATIVE_RESULT_UNKNOWN");
      if (action.type === "observe") ctx.desktopPrivateObservation = true;
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
      if (this.pending === pending) this.pending = null;
    }
  }
}
