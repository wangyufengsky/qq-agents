// @ts-check
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import crossSpawn from "cross-spawn";
import { execFileSync } from "node:child_process";
import { buildChildEnv } from "../core/child-env.mjs";
import { ExternalTools } from "./external.mjs";
import { assertSession, sessionSignature } from "./session-contract.mjs";
import { BackendTurnFailure } from "./turn-failure.mjs";
import { mcpResult } from "../tools/index.mjs";
import { safeToolFailure } from "../tools/errors.mjs";

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
/** @param {string} text @param {string} status */
export function antigravityFailure(text, status = "ERROR") {
  // Match categories only. Provider diagnostics never become an error message.
  const category = /RESOURCE_EXHAUSTED|quota|429/i.test(text)
    ? "quota"
    : /UNAUTHENTICATED|authentication required|sign.?in|login required/i.test(
          text,
        )
      ? "authentication"
      : /context.*(?:limit|exceed)|too many tokens/i.test(text)
        ? "context-limit"
        : /permission|hook|denied/i.test(text)
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
    this.config = config;
    this.agent = agent;
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
    this.closing = false;
  }
  /** @param {import("./session-contract.mjs").ToolSpec[]} tools */
  sessionSignature(tools) {
    // Existing native sessions retain their old system prompt. Hand off once
    // rather than resume a session without the explicit parameter contract.
    return "antigravity-tools-v2:" + sessionSignature(this, tools);
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
        !["mcp_config.json", "projects", ".migrated"].includes(name) ||
        fs.lstatSync(path.join(configuration, name)).isSymbolicLink()
      )
        throw Error("ANTIGRAVITY_PROFILE_UNSAFE");
    for (const name of ["GEMINI.md", "AGENTS.md", "skills", "hooks.json"])
      if (fs.existsSync(path.join(this.profile, name)))
        throw Error("ANTIGRAVITY_PROFILE_UNSAFE");
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
  /** @param {RunParams} params */
  async run(params) {
    if (this.closing) throw Error("ANTIGRAVITY_CLOSED");
    if (params.signal.aborted) throw Error("ABORTED");
    const signature = this.sessionSignature(params.tools);
    assertSession(params.session, "antigravity", signature);
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
        bound?.signature !== signature
      ) {
        params.saveSession(null);
        throw Error("ANTIGRAVITY_SESSION_UNAVAILABLE");
      }
    }
    const token = randomBytes(32).toString("hex");
    let live = true;
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
      if (
        !live ||
        params.signal.aborted ||
        req.headers.authorization !== `Bearer ${token}` ||
        req.headers.origin
      )
        return reply(403, { error: "ANTIGRAVITY_TURN_INACTIVE" });
      if (req.method === "GET" && req.url === "/catalog")
        return reply(200, { tools: params.tools });
      if (req.method !== "POST" || req.url !== "/call") return reply(404, {});
      let spec;
      try {
        let body = "";
        for await (const part of req) {
          body += part;
          if (body.length > 1048576) return reply(413, {});
        }
        const value = JSON.parse(body);
        if (!live || params.signal.aborted || !names.has(value.name))
          return reply(403, {});
        spec = params.tools.find((tool) => tool.name === value.name);
        const result = await params.callTool(value.name, value.arguments || {});
        if (!live || params.signal.aborted) return reply(403, {});
        reply(200, mcpResult(result));
      } catch (error) {
        const failure = safeToolFailure(error);
        reply(200, {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ...failure,
                ...(failure.code === "INVALID_TOOL_ARGUMENTS" && spec
                  ? {
                      tool: { name: spec.name, inputSchema: spec.inputSchema },
                    }
                  : {}),
              }),
            },
          ],
        });
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
    const abort = () => {
      if (cancelled) return;
      cancelled = true;
      live = false;
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
      const hook = [process.execPath, path.join(here, "antigravity-guard.mjs")]
        .map((v) => antigravityShellQuote(v))
        .join(" ");
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
      if (
        !params.session ||
        params.instructions !== undefined ||
        !fs.existsSync(agentFile)
      )
        managedFile(
          agentFile,
          `---\nname: qq-agents\ndescription: QQ Agents restricted role\nmainAgent: true\nsubagent: false\ntools:\n  - finish\nenable_mcp_tools: true\ncommandExecutionPolicy: off\n---\n${params.instructions || ""}\n\nUse only the qq-agents MCP tools. Call call_mcp_tool with ServerName="qq-agents", ToolName equal to an allowed name, and Arguments matching that tool's JSON schema below. Do not guess parameter names or read framework source to discover arguments. The current chat and authorization are bound by the bridge; never add target, chatId or context fields unless the schema requires them. Ordinary assistant text is never delivered to QQ. No native task, filesystem, shell, browser, scheduling or subagent actions are authorized.\n\nAllowed tool argument schemas (required fields and additionalProperties are binding):\n${params.tools.map(({ name, inputSchema }) => JSON.stringify({ name, inputSchema })).join("\n")}\n`,
        );
      const settings = path.join(workspace, "settings.json");
      managedFile(
        settings,
        JSON.stringify({
          toolPermission: "request-review",
          useG1Credits: false,
          permissions: {
            deny: [
              "command(*)",
              "read_file(*)",
              "write_file(*)",
              "read_url(*)",
              "execute_url(*)",
            ],
            allow: [...names].map((name) => `mcp(qq-agents/${name})`),
          },
        }),
      );
      if (params.signal.aborted || cancelled || this.closing)
        throw Error("ABORTED");
      child = this.spawn(
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
            ...isolatedEnv(),
            QQ_AGY_ENDPOINT: endpoint,
            QQ_AGY_TOKEN: token,
          },
          stdio: ["pipe", "pipe", "pipe"],
          detached: process.platform !== "win32",
          windowsHide: true,
        },
      );
      let buffer = "",
        diagnostic = "",
        bytes = 0,
        initialized = false,
        initializedId = "";
      /** @type {any} */ let terminal;
      let lastResponseStep = -1;
      /** @type {number | null} */ let contextTokens = null;
      /** @type {Error | undefined} */ let protocolError;
      const fail = () => {
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
                initialized ||
                !uuid.test(event.conversation_id) ||
                (params.session && params.session.id !== event.conversation_id)
              )
                return fail();
              initialized = true;
              initializedId = event.conversation_id;
              if (live && !cancelled && !params.signal.aborted) {
                managedFile(
                  binding,
                  JSON.stringify({ id: event.conversation_id, signature }),
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
                if (step.state === "DONE")
                  contextTokens = responseOccupancy(step.usage);
              }
            } else if (event.event === "result") {
              if (
                !initialized ||
                terminal ||
                event.result?.conversation_id !== initializedId
              )
                return fail();
              terminal = event.result;
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
        child?.once("error", () => reject(Error("ANTIGRAVITY_NOT_FOUND")));
        child?.once("close", resolve);
        child?.stdin?.once("error", () => {
          /* Process exit is classified below. */
        });
      });
      // Prompts and credentials never appear in process arguments. EOF ends this
      // turn's process after its result; subsequent turns explicitly resume by ID.
      child.stdin?.end(
        JSON.stringify({ event: "user", message: { content: params.prompt } }) +
          "\n",
      );
      const code = await completed;
      if (cancelled || params.signal.aborted) throw Error("ABORTED");
      if (protocolError) throw protocolError;
      if (buffer.trim() || code !== 0 || terminal?.status !== "SUCCESS")
        throw antigravityFailure(
          diagnostic + " " + (terminal?.error || ""),
          terminal?.status,
        );
      if (contextTokens !== null)
        params.onUsage?.({
          source: "measured",
          contextTokens,
          basis:
            "Antigravity latest completed agent_response input_tokens + cache_read_tokens + output_tokens; excludes cumulative result and auxiliary steps",
        });
    } catch (error) {
      if (fs.existsSync(binding)) managedFile(binding, "{}\n");
      params.saveSession(null);
      throw error;
    } finally {
      live = false;
      params.signal.removeEventListener("abort", abort);
      if (force) clearTimeout(force);
      if (child) this.stop(child, "SIGKILL");
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      this.active.delete(entry);
      finishDone();
      this.conversations.delete(key);
    }
  }
  async cancel() {
    for (const entry of this.active) entry.abort();
    await Promise.all([...this.active].map((e) => e.done));
  }
  async close() {
    this.closing = true;
    await this.cancel();
    await this.external.close();
  }
}
