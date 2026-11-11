// @ts-check
import { closeSocialSessions } from "./social-sessions.mjs";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { runNativeSocial } from "./native-social.mjs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { NodeApiClient, unwrap } from "../../vendor/dsh-qq/dsh-client.js";
import { resolveDshInstance } from "./dsh-discovery.mjs";
import { ExternalTools } from "./external.mjs";
import {
  sessionSignature,
  assertSession,
  acceptsSession,
} from "./session-contract.mjs";
import {
  beforeSessionInput,
  sessionWasUnchanged,
  SessionUnavailableFailure,
} from "./turn-failure.mjs";
import { dshTurnFailure, BackendTurnFailure } from "./turn-failure.mjs";

/**
 * @typedef {import("./session-contract.mjs").BackendConfig} BackendConfig
 * @typedef {import("./session-contract.mjs").RunParams} RunParams
 * @typedef {import("./session-contract.mjs").StoredSession} StoredSession
 * @typedef {import("./session-contract.mjs").DisconnectHook} DisconnectHook
 */

function deferred() {
  /** @type {(value?: unknown) => void} */
  let resolve = () => {};
  /** @type {(reason?: unknown) => void} */
  let reject = () => {};
  const promise = new Promise((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}

/** @param {any} snapshot */
function dshInboxEmpty(snapshot) {
  const inbox = snapshot?.projections?.values?.inbox;
  return ["next-turn", "next-step"].every(
    (lane) => Array.isArray(inbox?.[lane]) && !inbox[lane].length,
  );
}

/** @param {any} snapshot */
function lastDshTurnEvent(snapshot) {
  return snapshot?.records?.findLast(
    (/** @type {any} */ r) =>
      r.event?.type === "turn/start" || r.event?.type === "turn/end",
  )?.event;
}

/** @param {any} event @param {string} text */
function dshInputMatches(event, text) {
  return (
    event?.type === "user/message" &&
    event.data.source?.kind === "user" &&
    event.data.content?.[0]?.type === "text" &&
    event.data.content[0].text === text
  );
}

/**
 * DSH's prompt receipt does not include a turn ID. If the subscription lost
 * turn/start, match the exact opening text (including the per-turn bridge
 * capability) within the new native turn instead of adopting a desktop turn.
 * @param {any} snapshot @param {string} text @param {Set<string>} previous
 */
function dshTurnForInput(snapshot, text, previous) {
  let current = null;
  for (const { event } of snapshot?.records || []) {
    if (event?.type === "turn/start") current = String(event.data.turn);
    if (event?.type === "turn/end") current = null;
    if (current && !previous.has(current) && dshInputMatches(event, text))
      return current;
  }
  return null;
}

/** @param {any} snapshot @param {BackendTurnFailure} failure */
export function dshRecoveryReady(snapshot, failure) {
  if (!dshInboxEmpty(snapshot)) return false;
  const last = lastDshTurnEvent(snapshot);
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
    this.config = { ...config, type: /** @type {const} */ ("dsh") };
    this.agent = agent;
    this.root = root;
    this.client = client;
    this.discover = discover;
    /** @type {(url: string) => boolean} */
    this.reservedEndpoint = () => false;
    this.external = new ExternalTools(config.toolServers);
    this.turns = new Map();
    this.capacities = new Map();
    this.functionalSessionUnverified = false;
    /** @type {AbortController | null} */
    this.streamAbort = null;
  }
  async ready() {
    if (this.client) {
      if (this.endpoint && this.reservedEndpoint(this.endpoint))
        throw Error("DSH_SELECTION_REQUIRED");
      return this.client;
    }
    if (!this.connecting)
      this.connecting = this.connectClient().finally(() => {
        this.connecting = null;
      });
    return this.connecting;
  }
  async connectClient() {
    const found = await this.discover(this.config, this.reservedEndpoint);
    const base = found.url;
    if (this.reservedEndpoint(base)) throw Error("DSH_SELECTION_REQUIRED");
    this.endpoint = base;
    this.client = new NodeApiClient(base, 30000, {});
    return this.client;
  }
  async models() {
    const c = await this.ready();
    let response;
    try {
      response = await c.callUnary("session.modelCatalog", {});
    } catch (e) {
      // The desktop app quit or moved: the remembered endpoint now fails as a
      // bare "fetch failed", which would otherwise leave as INTERNAL_ERROR.
      if (e instanceof TypeError)
        throw Error("DSH_INSTANCE_UNAVAILABLE", { cause: e });
      throw e;
    }
    return unwrap(response, "model catalog");
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
    const lifetime = new AbortController();
    this.streamAbort = lifetime;
    const { promise: ready, resolve, reject } = deferred();
    this.streamReady = ready;
    this.pump = (async () => {
      try {
        let retries = 0;
        for (;;) {
          if (retries) {
            await delay(250 * 2 ** (retries - 1), undefined, {
              signal: lifetime.signal,
            });
            if (!this.turns.size) break;
          }
          const started = performance.now();
          const connection = new AbortController();
          const timer = setTimeout(() => connection.abort(), 10000);
          try {
            await this.pumpEvents(
              client,
              AbortSignal.any([lifetime.signal, connection.signal]),
              () => {
                clearTimeout(timer);
                resolve();
              },
            );
          } catch {
            // A failed handshake is also a lost subscription.
          } finally {
            clearTimeout(timer);
          }
          if (lifetime.signal.aborted || !this.turns.size) break;
          if (
            performance.now() - started >= 10000 &&
            !connection.signal.aborted
          )
            retries = 0;
          if (++retries > 3) break;
          for (const t of this.turns.values()) {
            t.interrupted = true;
            if (t.promptPending) t.awaitEvidence();
          }
          // NodeApiClient retains desired follows and opens them on the
          // replacement socket. Keep the original client and native session IDs.
        }
      } catch (error) {
        if (!lifetime.signal.aborted) throw error;
      } finally {
        const error = Error("DSH_STREAM_ENDED");
        reject(error);
        for (const t of this.turns.values()) {
          if (t.promptPending) t.failReattachment();
          t.failFollow(error);
        }
        this.streamReady = null;
        this.client = null;
        if (!this.closing)
          /** @type {this & DisconnectHook} */ (this).onDisconnect?.(error);
      }
    })();
    return ready;
  }
  /** @param {NodeApiClient} client @param {AbortSignal} signal @param {() => void} open */
  async pumpEvents(client, signal, open) {
    for await (const frame of client.events.mux({}, signal, open)) {
      const p = frame.payload;
      const t = this.turns.get(p?.sessionId);
      if (!t) continue;
      if (p.type === "stream/error") {
        if (p.error?.code !== "session/not-found") return;
        const error = new SessionUnavailableFailure("DSH_SESSION_UNAVAILABLE");
        t.failFollow(error);
        if (t.promptPending) t.reject(error);
        continue;
      }
      if (p.type === "session/snapshot") {
        const capacity =
          p.snapshot?.projections?.values?.contextPressure?.contextWindow;
        if (Number.isFinite(capacity) && capacity > 0)
          this.capacities.set(p.sessionId, capacity);
        t.followed(p.snapshot);
        if (!t.promptPending) continue;
        const last = lastDshTurnEvent(p.snapshot);
        const open =
          last?.type === "turn/start" ? String(last.data.turn) : null;
        t.observedTurn = open && !t.previousTurns.has(open) ? open : null;
        if (!t.turn || !t.inputSubmitted) {
          const inputTurn = dshTurnForInput(
            p.snapshot,
            t.inputText,
            t.previousTurns,
          );
          if (!t.turn) t.bindTurn(inputTurn);
          if (inputTurn && t.turn === inputTurn) t.submitInput();
        }
        if (!t.turn) continue;
        const terminal = p.snapshot?.records?.find(
          (/** @type {any} */ { event }) =>
            event?.type === "turn/end" && String(event.data.turn) === t.turn,
        )?.event;
        // A snapshot can also be the result of reopening just this follow.
        // Only matching native evidence proves that the active turn reattached.
        if (terminal || t.observedTurn === t.turn) {
          t.interrupted = true;
          if (terminal) t.finish(terminal);
          else t.reattached();
        }
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
      if (!t.promptPending) continue;
      if (e.type === "turn/start") {
        const id = String(e.data.turn);
        t.observedTurn = t.previousTurns.has(id) ? null : id;
        if (!t.turn && !t.interrupted) t.bindTurn(t.observedTurn);
      }
      if (t.observedTurn && dshInputMatches(e, t.inputText)) {
        if (!t.turn) t.bindTurn(t.observedTurn);
        if (t.turn === t.observedTurn) {
          t.submitInput();
          t.reattached();
        }
      }
      if (e.type === "turn/end") {
        const id = String(e.data.turn);
        if (t.observedTurn === id) t.observedTurn = null;
        if (t.turn === id) t.finish(e);
      }
    }
  }
  /**
   * @param {import("./session-contract.mjs").ToolSpec[]} tools
   * @param {import("./session-contract.mjs").ModelSelection} [modelSelection]
   */
  sessionSignature(tools, modelSelection) {
    return sessionSignature(
      modelSelection ? { config: { ...this.config, ...modelSelection } } : this,
      tools,
    );
  }
  /** @param {StoredSession | null | undefined} session @param {import("./session-contract.mjs").ToolSpec[]} tools @param {import("./session-contract.mjs").SessionContract} [previous] */
  acceptsSession(session, tools, previous) {
    return acceptsSession(this, session, tools, previous);
  }
  /** @param {{windowId?: string, actorGeneration?: string}} [filter] */
  async closeSocialSessions(filter = {}) {
    await closeSocialSessions(this, filter);
  }
  /** @param {any} params */
  async runSocial(params) {
    return this.runIsolated(params, "social");
  }
  /** @param {any} params */
  async runDesktop(params) {
    return this.runIsolated(params, "desktop");
  }
  /** @param {any} params @param {"social" | "desktop"} surface */
  async runIsolated(params, surface) {
    if (
      this.config.preset !== "qq-unified" ||
      typeof params.socialContextToken !== "string" ||
      params.socialContextToken.length < 20
    )
      throw Error("SOCIAL_BACKEND_UNSUPPORTED");
    return runNativeSocial(
      this,
      {
        ...params,
        prompt: `${params.prompt}\n本轮唯一有效的能力凭据 context=${params.socialContextToken}。历史中的context均已失效；只复制本轮这一个值用于bridge_tools/bridge_call外层，不得披露。`,
      },
      async (session) => {
        if (!session) return;
        try {
          const client = await this.ready();
          await client.stopSessionWork(session.id);
        } catch {
          throw Error("SOCIAL_CONTEXT_FINALIZATION_FAILED");
        }
      },
      surface,
    );
  }
  /**
   * @param {NodeApiClient} client
   * @param {string} sessionId
   * @param {Promise<unknown> | undefined} submission
   * @param {{terminalObserved: boolean, promptPending: boolean,
   *   followed: (snapshot: unknown) => void, followError: (error: unknown) => void}} active
   */
  async stopFunctionalSession(client, sessionId, submission, active) {
    try {
      // Do not drain before a pending submission has returned its receipt.
      // Cancellation of the HTTP wait does not cancel the host's admission.
      const receiptObserved = await submission?.then(
        () => true,
        () => false,
      );
      await client.stopSessionWork(sessionId);
      if (!submission || active.terminalObserved) return;
      // The cancel RPC acknowledges the request, not the host's quiescence.
      // Re-follow after queue cleanup to verify that this session is idle.
      active.promptPending = false;
      const signal = AbortSignal.timeout(4000);
      for (;;) {
        signal.throwIfAborted();
        const { promise, resolve, reject } = deferred();
        active.followed = resolve;
        active.followError = reject;
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        let snapshot;
        try {
          client.events.forget?.(sessionId);
          client.events.follow(sessionId);
          snapshot = await promise;
        } finally {
          signal.removeEventListener("abort", abort);
        }
        if (
          dshInboxEmpty(snapshot) &&
          Array.isArray(/** @type {any} */ (snapshot)?.records) &&
          lastDshTurnEvent(snapshot)?.type !== "turn/start"
        ) {
          // An idle snapshot cannot prove that a request whose receipt was
          // lost will never reach this session.
          if (!receiptObserved) throw Error("DSH_RECOVERY_STATE_UNVERIFIED");
          return;
        }
        await delay(100, undefined, { signal });
      }
    } catch (cause) {
      if (submission) this.functionalSessionUnverified = true;
      throw Error("FUNCTIONAL_AGENT_BACKEND_UNAVAILABLE", { cause });
    }
  }
  /** @param {RunParams} params */
  async run({
    conversation,
    prompt,
    inputImages = [],
    instructions,
    onUsage,
    signal,
    tools,
    modelSelection,
    effort,
    session,
    saveSession,
    onBackendTurn,
    onInputSubmitted,
    beforeInputSubmitted,
    appendPrompt,
    recovery,
  }) {
    // Capture the requested selection before any await. It applies only to
    // this invocation's newly created native session.
    const selection = modelSelection && { ...modelSelection };
    if (Boolean(selection) !== (this.config.functionalAgentOnly === true))
      throw Error("FUNCTIONAL_AGENT_BACKEND_UNSUPPORTED");
    if (selection) {
      if (
        this.config.preset !== "qq-unified" ||
        !selection.provider ||
        !selection.model
      )
        throw Error("FUNCTIONAL_AGENT_BACKEND_UNSUPPORTED");
      if (session || recovery) throw Error("SESSION_REQUIRES_HANDOFF");
      if (signal.aborted) throw Error("ABORTED");
    }
    const signature = this.sessionSignature(tools, selection);
    assertSession(session, "dsh", signature);
    const client = await beforeSessionInput(session, async () => {
      const connected = await this.ready();
      await this.stream();
      return connected;
    });
    if (signal.aborted) throw Error("ABORTED");
    // The SDK brands session ids; this holds the raw id it handed out.
    /** @type {any} */
    let sessionId = session?.id;
    const initializing = !sessionId;
    if (!sessionId) {
      const presets = unwrap(
        await client.agentPresets.list({}, selection ? signal : undefined),
        "presets",
      );
      const list = presets.presets || presets.items || [];
      const preset = list.find(
        (/** @type {any} */ p) => (p.id || p.name) === this.config.preset,
      );
      if (!preset) throw Error("DSH_UNIFIED_PRESET_NOT_INSTALLED");
      if (preset.broken) throw Error("DSH_UNIFIED_PRESET_BROKEN");
      const dir = path.join(
        /** @type {string} */ (this.root),
        selection ? "dsh-functional-workspaces" : "dsh-workspaces",
        this.agent.id,
      );
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const w = unwrap(
        await client.workspace.create(
          { path: dir },
          selection ? signal : undefined,
        ),
        "workspace",
      );
      // Keep the create receipt even on abort: it names the session to clean up.
      if (selection && signal.aborted) throw Error("ABORTED");
      sessionId = unwrap(
        await client.sessions.create({
          workspaceId: w.workspace.workspaceId,
          agentPreset: this.config.preset,
          // Name an invocation-owned session rather than adopting a blank
          // desktop session that might already exist in this workspace.
          ...(selection
            ? { sessionId: /** @type {any} */ ("session-" + randomUUID()) }
            : {}),
        }),
        "session",
      ).sessionId;
      if (!selection) saveSession({ backend: "dsh", id: sessionId, signature });
    }
    const { promise: done, resolve, reject } = deferred();
    const {
      promise: followReady,
      resolve: followed,
      reject: followError,
    } = deferred();
    done.catch(() => {});
    followReady.catch(() => {});
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let reconnectTimer;
    /** @type {Promise<unknown> | undefined} */
    let pendingSubmission;
    const unverified = new BackendTurnFailure(
      "dsh",
      "RECOVERY_STATE_UNVERIFIED",
      "event-stream",
      "",
    );
    // Retain the reference and require a verified idle snapshot on the next
    // wake. This does not make the interrupted prompt eligible for replay.
    unverified.sessionReusable = true;
    const active = {
      interrupted: false,
      /** @type {Error | undefined} */
      followFailure: undefined,
      failFollow: (/** @type {Error} */ error) => {
        active.followFailure = error;
        active.followError(error);
      },
      promptPending: false,
      terminalObserved: false,
      inputSubmitted: false,
      previousTurns: new Set(),
      submitInput: () => {
        if (
          active.inputSubmitted ||
          signal.aborted ||
          this.turns.get(sessionId) !== active
        )
          return;
        active.inputSubmitted = true;
        if (session?.dshStreamUnverified)
          saveSession({ backend: "dsh", id: sessionId, signature });
        onInputSubmitted?.();
      },
      failReattachment: () => reject(unverified),
      awaitEvidence: () => {
        if (this.turns.get(sessionId) === active)
          reconnectTimer ??= setTimeout(active.failReattachment, 10000);
      },
      reattached: () => {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      },
      finish: (/** @type {any} */ event) => {
        active.terminalObserved = true;
        active.reattached();
        active.submitInput();
        if (["completed", "done", "stop"].includes(event.data.reason?.kind))
          resolve();
        else reject(dshTurnFailure(event.data.reason, event.data.turn));
      },
      resolve,
      reject,
      /** @type {string | null} */
      turn: null,
      /** @type {string | null} */
      observedTurn: null,
      inputText:
        initializing && instructions ? instructions + "\n\n" + prompt : prompt,
      bindTurn: (/** @type {string | null} */ id) => {
        if (!id) return;
        active.turn = id;
        onBackendTurn?.({ turnId: id });
      },
      followed,
      followError,
      onUsage,
      abort: () => {
        if (active.promptPending && !selection)
          void client
            .callUnary("session.cancel", { sessionId })
            .catch(() => {});
        active.failFollow(Error("ABORTED"));
        reject(Error("ABORTED"));
      },
    };
    this.turns.set(sessionId, active);
    signal.addEventListener("abort", active.abort, { once: true });
    const followTimer = setTimeout(
      () => followError(Error("DSH_FOLLOW_TIMEOUT")),
      10000,
    );
    try {
      if (signal.aborted) throw Error("ABORTED");
      const snapshot = await beforeSessionInput(session, async () => {
        client.events.follow(sessionId);
        const current = await followReady;
        if (
          session?.dshStreamUnverified &&
          (!dshInboxEmpty(current) ||
            lastDshTurnEvent(current)?.type !== "turn/end")
        )
          throw Error("DSH_RECOVERY_STATE_UNVERIFIED");
        return current;
      });
      clearTimeout(followTimer);
      if (signal.aborted) throw Error("ABORTED");
      if (recovery && !dshRecoveryReady(snapshot, recovery))
        throw Error("DSH_RECOVERY_STATE_UNVERIFIED");
      const chosen = selection || this.config;
      if (chosen.model)
        await beforeSessionInput(session, async () => {
          const result = await client.sessions.selectModel(
            {
              sessionId,
              // Omitted when unset, although the SDK type asks for a string.
              provider: /** @type {string} */ (chosen.provider || undefined),
              model: chosen.model,
              reasoningEffort: selection
                ? chosen.effort || undefined
                : (effort ?? chosen.effort),
            },
            selection ? signal : undefined,
          );
          if (selection) {
            const selected = result.result.ok && result.result.value?.selected;
            if (
              !selected ||
              selected.provider !== selection.provider ||
              selected.model !== selection.model ||
              (selection.effort &&
                selected.reasoningEffort !== selection.effort)
            )
              throw Error("BACKEND_MODEL_UNAVAILABLE");
            return;
          }
          if (
            !result.result.ok &&
            ["session/not-found", "session-not-found"].includes(
              result.result.error.code,
            )
          )
            throw new SessionUnavailableFailure("DSH_SESSION_UNAVAILABLE");
          const model = unwrap(result, "model");
          if (effort && model.selected?.reasoningEffort !== effort)
            throw Error("BACKEND_MODEL_UNAVAILABLE");
        });
      await beforeInputSubmitted?.();
      if (signal.aborted) throw Error("ABORTED");
      await beforeSessionInput(session, async () => {
        if (active.followFailure) throw active.followFailure;
      });
      for (const record of /** @type {any} */ (snapshot)?.records || [])
        if (record.event?.data?.turn !== undefined)
          active.previousTurns.add(String(record.event.data.turn));
      if (appendPrompt) active.inputText += appendPrompt();
      active.promptPending = true;
      const submission = client.sessions.prompt(
        {
          sessionId,
          mode: "queue",
          content: [
            {
              type: "text",
              text: active.inputText,
            },
            ...inputImages.flatMap((image) => [
              { type: /** @type {const} */ ("text"), text: image.label },
              ...(image.data
                ? [
                    {
                      type: /** @type {const} */ ("image"),
                      mediaType: /** @type {"image/jpeg"} */ (image.mimeType),
                      data: image.data,
                    },
                  ]
                : []),
            ]),
          ],
        },
        selection ? undefined : signal,
      );
      if (selection) pendingSubmission = submission;
      await Promise.race([
        submission.then(
          (response) => {
            unwrap(response, "prompt");
            active.submitInput();
            return done;
          },
          () => {
            // HTTP may lose the receipt before the socket reports its loss.
            // Only the native terminal can resolve an ambiguous submission.
            if (!active.turn) active.awaitEvidence();
            return done;
          },
        ),
        done.then(() => active.submitInput()),
      ]);
      return { streamReattached: active.interrupted };
    } catch (/** @type {any} */ e) {
      if (selection) throw e;
      if (
        !signal.aborted &&
        (e === unverified ||
          (active.interrupted && e instanceof BackendTurnFailure))
      ) {
        // A confirmed terminal failure after reattachment still belongs to
        // this native session. Inspect idle state before the next normal wake.
        e.recoverable = false;
        e.sessionReusable = true;
        saveSession({
          backend: "dsh",
          id: sessionId,
          signature,
          dshStreamUnverified: true,
        });
      }
      if (!signal.aborted && e instanceof BackendTurnFailure && e.recoverable) {
        // A fresh native snapshot must still end at this exact failed turn and
        // have no queued input. A stream error alone is never replay evidence.
        let timer;
        try {
          const snapshot = await new Promise((r, j) => {
            timer = setTimeout(() => j(Error("DSH_FOLLOW_TIMEOUT")), 10000);
            active.followed = r;
            active.followError = j;
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
      if ((!e.sessionReusable && !sessionWasUnchanged(e)) || signal.aborted)
        saveSession(null);
      throw e;
    } finally {
      clearTimeout(followTimer);
      active.reattached();
      signal.removeEventListener("abort", active.abort);
      try {
        if (selection)
          await this.stopFunctionalSession(
            client,
            sessionId,
            pendingSubmission,
            active,
          );
      } finally {
        this.turns.delete(sessionId);
        client.events.forget?.(sessionId);
        if (selection) this.capacities.delete(sessionId);
      }
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
    for (const t of this.turns.values()) t.abort();
  }
  async close() {
    this.closing = true;
    await this.cancel();
    await this.closeSocialSessions();
    this.streamAbort?.abort();
    await this.pump;
    await this.external.close();
  }
}
