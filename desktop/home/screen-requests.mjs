import { createHash } from "node:crypto";
import { createDeferredScreenRequest } from "./deferred-screen-request.mjs";
import { readObservationFrame } from "./screen-source.mjs";

export function createScreenRequests({
  context,
  screenGrants,
  windowGrants,
  displayGrants,
  removeObservation,
  clearManualScreen,
  localObservation,
  localScreen,
  permissionRevision,
  observationCurrent,
  probeObservation,
  verifyApproachedWindow,
  readDisplayTarget,
  readObservationTarget,
  captureScreenSource,
  reportObservationState,
}) {
  let screenCapture;
  const deferredScreenRequest = createDeferredScreenRequest();

  function handle(value, action) {
    deferredScreenRequest.update(value, action, screenCapture);
    const { room: current, screenRequest: request } = value;
    for (const grant of windowGrants.values()) {
      const policy = current?.observation;
      if (
        current?.roomEpoch !== grant.roomEpoch ||
        !policy?.eligible.includes(grant.agentId) ||
        (!grant.pending &&
          !policy.windowGrants?.some(
            ({ grantId }) => grantId === grant.grantId,
          ))
      )
        removeObservation(grant);
    }
    for (const grant of screenGrants.values()) {
      const policy = current?.screenView;
      if (
        current?.roomEpoch !== grant.roomEpoch ||
        !policy?.eligible.includes(grant.agentId) ||
        (!grant.pending &&
          (policy.grants
            ? !policy.grants.some(({ grantId }) => grantId === grant.grantId)
            : policy.grantedAgentId !== grant.agentId))
      )
        clearManualScreen(grant);
    }
    for (const grant of displayGrants.values()) {
      const policy = current?.observation;
      if (
        current?.roomEpoch !== grant.roomEpoch ||
        !policy?.eligible.includes(grant.agentId) ||
        (!grant.pending &&
          !policy.displays?.some(({ grantId }) => grantId === grant.grantId))
      )
        removeObservation(grant);
    }
    const observe = request?.mode === "observation";
    const grant = observe
      ? localObservation(request.grantId)
      : localScreen(request?.grantId);
    if (!grant) return;
    if (
      !request ||
      permissionRevision("view") === undefined ||
      (observe && (!observationCurrent(grant) || grant.state !== "ready")) ||
      screenCapture ||
      request.roomEpoch !== grant.roomEpoch ||
      request.grantId !== grant.grantId ||
      deferredScreenRequest.hasStarted(grant, request.requestId)
    )
      return;
    deferredScreenRequest.markStarted(grant, request.requestId);
    const { roomEpoch, grantId, requestId, maxEdge, maxBytes } = request;
    const controller = new AbortController();
    screenCapture = {
      grant,
      controller,
      requestId,
      observe,
      windowTaskId: request.windowTaskId,
    };
    const isCurrent = () =>
      permissionRevision("view") !== undefined &&
      (observe
        ? observationCurrent(grant)
        : screenGrants.get(grant.agentId) === grant &&
          !context.desktopLocked &&
          !context.hidden) &&
      !controller.signal.aborted &&
      !context.shuttingDown;
    void (async () => {
      let status;
      try {
        if (observe) {
          const claim = await context.framework.result(
            "screen-claim",
            { roomEpoch, grantId, requestId },
            isCurrent,
          );
          if (!claim?.accepted || !isCurrent()) return;
        }
        const { signal } = controller;
        let data;
        let digest;
        const probe = async () => {
          if (observe) return probeObservation(grant, signal);
          if (!(await verifyApproachedWindow(request, signal)) || !isCurrent())
            return { state: "unavailable" };
          return grant.display
            ? readDisplayTarget(grant.display, signal)
            : readObservationTarget(grant.source, signal);
        };
        ({ data, status } = await readObservationFrame(
          probe,
          (source) =>
            captureScreenSource(source, maxEdge, maxBytes, signal, true).catch(
              () => undefined,
            ),
          isCurrent,
        ));
        if (observe && data) {
          digest = createHash("sha256").update(data).digest("hex");
          if (grant.digests.has(digest)) {
            data = undefined;
            status = "duplicate";
          }
        }
        if (isCurrent()) {
          await context.framework.result(
            "screen-result",
            { roomEpoch, grantId, requestId, data, status },
            isCurrent,
            data
              ? async () => {
                  const verified = await probe();
                  if (!isCurrent()) return false;
                  if (verified.state !== "ready") {
                    status = verified.state;
                    return false;
                  }
                  // A lost receipt can follow a delivered frame.
                  if (digest) grant.digests.add(digest);
                  return true;
                }
              : undefined,
          );
        }
      } catch {
        // The host owns request expiry and rejects stale results.
      } finally {
        screenCapture = undefined;
        if (observe && status && status !== "duplicate")
          reportObservationState(grant, status);
        else if (!observe && ["unavailable", "permission"].includes(status))
          clearManualScreen(grant);
        const deferred = deferredScreenRequest.take();
        if (deferred) handle(deferred, "deferred");
      }
    })();
  }

  return {
    handle,
    get active() {
      return screenCapture;
    },
  };
}
