import test from "node:test";
import assert from "node:assert/strict";
import { assertSocialToolResult } from "../src/backends/native-social.mjs";
import { config, context, fixture } from "./helpers.mjs";

const desktop = "@desktop";
const owner = "private:30000";

function setup(t) {
  const cfg = config(2);
  cfg.desktopHome.enabled = true;
  cfg.desktopHome.toolRoles = ["agent-0"];
  for (const agent of cfg.agents) {
    agent.subject.enabled = true;
    agent.subject.inboxEnabled = true;
    agent.subject.users = ["30000"];
  }
  cfg.agents[0].tools.push(
    "file_create",
    "file_list",
    "file_download",
    "self_propose",
    "projects",
  );
  Object.assign(cfg.agents[0].files, {
    enabled: true,
    create: true,
    download: false,
    receive: false,
  });
  return fixture(t, { cfg });
}

function activeDesktopContext(runtime) {
  return runtime.makeContext("agent-0", desktop, {
    controller: new AbortController(),
    assertCurrent() {},
  });
}

test("desktop capabilities are limited by the role's opt-in and existing permissions", (t) => {
  const { runtime } = setup(t);
  const first = runtime.agent("agent-0");
  const second = runtime.agent("agent-1");
  assert.deepEqual(runtime.toolsFor(first, desktop), [
    "desktop_room_decide",
    "desktop_room_history",
    "memory_search",
    "memory_read",
    "diary_write",
    "diary_revise",
    "file_create",
    "file_list",
    "self_propose",
    "projects",
    "file_read",
    "file_revise",
    "subject_inbox_submit",
    "subject_inbox_list",
  ]);
  assert.deepEqual(runtime.toolsFor(second, desktop), [
    "desktop_room_decide",
    "desktop_room_history",
    "memory_search",
    "memory_read",
  ]);
  first.files.receive = true;
  assert(runtime.toolsFor(first, desktop).includes("file_download"));
  assert(runtime.toolsFor(first, owner).includes("qq_send"));
  runtime.config.desktopHome.toolRoles = [];
  assert.deepEqual(runtime.toolsFor(first, desktop), [
    "desktop_room_decide",
    "desktop_room_history",
    "memory_search",
    "memory_read",
  ]);
});

test("desktop proposals stay in the same role's inbox and use the QQ ledger for receipts", (t) => {
  const { runtime, store } = setup(t);
  const inbox = runtime.subjectInbox;
  const memory = store.bind("agent-0");
  const desktopCtx = activeDesktopContext(runtime);
  const subject = context(runtime, "agent-0", "@subject");
  const sibling = context(runtime, "agent-1", "@subject");

  const args = {
    requestId: "contact-fixture",
    proposal: { kind: "contact", target: owner, note: "桌边私下备注" },
  };
  assert.throws(
    () =>
      inbox.submit(desktopCtx, {
        ...args,
        proposal: { ...args.proposal, target: "group:20001" },
      }),
    /PROACTIVE_TARGET_NOT_ENABLED/,
  );
  assert.throws(
    () => inbox.submit(desktopCtx, { ...args, proposal: { kind: "rest" } }),
    /TOOL_DISABLED/,
  );
  desktopCtx.privateRead.add("operations:fixture");
  assert.throws(
    () => inbox.submit(desktopCtx, args),
    /SUBJECT_INBOX_SOURCE_DENIED/,
  );
  desktopCtx.privateRead.delete("operations:fixture");
  const pending = inbox.submit(desktopCtx, args);
  assert.equal(pending.status, "pending");
  assert.deepEqual(inbox.submit(desktopCtx, args), {
    ...pending,
    duplicate: true,
  });
  assert.deepEqual(inbox.list(sibling, { offset: 0 }).items, []);
  assert.equal(inbox.list(subject, { offset: 0 }).items[0].id, pending.id);
  assert.throws(
    () => runtime.subject.beforeDelivery(desktopCtx),
    /SUBJECT_CANNOT_SEND_QQ/,
  );

  const accepted = inbox.decide(subject, {
    id: pending.id,
    expectedRevision: 1,
    action: "contact",
    expiresAt: runtime.now() + 60_000,
  });
  const feedback = () => inbox.list(desktopCtx, { offset: 0 }).items[0];
  assert.equal(feedback().status, "accepted");
  assert.equal(feedback().deliveryStatus, "not-attempted");
  const intent = memory.identity.get("intentions", accepted.contactIntentId);
  assert.equal(intent.target, owner);
  assert.doesNotMatch(JSON.stringify(intent), /桌边私下备注/);
  const key = "intent:" + intent.id;
  memory.reserveDelivery(key, owner, { text: "合成投递" });
  assert.equal(feedback().deliveryStatus, "pending");
  memory.completeDelivery(key, "unknown");
  assert.equal(feedback().deliveryStatus, "unknown");
  memory.completeDelivery(key, "sent", "fixture-receipt");
  assert.equal(feedback().deliveryStatus, "sent");

  const record = memory.append({
    conversation: desktop,
    dedupe: "desktop-note-source",
    kind: "message.received",
    direction: "in",
    status: "observed",
    body: "先检查附件",
  });
  const note = memory.identity.saveNote(
    {
      body: "继续整理附件",
      evidence: [record.id],
      uncertainty: "附件尚未整理",
    },
    desktop,
    runtime.now(),
  );
  const handoff = inbox.submit(desktopCtx, {
    requestId: "handoff-fixture",
    proposal: {
      kind: "handoff",
      reference: { type: "work-note", id: note.id },
    },
  });
  const take = { id: handoff.id, expectedRevision: 1, action: "take" };
  assert.throws(() => inbox.decide(sibling, take), /RECORD_NOT_FOUND/);
  assert.equal(inbox.decide(subject, take).reference.id, note.id);
  runtime.config.desktopHome.toolRoles = [];
  assert.throws(() => inbox.list(desktopCtx, { offset: 0 }), /TOOL_DISABLED/);
});

test("native desktop attachment readers preserve bounded image output", () => {
  const image = {
    type: "image",
    mimeType: "image/jpeg",
    data: Buffer.from("fixture").toString("base64"),
  };
  const result = { content: [image] };
  assert.doesNotThrow(() =>
    assertSocialToolResult("qq_image_read", result, 65536, true),
  );
  assert.throws(
    () => assertSocialToolResult("qq_image_read", result, 65536),
    /SOCIAL_TOOL_RESULT_LIMIT/,
  );
  assert.throws(
    () => assertSocialToolResult("memory_read", result, 65536, true),
    /SOCIAL_TOOL_RESULT_LIMIT/,
  );
  assert.throws(
    () =>
      assertSocialToolResult(
        "sticker_read",
        { content: Array(13).fill(image) },
        65536,
        true,
      ),
    /SOCIAL_TOOL_RESULT_LIMIT/,
  );
});

test("desktop diary, Self candidates and projects retain the existing ownership and review boundaries", async (t) => {
  const { runtime, store } = setup(t);
  const ctx = activeDesktopContext(runtime);
  const memory = store.bind(ctx.agentId);
  const identity = memory.identity;
  const now = runtime.now();
  const self = identity.initialize(runtime.agent(ctx.agentId), now);
  const call = (name, args) => runtime.executeTool(ctx, name, args);
  const draft = { title: "桌边日记", body: "今天一起聊了旧事" };
  const diary = await call("diary_write", draft);
  assert.deepEqual(
    await call("diary_revise", { ...draft, id: diary.id, expectedRevision: 1 }),
    { id: diary.id, revision: 2 },
  );
  const protectedDiary = memory.diaryWrite(
    { title: "受保护日记", body: "受保护测试资料" },
    "ai-diary",
    { conversation: "@work:fixture" },
    true,
  );
  await assert.rejects(
    call("diary_revise", {
      ...draft,
      id: protectedDiary.id,
      expectedRevision: 1,
    }),
    /RECALL_SOURCE_NOT_ALLOWED/,
  );
  const candidate = await call("self_propose", {
    body: "我喜欢在桌边听大家聊天。",
    reason: "桌面试聊",
    evidence: [],
    scope: "interest",
    expectedVersion: self.version,
  });
  assert.equal(candidate.status, "pending");
  assert.equal(identity.current().version, self.version);
  await assert.rejects(call("self_review", {}), /TOOL_DISABLED/);

  const project = identity.saveProject(
    { title: "自己的项目", why: "桌面继续整理" },
    { writtenIn: desktop, now },
  );
  const restricted = identity.saveProject(
    { title: "受保护项目", why: "受保护来源" },
    { writtenIn: "@work:fixture", now },
  );
  assert.deepEqual(
    (await call("projects", {})).items.map(({ id }) => id),
    [project.id],
  );
  await assert.rejects(
    call("projects", { id: restricted.id }),
    /RECORD_NOT_FOUND/,
  );
  await assert.rejects(call("project", {}), /TOOL_DISABLED/);
  assert.throws(
    () =>
      runtime.subjectInbox.submit(ctx, {
        requestId: "protected-project",
        proposal: {
          kind: "handoff",
          reference: { type: "project", id: restricted.id },
        },
      }),
    /SUBJECT_INBOX_SOURCE_DENIED/,
  );
});
