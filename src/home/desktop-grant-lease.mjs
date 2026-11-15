const LEASE_MS = 15 * 60_000;

// A used ID cannot revive a grant after its lease, even if a delayed request arrives.
export class DesktopGrantLease {
  constructor(host, unavailable) {
    this.host = host;
    this.unavailable = unavailable;
    this.used = new Set();
  }

  attach(grant, expire) {
    if (this.host.mode == null) return;
    if (this.used.has(grant.grantId)) throw Error(this.unavailable);
    this.used.add(grant.grantId);
    grant.expiresAt = this.host.runtime.now() + LEASE_MS;
    grant.leaseTimer = setTimeout(expire, LEASE_MS);
    grant.leaseTimer.unref();
  }

  valid(grant) {
    return (
      grant.expiresAt === undefined || grant.expiresAt > this.host.runtime.now()
    );
  }

  clear(grant) {
    if (grant?.leaseTimer) clearTimeout(grant.leaseTimer);
  }

  expired(grant) {
    if (!this.valid(grant) && this.host.mode != null) this.host.modeRevision++;
  }
}
