// Receive-channel recovery. Only a connection an administrator connected in this
// process is armed, and only an established socket that drops is retried. Sends
// are never replayed; messages posted while disconnected are not backfilled.
const LOST = new Set([
  "CONNECTION_LOST",
  "ONEBOT_WS_ERROR",
  "ONEBOT_HEARTBEAT_TIMEOUT",
]);
// Identity and configuration failures will not heal by retrying.
const FATAL = new Set([
  "QQ_ACCOUNT_MISMATCH",
  "ONEBOT_TOKEN_ENV_MISSING",
  "CONNECTION_DISABLED",
  "UNKNOWN_CONNECTION",
  "ISOLATED_MODE",
]);
export class ConnectionRecovery {
  constructor(runtime) {
    this.runtime = runtime;
    this.states = new Map();
  }
  armed(id) {
    const previous = this.states.get(id);
    this.states.set(id, {
      state: "connected",
      attempts: 0,
      nextRetryAt: null,
      error: null,
      lostAt: null,
      lastGap: previous?.lostAt
        ? { lostAt: previous.lostAt, recoveredAt: this.runtime.now() }
        : previous?.lastGap || null,
    });
  }
  disarm(id) {
    this.states.delete(id);
  }
  lost(id, code) {
    const s = this.states.get(id);
    if (!s || s.state !== "connected" || !LOST.has(code)) return;
    Object.assign(s, {
      state: "retrying",
      attempts: 0,
      error: code,
      lostAt: this.runtime.now(),
      nextRetryAt: this.runtime.now() + this.delay(id, 1),
    });
  }
  policy(id) {
    return this.runtime.config.connections.find((c) => c.id === id)?.recovery;
  }
  // Exponential backoff with ±20% jitter so several connections do not retry in step.
  delay(id, attempt) {
    const p = this.policy(id) || { initialDelayMs: 2000, maxDelayMs: 300000 };
    const base = Math.min(
      p.maxDelayMs,
      p.initialDelayMs * 2 ** Math.max(0, attempt - 1),
    );
    return Math.round(base * (0.8 + 0.4 * this.runtime.random()));
  }
  tick() {
    const r = this.runtime;
    if (r.closed || r.configChanging || r.config.mode !== "live") return;
    for (const [id, s] of this.states) {
      if (s.state !== "retrying" || r.now() < s.nextRetryAt) continue;
      const c = r.config.connections.find((c) => c.id === id);
      if (!c?.enabled || !c.recovery.autoReconnect) {
        Object.assign(s, { state: "stopped", nextRetryAt: null });
        continue;
      }
      if (r.connecting.has(id) || r.reconfiguringConnections.has(id)) continue;
      s.attempts++;
      Object.assign(s, { state: "reconnecting", nextRetryAt: null });
      r.trackJob(this.attempt(id, s), "connection:" + id);
    }
  }
  async attempt(id, s) {
    const r = this.runtime;
    try {
      await r.connectConnection(id);
    } catch (error) {
      if (this.states.get(id) !== s) return;
      if (error?.message === "CONNECTION_ALREADY_STARTED")
        return this.armed(id);
      const max = this.policy(id)?.maxAttempts ?? 0;
      if (FATAL.has(error?.message) || s.attempts >= max) {
        Object.assign(s, {
          state: "exhausted",
          error: FATAL.has(error?.message) ? error.message : s.error,
          nextRetryAt: null,
        });
        if (!r.closed) r.faults.set(id, "QQ_AUTO_RECONNECT_EXHAUSTED");
        return;
      }
      Object.assign(s, {
        state: "retrying",
        nextRetryAt: r.now() + this.delay(id, s.attempts + 1),
      });
    }
  }
  snapshot(id) {
    const s = this.states.get(id),
      p = this.policy(id);
    return {
      enabled: p?.autoReconnect === true,
      maxAttempts: p?.maxAttempts ?? 0,
      state: s?.state || "idle",
      attempts: s?.attempts || 0,
      nextRetryAt: s?.nextRetryAt ?? null,
      error: s?.error ?? null,
      lostAt: s?.lostAt ?? null,
      lastGap: s?.lastGap ?? null,
    };
  }
}
