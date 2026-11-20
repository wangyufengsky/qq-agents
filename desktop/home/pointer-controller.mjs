import { createOwnerDragQueue } from "./owner-drag.mjs";

export function createPointerController({
  context,
  entries,
  windowVisible,
  screen,
  follow,
  desktopBodyBounds,
  room,
  space,
  stopLocalWindowTask,
  stopCompanionControl,
  manuallyMoved,
  body,
  stopLocalSeat,
  stopMovement,
  send,
  snapshot,
  clampPoint,
  sizes,
  manualTouches,
  ownerInput,
  positions,
  savePreferences,
}) {
  const unifiedDrag = (entry) =>
    entry.type === "sprite" && context.remoteState?.desktopUnified === true;
  const stopRevision = (entry) =>
    Math.max(entry.bodyInputAfter ?? 0, context.bodyInputAfter ?? 0);
  const ownerDrag = createOwnerDragQueue({
    fence: (entry) => ({
      roomEpoch: context.remoteState?.roomEpoch,
      visitId: entry.bodyVisitId,
      stopRevision: stopRevision(entry),
    }),
    valid: (entry, fence) =>
      unifiedDrag(entry) &&
      context.remoteState?.connected &&
      fence.roomEpoch === context.remoteState.roomEpoch &&
      fence.visitId &&
      fence.visitId === entry.bodyVisitId &&
      fence.stopRevision === stopRevision(entry) &&
      entries.get(entry.id) === entry &&
      !entry.departing &&
      !entry.win.isDestroyed() &&
      !context.hidden &&
      !context.desktopLocked &&
      windowVisible(entry),
    cancelled: (entry) => send(entry, "room:owner-drag", false),
    start(entry) {
      send(entry, "room:owner-drag", true);
      follow.stop("manual-control");
      stopLocalSeat(entry, "manual-control");
      stopMovement(entry);
      const [x, y] = entry.win.getPosition();
      return { x, y };
    },
    move(entry, point) {
      const { x, y } = clampPoint(point, ...sizes[entry.type]);
      entry.win.setPosition(x, y);
    },
    end(entry, from) {
      send(entry, "room:owner-drag", false);
      const [x, y] = entry.win.getPosition();
      if (from.x === x && from.y === y) return;
      const to = { x, y };
      space.invalidate();
      entry.privatePosition = undefined;
      positions[entry.id] = to;
      savePreferences();
      if (ownerInput?.record(entry, { kind: "drag", from, to }))
        context.framework?.sync();
    },
  });
  let pointerTimer;
  function updatePointerPolling() {
    const needed =
      !context.hidden &&
      !context.desktopLocked &&
      [...entries.values()].some(
        (entry) =>
          entry.type !== "panel" && !entry.departing && windowVisible(entry),
      );
    if (needed && !pointerTimer) {
      updatePointerRegions();
      pointerTimer = setInterval(updatePointerRegions, 32);
    } else if (!needed && pointerTimer) {
      clearInterval(pointerTimer);
      pointerTimer = undefined;
    }
  }

  function updatePointerRegions() {
    if (context.hidden || context.desktopLocked) return;
    const { x, y } = screen.getCursorScreenPoint();
    follow.pointer({ x, y });
    for (const entry of entries.values()) {
      const { win, type, id } = entry;
      if (type === "panel" || entry.departing || !windowVisible(entry))
        continue;
      const bounds = win.getBounds();
      const dx = x - bounds.x;
      const dy = y - bounds.y;
      const body = desktopBodyBounds(type, bounds);
      const overBody =
        x >= body.x &&
        x <= body.x + body.width &&
        y >= body.y &&
        y <= body.y + body.height;
      const speech = entry.bubbleReply ? undefined : entry.speechBounds;
      const overSpeech = speech
        ? dx >= speech.x &&
          dx < speech.x + speech.width &&
          dy >= speech.y &&
          dy < speech.y + speech.height
        : Math.abs(dx - bounds.width / 2) <= 87 && dy >= 2 && dy <= 54;
      const overBubble =
        type === "sprite" &&
        (entry.bubbleReply || room.bubbles[id] || room.turn?.actor === id) &&
        overSpeech;
      const overStatus =
        type === "sprite" &&
        context.remoteState?.roles.some(
          (role) => role.id === id && role.statusCard,
        ) &&
        Math.abs(dx - bounds.width / 2) <= 87 &&
        dy >= 2 &&
        dy <= 54;
      const active = overBody || overBubble || overStatus;
      const ignored = !active && !entry.drag && !ownerDrag.capturing(entry);
      if (ignored === entry.ignored) continue;
      entry.ignored = ignored;
      win.setIgnoreMouseEvents(ignored);
    }
  }

  function handleDrag(entry, action, data) {
    if (!Number.isFinite(data?.x) || !Number.isFinite(data?.y)) return;
    if (unifiedDrag(entry)) return ownerDrag.handle(entry, action, data);
    const [x, y] = entry.win.getPosition();
    if (action === "drag-start") {
      space.invalidate();
      // Manual movement of any resident can invalidate the local route.
      follow.stop("manual-control");
      stopLocalWindowTask(
        "manual-control",
        entry.type === "door" ? undefined : entry.id,
      );
      stopCompanionControl(entry.type === "door" ? undefined : entry.id);
      const interrupted =
        entry.type === "door"
          ? [...entries.values()].filter(
              (resident) => resident.bodyAction || resident.windowApproach,
            )
          : entry.bodyAction || entry.windowApproach
            ? [entry]
            : [];
      entry.bodyInputAfter = Date.now();
      if (
        context.framework &&
        entry.type === "sprite" &&
        !ownerInput?.enabled()
      ) {
        manuallyMoved.add(entry.id);
        context.framework.sync();
      }
      if (entry.type === "door") {
        context.bodyInputAfter = entry.bodyInputAfter;
        body.clear("manual-control");
        for (const resident of entries.values())
          stopLocalSeat(resident, "manual-control");
      } else {
        body.stop(entry.id, "manual-control");
        stopLocalSeat(entry, "manual-control");
      }
      stopMovement(entry);
      if (interrupted.length) {
        const at = Date.now();
        for (const resident of interrupted)
          resident.bodyFeedback = { reason: "manual-control", at };
        const panel = entries.get("panel");
        if (panel?.ready) send(panel, "room:update", snapshot(true));
      }
      entry.drag = {
        x,
        y,
        visitId: entry.bodyVisitId,
        mouseX: data.x,
        mouseY: data.y,
      };
    } else if (entry.drag) {
      const from = entry.drag;
      const target = clampPoint(
        {
          x: from.x + data.x - from.mouseX,
          y: from.y + data.y - from.mouseY,
        },
        ...sizes[entry.type],
      );
      entry.win.setPosition(target.x, target.y);
      if (target.x !== from.x || target.y !== from.y)
        entry.privatePosition = undefined;
      if (action === "drag-end") {
        entry.drag = null;
        space.invalidate();
        entry.bodyInputAfter = Date.now();
        if (context.framework && entry.type === "sprite") {
          if (ownerInput?.enabled()) {
            const [actualX, actualY] = entry.win.getPosition();
            if (
              from.visitId === entry.bodyVisitId &&
              (from.x !== actualX || from.y !== actualY)
            )
              ownerInput.record(entry, {
                kind: "drag",
                from: { x: from.x, y: from.y },
                to: { x: actualX, y: actualY },
              });
          } else {
            manuallyMoved.add(entry.id);
            if (entry.bodyVisitId)
              manualTouches.set(entry.id + ":drag", {
                agentId: entry.id,
                visitId: entry.bodyVisitId,
                kind: "drag",
              });
          }
          context.framework.sync();
        }
        if (entry.type === "door") {
          context.bodyInputAfter = entry.bodyInputAfter;
          context.doorPosition = target;
        } else positions[entry.id] = target;
        savePreferences();
      }
    }
  }

  function executeBody(request, current, finish, execute) {
    const entry = entries.get(request.agentId);
    return entry && unifiedDrag(entry)
      ? ownerDrag.body(entry, current, finish, execute)
      : execute(finish);
  }

  return {
    updatePointerPolling,
    updatePointerRegions,
    handleDrag,
    executeBody,
    clearOwnerDrag: ownerDrag.clear,
  };
}
