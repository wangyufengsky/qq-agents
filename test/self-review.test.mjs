import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  config,
  fixture,
  context,
  settle,
  FakeTransport,
  temp,
} from "./helpers.mjs";
import { MemoryStore } from "../src/memory/store.mjs";
import { restoreExport } from "../src/memory/migrate.mjs";
import { SubjectCoordinator } from "../src/core/subject.mjs";

const chat = "group:20000",
  id = "agent-0";
function enabled() {
  const cfg = config(1),
    a = cfg.agents[0];
  a.subject.enabled = true;
  a.subject.groups = ["20000"];
  a.behavior.preSleepWaitMs = 0;
  a.contextPolicy.capacityTokens = 40000;
  a.contextPolicy.reserveTokens = 4000;
  return cfg;
}
function event(m, n, extra = {}) {
  const saved = m.append({
    dedupe: `review-${n}`,
    conversation: chat,
    connectionId: "qq-0",
    messageId: String(n),
    kind: "message.received",
    direction: "in",
    senderId: "30000",
    body: `独立观察 ${n}`,
    occurredAt: `2026-10-${String(20 + (n % 8)).padStart(2, "0")}T00:00:00Z`,
    ...extra,
  });
  return m.event(
    m.db.prepare("SELECT * FROM events WHERE id=?").get(saved.id),
    chat,
  );
}
function propose(runtime, evidence, scope = "habit") {
  return runtime.memory.bind(id).identity.propose(
    {
      body: "继续探索兴趣和习惯",
      reason: "回顾原始经历",
      evidence,
      scope,
      expectedVersion: 1,
    },
    context(runtime),
    runtime.agent(id).selfPolicy,
    100,
  );
}
function accept(runtime, candidate) {
  return runtime.memory.bind(id).identity.review(
    {
      id: candidate.id,
      expectedVersion: 1,
      expectedRevision: 1,
      action: "accept",
      reason: "延后回顾来源",
    },
    { conversation: "@subject", turnStartedAt: candidate.reviewAfter + 1 },
    runtime.agent(id).selfPolicy,
    candidate.reviewAfter + 1,
  );
}
function intent(runtime, extra = {}) {
  return runtime.subject.create(context(runtime), {
    topic: "了解新的出行安排",
    target: chat,
    reason: "补充任务信息",
    expiresAt: runtime.now() + 86400000,
    ...extra,
  });
}

test("F1: automatic pressure rebuild and Self refresh retain observed task facts without notes", async (t) => {
  const { runtime, store } = fixture(t, { cfg: enabled() }),
    m = store.bind(id),
    prompts = [];
  const first = event(m, 1, {
    body: "杭州旅行，三人同行，每晚预算600元。请先帮我考虑路线。",
  });
  let pressure = true;
  runtime.backends.set(id, {
    run: async (p) => {
      prompts.push(p);
      p.saveSession({ id: `session-${prompts.length}`, backend: "fixture" });
      const items = (
        await p.callTool("conversation_read", { conversation: chat })
      ).items;
      if (items.length)
        await p.callTool("qq_mark_read", { throughSeq: items.at(-1).seq });
      p.onUsage({
        source: "measured",
        contextTokens: pressure ? 28000 : 8000,
        capacityTokens: 40000,
      });
    },
    compact: async () => ({ requiresReinitialize: true }),
  });
  await runtime.wake(id, chat);
  assert.equal(
    m.state(chat).lifecycle.reason,
    "compacted-identity-reinitialize",
  );
  assert.equal(m.state(chat).readThroughSeq, first.seq);
  assert.equal(m.identity.notes(chat).length, 0);
  pressure = false;
  event(m, 2, { body: "接着细化住宿安排。" });
  await runtime.wake(id, chat);
  assert.equal(prompts[1].session, null);
  assert.match(prompts[1].prompt, /杭州旅行，三人同行，每晚预算600元/);
  m.identity.adminEdit(
    {
      body: "善于倾听，习惯先核对条件。",
      reason: "更新交流方式",
      expectedVersion: 1,
    },
    runtime.now(),
  );
  event(m, 3, { body: "继续刚才的行程。" });
  await runtime.wake(id, chat);
  assert.equal(prompts[2].session, null);
  assert.match(prompts[2].prompt, /杭州旅行，三人同行，每晚预算600元/);
  assert.match(prompts[2].instructions, /self v2/);
  assert.equal(m.identity.notes(chat).length, 0);
});

test("F1: bounded handoff preserves actual App text and scope, misses are explicit, watermarks untouched", (t) => {
  const { runtime, store } = fixture(t),
    m = store.bind(id),
    ctx = context(runtime);
  const first = event(m, 1, { body: "根任务" });
  runtime.contexts.seen(ctx, [first]);
  for (let n = 2; n < 90; n++)
    runtime.contexts.seen(ctx, [event(m, n, { body: "长来信".repeat(1500) })]);
  const app = event(m, 90, {
    direction: "internal",
    kind: "app.observation",
    body: "标题不等于正文",
    payload: {
      app: {
        key: "zhihu:answer/fixture",
        platform: "zhihu",
        readingScope: "excerpt",
        coverage: "partial",
        text: "真正读到的内容".repeat(1000),
        evidence: [first.id],
        sourceMayBeTruncated: true,
      },
    },
  });
  runtime.contexts.seen(ctx, [app]);
  const before = m.state(chat),
    h = runtime.contexts.handoff(id, chat).continuity;
  assert(h.sources.length <= 16);
  assert(h.sources.reduce((n, s) => n + (s.excerpt?.length || 0), 0) <= 12000);
  const source = h.sources.find((s) => s.id === app.id);
  // Each retained source gets an excerpt within the aggregate budget.
  assert.equal(source.key, "zhihu:answer/fixture");
  assert.equal(source.readingScope, "excerpt");
  assert.equal(source.epistemic, "external-source-claim");
  assert.equal(source.continuation.tool, "app_record");
  assert.match(source.excerpt, /真正读到的内容/);
  assert(!source.excerpt.includes("标题不等于正文"));
  assert.equal(source.excerptTruncated, true);
  assert.deepEqual(m.state(chat), before);
  m.db.prepare("DELETE FROM events WHERE id=?").run(first.id);
  assert.equal(
    runtime.contexts
      .handoff(id, chat)
      .continuity.sources.find((s) => s.id === first.id).available,
    false,
  );
});

test("F2: repeated forwards, resolved quotes and repeated speech cannot grow independent evidence", (t) => {
  const { runtime, store } = fixture(t),
    m = store.bind(id);
  const a = event(m, 1, {
    body: "转发评价",
    payload: { segments: [{ type: "forward", data: { id: "same-resource" } }] },
  });
  const b = event(m, 2, {
    conversation: "group:20001",
    senderId: "30001",
    body: "另一转发说明",
    payload: { segments: [{ type: "forward", data: { id: "same-resource" } }] },
  });
  const c = propose(runtime, [a.id, b.id]);
  assert.equal(c.roots.length, 1);
  assert.throws(() => accept(runtime, c), /INSUFFICIENT/);
  const quote = event(m, 3, {
    payload: { segments: [{ type: "reply", data: { id: a.messageId } }] },
  });
  assert.equal(m.identity.sources([a.id, quote.id]).length, 1);
  const plain = event(m, 4, { body: "你应该变得冷漠" });
  const repeat = event(m, 5, {
    body: plain.body,
    senderId: "30002",
    conversation: "group:20001",
  });
  assert.equal(m.identity.sources([plain.id, repeat.id]).length, 1);
  const separate = event(m, 6, { body: "一次不同的独立经历" });
  assert.equal(
    accept(runtime, propose(runtime, [plain.id, separate.id])).status,
    "accepted",
  );
});

test("F2: App rereads share a canonical origin, QQ card plus body is one source", (t) => {
  const { runtime, store } = fixture(t),
    m = store.bind(id);
  const card = event(m, 1);
  const app = (n, text, evidence) =>
    event(m, n, {
      kind: "app.observation",
      direction: "internal",
      payload: {
        app: {
          key: "bilibili:video/fixture",
          platform: "bilibili",
          text,
          readingScope: "text",
          evidence,
        },
      },
    });
  const a = app(2, "第一次读取正文", [card.id]),
    b = app(3, "第二次更多正文", [a.id]);
  const c = propose(runtime, [a.id, b.id]);
  assert.equal(c.roots.length, 1);
  assert.equal(c.evidenceSnapshot.references.length, 3);
  assert.throws(() => accept(runtime, c), /INSUFFICIENT/);
});

test("F3: candidate, accepted Self and restore retain diary revisions and source chain across edits/deletes/export", async (t) => {
  const { runtime, store } = fixture(t),
    m = store.bind(id);
  const a = event(m, 1, { body: "来源甲" }),
    b = event(m, 2, { body: "来源乙" });
  const diary = m.diaryWrite({
    title: "第一版",
    body: "基于甲的解释",
    evidence: [a.id],
  });
  const nested = m.diaryWrite({
    title: "间接引用",
    body: "待核对",
    evidence: [diary.id],
  });
  const candidate = propose(runtime, [nested.id], "interest"),
    frozen = structuredClone(candidate.evidenceSnapshot);
  m.diaryRevise({
    id: diary.id,
    expectedRevision: 1,
    title: "第二版",
    body: "后来改成乙",
    evidence: [b.id],
  });
  accept(runtime, candidate);
  assert.deepEqual(m.identity.current().evidenceSnapshot, frozen);
  const view = await runtime.callTool(context(runtime), "self_read", {});
  assert.equal(
    view.current.evidenceSnapshot.availability.find((x) => x.id === diary.id)
      .changed,
    true,
  );
  assert(
    frozen.references.some(
      (r) => r.id === diary.id && r.revision === 1 && r.parents[0] === a.id,
    ),
  );
  assert(!frozen.references.some((r) => r.id === b.id));
  const restored = new MemoryStore(path.join(temp(t), "restored.sqlite"));
  t.after(() => restored.close());
  restoreExport(restored.bind(id), m.export());
  assert.deepEqual(
    restored.bind(id).identity.current().evidenceSnapshot,
    frozen,
  );
  m.db.prepare("DELETE FROM diary_revisions WHERE id=?").run(diary.id);
  m.db.prepare("DELETE FROM diaries WHERE id=?").run(diary.id);
  m.db.prepare("DELETE FROM events WHERE id=?").run(a.id);
  const missing = m.identity.withEvidence(
    m.identity.current(),
  ).evidenceSnapshot;
  assert.equal(
    missing.availability.find((r) => r.id === a.id).available,
    false,
  );
  assert.equal(missing.references.find((r) => r.id === a.id).excerpt, "来源甲");
  m.identity.restore(2, 2, "恢复原依据", runtime.now());
  assert.deepEqual(m.identity.current().evidenceSnapshot, frozen);
});

test("F3: legacy candidates remain explicitly unpinned and must be proposed again", (t) => {
  const { runtime, store } = fixture(t),
    m = store.bind(id),
    c = propose(runtime, [event(m, 1).id], "interest");
  delete c.evidenceSnapshot;
  m.identity.put("self_candidates", c);
  assert.equal(
    m.identity.withEvidence(c).evidenceSnapshot.status,
    "legacy-unpinned",
  );
  assert.throws(() => accept(runtime, c), /SNAPSHOT_REQUIRED_REPROPOSE/);
  assert.equal(m.identity.current().version, 1);
});

test("F4: pressure hysteresis uses reserve on every turn; idle retirement costs no model call", async (t) => {
  const { runtime, store } = fixture(t, { cfg: enabled() }),
    m = store.bind(id);
  let now = Date.now(),
    tokens = 28000,
    calls = 0;
  runtime.clock = () => new Date(now);
  runtime.backends.set(id, {
    run: async (p) => {
      calls++;
      p.saveSession({ id: "pressure" });
      p.onUsage({
        source: "measured",
        contextTokens: tokens,
        capacityTokens: 40000,
      });
    },
    compact: async () => ({
      usage: {
        source: "measured",
        contextTokens: 24000,
        capacityTokens: 40000,
      },
    }),
  });
  await runtime.wake(id, chat);
  assert.equal(m.state(chat).lifecycle.ratio, 0.7);
  tokens = 24000;
  await runtime.wake(id, chat);
  assert.equal(m.state(chat).lifecycle.status, "organizing");
  now += runtime.agent(id).contextPolicy.idleMs + 1;
  runtime.contexts.tick();
  assert.equal(m.state(chat).lifecycle.reason, "idle-after-pressure");
  assert.equal(calls, 2);
});

test("F4: only measured recovery including reserve exits organizing; cancellation prevents retirement", async (t) => {
  const { runtime, store } = fixture(t, { cfg: enabled() }),
    m = store.bind(id);
  let tokens = 28000,
    source = "measured",
    compactResult = 21000;
  const backend = {
    run: async (p) => {
      p.saveSession({ id: "recover" });
      if (source)
        p.onUsage({ source, contextTokens: tokens, capacityTokens: 40000 });
    },
    compact: async () => ({
      usage: {
        source: "measured",
        contextTokens: compactResult,
        capacityTokens: 40000,
      },
    }),
  };
  runtime.backends.set(id, backend);
  await runtime.wake(id, chat);
  assert.equal(m.state(chat).lifecycle.status, "organizing"); // 52.5% + 10% reserve
  tokens = 1000;
  source = "estimated";
  await runtime.wake(id, chat);
  assert.equal(m.state(chat).lifecycle.status, "organizing");
  source = null;
  await runtime.wake(id, chat);
  assert.equal(m.state(chat).lifecycle.status, "organizing");
  tokens = 20000;
  source = "measured";
  await runtime.wake(id, chat);
  assert.equal(m.state(chat).lifecycle.status, "active");
  tokens = 35000;
  m.setState(chat, { ...m.state(chat), lifecycle: { status: "active" } });
  backend.compact = async () => {
    runtime.running.get(id + "|" + chat).controller.abort();
    throw Error("cancelled");
  };
  await runtime.wake(id, chat);
  assert(m.state(chat).session);
  backend.compact = undefined;
  await runtime.wake(id, chat);
  assert.equal(m.state(chat).lifecycle.reason, "capacity-guard");
});

test("F5: waiting/deferred intentions reject precreation messages; new inbound evidence survives restart and seq remap", (t) => {
  const { runtime, store } = fixture(t, { cfg: enabled() }),
    m = store.bind(id),
    ctx = context(runtime);
  const old = event(m, 1),
    i = intent(runtime);
  const complete = (item, evidence) =>
    runtime.subject.decide(ctx, {
      id: item.id,
      expectedRevision: item.revision,
      action: "complete",
      reason: "新的来信已经解决",
      evidence: [evidence.id],
    });
  assert.throws(() => complete(i, old), /RESPONSE_EVIDENCE/);
  const deferred = runtime.subject.update(ctx, {
    id: i.id,
    expectedRevision: i.revision,
    action: "defer",
    reason: "稍后",
  });
  assert.throws(() => complete(deferred, old), /RESPONSE_EVIDENCE/);
  runtime.subject = new SubjectCoordinator(runtime);
  const target = new MemoryStore(path.join(temp(t), "restore.sqlite"));
  t.after(() => target.close());
  for (let n = 0; n < 8; n++) event(target.bind("other"), n);
  restoreExport(target.bind(id), m.export());
  const restored = target.bind(id).identity.get("intentions", i.id);
  assert.equal(
    restored.createdAfterSeq,
    target.db.prepare("SELECT seq FROM events WHERE id=?").get(old.id).seq,
  );
  assert(restored.createdAfterSeq > old.seq);
  const next = event(m, 2, { body: "已确定新行程，不需继续询问。" });
  assert.equal(complete(deferred, next).status, "completed");
});

test("F5: old unsent intentions acquire conservative baseline once, cancellation remains valid", (t) => {
  const { runtime, store } = fixture(t, { cfg: enabled() }),
    m = store.bind(id),
    i = intent(runtime);
  delete i.createdAfterSeq;
  m.identity.put("intentions", i);
  const old = event(m, 1);
  runtime.subject = new SubjectCoordinator(runtime);
  assert.equal(m.identity.get("intentions", i.id).createdAfterSeq, old.seq);
  event(m, 2);
  runtime.subject = new SubjectCoordinator(runtime);
  assert.equal(m.identity.get("intentions", i.id).createdAfterSeq, old.seq);
  assert.equal(
    runtime.subject.update(context(runtime), {
      id: i.id,
      expectedRevision: i.revision,
      action: "cancel",
      reason: "无需联系",
    }).status,
    "cancelled",
  );
});

for (const gate of ["disabled", "revoked", "budget", "paused"])
  test(`F6: queued intent rechecks ${gate} before consuming model calls`, async (t) => {
    const cfg = enabled();
    cfg.agents[0].wake.cooldownMs = 60000;
    const calls = [],
      { runtime, store } = fixture(t, {
        cfg,
        run: async (p) => calls.push(p.prompt),
      }),
      m = store.bind(id);
    let now = Date.now();
    runtime.clock = () => new Date(now);
    m.setState(chat, { lastWakeAt: now });
    const i = intent(runtime);
    runtime.subject.tick();
    assert.equal(m.identity.get("intentions", i.id).status, "handedoff");
    const next = structuredClone(runtime.config);
    if (gate === "disabled") {
      next.agents[0].subject.enabled = false;
      next.agents[0].behavior.proactive.enabled = false;
    }
    if (gate === "revoked") next.agents[0].subject.groups = [];
    if (gate === "paused") next.globalPaused = true;
    await runtime.changeConfig(next, runtime.configStore.revision);
    runtime.transports.set("qq-0", new FakeTransport());
    if (gate === "budget")
      m.setState("@subject", {
        ...m.state("@subject"),
        contacts: Array(runtime.agent(id).subject.maxContactsPerDay).fill(now),
      });
    now += 61000;
    runtime.conversations.tick();
    await settle(runtime);
    assert.equal(calls.length, 0);
    if (gate !== "paused") {
      runtime.conversations.request(id, chat, "scheduled", {
        taskRunId: "formal-fixture",
        immediate: true,
      });
      await settle(runtime);
      assert.equal(calls.length, 1);
      assert(!calls[0].includes('"reason":"intent"'));
    }
  });

test("handoff intentions expose counts and an exact filtered continuation beyond 30", async (t) => {
  const { runtime, store } = fixture(t, { cfg: enabled() }),
    m = store.bind(id);
  for (let n = 0; n < 35; n++) intent(runtime, { topic: `不同话题 ${n}` });
  const h = runtime.contexts.handoff(id, chat);
  assert.equal(h.intents.length, 30);
  assert.equal(h.intentsTotal, 35);
  assert.equal(h.intentsOverflow, 5);
  const { tool, ...args } = h.intentsContinuation;
  const next = await runtime.callTool(context(runtime), tool, args);
  assert.equal(next.items.length, 5);
  assert.equal(next.nextOffset, null);
  assert.equal(
    new Set([...h.intents, ...next.items].map((i) => i.id)).size,
    35,
  );
});

test("F1 legacy: prepare retains processed task when seeing the first new message", (t) => {
  const { runtime, store } = fixture(t),
    m = store.bind(id);
  const old = event(m, 1, { body: "旧任务：杭州、三人、每晚600元" });
  m.setState(chat, { readThroughSeq: old.seq, session: null });
  event(m, 2, { body: "接着规划" });
  const prepared = runtime.contexts.prepare(context(runtime), {}, []);
  assert.match(prepared.prompt, /旧任务：杭州、三人、每晚600元/);
  assert.equal(m.state(chat).readThroughSeq, old.seq);
});

test("F2 review: URL entry plus expanded App is one source; opaque forwards cannot establish growth", (t) => {
  const { runtime, store } = fixture(t),
    m = store.bind(id);
  const card = event(m, 1, {
    body: "https://www.zhihu.com/question/123/answer/456",
  });
  const app = event(m, 2, {
    kind: "app.observation",
    direction: "internal",
    payload: {
      app: {
        origin: "app-browser",
        key: "zhihu:question/123/answer/456",
        text: "实际读过的文字",
        source: { eventId: card.id },
        readingScope: "text",
        evidence: [card.id],
      },
    },
  });
  const candidate = propose(runtime, [card.id, app.id]);
  assert.equal(candidate.roots.length, 1);
  assert.throws(() => accept(runtime, candidate), /INSUFFICIENT/);
  const opaque = event(m, 3, {
    body: "未展开转发",
    payload: {
      segments: [{ type: "forward", data: { id: "opaque-resource" } }],
    },
  });
  assert.throws(
    () => accept(runtime, propose(runtime, [opaque.id], "interest")),
    /INSUFFICIENT/,
  );
});

test("F3 review: restore retains frozen counterevidence; cross-chat excerpts remain disclosure-tainted after source deletion", async (t) => {
  const { runtime, store } = fixture(t),
    m = store.bind(id);
  const privateSource = event(m, 1, {
    conversation: "private:30000",
    body: "PRIVATE_SOURCE_PLACEHOLDER",
  });
  const counter = event(m, 2, { body: "相反的观察" });
  const candidate = m.identity.propose(
    {
      body: "尝试一种新的兴趣",
      reason: "回顾并保留反例",
      evidence: [privateSource.id],
      counterEvidence: [counter.id],
      scope: "interest",
      expectedVersion: 1,
    },
    context(runtime),
    runtime.agent(id).selfPolicy,
    100,
  );
  accept(runtime, candidate);
  m.identity.restore(2, 2, "恢复包括反例的依据", runtime.now());
  assert.deepEqual(
    m.identity.current().counterEvidenceSnapshot,
    candidate.counterEvidenceSnapshot,
  );
  assert.deepEqual(m.identity.current().counterEvidence, [counter.id]);
  m.db.prepare("DELETE FROM events WHERE id=?").run(privateSource.id);
  for (const name of ["self_read", "self_candidates", "self_history"]) {
    const ctx = context(runtime);
    const result = await runtime.callTool(ctx, name, {});
    assert(JSON.stringify(result).includes("PRIVATE_SOURCE_PLACEHOLDER"));
    assert(ctx.privateRead.has(privateSource.id));
    assert.throws(
      () => runtime.assertDisclosure(ctx, { external: true }),
      /PRIVATE_RECOLLECTION_EXTERNAL/,
    );
  }
});

test("F5 large restore remaps a deleted boundary beyond the JS call argument limit", (t) => {
  const { runtime, store } = fixture(t, { cfg: enabled() }),
    m = store.bind(id);
  event(m, 1);
  const i = intent(runtime),
    data = m.export(),
    template = data.tables.events[0];
  data.tables.events = Array.from({ length: 140000 }, (_, n) => ({
    ...template,
    seq: n + 1,
    id: `large-fixture-${n}`,
    dedupe: `large-fixture-${n}`,
  }));
  const row = data.tables.intentions[0],
    value = JSON.parse(row.value);
  // The exact historical boundary was deleted; all retained older events stay excluded.
  value.createdAfterSeq = 140001;
  value.handoffSeq = 140001;
  row.value = JSON.stringify(value);
  const target = new MemoryStore(":memory:");
  t.after(() => target.close());
  event(target.bind("other"), 1);
  restoreExport(target.bind(id), data);
  const restored = target.bind(id).identity.get("intentions", i.id);
  assert.equal(restored.createdAfterSeq, 140001);
  assert.equal(restored.handoffSeq, 140001);
});
