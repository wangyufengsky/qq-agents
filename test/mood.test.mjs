import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { fixture, config, context } from "./helpers.mjs";
import { safeToolFailure } from "../src/tools/errors.mjs";
import { createServer } from "../src/server.mjs";
import { MemoryStore } from "../src/memory/store.mjs";
import { restoreExport } from "../src/memory/migrate.mjs";
import {
  EXPORT_TABLES,
  exportDigest,
  validateExport,
} from "../src/memory/export-format.mjs";

const scope = "group:20000";
const HOUR = 3600000;
let n = 0;
const said = (m, body) =>
  m.append({
    dedupe: "e" + ++n,
    conversation: scope,
    kind: "message.received",
    body,
    senderId: "30000",
  });
const count = (text, part) => text.split(part).length - 1;

function chat(t, cfg) {
  const prompts = [];
  let write = null;
  const f = fixture(t, {
    ...(cfg ? { cfg } : {}),
    run: async (p) => {
      prompts.push(p.prompt);
      p.saveSession({ id: "s", backend: "fixture" });
      if (write) await p.callTool("mood_set", write);
      write = null;
    },
  });
  let now = Date.parse("2026-10-29T12:00:00Z");
  f.runtime.clock = () => new Date(now);
  return {
    ...f,
    m: f.store.bind("agent-0"),
    prompts,
    writeNext: (args) => (write = args),
    advance: (ms) => (now += ms),
  };
}

test("the agent writes, reads and clears its own mood, never from restricted context", async (t) => {
  const f = chat(t),
    ctx = context(f.runtime);
  const cause = said(f.m, "今天的蛋糕是你最爱的口味");
  await assert.rejects(
    f.runtime.callTool(ctx, "mood_set", { reason: "没写心情" }),
    /INVALID_MOOD/,
  );
  await assert.rejects(
    f.runtime.callTool(ctx, "mood_set", { mood: "开心", reason: "没写强度" }),
    /INVALID_MOOD/,
  );
  await assert.rejects(
    f.runtime.callTool(ctx, "mood_set", {
      mood: "开心",
      intensity: 3,
      reason: "太久了",
      hours: 48,
    }),
  );
  const happy = await f.runtime.callTool(ctx, "mood_set", {
    mood: "开心",
    intensity: 3,
    reason: "群友带了我最爱的蛋糕",
    evidence: [cause.id],
  });
  assert.equal(happy.action, "set");
  assert.equal(happy.expiresAt - happy.since, 4 * HOUR);
  assert.equal(happy.writtenIn, scope);
  const read = await f.runtime.callTool(ctx, "mood_read", {});
  assert.equal(read.current.mood, "开心");
  const calm = await f.runtime.callTool(ctx, "mood_set", {
    clear: true,
    reason: "吃完蛋糕，回到平常",
  });
  assert.equal(calm.previousId, happy.id);
  const after = await f.runtime.callTool(ctx, "mood_read", {});
  assert.equal(after.current, null);
  assert.deepEqual(
    after.recent.map((x) => x.action),
    ["clear", "set"],
  );

  const tainted = context(f.runtime);
  tainted.privateRead.add("operations:fixture");
  await assert.rejects(
    f.runtime.callTool(tainted, "mood_set", {
      mood: "烦",
      intensity: 2,
      reason: "不该进共享心情",
    }),
    /RESTRICTED_CONTEXT_MIND_WRITE_BLOCKED/,
  );
});

test("a strong mood in effect changes only for something that happened after it", async (t) => {
  const f = chat(t),
    ctx = context(f.runtime),
    set = (args) => f.runtime.callTool(ctx, "mood_set", args);
  const late = said(f.m, "我晚点到，你们先开始");
  const angry = await set({
    mood: "非常生气",
    intensity: 5,
    reason: "主人又放我鸽子",
    evidence: [late.id],
  });
  // Feeling better out of nowhere does not flip it.
  await assert.rejects(
    set({ mood: "开心", intensity: 3, reason: "想开了" }),
    /MOOD_CHANGE_NEEDS_CAUSE/,
  );
  // What happened before the mood is not a new cause, for clearing either.
  await assert.rejects(
    set({ clear: true, reason: "算了", evidence: [late.id] }),
    /MOOD_CHANGE_NEEDS_CAUSE/,
  );
  assert.match(
    safeToolFailure(Error("MOOD_CHANGE_NEEDS_CAUSE")).hint,
    /happened after it was written/,
  );
  // Being comforted afterwards is.
  const sorry = said(f.m, "对不起，给你买了奶茶");
  const better = await set({
    mood: "消气了一点",
    intensity: 2,
    reason: "主人道歉还买了奶茶",
    evidence: [sorry.id],
  });
  assert.equal(better.previousId, angry.id);
  // A mild mood changes freely; a strong one that expired needs no cause.
  await set({ mood: "超级兴奋", intensity: 5, reason: "抢到门票", hours: 1 });
  f.advance(HOUR + 1);
  const calm = await set({
    mood: "平静",
    intensity: 1,
    reason: "兴奋劲过去了",
  });
  assert.equal(calm.mood, "平静");
});

test("a strong mood can settle on the agent's own idle time without anyone coaxing it", async (t) => {
  const cfg = config(1);
  Object.assign(cfg.agents[0].subject, { enabled: true, groups: ["20000"] });
  const f = chat(t, cfg);
  const rude = said(f.m, "你别说话了");
  await f.runtime.callTool(context(f.runtime), "mood_set", {
    mood: "很受伤",
    intensity: 4,
    reason: "被人叫我闭嘴",
    evidence: [rude.id],
  });
  f.advance(HOUR);
  const idle = context(f.runtime, "agent-0", "@subject");
  // No one apologised; the agent went and did something else, then thought it over.
  const log = await f.runtime.callTool(idle, "subject_log", {
    did: "read",
    summary: "读了会儿鲸类睡眠的论文，回头想了想，那句话是冲着刷屏说的",
  });
  const settled = await f.runtime.callTool(idle, "mood_set", {
    clear: true,
    reason: "缓过来了，那句话不是冲我这个人",
    evidence: [log.id],
  });
  assert.equal(settled.action, "clear");
});

test("a mood reaches each session once while it lasts, with what it changed from", async (t) => {
  const cfg = config(1);
  cfg.agents[0].contextPolicy.capacityTokens = 131072;
  const f = chat(t, cfg);
  f.m.identity.setMood(
    { mood: "有点委屈", intensity: 2, reason: "主人在私聊里凶了我", hours: 2 },
    { writtenIn: "private:30000", now: f.runtime.now() },
  );
  said(f.m, "在吗");
  await f.runtime.wake("agent-0", scope);
  assert.equal(count(f.prompts[0], "有点委屈"), 1);
  assert.match(f.prompts[0], /主人在私聊里凶了我/);
  assert.match(f.prompts[0], /"intensity":2/);
  assert.match(f.prompts[0], /"writtenIn":"private:30000"/);

  said(f.m, "还在吗");
  await f.runtime.wake("agent-0", scope);
  assert.doesNotMatch(f.prompts[1], /你此刻的心情/, "seen this session");

  // A mood the agent writes in this session is not echoed back.
  f.writeNext({ mood: "好多了", intensity: 1, reason: "群友安慰了我" });
  said(f.m, "别难过");
  await f.runtime.wake("agent-0", scope);
  said(f.m, "嗯嗯");
  await f.runtime.wake("agent-0", scope);
  assert.doesNotMatch(f.prompts[3], /好多了/);

  // A new session sees the mood together with the one it changed from.
  f.runtime.contexts.retire("agent-0", scope, "test");
  said(f.m, "换个会话");
  await f.runtime.wake("agent-0", scope);
  assert.match(f.prompts[4], /好多了/);
  assert.match(
    f.prompts[4],
    /"changedFrom":\{"mood":"有点委屈","intensity":2,"reason":"主人在私聊里凶了我"\}/,
  );

  // When the agent clears it elsewhere, a session that saw it hears once.
  f.m.identity.setMood(
    { clear: true, reason: "睡了一觉，心情平复了" },
    { writtenIn: "@subject", now: f.runtime.now() },
  );
  said(f.m, "早");
  await f.runtime.wake("agent-0", scope);
  assert.match(f.prompts[5], /心情已经过去/);
  assert.match(f.prompts[5], /睡了一觉，心情平复了/);
  assert.match(f.prompts[5], /"was":\{"mood":"好多了"/);
  said(f.m, "早上好");
  await f.runtime.wake("agent-0", scope);
  assert.doesNotMatch(f.prompts[6], /心情/);

  // An expired mood is no longer shown, even to a new session.
  f.m.identity.setMood(
    { mood: "兴奋", intensity: 3, reason: "要去看演唱会", hours: 1 },
    { writtenIn: scope, now: f.runtime.now() },
  );
  f.advance(HOUR + 1);
  f.runtime.contexts.retire("agent-0", scope, "test");
  said(f.m, "演唱会怎么样");
  await f.runtime.wake("agent-0", scope);
  assert.doesNotMatch(f.prompts[7], /兴奋/);
});

test("free time carries the mood too", async (t) => {
  const cfg = config(1);
  Object.assign(cfg.agents[0].subject, {
    enabled: true,
    groups: ["20000"],
    intervalMs: 60000,
  });
  const f = chat(t, cfg);
  f.m.identity.setMood(
    { mood: "无聊", intensity: 2, reason: "群里一下午没人说话" },
    { writtenIn: scope, now: f.runtime.now() },
  );
  await f.runtime.wake("agent-0", "@subject");
  assert.match(f.prompts[0], /你此刻的心情[\s\S]*无聊/);
});

test("the console shows the mood history and cannot change it", async (t) => {
  const f = chat(t);
  f.m.identity.setMood(
    { mood: "开心", intensity: 3, reason: "收到礼物" },
    { writtenIn: scope, now: f.runtime.now() },
  );
  f.m.identity.setMood(
    { mood: "紧张", intensity: 3, reason: "明天要考试" },
    { writtenIn: "private:30000", now: f.runtime.now() },
  );
  const token = randomBytes(32).toString("hex"),
    app = createServer({ runtime: f.runtime, token });
  const port = await app.listen();
  t.after(() => app.close());
  const mind = await (
    await fetch(`http://127.0.0.1:${port}/api/mind?agentId=agent-0`, {
      headers: { "x-admin-token": token },
    })
  ).json();
  assert.equal(mind.mood.current.mood, "紧张");
  assert.deepEqual(
    mind.mood.history.map((x) => x.mood),
    ["紧张", "开心"],
  );
  const change = await fetch(`http://127.0.0.1:${port}/api/mood`, {
    method: "POST",
    headers: { "x-admin-token": token },
    body: JSON.stringify({ agentId: "agent-0", clear: true, reason: "x" }),
  });
  assert.equal(change.ok, false);
  assert.equal(f.m.identity.currentMood(f.runtime.now()).mood, "紧张");
});

test("moods travel with an export, and earlier exports without them still restore", (t) => {
  const source = new MemoryStore(":memory:"),
    memory = source.bind("agent-a");
  t.after(() => source.close());
  memory.identity.setMood(
    { mood: "开心", intensity: 3, reason: "导出前的心情" },
    { writtenIn: scope, now: 1 },
  );
  const sign = (tables) => {
    const data = {
      version: 2,
      agentId: "agent-a",
      exportedAt: new Date(0).toISOString(),
      tables,
    };
    const digest = exportDigest(data),
      counts = {};
    for (const name of EXPORT_TABLES.filter((x) => x in tables)) {
      digest.update(name + "\n");
      for (const row of tables[name]) digest.update(JSON.stringify(row) + "\n");
      counts[name] = tables[name].length;
    }
    return {
      ...data,
      manifest: { algorithm: "sha256", counts, sha256: digest.digest("hex") },
    };
  };
  const tables = memory.export().tables;
  const target = new MemoryStore(":memory:");
  t.after(() => target.close());
  restoreExport(target.bind("agent-a"), sign(tables));
  assert.equal(
    target.bind("agent-a").identity.moodHistory()[0].reason,
    "导出前的心情",
  );
  const { moods: _m, person_notes: _p, ...before } = tables;
  validateExport(sign(before));
});

test("restoring keeps mood order and the strong-mood boundary", (t) => {
  const source = new MemoryStore(":memory:"),
    a = source.bind("agent-a");
  t.after(() => source.close());
  const old = a.append({
    dedupe: "old",
    conversation: scope,
    kind: "message.received",
    body: "放鸽子",
    senderId: "30000",
  });
  for (const [i, mood] of ["开心", "平静", "紧张", "无聊", "困"].entries())
    a.identity.setMood(
      { mood, intensity: 2, reason: "第" + i + "次" },
      { writtenIn: scope, now: 1000 + i },
    );
  a.identity.setMood(
    {
      mood: "非常生气",
      intensity: 5,
      reason: "又被放鸽子",
      evidence: [old.id],
    },
    { writtenIn: scope, now: 2000 },
  );
  const expected = a.identity.moodHistory().map((x) => x.mood);
  assert.deepEqual(
    a.export().tables.moods.map((r) => JSON.parse(r.value).mood),
    [...expected].reverse(),
    "exported oldest first, as written",
  );
  // Restore beside another agent, so every event gets a new seq.
  const target = new MemoryStore(":memory:");
  t.after(() => target.close());
  const b = target.bind("agent-b");
  for (let i = 0; i < 5; i++)
    b.append({
      dedupe: "b" + i,
      conversation: scope,
      kind: "message.received",
      body: "别的角色",
      senderId: "30000",
    });
  const { moods, ...rest } = a.export().tables;
  restoreExport(target.bind("agent-a"), {
    version: 1,
    agentId: "agent-a",
    tables: { ...rest, moods },
  });
  const restored = target.bind("agent-a");
  assert.deepEqual(
    restored.identity.moodHistory().map((x) => x.mood),
    expected,
  );
  assert.equal(restored.identity.currentMood(3000).mood, "非常生气");
  // The message from before the mood is still not a new cause.
  assert.throws(
    () =>
      restored.identity.setMood(
        { clear: true, reason: "算了", evidence: [old.id] },
        { writtenIn: scope, now: 3000 },
      ),
    /MOOD_CHANGE_NEEDS_CAUSE/,
  );
  const sorry = restored.append({
    dedupe: "sorry",
    conversation: scope,
    kind: "message.received",
    body: "对不起",
    senderId: "30000",
  });
  restored.identity.setMood(
    { clear: true, reason: "道歉了", evidence: [sorry.id] },
    { writtenIn: scope, now: 3000 },
  );
});
