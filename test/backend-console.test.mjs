import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import { fixture, config } from "./helpers.mjs";
import { createServer } from "../src/server.mjs";

test("console recovery and automatic-recovery controls call real admin routes without changing QQ settings", async (t) => {
  const f = fixture(t, { cfg: config(1) });
  let created = 0;
  f.runtime.backendFactory = () => {
    created++;
    return {
      models: async () => [{ model: "fixture" }],
      close: async () => {},
    };
  };
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
      nodes.set(s, {
        close() {},
        addEventListener() {},
        querySelectorAll: () => [],
      });
    return nodes.get(s);
  };
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
    fetch: (url, options) =>
      fetch(`http://127.0.0.1:${port}` + url, {
        ...options,
        headers: { ...options?.headers, "x-admin-token": "test-admin" },
      }),
    initial: { config: f.runtime.config, status: f.runtime.status() },
  });
  vm.runInContext(
    fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8"),
    sandbox,
  );
  vm.runInContext(
    "config=initial.config;status=initial.status;render=()=>{};",
    sandbox,
  );
  const card = vm.runInContext("backendCard(config.backends[0])", sandbox);
  assert.match(card, /检测连接/);
  assert.match(card, /恢复连接/);
  assert.match(card, /开启自动恢复/);
  assert.match(card, /尚未检测/);
  await vm.runInContext('operate("backend-check","fixture")', sandbox);
  assert.equal(f.runtime.backendConnections.snapshot("fixture").state, "ready");
  await vm.runInContext('operate("backend-recover","fixture")', sandbox);
  assert.equal(created, 2);
  assert.match(node("#notice").textContent, /已恢复/);
  await vm.runInContext('operate("backend-auto","fixture")', sandbox);
  assert.equal(f.runtime.config.backends[0].recovery.autoReconnect, true);
  assert(f.runtime.transports.get("qq-0").connected);
  assert.equal(f.runtime.agent("agent-0").wake.participation, 1);
  f.runtime.config.backends[0].type = "dsh";
  f.runtime.backendConnections.discover = async () => [
    {
      id: "relay:web",
      label: "Desktop <unsafe>",
      url: "http://127.0.0.1:9001",
      pid: 123,
      followsRestart: true,
    },
  ];
  node("#editor").showModal = () => {};
  await vm.runInContext('operate("backend-discover","fixture")', sandbox);
  assert.match(node("#edit-fields").innerHTML, /连接此实例/);
  assert.match(
    node("#edit-fields").innerHTML,
    /type="button" data-backend-candidate=/,
  );
  assert.match(node("#edit-fields").innerHTML, /&lt;unsafe&gt;/);
});
