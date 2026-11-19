import { randomUUID } from "node:crypto";
import { z } from "zod";
import { imageMime } from "../tools/media.mjs";
import { mediaLease, mediaSubmitted } from "../tools/media-lease.mjs";

import {
  desktopCaptureBatch,
  MAX_DESKTOP_CAPTURE_BYTES,
  MAX_DESKTOP_CAPTURE_DISPLAYS,
  MAX_DESKTOP_CAPTURE_ENCODED as maxEncoded,
} from "./desktop-capture-protocol.mjs";
const uuid = z.uuid();
const identity = z.strictObject({
  roomEpoch: uuid,
  agentId: z.string().min(1).max(64),
  visitId: uuid,
  requestId: uuid,
  observationRevision: z.number().int().nonnegative(),
});
const coordinate = z.number().int().min(-1_000_000).max(1_000_000);
const dimension = z.number().int().positive().max(1_000_000);
const framesSchema = z
  .array(
    z.strictObject({
      displayId: z.string().regex(/^-?[0-9]{1,20}$/),
      bounds: z.strictObject({
        x: coordinate,
        y: coordinate,
        width: dimension,
        height: dimension,
      }),
      width: dimension,
      height: dimension,
      data: z.string().min(4).max(maxEncoded),
    }),
  )
  .min(1)
  .max(MAX_DESKTOP_CAPTURE_DISPLAYS);
const receiptSchema = z.union([
  identity.extend({ client: uuid, frames: framesSchema }),
  identity.extend({
    client: uuid,
    status: z.enum(["permission", "unavailable"]),
  }),
]);

function validFrame({ data, width, height }, { maxEdge, maxBytes }) {
  const bytes = Buffer.from(data, "base64");
  return (
    width <= maxEdge &&
    height <= maxEdge &&
    bytes.length <= maxBytes &&
    bytes.toString("base64") === data &&
    imageMime(bytes) === "image/jpeg" &&
    bytes.at(-2) === 0xff &&
    bytes.at(-1) === 0xd9
  );
}

export class DesktopFullDesktop {
  revision = 0;
  enabled = false;

  constructor(host) {
    this.host = host;
  }

  isEnabled() {
    const policy = this.host.runtime.config.desktopHome;
    return this.host.desktopUnified
      ? policy.observeDesktop === true
      : policy.screenView?.enabled === true;
  }

  maintain() {
    const enabled = this.isEnabled();
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    this.revision++;
    if (!enabled) this.clear();
  }

  clear() {
    this.pending?.reject(Error("DESKTOP_SCREEN_UNAVAILABLE"));
    this.pending = undefined;
  }

  request() {
    const pending = this.pending;
    if (pending?.current() && !pending.received) return pending.request;
  }

  receive(data) {
    const parsed = receiptSchema.safeParse(data);
    if (!parsed.success) throw Error("DESKTOP_SCREEN_INVALID");
    const result = parsed.data;
    const pending = this.pending;
    if (
      !pending ||
      pending.received ||
      !pending.current() ||
      pending.client !== result.client ||
      Object.keys(identity.shape).some(
        (key) => pending.request[key] !== result[key],
      )
    )
      throw Error("DESKTOP_SCREEN_UNAVAILABLE");
    if ("frames" in result) {
      const { frames } = result;
      if (
        new Set(frames.map(({ displayId }) => displayId)).size !==
          frames.length ||
        frames.some((frame) => !validFrame(frame, pending.request)) ||
        frames.reduce(
          (bytes, frame) => bytes + Buffer.byteLength(frame.data, "base64"),
          0,
        ) > pending.request.maxBytes
      )
        throw Error("DESKTOP_SCREEN_INVALID");
      pending.received = true;
      pending.resolve(frames);
    } else {
      pending.received = true;
      pending.reject(
        Error(
          result.status === "permission"
            ? "DESKTOP_SCREEN_PERMISSION"
            : "DESKTOP_SCREEN_CAPTURE_FAILED",
        ),
      );
    }
    return { accepted: true };
  }

  async view(ctx) {
    this.maintain();
    const { host } = this;
    const { runtime, live, client } = host;
    const agent = runtime.assertActive(ctx);
    if (host.desktopUnified && !this.enabled)
      throw Error("DESKTOP_SCREEN_DENIED");
    const visit = live?.visits.get(agent.id);
    const epoch = ctx.inputEpoch;
    const revision = this.revision;
    const current = () => {
      try {
        runtime.assertActive(ctx);
        return (
          ctx.runtimeKind === "desktop" &&
          ctx.inputEpoch === epoch &&
          this.revision === revision &&
          this.isEnabled() &&
          host.connected(ctx) &&
          host.client === client &&
          client?.desktopCaptureProtocol === 1 &&
          host.live === live &&
          visit &&
          live.visits.get(agent.id) === visit &&
          live.room.members[agent.id] === "here"
        );
      } catch {
        return false;
      }
    };
    while (this.pending && current()) await this.pending.finished.promise;
    if (!current()) throw Error("DESKTOP_SCREEN_UNAVAILABLE");
    const request = {
      roomEpoch: live.room.epoch,
      agentId: agent.id,
      visitId: host.body.visitId(visit),
      requestId: randomUUID(),
      observationRevision: revision,
      maxEdge: agent.behavior.imageInput.maxEdge,
      maxBytes: Math.min(
        MAX_DESKTOP_CAPTURE_BYTES,
        agent.behavior.imageInput.maxBytes,
      ),
    };
    const pending = {
      ...Promise.withResolvers(),
      finished: Promise.withResolvers(),
      request,
      client: client.id,
      current,
    };
    const signal = ctx.controller.signal;
    const abort = () => pending.reject(Error("DESKTOP_SCREEN_UNAVAILABLE"));
    this.pending = pending;
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => pending.reject(Error("DESKTOP_SCREEN_CAPTURE_FAILED")),
      8000,
    );
    try {
      host.notify();
      const frames = await pending.promise;
      if (!current()) throw Error("DESKTOP_SCREEN_UNAVAILABLE");
      const result = {
        [desktopCaptureBatch]: true,
        [mediaLease]: current,
        [mediaSubmitted]: () => {
          if (current()) ctx.onDesktopFrameSubmitted?.(request.requestId);
        },
        content: frames.flatMap(({ displayId, bounds, data }) => [
          {
            type: "text",
            text: `显示器 ${displayId}，桌面坐标 (${bounds.x}, ${bounds.y})，尺寸 ${bounds.width} × ${bounds.height}。`,
          },
          { type: "image", mimeType: "image/jpeg", data },
        ]),
      };
      runtime.stageToolOutput(ctx, result, [{ value: result, current }]);
      ctx.onDesktopFramePrepared?.(request.requestId);
      return result;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (this.pending === pending) this.pending = undefined;
      pending.finished.resolve();
      host.notify();
    }
  }
}
