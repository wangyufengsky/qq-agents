export function registerWindowObservationIpc({
  ipc,
  context,
  entries,
  permissionRevision,
  verifiedWindowSurface,
  screenCaptureSupported,
  observationDriver,
  clearScreenGrant,
  systemPreferences,
  listScreenSources,
  screenCapturePermission,
  observationSources,
  ownScreenSources,
  deniedWindow,
  screenPickerVisits,
  desktopSourceMenu,
  readObservationTarget,
  randomUUID,
  windowGrants,
  monitorObservation,
  clearObservation,
  removeObservation,
  observationError,
}) {
  async function chooseObservationWindow(event) {
    const entry = entries.get("panel");
    const win = entry?.win;
    const { roomEpoch } = context.remoteState ?? {};
    const screenView = context.remoteState?.observation;
    const modeRevision = permissionRevision("view");
    const modeCurrent = () =>
      modeRevision !== undefined && permissionRevision("view") === modeRevision;
    if (
      !verifiedWindowSurface ||
      !modeCurrent() ||
      !screenCaptureSupported ||
      !context.observationProtocol ||
      !context.framework ||
      !roomEpoch ||
      !screenView ||
      !win ||
      win.webContents !== event.sender ||
      event.senderFrame !== win.webContents.mainFrame ||
      !win.isFocused() ||
      context.choosingDesktopPermission
    )
      return "unavailable";
    if (!observationDriver) return "missing-helper";
    if (screenView.windowGrants?.length) {
      context.choosingDesktopPermission = true;
      try {
        clearScreenGrant(true);
        for (const { grantId } of screenView.windowGrants)
          await context.framework.authorization("observation-revoke", {
            roomEpoch,
            grantId,
          });
        return "revoked";
      } catch {
        return "failed";
      } finally {
        context.choosingDesktopPermission = false;
      }
    }
    context.choosingDesktopPermission = true;
    try {
      if (process.platform === "darwin") {
        const status = systemPreferences.getMediaAccessStatus("screen");
        if (status === "denied" || status === "restricted") return "permission";
      }
      let sources = await listScreenSources(true);
      if (!screenCapturePermission()) return "permission";
      sources = observationSources(
        sources,
        await observationDriver.observationWindows({
          signal: AbortSignal.timeout(2500),
        }),
        ownScreenSources(),
        process.pid,
      ).filter(({ identity }) => deniedWindow(identity) === false);
      if (!modeCurrent() || win.isDestroyed() || !win.isFocused())
        return "cancelled";
      if (!sources.length) return "no-sources";
      const visits = screenPickerVisits();
      const eligible = context.roles.filter(
        ({ id }) => screenView.eligible.includes(id) && visits.has(id),
      );
      if (!eligible.length) return "unavailable";
      const all = { id: "", name: `所有获准在场角色（${eligible.length} 位）` };
      const selection = await desktopSourceMenu(
        win,
        eligible.length > 1 ? [...eligible, all] : eligible,
        sources,
        ({ id, name }) =>
          `${id.startsWith("screen:") ? "显示器" : "窗口"} · ${name}`,
      );
      if (!selection || win.isDestroyed() || !win.isVisible())
        return "cancelled";
      const { state } = await readObservationTarget(
        selection.source,
        AbortSignal.timeout(3000),
        false,
      );
      if (state !== "ready")
        return state === "permission" ? state : "no-sources";
      if (
        !modeCurrent() ||
        win.isDestroyed() ||
        !win.isVisible() ||
        context.hidden ||
        context.desktopLocked
      )
        return "cancelled";
      const selected = selection.agentId
        ? [selection.agentId]
        : eligible.map(({ id }) => id);
      const current = () =>
        modeCurrent() &&
        context.remoteState?.roomEpoch === roomEpoch &&
        selected.every(
          (id) =>
            context.remoteState.observation?.eligible.includes(id) &&
            screenPickerVisits().get(id) === visits.get(id),
        );
      if (!current()) return "unavailable";
      const targetId = randomUUID();
      const records = selected.map((agentId) => ({
        agentId,
        source: selection.source,
        expiresAt: Date.now() + 15 * 60_000,
        controller: new AbortController(),
        probe: Promise.resolve(),
        digests: new Set(),
        roomEpoch,
        grantId: randomUUID(),
        pending: true,
      }));
      context.observationEnded = undefined;
      for (const grant of records) windowGrants.set(grant.agentId, grant);
      try {
        const room = await context.framework.command(
          "window-observation-grant-batch",
          {
            targetId,
            grants: records.map(({ agentId, grantId }) => ({
              roomEpoch,
              grantId,
              agentId,
              visitId: visits.get(agentId),
              modeRevision,
            })),
          },
        );
        const grants = new Map(
          room?.observation?.windowGrants?.map((grant) => [
            grant.grantId,
            grant,
          ]),
        );
        if (
          current() &&
          room?.roomEpoch === roomEpoch &&
          records.every(
            (grant) =>
              windowGrants.get(grant.agentId) === grant &&
              grants.has(grant.grantId),
          )
        ) {
          for (const grant of records) {
            grant.pending = false;
            grant.expiresAt = Math.min(
              grant.expiresAt,
              grants.get(grant.grantId).expiresAt,
            );
            grant.monitor = setInterval(() => monitorObservation(grant), 1300);
            monitorObservation(grant);
          }
          return "granted";
        }
        for (const grant of records) clearObservation(grant);
        return "unavailable";
      } catch {
        for (const grant of records) removeObservation(grant);
        return "failed";
      }
    } catch (error) {
      return observationError(error) === "permission" ? "permission" : "failed";
    } finally {
      context.choosingDesktopPermission = false;
    }
  }
  ipc.handle("room:observation", chooseObservationWindow);
}
