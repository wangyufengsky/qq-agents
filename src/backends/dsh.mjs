import fs from "node:fs";
import path from "node:path";
import { NodeApiClient, unwrap } from "../../vendor/dsh-qq/dsh-client.js";
import {
  resolveDshBaseUrl,
  looksLikeDsh,
  listDesktopListenPorts,
} from "../../vendor/dsh-qq/dsh-endpoint.mjs";
import { ExternalTools } from "./external.mjs";
import { sessionSignature, assertSession } from "./session-contract.mjs";

export class DshBackend {
  constructor(
    config,
    agent,
    { root, client, discover = resolveDshBaseUrl } = {},
  ) {
    Object.assign(this, { config, agent, root, client, discover });
    this.external = new ExternalTools(config.toolServers);
    this.turns = new Map();
    this.capacities = new Map();
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
    const found = await this.discover(this.config.baseUrl);
    if (!found.reachable) throw Error("DSH_NOT_FOUND");
    // TCP-open alone is insufficient: a reused port may belong to an unrelated local service.
    let base = found.url;
    if (!(await looksLikeDsh(base))) {
      if (this.config.baseUrl) throw Error("NOT_DSH_ENDPOINT");
      base = null;
      for (const p of await listDesktopListenPorts()) {
        const u = `http://127.0.0.1:${p}`;
        if (await looksLikeDsh(u)) {
          base = u;
          break;
        }
      }
      if (!base) throw Error("DSH_NOT_FOUND");
    }
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
  async stream() {
    if (this.streamReady) return this.streamReady;
    const client = this.client;
    if (!client) throw Error("DSH_NOT_READY");
    this.streamAbort = new AbortController();
    let resolve, reject;
    this.streamReady = new Promise((r, j) => {
      resolve = r;
      reject = j;
    });
    this.pump = (async () => {
      try {
        for await (const frame of client.events.mux(
          {},
          this.streamAbort.signal,
          resolve,
        )) {
          const p = frame.payload;
          const t = this.turns.get(p?.sessionId);
          if (!t) continue;
          if (p.type === "session/snapshot") {
            t.followed?.();
            continue;
          }
          if (p.type !== "session/event") continue;
          const e = p.event;
          if (e.type === "request/context" && e.data?.contextWindow)
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
            else t.reject(Error("DSH_TURN_FAILED"));
          }
        }
      } catch {
        reject(Error("DSH_STREAM_FAILED"));
      } finally {
        for (const t of this.turns.values())
          t.reject(Error("DSH_STREAM_ENDED"));
        this.streamReady = null;
        this.client = null;
      }
    })();
    const timeout = setTimeout(() => {
      reject(Error("DSH_STREAM_TIMEOUT"));
      this.streamAbort.abort();
    }, 10000);
    try {
      await this.streamReady;
    } finally {
      clearTimeout(timeout);
    }
  }
  sessionSignature(tools) {
    return sessionSignature(this, tools);
  }
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
  }) {
    const signature = this.sessionSignature(tools);
    assertSession(session, "dsh", signature);
    const client = await this.ready();
    await this.stream();
    if (signal.aborted) throw Error("ABORTED");
    let sessionId = session?.id;
    const initializing = !sessionId;
    if (!sessionId) {
      const presets = unwrap(await client.agentPresets.list({}), "presets");
      const list = presets.presets || presets.items || [];
      const preset = list.find((p) => (p.id || p.name) === this.config.preset);
      if (!preset) throw Error("DSH_UNIFIED_PRESET_NOT_INSTALLED");
      if (preset.broken) throw Error("DSH_UNIFIED_PRESET_BROKEN");
      const dir = path.join(this.root, "dsh-workspaces", this.agent.id);
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
          provider: this.config.provider || undefined,
          model: this.config.model,
          reasoningEffort: this.config.effort,
        }),
        "model",
      );
    let resolve, reject, followed, followError;
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
      await followReady;
      clearTimeout(followTimer);
      if (signal.aborted) throw Error("ABORTED");
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
    } catch (e) {
      saveSession(null);
      throw e;
    } finally {
      clearTimeout(followTimer);
      signal.removeEventListener("abort", abort);
      this.turns.delete(sessionId);
      client.events.forget?.(sessionId);
    }
  }
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
    await this.cancel();
    this.streamAbort?.abort();
    await this.pump;
    await this.external.close();
  }
}
