import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { validateConfig, privateNetworkHost } from "../src/core/config.mjs";
import { createServer } from "../src/server.mjs";
import { findScreenshotBrowser } from "../src/tools/public-screenshot.mjs";
import { safeToolFailure } from "../src/tools/errors.mjs";
import { config, fixture, temp } from "./helpers.mjs";

const withUrls = (urls, allowPrivateNetwork) => {
  const c = config(1);
  Object.assign(c.connections[0], urls);
  if (allowPrivateNetwork !== undefined)
    c.connections[0].allowPrivateNetwork = allowPrivateNetwork;
  return c;
};
const compose = {
  httpUrl: "http://napcat:3000",
  wsUrl: "ws://napcat:3001",
  webUrl: "http://napcat:6099",
};

test("OneBot endpoints stay on loopback unless private networking is enabled", () => {
  const parsed = validateConfig(config(1));
  assert.equal("allowPrivateNetwork" in parsed.connections[0], false);
  assert.throws(() => validateConfig(withUrls(compose)), /Loopback URL/);
  assert.throws(() => validateConfig(withUrls(compose, false)), /Loopback/);
  for (const key of ["httpUrl", "wsUrl", "webUrl"])
    assert.throws(
      () => validateConfig(withUrls({ [key]: compose[key] })),
      (e) => e.issues.some((i) => i.path.includes(key)),
    );
  const c = validateConfig(withUrls(compose, true));
  assert.equal(c.connections[0].httpUrl, "http://napcat:3000");
  assert.equal(c.connections[0].allowPrivateNetwork, true);
  for (const httpUrl of [
    "http://172.18.0.2:3000",
    "http://10.1.2.3:3000",
    "http://192.168.1.20:3000",
    "http://host.docker.internal:3000",
    "http://[fd12::3]:3000",
    "http://127.0.0.1:3000",
  ])
    assert.doesNotThrow(() => validateConfig(withUrls({ httpUrl }, true)));
});

test("unparsable OneBot URLs are validation errors with or without private networking", () => {
  for (const allowPrivateNetwork of [undefined, false, true])
    for (const key of ["httpUrl", "wsUrl", "webUrl"])
      for (const value of ["not a url", "::::", ""])
        assert.throws(
          () => validateConfig(withUrls({ [key]: value }, allowPrivateNetwork)),
          (e) =>
            e.name === "ZodError" && e.issues.some((i) => i.path.includes(key)),
          `${key}=${JSON.stringify(value)} allowPrivateNetwork=${allowPrivateNetwork}`,
        );
});

test("private networking never admits public, link-local or credentialed endpoints", () => {
  for (const httpUrl of [
    "http://example.org:3000",
    "http://napcat.example.org:3000",
    "http://8.8.8.8:3000",
    "http://172.32.0.1:3000",
    "http://169.254.169.254/",
    "http://100.64.0.1:3000",
    "http://[2001:db8::1]:3000",
    "https://example.org",
    "http://user:pw@napcat:3000",
    "http://napcat:3000/?access_token=x",
  ])
    assert.throws(
      () => validateConfig(withUrls({ httpUrl }, true)),
      undefined,
      httpUrl,
    );
  assert.throws(() =>
    validateConfig(withUrls({ wsUrl: "wss://napcat:3001" }, true)),
  );
  assert.equal(privateNetworkHost("0.0.0.0"), false);
  assert.equal(privateNetworkHost("napcat"), true);
});

function hostRequest(port, host, headers = {}, token) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/api/status",
        headers: {
          host,
          ...(token ? { "x-admin-token": token } : {}),
          ...headers,
        },
      },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () =>
          resolve({ status: res.statusCode, body: JSON.parse(text) }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("console listening on 0.0.0.0 still answers only loopback Host names", async (t) => {
  const f = fixture(t),
    token = randomBytes(32).toString("hex"),
    app = createServer({ runtime: f.runtime, token, publicPort: 18321 });
  const port = await app.listen(0, "0.0.0.0");
  t.after(() => app.close());
  assert.equal(app.server.address().address, "0.0.0.0");
  // Same-port mapping (127.0.0.1:3210:3210) and a remapped host port.
  for (const host of [
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    "127.0.0.1:18321",
  ])
    assert.equal((await hostRequest(port, host, {}, token)).status, 200, host);
  for (const host of [
    `192.168.1.5:${port}`,
    `napcat-bridge:${port}`,
    "attacker.example:18321",
    "127.0.0.1:18322",
  ]) {
    const r = await hostRequest(port, host, {}, token);
    assert.equal(r.status, 403, host);
    assert.equal(r.body.error, "INVALID_HOST");
  }
  const crossOrigin = await hostRequest(
    port,
    "127.0.0.1:18321",
    { origin: "http://192.168.1.5:18321" },
    token,
  );
  assert.equal(crossOrigin.body.error, "CROSS_ORIGIN");
  assert.equal(
    (
      await hostRequest(port, "127.0.0.1:18321", {
        origin: "http://127.0.0.1:18321",
      })
    ).status,
    401,
  );
});

test("default listen address remains 127.0.0.1", async (t) => {
  const f = fixture(t),
    app = createServer({ runtime: f.runtime, token: "a".repeat(64) });
  await app.listen();
  t.after(() => app.close());
  assert.equal(app.server.address().address, "127.0.0.1");
});

async function boot(t, extra) {
  const root = temp(t),
    source = fileURLToPath(new URL("..", import.meta.url));
  const child = spawn(
    process.execPath,
    [
      "src/main.mjs",
      "--data",
      path.join(root, "data"),
      "--port",
      "0",
      ...extra,
    ],
    { cwd: source, stdio: ["ignore", "pipe", "pipe"] },
  );
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  let output = "";
  child.stdout.on("data", (c) => (output += c));
  child.stderr.on("data", (c) => (output += c));
  return { child, root, output: () => output };
}

test("--host 0.0.0.0 boots a reachable console and invalid hosts fail closed", async (t) => {
  const app = await boot(t, ["--host", "0.0.0.0"]);
  let url;
  // A loaded Windows runner can take well over 5s to start the child.
  for (const end = Date.now() + 60_000; !url && Date.now() < end;) {
    url = app.output().match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    if (app.child.exitCode !== null) break;
    await delay(5);
  }
  assert(url, app.output());
  assert.match(app.output(), /Listening on 0\.0\.0\.0:\d+/);
  const token = fs
    .readFileSync(path.join(app.root, "data", "admin-token"), "utf8")
    .trim();
  assert.equal(
    (await fetch(url + "/api/status", { headers: { "x-admin-token": token } }))
      .status,
    200,
  );
  assert.doesNotMatch(app.output(), new RegExp(token));
  app.child.kill("SIGTERM");
  await once(app.child, "exit");

  for (const extra of [
    ["--host", "napcat.example.org"],
    ["--public-port", "70000"],
  ]) {
    const bad = await boot(t, extra);
    const [code] = await once(bad.child, "exit");
    assert.notEqual(code, 0, extra.join(" "));
  }
});

test("screenshot browser: explicit path first, then platform paths, else a clear code", () => {
  const exists = (p) => p === "/usr/bin/chromium" || p === "/opt/chrome";
  assert.equal(
    findScreenshotBrowser({ env: {}, platform: "linux", exists }),
    "/usr/bin/chromium",
  );
  assert.equal(
    findScreenshotBrowser({
      env: { CHROME_PATH: "/opt/chrome" },
      platform: "linux",
      exists,
    }),
    "/opt/chrome",
  );
  assert.equal(
    findScreenshotBrowser({
      env: { QQ_SCREENSHOT_BROWSER: "/opt/chrome", CHROME_PATH: "/nope" },
      platform: "linux",
      exists,
    }),
    "/opt/chrome",
  );
  // A wrong explicit path is reported, not silently swapped for a probed one.
  for (const CHROME_PATH of ["/missing/chrome", "chromium"])
    assert.throws(
      () =>
        findScreenshotBrowser({
          env: { CHROME_PATH },
          platform: "linux",
          exists,
        }),
      /^Error: SCREENSHOT_BROWSER_MISSING$/,
    );
  assert.throws(
    () => findScreenshotBrowser({ env: {}, platform: "darwin", exists }),
    /SCREENSHOT_BROWSER_MISSING/,
  );
  assert.throws(
    () => findScreenshotBrowser({ env: {}, platform: "win32", exists }),
    /SCREENSHOT_BROWSER_MISSING/,
  );
  assert.match(
    safeToolFailure(Error("SCREENSHOT_BROWSER_MISSING")).hint,
    /CHROME_PATH/,
  );
});

test("local TTS degrades with an explained code off macOS", async (t) => {
  const cfg = config();
  cfg.agents[0].tools.push("voice_synthesize");
  cfg.agents[0].voice.tts.enabled = true;
  const { runtime } = fixture(t, { cfg }),
    ctx = runtime.makeContext("agent-0", "group:20000");
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "linux" });
  t.after(() => Object.defineProperty(process, "platform", platform));
  // No voice store is installed: the platform check must come first.
  await assert.rejects(
    runtime.callTool(ctx, "voice_synthesize", { text: "合成验收" }),
    /LOCAL_TTS_UNAVAILABLE/,
  );
  assert.equal(runtime.transports.get("qq-0").sent.length, 0);
  const failure = safeToolFailure(Error("LOCAL_TTS_UNAVAILABLE"));
  assert.equal(failure.code, "LOCAL_TTS_UNAVAILABLE");
  assert.match(failure.hint, /macOS/);
});
