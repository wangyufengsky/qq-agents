import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { once } from "node:events";
import {
  buildConfig,
  goLive,
  init,
  napcatOnebotConfig,
  unpause,
} from "../src/cli/setup.mjs";
import { runDoctor, referencedSecrets } from "../src/cli/doctor.mjs";
import {
  applyLocalSecrets,
  readLocalSecrets,
  writeLocalSecret,
} from "../src/core/local-secrets.mjs";
import { temp } from "./helpers.mjs";

const answers = (port = 3000) => ({
  qq: {
    accountId: "123456789",
    httpUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port + 1}`,
  },
  backend: {
    type: "openai",
    baseUrl: "https://api.example.test/v1",
    model: "m",
  },
  agent: { name: "小测", persona: "测试人设", groups: ["20000"] },
});
const posix = process.platform !== "win32";

test("setup answers become an isolated, paused single-character config", () => {
  const config = buildConfig(answers());
  assert.equal(config.mode, "isolated");
  assert.equal(config.globalPaused, true);
  assert.equal(config.connections.length, 1);
  assert.equal(config.connections[0].enabled, false);
  assert.equal(config.connections[0].tokenEnv, "QQ_AGENTS_ONEBOT_TOKEN");
  assert.equal(config.backends[0].apiKeyEnv, "QQ_AGENTS_API_KEY");
  const [agent] = config.agents;
  assert.equal(agent.paused, true);
  assert.deepEqual(agent.allow, { groups: ["20000"], users: [] });
  assert.equal(agent.network.autonomous, false);
  assert.equal(agent.apps.enabled, false);
  // Docker service names need the explicit opt-in, as everywhere else.
  const docker = answers();
  docker.qq.httpUrl = "http://napcat:3000";
  docker.qq.wsUrl = "ws://napcat:3001";
  assert.throws(() => buildConfig(docker));
  docker.qq.allowPrivateNetwork = true;
  assert.equal(buildConfig(docker).connections[0].allowPrivateNetwork, true);
  // A keyless local model server.
  const local = answers();
  local.backend = {
    type: "openai",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "m",
    apiKeyEnv: null,
  };
  assert.equal(buildConfig(local).backends[0].apiKeyEnv, undefined);
  assert.throws(
    () => buildConfig({ ...answers(), agent: { name: "x", groups: ["abc"] } }),
    { name: "ZodError" },
  );
});

test("init writes config, a private generated token and NapCat's OneBot file; refuses to clobber", (t) => {
  const root = path.join(temp(t), "data"),
    napcat = path.join(temp(t), "napcat");
  fs.mkdirSync(napcat);
  const napcatFile = path.join(napcat, "onebot11_123456789.json");
  fs.writeFileSync(
    napcatFile,
    JSON.stringify({
      network: {
        httpServers: [{ name: "other", enable: true, port: 9 }],
        websocketServers: [{ name: "qq-agents-ws", port: 1 }],
      },
      musicSignUrl: "keep",
    }),
    { mode: 0o644 },
  );
  const result = init({
    root,
    answers: answers(),
    napcatConfig: napcat,
    env: {},
  });
  assert.equal(result.ok, true);
  assert.equal(result.onebotTokenSource, "generated");
  assert.deepEqual(result.missingSecrets, ["QQ_AGENTS_API_KEY"]);
  const token = readLocalSecrets(root).QQ_AGENTS_ONEBOT_TOKEN;
  assert.match(token, /^[A-Za-z0-9_-]{32}$/);
  assert.ok(!JSON.stringify(result).includes(token), "no secret in output");
  if (posix)
    assert.equal(
      fs.statSync(path.join(root, "secrets.json")).mode & 0o777,
      0o600,
    );
  const onebot = JSON.parse(fs.readFileSync(napcatFile, "utf8"));
  assert.equal(onebot.musicSignUrl, "keep");
  assert.deepEqual(
    onebot.network.httpServers.map((s) => s.name),
    ["other", "qq-agents-http"],
  );
  assert.equal(onebot.network.websocketServers.length, 1);
  const [ws] = onebot.network.websocketServers;
  assert.deepEqual(
    [ws.name, ws.host, ws.port, ws.token, ws.enable],
    ["qq-agents-ws", "127.0.0.1", 3001, token, true],
  );
  if (posix) assert.equal(fs.statSync(napcatFile).mode & 0o777, 0o644);
  assert.ok(fs.readdirSync(napcat).some((f) => f.includes(".before-setup-")));

  assert.throws(
    () => init({ root, answers: answers(), env: {} }),
    /CONFIG_EXISTS/,
  );
  const again = init({ root, answers: answers(), force: true, env: {} });
  assert.equal(again.onebotTokenSource, "secrets.json", "the token is reused");
  assert.equal(readLocalSecrets(root).QQ_AGENTS_ONEBOT_TOKEN, token);
  assert.equal(again.backedUp.length, 1);
  fs.writeFileSync(path.join(root, "process.lock"), "{}");
  assert.throws(
    () => init({ root, answers: answers(), force: true, env: {} }),
    /DATA_DIRECTORY_LOCKED/,
  );
});

test("Docker OneBot servers listen on all interfaces inside the container", () => {
  const config = napcatOnebotConfig(null, {
    httpUrl: "http://napcat:3000",
    wsUrl: "ws://napcat:3001",
    token: "t",
  });
  assert.equal(config.network.httpServers[0].host, "0.0.0.0");
  assert.equal(config.network.websocketServers[0].host, "0.0.0.0");
  assert.deepEqual(config.network.httpClients, []);
  assert.throws(
    () =>
      napcatOnebotConfig(null, {
        httpUrl: "http://napcat",
        wsUrl: "ws://napcat:1",
        token: "t",
      }),
    /ONEBOT_PORT_REQUIRED/,
  );
});

test("secrets.json fills only unset variables and rejects anything but a name→string map", (t) => {
  const root = temp(t);
  writeLocalSecret(root, "QQ_A", "from-file");
  writeLocalSecret(root, "QQ_B", "from-file");
  const env = { QQ_A: "from-shell" };
  assert.deepEqual(applyLocalSecrets(root, env), ["QQ_B"]);
  assert.deepEqual(env, { QQ_A: "from-shell", QQ_B: "from-file" });
  assert.throws(
    () => writeLocalSecret(root, "lower", "x"),
    /INVALID_SECRET_NAME/,
  );
  assert.throws(() => writeLocalSecret(root, "QQ_C", ""), /EMPTY_SECRET/);
  fs.writeFileSync(path.join(root, "secrets.json"), '{"QQ_A": 1}');
  assert.throws(() => readLocalSecrets(root), /INVALID_LOCAL_SECRETS/);
  assert.deepEqual(readLocalSecrets(path.join(root, "absent")), {});
});

test("live enables the character's connection and lifts its pause, only while stopped", (t) => {
  const root = temp(t);
  init({ root, answers: answers(), env: {} });
  const result = goLive({ root });
  assert.equal(result.mode, "live");
  const config = JSON.parse(
    fs.readFileSync(path.join(root, "config.json"), "utf8"),
  );
  assert.equal(config.mode, "live");
  assert.equal(config.connections[0].enabled, true);
  assert.equal(config.agents[0].paused, false);
  fs.writeFileSync(path.join(root, "process.lock"), "{}");
  assert.throws(() => goLive({ root }), /DATA_DIRECTORY_LOCKED/);
});

test("unpause connects QQ first and lifts the global pause through the console API", async (t) => {
  const root = temp(t);
  init({ root, answers: answers(), env: {} });
  goLive({ root });
  fs.writeFileSync(path.join(root, "admin-token"), "admin\n");
  const calls = [];
  let connected = false,
    paused = true;
  const fetchImpl = async (url, init = {}) => {
    const route = new URL(url).pathname,
      body = init.body ? JSON.parse(init.body) : undefined;
    assert.equal(init.headers["x-admin-token"], "admin");
    calls.push(route + (body ? " " + JSON.stringify(body) : ""));
    if (route === "/api/connection") connected = true;
    if (route === "/api/pause") paused = body.paused;
    return new Response(
      JSON.stringify(
        route === "/api/status"
          ? {
              mode: "live",
              globalPaused: paused,
              connections: [{ id: "qq-main", connected }],
              agents: [
                { id: "agent-main", blockers: paused ? ["GLOBAL_PAUSED"] : [] },
              ],
            }
          : { ok: true },
      ),
    );
  };
  const result = await unpause({ root, fetchImpl, wait: 2000 });
  assert.deepEqual(result.agents, [{ id: "agent-main", blockers: [] }]);
  const order = calls.filter((c) => !c.startsWith("/api/status"));
  assert.deepEqual(order, [
    '/api/connection {"id":"qq-main","action":"connect"}',
    '/api/pause {"paused":false}',
  ]);
  await assert.rejects(
    unpause({ root, fetchImpl: async () => Promise.reject(Error("down")) }),
    /CONSOLE_NOT_RUNNING/,
  );
});

test("doctor checks OneBot identity and the backend without leaking secret values", async (t) => {
  const root = temp(t);
  const server = http.createServer((req, res) => {
    let body = "";
    req
      .on("data", (c) => (body += c))
      .on("end", () => {
        const auth = req.headers.authorization;
        const json = (status, value) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(value));
        };
        if (req.url === "/v1/models")
          return auth === "Bearer model-key-value"
            ? json(200, { data: [{ id: "m" }] })
            : json(401, { error: { code: "invalid_api_key" } });
        if (auth !== "Bearer " + readLocalSecrets(root).QQ_AGENTS_ONEBOT_TOKEN)
          return json(403, {});
        if (req.url === "/get_login_info")
          return json(200, {
            status: "ok",
            retcode: 0,
            data: { user_id: 123456789 },
          });
        if (req.url === "/get_status")
          return json(200, {
            status: "ok",
            retcode: 0,
            data: { online: true },
          });
        json(404, {});
      });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const port = server.address().port;
  const a = answers(port);
  a.backend.baseUrl = `http://127.0.0.1:${port}/v1`;
  init({ root, answers: a, env: {} });

  let report = await runDoctor({ root, env: {} });
  const byId = (id) => report.checks.find((c) => c.id === id);
  assert.equal(report.ok, false);
  assert.equal(byId("secret:QQ_AGENTS_API_KEY").status, "fail");
  assert.equal(
    byId("secret:QQ_AGENTS_API_KEY").fix,
    "npm run setup -- secret QQ_AGENTS_API_KEY",
  );
  assert.equal(byId("onebot:qq-main").status, "ok");
  assert.equal(byId("backend:api").status, "fail");

  writeLocalSecret(root, "QQ_AGENTS_API_KEY", "model-key-value");
  report = await runDoctor({ root, env: {} });
  assert.equal(report.ok, true, JSON.stringify(report.checks));
  assert.match(byId("backend:api").detail, /1 model/);
  const text = JSON.stringify(report);
  for (const value of Object.values(readLocalSecrets(root)))
    assert.ok(!text.includes(value), "doctor never prints a secret");
  assert.equal(process.env.QQ_AGENTS_API_KEY, undefined, "env is restored");

  // A different logged-in account is reported as a mismatch.
  const config = JSON.parse(fs.readFileSync(path.join(root, "config.json")));
  config.connections[0].accountId = "987654321";
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify(config));
  report = await runDoctor({ root, env: {}, probeBackends: false });
  assert.equal(byId("onebot:qq-main").detail, "QQ_ACCOUNT_MISMATCH");
});

test("doctor only asks for secrets that the config actually uses", () => {
  const config = buildConfig(answers());
  assert.deepEqual(referencedSecrets(config).sort(), [
    "QQ_AGENTS_API_KEY",
    "QQ_AGENTS_ONEBOT_TOKEN",
  ]);
});

test("init gives NapCat the token the console will actually use when the shell sets it", (t) => {
  const root = path.join(temp(t), "data"),
    napcat = temp(t);
  const result = init({
    root,
    answers: answers(),
    napcatConfig: napcat,
    env: { QQ_AGENTS_ONEBOT_TOKEN: "token-from-shell" },
  });
  assert.equal(result.onebotTokenSource, "environment");
  assert.equal(readLocalSecrets(root).QQ_AGENTS_ONEBOT_TOKEN, undefined);
  const onebot = JSON.parse(
    fs.readFileSync(path.join(napcat, "onebot11_123456789.json"), "utf8"),
  );
  assert.equal(onebot.network.httpServers[0].token, "token-from-shell");
  assert.equal(onebot.network.websocketServers[0].token, "token-from-shell");
  assert.ok(!JSON.stringify(result).includes("token-from-shell"));
});

test("doctor never starts a Codex app-server while a console holds the data directory", async (t) => {
  const root = temp(t);
  const a = answers();
  a.backend = { type: "codex" };
  init({ root, answers: a, env: {} });
  fs.writeFileSync(path.join(root, "process.lock"), "{}");
  const registry = {
    create: () =>
      assert.fail("no backend may be created for a locked Codex home"),
  };
  const report = await runDoctor({
    root,
    env: {},
    registry,
    fetchImpl: async () => Promise.reject(Error("unreachable console")),
  });
  const check = report.checks.find((c) => c.id === "backend:codex");
  assert.equal(check.status, "skip");
});
