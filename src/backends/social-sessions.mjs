// @ts-check
import { canonical } from "./session-contract.mjs";

/** Backend-private session ownership; no ordinary chat session enters this pool. */
export class SocialSessionPool {
  /** @param {(session: any, conversation: string) => Promise<void>} dispose */
  constructor(dispose) {
    this.dispose = dispose;
    /** @type {Map<string, any>} */
    this.capsules = new Map();
    this.closed = new Set();
  }
  /** @param {any} binding @param {string} toolSignature */
  async acquire(binding, toolSignature) {
    const windowId = binding?.windowId || null;
    const actorGeneration = binding?.actorIdentity?.generation || null;
    if (!binding?.runId || (windowId && !actorGeneration))
      throw Error("SOCIAL_TURN_CLOSED");
    const key = JSON.stringify(
      windowId ? [windowId, actorGeneration] : ["run", binding.runId],
    );
    const contract = JSON.stringify(
      canonical({
        actor: binding.actorIdentity,
        target: binding.target,
        host: binding.targetHostGeneration,
        guest: binding.targetGuestGeneration,
        epoch: binding.epoch,
        windowFence: binding.windowFence,
        backend: binding.backendContract,
        toolSignature,
      }),
    );
    if (windowId && this.closed.has(key)) throw Error("SOCIAL_TURN_CLOSED");
    let entry = this.capsules.get(key);
    if (entry && entry.contract !== contract) {
      await this.closeEntry(entry);
      throw Error("SOCIAL_TURN_CLOSED");
    }
    if (entry && entry.state !== "idle") throw Error("SOCIAL_TURN_CLOSED");
    if (!entry) {
      entry = {
        key,
        windowId,
        actorGeneration,
        contract,
        conversation: windowId
          ? `@social:${windowId}:${actorGeneration}`
          : `@social:${binding.runId}`,
        session: null,
        messages: [],
        state: "idle",
      };
      this.capsules.set(key, entry);
    }
    entry.state = "running";
    entry.controller = new AbortController();
    entry.done = new Promise((resolve) => {
      entry.finish = resolve;
    });
    return entry;
  }
  /** Release the per-run callback ownership before an idle session can be reused.
   * @param {any} entry @param {boolean} keep */
  async release(entry, keep) {
    entry.controller.abort();
    entry.finish();
    if (keep && entry.windowId && entry.state === "running") {
      entry.state = "idle";
      entry.controller = null;
      entry.done = null;
      entry.finish = null;
      return;
    }
    await this.closeEntry(entry);
  }
  /** @param {any} entry */
  async closeEntry(entry) {
    if (entry.closing) return entry.closing;
    entry.state = "closing";
    if (entry.windowId) this.closed.add(entry.key);
    entry.controller?.abort();
    entry.closing = (async () => {
      await entry.done;
      try {
        await this.dispose(entry.session, entry.conversation);
      } finally {
        entry.session = null;
        entry.messages.length = 0;
        entry.state = "closed";
        this.capsules.delete(entry.key);
      }
    })();
    return entry.closing;
  }
  /** @param {{windowId?: string, actorGeneration?: string}} [filter] */
  async close(filter = {}) {
    const results = await Promise.allSettled(
      [...this.capsules.values()]
        .filter(
          (entry) =>
            (!filter.windowId || entry.windowId === filter.windowId) &&
            (!filter.actorGeneration ||
              entry.actorGeneration === filter.actorGeneration),
        )
        .map((entry) => this.closeEntry(entry)),
    );
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
}

/** @param {any} backend @param {(session: any, conversation: string) => Promise<void>} dispose */
export function socialSessionPool(backend, dispose) {
  return (backend.socialSessionPool ||= new SocialSessionPool(dispose));
}
/** @param {any} backend @param {{windowId?: string, actorGeneration?: string}} [filter] */
export async function closeSocialSessions(backend, filter = {}) {
  await backend.socialSessionPool?.close(filter);
}
