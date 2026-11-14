// @ts-check
import { closeSocialSessions } from "./social-sessions.mjs";
import fs from "node:fs";
import { runNativeSocial } from "./native-social.mjs";
import {
  codexTurnFailure,
  BackendTurnFailure,
  beforeSessionInput,
  sessionWasUnchanged,
  SessionUnavailableFailure,
} from "./turn-failure.mjs";
import path from "node:path";
import { CodexRpc } from "../../vendor/local-bridge/codex-rpc.mjs";
import { ExternalTools } from "./external.mjs";
import { videoDelivery, videoResponseGuide } from "../video/policy.mjs";
import { mediaLease } from "../tools/media-lease.mjs";
import { mcpResult } from "../tools/index.mjs";
import { safeToolFailure } from "../tools/errors.mjs";
import { DESKTOP_SCREEN_VIEW } from "../tools/names.mjs";
import {
  sessionSignature,
  assertSession,
  acceptsSession,
} from "./session-contract.mjs";
import { readGeneratedImage } from "./generated-image-file.mjs";
import { buildChildEnv } from "../core/child-env.mjs";
import { taskkillTree } from "../core/windows-process.mjs";
import crossSpawn from "cross-spawn";

const MAX_TOOL_RESPONSE_BYTES = 65536;
const desktopVisualNamespace = "qq_desktop_visual";

/** @param {import("./session-contract.mjs").ToolSpec[]} tools */
function hasDesktopScreen(tools) {
  return tools.some(({ name }) => name === DESKTOP_SCREEN_VIEW);
}

/** @param {number|string} id @param {ReturnType<typeof mcpResult>} result */
function codexToolOutput(id, result) {
  const contentItems = result.content.flatMap((/** @type {any} */ c) =>
    c.type === "text"
      ? [{ type: "inputText", text: c.text }]
      : c.type === "image"
        ? [
            {
              type: "inputImage",
              imageUrl: `data:${c.mimeType};base64,${c.data}`,
            },
          ]
        : c.type === "audio"
          ? [
              {
                type: "inputText",
                text: "音频已读取并登记，但此 Codex 动态工具通道未提供音频输入；没有转录，不得声称听懂语音内容。",
              },
            ]
          : [],
  );
  return {
    wire: { id, result: { success: !result.isError, contentItems } },
    text: codexToolText(contentItems),
  };
}

/** @param {any[]} items */
function codexToolText(items) {
  return items[0]?.type === "inputText" ? items[0].text : undefined;
}

/** @param {unknown} value */
function codexToolError(value) {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(value) }],
  };
}

/**
 * Windows launcher for Codex. cross-spawn starts `codex.cmd` through cmd.exe,
 * so the child is that wrapper and kill() would leave the app-server running
 * against the same dedicated home. kill() ends the whole tree instead, and
 * synchronously, so a replacement backend never overlaps the old process.
 * @param {{ spawn?: typeof crossSpawn, killTree?: (pid: number) => void }} [deps]
 */
export function windowsCodexSpawn({
  spawn = crossSpawn,
  killTree = taskkillTree,
} = {}) {
  return (
    /** @type {string} */ command,
    /** @type {string[]} */ args,
    /** @type {any} */ options,
  ) => {
    const child = spawn(command, args, options);
    const kill = child.kill.bind(child);
    child.kill = (signal) => {
      if (child.pid && child.exitCode === null && child.signalCode === null)
        try {
          killTree(child.pid);
          return true;
        } catch {
          // taskkill missing or refused: fall back to ending the wrapper.
        }
      return kill(signal);
    };
    return child;
  };
}

export const restrictions = {
  "features.shell_tool": false,
  "features.unified_exec": false,
  "features.multi_agent": false,
  "features.plugins": false,
  "features.memories": false,
  "features.skill_search": false,
  "features.js_repl": false,
  "features.code_mode": false,
  "tools.view_image": false,
  web_search: "disabled",
  project_doc_max_bytes: 0,
  "apps._default.enabled": false,
};
/**
 * @typedef {import("./session-contract.mjs").BackendConfig} BackendConfig
 * @typedef {import("./session-contract.mjs").RunParams} RunParams
 * @typedef {import("./session-contract.mjs").StoredSession} StoredSession
 * @typedef {import("./session-contract.mjs").DisconnectHook} DisconnectHook
 */
export class CodexBackend {
  /**
   * @param {BackendConfig} config
   * @param {import("./session-contract.mjs").BackendAgent} agent
   * @param {{root?: string, rpc?: CodexRpc}} [options] root is required; the default only keeps the destructuring safe.
   */
  constructor(config, agent, { root, rpc } = {}) {
    this.config = { ...config, type: /** @type {const} */ ("codex") };
    this.agent = agent;
    this.root = path.join(/** @type {string} */ (root), "codex", agent.id);
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const home = (this.home = path.join(this.root, "home"));
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    this.expectedHome = path.join(
      fs.realpathSync(/** @type {string} */ (root)),
      "codex",
      agent.id,
      "home",
    );
    // Never inherit the user's everyday Codex home. Login belongs to this dedicated instance.
    this.rpc =
      rpc ||
      new CodexRpc(
        // Vendor JS: its inferred options type omits the destructured cwd.
        /** @type {any} */ ({
          command: config.command || "codex",
          // npm installs `codex.cmd` on Windows, which spawn() cannot start
          // without a shell; see windowsCodexSpawn for how it is stopped.
          ...(process.platform === "win32"
            ? { spawnProcess: windowsCodexSpawn() }
            : {}),
          cwd: this.root,
          env: { ...buildChildEnv("codex", config.env), CODEX_HOME: home },
          args: [
            "app-server",
            "--stdio",
            ...Object.entries(restrictions).flatMap(([k, v]) => [
              "-c",
              `${k}=${JSON.stringify(v)}`,
            ]),
          ],
        }),
      );
    this.external = new ExternalTools(config.toolServers);
    this.active = new Map();
    this.rpc.on("notification", (/** @type {any} */ m) => this.notification(m));
    this.rpc.on("request", (/** @type {any} */ m) => void this.request(m));
    this.rpc.on("disconnected", () => {
      for (const r of this.active.values())
        r.reject(Error("CODEX_DISCONNECTED"));
      this.active.clear();
      this.readyPromise = null;
      if (!this.closing)
        /** @type {this & DisconnectHook} */ (this).onDisconnect?.(
          Error("CODEX_DISCONNECTED"),
        );
    });
  }
  async ready() {
    if (!this.readyPromise)
      this.readyPromise = (async () => {
        const initialized = await this.rpc.start();
        const version = /^qq_bridge_codex\/(\d+)\.(\d+)\.\d+/.exec(
          initialized?.userAgent || "",
        );
        // Older app-servers accept only flat dynamic tool declarations.
        this.desktopVisualDirect =
          !!version && (Number(version[1]) > 0 || Number(version[2]) >= 167);
        const auth = await this.rpc.request("account/read", {
          refreshToken: false,
        });
        if (!auth.account) throw Error("CODEX_DEDICATED_LOGIN_REQUIRED");
        return this.rpc.request("model/list", {});
      })().catch((e) => {
        this.readyPromise = null;
        throw e;
      });
    return this.readyPromise;
  }
  async models() {
    return (await this.health()).models;
  }
  async health() {
    await this.ready();
    const auth = await this.rpc.request("account/read", {
      refreshToken: false,
    });
    if (!auth.account) throw Error("CODEX_DEDICATED_LOGIN_REQUIRED");
    const result = await this.rpc.request("model/list", {});
    if (
      !result.data?.length ||
      (this.config.model &&
        !result.data.some(
          (/** @type {any} */ m) =>
            m.model === this.config.model || m.id === this.config.model,
        ))
    )
      throw Error("BACKEND_MODEL_UNAVAILABLE");
    return { models: result.data, endpoint: "stdio" };
  }
  /** @param {{method: string, params?: any}} message */
  notification({ method, params: p }) {
    const r = this.active.get(p?.threadId);
    if (!r) return;
    if (
      method === "item/completed" &&
      p.turnId === r.turnId &&
      !r.signal.aborted &&
      p.item?.type === "imageGeneration"
    ) {
      try {
        r.onGeneratedImage?.(p.threadId, p.item);
      } catch {
        r.onImageError?.();
      }
    }
    if (method === "thread/tokenUsage/updated") {
      const usage = p.tokenUsage;
      if (usage?.last && usage.last.inputTokens + usage.last.outputTokens > 0)
        r.onUsage?.({
          source: "measured",
          contextTokens: usage.last.inputTokens + usage.last.outputTokens,
          capacityTokens: usage.modelContextWindow,
          cumulativeTokens: usage.total.totalTokens,
          basis:
            "last model request input plus output; total only for billing telemetry",
        });
    }
    if (method === "turn/started") {
      // Only turn/start's receipt identifies our submitted input. Earlier
      // notifications can belong to a prior turn on the resumed thread.
      if (r.submitInput && (!r.inputSubmitted || p.turn.id !== r.turnId))
        return;
      if (p.turn.id === r.recoveryTurnId) return;
      r.turnId = p.turn.id;
      r.onBackendTurn?.({ turnId: p.turn.id });
    }
    if (method === "turn/completed") {
      if (r.submitInput && r.awaitingReceipt) {
        r.earlyCompletions.set(p.turn.id, p);
        return;
      }
      if (
        (r.turnId && p.turn.id !== r.turnId) ||
        p.turn.id === r.recoveryTurnId
      )
        return;
      r.turnId = p.turn.id;
      r.onBackendTurn?.({ turnId: p.turn.id });
      if (p.turn.status === "completed") r.resolve();
      else r.reject(codexTurnFailure(p.turn));
    }
  }
  /** @param {{id: number | string, method: string, params?: any}} message */
  async request({ id, method, params: p }) {
    const r = this.active.get(p?.threadId);
    if (
      method !== "item/tool/call" ||
      !r ||
      !r.callTool ||
      (r.submitInput && !r.inputSubmitted) ||
      r.turnId !== p.turnId ||
      r.signal.aborted
    ) {
      this.rpc.reject(id);
      return;
    }
    const active = () =>
      this.active.get(p.threadId) === r &&
      r.turnId === p.turnId &&
      !r.signal.aborted;
    let original,
      failed = false;
    try {
      const args =
        typeof p.arguments === "string" ? JSON.parse(p.arguments) : p.arguments;
      original = await r.callTool(p.tool, args);
    } catch (error) {
      original = error;
      failed = true;
    }
    if (!active()) return this.rpc.reject(id);
    /** @type {any} */
    let pendingVideo;
    const encode = (/** @type {any} */ value) => {
      let output = failed
        ? codexToolError(
            value instanceof Error || value === original
              ? safeToolFailure(value)
              : value,
          )
        : mcpResult(value);
      if (p.tool === "video_read" && !output.isError) {
        if (r.videoFrames || typeof value[mediaLease] !== "function")
          throw Error("VIDEO_BUSY");
        pendingVideo = {
          current: value[mediaLease],
          content: output.content,
          setPending: value[videoDelivery],
        };
        output = mcpResult({
          notice: videoResponseGuide,
        });
      }
      return codexToolOutput(id, output);
    };
    try {
      const { wire, receipt } = r.finalizeToolOutput
        ? await r.finalizeToolOutput(original, {
            encode,
            // The local RPC appends a newline after serializing this object.
            maxBytes: MAX_TOOL_RESPONSE_BYTES - 1,
          })
        : { wire: encode(original).wire };
      if (!active()) return this.rpc.reject(id);
      if (pendingVideo) {
        pendingVideo.setPending(true);
        r.videoFrames = pendingVideo;
      }
      this.rpc.respond(
        wire.id,
        wire.result,
        (/** @type {Error | null | undefined} */ error) => {
          if (!error && receipt && active())
            r.commitToolOutput?.(
              receipt,
              codexToolText(wire.result.contentItems),
            );
        },
      );
    } catch (error) {
      if (!active()) return;
      try {
        const { wire } = codexToolOutput(
          id,
          codexToolError(safeToolFailure(error)),
        );
        this.rpc.respond(wire.id, wire.result);
      } catch {
        // The app-server may already be gone; nothing more to report.
      }
    }
  }
  /** @param {import("./session-contract.mjs").ToolSpec[]} tools */
  sessionSignature(tools) {
    if (hasDesktopScreen(tools))
      return sessionSignature(
        {
          config: this.config,
          sessionProtocol: "desktop-visual-v1",
        },
        tools,
      );
    return sessionSignature(this, tools);
  }
  /** @param {StoredSession | null | undefined} session @param {import("./session-contract.mjs").ToolSpec[]} tools @param {import("./session-contract.mjs").SessionContract} [previous] */
  acceptsSession(session, tools, previous) {
    if (hasDesktopScreen(tools))
      return (
        session?.backend === "codex" &&
        session.signature === this.sessionSignature(tools)
      );
    return acceptsSession(this, session, tools);
  }
  /** @param {{windowId?: string, actorGeneration?: string}} [filter] */
  async closeSocialSessions(filter = {}) {
    await closeSocialSessions(this, filter);
  }
  /** @param {any} params */
  async runDesktop(params) {
    return this.runIsolated(params, "desktop");
  }
  /** @param {any} params */
  async runSocial(params) {
    return this.runIsolated(params, "social");
  }
  /** @param {any} params @param {"social" | "desktop"} surface */
  async runIsolated(params, surface) {
    return runNativeSocial(
      this,
      params,
      async (session) => {
        if (!session) return;
        try {
          await this.rpc.request("thread/archive", { threadId: session.id });
        } catch {
          throw Error("SOCIAL_CONTEXT_FINALIZATION_FAILED");
        }
      },
      surface,
    );
  }
  /** @param {RunParams} params */
  async run({
    prompt,
    inputImages = [],
    instructions,
    onUsage,
    signal,
    tools,
    callTool,
    session,
    saveSession,
    onBackendTurn,
    onInputSubmitted,
    finalizeToolOutput,
    commitToolOutput,
    beforeInputSubmitted,
    appendPrompt,
    onImageSession,
    onGeneratedImage,
    onImageError,
    recovery,
    protectedWork = false,
    game = false,
    social = false,
    desktop = false,
  }) {
    const policy =
      protectedWork || game || social
        ? {
            ...restrictions,
            "features.image_generation": false,
            "features.browser_use": false,
            "features.computer_use": false,
            "features.in_app_browser": false,
            "features.apps": false,
            ...(social ? { mcp_servers: {} } : {}),
          }
        : restrictions;
    const signature = this.sessionSignature(tools);
    assertSession(session, "codex", signature);
    await beforeSessionInput(session, () => this.ready());
    if (signal.aborted) throw Error("ABORTED");
    const hasScreen = desktop && hasDesktopScreen(tools);
    const directScreen = hasScreen && this.desktopVisualDirect;
    const nativeSignature = hasScreen
      ? directScreen
        ? "desktop-screen-direct"
        : "desktop-screen-flat"
      : undefined;
    if (
      session &&
      nativeSignature &&
      session.nativeSignature !== nativeSignature
    )
      throw new SessionUnavailableFailure("CODEX_SESSION_UNAVAILABLE");
    if (directScreen) {
      // Model-selected code mode serializes nested tool outputs as text.
      // Keep the screenshot's image block on the direct model tool route.
      Object.assign(policy, {
        "features.code_mode": {
          enabled: false,
          direct_only_tool_namespaces: [desktopVisualNamespace],
        },
      });
    }
    if (social) {
      // Empty MCP tables merge with inherited config; disable each effective
      // server explicitly instead of assuming mcp_servers={} removes it.
      try {
        const effective = await this.rpc.request("config/read", {
          includeLayers: false,
          cwd: this.root,
        });
        if (!effective.config || typeof effective.config !== "object")
          throw Error("SOCIAL_BACKEND_UNSUPPORTED");
        const servers = effective.config.mcp_servers || {};
        if (typeof servers !== "object" || Array.isArray(servers))
          throw Error("SOCIAL_BACKEND_UNSUPPORTED");
        Object.assign(policy, {
          mcp_servers: Object.fromEntries(
            Object.keys(servers).map((name) => [name, { enabled: false }]),
          ),
        });
      } catch {
        throw Error("SOCIAL_BACKEND_UNSUPPORTED");
      }
    }
    let threadId = session?.id;
    if (threadId)
      await beforeSessionInput(session, async () => {
        try {
          await this.rpc.request("thread/resume", {
            threadId,
            excludeTurns: true,
            sandbox: "read-only",
            approvalPolicy: "never",
            config: policy,
          });
        } catch (/** @type {any} */ error) {
          const closing =
            error.rpcCode === -32600 &&
            error.message ===
              `thread ${threadId} is closing; retry thread/resume after the thread is closed`;
          if (error.rpcRejected && !closing)
            throw new SessionUnavailableFailure("CODEX_SESSION_UNAVAILABLE");
          throw error;
        }
      });
    else {
      const r = await this.rpc.request("thread/start", {
        cwd: this.root,
        sandbox: "read-only",
        approvalPolicy: "never",
        ...(this.config.model ? { model: this.config.model } : {}),
        baseInstructions:
          instructions || "你是独立 QQ 人格，只通过启用的 QQ 发送工具投递。",
        developerInstructions:
          "只使用本回合提供的工具。不得访问本机开发环境。不要在文本中泄露能力凭据。",
        dynamicTools: tools.map(({ name, description, inputSchema }) => {
          const tool = { name, description, inputSchema };
          if (!directScreen) return tool;
          const declaration = { type: "function", ...tool };
          if (name !== DESKTOP_SCREEN_VIEW) return declaration;
          return {
            type: "namespace",
            name: desktopVisualNamespace,
            description: "Current-turn desktop image observations",
            tools: [declaration],
          };
        }),
        config: policy,
        experimentalRawEvents: false,
      });
      threadId = /** @type {string} */ (r.thread.id);
      saveSession({
        backend: "codex",
        id: threadId,
        signature,
        ...(nativeSignature && { nativeSignature }),
      });
    }
    if (signal.aborted) throw Error("ABORTED");
    if (recovery && !(await this.recoveryReady(threadId, recovery)))
      throw Error("CODEX_RECOVERY_STATE_UNVERIFIED");
    onImageSession?.(threadId);
    /** @type {(value?: unknown) => void} */
    let resolve = /** @type {any} */ (undefined);
    /** @type {(reason?: unknown) => void} */
    let reject = /** @type {any} */ (undefined);
    let done = new Promise((r, j) => {
      resolve = r;
      reject = j;
    });
    done.catch(() => {});
    const active = {
      resolve,
      reject,
      callTool,
      signal,
      onUsage,
      onBackendTurn,
      onGeneratedImage,
      onImageError,
      finalizeToolOutput,
      commitToolOutput,
      inputSubmitted: false,
      awaitingReceipt: true,
      videoFrames:
        /** @type {{current: () => boolean, content: any[], setPending: (pending: boolean, submitted?: boolean) => void} | undefined} */ (
          undefined
        ),
      earlyCompletions: new Map(),
      submitInput: () => {
        if (active.inputSubmitted || signal.aborted) return;
        active.inputSubmitted = true;
        onInputSubmitted?.();
      },
      turnId: null,
      recoveryTurnId: recovery?.turnId,
    };
    this.active.set(threadId, active);
    const abort = () => {
      if (active.turnId)
        void this.rpc
          .request("turn/interrupt", { threadId, turnId: active.turnId })
          .catch(() => {});
      active.reject(Error("ABORTED"));
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (signal.aborted) throw Error("ABORTED");
      await beforeInputSubmitted?.();
      if (signal.aborted) throw Error("ABORTED");
      /** @type {any[]} */
      let input = [
        {
          type: "text",
          text: prompt + (appendPrompt?.() || ""),
          text_elements: [],
        },
        ...inputImages.flatMap((image) => [
          { type: "text", text: image.label, text_elements: [] },
          ...(image.data
            ? [
                {
                  type: "image",
                  url: `data:${image.mimeType};base64,${image.data}`,
                },
              ]
            : []),
        ]),
      ];
      /** @type {((pending: boolean, submitted?: boolean) => void) | undefined} */
      let setPending;
      let videoSubmitted = false;
      for (let step = 0; step <= 2; step++) {
        active.awaitingReceipt = true;
        const receipt = await this.rpc.request("turn/start", {
          threadId,
          input,
          ...(this.config.model ? { model: this.config.model } : {}),
          effort: this.config.effort || "high",
        });
        active.turnId = receipt.turn.id;
        active.awaitingReceipt = false;
        setPending?.(false, videoSubmitted);
        active.submitInput();
        onBackendTurn?.({ turnId: receipt.turn.id });
        const completed = active.earlyCompletions.get(receipt.turn.id);
        active.earlyCompletions.clear();
        if (completed)
          this.notification({ method: "turn/completed", params: completed });
        if (signal.aborted) abort();
        await done;
        const frames =
          /** @type {{current: () => boolean, content: any[], setPending: (pending: boolean) => void} | undefined} */ (
            active.videoFrames
          );
        if (!frames) break;
        active.videoFrames = undefined;
        if (step === 2) throw Error("VIDEO_TURN_LIMIT");
        signal.throwIfAborted();
        const content = frames.current() ? frames.content : [];
        videoSubmitted = content.length > 0;
        setPending = frames.setPending;
        input = [
          {
            type: "text",
            text: content.length
              ? "这是刚才获准的视频采样画面。看完概览后可按兴趣回看一次，也可直接交流。只描述实际看到的画面。"
              : "视频来源或权限已变化，本次图片未交付。",
            text_elements: [],
          },
          ...content.map((part) =>
            part.type === "image"
              ? {
                  type: "image",
                  url: `data:${part.mimeType};base64,${part.data}`,
                }
              : { type: "text", text: part.text, text_elements: [] },
          ),
        ];
        // Advance the native request in the same thread without admitting new
        // chat input or transferring the observation to another bridge turn.
        done = new Promise((r, j) => {
          resolve = r;
          reject = j;
        });
        done.catch(() => {});
        active.resolve = resolve;
        active.reject = reject;
        active.turnId = null;
      }
    } catch (/** @type {any} */ e) {
      if (!signal.aborted && e instanceof BackendTurnFailure && e.recoverable)
        e.sessionReusable = await this.recoveryReady(threadId, e).catch(
          () => false,
        );
      if ((!e.sessionReusable && !sessionWasUnchanged(e)) || signal.aborted)
        saveSession(null);
      throw e;
    } finally {
      signal.removeEventListener("abort", abort);
      this.active.delete(threadId);
    }
  }
  /** A local abort is not terminal proof; match the exact native turn on the server.
   * @param {{session?:{id?:string},backendTurn?:string}} run */
  async gameRunState(run) {
    if (!run.session?.id || !run.backendTurn) return { terminal: false };
    await this.ready();
    const reply = await this.rpc.request("thread/read", {
      threadId: run.session.id,
      includeTurns: true,
    });
    const thread = reply.thread,
      turn = thread?.turns?.find(
        (/** @type {any} */ item) => item.id === run.backendTurn,
      );
    return {
      terminal:
        thread?.id === run.session.id &&
        thread?.status?.type === "idle" &&
        ["completed", "interrupted", "failed"].includes(turn?.status),
    };
  }
  /** @param {string} threadId @param {BackendTurnFailure} failure */
  async recoveryReady(threadId, failure) {
    const { thread } = await this.rpc.request("thread/read", {
      threadId,
      includeTurns: true,
    });
    const last = thread?.turns?.at(-1);
    return (
      thread?.id === threadId &&
      thread.status?.type === "idle" &&
      last?.id === failure.turnId &&
      last.status === "failed" &&
      codexTurnFailure(last).code === failure.code
    );
  }
  /** @param {string} sessionId @param {any} item */
  readGeneratedImage(sessionId, item) {
    if (fs.realpathSync(this.home) !== this.expectedHome)
      throw Error("GENERATED_IMAGE_SOURCE_DENIED");
    return readGeneratedImage(this.home, sessionId, item);
  }
  /** @param {string} sessionId */
  async imageHistory(sessionId) {
    await this.ready();
    const result = await this.rpc.request("thread/read", {
      threadId: sessionId,
      includeTurns: true,
    });
    if (result.thread?.id !== sessionId)
      throw Error("IMAGE_SESSION_SCOPE_MISMATCH");
    const items = (result.thread?.turns || [])
      .flatMap((/** @type {any} */ t) => t.items || [])
      .filter((/** @type {any} */ i) => i.type === "imageGeneration");
    if (items.length > 100) throw Error("GENERATED_IMAGE_HISTORY_LIMIT");
    return items;
  }
  /** @param {{session: StoredSession, signal: AbortSignal}} params */
  async compact({ session, signal }) {
    await this.ready();
    if (signal.aborted) throw Error("ABORTED");
    const threadId = session.id;
    /** @type {(value?: unknown) => void} */
    let resolve = /** @type {any} */ (undefined);
    /** @type {(reason?: unknown) => void} */
    let reject = /** @type {any} */ (undefined);
    /** @type {import("./session-contract.mjs").UsageReport | undefined} */
    let usage;
    let done = new Promise((r, j) => {
      resolve = r;
      reject = j;
    });
    done.catch(() => {});
    const active = {
      resolve,
      reject,
      signal,
      turnId: null,
      onUsage: (
        /** @type {import("./session-contract.mjs").UsageReport} */ value,
      ) => {
        usage = value;
      },
    };
    this.active.set(threadId, active);
    const abort = () => {
      if (active.turnId)
        void this.rpc
          .request("turn/interrupt", { threadId, turnId: active.turnId })
          .catch(() => {});
      reject(Error("COMPACTION_CANCELLED"));
    };
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 120000);
    try {
      await this.rpc.request("thread/compact/start", { threadId });
      await done;
      return { usage };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      this.active.delete(threadId);
    }
  }
  async cancel() {
    for (const [threadId, r] of this.active) {
      if (r.turnId)
        void this.rpc
          .request("turn/interrupt", { threadId, turnId: r.turnId })
          .catch(() => {});
      r.reject(Error("ABORTED"));
    }
  }
  async close() {
    this.closing = true;
    await this.cancel();
    await this.closeSocialSessions();
    this.rpc.close();
    await this.external.close();
  }
}
