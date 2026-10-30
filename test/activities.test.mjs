import test from "node:test";
import assert from "node:assert/strict";
import { fixture, context } from "./helpers.mjs";
import { MemoryStore } from "../src/memory/store.mjs";
import { restoreExport } from "../src/memory/migrate.mjs";
import { activityForTurn } from "../src/tools/activities.mjs";
import { createServer } from "../src/server.mjs";
let seq = 0;
function setup(t) {
  const f = fixture(t),
    m = f.store.bind("agent-0"),
    ctx = context(f.runtime);
  const say = (body = "一起写故事吧", personId = "30000") => {
    const e = m.append({
      dedupe: "activity:" + ++seq,
      connectionId: "qq-0",
      conversation: ctx.conversation,
      kind: "message.received",
      senderId: personId,
      body,
      payload: { trustedInput: true },
    });
    f.runtime.observeInput(ctx, [m.readRecord({ id: e.id }, ctx.conversation)]);
    return e;
  };
  const source = say();
  const call = (name, args) => f.runtime.callTool(ctx, name, args);
  const start = {
    title: "车站故事",
    why: "一起写一个推理故事",
    participantEventId: source.id,
    shared: {
      participants: ["30000"],
      turn: "30000",
      pending: [
        { id: "route", question: "先去哪里", options: ["站长室", "监控室"] },
      ],
    },
    draft: { title: "第一稿", text: "调查员走进了车站。" },
    progress: "写了开头，等你选路线",
  };
  return { ...f, m, ctx, say, call, start };
}
test("a joint activity resumes with its exact draft, unresolved choices and whose turn it is", async (t) => {
  const f = setup(t),
    p = await f.call("project", f.start);
  const fresh = context(f.runtime);
  const result = await f.runtime.callTool(fresh, "projects", { id: p.id });
  assert.equal(result.draft.text, f.start.draft.text);
  assert.equal(result.project.activity.turn, "30000");
  assert.deepEqual(result.project.activity.pending, f.start.shared.pending);
  assert.equal(result.version.contribution.text, "一起写故事吧");
  assert.equal(activityForTurn(f.m, f.ctx.conversation)[0].id, p.id);
  await assert.rejects(
    f.call("project", {
      id: p.id,
      expectedRevision: 1,
      progress: "替你选监控室",
      shared: { turn: "agent", pending: [] },
    }),
    /ACTIVITY_WAITING_FOR_PARTICIPANT/,
  );
  const e = f.say("先去监控室，我来写开门的部分");
  await f.call("projects", { id: p.id });
  const next = await f.call("project", {
    id: p.id,
    expectedRevision: 1,
    participantEventId: e.id,
    shared: { turn: "agent", pending: [] },
    progress: "收到路线选择",
    draft: { title: "第二稿", text: "调查员走进车站，来到监控室。" },
  });
  assert.equal(next.revision, 2);
  assert.equal(
    (await f.call("projects", { id: p.id, revision: 1 })).draft.text,
    f.start.draft.text,
  );
  await assert.rejects(
    f.call("project", {
      id: p.id,
      expectedRevision: 2,
      participantEventId: e.id,
      progress: "重复贡献",
    }),
    /ACTIVITY_INPUT_ALREADY_USED/,
  );
});
test("draft updates require complete read of the current draft and reject stale revisions", async (t) => {
  const f = setup(t),
    p = await f.call("project", {
      ...f.start,
      shared: { participants: ["30000"], turn: "agent" },
      draft: { title: "长原稿", text: "原稿".repeat(1000) },
    });
  const update = {
    id: p.id,
    expectedRevision: 1,
    draft: { title: "第二稿", text: "改稿" },
    progress: "修改",
  };
  await assert.rejects(f.call("project", update), /ACTIVITY_READ_DRAFT_FIRST/);
  await f.call("projects", { id: p.id, maxChars: 512 });
  await assert.rejects(f.call("project", update), /ACTIVITY_READ_DRAFT_FIRST/);
  await f.call("projects", { id: p.id, offset: 512, maxChars: 16000 });
  await f.call("project", update);
  await f.call("projects", { id: p.id });
  await assert.rejects(f.call("project", update), /REVISION_CONFLICT/);
});
test("turn hints stay bounded and long human contributions retain a full-text reader", async (t) => {
  const f = setup(t),
    source = f.say("原文".repeat(5000)),
    p = await f.call("project", {
      ...f.start,
      participantEventId: source.id,
      shared: {
        ...f.start.shared,
        pending: Array.from({ length: 10 }, (_, i) => ({
          id: String(i),
          question: "问题".repeat(150),
          options: Array(8).fill("选项".repeat(100)),
        })),
      },
    });
  const hint = activityForTurn(f.m, f.ctx.conversation);
  assert.equal(hint[0].pendingCount, 10);
  assert.ok(JSON.stringify(hint).length < 2000);
  const read = await f.call("projects", { id: p.id });
  assert.equal(read.version.contribution.truncated, true);
  assert.equal(read.version.contribution.read.id, source.id);
  assert.equal(f.m.readRecord({ id: source.id }).body.length, 10000);
});
test("activity history and original drafts survive beyond the rolling project summary, reopening and export", async (t) => {
  const f = setup(t);
  let p = await f.call("project", {
    ...f.start,
    shared: { participants: ["30000"], turn: "agent" },
  });
  for (let i = 0; i < 35; i++)
    p = await f.call("project", {
      id: p.id,
      expectedRevision: p.revision,
      progress: "真实步骤 " + i,
    });
  assert.equal(p.steps.length, 30);
  const all = await f.call("projects", { id: p.id });
  assert.equal(all.historyTotal, 36);
  assert.equal(all.draft.text, f.start.draft.text);
  assert.equal(
    (await f.call("projects", { id: p.id, revision: 1 })).version.contribution
      .text,
    "一起写故事吧",
  );
  const reopened = new MemoryStore(f.store.file);
  t.after(() => reopened.close());
  assert.equal(
    activityForTurn(reopened.bind("agent-0"), f.ctx.conversation)[0].revision,
    36,
  );
  const restored = new MemoryStore(":memory:");
  t.after(() => restored.close());
  restoreExport(restored.bind("agent-0"), f.m.export());
  assert.equal(
    restored.db.prepare("SELECT count(*) n FROM activity_history").get().n,
    36,
  );
  assert.equal(
    restored.bind("agent-0").identity.project(p.id).activity.draftRevision,
    1,
  );
});
test("activities require real participants and stay scoped to their original chat and role", async (t) => {
  const f = setup(t);
  await assert.rejects(
    f.call("project", {
      ...f.start,
      shared: { participants: ["30000", "30001"] },
    }),
    /ACTIVITY_HUMAN_INPUT_REQUIRED/,
  );
  const p = await f.call("project", f.start);
  for (const ctx of [
    context(f.runtime, "agent-0", "private:30000"),
    context(f.runtime, "agent-1"),
  ]) {
    const list = await f.runtime.callTool(ctx, "projects", {});
    assert.equal(list.items.length, 0);
    await assert.rejects(
      f.runtime.callTool(ctx, "projects", { id: p.id }),
      /RECORD_NOT_FOUND/,
    );
  }
  f.runtime.agent("agent-0").subject.enabled = true;
  await assert.rejects(
    f.runtime.callTool(context(f.runtime, "agent-0", "@subject"), "project", {
      id: p.id,
      expectedRevision: 1,
      progress: "替对方续写",
    }),
    /ACTIVITY_SCOPE_REQUIRED/,
  );
  f.ctx.privateRead.add("operations:test");
  await assert.rejects(
    f.call("project", f.start),
    /RESTRICTED_CONTEXT_MIND_WRITE_BLOCKED/,
  );
});
test("an agent turn cannot resolve a pending human choice without new input", async (t) => {
  const f = setup(t),
    p = await f.call("project", {
      ...f.start,
      shared: { ...f.start.shared, turn: "agent" },
    });
  await assert.rejects(
    f.call("project", {
      id: p.id,
      expectedRevision: 1,
      shared: { pending: [] },
      progress: "自己选",
    }),
    /ACTIVITY_DECISION_NEEDS_HUMAN/,
  );
});
test("console reads activity versions through an authenticated endpoint", async (t) => {
  const f = setup(t),
    p = await f.call("project", f.start),
    token = "test-activity-admin";
  const server = createServer({ runtime: f.runtime, token });
  const port = await server.listen();
  t.after(() => server.close());
  const url = `http://127.0.0.1:${port}/api/project?agentId=agent-0&id=${p.id}&revision=1`;
  assert.equal((await fetch(url)).status, 401);
  const response = await fetch(url, { headers: { "x-admin-token": token } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).draft.text, f.start.draft.text);
});
