export function createObservationMonitor({
  current,
  local,
  probe,
  report,
  remove,
  clear,
  sync,
  now = Date.now,
}) {
  return (grant) => {
    if (grant.monitoring) return;
    if (!current(grant)) {
      if (local(grant.grantId) !== grant) return;
      if (grant.display && now() >= grant.expiresAt) {
        remove(grant);
        sync();
      } else clear(grant);
      return;
    }
    grant.monitoring = true;
    void probe(grant)
      .then(({ state }) => report(grant, state))
      .finally(() => {
        grant.monitoring = false;
      });
  };
}
