import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { CodexBackend } from "../src/backends/codex.mjs";
import { Lifecycle } from "../src/transport/lifecycle.mjs";
import { ExternalTools } from "../src/backends/external.mjs";
import { config, temp, fixture, context } from "./helpers.mjs";
import { buildChildEnv } from "../src/core/child-env.mjs";
import { validateConfig } from "../src/core/config.mjs";
import { nativeEnv } from "../scripts/lib/local-process.mjs";

const peer = fileURLToPath(new URL("./child-env-fixture.mjs", import.meta.url));
function canaries(t) {
  const values = {
    GITHUB_TOKEN: "synthetic-round2-github",
    ONEBOT_TOKEN: "synthetic-round2-onebot",
    TOTP_SECRET: "synthetic-round2-totp",
    OPENAI_API_KEY: "synthetic-round2-model",
    QQ_ROUND2_UNRELATED: "synthetic-round2-unrelated",
    QQ_ROUND2_EXPLICIT: "synthetic-round2-explicit",
    HTTPS_PROXY: "http://127.0.0.1:9",
    NODE_OPTIONS: "--trace-warnings",
  };
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("Codex receives only its allowed environment, explicit secret and dedicated login home", async (t) => {
  canaries(t);
  const root = temp(t),
    cfg = config(1);
  cfg.backends[0].env = { ROLE_SECRET: "QQ_ROUND2_EXPLICIT" };
  const backend = new CodexBackend(cfg.backends[0], cfg.agents[0], { root });
  // Replace only the OS launch boundary; use the real backend/RPC handshake.
  backend.rpc.spawnProcess = (_command, _args, options) =>
    spawn(process.execPath, [peer, "codex"], options);
  t.after(() => backend.close());
  await assert.rejects(backend.health(), /CODEX_DEDICATED_LOGIN_REQUIRED/);
  fs.writeFileSync(path.join(backend.home, "synthetic-login"), "fixture");
  const value = (await backend.health()).models[0].environment;
  assert.deepEqual(value.inheritedSecrets, []);
  assert.equal(value.explicitSecret, true);
  assert.equal(value.dedicatedHome, true);
  assert.equal(value.hasPath, true);
  assert.equal(value.hasHome, true);
  assert.equal(value.proxy, true);
  assert.equal(value.nodeOptions, false);
});

test("managed native QQ receives only its allowed environment and explicit mappings", async (t) => {
  canaries(t);
  const root = temp(t),
    output = path.join(root, "observed.json");
  const manager = new Lifecycle(root);
  t.after(() => manager.close());
  await manager.start({
    id: "synthetic",
    deployment: "native",
    process: {
      command: process.execPath,
      args: [peer, "native", output],
      env: { ROLE_SECRET: "QQ_ROUND2_EXPLICIT" },
    },
  });
  // The child may still be writing when the file appears; wait for whole JSON.
  let value;
  for (let i = 0; i < 200 && value === undefined; i++) {
    try {
      value = JSON.parse(fs.readFileSync(output, "utf8"));
    } catch {
      await delay(10);
    }
  }
  assert.ok(value, "child process did not report its environment");
  assert.deepEqual(value.inheritedSecrets, []);
  assert.equal(value.explicitSecret, true);
  assert.equal(value.hasPath, true);
  assert.equal(value.hasHome, true);
  assert.equal(value.proxy, true);
  assert.equal(value.nodeOptions, false);
});

test("external MCP keeps its existing minimal environment and explicit secret mapping", async (t) => {
  canaries(t);
  const external = new ExternalTools([
    {
      id: "synthetic",
      command: process.execPath,
      args: [peer, "mcp"],
      env: { ROLE_SECRET: "QQ_ROUND2_EXPLICIT" },
      allowedTools: ["env_probe"],
    },
  ]);
  t.after(() => external.close());
  const result = await external.call("synthetic", "env_probe", {});
  const value = JSON.parse(result.content[0].text);
  assert.deepEqual(value.inheritedSecrets, []);
  assert.equal(value.explicitSecret, true);
  assert.equal(value.hasPath, true);
  assert.equal(value.nodeOptions, false);
});

test("platform launch environments retain locale, certificate, proxy and required desktop variables", () => {
  const parent = {
    PATH: "/synthetic/bin",
    HOME: "/synthetic/home",
    LANG: "zh_CN.UTF-8",
    LC_CTYPE: "UTF-8",
    TZ: "Asia/Shanghai",
    TMPDIR: "/synthetic/tmp",
    HTTPS_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "localhost,127.0.0.1",
    SSL_CERT_FILE: "/synthetic/ca.pem",
    SSL_CERT_DIR: "/synthetic/certs",
    NODE_EXTRA_CA_CERTS: "/synthetic/node-ca.pem",
    DISPLAY: ":0",
    WAYLAND_DISPLAY: "wayland-0",
    XDG_RUNTIME_DIR: "/synthetic/run",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/synthetic/bus",
    __CF_USER_TEXT_ENCODING: "synthetic",
    NODE_OPTIONS: "synthetic-loader",
    LD_PRELOAD: "synthetic-loader",
    DYLD_INSERT_LIBRARIES: "synthetic-loader",
    SSH_AUTH_SOCK: "/synthetic/ssh",
    CODEX_HOME: "/synthetic/daily-home",
    OPENAI_API_KEY: "synthetic-private",
  };
  for (const platform of ["darwin", "linux", "win32"]) {
    for (const component of ["codex", "native-qq"]) {
      const value = buildChildEnv(component, {}, { parent, platform });
      for (const key of [
        "LANG",
        "LC_CTYPE",
        "TZ",
        "HTTPS_PROXY",
        "NO_PROXY",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "NODE_EXTRA_CA_CERTS",
      ])
        assert.equal(value[key], parent[key]);
      for (const key of [
        "NODE_OPTIONS",
        "LD_PRELOAD",
        "DYLD_INSERT_LIBRARIES",
        "SSH_AUTH_SOCK",
        "CODEX_HOME",
        "OPENAI_API_KEY",
      ])
        assert.equal(value[key], undefined);
      assert.equal(
        value.DISPLAY,
        component === "native-qq" && platform === "linux" ? ":0" : undefined,
      );
      assert.equal(
        value.__CF_USER_TEXT_ENCODING,
        component === "native-qq" && platform === "darwin"
          ? "synthetic"
          : undefined,
      );
    }
  }
  const win = buildChildEnv(
    "native-qq",
    { Path: "ROLE_PATH" },
    {
      platform: "win32",
      parent: {
        Path: "C:\\Windows",
        SystemRoot: "C:\\Windows",
        ComSpec: "C:\\Windows\\cmd.exe",
        PATHEXT: ".EXE;.CMD",
        USERPROFILE: "C:\\Users\\synthetic",
        Username: "synthetic-user",
        AppData: "C:\\synthetic\\appdata",
        Temp: "C:\\synthetic\\temp",
        ROLE_PATH: "C:\\role\\bin",
      },
    },
  );
  assert.equal(win.PATH, "C:\\role\\bin");
  assert.equal(win.SYSTEMROOT, "C:\\Windows");
  assert.equal(win.COMSPEC, "C:\\Windows\\cmd.exe");
  assert.equal(win.APPDATA, "C:\\synthetic\\appdata");
  assert.equal(win.USERNAME, "synthetic-user");
  assert.equal(win.TEMP, "C:\\synthetic\\temp");
  assert.equal(
    Object.keys(win).filter((k) => k.toUpperCase() === "PATH").length,
    1,
  );
  assert.throws(
    () =>
      buildChildEnv(
        "codex",
        { Path: "ROLE_PATH", PATH: "ROLE_PATH" },
        { parent: { ROLE_PATH: "synthetic" }, platform: "win32" },
      ),
    /INVALID_CHILD_ENV_MAPPING/,
  );
  const launcher = nativeEnv(
    {
      ...parent,
      GITHUB_TOKEN: "synthetic-private",
      ONEBOT_TOKEN: "synthetic-private",
      TOTP_SECRET: "synthetic-private",
    },
    { workdir: "/synthetic/qq", accountId: "10001", webPort: 23012 },
  );
  assert.equal(launcher.NAPCAT_WORKDIR, "/synthetic/qq");
  assert.equal(launcher.NAPCAT_QUICK_ACCOUNT, "10001");
  assert.equal(launcher.NAPCAT_WEBUI_PREFERRED_PORT, "23012");
  for (const key of [
    "GITHUB_TOKEN",
    "ONEBOT_TOKEN",
    "TOTP_SECRET",
    "OPENAI_API_KEY",
    "CODEX_HOME",
    "NODE_OPTIONS",
  ])
    assert.equal(launcher[key], undefined);
});

test("missing explicit variables and dedicated-home overrides fail before child launch", async (t) => {
  const cfg = config(1),
    root = temp(t);
  const missing = "QQ_ROUND2_MISSING_" + process.pid;
  delete process.env[missing];
  cfg.backends[0].env = { ROLE_SECRET: missing };
  assert.throws(
    () => new CodexBackend(cfg.backends[0], cfg.agents[0], { root }),
    /CODEX_ENV_MISSING/,
  );
  let spawned = false;
  const manager = new Lifecycle(root, {
    spawnProcess: () => {
      spawned = true;
    },
  });
  await assert.rejects(
    manager.start({
      id: "synthetic",
      deployment: "native",
      process: {
        command: "must-not-run",
        args: [],
        env: { ROLE_SECRET: missing },
      },
    }),
    /PROCESS_ENV_MISSING/,
  );
  assert.equal(spawned, false);
  assert.throws(
    () =>
      buildChildEnv(
        "codex",
        { CODEX_HOME: "ROLE_HOME" },
        { parent: { ROLE_HOME: "/synthetic/wrong" } },
      ),
    /CODEX_HOME_OVERRIDE_DENIED/,
  );
  assert.throws(
    () => buildChildEnv("native-qq", { "INVALID=KEY": missing }),
    /INVALID_CHILD_ENV_MAPPING/,
  );
  assert.equal(validateConfig(cfg).backends[0].env.ROLE_SECRET, missing);
  cfg.backends[0].env = { CODEX_HOME: "ROLE_HOME" };
  assert.throws(() => validateConfig(cfg));
  cfg.backends[0].env = { ROLE_SECRET: missing };
  cfg.backends[0].type = "dsh";
  assert.throws(() => validateConfig(cfg));
});

test("explicit Codex credentials remain protected from outbound request arguments", (t) => {
  canaries(t);
  const cfg = config(1);
  cfg.backends[0].env = { ROLE_SECRET: "QQ_ROUND2_EXPLICIT" };
  const f = fixture(t, { cfg }),
    ctx = context(f.runtime);
  for (const value of [
    process.env.QQ_ROUND2_EXPLICIT,
    Buffer.from(process.env.QQ_ROUND2_EXPLICIT).toString("base64"),
  ])
    assert.throws(
      () =>
        f.runtime.authorizeExternal(ctx, {
          tool: "external_tool",
          args: {
            serverId: "fixture",
            tool: "search",
            arguments: { q: value },
          },
        }),
      /SENSITIVE_OUTPUT_BLOCKED/,
    );
});
