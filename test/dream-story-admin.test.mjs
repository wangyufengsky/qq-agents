import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "../src/server.mjs";
import { config, fixture } from "./helpers.mjs";

test("administrator can trigger and read fictional stories for an imaginative-only role", async (t) => {
  const cfg = config(2);
  const [role, other] = cfg.agents;
  role.dream.enabled = true;
  role.dream.backendId = role.backendId;
  role.dream.cognitive.enabled = false;
  role.dream.imaginative.enabled = true;
  role.dream.imaginative.model = "fixture-story-model";
  other.dream.enabled = true;
  other.dream.cognitive.model = "fixture-cognition-model";
  other.dream.imaginative.enabled = true;
  other.dream.imaginative.model = "fixture-other-story-model";
  const backend = {
    ...cfg.backends[0],
    id: "fixture-dedicated",
    type: "dsh",
    preset: "qq-unified",
    baseUrl: "http://127.0.0.1:9",
    functionalAgentOnly: true,
    provider: "fixture",
    model: "fixture-default-model",
  };
  cfg.backends.push(backend);

  const story = {
    schemaVersion: 1,
    title: "月亮邮局",
    narrative: "梦见一只猫把月光装进了信封。",
    reflection: "醒来时想起了纸的触感。",
    themes: ["月光", "信件"],
    inspirations: [{ kind: "diary", content: "试写一篇信件体日记。" }],
  };
  const f = fixture(t, {
    cfg,
    run: async (params) => {
      assert.match(params.conversation, /dream-imaginative/);
      await params.callTool("dream_story_submit", story);
    },
  });
  const token = randomBytes(32).toString("hex");
  const app = createServer({ runtime: f.runtime, token });
  const port = await app.listen();
  t.after(() => app.close());
  const request = (path, { credential = token, data } = {}) =>
    fetch(`http://127.0.0.1:${port}/api/dreams/${path}`, {
      method: data ? "POST" : "GET",
      headers: {
        ...(credential ? { "x-admin-token": credential } : {}),
        ...(data ? { "content-type": "application/json" } : {}),
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
  const query = "?agentId=" + role.id;
  const get = async (path, suffix = query) => {
    const response = await request(path + suffix);
    assert.equal(response.status, 200);
    return response.json();
  };
  const trigger = (mode, credential = token) =>
    request("trigger", { credential, data: { agentId: role.id, mode } });
  const conflict = async (mode, error) => {
    const response = await trigger(mode);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, error);
  };

  const before = await get("overview");
  assert.equal(before.enabled, true);
  assert.equal(before.cognitive.enabled, false);
  assert.deepEqual(before.imaginative, {
    enabled: true,
    backendId: role.backendId,
    model: role.dream.imaginative.model,
    dedicated: false,
    used: 0,
    limit: 1,
  });
  const otherOverview = await get("overview", "?agentId=" + other.id);
  assert.equal(otherOverview.cognitive.model, other.dream.cognitive.model);
  assert.equal(otherOverview.imaginative.model, other.dream.imaginative.model);
  assert.equal(otherOverview.cognitive.backendId, backend.id);
  assert.equal(otherOverview.imaginative.backendId, backend.id);

  const ctx = f.runtime.makeContext(role.id, "group:20000");
  assert.equal(
    (await request("stories" + query, { credential: null })).status,
    401,
  );
  assert.equal(
    (await request("stories" + query, { credential: ctx.token })).status,
    401,
  );
  assert.equal((await trigger("imaginative", ctx.token)).status, 401);
  await conflict("nap", "DREAM_DISABLED");

  for (const paused of [true, false]) {
    const response = await request("pause", {
      data: { agentId: role.id, paused },
    });
    assert.equal(response.status, 200);
    assert.equal((await get("overview")).paused, paused);
    if (paused) await conflict("imaginative", "DREAM_DISABLED");
  }

  const accepted = await trigger("imaginative");
  assert.equal(accepted.status, 202);
  const { runId, status } = await accepted.json();
  assert.ok(runId);
  assert.ok(["RUNNING", "QUEUED"].includes(status));
  while (f.runtime.work.size) await Promise.allSettled([...f.runtime.work]);

  const { items: runs } = await get("runs");
  assert.equal(runs.length, 1);
  assert.equal(runs[0].run_id, runId);
  assert.equal(runs[0].mode, "imaginative");
  assert.equal(runs[0].trigger, "manual");
  assert.equal(runs[0].status, "COMMITTED", runs[0].error_code);
  assert.equal(runs[0].backend_id, role.backendId);
  assert.equal(runs[0].model, role.dream.imaginative.model);
  const { items } = await get("stories");
  assert.equal(items.length, 1);
  const [row] = items;
  assert.equal(row.run_id, runId);
  assert.equal(row.fictional, 1);
  assert.equal(row.title, story.title);
  assert.equal(row.narrative, story.narrative);
  assert.equal(row.reflection, story.reflection);
  assert.deepEqual(JSON.parse(row.themes_json), story.themes);
  assert.deepEqual(JSON.parse(row.inspirations_json), story.inspirations);
  assert.equal(row.published_room_slot, null);
  assert.equal(row.published_at, null);
  assert.deepEqual((await get("stories", "?agentId=" + other.id)).items, []);
  assert.deepEqual((await get("cognitions")).items, []);

  const after = await get("overview");
  assert.equal(after.used, 1);
  assert.equal(after.imaginative.used, 1);
  assert.ok(after.used < after.limit);
  await conflict("imaginative", "DREAM_BUDGET_EXCEEDED");
});
