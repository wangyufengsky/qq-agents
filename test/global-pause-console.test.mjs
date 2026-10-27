import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { config, fixture } from "./helpers.mjs";
import { createServer } from "../src/server.mjs";

async function setup(t, mode = "live") {
  const cfg = config(2);
  cfg.mode = mode;
  cfg.globalPaused = true;
  cfg.agents[1].paused = true;
  const f = fixture(t, { cfg });
  f.store.bind("agent-0").setState("group:20000", { paused: true });
  const app = createServer({
    runtime: f.runtime,
    token: "test-admin",
    allowLive: true,
  });
  const port = await app.listen();
  t.after(() => app.close());
  const nodes = new Map();
  const node = (s) => {
    if (!nodes.has(s))
      nodes.set(s, { addEventListener() {}, querySelectorAll: () => [] });
    return nodes.get(s);
  };
  const requests = [];
  let gate,
    fail = false;
  const sandbox = vm.createContext({
    document: {
      querySelector: node,
      querySelectorAll: () => [],
      body: { classList: { remove() {} } },
    },
    sessionStorage: { getItem: () => "" },
    setInterval() {},
    setTimeout() {},
    clearTimeout() {},
    structuredClone,
    initial: { config: f.runtime.config, status: f.runtime.status() },
    fetch: async (url, options) => {
      if (url === "/api/pause") {
        requests.push(JSON.parse(options.body));
        await gate;
        if (fail)
          return new Response(JSON.stringify({ error: "TEST_UNAVAILABLE" }), {
            status: 503,
          });
      }
      return fetch(`http://127.0.0.1:${port}` + url, {
        ...options,
        headers: { ...options?.headers, "x-admin-token": "test-admin" },
      });
    },
  });
  vm.runInContext(
    fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8"),
    sandbox,
  );
  vm.runInContext(
    'config=initial.config;status=initial.status;tab="settings";render();',
    sandbox,
  );
  return {
    ...f,
    node,
    sandbox,
    requests,
    setGate: (value) => {
      gate = value;
    },
    setFail: (value) => {
      fail = value;
    },
  };
}

test("header resumes and pauses through the admin API while preserving individual pauses and connections", async (t) => {
  const f = await setup(t),
    button = f.node("#pause-all");
  const original = structuredClone(f.runtime.config);
  const transports = [...f.runtime.transports.values()];
  assert.match(button.innerHTML, /全局恢复/);
  assert.equal(button.disabled, false);
  let release;
  f.setGate(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const first = button.onclick();
  assert.equal(button.disabled, true);
  vm.runInContext("render()", f.sandbox);
  assert.equal(button.disabled, true);
  await button.onclick();
  assert.deepEqual(f.requests, [{ paused: false }]);
  release();
  await first;
  original.globalPaused = false;
  assert.deepEqual(f.runtime.config, original);
  assert.equal(f.store.bind("agent-0").state("group:20000").paused, true);
  assert.deepEqual([...f.runtime.transports.values()], transports);
  assert(transports.every((transport) => transport.connected));
  assert.match(button.innerHTML, /全部暂停/);
  assert.equal(button.disabled, false);
  assert.match(f.node("#notice").textContent, /单独暂停/);
  await button.onclick();
  original.globalPaused = true;
  assert.deepEqual(f.runtime.config, original);
  assert.match(button.innerHTML, /全局恢复/);
  await vm.runInContext('operate("global-resume")', f.sandbox);
  assert.equal(f.runtime.config.globalPaused, false);
  assert.match(button.innerHTML, /全部暂停/);
});

test("failed resume keeps the paused control usable and isolated mode cannot resume", async (t) => {
  const f = await setup(t),
    button = f.node("#pause-all");
  f.setFail(true);
  await button.onclick();
  assert.equal(f.runtime.config.globalPaused, true);
  assert.equal(button.disabled, false);
  assert.match(button.innerHTML, /全局恢复/);
  assert.match(f.node("#notice").textContent, /TEST_UNAVAILABLE/);
  f.setFail(false);
  await button.onclick();
  assert.equal(f.runtime.config.globalPaused, false);
  const isolated = await setup(t, "isolated");
  assert.equal(isolated.node("#pause-all").disabled, true);
  await isolated.node("#pause-all").onclick();
  await vm.runInContext('operate("global-resume")', isolated.sandbox);
  assert.equal(isolated.requests.length, 0);
  assert.equal(isolated.runtime.config.globalPaused, true);
});
