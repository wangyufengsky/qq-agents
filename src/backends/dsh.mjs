// @ts-check
import fs from "node:fs";
import path from "node:path";
import { NodeApiClient, unwrap } from "../../vendor/dsh-qq/dsh-client.js";
import { resolveDshInstance } from "./dsh-discovery.mjs";
import { ExternalTools } from "./external.mjs";
import { sessionSignature, assertSession } from "./session-contract.mjs";
import { dshTurnFailure, BackendTurnFailure } from "./turn-failure.mjs";

/**
 * @typedef {import("./session-contract.mjs").BackendConfig} BackendConfig
 * @typedef {import("./session-contract.mjs").RunParams} RunParams
 * @typedef {import("./session-contract.mjs").StoredSession} StoredSession
 * @typedef {import("./session-contract.mjs").DisconnectHook} DisconnectHook
 */

/** @param {any} snapshot @param {BackendTurnFailure} failure */
export function dshRecoveryReady(snapshot, failure) {
  const inbox = snapshot?.projections?.values?.inbox;
  if (
    !Array.isArray(inbox?.["next-turn"]) ||
    !Array.isArray(inbox?.["next-step"]) ||
    inbox["next-turn"].length ||
    inbox["next-step"].length
  )
    return false;
  const last = snapshot.records
    ?.map((/** @type {any} */ r) => r.event)
    .filter(
      (/** @type {any} */ e) =>
        e?.type === "turn/start" || e?.type === "turn/end",
    )
    .at(-1);
  return (
    last?.type === "turn/end" &&
    String(last.data?.turn) === failure.turnId &&
    last.data?.reason?.kind === "error" &&
    last.data.reason.error?.code === failure.code
  );
}

export class DshBackend {
  /**
   * @param {BackendConfig} config
   * @param {import("./session-contract.mjs").BackendAgent} agent
   * @param {{root?: string, client?: NodeApiClient | null, discover?: typeof resolveDshInstance}} [options]
   */
  constructor(
    config,
    agent,
    { root, client, discover = resolveDshInstance } = {},
  ) {
    this.config = config;
    this.agent = agent;
    this.root = root;
    this.client = client;
    this.discover = discover;
    this.external = new ExternalTools(config.toolServers);
    this.turns = new Map();
    this.capacities = new Map();
    /** @type {AbortController | null} */
    this.streamAbort = null;
  }
  async ready() {
    if (this.client) return this.client;
    if (!this.connecting)
      this.connecting = this.connectClient().finally(() => {
        this.connecting = null;
      });
    return this.connecting;
  }
  async connectClient() {
    const found = await this.discover(this.config);
    const base = found.url;
    this.endpoint = base;
    this.client = new NodeApiClient(base, 30000, {});
    return this.client;
  }
  async models() {
    const c = await this.ready();
    return unwrap(
      await c.callUnary("session.modelCatalog", {}),
      "model catalog",
    );
  }
  async health() {
    const catalog = await this.models();
    const groups = catalog.groups?.filter(
      (/** @type {any} */ g) =>
        !this.config.provider || g.id === this.config.provider,
    );
    const models = groups?.flatMap((/** @type {any} */ g) => g.models);
    if (
      !models?.length ||
      (this.config.model &&
        !models.some((/** @type {any} */ m) => m.id === this.config.model))
    )
      throw Error("BACKEND_MODEL_UNAVAILABLE");
    return { models, endpoint: this.endpoint || null };
  }
  async stream() {
    if (this.streamReady) return this.streamReady;
    const client = this.client;
    if (!client) throw Error("DSH_NOT_READY");
    this.streamAbort = new AbortController();
    /** @type {(value?: unknown) => void} */
    let resolve = /** @type {any} */ (undefined);
    /** @type {(reason?: unknown) => void} */
    let reject = /** @type {any} */ (undefined);
    this.streamReady = new Promise((r, j) => {
      resolve = r;
      reject = j;
    });
    this.pump = (async () => {
      try {
        for await (const frame of client.events.mux(
          {},
          /** @type {AbortController} */ (this.streamAbort).signal,
          resolve,
        )) {
          const p = frame.payload;
          const t = this.turns.get(p?.sessionId);
          if (!t) continue;
          if (p.type === "session/snapshot") {
            const capacity =
              p.snapshot?.projections?.values?.contextPressure?.contextWindow;
            if (Number.isFinite(capacity) && capacity > 0)
              this.capacities.set(p.sessionId, capacity);
            t.followed?.(p.snapshot);
            continue;
          }
          if (p.type !== "session/event") continue;
          const e = p.event;
          if (
            e.type === "request/context" &&
            Number.isFinite(e.data?.contextWindow) &&
            e.data.contextWindow > 0
          )
            this.capacities.set(p.sessionId, e.data.contextWindow);
          if (e.type === "assistant/message" && e.data?.usage) {
            const u = e.data.usage;
            t.onUsage?.({
              source: "measured",
              contextTokens:
                u.inputTokens +
                (u.cacheReadTokens || 0) +
                (u.cacheWriteTokens || 0) +
                u.outputTokens,
              capacityTokens: this.capacities.get(p.sessionId),
              basis:
                "last provider request including disjoint cache counts and output",
            });
          }
          if (e.type === "turn/start") {
            t.turn = e.data.turn;
            t.onBackendTurn?.({ turnId: String(e.data.turn) });
          }
          if (e.type === "turn/end" && e.data.turn === t.turn) {
            if (["completed", "done", "stop"].includes(e.data.reason?.kind))
              t.resolve();
            else t.reject(dshTurnFailure(e.data.reason, e.data.turn));
          }
        }
      } catch {
        reject(Error("DSH_STREAM_FAILED"));
      } finally {
        for (const t of this.turns.values())
          t.reject(Error("DSH_STREAM_ENDED"));
        this.streamReady = null;
        this.client = null;
        if (!this.closing)
          /** @type {this & DisconnectHook} */ (this).onDisconnect?.(
            Error("DSH_STREAM_ENDED"),
          );
      }
    })();
    const timeout = setTimeout(() => {
      reject(Error("DSH_STREAM_TIMEOUT"));
      /** @type {AbortController} */ (this.streamAbort).abort();
    }, 10000);
    try {
      await this.streamReady;
    } finally {
      clearTimeout(timeout);
    }
  }
  /** @param {import("./session-contract.mjs").ToolSpec[]} tools */
  sessionSignature(tools) {
    return sessionSignature(this, tools);
  }
  /** @param {RunParams} params */
  async run({
    conversation,
    prompt,
    instructions,
    onUsage,
    signal,
    tools,
    session,
    saveSession,
    onBackendTurn,
    recovery,
  }) {
    const signature = this.sessionSignature(tools);
    assertSession(session, "dsh", signature);
    const client = await this.ready();
    await this.stream();
    if (signal.aborted) throw Error("ABORTED");
    // The SDK brands session ids; this holds the raw id it handed out.
    /** @type {any} */
    let sessionId = session?.id;
    const initializing = !sessionId;
    if (!sessionId) {
      const presets = unwrap(await client.agentPresets.list({}), "presets");
      const list = presets.presets || presets.items || [];
      const preset = list.find(
        (/** @type {any} */ p) => (p.id || p.name) === this.config.preset,
      );
      if (!preset) throw Error("DSH_UNIFIED_PRESET_NOT_INSTALLED");
      if (preset.broken) throw Error("DSH_UNIFIED_PRESET_BROKEN");
      const dir = path.join(
        /** @type {string} */ (this.root),
        "dsh-workspaces",
        this.agent.id,
      );
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const w = unwrap(
        await client.workspace.create({ path: dir }),
        "workspace",
      );
      sessionId = unwrap(
        await client.sessions.create({
          workspaceId: w.workspace.workspaceId,
          agentPreset: this.config.preset,
        }),
        "session",
      ).sessionId;
      saveSession({ backend: "dsh", id: sessionId, signature });
    }
    if (this.config.model)
      unwrap(
        await client.sessions.selectModel({
          sessionId,
          // Omitted when unset, although the SDK type asks for a string.
          provider: /** @type {string} */ (this.config.provider || undefined),
          model: this.config.model,
          reasoningEffort: this.config.effort,
        }),
        "model",
      );
    /** @type {(value?: unknown) => void} */
    let resolve = /** @type {any} */ (undefined);
    /** @type {(reason?: unknown) => void} */
    let reject = /** @type {any} */ (undefined);
    /** @type {(snapshot: unknown) => void} */
    let followed = /** @type {any} */ (undefined);
    /** @type {(reason?: unknown) => void} */
    let followError = /** @type {any} */ (undefined);
    const done = new Promise((r, j) => {
      resolve = r;
      reject = j;
    });
    done.catch(() => {});
    const followReady = new Promise((r, j) => {
      followed = r;
      followError = j;
    });
    followReady.catch(() => {});
    this.turns.set(sessionId, {
      resolve,
      reject,
      turn: null,
      followed,
      onUsage,
      onBackendTurn,
    });
    const abort = () => {
      void client.callUnary("session.cancel", { sessionId }).catch(() => {});
      followError(Error("ABORTED"));
      reject(Error("ABORTED"));
    };
    signal.addEventListener("abort", abort, { once: true });
    const followTimer = setTimeout(
      () => followError(Error("DSH_FOLLOW_TIMEOUT")),
      10000,
    );
    try {
      if (signal.aborted) throw Error("ABORTED");
      client.events.follow(sessionId);
      const snapshot = await followReady;
      clearTimeout(followTimer);
      if (signal.aborted) throw Error("ABORTED");
      if (recovery && !dshRecoveryReady(snapshot, recovery))
        throw Error("DSH_RECOVERY_STATE_UNVERIFIED");
      unwrap(
        await client.sessions.prompt({
          sessionId,
          mode: "queue",
          content: [
            {
              type: "text",
              text:
                initializing && instructions
                  ? instructions + "\n\n" + prompt
                  : prompt,
            },
          ],
        }),
        "prompt",
      );
      await done;
    } catch (/** @type {any} */ e) {
      if (!signal.aborted && e instanceof BackendTurnFailure && e.recoverable) {
        // A fresh native snapshot must still end at this exact failed turn and
        // have no queued input. A stream error alone is never replay evidence.
        let timer;
        try {
          const snapshot = await new Promise((r, j) => {
            timer = setTimeout(() => j(Error("DSH_FOLLOW_TIMEOUT")), 10000);
            followed = r;
            followError = j;
            this.turns.get(sessionId).followed = r;
            client.events.forget?.(sessionId);
            client.events.follow(sessionId);
          });
          e.sessionReusable = !signal.aborted && dshRecoveryReady(snapshot, e);
        } catch {
          e.sessionReusable = false;
        } finally {
          clearTimeout(timer);
        }
      }
      if (!e.sessionReusable || signal.aborted) saveSession(null);
      throw e;
    } finally {
      clearTimeout(followTimer);
      signal.removeEventListener("abort", abort);
      this.turns.delete(sessionId);
      client.events.forget?.(sessionId);
    }
  }
  /** @param {{session: StoredSession, signal: AbortSignal}} params */
  async compact({ session, signal }) {
    const client = await this.ready();
    if (signal.aborted) throw Error("ABORTED");
    const result = unwrap(
      await client.commands.execute(session.id, "/compact", signal),
      "compact",
    );
    if (result?.result?.kind !== "success")
      throw Error("DSH_COMPACTION_UNSUPPORTED_OR_FAILED");
    const projection = unwrap(
      await client.callUnary(
        "session/projections",
        { sessionId: session.id },
        signal,
      ),
      "projection",
    );
    const p = projection?.values?.contextPressure;
    return {
      // Dynamic self is in the initial user envelope on this protocol; do not assume
      // the native summarizer preserves it. A safe new session loads it in full.
      requiresReinitialize: Number.isSafeInteger(result.result.sourceEventSeq),
      compacted: Number.isSafeInteger(result.result.sourceEventSeq),
      sourceEventSeq: result.result.sourceEventSeq,
      usage: Number.isFinite(p?.projectedTokens)
        ? {
            source: "estimated",
            contextTokens: p.projectedTokens,
            capacityTokens: p.contextWindow,
            basis:
              "DSH contextPressure.projectedTokens; replay estimate with provider anchor",
          }
        : undefined,
    };
  }
  async cancel() {
    for (const [sessionId, t] of this.turns) {
      void this.client
        ?.callUnary("session.cancel", { sessionId })
        .catch(() => {});
      t.reject(Error("ABORTED"));
    }
  }
  async close() {
    this.closing = true;
    await this.cancel();
    this.streamAbort?.abort();
    await this.pump;
    await this.external.close();
  }
}
