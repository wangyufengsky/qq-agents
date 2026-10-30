// @ts-check
import { setTimeout as delay } from "node:timers/promises";

// Admission closes before waiting. Existing capabilities retain their normal
// permissions and deadlines; pausing them would cancel the session we preserve.
export class MaintenanceDrain {
  /** @param {any} runtime */
  constructor(runtime) {
    this.runtime = runtime;
    /** @type {Set<any> | null} */
    this.contexts = null;
    /** @type {Set<Promise<unknown>>} */
    this.pending = new Set();
    this.deadline = 0;
    /** @type {{globalPaused: boolean, connections: string[]} | null} */
    this.checkpoint = null;
  }
  begin() {
    const r = this.runtime;
    if (r.closed) throw Error("RUNTIME_CLOSING");
    if (this.contexts) return this.snapshot();
    if (r.updateMaintenance) throw Error("UPDATE_IN_PROGRESS");
    this.contexts = new Set([
      ...r.capabilities.values(),
      ...r.running.values(),
    ]);
    this.pending = new Set();
    this.deadline =
      Math.max(
        Date.now(),
        ...[...this.contexts].map((ctx) => ctx.expires || Date.now()),
      ) + 40000;
    this.checkpoint = {
      globalPaused: r.config.globalPaused,
      connections: r.config.connections
        .filter(
          (/** @type {any} */ c) =>
            c.enabled && r.transports.get(c.id)?.connected,
        )
        .map((/** @type {any} */ c) => c.id),
    };
    r.updateMaintenance = true;
    r.autoResume.cancel("cancelled");
    for (const ctx of this.contexts) {
      if (!ctx.done) continue;
      this.pending.add(ctx.done);
      const remove = () => this.pending.delete(ctx.done);
      ctx.done.then(remove, remove);
    }
    return this.snapshot();
  }
  get active() {
    return !!this.contexts;
  }
  /** @param {any} ctx */
  allows(ctx) {
    return !!ctx && this.contexts?.has(ctx) === true;
  }
  snapshot() {
    return {
      active: this.active,
      pending: this.active
        ? this.pending.size +
          this.runtime.sendChains.size +
          Number(!!this.runtime.configChanging)
        : 0,
      deadline: this.active ? this.deadline : null,
    };
  }
  async wait() {
    this.begin();
    while (this.snapshot().pending) {
      if (Date.now() >= this.deadline) throw Error("UPDATE_DRAIN_TIMEOUT");
      await delay(25);
    }
    return this.checkpoint;
  }
  clear() {
    this.contexts = null;
    this.pending = new Set();
    this.deadline = 0;
    this.checkpoint = null;
  }
}
