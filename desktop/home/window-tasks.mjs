export function createWindowTasks({
  context,
  nativeControl,
  screenGrants,
  screenCapturePermission,
  entries,
  activeFollow,
  windowVisible,
  windowGeometry,
  stopLocalSeat,
  moveResident,
}) {
  function windowTaskGrant(scope, agentId, roomEpoch) {
    if (!agentId || !roomEpoch || !context.remoteState?.interactionsAvailable)
      return;
    const policy =
      scope === "screen"
        ? context.remoteState.screenView
        : context.remoteState.nativeControl;
    if (!policy || context.remoteState?.roomEpoch !== roomEpoch) return;
    if (scope === "native")
      return (
        policy.grantedAgentId === agentId &&
        nativeControl?.selectedWindow(agentId, roomEpoch)
      );
    const screenGrant = screenGrants.get(agentId);
    if (
      screenGrant?.geometrySource &&
      (policy.grants
        ? policy.grants.some(({ grantId }) => grantId === screenGrant.grantId)
        : policy.grantedAgentId === agentId) &&
      !screenGrant.pending &&
      screenGrant.roomEpoch === roomEpoch &&
      screenGrant.agentId === agentId &&
      screenCapturePermission()
    )
      return screenGrant;
  }

  function controllableResident(agentId, roomEpoch, visitId, approach = false) {
    const role = context.remoteState?.roles.find(({ id }) => id === agentId);
    const entry = entries.get(agentId);
    if (
      (approach ||
        context.remoteState?.interactionsAvailable ||
        context.remoteState?.socialBodyAvailable) &&
      context.remoteState?.roomEpoch === roomEpoch &&
      !context.remoteState.connectionLost &&
      !context.hidden &&
      !context.desktopLocked &&
      !context.shuttingDown &&
      role?.state === "here" &&
      role.bodyVisitId === visitId &&
      role.bodyControlAvailable &&
      !["paused", "qq"].includes(role.bodyStatus?.state) &&
      entry &&
      !entry.departing &&
      !entry.drag &&
      !entries.get("door")?.drag &&
      !activeFollow(entry) &&
      windowVisible(entry)
    )
      return entry;
  }

  function stopLocalWindowTask(reason, agentId) {
    const task = context.approachedWindowTask;
    if (task && (!agentId || task.agentId === agentId)) {
      context.approachedWindowTask = undefined;
      const capture = context.screenCapture;
      if (capture?.windowTaskId === task.id) capture.controller.abort();
      nativeControl?.stopWindowTask(task.id);
    }
    for (const entry of entries.values()) {
      if (agentId && entry.id !== agentId) continue;
      const cancel = entry.localComboCancel;
      entry.localComboCancel = undefined;
      cancel?.(reason);
    }
  }

  async function verifyApproachedWindow(request, signal) {
    if (!request.windowTaskId) return true;
    const task = context.approachedWindowTask;
    if (
      !task ||
      request.windowTaskId !== task.id ||
      request.roomEpoch !== task.roomEpoch ||
      request.grantId !== task.grant.grantId ||
      !task.current()
    )
      return false;
    try {
      const result = await windowGeometry(task.source, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(1800)]),
      });
      return (
        !signal.aborted &&
        context.approachedWindowTask === task &&
        task.current() &&
        sameRectangle(task.bounds, result?.bounds)
      );
    } catch {
      return false;
    }
  }

  function sameRectangle(a, b) {
    return (
      b &&
      a.x === b.x &&
      a.y === b.y &&
      a.width === b.width &&
      a.height === b.height
    );
  }

  function executeWindowTask(request, current, finish) {
    const { agentId, roomEpoch, visitId, expiresAt, inputAt, windowTask } =
      request;
    const entry = controllableResident(agentId, roomEpoch, visitId);
    const grant = windowTaskGrant(windowTask.scope, agentId, roomEpoch);
    if (
      !entry ||
      grant?.grantId !== windowTask.grantId ||
      inputAt <= Math.max(entry.bodyInputAfter ?? 0, context.bodyInputAfter)
    )
      return finish({ status: "cancelled", reason: "target-unavailable" });
    const source = grant.geometrySource ?? grant.source;
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(Math.max(1, expiresAt - Date.now())),
    ]);
    let cancelMove;
    const localCurrent = () =>
      controllableResident(agentId, roomEpoch, visitId) === entry &&
      windowTaskGrant(windowTask.scope, agentId, roomEpoch) === grant &&
      inputAt > Math.max(entry.bodyInputAfter ?? 0, context.bodyInputAfter);
    const moving = () => !signal.aborted && current() && localCurrent();
    const complete = (result) => {
      if (entry.localComboCancel === cancel) entry.localComboCancel = undefined;
      finish(result);
    };
    const cancel = (reason) => {
      controller.abort();
      cancelMove?.(reason);
    };
    entry.localComboCancel = cancel;
    stopLocalSeat(entry, "stopped");
    void (async () => {
      try {
        const geometry = await windowGeometry(source, { signal });
        if (!geometry || !moving()) {
          complete({ status: "cancelled", reason: "target-unavailable" });
          return;
        }
        const { bounds } = geometry;
        cancelMove = moveResident(
          entry,
          { target: { type: "window", bounds } },
          {
            current: moving,
            expiresAt,
            crossDisplay: request.crossDisplay === true,
            local: true,
            fail: (reason, status) => complete({ status, reason }),
            finish: () => {
              cancelMove = undefined;
              void (async () => {
                const checked = await windowGeometry(source, { signal });
                if (!moving() || !sameRectangle(bounds, checked?.bounds)) {
                  complete({
                    status: "failed",
                    reason: "position-unconfirmed",
                  });
                  return;
                }
                const point = entry.win.getBounds();
                context.approachedWindowTask = {
                  id: windowTask.id,
                  agentId,
                  roomEpoch,
                  grant,
                  source,
                  bounds,
                  current: () =>
                    localCurrent() &&
                    sameRectangle(point, entry.win.getBounds()),
                };
                complete({ status: "completed", arrivalConfirmed: true });
              })().catch(() =>
                complete({ status: "failed", reason: "target-unavailable" }),
              );
            },
          },
        );
      } catch {
        complete({ status: "failed", reason: "target-unavailable" });
      }
    })();
    return (reason) => {
      if (entry.localComboCancel === cancel)
        stopLocalWindowTask(reason, agentId);
    };
  }

  return {
    windowTaskGrant,
    controllableResident,
    stopLocalWindowTask,
    verifyApproachedWindow,
    sameRectangle,
    executeWindowTask,
  };
}
