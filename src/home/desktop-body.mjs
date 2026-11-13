import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  DESKTOP_ACTIVITY_CONVERSATION,
  DESKTOP_OBSERVATION_CONVERSATION,
  DESKTOP_WINDOW_TASK_CONVERSATION,
  isDesktopActivity,
  isDesktopConversation,
} from "./desktop-decision.mjs";
import { rhythmStatus } from "../core/rhythm.mjs";
import { DESKTOP_BODY_CONTROL } from "../tools/names.mjs";
import { bodyClaimSchema, bodyResultSchema } from "./desktop-body-protocol.mjs";

const ACTION_TIMEOUT = 6000;
const RECOVERY_WINDOW = 3000;
const LAYOUT_MAX_AGE = 5000;
const TURN_ACTION_LIMIT = 8;
const INTERACTIVE_ACTIONS = new Set(["gesture", "interaction", "window-task"]);

function canAct(runtime, agent, ctx) {
  const { state } = rhythmStatus(runtime, agent);
  return (
    state !== "sleeping" &&
    state !== "rest-pending" &&
    runtime.toolsForContext(agent, ctx).includes(DESKTOP_BODY_CONTROL)
  );
}

function freshSample(sampledAt, now) {
  return sampledAt <= now && now - sampledAt < LAYOUT_MAX_AGE;
}

function validSpace(space, result, now) {
  const displays = new Set(space.displays.map(({ ref }) => ref));
  const { self, residents, door } = space;
  return (
    freshSample(space.sampledAt, now) &&
    displays.size === space.displays.length &&
    displays.has(self.displayRef) &&
    (!door || displays.has(door.displayRef)) &&
    residents.every(({ displayRef }) => displays.has(displayRef)) &&
    new Set(residents.map(({ ref }) => ref)).size === residents.length &&
    (!self.action?.destination ||
      displays.has(self.action.destination.displayRef)) &&
    result.position.x === self.bounds.x &&
    result.position.y === self.bounds.y &&
    result.facing === self.facing
  );
}

function validateTarget(action, snapshot, crossDisplay) {
  const { space, receivedAt } = snapshot ?? {};
  const now = Date.now();
  if (
    !space ||
    space.layoutVersion !== action.layoutVersion ||
    !freshSample(receivedAt, now) ||
    !freshSample(space.sampledAt, now)
  )
    throw Error("DESKTOP_BODY_STALE_LAYOUT");
  const { target } = action;
  const displayRef =
    target.type === "near-resident"
      ? space.residents.find(({ ref }) => ref === target.residentRef)
          ?.displayRef
      : target.displayRef;
  const display = space.displays.find(({ ref }) => ref === displayRef);
  if (!display || (!crossDisplay && displayRef !== space.self.displayRef))
    throw Error("DESKTOP_BODY_INVALID");
  if (target.type !== "point") return;
  const { workArea } = display;
  const { width, height } = space.self.bounds;
  if (
    target.x < workArea.x ||
    target.y < workArea.y ||
    target.x + width > workArea.x + workArea.width ||
    target.y + height > workArea.y + workArea.height
  )
    throw Error("DESKTOP_BODY_INVALID");
}

export class DesktopBody {
  pending = new Map();
  receipts = new WeakMap();
  visitIds = new WeakMap();
  spaces = new WeakMap();

  constructor(host) {
    this.host = host;
  }

  clear() {
    for (const entry of this.pending.values())
      this.invalidate(entry, "inactive");
  }

  visitId(visit) {
    if (!this.visitIds.has(visit)) this.visitIds.set(visit, randomUUID());
    return this.visitIds.get(visit);
  }

  current(entry) {
    const { host } = this;
    const { ctx, live, visit, client } = entry;
    if (
      host.live !== live ||
      host.client !== client ||
      host.runtime.updateMaintenance ||
      !host.connected(ctx) ||
      live.visits.get(ctx.agentId) !== visit ||
      live.turnFor(ctx.agentId) !== entry.turn ||
      (entry.greeting &&
        (!live.publicEnabled() ||
          live.visits.get(entry.greeting.recipient) !== entry.greeting.visit ||
          (entry.greeting.reply &&
            !live.perception.greeting(
              ctx.agentId,
              visit,
              entry.greeting.reply.id,
            )))) ||
      (INTERACTIVE_ACTIONS.has(entry.request.action.type) &&
        !(entry.greeting
          ? host.publicBodyAvailable()
          : entry.request.interaction
            ? host.socialBodyAvailable()
            : host.interactionsAvailable())) ||
      (entry.request.interaction &&
        !live.interactionStep(
          ctx.agentId,
          entry.request.action.interactionId,
        )) ||
      host.runtime.running.get(ctx.agentId + "|" + ctx.conversation) !== ctx
    )
      return false;
    try {
      return canAct(host.runtime, host.runtime.assertActive(ctx), ctx);
    } catch {
      return false;
    }
  }

  clientWork() {
    const requests = [];
    const now = Date.now();
    for (const entry of this.pending.values()) {
      if (!this.current(entry)) this.invalidate(entry, "inactive");
      else if (now < entry.request.expiresAt)
        requests.push({ ...entry.request, cancel: entry.cancel });
      else if (!entry.claimed || !entry.v2 || now >= entry.recoverUntil)
        this.invalidate(entry, "timeout");
    }
    return requests;
  }

  lookup({ client, roomEpoch, commandId, agentId, visitId }) {
    const entry = [...this.pending.values()].find(
      ({ request }) => request.commandId === commandId,
    );
    if (
      !entry ||
      entry.client.id !== client ||
      entry.request.roomEpoch !== roomEpoch ||
      entry.request.visitId !== visitId ||
      (entry.v2 ? entry.request.agentId !== agentId : agentId !== undefined) ||
      !this.current(entry)
    )
      throw Error("DESKTOP_BODY_UNAVAILABLE");
    return entry;
  }

  claim(input) {
    const parsed = bodyClaimSchema.safeParse(input);
    if (!parsed.success) throw Error("DESKTOP_BODY_INVALID");
    const entry = this.lookup(parsed.data);
    const now = Date.now();
    if (entry.claimed || entry.cancel || now >= entry.request.expiresAt)
      throw Error("DESKTOP_BODY_UNAVAILABLE");
    entry.claimed = true;
    entry.claimedAt = now;
    if (entry.v2) {
      // Only a claim can hold its receipt open past the execution deadline.
      clearTimeout(entry.timer);
      entry.timer = setTimeout(
        () => this.invalidate(entry, "timeout"),
        entry.recoverUntil - now,
      );
    }
    return { accepted: true, expiresAt: entry.request.expiresAt };
  }

  receive(input) {
    const parsed = bodyResultSchema.safeParse(input);
    if (!parsed.success) throw Error("DESKTOP_BODY_INVALID");
    this.accept(parsed.data, false);
    return { accepted: true };
  }

  reconcile(client, records) {
    const accepted = [];
    for (const evidence of records) {
      try {
        this.accept({ ...evidence, client }, true);
        accepted.push(evidence.commandId);
      } catch (error) {
        if (
          error.message !== "DESKTOP_BODY_UNAVAILABLE" &&
          error.message !== "DESKTOP_BODY_INVALID"
        )
          throw error;
      }
    }
    return accepted;
  }

  accept(input, recovered) {
    const entry = this.lookup(input);
    const { finishedAt, result } = input;
    const now = Date.now();
    const { expiresAt } = entry.request;
    if (
      !entry.claimed ||
      (recovered ? !entry.v2 || now >= entry.recoverUntil : now >= expiresAt) ||
      (entry.v2 &&
        (!Number.isFinite(finishedAt) ||
          finishedAt < entry.claimedAt ||
          finishedAt > now ||
          finishedAt >= expiresAt ||
          now - finishedAt >= RECOVERY_WINDOW))
    )
      throw Error("DESKTOP_BODY_UNAVAILABLE");
    const windowTask = entry.request.action.type === "window-task";
    if (
      (result.arrivalConfirmed && !windowTask) ||
      (windowTask &&
        (result.position ||
          result.facing ||
          result.space ||
          (result.status === "completed" && !result.arrivalConfirmed)))
    )
      throw Error("DESKTOP_BODY_INVALID");
    if (result.space) {
      if (
        recovered ||
        !entry.v2 ||
        entry.request.action.type !== "state" ||
        result.status !== "completed" ||
        result.space.sampledAt < entry.claimedAt ||
        result.space.sampledAt > finishedAt ||
        !validSpace(result.space, result, now)
      )
        throw Error("DESKTOP_BODY_INVALID");
      this.spaces.set(entry.ctx, { space: result.space, receivedAt: now });
    }
    this.finish(
      entry,
      recovered ? { ...result, reconciled: true, finishedAt } : result,
    );
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
    if (
      ["move", "pose", "gesture", "interaction"].includes(
        entry.request.action.type,
      )
    )
      entry.ctx.onDesktopBodyResult?.({
        type: entry.request.action.type,
        ...(entry.request.action.target && {
          target: entry.request.action.target,
        }),
        ...result,
      });
    if (entry.request.interaction) entry.ctx.onDesktopInteractionResult(result);
    if (
      result.status !== "completed" ||
      !result.position ||
      !entry.live.publicEnabled() ||
      entry.request.observation ||
      entry.request.windowTask ||
      entry.ctx.desktopScreenObserved ||
      entry.ctx.desktopPrivateObservation
    )
      return;
    const { action } = entry.request;
    const { perception } = entry.live;
    if (entry.greeting) {
      const { recipient, reply } = entry.greeting;
      if (
        entry.live.visits.get(recipient) !== entry.greeting.visit ||
        (reply && reply.replied)
      )
        return;
      if (reply) reply.replied = true;
      perception.add("greeting", entry.ctx.agentId, {
        target: recipient,
        action: "wave",
        position: result.position,
        urgent: true,
        replyTo: reply?.id,
      });
    } else if (
      ["move", "pose", "gesture", "interaction"].includes(action.type)
    ) {
      const gesture =
        entry.request.interaction?.step ??
        action.gesture ??
        action.pose ??
        (typeof action.target === "string" ? action.target : action.type);
      perception.add("action", entry.ctx.agentId, {
        action: gesture,
        position: result.position,
      });
    }
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
    const turn = live?.turnFor(ctx.agentId);
    const inputAt = ctx.desktopBodyInputAt;
    if (
      ctx.runtimeKind !== "desktop" ||
      !isDesktopConversation(ctx.conversation) ||
      !host.connected(ctx) ||
      host.runtime.updateMaintenance ||
      !visit ||
      turn?.actor !== agent.id ||
      host.runtime.running.get(agent.id + "|" + ctx.conversation) !== ctx ||
      !Number.isFinite(inputAt) ||
      !canAct(host.runtime, agent, ctx)
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
      const positions = client.bodyPositions;
      const current = positions?.entries.get(agent.id);
      if (
        (old?.result?.status === "unknown" || old?.result?.reconciled) &&
        current?.visit === visit &&
        freshSample(positions.at, Date.now())
      )
        return { ...old.result, currentPosition: current.position };
      const status = !old
        ? "missing"
        : old.entry.claimed
          ? "executing"
          : "queued";
      return old?.result ?? { requestId: action.requestId, status };
    }
    if (old) {
      if (!isDeepStrictEqual(old.entry.request.action, action))
        throw Error("DESKTOP_BODY_INVALID");
      return old.promise;
    }
    if (pending) throw Error("DESKTOP_BODY_BUSY");
    if (receipts.size >= TURN_ACTION_LIMIT) throw Error("DESKTOP_BODY_LIMIT");
    if (
      isDesktopActivity(ctx.conversation) &&
      action.type !== "state" &&
      [...receipts.values()].some(
        ({ entry }) => entry.request.action.type !== "state",
      )
    )
      throw Error("DESKTOP_BODY_LIMIT");

    if (action.type !== "state" && ctx.desktopObservationRequested)
      throw Error("DESKTOP_BODY_UNAVAILABLE");
    const v2 = client.bodyProtocol === 2;
    if (("layoutVersion" in action || "pose" in action) && !v2)
      throw Error("DESKTOP_BODY_UNAVAILABLE");
    let interaction;
    if (action.type === "interaction") {
      if (
        ctx.conversation !== DESKTOP_ACTIVITY_CONVERSATION ||
        ctx.desktopInteractionStep?.id !== action.interactionId
      )
        throw Error("DESKTOP_BODY_UNAVAILABLE");
      const step = live.interactionStep(agent.id, action.interactionId);
      if (!step) throw Error("DESKTOP_BODY_UNAVAILABLE");
      interaction = {
        kind: step.kind,
        step: step.step,
        peerAgentId: step.peer.id,
        peerVisitId: this.visitId(step.peer.visit),
      };
    }
    let greeting;
    if (action.recipient !== undefined || action.replyTo !== undefined) {
      if (
        !host.publicBodyAvailable() ||
        action.type !== "gesture" ||
        action.gesture !== "wave" ||
        !action.recipient ||
        action.recipient === ctx.agentId ||
        ctx.desktopScreenObserved ||
        ctx.desktopPrivateObservation ||
        ctx.conversation === DESKTOP_OBSERVATION_CONVERSATION
      )
        throw Error("DESKTOP_BODY_UNAVAILABLE");
      const recipient = live.visits.get(action.recipient);
      const reply = action.replyTo
        ? live.perception.greeting(ctx.agentId, visit, action.replyTo)
        : live.perception.incomingGreeting(
            ctx.agentId,
            visit,
            action.recipient,
          );
      if (
        !recipient ||
        (action.replyTo && (!reply || reply.actor !== action.recipient))
      )
        throw Error("DESKTOP_BODY_UNAVAILABLE");
      greeting = { recipient: action.recipient, visit: recipient, reply };
    }
    if (
      INTERACTIVE_ACTIONS.has(action.type) &&
      !greeting &&
      !(action.type === "interaction"
        ? host.socialBodyAvailable()
        : host.interactionsAvailable())
    )
      throw Error("DESKTOP_BODY_UNAVAILABLE");
    const windowTask = ctx.desktopWindowTask;
    if (
      action.type === "window-task" &&
      (ctx.conversation !== DESKTOP_WINDOW_TASK_CONVERSATION ||
        action.requestId !== windowTask?.id)
    )
      throw Error("DESKTOP_BODY_UNAVAILABLE");
    if ("layoutVersion" in action)
      validateTarget(action, this.spaces.get(ctx), client.bodyCrossDisplay);
    if (action.type === "state") this.spaces.delete(ctx);
    if (["move", "window-task"].includes(action.type))
      live.interruptInteractionMovement(agent.id);
    const expiresAt = Date.now() + ACTION_TIMEOUT;
    const receipt = Promise.withResolvers();
    const entry = {
      ctx,
      live,
      client,
      visit,
      turn,
      greeting,
      receipt,
      v2,
      recoverUntil: expiresAt + RECOVERY_WINDOW,
      claimed: false,
      cancel: false,
      request: {
        agentId: agent.id,
        ...(v2 && { visitId: this.visitId(visit) }),
        ...(client.bodyCrossDisplay && { crossDisplay: true }),
        roomEpoch: live.room.epoch,
        commandId: randomUUID(),
        expiresAt,
        inputAt,
        ...(interaction && { interaction }),
        ...(greeting && {
          greeting: {
            agentId: greeting.recipient,
            visitId: this.visitId(greeting.visit),
          },
        }),
        ...(action.type === "window-task" && {
          windowTask: {
            id: windowTask.id,
            scope: windowTask.scope,
            grantId: windowTask.grantId,
          },
        }),
        ...(ctx.conversation === DESKTOP_OBSERVATION_CONVERSATION && {
          observation: true,
          observationGrantId: ctx.desktopObservationGrantId,
        }),
        action,
      },
      abort: () => this.invalidate(entry, "inactive"),
      timer: setTimeout(
        () => this.invalidate(entry, "timeout"),
        ACTION_TIMEOUT,
      ),
    };
    receipt.entry = entry;
    if (action.type !== "state") ctx.desktopBodyActed = true;
    receipts.set(action.requestId, receipt);
    this.pending.set(agent.id, entry);
    ctx.controller.signal.addEventListener("abort", entry.abort, {
      once: true,
    });
    return receipt.promise;
  }
}
