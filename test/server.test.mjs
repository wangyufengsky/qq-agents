import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import vm from "node:vm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer } from "../src/server.mjs";
import { VoiceStore } from "../src/tools/voice.mjs";
import { wav } from "./audio-fixture.mjs";
import { fixture, context, disclosureApproval } from "./helpers.mjs";
async function setup(t, exportOptions) {
  const f = fixture(t),
    token = randomBytes(32).toString("hex"),
    app = createServer({ runtime: f.runtime, token, exportOptions });
  const port = await app.listen();
  t.after(() => app.close());
  const base = `http://127.0.0.1:${port}`;
  const request = (url, { auth = true, ...o } = {}) =>
    fetch(base + url, {
      ...o,
      headers: {
        ...(auth ? { "x-admin-token": token } : {}),
        ...(o.headers || {}),
      },
    });
  return { ...f, token, app, base, request };
}
test("admin routes reject absent, wrong and agent credentials", async (t) => {
  const { request, runtime } = await setup(t);
  assert.equal((await request("/api/config", { auth: false })).status, 401);
  assert.equal(
    (await request("/api/config", { headers: { "x-admin-token": "wrong" } }))
      .status,
    401,
  );
  const ctx = context(runtime);
  assert.equal(
    (
      await request("/api/config", {
        auth: false,
        headers: { "x-agent-capability": ctx.token },
      })
    ).status,
    401,
  );
  assert.equal((await request("/api/config")).status, 200);
});

test("disclosure approval uses an admin-only request ID that cannot call model tools", async (t) => {
  const { request, runtime } = await setup(t);
  const ctx = context(runtime);
  ctx.privateRead.add("operations:synthetic");
  const outbound = {
    tool: "external_tool",
    args: {
      serverId: "fixture",
      tool: "search",
      arguments: { q: "synthetic query" },
    },
  };
  assert.throws(
    () => runtime.authorizeExternal(ctx, outbound),
    /EXTERNAL_CALL_BLOCKED/,
  );
  const status = await (await request("/api/status")).json();
  assert.equal(JSON.stringify(status).includes(ctx.token), false);
  const pending = status.disclosureRequests[0];
  assert.equal(Object.hasOwn(pending, "token"), false);
  assert.match(pending.approvalId, /^[a-f0-9-]{36}$/);
  for (const route of ["/agent/tools", "/agent/catalog"])
    assert.equal(
      (
        await request(route, {
          auth: false,
          method: "POST",
          headers: { "x-agent-capability": pending.approvalId },
          body: "{}",
        })
      ).status,
      401,
    );
  const payload = {
    approvalId: pending.approvalId,
    agentId: pending.agentId,
    conversation: pending.conversation,
    ids: pending.records,
    requestId: pending.requestId,
  };
  const approve = (auth = true) =>
    request("/api/disclosure", {
      auth,
      method: "POST",
      body: JSON.stringify(payload),
    });
  assert.equal((await approve(false)).status, 401);
  assert.equal((await approve()).status, 200);
  assert.equal(
    runtime.authorizeExternal(ctx, outbound).basis,
    "exact-request-grant",
  );
  assert.equal((await approve()).status, 400);
  assert.equal(
    (await (await request("/api/status")).json()).disclosureRequests.length,
    0,
  );
  assert.equal(
    (await (await request("/api/export?agentId=agent-0")).text()).includes(
      ctx.token,
    ),
    false,
  );
});

for (const change of [
  "expired",
  "cancelled",
  "paused",
  "reset",
  "sources",
  "request",
])
  test(`disclosure approval rejects a stale ${change} request`, async (t) => {
    const { request, runtime } = await setup(t);
    const ctx = context(runtime);
    ctx.privateRead.add("operations:synthetic");
    const outbound = {
      tool: "external_tool",
      args: {
        serverId: "fixture",
        tool: "search",
        arguments: { q: "original" },
      },
    };
    assert.throws(
      () => runtime.authorizeExternal(ctx, outbound),
      /EXTERNAL_CALL_BLOCKED/,
    );
    const payload = disclosureApproval(ctx);
    if (change === "expired") ctx.expires = Date.now() - 1;
    if (change === "cancelled") ctx.controller.abort();
    if (change === "paused") await runtime.pause(ctx.agentId);
    if (change === "reset")
      await runtime.resetSession(ctx.agentId, ctx.conversation);
    if (change === "sources") ctx.privateRead.add("operations:new-source");
    if (change === "request") {
      outbound.args.arguments.q = "changed";
      assert.throws(
        () => runtime.authorizeExternal(ctx, outbound),
        /EXTERNAL_CALL_BLOCKED/,
      );
    }
    const result = await request("/api/disclosure", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    assert.equal(result.status, 400);
    assert.equal(ctx.externalGrants.size, 0);
  });

test("disclosure approval binds identity, complete source set and immutable action arguments", async (t) => {
  const { request, runtime } = await setup(t);
  const ctx = context(runtime);
  ctx.privateRead.add("operations:synthetic");
  const outbound = {
    tool: "external_tool",
    args: { serverId: "fixture", tool: "search", arguments: { q: "original" } },
  };
  assert.throws(
    () => runtime.authorizeExternal(ctx, outbound),
    /EXTERNAL_CALL_BLOCKED/,
  );
  const original = structuredClone(outbound);
  const payload = disclosureApproval(ctx);
  // Repeating the same blocked action retains one pending ID; caller mutation cannot edit it.
  assert.throws(
    () => runtime.authorizeExternal(ctx, original),
    /EXTERNAL_CALL_BLOCKED/,
  );
  assert.equal(ctx.disclosureRequest.approvalId, payload.approvalId);
  outbound.args.arguments.q = "mutated by caller";
  for (const patch of [
    { agentId: "agent-1" },
    { conversation: "group:20001" },
    { ids: [] },
    { ids: [...payload.ids, ...payload.ids] },
    { requestId: "0".repeat(64) },
    { token: ctx.token },
    { approvalId: ctx.token },
  ]) {
    const result = await request("/api/disclosure", {
      method: "POST",
      body: JSON.stringify({ ...payload, ...patch }),
    });
    assert.equal(result.status, 400);
    assert.equal(ctx.externalGrants.size, 0);
  }
  assert.equal(
    (
      await request("/api/disclosure", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    ).status,
    200,
  );
  assert.equal(
    runtime.authorizeExternal(ctx, original).basis,
    "exact-request-grant",
  );
  assert.throws(
    () => runtime.authorizeExternal(ctx, outbound),
    /EXTERNAL_CALL_BLOCKED/,
  );
});

test("QQ source disclosure approvals stay scoped to the pending role and conversation", async (t) => {
  const { request, runtime } = await setup(t);
  const ctx = context(runtime);
  ctx.privateRead.add("operations:synthetic");
  assert.throws(() => runtime.assertDisclosure(ctx), /DISCLOSURE_GRANT/);
  const payload = disclosureApproval(ctx);
  assert.equal(
    (
      await request("/api/disclosure", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    ).status,
    200,
  );
  assert.doesNotThrow(() => runtime.assertDisclosure(ctx));
  const peer = context(runtime, ctx.agentId, "group:20001");
  peer.privateRead.add("operations:synthetic");
  assert.throws(() => runtime.assertDisclosure(peer), /DISCLOSURE_GRANT/);
});

test("console approval submits the public ID and scope without a model capability", async (t) => {
  const f = await setup(t),
    ctx = context(f.runtime);
  ctx.privateRead.add("operations:synthetic");
  const outbound = {
    tool: "external_tool",
    args: {
      serverId: "fixture",
      tool: "search",
      arguments: { q: "synthetic" },
    },
  };
  assert.throws(
    () => f.runtime.authorizeExternal(ctx, outbound),
    /EXTERNAL_CALL_BLOCKED/,
  );
  const nodes = new Map();
  let submitted;
  const sandbox = vm.createContext({
    document: {
      querySelector: (s) => {
        if (!nodes.has(s)) nodes.set(s, { addEventListener() {} });
        return nodes.get(s);
      },
      querySelectorAll: () => [],
    },
    sessionStorage: { getItem: () => "" },
    adminToken: f.token,
    setInterval() {},
    initialStatus: await (await f.request("/api/status")).json(),
    fetch: (url, options) => {
      if (url === "/api/disclosure") submitted = JSON.parse(options.body);
      return f.request(url, options);
    },
  });
  vm.runInContext(
    fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8"),
    sandbox,
  );
  await vm.runInContext(
    'token = adminToken; status = initialStatus; load = async () => {}; operate("grant", "0")',
    sandbox,
  );
  assert.equal(
    submitted.approvalId,
    sandbox.initialStatus.disclosureRequests[0].approvalId,
  );
  assert.equal(JSON.stringify(submitted).includes(ctx.token), false);
  assert.equal(
    f.runtime.authorizeExternal(ctx, outbound).basis,
    "exact-request-grant",
  );
});
test("origin and host guards reject cross-site and rebinding requests", async (t) => {
  const { request, base, token } = await setup(t);
  assert.equal(
    (
      await request("/api/status", {
        headers: { origin: "https://attacker.invalid" },
      })
    ).status,
    403,
  );
  const code = await new Promise((resolve, reject) =>
    http
      .get(
        base + "/api/status",
        { headers: { host: "attacker.invalid", "x-admin-token": token } },
        (r) => {
          r.resume();
          resolve(r.statusCode);
        },
      )
      .on("error", reject),
  );
  assert.equal(code, 403);
  assert.equal(
    (
      await request("/api/status", {
        headers: { "sec-fetch-site": "cross-site" },
      })
    ).status,
    403,
  );
});
test("config revision conflicts prevent stale edits; isolated listener cannot enable live mode", async (t) => {
  const { request, runtime } = await setup(t);
  const value = structuredClone(runtime.config);
  const revision = runtime.configStore.revision;
  value.mode = "isolated";
  const save = () =>
    request("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ config: value, revision }),
    });
  assert.equal((await save()).status, 200);
  assert.equal((await save()).status, 409);
  value.mode = "live";
  const r = await request("/api/config", {
    method: "PUT",
    body: JSON.stringify({
      config: value,
      revision: runtime.configStore.revision,
    }),
  });
  assert.equal(r.status, 400);
});
test("invalid config names the failing field paths without echoing values", async (t) => {
  const { request, runtime } = await setup(t);
  const value = structuredClone(runtime.config);
  value.mode = "isolated";
  value.agents[0].allow.groups = ["abc-leaked-value"];
  value.agents[0]["not a key"] = "other-leaked-value";
  const r = await request("/api/config", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      config: value,
      revision: runtime.configStore.revision,
    }),
  });
  assert.equal(r.status, 400);
  const text = await r.text(),
    body = JSON.parse(text);
  assert.equal(body.error, "INVALID_REQUEST");
  assert(body.fields.includes("agents.0.allow.groups.0"));
  assert(body.fields.includes("agents.0.*"));
  assert(body.fields.length <= 8);
  assert.doesNotMatch(text, /leaked-value|not a key/);
  assert.notEqual(runtime.config.agents[0].allow.groups[0], "abc-leaked-value");
});
test("agent tool endpoint binds identity from capability and rejects forged agentId", async (t) => {
  const { request, runtime, store } = await setup(t),
    ctx = context(runtime);
  store.bind("agent-1").diaryWrite({ title: "other", body: "SECRET_OTHER" });
  const r = await request("/agent/tools", {
    auth: false,
    method: "POST",
    headers: { "x-agent-capability": ctx.token },
    body: JSON.stringify({
      name: "memory_search",
      arguments: { agentId: "agent-1" },
    }),
  });
  assert.equal((await r.json()).isError, true);
  const good = await request("/agent/tools", {
    auth: false,
    method: "POST",
    headers: { "x-agent-capability": ctx.token },
    body: JSON.stringify({ name: "memory_search", arguments: {} }),
  });
  assert.ok(!(await good.text()).includes("SECRET_OTHER"));
});
test("HTTP memory export is admin-only and includes only selected agent", async (t) => {
  const { request, store } = await setup(t);
  store.bind("agent-0").diaryWrite({ title: "mine", body: "AAA" });
  store.bind("agent-1").diaryWrite({ title: "other", body: "BBB" });
  assert.equal(
    (await request("/api/export?agentId=agent-0", { auth: false })).status,
    401,
  );
  const data = await (await request("/api/export?agentId=agent-0")).json();
  assert.equal(data.tables.diaries.length, 1);
  assert.equal(data.tables.diaries[0].body, "AAA");
  assert.equal(data.manifest.counts.diaries, 1);
  assert.match(data.manifest.sha256, /^[a-f0-9]{64}$/);
});
test("conversation and session summaries exclude cursor bodies and other internal ledgers", async (t) => {
  const { request, store } = await setup(t);
  const memory = store.bind("agent-0");
  memory.setState("group:20000", { paused: true });
  memory.setState("internal:app-cursor-item:synthetic:000000", {
    text: "SYNTHETIC_PENDING_BODY",
  });
  const response = await (
    await request("/api/conversations?agentId=agent-0")
  ).json();
  assert.deepEqual(response, [{ conversation: "group:20000", paused: true }]);
  assert.equal(
    (await (await request("/api/mind?agentId=agent-0")).text()).includes(
      "SYNTHETIC_PENDING_BODY",
    ),
    false,
  );
});
test("the bounded export worker supports large rows below its advertised limit", async (t) => {
  const { request, store } = await setup(t);
  store.bind("agent-0").append({
    dedupe: "large-row",
    conversation: "group:20000",
    kind: "message.received",
    body: "x".repeat(2 * 1024 * 1024),
    payload: { text: "y".repeat(4 * 1024 * 1024) },
  });
  const response = await request("/api/export?agentId=agent-0");
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.tables.events[0].body.length, 2 * 1024 * 1024);
  assert.equal(
    JSON.parse(data.tables.events[0].payload).text.length,
    4 * 1024 * 1024,
  );
});
test("native export downloads use a single-use agent-bound POST ticket", async (t) => {
  const { request, store } = await setup(t);
  store.bind("agent-0").diaryWrite({ title: "mine", body: "native download" });
  store.bind("agent-1").diaryWrite({ title: "other", body: "other identity" });
  const prepare = () =>
    request("/api/export/ticket", {
      method: "POST",
      body: JSON.stringify({ agentId: "agent-0" }),
    });
  assert.equal(
    (
      await request("/api/export/ticket", {
        auth: false,
        method: "POST",
        body: "{}",
      })
    ).status,
    401,
  );
  const { ticket } = await (await prepare()).json();
  assert.match(ticket, /^[a-f0-9-]{36}$/);
  const download = () =>
    request("/api/export/download", {
      auth: false,
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ticket }),
    });
  assert.equal(
    (await request("/api/config", { headers: { "x-admin-token": ticket } }))
      .status,
    401,
  );
  const response = await download();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-disposition"), /attachment/);
  assert.equal(
    (await response.json()).tables.diaries[0].body,
    "native download",
  );
  assert.equal((await download()).status, 401);
});
test("export console submits a scoped native download without fetching the export into JavaScript", async (t) => {
  const f = await setup(t),
    nodes = new Map(),
    calls = [],
    submitted = [];
  const node = (key) => {
    if (!nodes.has(key))
      nodes.set(key, { addEventListener() {}, querySelectorAll: () => [] });
    return nodes.get(key);
  };
  const sandbox = vm.createContext({
    document: {
      querySelector: node,
      querySelectorAll: () => [],
      body: { append() {}, classList: { toggle() {} } },
      createElement: (tag) => ({
        tag,
        children: [],
        append(child) {
          this.children.push(child);
        },
        remove() {},
        submit() {
          submitted.push(this);
        },
      }),
    },
    sessionStorage: { getItem: () => "" },
    setInterval() {},
    setTimeout() {},
    clearTimeout() {},
    initialConfig: f.runtime.config,
    initialStatus: await (await f.request("/api/status")).json(),
    adminToken: f.token,
    fetch: (url, options) => {
      calls.push(url);
      return f.request(url, options);
    },
  });
  vm.runInContext(
    fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8"),
    sandbox,
  );
  vm.runInContext(
    'token=adminToken; config=initialConfig; status=initialStatus; tab="memory"; render()',
    sandbox,
  );
  node("#memory-agent").value = "agent-0";
  await node("#export-memory").onclick();
  // On open the memory tab also reads the agent's conversations for the
  // source picker, the people it knows and its latest records.
  assert.deepEqual(
    calls.filter(
      (url) => !/^\/api\/(conversations|known-targets|memory)\?/.test(url),
    ),
    ["/api/export/ticket"],
  );
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].method, "POST");
  assert.equal(submitted[0].action, "/api/export/download");
  assert.equal(submitted[0].children[0].name, "ticket");
  assert.notEqual(submitted[0].children[0].value, f.token);
  assert.equal(
    (
      await f.request(submitted[0].action, {
        auth: false,
        method: "POST",
        body: new URLSearchParams({ ticket: submitted[0].children[0].value }),
      })
    ).status,
    200,
  );
});
test("export size and time budgets fail before headers and clean temporary snapshots", async (t) => {
  for (const [limits, code, status] of [
    [{ rowBytes: 500 }, "EXPORT_ROW_BUDGET", 429],
    [{ outputBytes: 100 }, "EXPORT_OUTPUT_BUDGET", 429],
    [{ snapshotBytes: 1 }, "EXPORT_SNAPSHOT_BUDGET", 429],
    [{ snapshotMs: 0 }, "EXPORT_TIMEOUT", 503],
    [{ timeoutMs: 1 }, "EXPORT_TIMEOUT", 503],
  ])
    await t.test(code, async (t) => {
      const tempRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "qq-export-budget-test-"),
      );
      t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
      const { request, store } = await setup(t, { limits, tempRoot });
      store
        .bind("agent-0")
        .diaryWrite({ title: "large", body: "x".repeat(2000) });
      const response = await request("/api/export?agentId=agent-0");
      assert.equal(response.status, status);
      assert.equal((await response.json()).error, code);
      assert.deepEqual(fs.readdirSync(tempRoot), []);
      assert.equal((await request("/api/status")).status, 200);
    });
});
test(
  "a slow export download applies backpressure, excludes concurrent exports, and cancels cleanly",
  { timeout: 30000 },
  async (t) => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "qq-export-cancel-test-"),
    );
    t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
    const { request, store, base, token } = await setup(t, { tempRoot });
    for (let i = 0; i < 80; i++)
      store.bind("agent-0").append({
        dedupe: "large-" + i,
        conversation: "group:20000",
        kind: "message.received",
        body: "x".repeat(64000),
      });
    const response = await new Promise((resolve, reject) => {
      const req = http.get(
        base + "/api/export?agentId=agent-0",
        { headers: { "x-admin-token": token } },
        (res) => {
          res.pause();
          resolve(res);
        },
      );
      req.on("error", reject);
    });
    assert.equal(response.statusCode, 200);
    const other = await request("/api/export?agentId=agent-0");
    assert.equal(other.status, 429);
    assert.equal((await other.json()).error, "EXPORT_DOWNLOAD_BUSY");
    assert.equal((await request("/api/status")).status, 200);
    response.destroy();
    for (let i = 0; i < 100 && fs.readdirSync(tempRoot).length; i++)
      await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(fs.readdirSync(tempRoot), []);
  },
);
test(
  "shutdown cancels export preparation and waits for worker and snapshot cleanup",
  { timeout: 30000 },
  async (t) => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "qq-export-stop-test-"),
    );
    t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
    const { request, store, app } = await setup(t, { tempRoot });
    for (let i = 0; i < 80; i++)
      store.bind("agent-0").append({
        dedupe: "stop-" + i,
        conversation: "group:20000",
        kind: "message.received",
        body: "x".repeat(64000),
      });
    const download = request("/api/export?agentId=agent-0")
      .then((res) => res.arrayBuffer())
      .catch(() => {});
    for (let i = 0; i < 200 && !fs.readdirSync(tempRoot).length; i++)
      await new Promise((r) => setTimeout(r, 1));
    assert.equal(fs.readdirSync(tempRoot).length, 1);
    await app.close();
    await download;
    assert.deepEqual(fs.readdirSync(tempRoot), []);
  },
);
test("static console has CSP and never exposes admin token", async (t) => {
  const { request, token } = await setup(t);
  const r = await request("/", { auth: false });
  assert.match(
    r.headers.get("content-security-policy"),
    /frame-ancestors 'none'/,
  );
  const html = await r.text();
  assert.ok(html.includes("QQ Agents"));
  assert.ok(!html.includes(token));
  assert.equal(
    (await request("/../../package.json", { auth: false })).status,
    401,
  );
});
test("MCP stdio handshake and memory roundtrip use live scoped capability", async (t) => {
  const { base, runtime, store } = await setup(t);
  const ctx = context(runtime);
  store.bind("agent-0").append({
    dedupe: "mcp",
    conversation: "group:20000",
    kind: "message.received",
    body: "MCP中文约定",
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/mcp.mjs"],
    env: { PATH: process.env.PATH, QQ_UNIFIED_URL: base },
    stderr: "pipe",
  });
  const client = new Client({ name: "test", version: "1" });
  await client.connect(transport);
  t.after(() => client.close());
  const catalog = await client.listTools();
  assert.deepEqual(
    catalog.tools.map((x) => x.name),
    ["bridge_tools", "bridge_call"],
  );
  const capability = catalog.tools.find((x) => x.name === "bridge_call")
    .inputSchema.properties.context;
  assert.match(capability.description, /copy.*context=/i);
  assert.match(capability.description, /not.*explanation/i);
  const invalid = await client.callTool({
    name: "bridge_tools",
    arguments: { context: "This is an explanation of the current task" },
  });
  assert.equal(invalid.isError, true);
  const discovery = await client.callTool({
    name: "bridge_tools",
    arguments: { context: ctx.token, names: ["memory_search"] },
  });
  const found = JSON.parse(discovery.content[0].text);
  assert.equal(found.tools[0].name, "memory_search");
  assert(!found.tools[0].inputSchema.properties.context);
  const r = await client.callTool({
    name: "bridge_call",
    arguments: {
      context: ctx.token,
      name: "memory_search",
      arguments: { query: "中文约定" },
    },
  });
  assert.match(r.content[0].text, /MCP中文约定/);
  const subject = context(runtime, "agent-0", "@subject");
  const denied = await client.callTool({
    name: "bridge_tools",
    arguments: { context: subject.token, names: ["qq_send"] },
  });
  assert.equal(denied.isError, true);
  await runtime.pause("all", true);
  const paused = await client.callTool({
    name: "bridge_call",
    arguments: { context: ctx.token, name: "memory_search", arguments: {} },
  });
  assert.equal(paused.isError, true);
});

test("scheduler HTTP CRUD and preview persist while isolated execution is refused", async (t) => {
  const { request, runtime } = await setup(t);
  const post = (data) =>
    request("/api/schedules", {
      method: "POST",
      body: JSON.stringify({ agentId: "agent-0", ...data }),
    });
  const task = {
    name: "控制台提醒",
    kind: "text",
    text: "本地合成提醒",
    targets: ["group:20000"],
    schedule: { type: "daily", times: ["09:00"] },
    jitterMin: 0,
  };
  const created = await (await post({ action: "create", task })).json();
  assert.ok(created.id);
  const preview = await (await post({ action: "preview", task })).json();
  assert.equal(preview.next.length, 5);
  assert.equal(
    (await post({ action: "update", id: created.id, task: { name: "已编辑" } }))
      .status,
    200,
  );
  const list = await (await request("/api/schedules?agentId=agent-0")).json();
  assert.equal(list.tasks[0].name, "已编辑");
  const run = await post({ action: "run", id: created.id, requestId: "ui" });
  assert.equal((await run.json()).error, "ISOLATED_MODE");
  assert.equal(runtime.transports.get("qq-0").sent.length, 0);
  assert.equal((await post({ action: "delete", id: created.id })).status, 200);
});
test("voice HTTP import and playback require admin and preserve agent ownership", async (t) => {
  const { request, runtime, root } = await setup(t);
  runtime.voices = new VoiceStore(root + "/voices");
  const response = await request("/api/voices/import", {
    method: "POST",
    body: JSON.stringify({
      agentId: "agent-0",
      title: "合成测试音",
      base64: wav().toString("base64"),
    }),
  });
  assert.equal(response.status, 200);
  const asset = await response.json();
  const url = "/api/voices/play?agentId=agent-0&id=" + asset.id;
  assert.equal((await request(url, { auth: false })).status, 401);
  const audio = await request(url);
  assert.deepEqual(Buffer.from(await audio.arrayBuffer()), wav());
  assert.equal((await request(url.replace("agent-0", "agent-1"))).status, 400);
  assert.equal(
    (await (await request("/api/voices?agentId=agent-0")).json()).total,
    1,
  );
});

test("admin memory search and context routes retain group scene and enforce agent ownership", async (t) => {
  const { request, store } = await setup(t);
  const mem = store.bind("agent-0");
  const e = mem.append({
    dedupe: "scene-ui",
    conversation: "group:20000",
    connectionId: "qq-0",
    kind: "message.received",
    senderId: "30000",
    body: "xxx",
    payload: { raw: { group_name: "场景验收群" } },
  });
  mem.append({
    dedupe: "scene-ui-b",
    conversation: "group:20000",
    connectionId: "qq-0",
    kind: "message.received",
    senderId: "30001",
    body: "yyy",
  });
  const result = await (
    await request(
      "/api/memory?agentId=agent-0&query=xxx&contextBefore=1&contextAfter=1",
    )
  ).json();
  assert.equal(result.items[0].scene.source.name, "场景验收群");
  assert.deepEqual(
    result.items[0].scene.messages.map((x) => x.body),
    ["xxx", "yyy"],
  );
  const around = await (
    await request("/api/memory/conversation?agentId=agent-0&aroundId=" + e.id)
  ).json();
  assert.deepEqual(
    around.items.map((x) => x.body),
    ["xxx", "yyy"],
  );
  assert.notEqual(
    (await request("/api/memory/conversation?agentId=agent-1&aroundId=" + e.id))
      .status,
    200,
  );
  assert.equal(
    (
      await request(
        "/api/memory/conversation?agentId=agent-0&aroundId=" + e.id,
        { auth: false },
      )
    ).status,
    401,
  );
});

test("pausing one conversation stops only that conversation's turn", async (t) => {
  const { request, runtime, store } = await setup(t);
  const group = context(runtime, "agent-0", "group:20000"),
    other = context(runtime, "agent-0", "private:30000");
  let finished = false;
  group.done = new Promise((resolve) =>
    group.controller.signal.addEventListener("abort", () =>
      setTimeout(() => {
        finished = true;
        resolve();
      }, 10),
    ),
  );
  runtime.running.set("agent-0|group:20000", group);
  runtime.operations.levels.set("agent-0|private:30000", {
    level: "L1",
    activeAt: runtime.now(),
  });
  const response = await request("/api/conversation/state", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agentId: "agent-0",
      conversation: "group:20000",
      paused: true,
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(group.controller.signal.aborted, true);
  assert.equal(finished, true, "response waits for the stopping turn");
  assert.equal(other.controller.signal.aborted, false);
  assert.equal(runtime.capabilities.has(other.token), true);
  assert.equal(runtime.operations.levels.has("agent-0|private:30000"), true);
  assert.equal(store.bind("agent-0").state("group:20000").paused, true);
  runtime.running.delete("agent-0|group:20000");
});

test("protected work creation and exact-result release require administrator credentials", async (t) => {
  const f = await setup(t);
  const body = { agentId: "agent-0", instruction: "PRIVATE_TASK" };
  const post = (value, auth = true, headers = {}) =>
    f.request("/api/protected-work", {
      method: "POST",
      auth,
      headers,
      body: JSON.stringify(value),
    });
  assert.equal((await post(body, false)).status, 401);
  const daily = context(f.runtime);
  assert.equal(
    (await post(body, false, { "x-agent-capability": daily.token })).status,
    401,
  );
  const response = await post(body);
  assert.equal(response.status, 200);
  const task = await response.json();
  const work = context(f.runtime, "agent-0", "@work:" + task.id);
  await f.runtime.callTool(work, "protected_work_submit", {
    text: "Approved public result",
  });
  const latest = f.runtime.protectedWork.task("agent-0", work.conversation);
  const release = {
    agentId: "agent-0",
    taskId: task.id,
    action: "release",
    revision: latest.revision,
    digest: latest.result.digest,
    target: "group:20000",
  };
  assert.equal((await post(release, false)).status, 401);
  assert.equal(
    (await post({ ...release, digest: "0".repeat(64) })).status,
    400,
  );
  const result = await post(release);
  assert.equal(result.status, 200);
  assert.equal((await result.json()).sent, false);
  assert.equal(f.runtime.transports.get("qq-0").sent.length, 0);
});
