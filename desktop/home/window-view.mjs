export function createWindowView({
  context,
  screen,
  positions,
  sizes,
  clampToWorkArea,
  restoreWindowPoint,
  entries,
  clearOwnerDrag,
  createWindow,
  send,
  snapshot,
  updatePointerPolling,
  windowVisible,
  follow,
  stopLocalWindowTask,
  body,
  stopLocalSeat,
  stopMovement,
  reportSpeed,
  spaceEditor,
  space,
  updatePointerRegions,
  visibleBounds,
  animateTo,
  invalidatePermissions,
}) {
  function defaultPoint(id) {
    const { x, y, width, height } = screen.getPrimaryDisplay().workArea;
    if (id === "door") return { x: x + width - 122, y: y + height - 138 };
    const index = context.roles.findIndex((role) => role.id === id);
    return {
      x: x + width - 290 - index * 142,
      y: y + height - 171 - (index % 2) * 28,
    };
  }

  function clampPoint(point, width, height, area) {
    const work =
      area ?? screen.getDisplayMatching({ ...point, width, height }).workArea;
    return clampToWorkArea(point, width, height, work);
  }

  function windowPoint(id, type) {
    const point = type === "door" ? context.doorPosition : positions[id];
    const [width, height] = sizes[type];
    const fallback = () =>
      clampPoint(
        defaultPoint(id),
        width,
        height,
        screen.getPrimaryDisplay().workArea,
      );
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y))
      return fallback();
    return restoreWindowPoint(
      { ...point, width, height },
      screen.getAllDisplays(),
      fallback,
    );
  }

  function showDoor() {
    context.hidden = false;
    if (!entries.has("door"))
      createWindow("door", "door", windowPoint("door", "door"));
    for (const entry of entries.values()) {
      if (entry.ready && entry.type !== "panel") entry.win.showInactive();
      updateMotion(entry);
    }
    updatePointerPolling();
  }

  function showPanel(section) {
    showDoor();
    const existing = entries.get("panel");
    if (existing) {
      existing.section = section;
      send(existing, "room:section", section);
      existing.win.show();
      existing.win.focus();
      return;
    }
    const door = entries.get("door").win.getBounds();
    const area = screen.getDisplayMatching(door).workArea;
    createWindow(
      "panel",
      "panel",
      {
        x: door.x + door.width - sizes.panel[0],
        y: door.y - sizes.panel[1] - 36,
      },
      { area, section },
    );
  }

  let positionReportTimer;
  function schedulePositionReport() {
    if (!context.framework || positionReportTimer) return;
    positionReportTimer = setTimeout(() => {
      positionReportTimer = undefined;
      context.framework?.sync();
    }, 75);
  }

  function windowVisibilityChanged(entry) {
    if (entry.type === "sprite") schedulePositionReport();
    if (!windowVisible(entry)) {
      follow.stop("hidden", entry);
      stopLocalWindowTask("hidden", entry.id);
      body.stop(entry.id, "hidden");
      clearOwnerDrag?.(entry);
      stopLocalSeat(entry, "hidden");
      if (entry.departing) entry.win.destroy();
      else stopMovement(entry);
    } else if (entry.type === "sprite") {
      send(entry, "room:update", snapshot());
    }
    updateMotion(entry);
    updatePointerPolling();
  }

  function updateMotion(entry) {
    if (entry.type !== "sprite" || entry.win.isDestroyed()) return;
    const suspended =
      context.hidden || context.desktopLocked || !windowVisible(entry);
    const state = suspended ? "suspended" : entry.movement ? "moving" : "still";
    if (entry.reportedMotion === state) return;
    if (!entry.ready) return;
    entry.reportedMotion = state;
    send(entry, "room:motion", state);
    if (state !== "moving") reportSpeed(entry, 0, performance.now());
    const panel = entries.get("panel");
    if (panel?.ready) send(panel, "room:update", snapshot(true));
  }

  function stopLocalMotion(reason) {
    follow.stop(reason);
    stopLocalWindowTask(reason);
    for (const entry of entries.values()) {
      entry.drag = null;
      clearOwnerDrag?.(entry);
      stopLocalSeat(entry, reason);
      if (entry.departing) entry.win.destroy();
      else stopMovement(entry);
    }
  }

  function restoreWindowLayout() {
    spaceEditor.close();
    space.invalidate();
    context.bodyInputAfter = Date.now();
    body.clear("display-changed");
    stopLocalMotion("display-changed");
    const displays = screen.getAllDisplays();
    for (const entry of entries.values()) {
      if (entry.win.isDestroyed()) continue;
      const bounds = entry.win.getBounds();
      const fallback = () =>
        entry.type === "panel"
          ? clampPoint(
              bounds,
              bounds.width,
              bounds.height,
              screen.getPrimaryDisplay().workArea,
            )
          : windowPoint(entry.id, entry.type);
      const point = restoreWindowPoint(bounds, displays, fallback);
      if (point.x !== bounds.x || point.y !== bounds.y)
        entry.win.setPosition(point.x, point.y);
    }
    updatePointerRegions();
  }

  function publicPoint(entry) {
    const bounds = visibleBounds(entry);
    if (!bounds || entry.privatePosition) return;
    return {
      x: bounds.x + Math.round(bounds.width / 2),
      y: bounds.y + Math.round(bounds.height / 2),
      displayId: screen.getDisplayMatching(bounds).id,
    };
  }

  function publicSpace() {
    if (
      !context.publicPerception ||
      context.hidden ||
      context.desktopLocked ||
      !context.remoteState?.roomEpoch
    )
      return;
    const residents = [...entries.values()]
      .flatMap((entry) => {
        if (entry.type !== "sprite" || !entry.bodyVisitId || entry.departing)
          return [];
        const point = publicPoint(entry);
        return point
          ? [
              {
                ...point,
                agentId: entry.id,
                visitId: entry.bodyVisitId,
                halfWidth: Math.round(entry.win.getBounds().width / 2),
                halfHeight: Math.round(entry.win.getBounds().height / 2),
                pose: entry.pose ?? "sit",
                facing: entry.facing ?? "right",
              },
            ]
          : [];
      })
      .slice(0, 24);
    return {
      roomEpoch: context.remoteState.roomEpoch,
      residents,
      door: publicPoint(entries.get("door")),
    };
  }

  function bodyPosition(id) {
    const entry = entries.get(id);
    if (!entry || entry.win.isDestroyed()) return {};
    const bounds = entry.win.getBounds();
    return {
      position: {
        x: bounds.x,
        y: bounds.y,
        displayId: screen.getDisplayMatching(bounds).id,
      },
      facing: entry.facing ?? "right",
    };
  }

  function showSprite(role) {
    const previous = entries.get(role.id);
    if (previous) previous.win.destroy();
    const door = entries.get("door")?.win.getBounds();
    const point = windowPoint(role.id, "sprite");
    const entry = createWindow(
      role.id,
      "sprite",
      door &&
        screen.getDisplayMatching(door).id ===
          screen.getDisplayNearestPoint(point).id
        ? { x: door.x - 36, y: door.y - 27 }
        : point,
    );
    entry.win.once("ready-to-show", () => animateTo(entry, point));
  }

  function hideAll() {
    spaceEditor.close();
    context.hidden = true;
    invalidatePermissions("hide");
    context.framework?.sync();
    context.bodyInputAfter = Date.now();
    body.clear("hidden");
    stopLocalMotion("hidden");
    for (const { win } of entries.values()) win.hide();
    updatePointerPolling();
  }

  function animateHome(role) {
    const entry = entries.get(role.id);
    if (entry && !entry.departing) {
      follow.stop("inactive", entry);
      stopLocalWindowTask("inactive", role.id);
      stopLocalSeat(entry, "inactive");
      entry.departing = true;
      entry.win.setIgnoreMouseEvents(true);
      const door = entries.get("door")?.win.getBounds();
      if (
        door &&
        windowVisible(entry) &&
        !context.hidden &&
        !context.desktopLocked &&
        screen.getDisplayMatching(door).id ===
          screen.getDisplayMatching(entry.win.getBounds()).id
      )
        animateTo(entry, { x: door.x - 36, y: door.y - 27 }, () =>
          entry.win.destroy(),
        );
      else entry.win.destroy();
    }
  }

  return {
    defaultPoint,
    clampPoint,
    windowPoint,
    showDoor,
    showPanel,
    schedulePositionReport,
    windowVisibilityChanged,
    updateMotion,
    stopLocalMotion,
    restoreWindowLayout,
    publicSpace,
    bodyPosition,
    showSprite,
    hideAll,
    animateHome,
  };
}
