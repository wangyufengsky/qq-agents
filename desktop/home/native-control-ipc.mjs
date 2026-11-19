import * as nativeControls from "./native-control-client.mjs";

export function registerNativeControlIpc({
  ipc,
  context,
  entries,
  permissionRevision,
  verifiedWindowSurface,
  nativeControl,
  screenPickerVisits,
  nativeDriver,
  desktopSourceMenu,
  deniedWindow,
  dialog,
  localLabel,
  identifyTarget = nativeControls.nativeControlTargetId,
}) {
  ipc.handle("room:native-control", async (event, action) => {
    const win = entries.get("panel")?.win;
    const { nativeControl: policy, roomEpoch } = context.remoteState ?? {};
    if (context.remoteState?.desktopUnified) {
      if (
        !context.framework ||
        !nativeControl ||
        !roomEpoch ||
        !policy ||
        !win ||
        win.webContents !== event.sender ||
        event.senderFrame !== win.webContents.mainFrame ||
        !win.isFocused() ||
        context.choosingDesktopPermission
      )
        return "unavailable";
      if (action?.type === "revoke") {
        const grant = policy.grants?.find(
          ({ grantId }) => grantId === action.grantId,
        );
        if (!grant) return "unavailable";
        try {
          return await nativeControl.revoke(
            roomEpoch,
            grant.agentId,
            grant.grantId,
          );
        } catch {
          return "failed";
        }
      }
      if (action?.type !== "grant" || !nativeDriver || !identifyTarget)
        return "unavailable";
      context.choosingDesktopPermission = true;
      try {
        const visits = screenPickerVisits();
        const eligible = context.roles.filter(
          ({ id }) => policy.targetEligible?.includes(id) && visits.get(id),
        );
        if (!eligible.length) return "unavailable";
        const windows = (
          await nativeDriver.listWindows({
            unified: true,
            signal: AbortSignal.timeout(4000),
          })
        ).filter(
          (source) => source.pid !== process.pid && !deniedWindow(source),
        );
        if (!windows.length) return "no-sources";
        if (win.isDestroyed() || !win.isFocused()) return "cancelled";
        const selection = await desktopSourceMenu(
          win,
          eligible,
          windows,
          ({ app, title }) => `${app} · ${title}`,
        );
        if (!selection || win.isDestroyed()) return "cancelled";
        const targetId = identifyTarget(selection.source);
        const agent = eligible.find(({ id }) => id === selection.agentId);
        if (!agent || !targetId) return "unavailable";
        const confirmed = await dialog.showMessageBox(win, {
          type: "question",
          title: "授权操作本机窗口",
          message: `允许 ${localLabel(agent.name)} 持续操作此窗口？`,
          detail: `${localLabel(selection.source.app)} · ${localLabel(selection.source.title)}`,
          buttons: ["取消", "确认授权"],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        if (confirmed.response !== 1 || win.isDestroyed()) return "cancelled";
        const room = context.remoteState;
        if (
          !room?.desktopUnified ||
          room.roomEpoch !== roomEpoch ||
          !room.nativeControl?.targetEligible?.includes(agent.id) ||
          screenPickerVisits().get(agent.id) !== visits.get(agent.id) ||
          deniedWindow(selection.source)
        )
          return "unavailable";
        return await nativeControl.grant({
          ...selection,
          targetId,
          roomEpoch,
          visitId: visits.get(agent.id),
        });
      } catch (error) {
        return error?.message === "DESKTOP_NATIVE_PERMISSION"
          ? "permission"
          : "failed";
      } finally {
        context.choosingDesktopPermission = false;
      }
    }
    let modeRevision = permissionRevision("control");
    if (
      !verifiedWindowSurface ||
      modeRevision === undefined ||
      !context.framework ||
      !nativeControl ||
      !roomEpoch ||
      !policy ||
      !win ||
      win.webContents !== event.sender ||
      event.senderFrame !== win.webContents.mainFrame ||
      !win.isFocused() ||
      context.choosingDesktopPermission
    )
      return "unavailable";
    context.choosingDesktopPermission = true;
    try {
      if (policy.grantedAgentId && action !== "switch")
        return await nativeControl.revoke(roomEpoch, policy.grantedAgentId);
      if (policy.handoff === "pending") return "pending";
      const visits = screenPickerVisits();
      let eligible = context.roles.filter(({ id }) =>
        policy.eligible.includes(id),
      );
      if (!eligible.length) return "unavailable";
      let windows;
      try {
        windows = await nativeDriver.listWindows({
          signal: AbortSignal.timeout(4000),
        });
      } catch (error) {
        if (
          process.platform !== "darwin" ||
          !["DESKTOP_NATIVE_TIMEOUT", "DESKTOP_NATIVE_CANCELLED"].includes(
            error?.message,
          )
        )
          throw error;
        // A stalled global AX inventory need not prevent a scoped app lookup.
        const applications = (
          await nativeDriver.listApplications({
            signal: AbortSignal.timeout(4000),
          })
        ).filter(({ pid }) => pid !== process.pid);
        if (win.isDestroyed() || !win.isFocused()) return "cancelled";
        if (!applications.length) return "no-sources";
        const selected = await desktopSourceMenu(
          win,
          eligible,
          applications,
          ({ app }) => app,
        );
        if (!selected || win.isDestroyed() || !win.isVisible())
          return "cancelled";
        eligible = eligible.filter(({ id }) => id === selected.agentId);
        windows = await nativeDriver.listWindows({
          application: selected.source,
          signal: AbortSignal.timeout(4000),
        });
      }
      const sources = windows.filter(
        (window) =>
          window.pid !== process.pid && deniedWindow(window) === false,
      );
      if (win.isDestroyed() || !win.isFocused()) return "cancelled";
      if (!sources.length) return "no-sources";
      const selection = await desktopSourceMenu(
        win,
        eligible,
        sources,
        ({ app, title }) => `${app} · ${title}`,
      );
      if (!selection || win.isDestroyed() || !win.isVisible())
        return "cancelled";
      const valid = () =>
        context.remoteState?.roomEpoch === roomEpoch &&
        permissionRevision("control") !== undefined &&
        !win.isDestroyed() &&
        win.isVisible() &&
        deniedWindow(selection.source) === false &&
        selection.source.pid !== process.pid &&
        context.remoteState?.nativeControl?.eligible.includes(
          selection.agentId,
        ) &&
        visits.get(selection.agentId) &&
        screenPickerVisits().get(selection.agentId) ===
          visits.get(selection.agentId);
      if (
        !valid() ||
        context.remoteState.nativeControl.grantedAgentId !==
          policy.grantedAgentId
      )
        return "unavailable";
      const confirmed = await dialog.showMessageBox(win, {
        type: "question",
        title: "授权操作本机窗口",
        message: `允许${context.roles.find(({ id }) => id === selection.agentId).name}操作此窗口？`,
        detail: `${policy.handoff === "unconfirmed" ? "确认前请核对上一次操作的窗口。\n" : ""}${localLabel(selection.source.app)} · ${localLabel(selection.source.title)}`,
        buttons: [
          "取消",
          policy.grantedAgentId ? "撤旧权限并授权" : "确认授权",
        ],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (
        confirmed.response !== 1 ||
        !valid() ||
        permissionRevision("control") !== modeRevision
      )
        return "cancelled";
      if (policy.grantedAgentId) {
        const status = await nativeControl.revoke(
          roomEpoch,
          policy.grantedAgentId,
        );
        if (status !== "revoked") return status;
      }
      // A receipt may arrive after revocation. Its identity cannot address the new grant.
      const deadline = Date.now() + 12_000;
      while (
        valid() &&
        (context.remoteState.nativeControl.handoff === "pending" ||
          (policy.grantedAgentId &&
            permissionRevision("control") === modeRevision)) &&
        Date.now() < deadline
      )
        await new Promise((resolve) => setTimeout(resolve, 160));
      if (!valid() || context.remoteState.nativeControl.grantedAgentId)
        return "unavailable";
      if (context.remoteState.nativeControl.handoff === "pending")
        return "pending";
      if (policy.grantedAgentId) {
        const current = permissionRevision("control");
        if (current === undefined || current === modeRevision) return "pending";
        modeRevision = current;
      }
      if (
        context.remoteState.nativeControl.handoff === "unconfirmed" &&
        policy.handoff !== "unconfirmed"
      )
        return "unconfirmed";
      return await nativeControl.grant({
        ...selection,
        roomEpoch,
        visitId: visits.get(selection.agentId),
        modeRevision,
        confirmed: context.remoteState.nativeControl.handoff === "unconfirmed",
      });
    } catch (error) {
      return error?.message === "DESKTOP_NATIVE_PERMISSION"
        ? "permission"
        : "failed";
    } finally {
      context.choosingDesktopPermission = false;
    }
  });
}
