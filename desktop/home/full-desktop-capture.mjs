function displaySnapshot(getDisplays) {
  return getDisplays()
    .map(({ id, bounds, scaleFactor, rotation }) => ({
      displayId: String(id),
      bounds,
      scaleFactor,
      rotation,
    }))
    .sort((left, right) => left.displayId.localeCompare(right.displayId));
}

function encodeFrame(thumbnail, maxEdge, maxBytes) {
  if (!thumbnail || thumbnail.isEmpty()) return;
  const { width, height } = thumbnail.getSize();
  if (!width || !height) return;
  const initialScale = Math.min(1, maxEdge / Math.max(width, height));
  for (const scale of [1, 0.75, 0.5, 0.25]) {
    const frameScale = scale * initialScale;
    const frame =
      frameScale === 1
        ? thumbnail
        : thumbnail.resize({
            width: Math.max(1, Math.round(width * frameScale)),
            height: Math.max(1, Math.round(height * frameScale)),
          });
    for (const quality of [85, 65, 45, 25]) {
      const bytes = frame.toJPEG(quality);
      if (bytes.length && bytes.length <= maxBytes)
        return { ...frame.getSize(), data: bytes.toString("base64") };
    }
  }
}

function permissionDenied(status) {
  return status === "denied" || status === "restricted";
}

export function createFullDesktopCapture({
  getDisplays,
  getSources,
  permission,
}) {
  return async function capture({ maxEdge, maxBytes }, signal) {
    if (permissionDenied(permission())) return { status: "permission" };
    try {
      signal.throwIfAborted();
      const displays = displaySnapshot(getDisplays);
      if (!displays.length) return { status: "unavailable" };
      const sources = await getSources({
        types: ["screen"],
        thumbnailSize: { width: maxEdge, height: maxEdge },
      });
      signal.throwIfAborted();
      if (permission() !== "granted") return { status: "permission" };
      // A hot-plug or layout change can otherwise pair pixels with stale coordinates.
      if (
        JSON.stringify(displays) !==
        JSON.stringify(displaySnapshot(getDisplays))
      )
        return { status: "unavailable" };
      const frames = [];
      const maxFrameBytes = Math.floor(maxBytes / displays.length);
      for (const { displayId, bounds } of displays) {
        const matches = sources.filter(
          (source) => source.display_id === displayId,
        );
        const frame =
          matches.length === 1 &&
          encodeFrame(matches[0].thumbnail, maxEdge, maxFrameBytes);
        if (!frame) return { status: "unavailable" };
        frames.push({ displayId, bounds, ...frame });
      }
      return { frames };
    } catch (error) {
      if (signal.aborted) throw error;
      return {
        status: permission() === "granted" ? "unavailable" : "permission",
      };
    }
  };
}

function requestIdentity({
  roomEpoch,
  agentId,
  visitId,
  requestId,
  observationRevision,
}) {
  return { roomEpoch, agentId, visitId, requestId, observationRevision };
}

export function createDesktopCaptureHandler({
  capture,
  send,
  available,
  blocked,
}) {
  let pending;

  function update(value) {
    const request = value?.desktopCaptureRequest;
    if (
      !available() ||
      value?.offline ||
      !request ||
      request.roomEpoch !== value.room?.roomEpoch
    ) {
      pending?.controller.abort();
      pending = undefined;
      return;
    }
    const identity = requestIdentity(request);
    const key = JSON.stringify(identity);
    if (pending?.key !== key) {
      pending?.controller.abort();
      pending = { key, controller: new AbortController() };
    }
    const current = pending;
    if (current.sending || current.sent) return;
    const { signal } = current.controller;
    const isCurrent = () => pending === current && !signal.aborted;
    current.sending = true;
    return (async () => {
      try {
        current.result ??= blocked()
          ? { status: "unavailable" }
          : await capture(request, signal);
        if (!isCurrent()) return;
        const payload = blocked() ? { status: "unavailable" } : current.result;
        current.sent = Boolean(
          await send(
            { ...identity, ...payload },
            () => isCurrent() && (!payload.frames || !blocked()),
          ),
        );
      } catch {
        // Keep the result for retry if the same request is published again.
      } finally {
        current.sending = false;
      }
    })();
  }

  return { update };
}
