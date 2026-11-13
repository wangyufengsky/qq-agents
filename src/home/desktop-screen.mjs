import { randomUUID } from "node:crypto";
import { z } from "zod";
import { imageMime } from "../tools/media.mjs";
import { mediaLease } from "../tools/media-lease.mjs";
import { DESKTOP_SCREEN_VIEW } from "../tools/names.mjs";
import {
  DesktopLocalGrant,
  localRevokeSchema,
} from "./desktop-local-grant.mjs";

const MAX_BYTES = 44 * 1024;
const CAPTURE_MS = 8_000;
const maxEncoded = Math.ceil(MAX_BYTES / 3) * 4;
export const MAX_DESKTOP_SCREEN_BODY = maxEncoded + 512;
const uuid = z.string().uuid();
const resultSchema = localRevokeSchema
  .extend({
    client: uuid,
    requestId: uuid,
    data: z.string().min(4).max(maxEncoded).optional(),
    status: z
      .enum(["duplicate", "minimized", "unavailable", "permission"])
      .optional(),
  })
  .strict()
  .refine(({ data, status }) => !(data && status));

export class DesktopScreen extends DesktopLocalGrant {
  constructor(host) {
    super(host, DESKTOP_SCREEN_VIEW, "DESKTOP_SCREEN_UNAVAILABLE");
  }

  clear() {
    super.clear();
    this.pending?.reject(Error("DESKTOP_SCREEN_UNAVAILABLE"));
    this.pending = null;
  }

  cancel(grant) {
    if (this.pending?.grant === grant)
      this.pending.reject(Error("DESKTOP_SCREEN_UNAVAILABLE"));
  }

  request() {
    const pending = this.pending;
    if (pending?.current() && !pending.received) return pending.request;
  }

  claim(input) {
    const parsed = resultSchema.safeParse(input);
    if (!parsed.success || parsed.data.data || parsed.data.status)
      throw Error("DESKTOP_SCREEN_INVALID");
    const pending = this.lookup(parsed.data);
    if (pending.request.mode !== "observation" || pending.claimed)
      throw Error("DESKTOP_SCREEN_UNAVAILABLE");
    pending.claimed = true;
    return { accepted: true };
  }

  lookup({ client, roomEpoch, grantId, requestId }) {
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
      throw Error("DESKTOP_SCREEN_UNAVAILABLE");
    return pending;
  }

  receive(input) {
    const parsed = resultSchema.safeParse(input);
    if (!parsed.success) throw Error("DESKTOP_SCREEN_INVALID");
    const { data, status } = parsed.data;
    const pending = this.lookup(parsed.data);
    const observe = pending.request.mode === "observation";
    if ((observe && !pending.claimed) || (status && !observe))
      throw Error("DESKTOP_SCREEN_UNAVAILABLE");
    if (data) {
      const bytes = Buffer.from(data, "base64");
      try {
        if (
          bytes.length > pending.request.maxBytes ||
          bytes.toString("base64") !== data ||
          imageMime(bytes) !== "image/jpeg" ||
          bytes.at(-2) !== 0xff ||
          bytes.at(-1) !== 0xd9
        )
          throw Error("INVALID_IMAGE");
      } catch {
        throw Error("DESKTOP_SCREEN_INVALID");
      }
    }
    pending.received = true;
    if (data) pending.resolve({ status: "frame", data });
    else if (status) pending.resolve({ status });
    else pending.reject(Error("DESKTOP_SCREEN_CAPTURE_FAILED"));
    return { accepted: true };
  }

  async view(ctx) {
    const { runtime } = this.host;
    const agent = runtime.assertActive(ctx);
    const { grant, current } = this.activeGrant(ctx, agent);
    if (ctx.desktopWindowTask) {
      if (ctx.desktopWindowTaskActionStarted)
        throw Error("DESKTOP_SCREEN_UNAVAILABLE");
      ctx.desktopWindowTaskActionStarted = true;
    }
    const { data } = await this.capture(ctx, agent, grant, current);
    if (!current()) throw Error("DESKTOP_SCREEN_UNAVAILABLE");
    // The native transcript can contain the pixels even if its receipt is lost.
    ctx.desktopScreenObserved = true;
    if (ctx.desktopWindowTask) ctx.desktopWindowTaskUsed = true;
    const result = {
      [mediaLease]: current,
      content: [
        {
          type: "text",
          text: "管理员为本轮选定的桌面画面。仅用于当前桌面对话。",
        },
        { type: "image", mimeType: "image/jpeg", data },
      ],
    };
    runtime.stageToolOutput(ctx, result, [{ value: result, current }]);
    return result;
  }

  async capture(ctx, agent, grant, current, mode) {
    if (this.pending || ctx.desktopScreenObserved)
      throw Error("DESKTOP_SCREEN_UNAVAILABLE");
    const pending = {
      ...Promise.withResolvers(),
      current,
      grant,
      request: {
        roomEpoch: grant.roomEpoch,
        grantId: grant.grantId,
        requestId: randomUUID(),
        ...(mode && { mode }),
        ...(ctx.desktopWindowTask && {
          windowTaskId: ctx.desktopWindowTask.id,
        }),
        maxEdge: Math.min(1024, agent.behavior.imageInput.maxEdge),
        maxBytes: mode
          ? Math.min(MAX_BYTES, agent.behavior.imageInput.maxBytes)
          : MAX_BYTES,
      },
    };
    this.pending = pending;
    const signal = ctx.controller.signal;
    const abort = () => pending.reject(Error("DESKTOP_SCREEN_UNAVAILABLE"));
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => pending.reject(Error("DESKTOP_SCREEN_CAPTURE_FAILED")),
      CAPTURE_MS,
    );
    try {
      const frame = await pending.promise;
      if (!current()) throw Error("DESKTOP_SCREEN_UNAVAILABLE");
      return frame;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (this.pending === pending) this.pending = null;
    }
  }
}
