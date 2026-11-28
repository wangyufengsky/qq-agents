import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { dreamAdmin } from "../src/dream/admin.mjs";
import { listCognitions } from "../src/dream/store.mjs";
import { createServer } from "../src/server.mjs";
import { config, fixture } from "./helpers.mjs";

test("administrator alone can read, trigger, filter, roll back, pause and delete role cognitions", async (t) => {
  const cfg = config(2);
  cfg.agents[0].dream.enabled = true;
  const role = "agent-0";
  let operation;
  const f = fixture(t, {
    cfg,
    run: async (p) => {
      p.onUsage({ source: "estimated", contextTokens: 100 });
      await p.callTool("dream_cognition_submit", {
        schemaVersion: 1,
        operations: [operation],
        awakeningSummary: "",
        noChangesReason: null,
      });
    },
  });
  const token = randomBytes(32).toString("hex"),
    app = createServer({ runtime: f.runtime, token });
  const port = await app.listen();
  t.after(() => app.close());
  const request = (path, { method = "GET", data, credential = token } = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        ...(credential ? { "x-admin-token": credential } : {}),
        ...(data ? { "content-type": "application/json" } : {}),
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
  const get = async (path) => {
    const response = await request(path);
    assert.equal(response.status, 200);
    return response.json();
  };
  const post = (path, data) => request(path, { method: "POST", data });
  const query = "?agentId=" + role;
  const overview = "/api/dreams/overview" + query;
  const ctx = f.runtime.makeContext(role, "group:20000");
  assert.equal((await request(overview, { credential: null })).status, 401);
  assert.equal(
    (await request(overview, { credential: ctx.token })).status,
    401,
  );
  assert.equal(
    (await request("/dream-ui.js", { credential: null })).status,
    200,
  );

  for (const [asset, type] of [
    ["/dream.css", "text/css"],
    ["/dream-art/moon-lake.webp", "image/webp"],
    ["/dream-art/paper-boat.webp", "image/webp"],
    ["/dream-art/shore.webp", "image/webp"],
  ]) {
    const assetResponse = await request(asset, { credential: null });
    assert.equal(assetResponse.status, 200);
    assert.ok(assetResponse.headers.get("content-type").startsWith(type));
  }

  const memory = f.store.bind(role);
  const event = memory.append({
    dedupe: "admin-source",
    conversation: "group:20000",
    kind: "message.received",
    body: "首次交流。",
  });
  operation = {
    op: "ADD",
    category: "fact",
    scopeId: "group:20000",
    subjectKey: "admin:fixture",
    content: "第一版认知。",
    epistemicStatus: "reported",
    evidenceIds: [event.id],
    importance: 0.5,
    confidence: 0.5,
    reason: "来源可查",
  };
  const launched = await post("/api/dreams/trigger", {
    agentId: role,
    mode: "nap",
  });
  assert.equal(launched.status, 202);
  const receipt = await launched.json();
  assert.ok(receipt.runId);
  while (f.runtime.work.size) await Promise.allSettled([...f.runtime.work]);
  const runs = await get("/api/dreams/runs" + query);
  assert.equal(runs.items[0].status, "COMMITTED");
  assert.deepEqual(JSON.parse(runs.items[0].usage_json), {
    source: "estimated",
    contextTokens: 100,
  });
  assert.equal((await get(overview)).lag.events, 0);
  assert.deepEqual((await get("/api/dreams/stories" + query)).items, []);

  const found = await get(
    "/api/dreams/cognitions" + query + "&category=fact&scopeId=group%3A20000",
  );
  assert.equal(found.items.length, 1);
  const id = found.items[0].id;
  const path = "/api/dreams/cognitions/" + id;
  assert.equal(
    (await get(path + "/revisions" + query)).evidence[0].source_id,
    event.id,
  );
  assert.equal(
    (await request(path + "/revisions?agentId=agent-1")).status,
    404,
  );
  assert.equal(
    (
      await post(path + "/rollback", {
        agentId: role,
        version: 1,
        expectedVersion: 2,
      })
    ).status,
    409,
  );
  const rollback = await post(path + "/rollback", {
    agentId: role,
    version: 1,
    expectedVersion: 1,
  });
  assert.equal(rollback.status, 200);
  assert.equal((await rollback.json()).version, 2);
  assert.equal(
    (
      await request(path, {
        method: "DELETE",
        data: { agentId: role, expectedVersion: 2 },
      })
    ).status,
    200,
  );
  assert.equal((await get("/api/dreams/cognitions" + query)).items.length, 0);
  assert.equal(
    (await post("/api/dreams/pause", { agentId: role, paused: true })).status,
    200,
  );
  assert.equal((await get(overview)).paused, true);
  assert.equal(
    (await post("/api/dreams/trigger", { agentId: role, mode: "nap" })).status,
    409,
  );
  assert.equal(
    (await post("/api/dreams/trigger", { agentId: role, mode: "long" })).status,
    409,
  );
});

test("cognition history counts only matching rows and pages deterministically by update time", async (t) => {
  const f = fixture(t, { cfg: config(2) });
  const insert = f.store.db.prepare(`INSERT INTO cognitions
 (id,agent_id,scope_id,category,subject_key,content,epistemic_status,importance,confidence,status,version,source_scopes_json,valid_from,created_at,updated_at)
 VALUES(?,?,'global',?,?,?,'reported',?,0.5,?,1,'[]','2026-01-01','2026-01-01',?)`);
  const seed = (id, role, category, status, day, importance) =>
    insert.run(
      id,
      role,
      category,
      id,
      "示例认知",
      importance,
      status,
      `2026-01-${day}`,
    );
  for (const id of ["a", "b", "c", "d", "e", "f"])
    seed(
      id,
      "agent-0",
      "fact",
      "active",
      id === "f" ? "11" : "10",
      id === "b" ? 1 : 0.1,
    );
  seed("g", "agent-1", "fact", "active", "12", 1);
  seed("h", "agent-0", "fact", "archived", "12", 1);
  seed("i", "agent-0", "reflection", "active", "12", 1);
  const page = async (offset, query = "示例") => {
    const url = new URL("/api/dreams/cognitions", "http://localhost");
    url.search = new URLSearchParams({
      agentId: "agent-0",
      category: "fact",
      status: "active",
      scopeId: "global",
      query,
      limit: 5,
      offset,
    });
    const response = await dreamAdmin(f.runtime, "GET", url, () =>
      assert.fail(),
    );
    assert.equal(response.status, 200);
    return response.result;
  };
  const first = await page(0),
    last = await page(5);
  assert.deepEqual(
    first.items.map((row) => row.id),
    ["f", "a", "b", "c", "d"],
  );
  assert.equal(first.total, 6);
  assert.equal(first.nextOffset, 5);
  assert.deepEqual(
    last.items.map((row) => row.id),
    ["e"],
  );
  assert.equal(last.total, 6);
  assert.equal(last.nextOffset, null);
  assert.deepEqual(await page(0, "未命中"), {
    items: [],
    total: 0,
    nextOffset: null,
  });
  assert.equal(
    listCognitions(f.store.db, "agent-0", { category: "fact" })[0].id,
    "b",
  );
});
