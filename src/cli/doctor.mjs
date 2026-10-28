// Pre-flight checks for people and AI assistants (see docs/AI-INSTALL.md).
//
//   node src/cli/doctor.mjs [--data dir] [--json]
//
// Read-only: it never sends a QQ message, never changes config and never
// prints a secret value. Exit code 1 when any check fails.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateConfig } from "../core/config.mjs";
import { readLocalSecrets } from "../core/local-secrets.mjs";
import { OneBot } from "../transport/onebot.mjs";
import { BackendRegistry } from "../backends/index.mjs";

const PLACEHOLDER_ACCOUNTS = new Set(["10001", "10002"]);
const withTimeout = (promise, ms, code) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(code)), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
};
// Only stable codes leave this tool: transport errors can carry tokens or paths.
const codeOf = (error) =>
  /^[A-Z][A-Z0-9_]+$/.test(error?.message || "")
    ? error.message
    : error?.cause?.code || error?.code || "CHECK_FAILED";

/** Environment variable names the config refers to (never their values). */
export function referencedSecrets(config) {
  const names = new Set();
  for (const c of config.connections) {
    if (c.tokenEnv) names.add(c.tokenEnv);
    for (const v of Object.values(c.process?.env || {})) names.add(v);
  }
  for (const b of config.backends) {
    if (b.apiKeyEnv) names.add(b.apiKeyEnv);
    for (const v of Object.values(b.env || {})) names.add(v);
    for (const s of b.toolServers || [])
      for (const v of [
        ...Object.values(s.env || {}),
        ...Object.values(s.headers || {}),
      ])
        names.add(v);
  }
  for (const a of config.agents) {
    if (a.github?.enabled && a.github.auth === "token" && a.github.tokenEnv)
      names.add(a.github.tokenEnv);
    if (a.operations?.enabled && a.operations?.totpEnv)
      names.add(a.operations.totpEnv);
  }
  return [...names];
}

const onebotFix = {
  ONEBOT_HTTP_ERROR:
    "NapCat 拒绝了请求：核对 NapCat HTTP 服务器的 token 与 secrets.json 中的值一致，然后重启 NapCat",
  QQ_ACCOUNT_MISMATCH:
    "NapCat 当前登录的不是配置中的 QQ 号：在 NapCat 里登录正确的号，或修改 accountId",
  ECONNREFUSED:
    "连不上 NapCat：确认 NapCat 正在运行、已扫码登录，且 OneBot HTTP 服务器已开启在配置的端口",
  ENOTFOUND:
    "找不到 OneBot 主机：Docker 服务名只能在容器网络内解析，请在 qq-agents 容器里运行 doctor",
  ONEBOT_TIMEOUT:
    "NapCat 没有响应：确认 QQ 已登录完成（扫码后需要等几秒），再重试",
};
const backendFix = {
  OPENAI_AUTH_FAILED: "API key 被拒绝：重新运行 setup secret 写入正确的 key",
  OPENAI_UNREACHABLE: "连不上模型服务：检查 baseUrl 和网络",
  BACKEND_MODEL_UNAVAILABLE: "服务可用但没有配置的模型：改成服务商列出的模型名",
  CODEX_DEDICATED_LOGIN_REQUIRED:
    "Codex 专用目录尚未登录：以该目录为 CODEX_HOME 运行 codex login（见 docs/GETTING-STARTED.md）",
  DSH_NOT_FOUND: "未找到 DSH：先打开 DeepSeek Harness 桌面应用",
};

export async function runDoctor({
  root,
  env = process.env,
  fetchImpl = fetch,
  probeBackends = true,
  registry = new BackendRegistry(),
} = {}) {
  const checks = [];
  const add = (id, status, detail, fix) =>
    checks.push({ id, status, detail, ...(fix ? { fix } : {}) });

  const major = Number(process.versions.node.split(".")[0]);
  add(
    "node",
    major >= 24 ? "ok" : "fail",
    "Node.js " + process.versions.node,
    major >= 24 ? undefined : "安装 Node.js 24 或更高版本",
  );
  for (const [tool, variable] of [
    ["ffmpeg", "FFMPEG_PATH"],
    ["ffprobe", "FFPROBE_PATH"],
  ]) {
    const run = spawnSync(env[variable] || tool, ["-version"], {
      stdio: "ignore",
      timeout: 5000,
      windowsHide: true,
    });
    add(
      tool,
      run.status === 0 ? "ok" : "warn",
      run.status === 0
        ? "available"
        : "not found (voice and GIF reading need it)",
      run.status === 0
        ? undefined
        : `安装 FFmpeg，或用 ${variable} 指向可执行文件`,
    );
  }

  const configFile = path.join(root, "config.json");
  let config;
  try {
    config = validateConfig(JSON.parse(fs.readFileSync(configFile, "utf8")));
    add("config", "ok", configFile);
  } catch (error) {
    add(
      "config",
      "fail",
      fs.existsSync(configFile) ? "invalid configuration" : "missing",
      fs.existsSync(configFile)
        ? "运行 npm run setup -- init --answers <文件> --force 重新生成"
        : "运行 npm run setup -- init --answers <文件>",
    );
    return summarize(checks);
  }
  for (const c of config.connections)
    if (PLACEHOLDER_ACCOUNTS.has(c.accountId))
      add(
        "config.placeholder",
        "warn",
        `connection ${c.id} still uses the example QQ number`,
        "运行 npm run setup -- init 写入真实 QQ 号",
      );

  let secrets = {};
  try {
    secrets = readLocalSecrets(root);
  } catch {
    add(
      "secrets",
      "fail",
      "secrets.json is not a name → string map",
      "修正或删除 secrets.json 后重新运行 setup secret",
    );
  }
  const lookup = { ...secrets, ...env };
  for (const name of referencedSecrets(config))
    add(
      "secret:" + name,
      lookup[name] ? "ok" : "fail",
      lookup[name] ? "set" : "missing",
      lookup[name] ? undefined : `npm run setup -- secret ${name}`,
    );

  let running = null;
  try {
    const token = fs
      .readFileSync(path.join(root, "admin-token"), "utf8")
      .trim();
    const response = await fetchImpl(
      `http://127.0.0.1:${config.port}/api/status`,
      {
        headers: { "x-admin-token": token },
        signal: AbortSignal.timeout(3000),
      },
    );
    if (response.ok) running = await response.json();
  } catch {
    // Not running, or no admin token yet.
  }
  if (running) {
    add(
      "console",
      "ok",
      `running on 127.0.0.1:${config.port}, mode ${running.mode}, ${running.globalPaused ? "globally paused" : "not paused"}`,
    );
    for (const a of running.agents || [])
      add(
        "agent:" + a.id,
        a.blockers?.length ? "warn" : "ok",
        a.blockers?.length
          ? "cannot speak: " + a.blockers.join(", ")
          : "can speak in allowlisted conversations",
        a.blockers?.length
          ? "对照 docs/TROUBLESHOOTING.md#机器人不说话 逐项解除"
          : undefined,
      );
  } else
    add(
      "console",
      fs.existsSync(path.join(root, "process.lock")) ? "warn" : "skip",
      fs.existsSync(path.join(root, "process.lock"))
        ? "process.lock exists but the console does not answer"
        : "not running",
      fs.existsSync(path.join(root, "process.lock"))
        ? "确认没有旧进程后删除 process.lock（见 docs/WINDOWS.md 第 5 节或 docs/TROUBLESHOOTING.md）"
        : undefined,
    );

  // Probes run with secrets.json applied, as the console would see them.
  const saved = {};
  for (const [name, value] of Object.entries(secrets))
    if (!process.env[name]) {
      saved[name] = process.env[name];
      process.env[name] = value;
    }
  try {
    const used = new Set(config.agents.map((a) => a.connectionId));
    for (const c of config.connections.filter((c) => used.has(c.id))) {
      try {
        const status = await withTimeout(
          new OneBot(c, { fetchImpl }).status(),
          8000,
          "ONEBOT_TIMEOUT",
        );
        add(
          "onebot:" + c.id,
          status.online ? "ok" : "warn",
          `logged in as the configured account${status.online ? ", online" : ", but not online"}`,
        );
      } catch (error) {
        const code = codeOf(error);
        add(
          "onebot:" + c.id,
          "fail",
          code,
          code === "ONEBOT_TOKEN_ENV_MISSING"
            ? `npm run setup -- secret ${c.tokenEnv}`
            : onebotFix[code],
        );
      }
    }
    if (probeBackends)
      for (const a of config.agents) {
        const b = config.backends.find((x) => x.id === a.backendId);
        if (!b) continue;
        if (running && b.type === "codex") {
          add(
            "backend:" + b.id,
            "skip",
            "console is running; a second Codex app-server would share its home",
            "在管理台「连接」页对该后端执行“检测连接”",
          );
          continue;
        }
        let backend;
        try {
          backend = registry.create({ ...b, model: a.model || b.model }, a, {
            root,
          });
          const health = await withTimeout(
            backend.health ? backend.health() : backend.models(),
            30000,
            "BACKEND_PROBE_TIMEOUT",
          );
          const models = Array.isArray(health) ? health : health.models;
          add(
            "backend:" + b.id,
            "ok",
            `${b.type}: ${models.length} model(s) available`,
          );
        } catch (error) {
          const code = codeOf(error);
          add(
            "backend:" + b.id,
            "fail",
            `${b.type}: ${code}`,
            code === "OPENAI_API_KEY_ENV_MISSING"
              ? `npm run setup -- secret ${b.apiKeyEnv}`
              : backendFix[code],
          );
        } finally {
          await backend?.close?.().catch(() => {});
        }
      }
  } finally {
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  }
  return summarize(checks);
}

function summarize(checks) {
  const failed = checks.filter((c) => c.status === "fail").length;
  return {
    ok: failed === 0,
    failed,
    warnings: checks.filter((c) => c.status === "warn").length,
    checks,
  };
}

const mark = { ok: "✔", warn: "!", fail: "✖", skip: "-" };
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const root = path.resolve(
    args.includes("--data") ? args[args.indexOf("--data") + 1] : ".runtime",
  );
  const report = await runDoctor({ root });
  if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else
    for (const c of report.checks)
      console.log(
        `${mark[c.status]} ${c.id}: ${c.detail}${c.fix ? `\n    → ${c.fix}` : ""}`,
      );
  process.exitCode = report.ok ? 0 : 1;
}
