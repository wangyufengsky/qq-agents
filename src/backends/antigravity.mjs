// @ts-check
import { finalizeMcpOutput, toolOutputText } from "./tool-output.mjs";
import { closeSocialSessions } from "./social-sessions.mjs";
import { runNativeSocial } from "./native-social.mjs";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import crossSpawn from "cross-spawn";
import { execFileSync } from "node:child_process";
import { buildChildEnv } from "../core/child-env.mjs";
import { sanitizeBackendDiagnostic } from "../core/session-records.mjs";
import { ExternalTools } from "./external.mjs";
import {
  assertSession,
  sessionSignature,
  acceptsSession,
  sessionContract,
  toolSchema as antigravitySchemaContract,
} from "./session-contract.mjs";
import {
  BackendTurnFailure,
  SessionPreparationFailure,
  SessionUnavailableFailure,
  beforeSessionInput,
} from "./turn-failure.mjs";
import { AntigravityMedia } from "./antigravity-media.mjs";
import { AntigravityStreamWorker } from "./antigravity-stream.mjs";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const here = path.dirname(fileURLToPath(import.meta.url));
const MAX_OUTPUT = 16 * 1024 * 1024;
/** Headless result usage is cumulative; only a completed model-response step
 * describes the latest request. Cache reads are excluded from input_tokens.
 * @param {any} usage */
function responseOccupancy(usage) {
  const counts = [
    usage?.input_tokens,
    usage?.output_tokens,
    usage?.cache_read_tokens ?? 0,
  ];
  if (!counts.every((n) => Number.isSafeInteger(n) && n >= 0)) return null;
  const tokens = counts.reduce((sum, n) => sum + n, 0);
  return Number.isSafeInteger(tokens) && counts[0] + counts[2] > 0
    ? tokens
    : null;
}
export { antigravitySchemaContract, responseOccupancy };
/** Emit only fixed diagnostic fields; provider text must never leave the adapter.
 * @param {RunParams} params @param {number} start @param {Record<string, unknown>} value */
export function antigravityDiagnostic(params, start, value) {
  const event = sanitizeBackendDiagnostic({
    ...value,
    ...("terminalStatus" in value
      ? {
          terminalStatus: ["SUCCESS", "ERROR", "CANCELLED"].includes(
            /** @type {string} */ (value.terminalStatus),
          )
            ? value.terminalStatus
            : "unrecognized",
        }
      : {}),
    elapsedMs: Math.min(86400000, Math.max(0, performance.now() - start)),
  });
  try {
    params.onDiagnostic?.(event);
  } catch {
    console.warn("Antigravity diagnostic recording failed");
  }
}
/** @type {WeakSet<import("node:child_process").ChildProcess>} */
const terminatedGroups = new WeakSet();
function isolatedEnv() {
  return {
    ...buildChildEnv("antigravity"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  };
}
/** CLI customizations resolve at the Git root, which must never be an ancestor.
 * @param {string} directory */
function isolatedWorkspace(directory) {
  const git = path.join(directory, ".git");
  try {
    if (fs.existsSync(git)) {
      if (
        !fs.lstatSync(git).isDirectory() ||
        fs.lstatSync(git).isSymbolicLink()
      )
        throw Error("ANTIGRAVITY_WORKSPACE_UNSAFE");
    } else {
      execFileSync(
        "git",
        [
          "init",
          "--quiet",
          "--template=",
          "--initial-branch=qq-agents",
          directory,
        ],
        {
          env: isolatedEnv(),
          stdio: "ignore",
          windowsHide: true,
          timeout: 10000,
        },
      );
    }
    const actual = execFileSync(
      "git",
      ["-C", directory, "rev-parse", "--show-toplevel"],
      {
        env: isolatedEnv(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
        timeout: 10000,
      },
    ).trim();
    // Git and Node can return different drive-letter casing on Windows.
    // Compare the actual directory identity without accepting an ancestor.
    const expected = fs.statSync(directory, { bigint: true });
    const resolved = fs.statSync(actual, { bigint: true });
    if (
      !expected.ino ||
      expected.dev !== resolved.dev ||
      expected.ino !== resolved.ino
    )
      throw Error("ANTIGRAVITY_WORKSPACE_UNSAFE");
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    // The bridge reports only the fixed outer category, never Git diagnostics.
    throw Error(
      code === "ENOENT"
        ? "ANTIGRAVITY_GIT_REQUIRED"
        : "ANTIGRAVITY_WORKSPACE_UNSAFE",
      { cause: error },
    );
  }
}
/** @param {string} directory */
function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (
    !fs.lstatSync(directory).isDirectory() ||
    fs.lstatSync(directory).isSymbolicLink()
  )
    throw Error("ANTIGRAVITY_PROFILE_UNSAFE");
  return directory;
}
/** @param {string} file @param {string} content */
function managedFile(file, content) {
  if (
    fs.existsSync(file) &&
    (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())
  )
    throw Error("ANTIGRAVITY_PROFILE_UNSAFE");
  // Replace only bridge-owned files; never follow an existing destination link.
  const temporary = file + "." + randomBytes(8).toString("hex");
  fs.writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, file);
}
/** @param {string} value @param {NodeJS.Platform} [platform] */
export function antigravityShellQuote(value, platform = process.platform) {
  if (platform === "win32") {
    if (/["%!?^&|<>\r\n]/.test(value))
      throw Error("ANTIGRAVITY_COMMAND_UNSAFE");
    return `"${value}"`;
  }
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
/** @param {import("node:child_process").ChildProcess} child @param {NodeJS.Signals} signal */
function stopTree(child, signal) {
  if (!child.pid || terminatedGroups.has(child)) return;
  try {
    if (process.platform === "win32") {
      if (child.exitCode !== null || child.signalCode !== null) return;
      execFileSync(
        path.join(
          process.env.SystemRoot || "C:\\Windows",
          "System32",
          "taskkill.exe",
        ),
        ["/pid", String(child.pid), "/T", "/F"],
        { stdio: "ignore", windowsHide: true, timeout: 10000 },
      );
    } else {
      // A dead group leader can leave descendants holding the stdio pipes open.
      // Escalate the owned group once, independently of the leader's exit state.
      if (signal === "SIGKILL") terminatedGroups.add(child);
      process.kill(-child.pid, signal);
    }
  } catch {
    if (child.exitCode === null && child.signalCode === null)
      child.kill(signal);
  }
}
/** @param {string} text @param {string} status @param {boolean} hookDenied */
export function antigravityFailure(text, status = "ERROR", hookDenied = false) {
  // Match categories only. Provider diagnostics never become an error message.
  const category = /RESOURCE_EXHAUSTED|quota|429/i.test(text)
    ? "quota"
    : /UNAUTHENTICATED|authentication required|sign.?in|login required/i.test(
          text,
        )
      ? "authentication"
      : /context.*(?:limit|exceed)|too many tokens/i.test(text)
        ? "context-limit"
        : /permission|hook|denied/i.test(text) || hookDenied
          ? "permission"
          : /CANCELED|INTERRUPTED/.test(status)
            ? "cancelled"
            : "unknown";
  return new BackendTurnFailure(
    "antigravity",
    category === "unknown"
      ? "TURN_FAILED"
      : category.toUpperCase().replaceAll("-", "_"),
    category,
    "",
    false,
  );
}

/** @typedef {import("./session-contract.mjs").BackendConfig} BackendConfig */
/** @typedef {import("./session-contract.mjs").RunParams} RunParams */
export class AntigravityBackend {
  /** @param {BackendConfig} config @param {import("./session-contract.mjs").BackendAgent} agent
   * @param {{root?: string, spawn?: typeof crossSpawn, stop?: typeof stopTree}} [options] */
  constructor(
    config,
    agent,
    { root, spawn = crossSpawn, stop = stopTree } = {},
  ) {
    this.config = { ...config, type: /** @type {const} */ ("antigravity") };
    this.agent = agent;
    this.sessionProtocol =
      config.cliProtocol === "acp"
        ? "antigravity-acp-v1"
        : "antigravity-tools-v3";
    this.spawn = spawn;
    this.stop = stop;
    this.root = privateDirectory(
      path.join(/** @type {string} */ (root), "antigravity", agent.id),
    );
    this.profile = privateDirectory(path.join(this.root, "profile"));
    this.external = new ExternalTools(config.toolServers);
    /** @type {Set<{abort: () => void, done: Promise<unknown>}>} */
    this.active = new Set();
    this.conversations = new Set();
    /** @type {Map<string, AntigravityStreamWorker>} */
    this.workers = new Map();
    this.closing = false;
  }
  /** @param {import("./session-contract.mjs").ToolSpec[]} tools */
  sessionSignature(tools) {
    // Native sessions retain their old prompt and native tool contract. Hand off
    // once to install the turn-scoped image reader instead of arbitrary file access.
    return sessionSignature(this, tools);
  }
  /** @param {import("./session-contract.mjs").StoredSession | null | undefined} session @param {import("./session-contract.mjs").ToolSpec[]} tools @param {import("./session-contract.mjs").SessionContract} [previous] */
  acceptsSession(session, tools, previous) {
    return acceptsSession(this, session, tools, previous);
  }
  profileArgs() {
    return ["--gemini_dir", this.profile, "--app_data_dir", "cli"];
  }
  checkProfile() {
    isolatedWorkspace(this.root);
    privateDirectory(this.profile);
    const configuration = privateDirectory(path.join(this.profile, "config"));
    // These directories are exclusively bridge-owned; personal customizations
    // would make an agent inherit tools or executable hooks outside its contract.
    for (const name of fs.readdirSync(configuration))
      if (
        !["mcp_config.json", "projects", ".migrated", "config.json"].includes(
          name,
        ) ||
        fs.lstatSync(path.join(configuration, name)).isSymbolicLink()
      )
        throw Error("ANTIGRAVITY_PROFILE_UNSAFE");
    for (const name of ["GEMINI.md", "AGENTS.md", "skills", "hooks.json"])
      if (fs.existsSync(path.join(this.profile, name)))
        throw Error("ANTIGRAVITY_PROFILE_UNSAFE");
    // New CLI versions persist a default swarm plugin on first use. Pin it off
    // before startup; only this exact inert configuration is permitted on reuse.
    const pluginConfig = path.join(configuration, "config.json");
    const disabledPlugins = { plugins: { swarm: { enabled: false } } };
    if (fs.existsSync(pluginConfig)) {
      try {
        if (
          JSON.stringify(JSON.parse(fs.readFileSync(pluginConfig, "utf8"))) !==
          JSON.stringify(disabledPlugins)
        )
          throw Error();
      } catch {
        throw Error("ANTIGRAVITY_PROFILE_UNSAFE");
      }
    }
    managedFile(pluginConfig, JSON.stringify(disabledPlugins) + "\n");
    const mcp = path.join(configuration, "mcp_config.json");
    if (fs.existsSync(mcp)) {
      if (fs.lstatSync(mcp).isSymbolicLink())
        throw Error("ANTIGRAVITY_PROFILE_UNSAFE");
      const raw = fs.readFileSync(mcp, "utf8").trim();
      try {
        if (raw && Object.keys(JSON.parse(raw).mcpServers || {}).length)
          throw Error();
      } catch {
        throw Error("ANTIGRAVITY_PROFILE_UNSAFE");
      }
    }
    managedFile(mcp, "{}\n");
    const cli = privateDirectory(path.join(this.profile, "cli"));
    for (const name of [
      "skills",
      "plugins",
      "hooks.json",
      "GEMINI.md",
      "AGENTS.md",
    ])
      if (fs.existsSync(path.join(cli, name)))
        throw Error("ANTIGRAVITY_PROFILE_UNSAFE");
    const settings = path.join(cli, "settings.json");
    if (fs.existsSync(settings)) {
      try {
        if (
          fs.lstatSync(settings).isSymbolicLink() ||
          Object.keys(JSON.parse(fs.readFileSync(settings, "utf8"))).length
        )
          throw Error();
      } catch {
        throw Error("ANTIGRAVITY_PROFILE_UNSAFE");
      }
    }
  }
  /** @param {string[]} args */
  async command(args) {
    if (this.closing) throw Error("ANTIGRAVITY_CLOSED");
    this.checkProfile();
    const child = this.spawn(
      this.config.command || "agy",
      [...this.profileArgs(), ...args],
      {
        cwd: this.root,
        env: isolatedEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      },
    );
    let output = "",
      diagnostic = "",
      failed = false;
    child.stdout?.on("data", (b) => {
      output += b;
      if (output.length > MAX_OUTPUT) {
        failed = true;
        this.stop(child, "SIGKILL");
      }
    });
    child.stderr?.on("data", (b) => {
      diagnostic = (diagnostic + b).slice(-65536);
    });
    const timer = setTimeout(() => {
      failed = true;
      this.stop(child, "SIGKILL");
    }, 30000);
    let finishDone = () => {};
    const entry = {
      abort: () => {
        failed = true;
        this.stop(child, "SIGKILL");
      },
      done: new Promise((resolve) => {
        finishDone = () => resolve(undefined);
      }),
    };
    this.active.add(entry);
    try {
      const code = await new Promise((resolve, reject) => {
        child.once("error", () => reject(Error("ANTIGRAVITY_NOT_FOUND")));
        child.once("close", resolve);
      });
      if (failed || code !== 0) {
        if (antigravityFailure(diagnostic).category === "authentication")
          throw Error("ANTIGRAVITY_LOGIN_REQUIRED");
        throw Error("ANTIGRAVITY_PROBE_FAILED");
      }
      return output;
    } finally {
      clearTimeout(timer);
      this.active.delete(entry);
      finishDone();
    }
  }
  async models() {
    const text = await this.command(["models"]);
    const models = text.split(/\r?\n/).flatMap((line) => {
      const match = /^([a-zA-Z0-9][a-zA-Z0-9._-]*)\t([^\r\n]+)$/.exec(line);
      return match ? [{ id: match[1], name: match[2] }] : [];
    });
    if (!models.length) throw Error("ANTIGRAVITY_PROBE_FAILED");
    return models;
  }
  async health() {
    const models = await this.models();
    if (this.config.model && !models.some((m) => m.id === this.config.model))
      throw Error("BACKEND_MODEL_UNAVAILABLE");
    return { models, endpoint: "stdio" };
  }
  /** @param {RunParams} params @param {string} signature */
  prepare(params, signature) {
    this.checkProfile();
    const key = createHash("sha256")
      .update(params.conversation || "subject")
      .digest("hex");
    const workspaces = privateDirectory(path.join(this.root, "workspaces"));
    const workspace = privateDirectory(path.join(workspaces, key));
    isolatedWorkspace(workspace);
    const custom = privateDirectory(path.join(workspace, ".agents"));
    const agents = privateDirectory(path.join(custom, "agents"));
    const binding = path.join(workspace, "session.json");
    if (this.conversations.has(key))
      throw Error("ANTIGRAVITY_CONVERSATION_BUSY");
    if (params.session) {
      const file = path.join(
        this.profile,
        "cli",
        "conversations",
        params.session.id + ".db",
      );
      let bound;
      try {
        if (fs.lstatSync(binding).isSymbolicLink()) throw Error();
        bound = JSON.parse(fs.readFileSync(binding, "utf8"));
      } catch {
        /* A lost binding is not permission to resume another chat. */
      }
      if (
        !uuid.test(params.session.id) ||
        !fs.existsSync(file) ||
        fs.lstatSync(file).isSymbolicLink() ||
        bound?.id !== params.session.id ||
        (!(
          params.session.nativeSignature &&
          bound?.signature === params.session.nativeSignature
        ) &&
          !this.acceptsSession(
            {
              backend: "antigravity",
              id: bound?.id,
              signature: bound?.signature,
            },
            params.tools,
            bound?.contract,
          ))
      ) {
        params.saveSession(null);
        throw new SessionUnavailableFailure("ANTIGRAVITY_SESSION_UNAVAILABLE");
      }
    }
    return { key, workspace, custom, agents, binding, signature };
  }
  /** @param {RunParams} params @param {ReturnType<AntigravityBackend["prepare"]>} details
   * @param {AntigravityMedia} media @param {boolean} [reuse] @param {string} [mediaRoot] */
  configure(
    params,
    { workspace, custom, agents },
    media,
    reuse = false,
    mediaRoot,
  ) {
    const names = new Set(
      reuse ? ["qq_turn_call"] : params.tools.map((tool) => tool.name),
    );
    let hook = [process.execPath, path.join(here, "antigravity-guard.mjs")]
      .map((v) => antigravityShellQuote(v))
      .join(" ");
    if (process.platform === "win32") {
      // The CLI escapes quoted hook commands before invoking cmd.exe. A
      // relative batch name avoids that extra quoting while keeping paths
      // with spaces inside the bridge-owned script and preserving stdin.
      managedFile(
        path.join(workspace, "qq-agents-hook.cmd"),
        `@echo off\r\nchcp 65001 >nul\r\n${hook}\r\nexit /b %errorlevel%\r\n`,
      );
      hook = "qq-agents-hook.cmd";
    }
    managedFile(
      path.join(custom, "hooks.json"),
      JSON.stringify({
        "qq-agents": {
          PreToolUse: [
            {
              matcher: "*",
              hooks: [{ type: "command", command: hook, timeout: 5 }],
            },
          ],
        },
      }),
    );
    managedFile(
      path.join(custom, "mcp_config.json"),
      JSON.stringify({
        mcpServers: {
          "qq-agents": {
            command: process.execPath,
            args: [path.join(here, "antigravity-mcp.mjs")],
            enabledTools: [...names],
            timeoutSeconds: 660,
          },
        },
      }),
    );
    const agentFile = path.join(agents, "qq-agents.md");
    const routing = reuse
      ? 'Use only call_mcp_tool with ServerName="qq-agents", ToolName="qq_turn_call" and Arguments={"epoch":the current bridge epoch,"name":an allowed logical tool name,"arguments":that tool arguments}. The epoch is a public routing label, not authorization. Take it only from the current bridge input, never a historical turn. Tool schemas below describe logical arguments inside the envelope. '
      : "";
    if (
      !params.session ||
      params.instructions !== undefined ||
      !fs.existsSync(agentFile)
    )
      managedFile(
        agentFile,
        `---\nname: qq-agents\ndescription: QQ Agents restricted role\nmainAgent: true\nsubagent: false\ntools:\n  - finish\n  - view_file\nenable_mcp_tools: true\ncommandExecutionPolicy: off\n---\n${params.instructions || ""}\n\n${routing}Use the qq-agents MCP tools for actions. ${reuse ? "" : 'Call call_mcp_tool with ServerName="qq-agents", ToolName equal to an allowed name, and Arguments matching that tool\'s JSON schema below. '}Do not guess parameter names or read framework source to discover arguments. The current chat and authorization are bound by the bridge; never add target, chatId or context fields unless the schema requires them. Ordinary assistant text is never delivered to QQ. Only native read_file (Path) or legacy view_file (AbsolutePath) on the exact image paths returned by an authorized tool in the CURRENT turn is allowed. Always call the native image reader before describing those pixels; MCP path text is not visual evidence. Never read other files or reuse a previous turn image path; request the original bridge tool again. No native task, filesystem writes, shell, browser, scheduling or subagent actions are authorized.\n\nAllowed tool argument schemas keyed by ToolName (required fields and additionalProperties are binding):\n${JSON.stringify(Object.fromEntries(params.tools.map(({ name, inputSchema }) => [name, antigravitySchemaContract(inputSchema)])))}\n`,
      );
    else {
      // Preserve the role instructions while refreshing compatible optional fields.
      if (fs.lstatSync(agentFile).isSymbolicLink())
        throw Error("ANTIGRAVITY_WORKSPACE_UNSAFE");
      const previous = fs.readFileSync(agentFile, "utf8");
      const marker =
        "\n\nAllowed tool argument schemas keyed by ToolName (required fields and additionalProperties are binding):\n";
      const offset = previous.lastIndexOf(marker);
      if (offset < 0) throw Error("ANTIGRAVITY_WORKSPACE_UNSAFE");
      managedFile(
        agentFile,
        // Native aliases resolve to one tool; register it once and preserve the transcript.
        previous
          .slice(0, offset)
          .replace(
            "\ntools:\n  - finish\n  - read_file\n  - view_file\n",
            "\ntools:\n  - finish\n  - view_file\n",
          )
          .replace(
            "\ntools:\n  - finish\nenable_mcp_tools:",
            "\ntools:\n  - finish\n  - view_file\nenable_mcp_tools:",
          )
          .replace(
            "Only native view_file on the exact image paths",
            "Only native read_file (Path) or legacy view_file (AbsolutePath) on the exact image paths",
          )
          .replace(
            "Always call view_file before describing those pixels",
            "Always call the native image reader before describing those pixels",
          ) +
          marker +
          JSON.stringify(
            Object.fromEntries(
              params.tools.map(({ name, inputSchema }) => [
                name,
                antigravitySchemaContract(inputSchema),
              ]),
            ),
          ) +
          "\n",
      );
    }
    if (this.config.cliProtocol === "acp") {
      // Replace only bridge-owned guidance, preserving arbitrary role instructions.
      const headless =
        "Only native read_file (Path) or legacy view_file (AbsolutePath) on the exact image paths returned by an authorized tool in the CURRENT turn is allowed. Always call the native image reader before describing those pixels; MCP path text is not visual evidence. Never read other files or reuse a previous turn image path; request the original bridge tool again. ";
      managedFile(
        agentFile,
        fs
          .readFileSync(agentFile, "utf8")
          .replace("  - view_file\n", "")
          .replace(
            headless,
            "Authorized MCP image content blocks contain visible pixels. Inspect those pixels directly; never read files to view an image. ",
          ),
      );
    }
    const settings = path.join(workspace, "settings.json");
    managedFile(
      settings,
      JSON.stringify({
        toolPermission: "request-review",
        useG1Credits: false,
        permissions: {
          deny: [
            "command(*)",
            "write_file(*)",
            "read_url(*)",
            "execute_url(*)",
          ],
          allow: [
            ...[...names].map((name) => `mcp(qq-agents/${name})`),
            ...(this.config.cliProtocol === "acp"
              ? []
              : [
                  `read_file(${(mediaRoot || media.prepare()).replaceAll("\\", "/")}/*)`,
                ]),
          ],
        },
      }),
    );
    return settings;
  }
  /** @param {RunParams} params @param {string} workspace @param {string} settings
   * @param {string} endpoint @param {string} token */
  spawnCli(params, workspace, settings, endpoint, token) {
    const childEnv = isolatedEnv();
    if (process.platform === "win32") {
      // The CLI may execute hooks outside the chat workspace. Resolve only
      // this bridge-owned batch entry through the turn's child environment.
      childEnv.PATH = [workspace, childEnv.PATH]
        .filter(Boolean)
        .join(path.delimiter);
    }
    if (this.config.cliProtocol === "acp")
      return this.spawn(
        process.execPath,
        [
          path.join(here, "antigravity-acp.mjs"),
          JSON.stringify({
            command: this.config.command || "agy",
            profile: this.profile,
            settings,
            workspace,
            model: this.config.model,
            effort: this.config.effort,
            session: params.session?.id,
          }),
        ],
        {
          cwd: workspace,
          env: { ...childEnv, QQ_AGY_ENDPOINT: endpoint, QQ_AGY_TOKEN: token },
          stdio: ["pipe", "pipe", "pipe"],
          detached: process.platform !== "win32",
          windowsHide: true,
        },
      );
    return this.spawn(
      this.config.command || "agy",
      [
        ...this.profileArgs(),
        "--settings",
        settings,
        "--agent",
        "qq-agents",
        "--disable-slash-commands",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        ...(this.config.model ? ["--model", this.config.model] : []),
        ...(this.config.effort ? ["--effort", this.config.effort] : []),
        ...(params.session ? ["--conversation", params.session.id] : []),
      ],
      {
        cwd: workspace,
        env: {
          ...childEnv,
          QQ_AGY_ENDPOINT: endpoint,
          QQ_AGY_TOKEN: token,
        },
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      },
    );
  }
  /** @param {RunParams} params @param {ReturnType<AntigravityBackend["prepare"]>} details @param {string} id */
  bindSession(params, details, id) {
    managedFile(
      details.binding,
      JSON.stringify({
        id,
        signature: details.signature,
        contract: sessionContract(this, params.tools),
      }),
    );
    params.saveSession({
      backend: "antigravity",
      id,
      signature: details.signature,
    });
  }
  /** Unverified native recovery is retired independently of the model outcome.
   * @param {RunParams} params @param {string} binding @param {number} start */
  retireCompletedSession(params, binding, start) {
    // Revoke the persisted reference even if a local binding cannot be replaced.
    antigravityDiagnostic(params, start, {
      origin: "finalization",
      phase: "settled",
      sessionDisposition: "retiring",
    });
    params.saveSession(null);
    antigravityDiagnostic(params, start, {
      origin: "finalization",
      phase: "settled",
      sessionDisposition: "retired",
    });
    try {
      if (fs.existsSync(binding)) managedFile(binding, "{}\n");
    } catch {
      console.warn("Antigravity retired binding cleanup failed");
    }
  }
  /** @param {RunParams} params */
  async runReusable(params) {
    const start = performance.now();
    if (this.closing) throw Error("ANTIGRAVITY_CLOSED");
    if (params.signal.aborted) throw Error("ABORTED");
    const signature = this.sessionSignature(params.tools);
    assertSession(params.session, "antigravity", signature);
    const details = await beforeSessionInput(params.session, async () => {
      const prepared = this.prepare(params, signature);
      // Acquire ownership before the preparation wrapper yields to another run.
      this.conversations.add(prepared.key);
      return prepared;
    });
    let worker = this.workers.get(details.key);
    let inputSubmitted = false;
    let finishDone = () => {};
    const entry = {
      abort: () => {
        if (worker) void worker.close();
      },
      done: new Promise((resolve) => {
        finishDone = () => resolve(undefined);
      }),
    };
    this.active.add(entry);
    try {
      if (worker && !worker.matches(params, signature)) {
        await worker.close();
        worker = undefined;
      }
      if (this.closing || params.signal.aborted) throw Error("ABORTED");
      if (!worker) {
        worker = new AntigravityStreamWorker(this, details, params);
        this.workers.set(details.key, worker);
      }
      const preparationMs = performance.now() - start;
      await worker.run({
        ...params,
        onInputSubmitted: () => {
          inputSubmitted = true;
          params.onInputSubmitted?.();
        },
        onTiming: (value) =>
          params.onTiming?.({
            ...value,
            elapsedMs: preparationMs + value.elapsedMs,
          }),
      });
      if (!worker.available)
        this.retireCompletedSession(params, details.binding, start);
      else
        antigravityDiagnostic(params, start, {
          origin: "finalization",
          phase: "settled",
          sessionDisposition: "retained",
        });
      if (worker.available && !this.closing) {
        worker.idle(this.config.cliReuse?.idleTimeoutMs ?? 600000);
        const idle = [...this.workers.values()]
          .filter((value) => !value.turn)
          .sort((a, b) => a.lastUsed - b.lastUsed);
        const limit = this.config.cliReuse?.maxIdleProcesses ?? 2;
        for (const unused of idle.slice(0, Math.max(0, idle.length - limit))) {
          try {
            await unused.close();
          } catch {
            // Pool housekeeping must not invalidate a completed turn or expose
            // cleanup diagnostics that may contain private filesystem details.
            console.warn("Antigravity idle worker cleanup failed");
          }
        }
      }
    } catch (error) {
      if (worker) {
        try {
          await worker.close();
        } catch {
          // Teardown cannot replace the input-stage evidence or the original failure.
          console.warn("Antigravity worker cleanup failed");
        }
      }
      if (
        params.session &&
        !params.signal.aborted &&
        error instanceof Error &&
        !inputSubmitted
      )
        throw new SessionPreparationFailure(error);
      if (fs.existsSync(details.binding)) managedFile(details.binding, "{}\n");
      params.saveSession(null);
      throw error;
    } finally {
      this.active.delete(entry);
      this.conversations.delete(details.key);
      finishDone();
    }
  }
  /** @param {{windowId?: string, actorGeneration?: string}} [filter] */
  async closeSocialSessions(filter = {}) {
    await closeSocialSessions(this, filter);
  }
  /** @param {any} params */
  async runSocial(params) {
    return runNativeSocial(this, params, async (session, conversation) => {
      const key = createHash("sha256").update(conversation).digest("hex");
      try {
        fs.rmSync(path.join(this.root, "workspaces", key), {
          recursive: true,
          force: true,
        });
        if (session)
          for (const suffix of ["", "-wal", "-shm"])
            fs.rmSync(
              path.join(
                this.profile,
                "cli",
                "conversations",
                session.id + ".db" + suffix,
              ),
              { force: true },
            );
      } catch {
        throw Error("SOCIAL_CONTEXT_FINALIZATION_FAILED");
      }
    });
  }
  /** @param {RunParams} params */
  async run(params) {
    if (
      this.config.cliProtocol !== "acp" &&
      !params.social &&
      this.config.cliReuse?.enabled
    )
      return this.runReusable(params);
    const timingStart = performance.now();
    const timing = (/** @type {string} */ phase) =>
      params.onTiming?.({
        phase,
        elapsedMs: performance.now() - timingStart,
        processReused: false,
      });
    if (this.closing) throw Error("ANTIGRAVITY_CLOSED");
    if (params.signal.aborted) throw Error("ABORTED");
    const signature = this.sessionSignature(params.tools);
    assertSession(params.session, "antigravity", signature);
    const details = await beforeSessionInput(params.session, async () =>
      this.prepare(params, signature),
    );
    const { key, workspace, binding } = details;
    const token = randomBytes(32).toString("hex");
    let resolveInput = () => {};
    let rejectInput = (/** @type {unknown} */ _error) => {};
    const inputSubmission = new Promise((resolve, reject) => {
      resolveInput = () => resolve(undefined);
      rejectInput = reject;
    });
    void inputSubmission.catch(() => {});
    let live = true;
    let hookDenied = false;
    let ioFailed = false;
    let diagnosticActive = true;
    let terminalObserved = false;
    const pending = new Set();
    const diagnosticEvent = (/** @type {Record<string, unknown>} */ value) =>
      diagnosticActive && antigravityDiagnostic(params, timingStart, value);
    const media = new AntigravityMedia(
      undefined,
      this.config.cliProtocol === "acp",
    );
    const names = new Set(params.tools.map((tool) => tool.name));
    const server = http.createServer(async (req, res) => {
      const reply = (
        /** @type {number} */ status,
        /** @type {unknown} */ body,
      ) => {
        if (res.destroyed || res.writableEnded) return;
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.headers.authorization !== `Bearer ${token}` || req.headers.origin)
        return reply(403, { error: "ANTIGRAVITY_TURN_INACTIVE" });
      if (req.method === "GET" && req.url === "/lease")
        return reply(200, { alive: true });
      if (!live || params.signal.aborted)
        return reply(403, { error: "ANTIGRAVITY_TURN_INACTIVE" });
      if (req.method === "POST" && req.url === "/hook-denied") {
        // The trusted hook reports only a denial bit, never paths or arguments.
        hookDenied = true;
        return reply(200, {});
      }
      if (req.method === "GET" && req.url === "/catalog")
        return reply(200, {
          tools: params.tools,
          nativeMcp: this.config.cliProtocol === "acp",
          images: media.catalog(),
        });
      if (req.method !== "POST" || req.url !== "/call") return reply(404, {});
      /** @type {import("./session-contract.mjs").ToolSpec | undefined} */
      let spec;
      try {
        let body = "";
        for await (const part of req) {
          body += part;
          if (body.length > 1048576) return reply(413, {});
        }
        const value = JSON.parse(body);
        await inputSubmission;
        if (!live || params.signal.aborted || !names.has(value.name))
          return reply(403, {});
        spec = params.tools.find((tool) => tool.name === value.name);
        const accepted = Promise.resolve().then(() => {
          if (
            cancelled ||
            params.signal.aborted ||
            (!live && !terminalObserved)
          )
            throw Error("ABORTED");
          return params.callTool(value.name, value.arguments || {});
        });
        pending.add(accepted);
        let result;
        try {
          result = await accepted;
        } finally {
          pending.delete(accepted);
        }
        if (!live || params.signal.aborted) return reply(403, {});
        // ACP can replace large textual MCP results with a file path. The
        // model must receive the inline review page before it can act on it.
        const inlineChatInput =
          this.config.cliProtocol === "acp" &&
          ((result && typeof result === "object" && "preparation" in result) ||
            [
              "conversation_read",
              "memory_read",
              "qq_wait_for_messages",
            ].includes(value.name));
        const { wire: content, receipt } = await finalizeMcpOutput(
          params,
          result,
          (value) => media.fromTool(value, params.signal),
          inlineChatInput ? 8192 : undefined,
        );
        if (!live || params.signal.aborted) return reply(403, {});
        res.once("finish", () => {
          if (live && !params.signal.aborted)
            params.commitToolOutput?.(receipt, toolOutputText(content));
        });
        reply(200, content);
      } catch (error) {
        const { wire: content, receipt } = await finalizeMcpOutput(
          params,
          error,
          (value) => {
            if (spec && value.isError) {
              const failure = JSON.parse(value.content[0].text);
              if (failure.code === "INVALID_TOOL_ARGUMENTS")
                value.content[0].text = JSON.stringify({
                  ...failure,
                  tool: { name: spec.name, inputSchema: spec.inputSchema },
                });
            }
            return value;
          },
        );
        res.once("finish", () => {
          if (live && !params.signal.aborted)
            params.commitToolOutput?.(receipt, toolOutputText(content));
        });
        reply(200, content);
      }
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve(undefined));
    });
    if (this.conversations.has(key)) {
      server.close();
      throw Error("ANTIGRAVITY_CONVERSATION_BUSY");
    }
    this.conversations.add(key);
    const endpoint = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}`;
    /** @type {import("node:child_process").ChildProcess | undefined} */
    let child;
    /** @type {NodeJS.Timeout | undefined} */
    let force;
    let cancelled = false;
    let inputSubmitted = false;
    let abortSettlement = () => {};
    let modelSucceeded = false;
    const abort = () => {
      if (cancelled) return;
      cancelled = true;
      live = false;
      rejectInput(Error("ABORTED"));
      abortSettlement();
      server.closeAllConnections();
      if (child) {
        this.stop(child, "SIGINT");
        force = setTimeout(() => {
          if (child) this.stop(child, "SIGKILL");
        }, 2000);
      }
    };
    let finishDone = () => {};
    const entry = {
      abort,
      done: new Promise((resolve) => {
        finishDone = () => resolve(undefined);
      }),
    };
    this.active.add(entry);
    params.signal.addEventListener("abort", abort, { once: true });
    try {
      const settings = this.configure(params, details, media);
      if (params.signal.aborted || cancelled || this.closing)
        throw Error("ABORTED");
      child = this.spawnCli(params, workspace, settings, endpoint, token);
      timing("prepared");
      let buffer = "",
        diagnostic = "",
        bytes = 0,
        initialized = false,
        initializedId = "";
      /** @type {any} */ let terminal;
      let lastResponseStep = -1;
      let responseSeen = false;
      /** @type {number | null} */ let contextTokens = null;
      /** @type {Error | undefined} */ let protocolError;
      const fail = () => {
        diagnosticEvent({
          origin: "protocol",
          phase: "running",
          trustedTerminal: false,
          backendOutcome: "failed",
        });
        protocolError = Error("ANTIGRAVITY_PROTOCOL_ERROR");
        live = false;
        if (child) this.stop(child, "SIGKILL");
      };
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (data) => {
        bytes += data.length;
        if (bytes > MAX_OUTPUT) return fail();
        buffer += data;
        while (buffer.includes("\n")) {
          const end = buffer.indexOf("\n"),
            line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (event.event === "init") {
              if (
                terminal ||
                initialized ||
                !uuid.test(event.conversation_id) ||
                (params.session && params.session.id !== event.conversation_id)
              )
                return fail();
              initialized = true;
              timing("initialized");
              initializedId = event.conversation_id;
              if (live && !cancelled && !params.signal.aborted) {
                managedFile(
                  binding,
                  JSON.stringify({
                    id: event.conversation_id,
                    signature,
                    contract: sessionContract(this, params.tools),
                  }),
                );
                params.saveSession({
                  backend: "antigravity",
                  id: event.conversation_id,
                  signature,
                });
              }
            } else if (event.event === "step_update") {
              const step = event.step_update;
              if (
                live &&
                initialized &&
                !terminal &&
                step?.conversation_id === initializedId &&
                step.step_type === "agent_response" &&
                Number.isSafeInteger(step.step_index) &&
                step.step_index >= 0 &&
                step.step_index >= lastResponseStep
              ) {
                if (step.step_index > lastResponseStep) {
                  lastResponseStep = step.step_index;
                  contextTokens = null;
                }
                if (step.state === "DONE") {
                  contextTokens = responseOccupancy(step.usage);
                  if (!responseSeen) {
                    responseSeen = true;
                    timing("firstResponse");
                  }
                  timing("lastResponse");
                }
              }
            } else if (event.event === "result") {
              if (
                !initialized ||
                terminal ||
                event.result?.conversation_id !== initializedId ||
                (event.result?.status === "SUCCESS" && !responseSeen)
              )
                return fail();
              terminal = event.result;
              terminalObserved = true;
              timing("terminal");
              diagnosticEvent({
                origin: "terminal",
                phase: "terminal-observed",
                terminalStatus: terminal.status,
                trustedTerminal: true,
              });
              // Revoke before process teardown; a trailing tool cannot use a completed turn.
              live = false;
            }
          } catch {
            return fail();
          }
        }
      });
      child.stderr?.on("data", (data) => {
        diagnostic = (diagnostic + data).slice(-65536);
      });
      const completed = new Promise((resolve, reject) => {
        child?.once("error", () => {
          diagnosticEvent({
            origin: "process-exit",
            phase: terminal ? "settling" : "preparing",
            trustedTerminal:
              Boolean(terminal) && !protocolError && !buffer.trim(),
            workerOutcome: "exit-warning",
          });
          if (terminal) {
            ioFailed = true;
            resolve(null);
          } else {
            const failure = Error("ANTIGRAVITY_NOT_FOUND");
            rejectInput(failure);
            reject(failure);
          }
        });
        child?.once("close", (code, signal) => {
          live = false;
          diagnosticEvent({
            origin: "process-exit",
            phase: "settling",
            trustedTerminal:
              Boolean(terminal) && !protocolError && !buffer.trim(),
            exitCode: code,
            signal,
            wrapperError: diagnostic.includes("AGY_BACKGROUND_START_FAILED"),
            workerOutcome:
              code === 0 && !signal && !ioFailed ? "recycled" : "exit-warning",
          });
          resolve(code);
        });
        child?.stdin?.once("error", (error) => {
          ioFailed = true;
          diagnosticEvent({
            origin: "stdin",
            phase: terminal ? "settling" : "running",
            ioCode: /** @type {NodeJS.ErrnoException} */ (error).code,
            trustedTerminal:
              Boolean(terminal) && !protocolError && !buffer.trim(),
            workerOutcome: "exit-warning",
          });
          if (!terminal) {
            const failure = antigravityFailure(diagnostic);
            rejectInput(failure);
            reject(failure);
          }
          if (child) this.stop(child, "SIGKILL");
        });
      });
      // Startup can fail while the submission fence is still being awaited.
      void completed.catch(() => {});
      // Prompts and credentials never appear in process arguments. EOF ends this
      // turn's process after its result; subsequent turns explicitly resume by ID.
      await params.beforeInputSubmitted?.();
      if (params.signal.aborted) throw Error("ABORTED");
      inputSubmitted = true;
      child.stdin?.write(
        JSON.stringify({
          event: "user",
          message: {
            content: params.prompt + (params.appendPrompt?.() || ""),
            ...(this.config.cliProtocol === "acp"
              ? { inputImages: params.inputImages }
              : {}),
          },
        }) + "\n",
        (error) => {
          if (error) return rejectInput(error);
          if (
            cancelled ||
            params.signal.aborted ||
            protocolError ||
            (!live && !terminalObserved)
          )
            return rejectInput(Error("ABORTED"));
          try {
            params.onInputSubmitted?.();
            timing("inputSubmitted");
            resolveInput();
          } catch (error) {
            rejectInput(error);
          }
        },
      );
      child.stdin?.end();
      await inputSubmission;
      const code = await completed;
      if (cancelled || params.signal.aborted) throw Error("ABORTED");
      if (protocolError) throw protocolError;
      if (buffer.trim()) {
        fail();
        throw protocolError;
      }
      if (!terminal)
        throw antigravityFailure(diagnostic, undefined, hookDenied);
      let rejectCancelled = () => {};
      const cancellation = new Promise((_, reject) => {
        rejectCancelled = () => reject(Error("ABORTED"));
        abortSettlement = rejectCancelled;
        params.signal.addEventListener("abort", rejectCancelled, {
          once: true,
        });
      });
      try {
        await Promise.race([Promise.allSettled([...pending]), cancellation]);
      } finally {
        abortSettlement = () => {};
        params.signal.removeEventListener("abort", rejectCancelled);
      }
      if (cancelled || params.signal.aborted) throw Error("ABORTED");
      if (protocolError) throw protocolError;
      if (terminal?.status !== "SUCCESS")
        throw antigravityFailure(
          diagnostic + " " + (terminal?.error || ""),
          terminal?.status,
          hookDenied,
        );
      if (contextTokens !== null)
        params.onUsage?.({
          source: "measured",
          contextTokens,
          basis:
            "Antigravity latest completed agent_response input_tokens + cache_read_tokens + output_tokens; excludes cumulative result and auxiliary steps",
        });
      modelSucceeded = true;
      diagnosticEvent({
        origin: "finalization",
        phase: "settled",
        trustedTerminal: true,
        backendOutcome: "success",
      });
      if (code !== 0 || child.signalCode || ioFailed)
        this.retireCompletedSession(params, binding, timingStart);
      else
        diagnosticEvent({
          origin: "finalization",
          phase: "settled",
          sessionDisposition: "retained",
        });
    } catch (error) {
      diagnosticEvent({
        origin: "finalization",
        phase: "settled",
        backendOutcome:
          cancelled || params.signal.aborted
            ? "cancelled"
            : modelSucceeded
              ? "success"
              : "failed",
      });
      if (
        params.session &&
        !params.signal.aborted &&
        error instanceof Error &&
        (!inputSubmitted || !child?.pid)
      )
        throw new SessionPreparationFailure(error);
      if (fs.existsSync(binding)) managedFile(binding, "{}\n");
      params.saveSession(null);
      throw error;
    } finally {
      diagnosticActive = false;
      live = false;
      rejectInput(Error("ABORTED"));
      try {
        media.close();
      } catch {
        // Local media cleanup must not turn a confirmed success into a backend failure.
        console.warn("Antigravity turn media cleanup failed");
      }
      params.signal.removeEventListener("abort", abort);
      if (force) clearTimeout(force);
      if (child) this.stop(child, "SIGKILL");
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      this.active.delete(entry);
      finishDone();
      this.conversations.delete(key);
      timing("complete");
    }
  }
  async cancel() {
    for (const entry of this.active) entry.abort();
    await Promise.all(
      [...this.workers.values()].map((worker) => worker.close()),
    );
    await Promise.all([...this.active].map((e) => e.done));
  }
  async close() {
    this.closing = true;
    await this.cancel();
    await this.closeSocialSessions();
    await this.external.close();
  }
}
