import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fixture, context } from "./helpers.mjs";
import { FileStore } from "../src/tools/files.mjs";
import { createServer } from "../src/server.mjs";
import { compareProjectText } from "../src/core/projects-console.mjs";

async function setup(t) {
  const f = fixture(t),
    token = randomBytes(32).toString("hex");
  f.runtime.files = new FileStore(path.join(f.root, "files"));
  const app = createServer({ runtime: f.runtime, token });
  const port = await app.listen();
  t.after(() => app.close());
  const request = (route, auth = true) =>
    fetch(`http://127.0.0.1:${port}${route}`, {
      headers: auth ? { "x-admin-token": token } : {},
    });
  const identity = f.store.bind("agent-0").identity;
  const put = (name, text) =>
    f.runtime.files.put(
      "agent-0",
      Buffer.from(text),
      name,
      f.runtime.agent("agent-0").files,
    );
  const project = (args = {}) =>
    identity.saveProject(
      { title: "个人故事", why: "逐步完成", ...args },
      { writtenIn: "@subject", now: Date.now() },
    );
  return { ...f, request, identity, put, project };
}
test("project workspace filters and pages role-owned records without returning draft bodies", async (t) => {
  const f = await setup(t);
  for (let i = 0; i < 22; i++) {
    const p = f.project({ title: "个人故事" + i });
    f.identity.saveProject(
      {
        id: p.id,
        expectedRevision: p.revision,
        status: "done",
        outcome: "已完成",
      },
      { now: Date.now() },
    );
  }
  const current = f.project();
  const route = "/api/projects?agentId=agent-0";
  assert.equal((await f.request(route, false)).status, 401);
  const first = await (await f.request(route)).json();
  assert.equal(first.total, 23);
  assert.equal(first.items.length, 20);
  assert.equal(first.nextOffset, 20);
  assert.equal(
    (await (await f.request(route + "&offset=20")).json()).items.length,
    3,
  );
  const active = await (
    await f.request(route + "&status=active&kind=personal")
  ).json();
  assert.deepEqual(
    active.items.map((p) => p.id),
    [current.id],
  );
  assert.equal(
    (
      await (
        await f.request(route + "&query=" + encodeURIComponent("个人故事21"))
      ).json()
    ).total,
    1,
  );
  assert.equal(
    (await (await f.request(route.replace("agent-0", "agent-1"))).json()).total,
    0,
  );
  assert.ok(!(await f.request(route + "&offset=-1")).ok);
});
test("comparisons use complete immutable text and require explicit membership in the project", async (t) => {
  const f = await setup(t),
    prefix = "相同".repeat(12000);
  const before = f.put("version-one.md", prefix + "👍🏽旧结尾"),
    after = f.put("renamed.md", prefix + "👍🏻新结尾");
  const foreign = f.put("unrelated.md", "not a project work");
  const p = f.project({ files: [after.fileId, before.fileId] });
  const route =
    "/api/projects/compare?" +
    new URLSearchParams({
      agentId: "agent-0",
      id: p.id,
      before: "file:" + before.fileId,
      after: "file:" + after.fileId,
    });
  assert.equal((await f.request(route, false)).status, 401);
  const result = await (await f.request(route)).json();
  assert.equal(result.identical, false);
  assert.equal(result.before.start, prefix.length);
  assert.equal(result.before.text, "👍🏽旧");
  assert.equal(result.after.text, "👍🏻新");
  assert.equal(result.before.truncated, false);
  assert.ok(!(await f.request(route.replace(after.fileId, foreign.fileId))).ok);
  assert.ok(!(await f.request(route.replace("agent-0", "agent-1"))).ok);
  assert.deepEqual(f.identity.project(p.id), p);
  const long = compareProjectText("a".repeat(20000), "b".repeat(20000));
  assert.equal(long.before.text.length, 16000);
  assert.equal(long.before.truncated, true);
});
test("activity comparisons resolve the actual inherited draft for any saved revision", async (t) => {
  const f = await setup(t),
    ctx = context(f.runtime),
    m = f.store.bind("agent-0");
  const event = m.append({
    dedupe: "join",
    connectionId: "qq-0",
    conversation: ctx.conversation,
    kind: "message.received",
    senderId: "30000",
    body: "一起写",
    payload: { trustedInput: true },
  });
  f.runtime.observeInput(ctx, [
    m.readRecord({ id: event.id }, ctx.conversation),
  ]);
  const p = await f.runtime.callTool(ctx, "project", {
    title: "共同故事",
    why: "一起写",
    participantEventId: event.id,
    shared: { participants: ["30000"], turn: "agent" },
    draft: { title: "原稿", text: "第一版" },
  });
  await f.runtime.callTool(ctx, "project", {
    id: p.id,
    expectedRevision: 1,
    progress: "查阅资料",
  });
  await f.runtime.callTool(ctx, "projects", { id: p.id });
  await f.runtime.callTool(ctx, "project", {
    id: p.id,
    expectedRevision: 2,
    draft: { title: "原稿", text: "第二版" },
  });
  const route =
    "/api/projects/compare?" +
    new URLSearchParams({
      agentId: "agent-0",
      id: p.id,
      before: "draft:2",
      after: "draft:3",
    });
  const result = await (await f.request(route)).json();
  assert.equal(result.before.text, "一");
  assert.equal(result.after.text, "二");
  const list = await (
    await f.request("/api/projects?agentId=agent-0&kind=shared")
  ).json();
  assert.equal(list.items[0].id, p.id);
  assert.ok(!JSON.stringify(list).includes("第二版"));
});

test("draft pages keep joined emoji intact and only a contiguous complete read permits rewriting", async (t) => {
  const f = await setup(t),
    ctx = context(f.runtime),
    m = f.store.bind("agent-0");
  const event = m.append({
    dedupe: "emoji-join",
    connectionId: "qq-0",
    conversation: ctx.conversation,
    kind: "message.received",
    senderId: "30000",
    body: "一起写",
    payload: { trustedInput: true },
  });
  f.runtime.observeInput(ctx, [
    m.readRecord({ id: event.id }, ctx.conversation),
  ]);
  const body = "x".repeat(7999) + "👍🏽" + "结尾";
  const p = await f.runtime.callTool(ctx, "project", {
    title: "表情故事",
    why: "保留原稿",
    participantEventId: event.id,
    shared: { participants: ["30000"], turn: "agent" },
    draft: { title: "原稿", text: body },
  });
  const first = await f.runtime.callTool(ctx, "projects", { id: p.id });
  assert.equal(first.draft.text, "x".repeat(7999));
  assert.equal(first.draft.nextOffset, 7999);
  await assert.rejects(
    f.runtime.callTool(ctx, "project", {
      id: p.id,
      expectedRevision: 1,
      draft: { title: "改稿", text: "新稿" },
    }),
    /ACTIVITY_READ_DRAFT_FIRST/,
  );
  const second = await f.runtime.callTool(ctx, "projects", {
    id: p.id,
    offset: first.draft.nextOffset,
  });
  assert.equal(second.draft.text, "👍🏽结尾");
  assert.equal(first.draft.text + second.draft.text, body);
  await f.runtime.callTool(ctx, "project", {
    id: p.id,
    expectedRevision: 1,
    draft: { title: "改稿", text: "新稿" },
  });
});
