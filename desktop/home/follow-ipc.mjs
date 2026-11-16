export function registerFollowIpc({
  ipc,
  context,
  entries,
  follow,
  space,
  followBlocked,
  body,
  stopLocalSeat,
  stopMovement,
  screen,
  geometryDriver,
  deniedWindow,
  desktopSourceMenu,
  windowGeometry,
  geometryFailure,
}) {
  ipc.handle("room:follow", async (event, id, mode) => {
    if (!["pointer", "window", "stop"].includes(mode)) return "unavailable";
    const win = entries.get("panel")?.win;
    const entry = entries.get(id);
    const role = context.remoteState?.roles.find(
      ({ id: agentId }) => id === agentId,
    );
    if (
      !entry ||
      !win ||
      win.isDestroyed() ||
      !win.isFocused() ||
      event.sender !== win.webContents ||
      event.senderFrame !== win.webContents.mainFrame
    )
      return "unavailable";
    if (mode === "stop") {
      follow.stop("stopped", entry);
      return "stopped";
    }
    const identity = {
      entry,
      roomEpoch: context.remoteState?.roomEpoch,
      visitId: role?.bodyVisitId,
    };
    const layoutVersion = space.layoutVersion;
    const current = () =>
      !followBlocked(identity) && layoutVersion === space.layoutVersion;
    if (!current()) return "unavailable";

    function start(source, bounds) {
      if (!current()) return "unavailable";
      if (
        entry.localComboCancel ||
        context.approachedWindowTask?.agentId === id
      )
        return "busy";
      entry.bodyInputAfter = Date.now();
      body.stop(id, "manual-control");
      stopLocalSeat(entry, "stopped");
      stopMovement(entry);
      return follow.start({ ...identity, mode, source, bounds });
    }

    if (
      context.choosingDesktopPermission ||
      entry.localComboCancel ||
      context.approachedWindowTask?.agentId === id
    )
      return "busy";
    if (mode === "pointer")
      return start(undefined, screen.getCursorScreenPoint());
    if (!geometryDriver) return "unavailable";
    context.choosingDesktopPermission = true;
    try {
      const windows = await geometryDriver.geometryWindows({
        signal: AbortSignal.timeout(4000),
      });
      if (win.isDestroyed() || !win.isFocused() || !current())
        return "cancelled";
      const sources = windows.filter(
        (window) =>
          window.pid !== process.pid && deniedWindow(window) === false,
      );
      if (!sources.length) return "no-sources";
      const selection = await desktopSourceMenu(
        win,
        [role],
        sources,
        ({ app, title }) => `${app} · ${title}`,
      );
      if (!selection || win.isDestroyed() || !win.isVisible() || !current())
        return "cancelled";
      const { id: windowId, pid, processInstance, app } = selection.source;
      const source = { id: windowId, pid, processInstance, app };
      const result = await windowGeometry(source, {
        signal: AbortSignal.timeout(2500),
      });
      if (win.isDestroyed() || !win.isVisible() || !current())
        return "cancelled";
      if (!result) return "target-unavailable";
      return start(source, result.bounds);
    } catch (error) {
      const reason = geometryFailure(error);
      return reason === "follow-permission" ? "permission" : reason;
    } finally {
      context.choosingDesktopPermission = false;
    }
  });
}
