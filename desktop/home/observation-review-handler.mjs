export function createObservationReviewHandler(ctx) {
  return async (event, action, data) => {
    if (!["status", "list", "delete"].includes(action)) return;
    const win = ctx.entries.get("panel")?.win;
    const roomEpoch = ctx.remoteState?.roomEpoch;
    const focused = () =>
      ctx.framework &&
      ctx.observationProtocol &&
      !ctx.hidden &&
      !ctx.desktopLocked &&
      ctx.remoteState?.connected &&
      ctx.remoteState.roomEpoch === roomEpoch &&
      win &&
      !win.isDestroyed() &&
      win.isFocused() &&
      event.sender === win.webContents &&
      event.senderFrame === win.webContents.mainFrame;
    if (!focused()) return;
    try {
      const result = await ctx.framework.result(
        "observation-review",
        { action, id: data?.id, agentId: data?.agentId },
        focused,
      );
      if (focused()) return result;
    } catch {
      // The room may have closed while the local query was in flight.
    }
  };
}
