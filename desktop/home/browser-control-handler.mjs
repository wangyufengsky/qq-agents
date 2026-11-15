export function createBrowserControlHandler(ctx) {
  return async (event, selection) => {
    const win = ctx.entries.get("panel")?.win;
    const { browserControl: policy, roomEpoch } = ctx.remoteState ?? {};
    const modeRevision = ctx.permissionRevision?.();
    if (
      (ctx.permissionRevision && modeRevision === undefined) ||
      !ctx.framework ||
      !roomEpoch ||
      !policy ||
      !win ||
      win.webContents !== event.sender ||
      event.senderFrame !== win.webContents.mainFrame ||
      !win.isFocused() ||
      ctx.choosingDesktopPermission
    )
      return "unavailable";
    ctx.choosingDesktopPermission = true;
    try {
      if (selection === undefined && policy.grantedAgentId) {
        const grant = ctx.lastBrowserGrant;
        if (
          grant?.roomEpoch !== roomEpoch ||
          grant.agentId !== policy.grantedAgentId
        )
          return "unavailable";
        const room = await ctx.framework.command("browser-revoke", {
          roomEpoch,
          grantId: grant.grantId,
        });
        if (room?.browserControl?.grantedAgentId) return "failed";
        ctx.lastBrowserGrant = undefined;
        return "revoked";
      }
      const agent = ctx.roles.find(({ id }) => id === selection?.agentId);
      if (
        policy.grantedAgentId ||
        !agent ||
        !policy.eligible.includes(agent.id)
      )
        return "unavailable";
      const origin = ctx.parseBrowserOrigin(selection.origin);
      if (!origin) return "invalid";
      const confirmed = await ctx.dialog.showMessageBox(win, {
        type: "question",
        title: "授权隔离浏览器",
        message: `允许 ${ctx.localLabel(agent.name)} 访问此站点？`,
        detail: origin,
        buttons: ["取消", "授权"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (confirmed.response !== 1 || win.isDestroyed() || !win.isVisible())
        return "cancelled";
      if (
        ctx.remoteState?.roomEpoch !== roomEpoch ||
        ctx.permissionRevision?.() !== modeRevision ||
        ctx.remoteState?.browserControl?.grantedAgentId ||
        !ctx.remoteState?.browserControl?.eligible.includes(agent.id)
      )
        return "unavailable";
      const grant = {
        roomEpoch,
        grantId: ctx.randomUUID(),
        agentId: agent.id,
        origin,
        ...(modeRevision !== undefined && { modeRevision }),
      };
      ctx.lastBrowserGrant = grant;
      const room = await ctx.framework.command("browser-grant", grant);
      return room?.roomEpoch === roomEpoch &&
        room.browserControl?.grantedAgentId === agent.id
        ? "granted"
        : "unavailable";
    } catch {
      return "failed";
    } finally {
      ctx.choosingDesktopPermission = false;
    }
  };
}
