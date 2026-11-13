import { randomUUID } from "node:crypto";
import { DESKTOP_CONVERSATION } from "./desktop-decision.mjs";
import { DESKTOP_BODY_CONTROL } from "../tools/names.mjs";
import { bodyClaimSchema, bodyResultSchema } from "./desktop-body-protocol.mjs";

const ACTION_TIMEOUT = 6000;
const TURN_ACTION_LIMIT = 8;

export class DesktopBody {
  pending = new Map();
  receipts = new WeakMap();

  constructor(host) {
    this.host = host;
  }

  clear() {
    for (const entry of this.pending.values())
      this.invalidate(entry, "inactive");
  }

  current(entry) {
    const { host } = this;
    const { ctx, live, visit, client, request } = entry;
    if (
      host.live !== live ||
      host.client !== client ||
      host.runtime.updateMaintenance ||
      !host.connected(ctx) ||
      live.visits.get(ctx.agentId) !== visit ||
      live.room.turn !== entry.turn ||
      host.runtime.running.get(ctx.agentId + "|" + DESKTOP_CONVERSATION) !==
        ctx ||
      Date.now() >= request.expiresAt
    )
      return false;
    try {
      const agent = host.runtime.assertActive(ctx);
      return host.runtime
        .toolsForContext(agent, ctx)
        .includes(DESKTOP_BODY_CONTROL);
    } catch {
      return false;
    }
  }

  clientWork() {
    const requests = [];
    for (const entry of this.pending.values()) {
      if (this.current(entry))
        requests.push({ ...entry.request, cancel: entry.cancel });
      else this.invalidate(entry, "inactive");
    }
    return requests;
  }

  lookup({ client, roomEpoch, commandId }) {
    const entry = [...this.pending.values()].find(
      ({ request }) => request.commandId === commandId,
    );
    if (
      !entry ||
      entry.client.id !== client ||
      entry.request.roomEpoch !== roomEpoch ||
      !this.current(entry)
    )
      throw Error("DESKTOP_BODY_UNAVAILABLE");
    return entry;
  }

  claim(input) {
    const parsed = bodyClaimSchema.safeParse(input);
    if (!parsed.success) throw Error("DESKTOP_BODY_INVALID");
    const entry = this.lookup(parsed.data);
    if (entry.claimed || entry.cancel) throw Error("DESKTOP_BODY_UNAVAILABLE");
    entry.claimed = true;
    return { accepted: true, expiresAt: entry.request.expiresAt };
  }

  receive(input) {
    const parsed = bodyResultSchema.safeParse(input);
    if (!parsed.success) throw Error("DESKTOP_BODY_INVALID");
    const entry = this.lookup(parsed.data);
    if (!entry.claimed) throw Error("DESKTOP_BODY_UNAVAILABLE");
    this.finish(entry, parsed.data.result);
    return { accepted: true };
  }

  finish(entry, result) {
    if (this.pending.get(entry.ctx.agentId) !== entry) return;
    this.pending.delete(entry.ctx.agentId);
    clearTimeout(entry.timer);
    entry.ctx.controller.signal.removeEventListener("abort", entry.abort);
    entry.receipt.result = {
      ...result,
      requestId: entry.request.action.requestId,
    };
    entry.receipt.resolve(entry.receipt.result);
  }

  invalidate(entry, reason) {
    this.finish(entry, {
      status: entry.claimed ? "unknown" : "cancelled",
      reason,
    });
  }

  run(ctx, action) {
    const { host } = this;
    const agent = host.runtime.assertActive(ctx);
    const { live, client } = host;
    const visit = live?.visits.get(ctx.agentId);
    const turn = live?.room.turn;
    const input = live?.room.messages.findLast(
      ({ speakerType }) => speakerType === "administrator",
    );
    if (
      ctx.runtimeKind !== "desktop" ||
      ctx.conversation !== DESKTOP_CONVERSATION ||
      !host.connected(ctx) ||
      host.runtime.updateMaintenance ||
      !visit ||
      turn?.actor !== agent.id ||
      host.runtime.running.get(agent.id + "|" + DESKTOP_CONVERSATION) !== ctx ||
      !input ||
      !host.runtime.toolsForContext(agent, ctx).includes(DESKTOP_BODY_CONTROL)
    )
      throw Error("DESKTOP_BODY_UNAVAILABLE");

    const pending = this.pending.get(agent.id);
    if (!this.receipts.has(ctx)) this.receipts.set(ctx, new Map());
    const receipts = this.receipts.get(ctx);
    if (action.type === "stop") {
      if (pending?.ctx !== ctx) return { status: "idle" };
      if (!pending.claimed) this.invalidate(pending, "stopped");
      else pending.cancel = true;
      return pending.receipt.promise;
    }
    const old = receipts.get(action.requestId);
    if (action.type === "status") {
      const status = !old
        ? "missing"
        : old.entry.claimed
          ? "executing"
          : "queued";
      return old?.result ?? { requestId: action.requestId, status };
    }
    if (old) {
      if (
        old.entry.request.action.type !== action.type ||
        old.entry.request.action.target !== action.target ||
        old.entry.request.action.facing !== action.facing
      )
        throw Error("DESKTOP_BODY_INVALID");
      return old.promise;
    }
    if (pending) throw Error("DESKTOP_BODY_BUSY");
    if (receipts.size >= TURN_ACTION_LIMIT) throw Error("DESKTOP_BODY_LIMIT");

    const receipt = Promise.withResolvers();
    const entry = {
      ctx,
      live,
      client,
      visit,
      turn,
      receipt,
      claimed: false,
      cancel: false,
      request: {
        agentId: agent.id,
        roomEpoch: live.room.epoch,
        commandId: randomUUID(),
        expiresAt: Date.now() + ACTION_TIMEOUT,
        inputAt: input.now,
        action,
      },
      abort: () => this.invalidate(entry, "inactive"),
      timer: setTimeout(
        () => this.invalidate(entry, "timeout"),
        ACTION_TIMEOUT,
      ),
    };
    receipt.entry = entry;
    receipts.set(action.requestId, receipt);
    this.pending.set(agent.id, entry);
    ctx.controller.signal.addEventListener("abort", entry.abort, {
      once: true,
    });
    return receipt.promise;
  }
}
