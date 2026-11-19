export function registerActionIpc({
  ipc,
  localRoomAction,
  context,
  places,
  controllableResident,
  entries,
  recordBodyFeedback,
  screen,
  displayFingerprint,
  clampPoint,
  savePreferences,
  update,
  room,
  windowVisible,
  follow,
  stopLocalWindowTask,
  body,
  stopLocalSeat,
  stopMovement,
  stopCompanionControl,
  manuallyMoved,
  savedPlace,
  space,
  moveResident,
  windowVisibilityChanged,
  refreshIfDue,
  handleDrag,
  showPanel,
  randomUUID,
  manualTouches,
  ownerInput,
  Menu,
  positions,
  returnHome,
  spaceEditor,
  windowTaskGrant,
  permissionRevision,
}) {
  function editPlace(id, action) {
    if (action === "body-clear-place") {
      places.delete(id);
    } else {
      const entry = controllableResident(
        id,
        context.remoteState?.roomEpoch,
        entries.get(id)?.bodyVisitId,
      );
      if (!entry) return;
      if (action === "body-go-place") return controlResident(id, action);
      if (entry.movement || entry.privatePosition)
        return recordBodyFeedback(entry, "position-unconfirmed");
      const bounds = entry.win.getBounds();
      const display = screen.getDisplayMatching(bounds);
      const fingerprint = displayFingerprint(display);
      if (!fingerprint) return recordBodyFeedback(entry, "target-unavailable");
      const point = clampPoint(
        bounds,
        bounds.width,
        bounds.height,
        display.workArea,
      );
      if (point.x !== bounds.x || point.y !== bounds.y)
        return recordBodyFeedback(entry, "target-unavailable");
      places.set(id, {
        display: fingerprint,
        x: bounds.x - display.workArea.x,
        y: bounds.y - display.workArea.y,
      });
    }
    savePreferences();
    update();
  }

  function controlResident(id, action) {
    const entry = entries.get(id);
    if (
      room.members[id] !== "here" ||
      entry?.type !== "sprite" ||
      entry.departing ||
      entry.drag ||
      !windowVisible(entry) ||
      context.hidden ||
      context.desktopLocked
    )
      return;
    entry.bodyInputAfter = Date.now();
    follow.stop("stopped", entry);
    stopLocalWindowTask("stopped", id);
    body.stop(id, "stopped");
    stopLocalSeat(entry, "stopped");
    stopMovement(entry);
    if (action === "body-stop") {
      stopCompanionControl(id);
      recordBodyFeedback(entry, "stopped");
    }
    if (context.framework) {
      manuallyMoved.add(id);
      context.framework.sync();
    }
    if (action === "body-seat" || action === "body-go-place") {
      const place = action === "body-go-place" && savedPlace(id);
      const target =
        action === "body-seat"
          ? { target: "seat" }
          : place?.state === "saved" &&
            space.pointTarget(id, place.displayId, place.point);
      if (!target) return recordBodyFeedback(entry, "target-unavailable");
      const expiresAt = Date.now() + 6000;
      let settled = false;
      const settle = () => {
        settled = true;
        entry.localSeatCancel = undefined;
      };
      const cancel = moveResident(entry, target, {
        current: () =>
          entries.get(id) === entry &&
          !entry.departing &&
          !entry.drag &&
          !context.hidden &&
          !context.desktopLocked &&
          windowVisible(entry) &&
          Date.now() < expiresAt,
        expiresAt,
        crossDisplay: true,
        finish: settle,
        fail: (reason) => {
          settle();
          recordBodyFeedback(entry, reason);
        },
      });
      if (!settled) entry.localSeatCancel = cancel;
    }
  }

  ipc.on("room:action", (event, action, data) => {
    const entry = ipc.actionEntry(event);
    if (!entry) return;
    if (
      action === "page-visible" &&
      entry.type !== "panel" &&
      event.senderFrame === entry.win.webContents.mainFrame &&
      typeof data === "boolean"
    ) {
      entry.pageVisible = data;
      windowVisibilityChanged(entry);
      return;
    }
    if (context.live) context.live.tick();
    else if (refreshIfDue(room)) update();
    if (
      entry.type !== "panel" &&
      ["drag-start", "drag-move", "drag-end"].includes(action)
    ) {
      handleDrag(entry, action, data);
      return;
    }
    if (entry.type === "door") {
      if (action === "open") showPanel("visits");
      return;
    }
    if (entry.type === "sprite") {
      if (action === "motion-preference" && typeof data === "boolean") {
        entry.reducedMotion = data;
        return;
      }
      const role = context.roles.find(({ id }) => id === entry.id);
      if (action === "open") showPanel("chat");
      if (
        action === "pet" &&
        !context.hidden &&
        !context.desktopLocked &&
        !entry.drag &&
        windowVisible(entry)
      ) {
        const candidatePet = context.framework && ownerInput?.enabled();
        if (candidatePet && ownerInput.record(entry, { kind: "pet" }))
          context.framework.sync();
        const now = Date.now();
        if (now < (entry.pettedAt ?? 0) + 700) return;
        entry.pettedAt = now;
        const gesture = { kind: "pet", id: randomUUID() };
        entry.gesture = gesture;
        update();
        setTimeout(() => {
          if (entry.gesture !== gesture) return;
          entry.gesture = undefined;
          update();
        }, 1050);
        if (!candidatePet && context.framework && entry.bodyVisitId) {
          manualTouches.set(entry.id + ":pet", {
            agentId: entry.id,
            visitId: entry.bodyVisitId,
            kind: "pet",
          });
          context.framework.sync();
        }
      }
      if (action === "menu") {
        Menu.buildFromTemplate([
          { label: "打开聊天", click: () => showPanel("chat") },
          {
            label: "坐回默认位置",
            click: () => {
              delete positions[role.id];
              savePreferences();
              controlResident(role.id, "body-seat");
            },
          },
          { type: "separator" },
          { label: "请回家", click: () => returnHome(role) },
          ...(context.live || context.framework
            ? []
            : [
                {
                  label: "模拟角色自行回家",
                  click: () => returnHome(role, true),
                },
              ]),
        ]).popup({ window: entry.win });
      }
      return;
    }
    if (action === "section") {
      if (
        event.senderFrame === entry.win.webContents.mainFrame &&
        ["chat", "visits", "observation", "garden"].includes(data)
      )
        entry.section = data;
      return;
    }
    const role = context.roles.find(({ id }) => id === data);
    if (action === "body-zones") {
      if (
        event.senderFrame === entry.win.webContents.mainFrame &&
        entry.win.isFocused() &&
        !context.hidden &&
        !context.desktopLocked
      )
        spaceEditor.open(screen.getDisplayMatching(entry.win.getBounds()));
      return;
    }
    const focused =
      event.senderFrame === entry.win.webContents.mainFrame &&
      entry.win.isFocused();
    if (
      ["body-mark-place", "body-go-place", "body-clear-place"].includes(action)
    ) {
      if (
        focused &&
        role &&
        context.remoteState?.interactionsAvailable &&
        !context.hidden &&
        !context.desktopLocked
      )
        editPlace(role.id, action);
      return;
    }
    if (action === "window-task" || action === "window-task-stop") {
      if (
        !focused ||
        !context.remoteState?.interactionsAvailable ||
        context.hidden ||
        context.desktopLocked
      )
        return;
      if (action === "window-task-stop") {
        context.localWindowTaskStatus = undefined;
        const status = context.remoteState.windowTaskStatus;
        if (
          status?.id !== data ||
          !["approaching", "ready"].includes(status.stage)
        )
          return;
        stopLocalWindowTask("stopped", status.agentId);
        body.stop(status.agentId, "stopped");
        void context.framework.command(action, data).catch(() => {});
        return;
      }
      const { roomEpoch } = context.remoteState;
      const { agentId, scope, grantId, text } = data ?? {};
      if (
        !["screen", "native"].includes(scope) ||
        typeof text !== "string" ||
        !text.trim() ||
        text.length > 1000
      )
        return;
      const grant = windowTaskGrant(scope, agentId, roomEpoch);
      const resident = controllableResident(
        agentId,
        roomEpoch,
        entries.get(agentId)?.bodyVisitId,
      );
      const fail = () => {
        if (
          context.remoteState?.roomEpoch !== roomEpoch ||
          ["approaching", "ready"].includes(
            context.remoteState.windowTaskStatus?.stage,
          )
        )
          return;
        context.localWindowTaskStatus = {
          agentId,
          scope,
          stage: "failed",
          reason: "target-unavailable",
        };
        update();
      };
      if (!context.roles.some(({ id }) => id === agentId)) return;
      const modeRevision = permissionRevision(
        scope === "native" ? "control" : "view",
      );
      if (
        modeRevision === undefined ||
        !resident ||
        !grant ||
        grantId !== grant.grantId
      )
        return fail();
      context.localWindowTaskStatus = undefined;
      void context.framework
        .command(action, {
          roomEpoch,
          agentId,
          scope,
          grantId,
          text,
          modeRevision,
        })
        .catch(fail);
      return;
    }
    if (["body-stop", "body-seat"].includes(action)) {
      if (
        event.senderFrame === entry.win.webContents.mainFrame &&
        entry.win.isFocused() &&
        role
      )
        controlResident(role.id, action);
      return;
    }
    if (context.framework) {
      if (action === "close") entry.win.hide();
      else if (
        [
          "invite",
          "leave",
          "send",
          "door-mode",
          "knock-answer",
          "activity-pause",
        ].includes(action)
      ) {
        if (action === "leave" && role) {
          stopLocalWindowTask("inactive", role.id);
          body.stop(role.id, "inactive");
        }
        if ((action === "activity-pause" && data === true) || action === "send")
          stopLocalWindowTask("stopped");
        context.framework.act(action, data);
      }
      return;
    }
    localRoomAction(action, data, role);
    if (action === "close") entry.win.hide();
  });
}
