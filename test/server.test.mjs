import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer } from "../src/server.mjs";
import { VoiceStore } from "../src/tools/voice.mjs";
import { wav } from "./audio-fixture.mjs";
import { fixture, context } from "./helpers.mjs";
async function setup(t) {
  const f = fixture(t),
    token = randomBytes(32).toString("hex"),
    app = createServer({ runtime: f.runtime, token });
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
  value.mode = "isolated";
  const save = () =>
    request("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ config: value, revision: 0 }),
    });
  assert.equal((await save()).status, 200);
  assert.equal((await save()).status, 409);
  value.mode = "live";
  const r = await request("/api/config", {
    method: "PUT",
    body: JSON.stringify({ config: value, revision: 1 }),
  });
  assert.equal(r.status, 400);
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
});
test("static console has CSP and never exposes admin token", async (t) => {
  const { request, token } = await setup(t);
  const r = await request("/", { auth: false });
  assert.match(
    r.headers.get("content-security-policy"),
    /frame-ancestors 'none'/,
  );
  const html = await r.text();
  assert.ok(html.includes("QQ Bridge"));
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
