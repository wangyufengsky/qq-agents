// Keep only the newest authoritative snapshot while an earlier capture settles.
export function createDeferredScreenRequest() {
  let latest;
  const started = new WeakMap();
  return {
    update(value, action, active) {
      if (action !== "sync") return;
      latest = active && !value.offline ? value : undefined;
      if (active && active.requestId !== value.screenRequest?.requestId)
        active.controller.abort();
    },
    hasStarted(grant, requestId) {
      return started.get(grant)?.has(requestId) ?? false;
    },
    markStarted(grant, requestId) {
      let ids = started.get(grant);
      if (!ids) started.set(grant, (ids = new Set()));
      ids.add(requestId);
    },
    take() {
      const value = latest;
      latest = undefined;
      return value;
    },
  };
}
