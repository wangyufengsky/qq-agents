import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { participateInProject } from "../src/core/project-participation.mjs";
import { createServer } from "../src/server.mjs";
import { desktopToken } from "../src/home/desktop-auth.mjs";
import { config, fixture } from "./helpers.mjs";

function setup(t) {
  const cfg = config(2);
  cfg.desktopHome.enabled = true;
  cfg.agents[0].subject.enabled = true;
  cfg.agents[0].tools = [
    ...new Set([
      ...cfg.agents[0].tools,
      "diary_write",
      "diary_revise",
      "project",
    ]),
  ];
  const { runtime, store } = fixture(t, { cfg });
  const host = runtime.desktopVisits,
    client = randomUUID();
  host.command({ client, action: "sync" });
  const role = host.live.room.roles[0];
  host.live.room.members[role.id] = "invited";
  host.live.admit(role);
  t.after(() => host.reset());
  const visit = host.live.visits.get(role.id);
  const ctx = runtime.makeContext(role.id, "@subject");
  const input = (ref) => ({
    client,
    roomEpoch: host.live.room.epoch,
    agentId: role.id,
    visitId: host.body.visitId(visit),
    ref,
  });
  return { runtime, store, host, ctx, visit, input, role };
}

test("status cards resolve only current authorized visit and resource revision", (t) => {
  const { runtime, store, host, ctx, visit, input, role } = setup(t);
  const memory = store.bind(role.id);
  const capture = host.captureStatusCard(ctx, "diary_write");
  const diary = memory.diaryWrite(
    { title: "日记标题", body: "日记正文" },
    "ai-diary",
    { conversation: "@subject" },
  );
  capture(diary);
  const card = host.statusCards.snapshot(role.id, visit);
  assert.equal(card.title, "日记标题");
  assert.deepEqual(host.statusCards.open(input(card.ref)), {
    status: "ok",
    kind: "diary",
    title: "日记标题",
    text: "日记正文",
  });
  for (const changed of [
    { ref: randomUUID() },
    { client: randomUUID() },
    { visitId: randomUUID() },
    { roomEpoch: randomUUID() },
    { agentId: "agent-1" },
  ])
    assert.throws(
      () => host.statusCards.open({ ...input(card.ref), ...changed }),
      /DESKTOP_VISIT_UNAVAILABLE/,
    );
  memory.db
    .prepare("UPDATE diaries SET revision=revision+1 WHERE id=?")
    .run(diary.id);
  assert.throws(
    () => host.statusCards.open(input(card.ref)),
    /DESKTOP_VISIT_UNAVAILABLE/,
  );
  assert.equal(host.statusCards.snapshot(role.id, visit), undefined);
  assert.equal(
    host.captureStatusCard(
      { ...ctx, conversation: "private:123" },
      "diary_write",
    ),
    undefined,
  );
  assert.equal(host.captureStatusCard(ctx, "projects"), undefined);
  assert.ok(runtime);
});

test("status cards exclude protected data and expire or disappear on leaving", (t) => {
  const { runtime, store, host, ctx, visit, input, role } = setup(t);
  const memory = store.bind(role.id);
  const protectedDiary = memory.diaryWrite(
    { title: "不可展示", body: "隐私" },
    "ai-diary",
    { conversation: "@subject" },
    true,
  );
  host.captureStatusCard(ctx, "diary_write")(protectedDiary);
  assert.equal(host.statusCards.snapshot(role.id, visit), undefined);
  const diary = memory.diaryWrite({ title: "可见", body: "内容" }, "ai-diary", {
    conversation: "@subject",
  });
  host.captureStatusCard(ctx, "diary_write")(diary);
  const card = host.statusCards.snapshot(role.id, visit);
  host.statusCards.cards.get(role.id).expiresAt = runtime.now();
  assert.throws(
    () => host.statusCards.open(input(card.ref)),
    /DESKTOP_VISIT_UNAVAILABLE/,
  );
  host.live.visits.delete(role.id);
  assert.equal(host.statusCards.snapshot(role.id, visit), undefined);
});

test("project cards track the saved project and reject foreign or changed sources", (t) => {
  const { store, host, ctx, visit, input, role } = setup(t);
  const memory = store.bind(role.id);
  const capture = host.captureStatusCard(ctx, "project");
  const project = memory.identity.saveProject(
    { title: "个人项目", why: "缘由", progress: "进度", files: [] },
    { writtenIn: "@subject", now: Date.now() },
  );
  capture(project);
  const card = host.statusCards.snapshot(role.id, visit);
  assert.equal(card.kind, "project");
  assert.match(host.statusCards.open(input(card.ref)).text, /进度/);
  memory.identity.saveProject(
    {
      id: project.id,
      expectedRevision: project.revision,
      progress: "更新",
      files: [],
    },
    { writtenIn: "@subject", now: Date.now() },
  );
  assert.throws(
    () => host.statusCards.open(input(card.ref)),
    /DESKTOP_VISIT_UNAVAILABLE/,
  );
});

test("console shared draft uses the current saved version and rechecks its source", async (t) => {
  const { runtime, host, ctx, visit, input, role } = setup(t);
  const project = await runtime.executeTool(ctx, "project", {
    title: "共同项目",
    why: "合写",
  });
  const joined = participateInProject(runtime, role.id, {
    id: project.id,
    expectedRevision: project.revision,
    submissionId: randomUUID(),
    action: "join",
  }).project;
  await runtime.executeTool(ctx, "projects", { id: project.id });
  const capture = host.captureStatusCard(ctx, "project");
  const written = await runtime.executeTool(ctx, "project", {
    id: project.id,
    expectedRevision: joined.revision,
    draft: { title: "共同原稿", text: "共同正文" },
  });
  capture(written);
  const card = host.statusCards.snapshot(role.id, visit);
  assert.equal(card.kind, "shared-draft");
  assert.equal(host.statusCards.open(input(card.ref)).text, "共同正文");
  runtime.memory.db
    .prepare(
      "DELETE FROM activity_history WHERE agent_id=? AND project_id=? AND revision=?",
    )
    .run(role.id, project.id, written.revision);
  assert.throws(
    () => host.statusCards.open(input(card.ref)),
    /DESKTOP_VISIT_UNAVAILABLE/,
  );
});

test("status card endpoint requires the desktop token", async (t) => {
  const { runtime, store, host, ctx, visit, input, role } = setup(t);
  const diary = store
    .bind(role.id)
    .diaryWrite({ title: "标题", body: "正文" }, "ai-diary", {
      conversation: "@subject",
    });
  host.captureStatusCard(ctx, "diary_write")(diary);
  const card = host.statusCards.snapshot(role.id, visit);
  const token = randomUUID();
  const server = createServer({ runtime, token, allowLive: true });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${await server.listen()}`;
  const post = (key) =>
    fetch(base + "/api/desktop-home/status-card", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-desktop-home-token": key,
      },
      body: JSON.stringify(input(card.ref)),
    });
  assert.equal((await post(token)).status, 401);
  const response = await post(desktopToken(token));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).title, "标题");
});

test("private, group and unknown source references cannot produce cards", (t) => {
  const { runtime, store, host, ctx, visit, role } = setup(t);
  const memory = store.bind(role.id);
  const diary = memory.diaryWrite({ title: "标题", body: "内容" }, "ai-diary", {
    conversation: "@subject",
  });
  for (const source of [
    "context:private:123",
    "context:group:123",
    "missing-legacy-source",
  ]) {
    ctx.privateRead.add(source);
    host.captureStatusCard(ctx, "diary_write")(diary);
    assert.equal(host.statusCards.snapshot(role.id, visit), undefined);
    ctx.privateRead.delete(source);
  }
  host.captureStatusCard(ctx, "diary_write")(diary);
  const card = host.statusCards.snapshot(role.id, visit);
  const row = memory.db
    .prepare("SELECT metadata FROM diaries WHERE id=?")
    .get(diary.id);
  const metadata = JSON.parse(row.metadata);
  metadata.evidence = ["missing-legacy-source"];
  memory.db
    .prepare("UPDATE diaries SET metadata=? WHERE id=?")
    .run(JSON.stringify(metadata), diary.id);
  assert.equal(host.statusCards.snapshot(role.id, visit), undefined);
  assert.ok(card);
  assert.ok(runtime);
});

test("a safe diary title inherited from the idle prompt is rechecked before opening a newer card", (t) => {
  const { store, host, ctx, visit, input, role } = setup(t);
  const memory = store.bind(role.id);
  const prior = memory.diaryWrite(
    { title: "此前的空闲日记", body: "此前的内容" },
    "ai-diary",
    { conversation: "@subject" },
  );
  ctx.privateRead.add(prior.id);
  const diary = memory.diaryWrite(
    { title: "这次的空闲日记", body: "这次的内容" },
    "ai-diary",
    { conversation: "@subject" },
  );
  host.captureStatusCard(ctx, "diary_write")(diary);
  const card = host.statusCards.snapshot(role.id, visit);
  assert.equal(host.statusCards.open(input(card.ref)).title, "这次的空闲日记");

  memory.db
    .prepare(
      "UPDATE diaries SET metadata=json_set(metadata, '$.evidence', json_array(?)) WHERE id=?",
    )
    .run("context:private:30000", prior.id);
  assert.throws(
    () => host.statusCards.open(input(card.ref)),
    /DESKTOP_VISIT_UNAVAILABLE/,
  );
  assert.equal(host.statusCards.snapshot(role.id, visit), undefined);
});
