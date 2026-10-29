// Receive-channel recovery. Only a connection an administrator connected in this
// process is armed, and only an established socket that drops is retried. Sends
// are never replayed; messages posted while disconnected are not backfilled.
import { knownErrorCodes } from "./error-codes.mjs";
import { OutageNotice } from "./outage-notice.mjs";

const LOST = new Set([
  "CONNECTION_LOST",
  "ONEBOT_WS_ERROR",
  "ONEBOT_HEARTBEAT_TIMEOUT",
  // QQ logged out behind a live gateway. Retrying only checks get_status, so it
  // reconnects once someone has logged QQ in again and never provokes risk control.
  "QQ_OFFLINE",
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
    this.outage = new OutageNotice(runtime);
  }
  armed(id) {
    const previous = this.states.get(id);
    const current = {
      state: "connected",
      attempts: 0,
      nextRetryAt: null,
      error: null,
      attemptError: null,
      lostAt: null,
      lastGap: previous?.lostAt
        ? { lostAt: previous.lostAt, recoveredAt: this.runtime.now() }
        : previous?.lastGap || null,
    };
    this.states.set(id, current);
    if (!previous?.lostAt) return;
    // "Recovered" only goes to owners an outage line actually reached. A line
    // still on its way is waited for; if QQ dropped again meanwhile, the
    // recovery is stale and says nothing.
    const recover = () => {
      if (
        previous.told?.size &&
        this.states.get(id) === current &&
        current.state === "connected"
      )
        this.notify(id, "recovered", previous.noticeCode, null, [
          ...previous.told,
        ]);
    };
    if (!previous.sending?.size) recover();
    else
      this.runtime.trackJob(
        Promise.allSettled([...previous.sending]).then(recover),
        "connection:" + id,
      );
  }
  // At most one line per event and outage; the notice applies its own cooldown.
  notify(id, event, code, s = null, owners = null) {
    if (s?.notified.has(event)) return;
    s?.notified.add(event);
    const job = this.outage.send(id, event, code, owners).then((delivered) => {
      if (!s || !delivered.length) return;
      for (const owner of delivered) s.told.add(owner);
      s.noticeCode = code;
    });
    if (s) {
      s.sending.add(job);
      const done = () => s.sending.delete(job);
      job.then(done, done);
    }
    this.runtime.trackJob(job, "connection:" + id);
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
      notified: new Set(),
      told: new Set(),
      sending: new Set(),
      noticeCode: null,
    });
    if (code === "QQ_OFFLINE") this.notify(id, "offline", code, s);
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
      // Why the latest attempt failed (e.g. QQ still not logged in), as a
      // reviewed code only; the lost reason stays in `error`.
      s.attemptError = knownErrorCodes.has(error?.message)
        ? error.message
        : "CONNECTION_FAILED";
      const max = this.policy(id)?.maxAttempts ?? 0;
      if (FATAL.has(error?.message) || s.attempts >= max) {
        Object.assign(s, {
          state: "exhausted",
          error: FATAL.has(error?.message) ? error.message : s.error,
          nextRetryAt: null,
        });
        if (!r.closed) {
          r.faults.set(id, "QQ_AUTO_RECONNECT_EXHAUSTED");
          this.notify(
            id,
            "exhausted",
            FATAL.has(error?.message)
              ? error.message
              : "QQ_AUTO_RECONNECT_EXHAUSTED",
            s,
          );
        }
        return;
      }
      Object.assign(s, {
        state: "retrying",
        nextRetryAt: r.now() + this.delay(id, s.attempts + 1),
      });
      // Dropped for another reason, but QQ turned out to be logged out.
      if (s.attemptError === "QQ_OFFLINE")
        this.notify(id, "offline", "QQ_OFFLINE", s);
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
      attemptError: s?.attemptError ?? null,
      lostAt: s?.lostAt ?? null,
      lastGap: s?.lastGap ?? null,
    };
  }
}
