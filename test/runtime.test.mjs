import test from "node:test";
import assert from "node:assert/strict";
import { validateConfig, inSilence } from "../src/core/config.mjs";
import { config, fixture, raw, context, settle } from "./helpers.mjs";
test("configuration supports 5 independent agents and rejects ambiguous account identity", () => {
  assert.equal(config(5).agents.length, 5);
  const c = config();
  c.agents[1].connectionId = c.agents[0].connectionId;
  assert.throws(() => validateConfig(c), /ALREADY_BOUND/);
});
test("duplicate IDs and missing references fail closed", () => {
  const c = config();
  c.backends[0].id = "missing";
  assert.throws(() => validateConfig(c), /INVALID_REFERENCE/);
  const d = config();
  d.connections[1].id = d.connections[0].id;
  assert.throws(() => validateConfig(d), /DUPLICATE_ID/);
});
test("credentials must be env references; non-loopback endpoints rejected", () => {
  const c = config();
  c.connections[0].accessToken = "secret";
  assert.throws(() => validateConfig(c));
  delete c.connections[0].accessToken;
  c.connections[0].httpUrl = "https://example.org";
  assert.throws(() => validateConfig(c));
});
test("silence schedule handles midnight and previous weekday in selected timezone", () => {
  const a = config().agents[0];
  a.silence = [{ start: "23:00", end: "02:00", days: [1], timezone: "UTC" }];
  assert.equal(inSilence(a, new Date("2026-10-26T23:30:00Z")), true);
  assert.equal(inSilence(a, new Date("2026-10-27T01:00:00Z")), true);
  assert.equal(inSilence(a, new Date("2026-10-27T23:30:00Z")), false);
});
test("paused agents continuously archive all messages without running backend", async (t) => {
  let calls = 0;
  const cfg = config();
  cfg.globalPaused = true;
  const { runtime, store } = fixture(t, { cfg, run: async () => calls++ });
  for (let i = 0; i < 100; i++) await runtime.ingest("qq-0", raw(i));
  assert.equal(store.bind("agent-0").export().tables.events.length, 100);
  assert.equal(calls, 0);
});
test("duplicate ingress cannot wake or archive twice", async (t) => {
  let calls = 0;
  const { runtime, store } = fixture(t, { run: async () => calls++ });
  await runtime.ingest("qq-0", raw());
  await settle(runtime);
  await runtime.ingest("qq-0", raw());
  await settle(runtime);
  assert.equal(calls, 1);
  assert.equal(store.bind("agent-0").export().tables.events.length, 1);
});
test("wrong QQ self identity and non-whitelisted sources never enter memory", async (t) => {
  const { runtime, store } = fixture(t);
  await assert.rejects(
    runtime.ingest("qq-0", raw(1, { self_id: 999 })),
    /MISMATCH/,
  );
  await runtime.ingest("qq-0", raw(2, { group_id: 999 }));
  assert.equal(store.bind("agent-0").search().items.length, 0);
});
test("isolated mode prevents connecting, waking and all outbound tools", async (t) => {
  const cfg = config();
  cfg.mode = "isolated";
  const { runtime } = fixture(t, { cfg });
  await assert.rejects(runtime.startConnection("qq-0"), /ISOLATED/);
  await assert.rejects(runtime.wake("agent-0", "group:20000"), /PAUSED/);
  await assert.rejects(
    runtime.send(context(runtime), { requestId: "a", text: "x" }),
    /PAUSED/,
  );
});
test("send success is archived only after confirmed receipt; retry returns previous receipt", async (t) => {
  const { runtime, store } = fixture(t);
  const ctx = context(runtime);
  const r = await runtime.send(ctx, { requestId: "send-1", text: "hello" });
  assert.equal(r.status, "sent");
  const again = await runtime.send(ctx, { requestId: "send-1", text: "hello" });
  assert.equal(again.duplicate, true);
  assert.equal(runtime.transports.get("qq-0").sent.length, 1);
  const rows = store.bind("agent-0").search().items;
  assert.equal(rows.filter((x) => x.status === "confirmed").length, 1);
  assert.equal(rows.filter((x) => x.status === "pending").length, 1);
});
test("timeout preserves unknown outcome and blocks silent replay", async (t) => {
  const { runtime, store } = fixture(t);
  runtime.transports.get("qq-0").failure = "TIMEOUT";
  const ctx = context(runtime);
  await assert.rejects(
    runtime.send(ctx, { requestId: "unknown", text: "x" }),
    /UNKNOWN/,
  );
  await assert.rejects(
    runtime.send(ctx, { requestId: "unknown", text: "x" }),
    /ALREADY_ATTEMPTED/,
  );
  assert.equal(runtime.transports.get("qq-0").sent.length, 1);
  assert.equal(
    store.bind("agent-0").search({ kind: "message.sent" }).items.length,
    0,
  );
});
test("pause invalidates a live capability before late sending tools", async (t) => {
  const { runtime } = fixture(t);
  const ctx = context(runtime);
  await runtime.pause("agent-0", true);
  await assert.rejects(
    runtime.send(ctx, { requestId: "late", text: "x" }),
    /PAUSED/,
  );
  assert.equal(runtime.transports.get("qq-0").sent.length, 0);
});
test("in-flight confirmed receipt is still recorded if pause arrives during HTTP request", async (t) => {
  const { runtime, store } = fixture(t);
  const ctx = context(runtime);
  let resolve;
  runtime.transports.get("qq-0").send = () => new Promise((r) => (resolve = r));
  const p = runtime.send(ctx, { requestId: "flight", text: "x" });
  await runtime.pause("all", true);
  resolve({ messageId: "40001" });
  assert.equal((await p).status, "sent");
  assert.equal(store.bind("agent-0").delivery("flight").status, "sent");
});
test("a send cancelled before the gateway call is failed, not unknown", async (t) => {
  const { runtime, store } = fixture(t);
  const ctx = context(runtime);
  const reserve = runtime.subject.reserveContact.bind(runtime.subject);
  // Cancellation lands after the outbox reservation but before any network I/O.
  runtime.subject.reserveContact = (...args) => {
    reserve(...args);
    ctx.controller.abort();
  };
  await assert.rejects(
    runtime.send(ctx, { requestId: "early", text: "x" }),
    /AGENT_PAUSED_OR_EXPIRED/,
  );
  assert.equal(runtime.transports.get("qq-0").sent.length, 0);
  const mem = store.bind("agent-0");
  assert.equal(mem.delivery("early").status, "failed");
  const [result] = mem.search({ kind: "message.send-result" }).items;
  assert.equal(result.status, "failed");
});
test("own recall and diaries permit agent-judged QQ speech across current and later turns", async (t) => {
  const { runtime, store } = fixture(t);
  const mem = store.bind("agent-0");
  const e = mem.append({
    dedupe: "group-memory",
    conversation: "group:20000",
    kind: "message.received",
    body: "蓝鲸约定",
  });
  const diary = mem.diaryWrite({
    title: "感受",
    body: "我记得那次约定",
    evidence: [e.id],
  });
  const ctx = context(runtime, "agent-0", "private:30000");
  const r = await runtime.callTool(ctx, "memory_search", { query: "蓝鲸约定" });
  assert.equal(r.items.length, 1);
  await runtime.callTool(ctx, "memory_read", { id: diary.id });
  assert.equal(
    (
      await runtime.send(ctx, {
        requestId: "recall",
        text: "群里曾聊过蓝鲸约定。",
      })
    ).status,
    "sent",
  );
  const next = context(runtime, "agent-0", "private:30000");
  assert.equal(
    (
      await runtime.send(next, {
        requestId: "next-recall",
        text: "这是我自己的感受。",
      })
    ).status,
    "sent",
  );
  assert.equal(runtime.status().disclosureRequests.length, 0);
  await assert.rejects(
    runtime.callTool(context(runtime, "agent-1"), "memory_read", { id: e.id }),
    /RECORD_NOT_FOUND/,
  );
});
test("old persisted recollection marks no longer lock QQ speech, while external disclosure stays scoped", async (t) => {
  const { runtime, store } = fixture(t);
  const mem = store.bind("agent-0");
  mem.setState("group:20000", { disclosureTaint: ["old-recollection"] });
  const ctx = context(runtime);
  assert.equal(
    (await runtime.send(ctx, { requestId: "old-state", text: "自主表达" }))
      .status,
    "sent",
  );
  runtime.agent("agent-0").tools.push("external_tool");
  await assert.rejects(
    runtime.callTool(ctx, "external_tool", {
      serverId: "test",
      tool: "test",
      arguments: {},
    }),
    /EXTERNAL_CALL_BLOCKED/,
  );
  assert.equal(
    runtime.status().disclosureRequests[0].reason,
    "external-service",
  );
});
test("model cannot supply another agentId or replace its destination", async (t) => {
  const { runtime } = fixture(t);
  const ctx = context(runtime);
  await assert.rejects(
    runtime.callTool(ctx, "memory_search", { agentId: "agent-1" }),
  );
  await assert.rejects(
    runtime.callTool(ctx, "qq_send", {
      requestId: "x",
      text: "x",
      conversation: "group:20001",
    }),
  );
});
test("read watermarks cannot exceed actually displayed message range", async (t) => {
  const { runtime, store } = fixture(t);
  for (let i = 0; i < 5; i++)
    store.bind("agent-0").append({
      dedupe: String(i),
      conversation: "group:20000",
      kind: "message.received",
      body: "x",
    });
  const ctx = context(runtime);
  await assert.rejects(
    runtime.callTool(ctx, "qq_mark_read", { throughSeq: 5 }),
    /UNSEEN/,
  );
  const r = await runtime.callTool(ctx, "conversation_read", { limit: 3 });
  await runtime.callTool(ctx, "qq_mark_read", { throughSeq: r.readThroughSeq });
  assert.equal(store.bind("agent-0").state(ctx.conversation).readThroughSeq, 3);
});
test("diary is not injected automatically into each wake prompt", async (t) => {
  let prompt;
  const { runtime, store } = fixture(t, {
    run: async (r) => {
      prompt = r.prompt;
    },
  });
  store
    .bind("agent-0")
    .diaryWrite({ title: "Secret diary", body: "PRIVATE_DIARY_MARKER" });
  await runtime.ingest("qq-0", raw());
  await settle(runtime);
  assert.ok(!prompt.includes("PRIVATE_DIARY_MARKER"));
  assert.match(prompt, /16|约定下周见/);
});
test("recall guidance never invokes diary writes automatically", async (t) => {
  const { runtime, store } = fixture(t);
  await runtime.ingest("qq-0", raw());
  await settle(runtime);
  assert.equal(store.bind("agent-0").export().tables.diaries.length, 0);
});
test("bounded peer interaction stops loops after configured messages", async (t) => {
  let calls = 0;
  const cfg = config();
  cfg.peerLimit.maxMessages = 2;
  const { runtime, store } = fixture(t, { cfg, run: async () => calls++ });
  for (let i = 0; i < 5; i++) {
    await runtime.ingest("qq-0", raw(i, { user_id: 10001 }));
    await settle(runtime);
  }
  assert.equal(calls, 2);
  assert.equal(store.bind("agent-0").export().tables.events.length, 5);
  await runtime.ingest("qq-0", raw(99));
  await settle(runtime);
  assert.equal(calls, 3);
});
test("self messages are archived without self-triggering", async (t) => {
  let calls = 0;
  const { runtime } = fixture(t, { run: async () => calls++ });
  await runtime.ingest("qq-0", raw(1, { user_id: 10000 }));
  await settle(runtime);
  assert.equal(calls, 0);
});
test("capabilities cannot be written into diary or sent in QQ", async (t) => {
  const { runtime } = fixture(t),
    ctx = context(runtime);
  await assert.rejects(
    runtime.callTool(ctx, "diary_write", { title: "x", body: ctx.token }),
    /EXFILTRATION/,
  );
  await assert.rejects(
    runtime.send(ctx, { requestId: "x", text: ctx.token }),
    /SENSITIVE/,
  );
});
test("recall and revocation events keep attachments as unrecognized observations", async (t) => {
  const cfg = config();
  cfg.globalPaused = true;
  const { runtime, store } = fixture(t, { cfg });
  await runtime.ingest(
    "qq-0",
    raw(1, {
      message: [{ type: "image", data: { url: "https://example.org/a.png" } }],
    }),
  );
  await runtime.ingest(
    "qq-0",
    raw(1, { post_type: "notice", notice_type: "group_recall" }),
  );
  const rows = store.bind("agent-0").search().items;
  assert.ok(rows.some((x) => x.type === "message.recalled"));
  assert.ok(rows.some((x) => x.body.includes("尚未识别")));
});

test("minimal config expands nested wake and peer defaults on first creation", () => {
  const c = config();
  delete c.agents[0].wake;
  delete c.peerLimit;
  const v = validateConfig(c);
  assert.equal(v.agents[0].wake.participation, 0.05);
  assert.equal(v.agents[0].wake.mentions, true);
  assert.equal(v.peerLimit.maxMessages, 6);
});

test("outbound archive reflects the actual plain text sent to QQ", async (t) => {
  const { runtime, store } = fixture(t);
  await runtime.send(context(runtime), {
    requestId: "md",
    text: "**Hello** `world`",
  });
  assert.equal(
    runtime.transports.get("qq-0").sent[0].segments[0].data.text,
    "Hello world",
  );
  assert.equal(
    store.bind("agent-0").search({ kind: "message.sent" }).items[0].body,
    "Hello world",
  );
});

test("diary creation records its actual writing scene and revisions keep that provenance", async (t) => {
  const { runtime, store } = fixture(t);
  const ctx = context(runtime, "agent-0", "private:30000");
  const d = await runtime.callTool(ctx, "diary_write", {
    title: "我的记忆",
    body: "当时的感受",
  });
  await runtime.callTool(ctx, "diary_revise", {
    id: d.id,
    expectedRevision: 1,
    title: "我的记忆",
    body: "后来又想到一点",
  });
  const record = JSON.parse(store.bind("agent-0").read({ id: d.id }).chunk);
  assert.deepEqual(record.metadata.writtenIn, {
    conversation: "private:30000",
    connectionId: "qq-0",
  });
  await assert.rejects(
    runtime.callTool(ctx, "diary_write", {
      title: "伪造",
      body: "x",
      writtenIn: { conversation: "group:20001" },
    }),
  );
});

test("protected operations content cannot lose its restriction by being saved and revised as a diary", async (t) => {
  const { runtime } = fixture(t);
  runtime.agent("agent-0").ownerIds = ["30000"];
  const ctx = context(runtime);
  ctx.privateRead.add("operations:file-source");
  const diary = await runtime.callTool(ctx, "diary_write", {
    title: "工作区笔记",
    body: "受限文件内容",
  });
  const next = context(runtime, "agent-0", "private:30000");
  await runtime.callTool(next, "memory_search", {
    query: "工作区笔记",
    maxChars: 512,
  });
  await assert.rejects(
    runtime.send(next, { requestId: "protected-diary", text: "受限文件内容" }),
    /DISCLOSURE/,
  );
  await runtime.callTool(next, "diary_revise", {
    id: diary.id,
    expectedRevision: 1,
    title: "工作区笔记",
    body: "整理后的受限内容",
  });
  const other = context(runtime, "agent-0", "group:20001");
  await assert.rejects(
    runtime.callTool(other, "memory_read", { id: diary.id }),
    /RECALL_SOURCE_NOT_ALLOWED/,
  );
  assert(!other.privateRead.has(diary.id));
  // A context that previously saw the record must still be blocked.
  other.privateRead.add("operations:diary:" + diary.id);
  await assert.rejects(
    runtime.send(other, {
      requestId: "protected-revision",
      text: "整理后的受限内容",
    }),
    /DISCLOSURE/,
  );
});
