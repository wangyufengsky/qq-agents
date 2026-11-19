import {
  companionMode,
  sensitiveApplications,
  sensitiveWindow,
} from "./companion-preferences.mjs";

export function createCompanionController({
  context,
  clearScreenGrant,
  displayGrants,
  removeObservation,
  stopLocalWindowTask,
  savePreferences,
  update,
}) {
  function permissionRevision(kind, state = context.remoteState) {
    if (
      !state?.connected ||
      context.hidden ||
      context.desktopLocked ||
      context.shuttingDown ||
      state.companionMode !== context.selectedMode ||
      context.selectedMode === "privacy" ||
      (kind === "control" && context.selectedMode !== "work") ||
      !Number.isSafeInteger(state.companionRevision) ||
      context.syncingMode
    )
      return;
    return state.companionRevision;
  }

  function syncCompanionMode(state = context.remoteState) {
    if (
      !context.framework ||
      !state?.connected ||
      !state.roomEpoch ||
      state.desktopUnified
    )
      return;
    if (
      state.companionMode === context.selectedMode &&
      Number.isSafeInteger(state.companionRevision)
    )
      return;
    const request = { roomEpoch: state.roomEpoch, mode: context.selectedMode };
    if (
      context.syncingMode?.roomEpoch === request.roomEpoch &&
      context.syncingMode.mode === request.mode
    )
      return context.syncingMode.promise;
    context.syncingMode = request;
    request.promise = context.framework
      .authorization("mode-set", request.mode)
      .then(
        (room) =>
          room?.roomEpoch === request.roomEpoch &&
          room.companionMode === request.mode,
      )
      .catch(() => false)
      .finally(() => {
        if (context.syncingMode === request) {
          context.syncingMode = undefined;
          update();
        }
      });
    return request.promise;
  }

  function clearVisualPermissions() {
    clearScreenGrant();
    clearScreenGrant(true);
    for (const grant of displayGrants.values()) removeObservation(grant);
    context.displayPicker = undefined;
    context.screenPicker = undefined;
  }

  function clearControlPermissions() {
    context.nativeControl?.clear();
    stopLocalWindowTask("inactive");
    context.lastBrowserGrant = undefined;
  }

  function stopCompanionControl(agentId) {
    const {
      roomEpoch,
      nativeControl: native,
      browserControl: browser,
    } = context.remoteState ?? {};
    if (!roomEpoch || !context.framework) return;
    const match = (id) => id && (!agentId || agentId === id);
    if (match(native?.grantedAgentId))
      void context.nativeControl
        ?.revoke(roomEpoch, native.grantedAgentId)
        .catch(() => {});
    const grant = context.lastBrowserGrant;
    if (
      match(browser?.grantedAgentId) &&
      grant?.roomEpoch === roomEpoch &&
      grant.agentId === browser.grantedAgentId
    ) {
      context.lastBrowserGrant = undefined;
      void context.framework
        .authorization("browser-revoke", {
          roomEpoch,
          grantId: grant.grantId,
        })
        .catch(() => {});
    }
  }

  function invalidatePermissions(reason) {
    clearVisualPermissions();
    clearControlPermissions();
    if (
      context.framework &&
      context.remoteState?.connected &&
      !context.remoteState.desktopUnified
    )
      void context.framework
        .authorization("mode-invalidate", reason)
        .catch(() => {});
  }

  function deniedWindow(window) {
    return sensitiveWindow(context.blockedApplications, window);
  }

  function register(ipc, permissionPanel) {
    ipc.handle("room:companion-mode", async (event, input) => {
      const roomEpoch = context.remoteState?.roomEpoch;
      if (!permissionPanel(event, roomEpoch)) return false;
      if (input?.action === "applications") {
        const next = sensitiveApplications(input.value);
        if (!next) return false;
        if (
          JSON.stringify(next) === JSON.stringify(context.blockedApplications)
        )
          return true;
        context.blockedApplications = next;
        if (!context.remoteState.desktopUnified)
          invalidatePermissions("policy-changed");
        savePreferences();
        update();
        return true;
      }
      if (context.remoteState.desktopUnified) return false;
      const next = companionMode(input?.value);
      if (input?.action !== "mode" || !next) return false;
      if (next !== context.selectedMode) {
        context.selectedMode = next;
        if (next === "privacy") clearVisualPermissions();
        if (next !== "work") clearControlPermissions();
        savePreferences();
        update();
      }
      return (await syncCompanionMode()) ?? true;
    });
  }

  return {
    permissionRevision,
    syncCompanionMode,
    clearVisualPermissions,
    clearControlPermissions,
    stopCompanionControl,
    invalidatePermissions,
    deniedWindow,
    register,
  };
}
