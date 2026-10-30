// Guided setup for people and AI assistants (see docs/AI-INSTALL.md).
//
//   node src/cli/setup.mjs init --answers answers.json|- [--data dir] [--napcat-config dir] [--force]
//   node src/cli/setup.mjs secret NAME [--data dir]        (value from a hidden prompt or stdin)
//   node src/cli/setup.mjs live --confirm [--data dir]     (console stopped)
//   node src/cli/setup.mjs unpause --confirm [--data dir]  (console running with --live)
//
// Every command prints one JSON object and never prints a secret value.
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { atomicJSON, validateConfig } from "../core/config.mjs";
import { defaultConfig } from "../core/default-config.mjs";
import { readLocalSecrets, writeLocalSecret } from "../core/local-secrets.mjs";

const qq = z.string().regex(/^\d{5,20}$/);
const envName = z.string().regex(/^[A-Z][A-Z0-9_]{0,100}$/);
const id = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const backendAnswers = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("openai"),
      baseUrl: z.string().min(1),
      model: z.string().min(1),
      apiKeyEnv: envName.nullable().default("QQ_AGENTS_API_KEY"),
      contextWindow: z.number().int().min(1024).optional(),
      vision: z.boolean().optional(),
    })
    .strict(),
  z
    .object({ type: z.literal("codex"), model: z.string().default("") })
    .strict(),
  z
    .object({
      type: z.literal("antigravity"),
      model: z.string().default(""),
      command: z.string().min(1).default("agy"),
    })
    .strict(),
  z
    .object({
      type: z.literal("dsh"),
      model: z.string().default(""),
      provider: z.string().default(""),
    })
    .strict(),
]);
export const answersSchema = z
  .object({
    qq: z
      .object({
        accountId: qq,
        httpUrl: z.string().min(1),
        wsUrl: z.string().min(1),
        tokenEnv: envName.default("QQ_AGENTS_ONEBOT_TOKEN"),
        // Docker service names such as http://napcat:3000 need this.
        allowPrivateNetwork: z.boolean().default(false),
      })
      .strict(),
    backend: backendAnswers,
    agent: z
      .object({
        id: id.default("agent-main"),
        name: z.string().min(1).max(120),
        persona: z.string().max(32000).default(""),
        aliases: z.array(z.string().min(1).max(40)).max(20).default([]),
        groups: z.array(qq).max(50).default([]),
        users: z.array(qq).max(50).default([]),
      })
      .strict(),
  })
  .strict();

const lockFile = (root) => path.join(root, "process.lock");
function assertStopped(root) {
  if (fs.existsSync(lockFile(root))) throw Error("DATA_DIRECTORY_LOCKED");
}
function backup(file) {
  if (!fs.existsSync(file)) return null;
  const copy = `${file}.before-setup-${Date.now()}`;
  fs.copyFileSync(file, copy);
  return copy;
}
const portOf = (url) => {
  const u = new URL(url);
  if (!u.port) throw Error("ONEBOT_PORT_REQUIRED");
  return Number(u.port);
};
const loopbackHost = (url) =>
  ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname);

/** Build a validated single-character config from answers. */
export function buildConfig(answers) {
  const a = answersSchema.parse(answers);
  const base = defaultConfig();
  const backendId = {
    openai: "api",
    codex: "codex",
    dsh: "dsh",
    antigravity: "antigravity",
  }[a.backend.type];
  const backend =
    a.backend.type === "openai"
      ? {
          id: backendId,
          type: "openai",
          label: "OpenAI 兼容 API",
          baseUrl: a.backend.baseUrl,
          ...(a.backend.apiKeyEnv ? { apiKeyEnv: a.backend.apiKeyEnv } : {}),
          model: a.backend.model,
          ...(a.backend.contextWindow
            ? { contextWindow: a.backend.contextWindow }
            : {}),
          ...(a.backend.vision ? { vision: true } : {}),
        }
      : {
          ...base.backends.find((b) => b.type === a.backend.type),
          ...(a.backend.type === "antigravity"
            ? {
                type: "antigravity",
                label: "Google Antigravity CLI",
                command: a.backend.command,
              }
            : {}),
          id: backendId,
          model: a.backend.model,
          ...(a.backend.type === "dsh" ? { provider: a.backend.provider } : {}),
        };
  const template = base.agents[0];
  return validateConfig({
    ...base,
    mode: "isolated",
    globalPaused: true,
    connections: [
      {
        id: "qq-main",
        label: "QQ " + a.qq.accountId,
        accountId: a.qq.accountId,
        httpUrl: a.qq.httpUrl,
        wsUrl: a.qq.wsUrl,
        tokenEnv: a.qq.tokenEnv,
        enabled: false,
        deployment: "external",
        ...(a.qq.allowPrivateNetwork ? { allowPrivateNetwork: true } : {}),
      },
    ],
    backends: [backend],
    agents: [
      {
        ...template,
        id: a.agent.id,
        name: a.agent.name,
        connectionId: "qq-main",
        backendId,
        paused: true,
        persona: a.agent.persona || template.persona,
        aliases: a.agent.aliases,
        allow: { groups: a.agent.groups, users: a.agent.users },
      },
    ],
  });
}

/**
 * NapCat's per-account OneBot 11 file with one HTTP and one forward WebSocket
 * server named qq-agents-*; other adapters in an existing file are kept.
 */
export function napcatOnebotConfig(existing, { httpUrl, wsUrl, token }) {
  const host = (url) => (loopbackHost(url) ? "127.0.0.1" : "0.0.0.0");
  const network = { ...(existing?.network || {}) };
  const keep = (list, name) =>
    (Array.isArray(list) ? list : []).filter((x) => x?.name !== name);
  network.httpServers = [
    ...keep(network.httpServers, "qq-agents-http"),
    {
      name: "qq-agents-http",
      enable: true,
      host: host(httpUrl),
      port: portOf(httpUrl),
      enableCors: false,
      enableWebsocket: false,
      messagePostFormat: "array",
      token,
      debug: false,
    },
  ];
  network.websocketServers = [
    ...keep(network.websocketServers, "qq-agents-ws"),
    {
      name: "qq-agents-ws",
      enable: true,
      host: host(wsUrl),
      port: portOf(wsUrl),
      messagePostFormat: "array",
      reportSelfMessage: false,
      token,
      enableForcePushEvent: true,
      debug: false,
      heartInterval: 30000,
    },
  ];
  for (const k of [
    "httpClients",
    "websocketClients",
    "httpSseServers",
    "plugins",
  ])
    network[k] ??= [];
  return { ...(existing || {}), network };
}

export function init({
  root,
  answers,
  napcatConfig,
  force = false,
  env = process.env,
}) {
  assertStopped(root);
  const configFile = path.join(root, "config.json");
  if (fs.existsSync(configFile) && !force) throw Error("CONFIG_EXISTS");
  const config = buildConfig(answers);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const wrote = [];
  const backedUp = [backup(configFile)].filter(Boolean);
  atomicJSON(configFile, config);
  wrote.push(configFile);
  const connection = config.connections[0];
  // Same precedence as applyLocalSecrets at startup: a variable the shell or
  // a Docker env file already sets wins over secrets.json, so NapCat must be
  // given that value or the console and NapCat would disagree.
  let tokenSource = "environment";
  if (!env[connection.tokenEnv]) {
    tokenSource = "secrets.json";
    if (!readLocalSecrets(root)[connection.tokenEnv]) {
      writeLocalSecret(
        root,
        connection.tokenEnv,
        randomBytes(24).toString("base64url"),
      );
      tokenSource = "generated";
    }
    wrote.push(path.join(root, "secrets.json"));
  }
  const onebotToken =
    env[connection.tokenEnv] || readLocalSecrets(root)[connection.tokenEnv];
  if (napcatConfig) {
    const file = path.join(
      napcatConfig,
      `onebot11_${connection.accountId}.json`,
    );
    let existing = null,
      mode = 0o600;
    if (fs.existsSync(file)) {
      existing = JSON.parse(fs.readFileSync(file, "utf8"));
      // NapCat creates this file at first login and may run as another user
      // (common in Docker): keep its permissions so NapCat can still read it.
      mode = fs.statSync(file).mode & 0o777;
      backedUp.push(backup(file));
    }
    fs.mkdirSync(napcatConfig, { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(
      temp,
      JSON.stringify(
        napcatOnebotConfig(existing, {
          httpUrl: connection.httpUrl,
          wsUrl: connection.wsUrl,
          token: onebotToken,
        }),
        null,
        2,
      ) + "\n",
      { mode },
    );
    fs.chmodSync(temp, mode);
    fs.renameSync(temp, file);
    wrote.push(file);
  }
  const keyEnv = config.backends[0].apiKeyEnv;
  const missing =
    keyEnv && !env[keyEnv] && !readLocalSecrets(root)[keyEnv] ? [keyEnv] : [];
  return {
    ok: true,
    wrote,
    backedUp,
    onebotTokenSource: tokenSource,
    missingSecrets: missing,
    next: [
      ...missing.map((name) => `npm run setup -- secret ${name}`),
      napcatConfig
        ? "Restart NapCat so it loads the new OneBot settings"
        : "Copy the OneBot token into NapCat by running setup with --napcat-config, or set it in the NapCat WebUI",
      "npm run doctor",
    ],
  };
}

export function goLive({ root }) {
  assertStopped(root);
  const file = path.join(root, "config.json");
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  const used = new Set(config.agents.map((a) => a.connectionId));
  const next = validateConfig({
    ...config,
    mode: "live",
    connections: config.connections.map((c) =>
      used.has(c.id) ? { ...c, enabled: true } : c,
    ),
    agents: config.agents.map((a) => ({ ...a, paused: false })),
  });
  backup(file);
  atomicJSON(file, next);
  return {
    ok: true,
    mode: "live",
    enabledConnections: [...used],
    unpausedAgents: next.agents.map((a) => a.id),
    next: [
      "npm start -- --live   (keep it running; every start is globally paused)",
      "npm run setup -- unpause --confirm",
    ],
  };
}

export async function unpause({ root, fetchImpl = fetch, wait = 30000 }) {
  const config = JSON.parse(
    fs.readFileSync(path.join(root, "config.json"), "utf8"),
  );
  const token = fs.readFileSync(path.join(root, "admin-token"), "utf8").trim();
  const base = `http://127.0.0.1:${config.port}`;
  const api = async (route, body) => {
    const response = await fetchImpl(base + "/api/" + route, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "x-admin-token": token,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }).catch(() => {
      throw Error("CONSOLE_NOT_RUNNING");
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(data.error || "CONSOLE_REQUEST_FAILED");
    return data;
  };
  let status = await api("status");
  if (status.mode !== "live") throw Error("RESTART_WITH_LIVE_FLAG_REQUIRED");
  for (const c of config.connections.filter((c) => c.enabled))
    if (!status.connections.find((x) => x.id === c.id)?.connected)
      await api("connection", { id: c.id, action: "connect" });
  const deadline = Date.now() + wait;
  for (;;) {
    status = await api("status");
    const ready = config.connections
      .filter((c) => c.enabled)
      .every((c) => status.connections.find((x) => x.id === c.id)?.connected);
    if (ready) break;
    if (Date.now() > deadline) throw Error("QQ_NOT_READY");
    await new Promise((r) => setTimeout(r, 1000));
  }
  await api("pause", { paused: false });
  status = await api("status");
  return {
    ok: true,
    globalPaused: status.globalPaused,
    agents: status.agents.map((a) => ({ id: a.id, blockers: a.blockers })),
  };
}

async function readHidden(prompt) {
  if (!process.stdin.isTTY) {
    let data = "";
    for await (const chunk of process.stdin) data += chunk;
    return data.replace(/\r?\n$/, "");
  }
  process.stderr.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const done = (fn) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off("data", onData);
      process.stderr.write("\n");
      fn();
    };
    const onData = (buffer) => {
      for (const ch of buffer.toString("utf8")) {
        if (ch === "\r" || ch === "\n") return done(() => resolve(value));
        if (ch === "\u0003") return done(() => reject(Error("CANCELLED")));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    process.stdin.on("data", onData);
  });
}

async function main(argv) {
  const [command, ...rest] = argv;
  const option = (name) =>
    rest.includes(name) ? rest[rest.indexOf(name) + 1] : undefined;
  const root = path.resolve(option("--data") || ".runtime");
  if (command === "init") {
    const file = option("--answers");
    if (!file) throw Error("ANSWERS_FILE_REQUIRED");
    let text = "";
    if (file === "-") for await (const chunk of process.stdin) text += chunk;
    else text = fs.readFileSync(file, "utf8");
    return init({
      root,
      answers: JSON.parse(text),
      napcatConfig: option("--napcat-config"),
      force: rest.includes("--force"),
    });
  }
  if (command === "secret") {
    const name = rest.find(
      (x) => !x.startsWith("--") && x !== option("--data"),
    );
    if (!name) throw Error("SECRET_NAME_REQUIRED");
    const value = (await readHidden(`${name}: `)).trim();
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    writeLocalSecret(root, name, value);
    return { ok: true, saved: name, file: path.join(root, "secrets.json") };
  }
  if (command === "live" || command === "unpause") {
    if (!rest.includes("--confirm")) throw Error("CONFIRM_REQUIRED");
    return command === "live" ? goLive({ root }) : unpause({ root });
  }
  throw Error("USAGE: setup init|secret|live|unpause");
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).then(
    (result) => console.log(JSON.stringify(result, null, 2)),
    (error) => {
      console.log(
        JSON.stringify({
          ok: false,
          error: /^[A-Z][A-Z0-9_:]*( [a-z|]+)?$/.test(error.message)
            ? error.message
            : error.name === "ZodError"
              ? "INVALID_ANSWERS"
              : "SETUP_FAILED",
          ...(error.name === "ZodError"
            ? {
                issues: error.issues
                  .slice(0, 8)
                  .map((i) => ({ path: i.path.join("."), message: i.message })),
              }
            : {}),
        }),
      );
      process.exitCode = 1;
    },
  );
