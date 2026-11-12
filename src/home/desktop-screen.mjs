import { randomUUID } from "node:crypto";
import { z } from "zod";
import { imageMime } from "../tools/media.mjs";
import { mediaLease } from "../tools/media-lease.mjs";
import { DESKTOP_SCREEN_VIEW } from "../tools/names.mjs";
import { DESKTOP_CONVERSATION } from "./desktop-decision.mjs";

const MAX_BYTES = 44 * 1024;
const CAPTURE_MS = 8_000;
const maxEncoded = Math.ceil(MAX_BYTES / 3) * 4;
export const MAX_DESKTOP_SCREEN_BODY = maxEncoded + 512;
const uuid = z.string().uuid();
export const screenGrantSchema = z
  .object({
    roomEpoch: uuid,
    grantId: uuid,
    agentId: z.string().min(1).max(64),
  })
  .strict();
export const screenRevokeSchema = z
  .object({ roomEpoch: uuid, grantId: uuid })
  .strict();
const resultSchema = screenRevokeSchema
  .extend({
    client: uuid,
    requestId: uuid,
    data: z.string().min(4).max(maxEncoded).optional(),
  })
  .strict();

export class DesktopScreen {
  constructor(host) {
    this.host = host;
  }

  eligible() {
    const { live, runtime } = this.host;
    return (live?.here() ?? []).filter(({ id }) =>
      runtime
        .toolsFor(runtime.agent(id), DESKTOP_CONVERSATION)
        .includes(DESKTOP_SCREEN_VIEW),
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
    this.pending?.reject(Error("DESKTOP_SCREEN_UNAVAILABLE"));
    this.pending = null;
  }

  change(action, value) {
    const { live } = this.host;
    if (value.roomEpoch !== live.room.epoch)
      throw Error("DESKTOP_SCREEN_UNAVAILABLE");
    if (action === "screen-revoke") {
      if (this.grant?.grantId === value.grantId) this.clear();
      return;
    }
    if (!this.eligible().some(({ id }) => id === value.agentId))
      throw Error("DESKTOP_SCREEN_UNAVAILABLE");
    this.clear();
    this.grant = { ...value, visit: live.visits.get(value.agentId) };
  }

  request() {
    const pending = this.pending;
    if (pending?.current() && !pending.received) return pending.request;
  }

  receive(input) {
    const parsed = resultSchema.safeParse(input);
    if (!parsed.success) throw Error("DESKTOP_SCREEN_INVALID");
    const { client, roomEpoch, grantId, requestId, data } = parsed.data;
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
    if (data) {
      const bytes = Buffer.from(data, "base64");
      try {
        if (
          bytes.length > MAX_BYTES ||
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
    if (data) pending.resolve(data);
    else pending.reject(Error("DESKTOP_SCREEN_CAPTURE_FAILED"));
    return { accepted: true };
  }

  async view(ctx) {
    const { runtime } = this.host;
    const agent = runtime.assertActive(ctx);
    const grant = this.grant;
    const epoch = ctx.inputEpoch;
    const current = () => {
      try {
        runtime.assertActive(ctx);
        return (
          ctx.inputEpoch === epoch &&
          ctx.runtimeKind === "desktop" &&
          grant?.agentId === agent.id &&
          this.current(grant)
        );
      } catch {
        return false;
      }
    };
    if (!current() || this.pending || ctx.desktopScreenObserved)
      throw Error("DESKTOP_SCREEN_UNAVAILABLE");
    const pending = {
      ...Promise.withResolvers(),
      current,
      request: {
        roomEpoch: grant.roomEpoch,
        grantId: grant.grantId,
        requestId: randomUUID(),
        maxEdge: Math.min(1024, agent.behavior.imageInput.maxEdge),
        maxBytes: MAX_BYTES,
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
      const data = await pending.promise;
      if (!current()) throw Error("DESKTOP_SCREEN_UNAVAILABLE");
      // The native transcript may contain the pixels even if its output
      // receipt is lost. Retire that session before another turn can resume it.
      ctx.desktopScreenObserved = true;
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
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (this.pending === pending) this.pending = null;
    }
  }
}
