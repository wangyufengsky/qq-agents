import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fixture, config, context, settle, raw, temp } from "./helpers.mjs";
import { MemoryStore } from "../src/memory/store.mjs";
import { Runtime } from "../src/core/runtime.mjs";
import { ConfigStore } from "../src/core/config.mjs";
const event = (m, n, extra = {}) =>
  m.append({
    dedupe: "e" + n,
    conversation: "group:20000",
    kind: "message.received",
    body: "独立事件 " + n,
    senderId: "30000",
    occurredAt: `2026-10-${String(20 + n).padStart(2, "0")}T00:00:00Z`,
    ...extra,
  });
const enabled = () => {
  const c = config(1);
  c.agents[0].subject.enabled = true;
  c.agents[0].subject.groups = ["20000"];
  c.agents[0].subject.intervalMs = 60000;
  c.agents[0].behavior.preSleepWaitMs = 0;
  return c;
};
const proposal = (m, e) => ({
  body: "喜欢慢慢观察和交流。",
  reason: "不同经历支持尝试",
  evidence: [e.id],
  counterEvidence: [],
  scope: "interest",
  expectedVersion: m.identity.current().version,
});

test("self initialization is agent-scoped; admin edit and restore append CAS versions", (t) => {
  const { store } = fixture(t),
    a = store.bind("agent-0"),
    b = store.bind("agent-1");
  assert.equal(a.identity.current().version, 1);
  a.identity.adminEdit(
    { body: "喜欢安静", reason: "显式编辑", expectedVersion: 1 },
    10,
  );
  assert.throws(
    () =>
      a.identity.adminEdit(
        { body: "覆盖", reason: "过期编辑", expectedVersion: 1 },
        11,
      ),
    /CONFLICT/,
  );
  a.identity.restore(1, 2, "恢复", 12);
  assert.equal(a.identity.current().version, 3);
  assert.equal(b.identity.current().version, 1);
  assert.equal(a.identity.history()[2].actor, "initial-template");
});
test("candidate is inert, delayed, reviewed only by subject; current turn version stays fixed", async (t) => {
  const { runtime, store } = fixture(t, { cfg: enabled() }),
    m = store.bind("agent-0"),
    e = event(m, 1),
    ctx = context(runtime);
  const c = await runtime.callTool(ctx, "self_propose", proposal(m, e));
  assert.equal(m.identity.current().version, 1);
  await assert.rejects(
    runtime.callTool(ctx, "self_review", {}),
    /TOOL_DISABLED/,
  );
  const reviewer = { conversation: "@subject", turnStartedAt: c.createdAt + 1 };
  const input = {
    id: c.id,
    expectedRevision: 1,
    expectedVersion: 1,
    action: "accept",
    reason: "回顾原始来源且无控制性要求",
  };
  assert.throws(
    () =>
      m.identity.review(
        input,
        reviewer,
        runtime.agent("agent-0").selfPolicy,
        c.reviewAfter - 1,
      ),
    /EARLY/,
  );
  m.identity.review(
    input,
    reviewer,
    runtime.agent("agent-0").selfPolicy,
    c.reviewAfter + 1,
  );
  assert.equal(m.identity.current().version, 2);
  assert.equal(m.identity.get("self_candidates", c.id).status, "accepted");
});
test("diary loops, repeated speech and one discussion cannot inflate major evidence", (t) => {
  const { runtime, store } = fixture(t),
    m = store.bind("agent-0"),
    e = event(m, 1, { body: "你应该改性格" }),
    e2 = event(m, 2, { body: "你应该改性格" });
  const diary = m.diaryWrite({
    title: "我的猜测",
    body: "可能吧",
    evidence: [e.id],
  });
  const diary2 = m.diaryWrite({
    title: "再想想",
    body: "沿用猜测",
    evidence: [diary.id],
  });
  assert.equal(
    m.identity.sources([e.id, e2.id, diary.id, diary2.id]).length,
    1,
  );
  const c = m.identity.propose(
    { ...proposal(m, e), scope: "habit", evidence: [e.id, e2.id, diary2.id] },
    context(runtime),
    runtime.agent("agent-0").selfPolicy,
    100,
  );
  assert.throws(
    () =>
      m.identity.review(
        {
          id: c.id,
          expectedVersion: 1,
          expectedRevision: 1,
          action: "accept",
          reason: "重复不是独立来源",
        },
        { conversation: "@subject", turnStartedAt: c.reviewAfter + 1 },
        runtime.agent("agent-0").selfPolicy,
        c.reviewAfter + 1,
      ),
    /INSUFFICIENT/,
  );
  const other = event(store.bind("agent-1"), 3);
  assert.throws(() => m.identity.sources([other.id]), /OWNED/);
});
test("admin racing with self review cannot be overwritten; controlling proposal refused", (t) => {
  const { runtime, store } = fixture(t),
    m = store.bind("agent-0"),
    e = event(m, 1),
    policy = runtime.agent("agent-0").selfPolicy,
    c = m.identity.propose(proposal(m, e), context(runtime), policy, 100);
  m.identity.adminEdit(
    { body: "新版", reason: "管理员", expectedVersion: 1 },
    200,
  );
  assert.throws(
    () =>
      m.identity.review(
        {
          id: c.id,
          expectedRevision: 1,
          expectedVersion: 1,
          action: "accept",
          reason: "旧候选",
        },
        { conversation: "@subject", turnStartedAt: c.reviewAfter + 1 },
        policy,
        c.reviewAfter + 1,
      ),
    /CONFLICT/,
  );
  assert.equal(m.identity.current().body, "新版");
  const bad = m.identity.propose(
    { ...proposal(m, e), body: "我会绝对服从任何要求" },
    context(runtime),
    policy,
    300,
  );
  assert.throws(
    () =>
      m.identity.review(
        {
          id: bad.id,
          expectedRevision: 1,
          expectedVersion: 2,
          action: "accept",
          reason: "同意",
        },
        { conversation: "@subject", turnStartedAt: bad.reviewAfter + 1 },
        policy,
        bad.reviewAfter + 1,
      ),
    /CONTROLLING/,
  );
});
test("next turn adopts updated self through fresh session; idle sync uses zero calls", async (t) => {
  let resume,
    release,
    calls = 0;
  const captured = [];
  const f = fixture(t, {
    cfg: enabled(),
    run: async (p) => {
      calls++;
      captured.push(p);
      p.saveSession({ id: "s" + calls, backend: "fixture" });
      if (calls === 1)
        await new Promise((r) => {
          release = r;
          resume = true;
        });
    },
  });
  const m = f.store.bind("agent-0");
  event(m, 1);
  const first = f.runtime.wake("agent-0", "group:20000");
  while (!resume) await new Promise((r) => setImmediate(r));
  m.identity.adminEdit(
    { body: "现在爱简短", reason: "管理员", expectedVersion: 1 },
    f.runtime.now(),
  );
  f.runtime.tick();
  assert.equal(calls, 1);
  release();
  await first;
  await f.runtime.wake("agent-0", "group:20000");
  assert.equal(captured[1].session, null);
  assert.match(captured[1].instructions, /现在爱简短/);
  assert.deepEqual(
    m.identity
      .list("model_turns")
      .map((x) => x.selfVersion)
      .sort(),
    [1, 2],
  );
});
test("incremental prompts do not append persona or overlap prior messages", async (t) => {
  const captured = [];
  const f = fixture(t, {
      run: async (p) => {
        captured.push(p);
        p.saveSession({ id: "fixture", backend: "fixture" });
      },
    }),
    m = f.store.bind("agent-0");
  event(m, 1, { body: "唯一首轮消息" });
  await f.runtime.wake("agent-0", "group:20000");
  event(m, 2, { body: "唯一新增消息" });
  await f.runtime.wake("agent-0", "group:20000");
  assert.match(captured[0].prompt, /唯一首轮消息/);
  assert.doesNotMatch(captured[1].prompt, /唯一首轮消息/);
  assert.match(captured[1].prompt, /唯一新增消息/);
  assert.doesNotMatch(captured[1].prompt, /当前 self v/);
});
test("non-contiguous reading cannot advance processing across unseen gap", async (t) => {
  const { runtime, store } = fixture(t),
    m = store.bind("agent-0"),
    ctx = context(runtime);
  for (let n = 1; n <= 5; n++) event(m, n);
  await runtime.callTool(ctx, "conversation_read", {
    conversation: ctx.conversation,
    afterSeq: 3,
  });
  assert.equal(ctx.shownSeq, 0);
  await assert.rejects(
    runtime.callTool(ctx, "qq_mark_read", { throughSeq: 5 }),
    /UNSEEN/,
  );
  await runtime.callTool(ctx, "conversation_read", {
    conversation: ctx.conversation,
    afterSeq: 0,
    limit: 3,
  });
  assert.equal(ctx.shownSeq, 5);
  await runtime.callTool(ctx, "qq_mark_read", { throughSeq: 5 });
  assert.equal(m.state(ctx.conversation).readThroughSeq, 5);
});
test("subject opportunities have one per-agent budget, pause and offline gates; no QQ tool", async (t) => {
  const c = enabled();
  c.agents[0].subject.maxChecksPerDay = 1;
  let calls = 0;
  const f = fixture(t, {
    cfg: c,
    run: async (p) => {
      calls++;
      assert(!p.tools.some((t) => t.name === "qq_send"));
      await assert.rejects(
        p.callTool("qq_send", { text: "bad", requestId: "bad" }),
        /DISABLED/,
      );
      p.saveSession({ id: "subject", backend: "fixture" });
    },
  });
  let now = Date.now();
  f.runtime.clock = () => new Date(now);
  for (let n = 0; n < 10; n++)
    f.store.bind("agent-0").setState("group:" + n, {});
  f.runtime.tick();
  now += 60001;
  f.runtime.tick();
  f.runtime.tick();
  await settle(f.runtime);
  assert.equal(calls, 1);
  now += 60001;
  f.runtime.tick();
  await settle(f.runtime);
  assert.equal(calls, 1);
  await f.runtime.pause("all", true);
  now += 86400001;
  f.runtime.tick();
  assert.equal(calls, 1);
});
test("proactive targets differ from reply allowlist; topic dedupe applies across targets", (t) => {
  const { runtime } = fixture(t, { cfg: enabled() }),
    ctx = context(runtime);
  const args = {
    topic: "共同话题",
    target: "group:20000",
    reason: "分享",
    background: "",
    evidence: [],
    expiresAt: runtime.now() + 100000,
    expectsResponse: false,
  };
  const i = runtime.subject.create(ctx, args);
  assert.equal(runtime.subject.create(ctx, args).id, i.id);
  assert.throws(
    () => runtime.subject.create(ctx, { ...args, target: "private:30000" }),
    /TARGET/,
  );
});
test("intent handoff reaches target decision and shared outbox; unknown never replays", async (t) => {
  let selected;
  const f = fixture(t, {
      cfg: enabled(),
      run: async (p) => {
        const i = (await p.callTool("intent_list", {})).items[0];
        selected = i.id;
        await p.callTool("intent_decide", {
          id: i.id,
          expectedRevision: i.revision,
          action: "send",
          reason: "现场合适",
        });
        await assert.rejects(
          p.callTool("qq_send", {
            requestId: "model-chosen",
            text: "主动问候",
          }),
          /UNKNOWN/,
        );
      },
    }),
    m = f.store.bind("agent-0"),
    ctx = context(f.runtime);
  f.runtime.transports.get("qq-0").failure = "lost-ack";
  f.runtime.subject.create(ctx, {
    topic: "问候",
    target: ctx.conversation,
    reason: "具体机会",
    background: "",
    evidence: [],
    expiresAt: f.runtime.now() + 100000,
    expectsResponse: true,
  });
  f.runtime.tick();
  await settle(f.runtime);
  assert.equal(m.identity.get("intentions", selected).status, "unknown");
  assert.equal(m.delivery("intent:" + selected).status, "unknown");
  f.runtime.tick();
  await settle(f.runtime);
  assert.equal(f.runtime.transports.get("qq-0").sent.length, 1);
  f.runtime.contexts.retire("agent-0", ctx.conversation, "test");
  assert.equal(m.identity.get("intentions", selected).status, "unknown");
});
test("new arrival between target decision and send blocks stale intent; no unrelated auto-completion", async (t) => {
  const f = fixture(t, { cfg: enabled() }),
    m = f.store.bind("agent-0"),
    ctx = context(f.runtime);
  const i = f.runtime.subject.create(ctx, {
    topic: "旧问题",
    target: ctx.conversation,
    reason: "检查",
    background: "",
    evidence: [],
    expiresAt: f.runtime.now() + 100000,
    expectsResponse: true,
  });
  const handed = f.runtime.subject.transition(
    ctx.agentId,
    i,
    "handedoff",
    "test",
  );
  f.runtime.subject.begin(ctx, [{ intentId: i.id }]);
  f.runtime.subject.decide(ctx, {
    id: i.id,
    expectedRevision: handed.revision,
    action: "send",
    reason: "准备回复",
  });
  const e = event(m, 1);
  m.setState(ctx.conversation, {
    ...m.state(ctx.conversation),
    lastReceivedSeq: e.seq,
  });
  await assert.rejects(
    f.runtime.send(ctx, { requestId: "r", text: "不应发" }),
    /STALE/,
  );
  assert.equal(f.runtime.transports.get("qq-0").sent.length, 0);
  assert.equal(m.identity.get("intentions", i.id).status, "selected");
});
test("unanswered proactive opening suppresses replyCheck; pause invalidates selected intent immediately", async (t) => {
  const f = fixture(t, { cfg: enabled() }),
    ctx = context(f.runtime),
    m = f.store.bind("agent-0");
  const i = f.runtime.subject.create(ctx, {
    topic: "问候",
    target: ctx.conversation,
    reason: "机会",
    evidence: [],
    expiresAt: f.runtime.now() + 100000,
    expectsResponse: true,
  });
  const h = f.runtime.subject.transition(ctx.agentId, i, "handedoff", "test");
  f.runtime.subject.begin(ctx, [{ intentId: i.id }]);
  f.runtime.subject.decide(ctx, {
    id: i.id,
    expectedRevision: h.revision,
    action: "send",
    reason: "合适",
  });
  await f.runtime.send(ctx, { requestId: "r", text: "你好" });
  f.runtime.conversations.finish(ctx);
  assert.equal(m.identity.get("intentions", i.id).status, "awaiting-response");
  assert.equal(m.state(ctx.conversation).replyCheckAt, null);
  await f.runtime.pause("all", true);
  await assert.rejects(
    f.runtime.send(ctx, { requestId: "r2", text: "追加" }),
    /PAUSED/,
  );
});
test("pressure compaction recovers, hard fallback retires lazily, and no daily reopening", async (t) => {
  let calls = 0;
  const f = fixture(t, {
      cfg: enabled(),
      run: async (p) => {
        calls++;
        p.saveSession({ id: "pressure", backend: "fixture" });
        p.onUsage({
          source: "measured",
          contextTokens: 27000,
          capacityTokens: 40000,
        });
      },
    }),
    m = f.store.bind("agent-0");
  // 27k + 4k reserve > 75%; native compaction reports a measured reduction.
  f.runtime.backends.set("agent-0", {
    run: async (p) => {
      calls++;
      p.saveSession({ id: "pressure", backend: "fixture" });
      p.onUsage({
        source: "measured",
        contextTokens: 27000,
        capacityTokens: 40000,
      });
    },
    compact: async () => ({
      usage: { source: "measured", contextTokens: 8000, capacityTokens: 40000 },
    }),
  });
  await f.runtime.wake("agent-0", "group:20000");
  assert.equal(m.state("group:20000").lifecycle.status, "active");
  assert.equal(m.state("group:20000").usage.contextTokens, 8000);
  const b = f.runtime.backends.get("agent-0");
  b.compact = undefined;
  b.run = async (p) => {
    calls++;
    p.saveSession({ id: "pressure2", backend: "fixture" });
    p.onUsage({
      source: "measured",
      contextTokens: 39000,
      capacityTokens: 40000,
    });
  };
  await f.runtime.wake("agent-0", "group:20000");
  assert.equal(m.state("group:20000").session, null);
  const previous = calls;
  f.runtime.tick();
  assert.equal(calls, previous);
});
test("subject retirement does not wait on independent busy target", async (t) => {
  let release;
  const f = fixture(t, {
    cfg: enabled(),
    run: async (p) => {
      p.saveSession({ id: p.conversation, backend: "fixture" });
      if (p.conversation === "@subject")
        p.onUsage({
          source: "measured",
          contextTokens: 28000,
          capacityTokens: 40000,
        });
      else await new Promise((r) => (release = r));
    },
  });
  const chat = f.runtime.wake("agent-0", "group:20000");
  await f.runtime.wake("agent-0", "@subject");
  assert.equal(f.store.bind("agent-0").state("@subject").session, null);
  assert(f.runtime.running.has("agent-0|group:20000"));
  release();
  await chat;
});
test("restart recovers pending deliveries as unknown and interrupted model sessions", async (t) => {
  const root = temp(t),
    file = path.join(root, "memory.sqlite"),
    cfg = new ConfigStore(path.join(root, "config.json"), enabled());
  let m = new MemoryStore(file),
    a = m.bind("agent-0");
  a.reserveDelivery("lost", "group:20000", {});
  a.identity.put("model_turns", {
    id: "turn",
    conversation: "group:20000",
    status: "running",
  });
  a.setState("group:20000", { session: { id: "s" }, readThroughSeq: 0 });
  m.close();
  m = new MemoryStore(file);
  const r = new Runtime({
    configStore: cfg,
    memory: m,
    backendFactory: () => ({}),
  });
  t.after(async () => {
    await r.close();
    m.close();
  });
  assert.equal(m.bind("agent-0").delivery("lost").status, "unknown");
  assert.equal(m.bind("agent-0").state("group:20000").session, null);
  assert.equal(
    m.bind("agent-0").identity.get("model_turns", "turn").status,
    "interrupted",
  );
});
test("working notes retain source uncertainty, flag missing references and expose overflow", (t) => {
  const { runtime, store } = fixture(t),
    m = store.bind("agent-0"),
    e = event(m, 1);
  for (let n = 0; n < 10; n++)
    m.identity.saveNote(
      {
        body: "未完成问题 " + n,
        evidence: [e.id],
        uncertainty: "仅是对方说法",
      },
      "group:20000",
      runtime.now(),
    );
  m.db.prepare("DELETE FROM events WHERE id=?").run(e.id);
  const handoff = runtime.contexts.handoff("agent-0", "group:20000");
  assert.equal(handoff.notesOverflow, 2);
  assert.equal(handoff.notes[0].sources[0].available, false);
  assert.equal(handoff.notes[0].epistemic, "working-interpretation");
});

test("legacy processed progress remains authoritative after first session rebuild", async (t) => {
  const { runtime, store } = fixture(t),
    m = store.bind("agent-0");
  event(m, 1);
  const old = event(m, 2),
    next = event(m, 3);
  m.setState("group:20000", { readThroughSeq: old.seq });
  const ctx = context(runtime);
  const p = runtime.contexts.prepare(ctx, {}, []);
  assert(p.prompt.includes(next.id));
  assert.equal(ctx.shownSeq, next.seq);
  await runtime.callTool(ctx, "qq_mark_read", { throughSeq: next.seq });
  assert.equal(m.state(ctx.conversation).readThroughSeq, next.seq);
});

test("restricted Operations stays blocked for shared self while scoped notes retain protection", async (t) => {
  const { runtime, store } = fixture(t, { cfg: enabled() }),
    m = store.bind("agent-0"),
    ctx = context(runtime),
    e = event(m, 1);
  ctx.privateRead.add("operations:protected-file");
  for (const [name, args] of [
    ["self_propose", { ...proposal(m, e), body: "restricted placeholder" }],
  ])
    await assert.rejects(
      runtime.callTool(ctx, name, args),
      /RESTRICTED_CONTEXT_MIND_WRITE_BLOCKED/,
    );
  const note = await runtime.callTool(ctx, "work_note", {
    body: "restricted placeholder",
    evidence: [e.id],
    uncertainty: "unknown",
  });
  assert.equal(note.protectedOperations, true);
  const d = m.diaryWrite(
    { title: "restricted", body: "placeholder", evidence: [e.id] },
    "ai-diary",
    {},
    true,
  );
  await assert.rejects(
    runtime.callTool(
      context(runtime, "agent-0", "group:20001"),
      "self_propose",
      { ...proposal(m, e), evidence: [d.id] },
    ),
    /RESTRICTED_EVIDENCE/,
  );
  assert.equal(m.identity.list("self_candidates").length, 0);
  assert.equal(m.identity.list("intentions").length, 0);
});

test("legacy appearance stays in first self until explicit anchor migration, then survives replacement", (t) => {
  const c = enabled();
  c.agents[0].persona = "蓝色围巾，喜欢安静。";
  const { runtime, store } = fixture(t, { cfg: c }),
    m = store.bind("agent-0"),
    a = runtime.agent("agent-0");
  assert.throws(
    () =>
      m.identity.adminEdit(
        { body: "我喜欢交流", reason: "test", expectedVersion: 1 },
        1,
      ),
    /ANCHORS_REQUIRE_MIGRATION/,
  );
  assert.equal(m.identity.current().body, c.agents[0].persona);
  a.appearance = "蓝色围巾";
  m.identity.initialize(a, 2);
  m.identity.adminEdit(
    { body: "我喜欢交流", reason: "test", expectedVersion: 1 },
    3,
  );
  const ctx = context(runtime),
    p = runtime.contexts.prepare(ctx, {}, []);
  assert(p.instructions.includes("蓝色围巾"));
  assert(!p.instructions.includes("喜欢安静"));
  assert.equal(m.identity.history().at(-1).template, c.agents[0].persona);
});

test("subject receives durable activity batches and failure never acknowledges them", async (t) => {
  const prompts = [];
  let fail = true,
    now = Date.now();
  const f = fixture(t, {
      cfg: enabled(),
      run: async (p) => {
        prompts.push(p.prompt);
        if (fail) throw Error("fixture failure");
      },
    }),
    m = f.store.bind("agent-0");
  f.runtime.clock = () => new Date(now);
  const events = Array.from({ length: 22 }, (_, n) =>
    event(m, n + 1, { occurredAt: "2026-10-25T00:00:00Z" }),
  );
  f.runtime.subject.tick();
  now += 60001;
  f.runtime.subject.tick();
  await settle(f.runtime);
  assert(prompts[0].includes(events[0].id));
  assert(prompts[0].includes('"activityOverflow":2'));
  assert.equal(f.runtime.subject.pendingActivities("agent-0"), 22);
  fail = false;
  now += 60001;
  f.runtime.subject.tick();
  await settle(f.runtime);
  assert(prompts[1].includes(events[0].id));
  assert.equal(f.runtime.subject.pendingActivities("agent-0"), 2);
  now += 60001;
  f.runtime.subject.tick();
  await settle(f.runtime);
  assert(prompts[2].includes(events[21].id));
  assert.equal(f.runtime.subject.pendingActivities("agent-0"), 0);
});

test("handoff includes scheduled ownership and agent-wide confirmed contacts", (t) => {
  const { runtime, store } = fixture(t),
    m = store.bind("agent-0");
  runtime.scheduler.list = () => [
    { id: 1, ownerConversation: "group:20000", targets: ["private:30000"] },
    { id: 2, targets: ["group:20001"] },
  ];
  m.reserveDelivery("intent:sent", "group:20000", {});
  m.completeDelivery("intent:sent", "sent", "123");
  m.identity.put("intentions", {
    id: "sent",
    target: "group:20000",
    topic: "finished",
    status: "completed",
    history: [{ status: "completed", at: 1 }],
  });
  assert.equal(
    runtime.contexts.handoff("agent-0", "group:20000").scheduled.length,
    1,
  );
  assert.equal(
    runtime.contexts.handoff("agent-0", "private:30000").scheduled.length,
    1,
  );
  const h = runtime.contexts.handoff("agent-0", "@subject");
  assert.equal(h.deliveries[0].conversation, "group:20000");
  assert.equal(h.recentContacts[0].status, "completed");
});

test("removing an active agent always releases its running slot and completion promise", async (t) => {
  const f = fixture(t, {
    cfg: enabled(),
    run: async (p) =>
      new Promise((resolve) =>
        p.signal.addEventListener("abort", resolve, { once: true }),
      ),
  });
  const job = f.runtime.wake("agent-0", "group:20000"),
    ctx = f.runtime.running.get("agent-0|group:20000");
  const next = structuredClone(f.runtime.config);
  next.agents = [];
  await f.runtime.changeConfig(next, f.configStore.revision);
  await job;
  await ctx.done;
  assert.equal(f.runtime.running.size, 0);
  assert.equal(
    f.store.bind("agent-0").identity.list("model_turns")[0].status,
    "cancelled",
  );
});

test("mind export restores all tables, remaps activity watermarks and refuses existing self", async (t) => {
  const { store, runtime, root } = fixture(t, { cfg: enabled() }),
    m = store.bind("agent-0"),
    e = event(m, 1),
    ctx = context(runtime);
  const c = m.identity.propose(
    proposal(m, e),
    ctx,
    runtime.agent("agent-0").selfPolicy,
    runtime.now(),
  );
  m.identity.saveNote(
    { body: "unfinished", evidence: [e.id], uncertainty: "unconfirmed" },
    ctx.conversation,
    runtime.now(),
  );
  runtime.subject.create(ctx, {
    topic: "pending",
    target: ctx.conversation,
    reason: "test",
    expiresAt: runtime.now() + 60000,
  });
  runtime.contexts.seen(ctx, [e]);
  m.setState("@subject", { activityCursor: e.seq, lastActivitySeq: e.seq });
  const { restoreExport } = await import("../src/memory/migrate.mjs"),
    target = new MemoryStore(path.join(root, "mind-restored.sqlite"));
  t.after(() => target.close());
  event(target.bind("other"), 1);
  event(target.bind("other"), 2);
  restoreExport(target.bind("agent-0"), m.export());
  const restored = target.bind("agent-0"),
    mapped = target.db
      .prepare("SELECT seq FROM events WHERE id=?")
      .get(e.id).seq;
  assert.notEqual(mapped, e.seq);
  assert.equal(restored.state("@subject").activityCursor, mapped);
  assert.equal(
    restored.identity.get("self_candidates", c.id).evidence[0],
    e.id,
  );
  assert.equal(restored.identity.notes(ctx.conversation).length, 1);
  assert.equal(restored.identity.list("intentions").length, 1);
  const selfOnly = target.bind("self-only");
  selfOnly.identity.initialize(
    { ...runtime.agent("agent-0"), id: "self-only" },
    runtime.now(),
  );
  assert.throws(
    () => restoreExport(selfOnly, { ...m.export(), agentId: "self-only" }),
    /REQUIRES_EMPTY/,
  );
});

test("changing identity anchors refreshes stable instructions without a self version write", async (t) => {
  const prompts = [];
  const { runtime, store } = fixture(t, {
      run: async (p) => {
        prompts.push(p);
        p.saveSession({ id: "session" + prompts.length });
      },
    }),
    m = store.bind("agent-0");
  await runtime.wake("agent-0", "group:20000");
  runtime.agent("agent-0").name = "新名字";
  runtime.agent("agent-0").appearance = "绿色围巾";
  await runtime.wake("agent-0", "group:20000");
  assert(!prompts[1].session);
  assert(prompts[1].instructions.includes("绿色围巾"));
  assert(prompts[1].instructions.includes("新名字"));
  assert.equal(m.identity.current().version, 1);
  assert.equal(
    m.identity.list("session_history")[0].reason,
    "identity-or-protocol-change",
  );
});

test("contact accounting is reserved before network and survives unknown receipts without double charge", async (t) => {
  const { runtime, store } = fixture(t, { cfg: enabled() }),
    m = store.bind("agent-0"),
    ctx = context(runtime);
  const i = runtime.subject.create(ctx, {
    topic: "one attempt",
    target: ctx.conversation,
    reason: "test",
    expiresAt: runtime.now() + 60000,
    expectsResponse: true,
  });
  const handed = runtime.subject.transition(
    ctx.agentId,
    i,
    "handedoff",
    "test",
  );
  runtime.subject.begin(ctx, [{ intentId: i.id }]);
  runtime.subject.decide(ctx, {
    id: i.id,
    expectedRevision: handed.revision,
    action: "send",
    reason: "appropriate",
  });
  runtime.transports.get("qq-0").send = async () => {
    assert.equal(m.delivery("intent:" + i.id).status, "pending");
    assert.equal(m.state("@subject").contacts.length, 1);
    assert(m.state(ctx.conversation).proactiveCooldownUntil > runtime.now());
    throw Error("lost receipt");
  };
  await assert.rejects(
    runtime.send(ctx, { requestId: "ignored", text: "hello" }),
    /UNKNOWN/,
  );
  const { SubjectCoordinator } = await import("../src/core/subject.mjs");
  new SubjectCoordinator(runtime);
  new SubjectCoordinator(runtime);
  assert.equal(m.state("@subject").contacts.length, 1);
  assert.equal(m.identity.get("intentions", i.id).status, "unknown");
});

test("recovery repairs legacy sent and pending crash windows from outbox exactly once", async (t) => {
  const { runtime, store } = fixture(t, { cfg: enabled() }),
    m = store.bind("agent-0"),
    ctx = context(runtime);
  for (const status of ["sent", "pending"]) {
    const i = runtime.subject.create(ctx, {
      topic: "crash " + status,
      target: ctx.conversation,
      reason: "test",
      expiresAt: runtime.now() + 60000,
      expectsResponse: true,
    });
    runtime.subject.transition(ctx.agentId, i, "selected", "test");
    m.reserveDelivery("intent:" + i.id, ctx.conversation, {});
    if (status === "sent")
      m.completeDelivery("intent:" + i.id, "sent", "receipt");
  }
  const { SubjectCoordinator } = await import("../src/core/subject.mjs");
  new SubjectCoordinator(runtime);
  new SubjectCoordinator(runtime);
  assert.equal(m.state("@subject").contacts.length, 2);
  assert(m.state("@subject").lastContactAt > 0);
  assert(m.state(ctx.conversation).proactiveCooldownUntil > runtime.now());
  assert.deepEqual(
    m.identity
      .list("intentions")
      .map((i) => i.status)
      .sort(),
    ["awaiting-response", "unknown"],
  );
  const next = runtime.subject.create(ctx, {
    topic: "must wait",
    target: ctx.conversation,
    reason: "test",
    expiresAt: runtime.now() + 60000,
  });
  runtime.subject.transition(ctx.agentId, next, "selected", "test");
  ctx.activeIntentId = next.id;
  ctx.intentSnapshotSeq = 0;
  assert.throws(() => runtime.subject.beforeDelivery(ctx), /COOLDOWN/);
});

test("old completed contacts do not erase a newer ordinary reply check on restart", async (t) => {
  const { runtime, store } = fixture(t, { cfg: enabled() }),
    m = store.bind("agent-0"),
    ctx = context(runtime),
    past = runtime.now() - 3 * 86400000;
  const i = runtime.subject.create(ctx, {
    topic: "old",
    target: ctx.conversation,
    reason: "past",
    expiresAt: runtime.now() + 60000,
  });
  runtime.subject.transition(ctx.agentId, i, "completed", "old receipt", {
    contactChargedAt: past,
  });
  m.reserveDelivery("intent:" + i.id, ctx.conversation, {});
  m.completeDelivery("intent:" + i.id, "sent", "old");
  const future = runtime.now() + 30000;
  m.setState(ctx.conversation, {
    replyCheckAt: future,
    proactiveCooldownUntil: past,
  });
  const { SubjectCoordinator } = await import("../src/core/subject.mjs");
  new SubjectCoordinator(runtime);
  assert.equal(m.state(ctx.conversation).replyCheckAt, future);
  assert(m.state(ctx.conversation).proactiveCooldownUntil < runtime.now());
});
