import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { randomBytes } from "node:crypto";
import { fixture, config, settle } from "./helpers.mjs";
import { createServer } from "../src/server.mjs";

async function consoleFixture(t, options) {
  const f = fixture(t, options),
    token = randomBytes(32).toString("hex");
  const app = createServer({ runtime: f.runtime, token, allowLive: true });
  const port = await app.listen();
  t.after(() => app.close());
  const api = async (route, data, method = "POST") => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method: data === undefined ? "GET" : method,
      headers: { "x-admin-token": token, "content-type": "application/json" },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  return { ...f, api };
}

async function render(f) {
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, {});
    return nodes.get(id);
  };
  const sandbox = vm.createContext({
    config: f.runtime.config,
    revision: f.configStore.revision,
    tab: "mind",
    api: f.api,
    $: node,
    esc: (x) => String(x ?? ""),
    check: () => "",
    input: () => "",
    area: () => "",
    URLSearchParams,
    document: { querySelectorAll: () => [] },
  });
  vm.runInContext(
    fs.readFileSync(new URL("../public/mind-ui.js", import.meta.url), "utf8"),
    sandbox,
  );
  await vm.runInContext("renderMind()", sandbox);
  return node("#mind-body").innerHTML;
}

test("subject history and console survive more than fifty later chat turns", async (t) => {
  const f = await consoleFixture(t);
  const m = f.store.bind("agent-0");
  const start = Date.now() - 3600000;
  for (let n = 0; n < 12; n++)
    m.identity.put("model_turns", {
      id: "subject-" + n,
      conversation: "@subject",
      startedAt: start + n,
      status: n === 11 ? "failed" : "completed-no-send",
      selfVersion: 1,
    });
  for (let n = 0; n < 60; n++)
    m.identity.put("model_turns", {
      id: "chat-" + n,
      conversation: "group:20000",
      startedAt: start + 100 + n,
      status: "completed-no-send",
      selfVersion: 1,
    });
  f.store.bind("agent-1").identity.put("model_turns", {
    id: "other-agent",
    conversation: "@subject",
    startedAt: start + 200,
  });
  // Updating an old record must not reorder history by SQLite insertion order.
  m.identity.put("model_turns", m.identity.get("model_turns", "subject-0"));
  const data = await f.api("/api/mind?agentId=agent-0");
  assert.deepEqual(
    data.subject.turns?.map((x) => x.id),
    Array.from({ length: 10 }, (_, n) => "subject-" + (11 - n)),
  );
  const html = await render(f);
  assert.doesNotMatch(html, /尚未思考/);
  assert.match(html, /已完成（无 QQ 发送）/);
  assert.match(html, /思考失败/);
  // Current self reads in full; the editor stays hidden until 修改.
  assert.match(html, /<div id="self-view" class="self-view">[^<]+<\/div>/);
  assert.match(html, /<button type="button" id="self-edit">修改<\/button>/);
  assert.match(html, /<form id="self-form" hidden>/);
  assert.match(html, /id="self-cancel">取消<\/button>/);
});

test("subject check status shows rolling budget release and real offline gate without writing state", async (t) => {
  const cfg = config(1);
  cfg.agents[0].subject.enabled = true;
  cfg.agents[0].subject.maxChecksPerDay = 2;
  const f = await consoleFixture(t, { cfg });
  const now = Date.now();
  f.runtime.clock = () => new Date(now);
  const m = f.store.bind("agent-0");
  const checks = [now - 30000, now - 20000, now - 10000];
  m.setState("@subject", { checks, nextCheckAt: now - 1000 });
  const before = m.state("@subject");
  let data = await f.api("/api/mind?agentId=agent-0");
  assert.equal(data.subject.checkStatus.state, "budget-exhausted");
  assert.equal(data.subject.checkStatus.nextEligibleAt, checks[1] + 86400000);
  assert.equal(data.subject.checkStatus.remaining, 0);
  assert.match(await render(f), /检查额度已用完/);
  f.runtime.transports.get("qq-0").close();
  data = await f.api("/api/mind?agentId=agent-0");
  assert.equal(data.subject.checkStatus.state, "offline");
  assert.equal(data.subject.checkStatus.nextEligibleAt, null);
  assert.deepEqual(m.state("@subject"), before);
});

test("raising subject quota resumes due checks without disconnecting or erasing spent checks", async (t) => {
  const cfg = config(1);
  cfg.agents[0].subject.enabled = true;
  cfg.agents[0].subject.maxChecksPerDay = 1;
  let calls = 0;
  const f = await consoleFixture(t, {
    cfg,
    run: async () => {
      calls++;
    },
  });
  const now = Date.now();
  f.runtime.clock = () => new Date(now);
  const m = f.store.bind("agent-0");
  m.setState("@subject", {
    checks: [now - 7200000],
    lastOpportunityAt: now - 7200000,
    nextCheckAt: now - 3600000,
  });
  f.runtime.subject.tick();
  await settle(f.runtime);
  assert.equal(calls, 0);
  const transport = f.runtime.transports.get("qq-0");
  const next = structuredClone(f.runtime.config);
  next.agents[0].subject.maxChecksPerDay = 24;
  const saved = await f.api(
    "/api/config",
    { config: next, revision: f.configStore.revision },
    "PUT",
  );
  assert.equal(saved.reconnectRequired, false);
  assert.equal(f.runtime.transports.get("qq-0"), transport);
  assert.equal(transport.connected, true);
  f.runtime.subject.tick();
  await settle(f.runtime);
  assert.equal(calls, 1);
  assert.deepEqual(m.state("@subject").checks, [now - 7200000, now]);
  f.runtime.subject.tick();
  await settle(f.runtime);
  assert.equal(calls, 1);
  const data = await f.api("/api/mind?agentId=agent-0");
  assert.equal(data.subject.checkStatus.state, "waiting");
  assert.equal(data.subject.checkStatus.nextEligibleAt, now + 3600000);
});

test("interval changes recompute due time while current model work and permissions remain intact", async (t) => {
  const cfg = config(1);
  cfg.agents[0].subject.enabled = true;
  let finish;
  const f = await consoleFixture(t, {
    cfg,
    run: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const now = Date.now();
  f.runtime.clock = () => new Date(now);
  const m = f.store.bind("agent-0");
  m.setState("@subject", {
    checks: [now - 1800000],
    lastOpportunityAt: now - 1800000,
    nextCheckAt: now + 1800000,
  });
  const job = f.runtime.wake("agent-0", "group:20000");
  const ctx = f.runtime.running.get("agent-0|group:20000");
  const backend = f.runtime.backends.get("agent-0");
  for (const intervalMs of [60000, 7200000]) {
    const next = structuredClone(f.runtime.config);
    next.agents[0].subject.intervalMs = intervalMs;
    const result = await f.runtime.changeConfig(next, f.configStore.revision);
    assert.equal(result.reconnectRequired, false);
    assert.equal(f.runtime.capability(ctx.token), ctx);
    assert.equal(ctx.controller.signal.aborted, false);
    assert.equal(f.runtime.backends.get("agent-0"), backend);
    assert.equal(m.state("@subject").nextCheckAt, now - 1800000 + intervalMs);
    assert.deepEqual(m.state("@subject").checks, [now - 1800000]);
  }
  finish();
  await job;
  const next = structuredClone(f.runtime.config);
  next.agents[0].subject.maxChecksPerDay = 24;
  next.agents[0].subject.enabled = false;
  assert.equal(
    (await f.runtime.changeConfig(next, f.configStore.revision))
      .reconnectRequired,
    false,
  );
  assert.equal(f.runtime.transports.size, 1);
});
