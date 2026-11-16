import { createObservationMonitor } from "./observation-monitor.mjs";

export function createObservationController({
  context,
  screenGrants,
  windowGrants,
  displayGrants,
  body,
  permissionRevision,
  readDisplayTarget,
  readObservationTarget,
  update,
}) {
  function clearScreenGrant(observe = false) {
    if (observe) {
      for (const grant of windowGrants.values()) removeObservation(grant);
    } else {
      for (const grant of screenGrants.values()) clearManualScreen(grant);
    }
  }

  function clearManualScreen(grant) {
    if (screenGrants.get(grant.agentId) !== grant) return;
    screenGrants.delete(grant.agentId);
    if (context.screenCapture?.grant === grant)
      context.screenCapture.controller.abort();
  }

  function localScreen(grantId) {
    return [...screenGrants.values()].find(
      (grant) => grant.grantId === grantId,
    );
  }

  function stopObservation(grant) {
    grant.controller.abort();
    clearInterval(grant.monitor);
    if (context.screenCapture?.grant === grant)
      context.screenCapture.controller.abort();
    body.stopObservation(grant.agentId, grant.grantId);
  }

  function localObservation(grantId) {
    if (!grantId) return;
    return [...windowGrants.values(), ...displayGrants.values()].find(
      (grant) => grant.grantId === grantId,
    );
  }

  function observationCurrent(grant) {
    return (
      permissionRevision("view") !== undefined &&
      grant &&
      localObservation(grant.grantId) === grant &&
      !grant.controller.signal.aborted &&
      !context.hidden &&
      !context.desktopLocked &&
      !context.shuttingDown &&
      Date.now() < grant.expiresAt
    );
  }

  function probeObservation(grant, signal = grant.controller.signal) {
    // A check queued after a capture must read the native window again.
    const probe = grant.probe.then(() =>
      observationCurrent(grant) && !signal.aborted
        ? grant.display
          ? readDisplayTarget(grant.display, signal)
          : readObservationTarget(grant.source, signal)
        : { state: "unavailable" },
    );
    grant.probe = probe;
    return probe;
  }

  function reportObservationState(grant, state) {
    if (!observationCurrent(grant)) return;
    const changed = grant.state !== state;
    const now = Date.now();
    if (!changed && (state !== "ready" || now - grant.reportedAt < 1200))
      return;
    grant.state = state;
    grant.proofUntil = state === "ready" ? now + 5000 : 0;
    grant.reportedAt = now;
    const { roomEpoch, grantId, agentId } = grant;
    context.framework.act("observation-state", { roomEpoch, grantId, state });
    if (!changed) return;
    context.observationEnded = {
      minimized: "target-minimized",
      unavailable: "target-unavailable",
      permission: "permission",
    }[state];
    if (state === "minimized") {
      if (context.screenCapture?.grant === grant)
        context.screenCapture.controller.abort();
      body.stopObservation(agentId, grantId);
    }
    if (state === "unavailable" || state === "permission")
      removeObservation(grant);
    update();
  }

  const monitorObservation = createObservationMonitor({
    current: observationCurrent,
    local: localObservation,
    probe: probeObservation,
    report: reportObservationState,
    remove: removeObservation,
    clear: clearObservation,
    sync: () => context.framework?.sync(),
  });

  function removeObservation(grant) {
    const grants = grant.display ? displayGrants : windowGrants;
    if (grants.get(grant.agentId) !== grant) return;
    grants.delete(grant.agentId);
    stopObservation(grant);
  }

  function clearObservation(grant) {
    if (!grant) {
      context.displayPicker = undefined;
      for (const current of [
        ...windowGrants.values(),
        ...displayGrants.values(),
      ])
        clearObservation(current);
      return;
    }
    removeObservation(grant);
    if (context.framework && !context.shuttingDown)
      context.framework.act(
        grant.display ? "observation-state" : "observation-revoke",
        {
          ...(grant.display && { state: "unavailable" }),
          roomEpoch: grant.roomEpoch,
          grantId: grant.grantId,
        },
      );
  }

  function verifyObservationRequest(grant, request) {
    if (!observationCurrent(grant)) return;
    if (grant.verify?.requestId !== request?.requestId) {
      grant.verify?.controller.abort();
      grant.verify = undefined;
    }
    if (
      !request ||
      grant.state !== "ready" ||
      request.roomEpoch !== grant.roomEpoch ||
      request.grantId !== grant.grantId ||
      request.requestId === grant.lastVerify
    )
      return;
    const { roomEpoch, grantId, requestId } = request;
    const controller = new AbortController();
    grant.verify = { controller, requestId };
    grant.lastVerify = requestId;
    const signal = AbortSignal.any([
      controller.signal,
      grant.controller.signal,
    ]);
    const current = () =>
      !signal.aborted &&
      observationCurrent(grant) &&
      grant.state === "ready" &&
      grant.verify?.requestId === requestId;
    void (async () => {
      let state;
      try {
        ({ state } = await probeObservation(grant, signal));
        if (!current()) return;
        await context.framework.result(
          "observation-verify",
          { roomEpoch, grantId, requestId, state },
          current,
        );
      } catch {
        // The host rejects requests that expired while checking the window.
      } finally {
        if (current() && state) reportObservationState(grant, state);
      }
    })();
  }

  return {
    clearScreenGrant,
    clearManualScreen,
    localScreen,
    stopObservation,
    localObservation,
    observationCurrent,
    probeObservation,
    reportObservationState,
    monitorObservation,
    removeObservation,
    clearObservation,
    verifyObservationRequest,
  };
}
