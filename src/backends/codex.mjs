// @ts-check
import fs from "node:fs";
import { codexTurnFailure, BackendTurnFailure } from "./turn-failure.mjs";
import path from "node:path";
import { CodexRpc } from "../../vendor/local-bridge/codex-rpc.mjs";
import { ExternalTools } from "./external.mjs";
import { mcpResult } from "../tools/index.mjs";
import { safeToolFailure } from "../tools/errors.mjs";
import { sessionSignature, assertSession } from "./session-contract.mjs";
import { readGeneratedImage } from "./generated-image-file.mjs";
import { buildChildEnv } from "../core/child-env.mjs";
import crossSpawn from "cross-spawn";
import { execFileSync } from "node:child_process";

/** @param {number} pid */
function taskkillTree(pid) {
  execFileSync(
    path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "taskkill.exe",
    ),
    ["/pid", String(pid), "/T", "/F"],
    { stdio: "ignore", windowsHide: true, timeout: 10000 },
  );
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
    this.config = config;
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
        await this.rpc.start();
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
      r.turnId = p.turn.id;
      r.onBackendTurn?.({ turnId: p.turn.id });
    }
    if (method === "turn/completed") {
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
      r.turnId !== p.turnId ||
      r.signal.aborted
    ) {
      this.rpc.reject(id);
      return;
    }
    try {
      const args =
        typeof p.arguments === "string" ? JSON.parse(p.arguments) : p.arguments;
      const result = mcpResult(await r.callTool(p.tool, args));
      if (r.signal.aborted) return this.rpc.reject(id);
      this.rpc.respond(id, {
        success: !result.isError,
        contentItems: result.content.flatMap((/** @type {any} */ c) =>
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
        ),
      });
    } catch (error) {
      try {
        this.rpc.respond(id, {
          success: false,
          contentItems: [
            { type: "inputText", text: JSON.stringify(safeToolFailure(error)) },
          ],
        });
      } catch {
        // The app-server may already be gone; nothing more to report.
      }
    }
  }
  /** @param {import("./session-contract.mjs").ToolSpec[]} tools */
  sessionSignature(tools) {
    return sessionSignature(this, tools);
  }
  /** @param {RunParams} params */
  async run({
    prompt,
    instructions,
    onUsage,
    signal,
    tools,
    callTool,
    session,
    saveSession,
    onBackendTurn,
    onImageSession,
    onGeneratedImage,
    onImageError,
    recovery,
  }) {
    const signature = this.sessionSignature(tools);
    assertSession(session, "codex", signature);
    await this.ready();
    if (signal.aborted) throw Error("ABORTED");
    let threadId = session?.id;
    if (threadId)
      await this.rpc.request("thread/resume", {
        threadId,
        excludeTurns: true,
        sandbox: "read-only",
        approvalPolicy: "never",
        config: restrictions,
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
        dynamicTools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
        config: restrictions,
        experimentalRawEvents: false,
      });
      threadId = /** @type {string} */ (r.thread.id);
      saveSession({ backend: "codex", id: threadId, signature });
    }
    if (signal.aborted) throw Error("ABORTED");
    if (recovery && !(await this.recoveryReady(threadId, recovery)))
      throw Error("CODEX_RECOVERY_STATE_UNVERIFIED");
    onImageSession?.(threadId);
    /** @type {(value?: unknown) => void} */
    let resolve = /** @type {any} */ (undefined);
    /** @type {(reason?: unknown) => void} */
    let reject = /** @type {any} */ (undefined);
    const done = new Promise((r, j) => {
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
      turnId: null,
      recoveryTurnId: recovery?.turnId,
    };
    this.active.set(threadId, active);
    const abort = () => {
      if (active.turnId)
        void this.rpc
          .request("turn/interrupt", { threadId, turnId: active.turnId })
          .catch(() => {});
      reject(Error("ABORTED"));
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (signal.aborted) throw Error("ABORTED");
      const receipt = await this.rpc.request("turn/start", {
        threadId,
        input: [{ type: "text", text: prompt, text_elements: [] }],
        ...(this.config.model ? { model: this.config.model } : {}),
        effort: this.config.effort || "high",
      });
      active.turnId = receipt.turn.id;
      onBackendTurn?.({ turnId: receipt.turn.id });
      if (signal.aborted) abort();
      await done;
    } catch (/** @type {any} */ e) {
      if (!signal.aborted && e instanceof BackendTurnFailure && e.recoverable)
        e.sessionReusable = await this.recoveryReady(threadId, e).catch(
          () => false,
        );
      if (!e.sessionReusable || signal.aborted) saveSession(null);
      throw e;
    } finally {
      signal.removeEventListener("abort", abort);
      this.active.delete(threadId);
    }
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
    const done = new Promise((r, j) => {
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
    this.rpc.close();
    await this.external.close();
  }
}
