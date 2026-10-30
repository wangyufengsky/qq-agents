import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fixture, context } from "./helpers.mjs";
import { FileStore } from "../src/tools/files.mjs";
import { participateInProject } from "../src/core/project-participation.mjs";
import { activityVersion, activityForTurn } from "../src/tools/activities.mjs";

function setup(t) {
  const f = fixture(t),
    m = f.store.bind("agent-0");
  f.runtime.agent("agent-0").subject.enabled = true;
  f.runtime.files = new FileStore(path.join(f.root, "files"));
  const file = f.runtime.files.put(
    "agent-0",
    Buffer.from("# 原始作品\n\n第一稿"),
    "work.md",
    f.runtime.agent("agent-0").files,
    { kind: "generated-text", conversation: "@subject" },
  );
  const personal = m.identity.saveProject(
    {
      title: "故事",
      why: "持续完善",
      files: [file.fileId],
      progress: "保存作品",
    },
    { writtenIn: "@subject", now: f.runtime.now() },
  );
  const act = (project, args) =>
    participateInProject(f.runtime, "agent-0", {
      id: project.id,
      expectedRevision: project.revision,
      submissionId: randomUUID(),
      ...args,
    });
  const join = () =>
    act(personal, { action: "join", sourceFileId: file.fileId }).project;
  const countEvents = () =>
    m.db.prepare("SELECT count(*) n FROM events").get().n;
  return { ...f, m, file, personal, act, join, countEvents };
}
test("joining a personal work preserves its original files, history and explicit source author", (t) => {
  const f = setup(t),
    count = f.countEvents();
  const p = f.join();
  assert.equal(p.activity.mode, "console");
  assert.deepEqual(p.activity.participants, ["administrator"]);
  assert.deepEqual(p.files, f.personal.files);
  assert.deepEqual(p.steps.slice(1), f.personal.steps);
  const entry = activityVersion(f.m, p.id, p.revision);
  assert.deepEqual(entry.previousProject, f.personal);
  assert.equal(entry.draftAuthor, "source-file");
  assert.equal(entry.draftSourceFileId, f.file.fileId);
  assert.equal(entry.draft.text, "# 原始作品\n\n第一稿");
  assert.equal(entry.contribution.eventId, undefined);
  assert.equal(f.countEvents(), count);
  assert.throws(() => f.act(p, { action: "join" }), /ACTIVITY_ALREADY_JOINED/);
});
test("administrator submissions are idempotent, role scoped and reject concurrent overwrite", (t) => {
  const f = setup(t),
    p = f.join();
  const args = {
    id: p.id,
    expectedRevision: p.revision,
    submissionId: randomUUID(),
    action: "comment",
    text: "\n  保留原来的结尾\n",
  };
  const first = participateInProject(f.runtime, "agent-0", args);
  const retry = participateInProject(f.runtime, "agent-0", args);
  assert.equal(retry.savedRevision, first.savedRevision);
  assert.equal(retry.duplicate, true);
  assert.throws(
    () =>
      participateInProject(f.runtime, "agent-0", {
        ...args,
        text: "更改了请求",
      }),
    /ACTIVITY_SUBMISSION_CONFLICT/,
  );
  assert.throws(
    () =>
      participateInProject(f.runtime, "agent-0", {
        ...args,
        submissionId: randomUUID(),
      }),
    /REVISION_CONFLICT/,
  );
  assert.throws(
    () => participateInProject(f.runtime, "agent-1", args),
    /RECORD_NOT_FOUND/,
  );
  assert.equal(
    activityVersion(f.m, p.id, first.savedRevision).contribution.text,
    args.text,
  );
});
test("an idle role reads real administrator contributions before advancing its console activity", async (t) => {
  const f = setup(t),
    p = f.join(),
    ctx = context(f.runtime, "agent-0", "@subject");
  const update = {
    id: p.id,
    expectedRevision: p.revision,
    progress: "继续写",
    draft: { title: "共同原稿", text: "角色续写" },
    shared: {
      turn: "administrator",
      pending: [
        { id: "ending", question: "结局如何？", options: ["开放", "圆满"] },
      ],
    },
  };
  await assert.rejects(
    f.runtime.callTool(ctx, "project", update),
    /ACTIVITY_READ_ADMINISTRATOR_FIRST/,
  );
  await f.runtime.callTool(ctx, "projects", { id: p.id });
  const next = await f.runtime.callTool(ctx, "project", update);
  assert.equal(activityVersion(f.m, p.id, next.revision).draftAuthor, "agent");
  assert.deepEqual(next.activity.administratorRevisions, []);
  await assert.rejects(
    f.runtime.callTool(ctx, "project", {
      id: p.id,
      expectedRevision: next.revision,
      progress: "擅自替人选择",
    }),
    /ACTIVITY_WAITING_FOR_PARTICIPANT/,
  );
  const decided = f.act(next, {
    action: "decision",
    choiceId: "ending",
    text: "开放",
  }).project;
  assert.deepEqual(decided.activity.pending, []);
  const read = await f.runtime.callTool(ctx, "projects", { id: p.id });
  assert.equal(read.version.contribution.kind, "administrator");
  assert.equal(read.version.decision.answer, "开放");
  assert.equal(read.draft.author, "agent");
  const final = await f.runtime.callTool(ctx, "project", {
    id: p.id,
    expectedRevision: decided.revision,
    progress: "采用开放结尾",
  });
  assert.equal(final.activity.turn, "agent");
  assert.ok(activityForTurn(f.m, "@subject").some((x) => x.id === p.id));
  assert.ok(!activityForTurn(f.m, "group:10000").some((x) => x.id === p.id));
  assert.equal(ctx.requestEvents?.size || 0, 0);
});
test("multiple console contributions must be read individually, and a short preview is not a full read", async (t) => {
  const f = setup(t),
    p = f.join(),
    ctx = context(f.runtime, "agent-0", "@subject");
  const first = f.act(p, {
    action: "comment",
    text: "长建议".repeat(600),
  }).project;
  const second = f.act(first, {
    action: "comment",
    text: "另外保留标题",
  }).project;
  await f.runtime.callTool(ctx, "projects", { id: p.id });
  await f.runtime.callTool(ctx, "projects", { id: p.id, revision: p.revision });
  await f.runtime.callTool(ctx, "projects", {
    id: p.id,
    revision: first.revision,
    maxChars: 512,
  });
  const update = {
    id: p.id,
    expectedRevision: second.revision,
    progress: "已考虑建议",
  };
  await assert.rejects(
    f.runtime.callTool(ctx, "project", update),
    /ACTIVITY_READ_ADMINISTRATOR_FIRST/,
  );
  await f.runtime.callTool(ctx, "projects", {
    id: p.id,
    revision: first.revision,
  });
  await f.runtime.callTool(ctx, "project", update);
});
test("joining cannot import protected, unrelated or overlong source text into a shared draft", (t) => {
  const f = setup(t);
  const unrelated = f.runtime.files.put(
    "agent-0",
    Buffer.from("别的资料"),
    "unrelated.md",
    f.runtime.agent("agent-0").files,
  );
  assert.throws(
    () => f.act(f.personal, { action: "join", sourceFileId: unrelated.fileId }),
    /ACTIVITY_SOURCE_FILE_INVALID/,
  );
  f.runtime.files.put(
    "agent-0",
    Buffer.from("# 原始作品\n\n第一稿"),
    "work.md",
    f.runtime.agent("agent-0").files,
    { protectedOperations: true },
  );
  assert.throws(() => f.join(), /RECALL_SOURCE_NOT_ALLOWED/);
  assert.deepEqual(f.m.identity.project(f.personal.id), f.personal);
  const tooLong = f.runtime.files.put(
    "agent-0",
    Buffer.from("长".repeat(32001)),
    "long.md",
    f.runtime.agent("agent-0").files,
  );
  const other = f.m.identity.saveProject(
    { title: "长稿项目", why: "测试明确拒绝超长稿", files: [tooLong.fileId] },
    { writtenIn: "@subject", now: f.runtime.now() },
  );
  assert.throws(
    () => f.act(other, { action: "join", sourceFileId: tooLong.fileId }),
    /ACTIVITY_DRAFT_TOO_LONG/,
  );
  assert.ok(!f.m.identity.project(other.id).activity);
});

test("administrator participation in a QQ activity never substitutes for the waiting QQ person", async (t) => {
  const f = setup(t),
    ctx = context(f.runtime);
  const event = f.m.append({
    dedupe: "qq-join",
    connectionId: "qq-0",
    conversation: ctx.conversation,
    kind: "message.received",
    senderId: "30000",
    body: "一起写",
    payload: { trustedInput: true },
  });
  f.runtime.observeInput(ctx, [
    f.m.readRecord({ id: event.id }, ctx.conversation),
  ]);
  const qq = await f.runtime.callTool(ctx, "project", {
    title: "QQ 故事",
    why: "共同写",
    participantEventId: event.id,
    shared: {
      participants: ["30000"],
      turn: "30000",
      pending: [{ id: "path", question: "走哪边", options: ["左", "右"] }],
    },
  });
  await assert.rejects(
    f.runtime.callTool(ctx, "project", {
      id: qq.id,
      expectedRevision: qq.revision,
      shared: { participants: ["30000", "administrator"] },
    }),
    /ACTIVITY_PARTICIPANTS_IMMUTABLE/,
  );
  await assert.rejects(
    f.runtime.callTool(ctx, "project", {
      title: "伪造加入",
      why: "不能代管理员加入",
      participantEventId: event.id,
      shared: { participants: ["30000", "administrator"] },
    }),
    /ACTIVITY_HUMAN_INPUT_REQUIRED/,
  );
  const joined = f.act(qq, { action: "join" }).project;
  const commented = f.act(joined, {
    action: "comment",
    text: "可以多描写环境",
  }).project;
  assert.equal(commented.activity.conversation, ctx.conversation);
  assert.equal(commented.activity.turn, "30000");
  assert.throws(
    () =>
      f.act(commented, { action: "decision", choiceId: "path", text: "左" }),
    /ACTIVITY_WAITING_FOR_PARTICIPANT/,
  );
  assert.throws(
    () => f.act(commented, { action: "draft", title: "原稿", text: "替他写" }),
    /ACTIVITY_WAITING_FOR_PARTICIPANT/,
  );
  const fresh = context(f.runtime);
  for (const revision of commented.activity.administratorRevisions)
    await f.runtime.callTool(fresh, "projects", { id: qq.id, revision });
  assert.equal(fresh.requestEvents?.size || 0, 0);
  await assert.rejects(
    f.runtime.callTool(fresh, "project", {
      id: qq.id,
      expectedRevision: commented.revision,
      progress: "代选",
    }),
    /ACTIVITY_WAITING_FOR_PARTICIPANT/,
  );
  const next = f.m.append({
    dedupe: "qq-next",
    connectionId: "qq-0",
    conversation: ctx.conversation,
    kind: "message.received",
    senderId: "30000",
    body: "向左走",
    payload: { trustedInput: true },
  });
  f.runtime.observeInput(fresh, [
    f.m.readRecord({ id: next.id }, ctx.conversation),
  ]);
  const saved = await f.runtime.callTool(fresh, "project", {
    id: qq.id,
    expectedRevision: commented.revision,
    participantEventId: next.id,
    shared: { turn: "agent", pending: [] },
    progress: "按参与者的选择向左",
  });
  assert.equal(saved.activity.lastHumanEventId, next.id);
  assert.equal(saved.activity.participants.includes("administrator"), true);
});

test("co-editing keeps the administrator author and all old drafts across export and restore", async (t) => {
  const { MemoryStore } = await import("../src/memory/store.mjs");
  const { restoreExport } = await import("../src/memory/migrate.mjs");
  const f = setup(t),
    joined = f.join();
  const edited = f.act(joined, {
    action: "draft",
    title: "共写稿",
    text: "管理员修改了结尾。",
  }).project;
  assert.equal(
    activityVersion(f.m, joined.id, joined.revision).draftAuthor,
    "source-file",
  );
  assert.equal(
    activityVersion(f.m, joined.id, edited.revision).draftAuthor,
    "administrator",
  );
  const count = f.countEvents();
  const restored = new MemoryStore(path.join(f.root, "restored.sqlite"));
  t.after(() => restored.close());
  restoreExport(restored.bind("agent-0"), f.m.export());
  const m = restored.bind("agent-0");
  assert.deepEqual(m.identity.project(edited.id), edited);
  assert.equal(
    activityVersion(m, edited.id, edited.revision).draft.text,
    "管理员修改了结尾。",
  );
  assert.equal(
    activityVersion(m, edited.id, joined.revision).draft.text,
    "# 原始作品\n\n第一稿",
  );
  assert.equal(f.countEvents(), count);
});

test("participation HTTP writes require admin authentication and preserve request conflict codes", async (t) => {
  const { createServer } = await import("../src/server.mjs");
  const f = setup(t),
    token = "synthetic-project-admin",
    app = createServer({ runtime: f.runtime, token });
  const port = await app.listen();
  t.after(() => app.close());
  const input = {
    agentId: "agent-0",
    id: f.personal.id,
    expectedRevision: 1,
    submissionId: randomUUID(),
    action: "join",
  };
  const request = (body, auth = true, extra = {}) =>
    fetch(`http://127.0.0.1:${port}/api/project/participate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(auth ? { "x-admin-token": token } : {}),
        ...extra,
      },
      body: JSON.stringify(body),
    });
  assert.equal((await request(input, false)).status, 401);
  assert.ok(
    !(await request(input, true, { origin: "https://invalid.example" })).ok,
  );
  const joined = await (await request(input)).json();
  assert.equal(joined.project.activity.mode, "console");
  const stale = await (
    await request({
      ...input,
      submissionId: randomUUID(),
      action: "comment",
      text: "建议",
    })
  ).json();
  assert.equal(stale.error, "REVISION_CONFLICT");
  assert.equal(f.countEvents(), 0);
});

test("a backlog can be checkpointed across default eight-call idle turns without changing choices", async (t) => {
  const f = setup(t);
  let p = f.join();
  let first = context(f.runtime, "agent-0", "@subject");
  await f.runtime.callTool(first, "projects", { id: p.id });
  p = await f.runtime.callTool(first, "project", {
    id: p.id,
    expectedRevision: p.revision,
    shared: {
      turn: "administrator",
      pending: [
        { id: "finish", question: "何时结束", options: ["今天", "明天"] },
      ],
    },
  });
  for (let i = 0; i < 12; i++)
    p = f.act(p, { action: "comment", text: "建议 " + i }).project;
  const choices = structuredClone(p.activity.pending);
  let turns = 0;
  while (p.activity.administratorRevisions.length) {
    const ctx = context(f.runtime, "agent-0", "@subject");
    const batch = p.activity.administratorRevisions.slice(0, 6);
    for (const revision of batch)
      await f.runtime.callTool(ctx, "projects", {
        id: p.id,
        revision,
        maxChars: 16000,
      });
    if (turns === 0)
      await assert.rejects(
        f.runtime.callTool(ctx, "project", {
          id: p.id,
          expectedRevision: p.revision,
          administratorRead: {
            revisions: batch,
            summary: "阅读确认不能替人选择",
          },
          shared: { pending: [] },
        }),
        /ACTIVITY_ACKNOWLEDGEMENT_ONLY/,
      );
    p = await f.runtime.callTool(ctx, "project", {
      id: p.id,
      expectedRevision: p.revision,
      administratorRead: {
        revisions: batch,
        summary: "已读这一批建议，仍保留结束日期的问题。",
      },
    });
    assert.equal(p.activity.turn, "administrator");
    assert.deepEqual(p.activity.pending, choices);
    assert.ok(ctx.subjectToolReservations <= 8);
    turns++;
  }
  assert.equal(turns, 2);
  assert.equal(p.activity.administratorAcknowledged.length, 12);
  const fresh = context(f.runtime, "agent-0", "@subject");
  await assert.rejects(
    f.runtime.callTool(fresh, "project", {
      id: p.id,
      expectedRevision: p.revision,
      progress: "尚未读接续摘要",
    }),
    /ACTIVITY_READ_ADMINISTRATOR_FIRST/,
  );
  const current = await f.runtime.callTool(fresh, "projects", { id: p.id });
  assert.ok(current.version.progress.includes("已读这一批建议"));
  p = await f.runtime.callTool(fresh, "project", {
    id: p.id,
    expectedRevision: p.revision,
    progress: "结合建议完善当前稿，结束日期仍待决定",
    draft: { title: "新稿", text: "已读贡献后继续" },
    shared: { turn: "administrator" },
  });
  assert.deepEqual(p.activity.administratorAcknowledged, []);
  assert.deepEqual(p.activity.pending, choices);
  assert.equal(fresh.requestEvents?.size || 0, 0);
});

test("reading a later short draft cannot acknowledge an earlier unread long administrator draft", async (t) => {
  const f = setup(t);
  const joined = f.join();
  const long = f.act(joined, {
    action: "draft",
    title: "长稿",
    text: "长".repeat(20000),
  }).project;
  const short = f.act(long, {
    action: "draft",
    title: "短稿",
    text: "另一个版本",
  }).project;
  const ctx = context(f.runtime, "agent-0", "@subject");
  await f.runtime.callTool(ctx, "projects", {
    id: joined.id,
    revision: joined.revision,
  });
  await f.runtime.callTool(ctx, "projects", {
    id: joined.id,
    revision: long.revision,
    maxChars: 512,
  });
  await f.runtime.callTool(ctx, "projects", {
    id: joined.id,
    revision: short.revision,
  });
  await assert.rejects(
    f.runtime.callTool(ctx, "project", {
      id: joined.id,
      expectedRevision: short.revision,
      progress: "假称全读过",
    }),
    /ACTIVITY_READ_ADMINISTRATOR_FIRST/,
  );
  await assert.rejects(
    f.runtime.callTool(ctx, "project", {
      id: joined.id,
      expectedRevision: short.revision,
      administratorRead: {
        revisions: [long.revision],
        summary: "不能确认未读全文",
      },
    }),
    /ACTIVITY_READ_ADMINISTRATOR_FIRST/,
  );
  const page = await f.runtime.callTool(ctx, "projects", {
    id: joined.id,
    revision: long.revision,
    maxChars: 16000,
  });
  await f.runtime.callTool(ctx, "projects", {
    id: joined.id,
    revision: long.revision,
    offset: page.draft.nextOffset,
    maxChars: 16000,
  });
  await f.runtime.callTool(ctx, "project", {
    id: joined.id,
    expectedRevision: short.revision,
    progress: "完整阅读所有稿件后继续",
  });
});

test("all acknowledged summaries survive step rolloff until a fresh turn consumes them", async (t) => {
  const f = setup(t);
  let p = f.join();
  const initial = context(f.runtime, "agent-0", "@subject");
  await f.runtime.callTool(initial, "projects", { id: p.id });
  p = await f.runtime.callTool(initial, "project", {
    id: p.id,
    expectedRevision: p.revision,
    progress: "开始共同创作",
  });
  const expected = [];
  for (let i = 0; i < 20; i++) {
    p = f.act(p, { action: "comment", text: "真实建议 " + i }).project;
    const revision = p.revision,
      summary = "仍待处理的独立建议 " + i;
    expected.push({ revision, summary });
    const ctx = context(f.runtime, "agent-0", "@subject");
    await f.runtime.callTool(ctx, "projects", { id: p.id, revision });
    p = await f.runtime.callTool(ctx, "project", {
      id: p.id,
      expectedRevision: p.revision,
      administratorRead: { revisions: [revision], summary },
    });
  }
  assert.equal(p.steps.length, 30);
  assert.ok(
    !p.steps.some(
      (step) => step.did === "已阅读管理员贡献：" + expected[0].summary,
    ),
  );
  const hints = activityForTurn(f.m, "@subject");
  assert.equal(hints[0].administratorAcknowledgedCount, 20);
  assert.ok(!JSON.stringify(hints).includes("仍待处理的独立建议"));
  const ctx = context(f.runtime, "agent-0", "@subject");
  const current = await f.runtime.callTool(ctx, "projects", { id: p.id });
  assert.deepEqual(
    current.project.activity.administratorAcknowledged,
    expected,
  );
  p = await f.runtime.callTool(ctx, "project", {
    id: p.id,
    expectedRevision: p.revision,
    progress: "结合所有建议继续",
  });
  assert.deepEqual(p.activity.administratorAcknowledged, []);
  assert.deepEqual(
    activityVersion(f.m, p.id, p.revision).administratorContributions,
    expected.map((entry) => entry.revision),
  );
});

test("a model cannot convert a personal project into a console activity", async (t) => {
  const f = setup(t),
    ctx = context(f.runtime, "agent-0", "@subject");
  await assert.rejects(
    f.runtime.callTool(ctx, "project", {
      id: f.personal.id,
      expectedRevision: f.personal.revision,
      shared: { participants: ["administrator"] },
    }),
    /ACTIVITY_SCOPE_REQUIRED/,
  );
  assert.deepEqual(f.m.identity.project(f.personal.id), f.personal);
  assert.equal(f.countEvents(), 0);
});
