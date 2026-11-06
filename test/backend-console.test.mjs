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
      body: { classList: { remove() {}, toggle() {} } },
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
  vm.runInContext(
    'status.backends[0].state="recovering";status.backends[0].waitingForTurns=2;',
    sandbox,
  );
  assert.match(
    vm.runInContext("backendCard(config.backends[0])", sandbox),
    /等待 2 个活跃回合结束/,
  );
  vm.runInContext(
    'status.backends[0].state="unchecked";delete status.backends[0].waitingForTurns;',
    sandbox,
  );
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
  const form = vm.runInContext(
    'backendForm({...config.backends[0],type:"openai",model:"keep-model",baseUrl:"https://example.com/v1"},"fixture","")',
    sandbox,
  );
  assert.match(form, /name="socialProfile"/);
  assert.match(form, /小窝社交 token 硬预算配置（可选）/);
  for (const type of ["dsh", "codex", "antigravity"]) {
    sandbox.backendType = type;
    const native = vm.runInContext(
      'backendForm({...config.backends[0],type:backendType},"fixture","")',
      sandbox,
    );
    assert.match(native, /无需社交 profile 或 token 硬预算/);
    assert.match(native, /DSH 须使用 qq-unified preset/);
  }
  assert.match(form, /openai-gpt-4.1-mini/);
  assert.match(form, /value="keep-model"/);
  assert.match(form, /value="https:\/\/example.com\/v1"/);
  sandbox.FormData = class {
    constructor(target) {
      return target;
    }
  };
  sandbox.formValues = new Map(
    Object.entries({
      id: "fixture",
      type: "openai",
      label: "fixture",
      model: "keep-model",
      baseUrl: "https://example.com/v1",
      socialProfile: "openai-gpt-4.1-mini",
      effort: "high",
      toolServers: "[]",
    }),
  );
  vm.runInContext(
    'editing={type:"backends",id:"fixture"}; api=async(url,body)=>{globalThis.savedConfig=body.config;globalThis.savedBackend=body.config.backends[0];return {warnings:[]}};load=async()=>{};action=(fn)=>{globalThis.pendingSave=fn()};',
    sandbox,
  );
  vm.runInContext(
    'document.querySelector("#edit-form").onsubmit({preventDefault(){},target:formValues})',
    sandbox,
  );
  await sandbox.pendingSave;
  assert.equal(sandbox.savedBackend.socialProfile, "openai-gpt-4.1-mini");
  assert.equal(sandbox.savedBackend.model, "keep-model");
  assert.equal(sandbox.savedBackend.baseUrl, "https://example.com/v1");
  const openai = structuredClone(sandbox.savedBackend);
  for (const profile of ["openai-gpt-4.1-mini", null]) {
    for (const type of ["codex", "dsh", "antigravity"]) {
      sandbox.sourceBackend = structuredClone(openai);
      vm.runInContext(
        'config.backends[0]=sourceBackend;editing={type:"backends",id:"fixture",row:sourceBackend}',
        sandbox,
      );
      // Emptying the selector persists null while the backend remains OpenAI.
      sandbox.formValues.set("type", "openai");
      sandbox.formValues.set("baseUrl", "https://example.com/v1");
      sandbox.formValues.set("socialProfile", profile || "");
      vm.runInContext(
        'document.querySelector("#edit-form").onsubmit({preventDefault(){},target:formValues})',
        sandbox,
      );
      await sandbox.pendingSave;
      assert.equal(sandbox.savedBackend.socialProfile, profile);
      sandbox.sourceBackend = structuredClone(sandbox.savedBackend);
      vm.runInContext(
        'config.backends[0]=sourceBackend;editing={type:"backends",id:"fixture",row:sourceBackend}',
        sandbox,
      );
      sandbox.formValues.set("type", type);
      sandbox.formValues.set("baseUrl", "");
      sandbox.formValues.set("cliReuseIdleSeconds", "120");
      sandbox.formValues.set("cliReuseMaxIdle", "1");
      sandbox.formValues.set("cliProtocol", "acp");
      vm.runInContext(
        'document.querySelector("#edit-form").onsubmit({preventDefault(){},target:formValues})',
        sandbox,
      );
      await sandbox.pendingSave;
      const payload = JSON.parse(JSON.stringify(sandbox.savedConfig));
      assert.equal(Object.hasOwn(payload.backends[0], "socialProfile"), false);
      const response = await fetch(`http://127.0.0.1:${port}/api/config`, {
        method: "PUT",
        headers: {
          "x-admin-token": "test-admin",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          config: payload,
          revision: f.configStore.revision,
        }),
      });
      assert.equal(
        response.status,
        200,
        `${profile} -> ${type}: ${JSON.stringify(await response.json())}`,
      );
      assert.equal(f.runtime.config.backends[0].type, type);
      assert.equal(f.runtime.config.backends[0].socialProfile, undefined);
      assert.equal(
        f.runtime.config.backends[0].cliProtocol,
        type === "antigravity" ? "acp" : undefined,
      );
    }
  }
});
