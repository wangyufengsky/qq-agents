export function registerRoomIpc({
  ipc,
  context,
  updatePointerRegions,
  windowVisible,
  snapshot,
}) {
  ipc.handle("room:bubble-reply", async (event, action, data) => {
    const entry = ipc.actionEntry(event);
    if (!entry || !["panel", "sprite"].includes(entry.type)) return false;
    if (action === "close" && entry.type === "sprite") {
      if (entry.bubbleReply) {
        entry.bubbleReply = undefined;
        entry.win.setFocusable(false);
        updatePointerRegions();
      }
      return true;
    }
    const bubble = context.remoteState?.recentBubbles?.find(
      ({ bubbleId }) => bubbleId === data?.bubbleId,
    );
    if (
      !context.framework ||
      !context.remoteState?.connected ||
      !data ||
      data.roomEpoch !== context.remoteState.roomEpoch ||
      !bubble?.canReply ||
      context.hidden ||
      context.desktopLocked ||
      context.shuttingDown ||
      !windowVisible(entry) ||
      (entry.type === "sprite" && bubble.actor !== entry.id)
    )
      return false;
    if (action === "open") {
      if (entry.type === "panel") return entry.win.isFocused();
      entry.bubbleReply = bubble.bubbleId;
      entry.win.setFocusable(true);
      entry.win.focus();
      updatePointerRegions();
      return true;
    }
    if (
      action !== "send" ||
      !entry.win.isFocused() ||
      typeof data.text !== "string" ||
      !data.text.trim() ||
      data.text.length > 1000 ||
      (entry.type === "sprite" && entry.bubbleReply !== data.bubbleId)
    )
      return false;
    try {
      return Boolean(
        await context.framework.command("bubble-reply", {
          roomEpoch: data.roomEpoch,
          bubbleId: data.bubbleId,
          text: data.text,
        }),
      );
    } catch {
      return false;
    }
  });

  ipc.handle("room:get", (event) => {
    const entry = ipc.entryFor(event);
    if (entry)
      return { data: snapshot(entry.type === "panel"), section: entry.section };
  });
}
