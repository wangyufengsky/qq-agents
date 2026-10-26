import { z } from "zod";
import {
  discoverDshInstances,
  selectDshInstance,
} from "../backends/dsh-discovery.mjs";

const request = z
  .object({
    id: z.string().min(1),
    action: z.enum(["check", "recover", "discover", "settings"]),
    candidateId: z.string().max(300).optional(),
    autoReconnect: z.boolean().optional(),
  })
  .strict();
const known = new Set([
  "DSH_NOT_FOUND",
  "DSH_INSTANCE_UNAVAILABLE",
  "DSH_SELECTION_REQUIRED",
  "DSH_STREAM_ENDED",
  "DSH_STREAM_FAILED",
  "DSH_STREAM_TIMEOUT",
  "CODEX_DISCONNECTED",
  "CODEX_PROCESS_EXITED",
  "CODEX_NOT_CONNECTED",
  "CODEX_DEDICATED_LOGIN_REQUIRED",
  "BACKEND_MODEL_UNAVAILABLE",
  "BACKEND_NO_AGENTS",
  "BACKEND_PROBE_FAILED",
  "BACKEND_RECOVERY_FAILED",
]);
export const isConnectionFailure = (error) => known.has(error?.message);
export const connectionError = (e) =>
  known.has(e?.message) ? e.message : "BACKEND_PROBE_FAILED";
function failureState(code) {
  return code === "CODEX_DEDICATED_LOGIN_REQUIRED"
    ? "login-required"
    : code === "DSH_SELECTION_REQUIRED"
      ? "selection-required"
      : "disconnected";
}
export class BackendConnections {
  constructor(runtime, { discover = discoverDshInstances } = {}) {
    this.runtime = runtime;
    this.discover = discover;
    this.states = new Map();
    this.operations = new Map();
    this.blocked = new Set();
  }
  config(id) {
    const b = this.runtime.config.backends.find((x) => x.id === id);
    if (!b) throw Error("UNKNOWN_BACKEND");
    return b;
  }
  agents(id) {
    return this.runtime.config.agents.filter((a) => a.backendId === id);
  }
  state(id) {
    if (!this.states.has(id))
      this.states.set(id, {
        state: "unchecked",
        error: null,
        checkedAt: null,
        attempts: 0,
        nextRetryAt: null,
        agents: [],
      });
    return this.states.get(id);
  }
  snapshot(id) {
    const config = this.config(id),
      s = this.state(id);
    return {
      id,
      type: config.type,
      ...s,
      autoReconnect: config.recovery?.autoReconnect === true,
      dshInstance: config.recovery?.dshInstance || null,
    };
  }
  list() {
    return this.runtime.config.backends.map((b) => this.snapshot(b.id));
  }
  adapter(a) {
    if (this.runtime.closed) throw Error("BACKEND_RECOVERY_FAILED");
    let b = this.runtime.backends.get(a.id);
    if (!b) {
      const config = this.config(a.backendId);
      b = this.runtime.backendFactory(
        {
          ...config,
          model: a.model || config.model,
          effort: a.effort || config.effort,
        },
        a,
      );
      this.runtime.backends.set(a.id, b);
      b.onDisconnect = (error) => {
        if (
          this.runtime.backends.get(a.id) === b &&
          !this.blocked.has(a.id) &&
          !this.runtime.closed
        ) {
          this.failed(a.backendId, error);
          const row = this.state(a.backendId).agents.find((x) => x.id === a.id);
          if (row)
            Object.assign(row, {
              state: "disconnected",
              error: connectionError(error),
            });
        }
      };
    }
    return b;
  }
  failed(id, error) {
    const s = this.state(id),
      code = connectionError(error);
    s.state = failureState(code);
    s.error = code;
    s.checkedAt = this.runtime.now();
    s.nextRetryAt ??= this.runtime.now() + 5000;
  }
  succeeded(id) {
    const s = this.state(id);
    s.state = "ready";
    s.error = null;
    s.checkedAt = this.runtime.now();
    s.attempts = 0;
    s.nextRetryAt = null;
  }
  async probe(id) {
    const agents = this.agents(id),
      results = [];
    if (!agents.length) throw Error("BACKEND_NO_AGENTS");
    for (const a of agents) {
      const b = this.adapter(a);
      try {
        const health = b.health
          ? await b.health()
          : { models: await b.models() };
        if (!Array.isArray(health.models)) throw Error("BACKEND_PROBE_FAILED");
        results.push({
          id: a.id,
          state: "ready",
          error: null,
          modelCount: health.models.length,
          endpoint: health.endpoint || null,
        });
      } catch (error) {
        results.push({
          id: a.id,
          state: failureState(connectionError(error)),
          error: connectionError(error),
        });
      }
    }
    this.state(id).agents = results;
    const failed = results.find((x) => x.error);
    if (failed) throw Error(failed.error);
    this.succeeded(id);
    return this.snapshot(id);
  }
  single(id, key, fn) {
    const pending = this.operations.get(id);
    if (pending) {
      if (pending.key !== key) throw Error("BACKEND_OPERATION_IN_PROGRESS");
      return pending.promise;
    }
    const promise = Promise.resolve()
      .then(fn)
      .finally(() => {
        if (this.operations.get(id)?.promise === promise)
          this.operations.delete(id);
      });
    this.operations.set(id, { key, promise });
    return promise;
  }
  async check(id) {
    return this.single(id, "check", async () => {
      try {
        return await this.probe(id);
      } catch (error) {
        this.failed(id, error);
        return this.snapshot(id);
      }
    });
  }
  async recover(id, { candidateId, automatic = false } = {}) {
    return this.single(id, "recover:" + (candidateId || ""), async () => {
      const r = this.runtime,
        config = this.config(id),
        agents = this.agents(id),
        state = this.state(id);
      state.state = "recovering";
      state.error = null;
      let selected;
      try {
        if (!agents.length) throw Error("BACKEND_NO_AGENTS");
        if (config.type === "dsh")
          selected = selectDshInstance(
            config,
            await this.discover({ configuredUrl: config.baseUrl }),
            candidateId,
            { automatic },
          );
        else if (candidateId) throw Error("BACKEND_RECOVERY_FAILED");
        if (
          automatic &&
          (r.config.globalPaused ||
            r.closed ||
            agents.every((a) => r.agent(a.id).paused) ||
            [...r.capabilities.values()].some((ctx) =>
              agents.some((a) => a.id === ctx.agentId),
            ))
        ) {
          state.state = "disconnected";
          state.attempts = Math.max(0, state.attempts - 1);
          state.nextRetryAt = r.now() + 5000;
          return this.snapshot(id);
        }
        for (const a of agents) this.blocked.add(a.id);
        const contexts = [...r.capabilities.values()].filter((ctx) =>
          agents.some((a) => a.id === ctx.agentId),
        );
        await Promise.all(agents.map((a) => r.cancel(a.id)));
        await Promise.all(
          agents.map(async (a) => {
            const b = r.backends.get(a.id);
            await b?.close?.();
            if (r.backends.get(a.id) === b) r.backends.delete(a.id);
            const learner = r.learner.backends.get(a.id);
            await learner?.close?.();
            if (r.learner.backends.get(a.id) === learner)
              r.learner.backends.delete(a.id);
          }),
        );
        await Promise.all(contexts.map((ctx) => ctx.done));
        if (r.closed) throw Error("BACKEND_RECOVERY_FAILED");
        if (selected) {
          const next = structuredClone(r.config),
            target = next.backends.find((b) => b.id === id);
          target.recovery.dshInstance = selected.followsRestart
            ? selected.id
            : undefined;
          target.baseUrl = selected.followsRestart ? undefined : selected.url;
          r.configStore.save(next, r.configStore.revision);
        }
        const result = await this.probe(id);
        for (const a of agents)
          if (/^(BACKEND_|DSH_|CODEX_)/.test(r.faults.get(a.id) || ""))
            r.faults.delete(a.id);
        return result;
      } catch (error) {
        this.failed(id, error);
        return this.snapshot(id);
      } finally {
        for (const a of agents) this.blocked.delete(a.id);
      }
    });
  }
  async handle(input) {
    const args = request.parse(input),
      config = this.config(args.id),
      r = this.runtime;
    if (r.closed) throw Error("BACKEND_RECOVERY_FAILED");
    if (r.config.mode !== "live") throw Error("ISOLATED_MODE");
    if (args.action === "discover") {
      if (config.type !== "dsh") throw Error("DSH_BACKEND_REQUIRED");
      return {
        candidates: await this.discover({ configuredUrl: config.baseUrl }),
      };
    }
    if (args.action === "settings") {
      if (this.operations.has(args.id))
        throw Error("BACKEND_OPERATION_IN_PROGRESS");
      if (args.autoReconnect === undefined)
        throw Error("INVALID_BACKEND_SETTINGS");
      const next = structuredClone(r.config),
        target = next.backends.find((b) => b.id === args.id);
      target.recovery.autoReconnect = args.autoReconnect;
      r.configStore.save(next, r.configStore.revision);
      this.state(args.id).attempts = 0;
      this.state(args.id).nextRetryAt = null;
      return this.snapshot(args.id);
    }
    if (args.action === "recover") {
      this.state(args.id).attempts = 0;
      return this.recover(args.id, { candidateId: args.candidateId });
    }
    return this.check(args.id);
  }
  tick() {
    const r = this.runtime;
    if (r.closed || r.config.mode !== "live" || r.config.globalPaused) return;
    for (const config of r.config.backends) {
      if (
        !config.recovery?.autoReconnect ||
        this.operations.has(config.id) ||
        !this.agents(config.id).some((a) => !a.paused)
      )
        continue;
      const s = this.state(config.id),
        now = r.now();
      if (
        ["login-required", "selection-required"].includes(s.state) ||
        s.attempts >= 3
      )
        continue;
      if (["unchecked", "ready"].includes(s.state)) {
        if (s.checkedAt !== null && now - s.checkedAt < 30000) continue;
        r.trackJob(this.check(config.id), "backend:" + config.id);
      } else if (now >= (s.nextRetryAt || 0)) {
        // A live turn is never interrupted by the automatic health monitor.
        if (
          [...r.capabilities.values()].some((ctx) =>
            this.agents(config.id).some((a) => a.id === ctx.agentId),
          )
        )
          continue;
        s.attempts++;
        s.nextRetryAt = now + [5000, 15000, 30000][s.attempts - 1];
        r.trackJob(
          this.recover(config.id, { automatic: true }),
          "backend:" + config.id,
        );
      }
    }
  }
  async drain() {
    await Promise.allSettled(
      [...this.operations.values()].map((x) => x.promise),
    );
  }
}
