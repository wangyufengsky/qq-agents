// @ts-check
import { setTimeout as sleep } from "node:timers/promises";
import { knownErrorCodes } from "./error-codes.mjs";

// Opt-in `--resume` (with `--live`): every boot still starts globally paused,
// and the barrier is lifted only after each enabled QQ connection is connected
// and the backend of every unpaused agent answers, as scripts/robots.mjs
// `start --resume` does. Agent, conversation and quiet-hour pauses are kept.
// An administrator's own pause or resume request ends the automatic attempt.
export class AutoResume {
  /**
   * @param {any} runtime
   * @param {{enabled?: boolean, maxAttempts?: number, initialDelayMs?: number, maxDelayMs?: number, wait?: (ms: number, signal: AbortSignal) => Promise<unknown>}} [options]
   */
  constructor(
    runtime,
    {
      enabled = false,
      maxAttempts = 10,
      initialDelayMs = 5000,
      maxDelayMs = 60000,
      wait = (ms, signal) => sleep(ms, undefined, { signal, ref: false }),
    } = {},
  ) {
    this.runtime = runtime;
    this.enabled = enabled;
    this.maxAttempts = maxAttempts;
    this.initialDelayMs = initialDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.wait = wait;
    this.controller = new AbortController();
    /** @type {{state: string, attempts: number, error: string | null, nextAttemptAt: number | null, resumedAt: number | null}} */
    this.status = {
      state: enabled ? "waiting" : "off",
      attempts: 0,
      error: null,
      nextAttemptAt: null,
      resumedAt: null,
    };
  }
  snapshot() {
    return { enabled: this.enabled, ...this.status };
  }
  /** The administrator took over (pause, resume or isolated mode). */
  cancel(state = "cancelled") {
    if (!["waiting", "resuming"].includes(this.status.state)) return;
    Object.assign(this.status, { state, nextAttemptAt: null });
    this.controller.abort();
  }
  async run() {
    if (!this.enabled) return this.snapshot();
    const r = this.runtime,
      signal = this.controller.signal;
    while (!signal.aborted && !r.closed) {
      if (r.config.mode !== "live")
        return this.finish("skipped", "ISOLATED_MODE");
      if (!r.config.globalPaused) return this.finish("not-needed");
      this.status.attempts++;
      Object.assign(this.status, { state: "resuming", nextAttemptAt: null });
      try {
        await this.attempt();
        if (signal.aborted || r.closed) break;
        await r.pause("all", false);
        this.status.resumedAt = r.now();
        return this.finish("resumed");
      } catch (error) {
        if (signal.aborted || r.closed) break;
        this.status.error =
          error instanceof Error && knownErrorCodes.has(error.message)
            ? error.message
            : "AUTO_RESUME_FAILED";
        if (this.status.attempts >= this.maxAttempts)
          return this.finish("failed", this.status.error);
      }
      const delay = Math.min(
        this.maxDelayMs,
        this.initialDelayMs * 2 ** (this.status.attempts - 1),
      );
      Object.assign(this.status, {
        state: "waiting",
        nextAttemptAt: r.now() + delay,
      });
      await this.wait(delay, signal).catch(() => {});
    }
    return this.snapshot();
  }
  async attempt() {
    const r = this.runtime;
    const enabled = r.config.connections.filter(
      (/** @type {any} */ c) => c.enabled,
    );
    for (const c of enabled)
      if (!r.transports.get(c.id)?.connected && !r.connecting.has(c.id))
        await r.startConnection(c.id);
    if (
      !enabled.every(
        (/** @type {any} */ c) => r.transports.get(c.id)?.connected,
      )
    )
      throw Error("QQ_NOT_READY");
    const backendIds = new Set(
      r.config.agents
        .filter((/** @type {any} */ a) => !a.paused)
        .map((/** @type {any} */ a) => a.backendId),
    );
    for (const id of backendIds) {
      const result = await r.backendConnections.check(id);
      if (result.state !== "ready")
        throw Error(result.error || "BACKEND_UNAVAILABLE");
    }
  }
  /** @param {string} state @param {string | null} [error] */
  finish(state, error = null) {
    Object.assign(this.status, { state, error, nextAttemptAt: null });
    return this.snapshot();
  }
}
