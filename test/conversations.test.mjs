import test from "node:test";
import assert from "node:assert/strict";
import { fixture, config, context, raw, settle } from "./helpers.mjs";
import { TOOL_NAMES } from "../src/tools/index.mjs";

function cfg() {
  const c = config(1);
  c.agents[0].tools = TOOL_NAMES;
  return c;
}
test("sleep requires a real observation window and sending resets it", async (t) => {
  const c = cfg();
  c.agents[0].behavior.preSleepWaitMs = 15;
  const f = fixture(t, { cfg: c }),
    ctx = context(f.runtime);
  await assert.rejects(
    f.runtime.callTool(ctx, "qq_set_wake_config", { infinite: true }),
    /PRE_SLEEP/,
  );
  const r = await f.runtime.callTool(ctx, "qq_wait_for_messages", {
    timeoutMs: 25,
  });
  assert.equal(r.reason, "timeout");
  await f.runtime.callTool(ctx, "qq_set_wake_config", { sleepMs: 1000 });
  await f.runtime.send(ctx, { requestId: "reset-observation", text: "你好" });
  await assert.rejects(
    f.runtime.callTool(ctx, "qq_set_wake_config", { infinite: true }),
    /PRE_SLEEP/,
  );
});
test("pause aborts a long wait immediately without a QQ send", async (t) => {
  const f = fixture(t, { cfg: cfg() }),
    ctx = context(f.runtime);
  const promise = f.runtime.callTool(ctx, "qq_wait_for_messages", {
    timeoutMs: 600000,
  });
  const rejected = assert.rejects(promise, /PAUSED/);
  await f.runtime.pause("agent-0", true);
  await rejected;
  assert.equal(f.runtime.transports.get("qq-0").sent.length, 0);
});
test("new messages wait for quiet time and return real safe read watermark", async (t) => {
  const c = cfg();
  c.agents[0].behavior.quietAfterNewMs = 10;
  const f = fixture(t, { cfg: c }),
    ctx = context(f.runtime),
    mem = f.store.bind("agent-0");
  const promise = f.runtime.callTool(ctx, "qq_wait_for_messages", {
    timeoutMs: 1000,
    quietMs: 0,
  });
  const saved = mem.append({
    dedupe: "waiting",
    conversation: ctx.conversation,
    kind: "message.received",
    body: "然后，",
  });
  mem.setState(ctx.conversation, { lastReceivedSeq: saved.seq });
  f.runtime.conversations.notify("agent-0", ctx.conversation);
  const r = await promise;
  assert.equal(r.reason, "messages");
  assert.equal(r.newMessages.items[0].body, "然后，");
  assert.equal(ctx.shownSeq, saved.seq);
  assert.equal(r.unfinished, true);
  await f.runtime.callTool(ctx, "qq_mark_read", {
    throughSeq: r.newMessages.readThroughSeq,
  });
});
test("two long polls for the same conversation are rejected", async (t) => {
  const f = fixture(t, { cfg: cfg() }),
    ctx = context(f.runtime);
  const one = f.runtime.callTool(ctx, "qq_wait_for_messages", {
    timeoutMs: 30,
  });
  await assert.rejects(
    f.runtime.callTool(ctx, "qq_wait_for_messages", { timeoutMs: 30 }),
    /ALREADY_WAITING/,
  );
  await one;
});
test("batch window upgrades wake priority and persists a single merged wake", async (t) => {
  const c = cfg();
  c.agents[0].behavior.batchWindowMs = 1000;
  let now = Date.parse("2026-10-25T04:00:00Z"),
    prompts = [];
  const f = fixture(t, { cfg: c, run: async (p) => prompts.push(p.prompt) });
  f.runtime.clock = () => new Date(now);
  await f.runtime.ingest("qq-0", raw(1));
  await f.runtime.ingest(
    "qq-0",
    raw(2, { message: [{ type: "at", data: { qq: "10000" } }] }),
  );
  assert.equal(prompts.length, 0);
  now += 1001;
  f.runtime.tick();
  await settle(f.runtime);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /"reason":"mention"/);
});
test("finite sleeping timers survive state restoration and wait through a pause", async (t) => {
  const c = cfg();
  let now = Date.parse("2026-10-25T04:00:00Z"),
    calls = 0;
  const f = fixture(t, { cfg: c, run: async () => calls++ });
  f.runtime.clock = () => new Date(now);
  f.store.bind("agent-0").setState("group:20000", {
    wakeConfig: { sleepUntil: now + 1000, infinite: false },
  });
  await f.runtime.pause("agent-0", true);
  now += 2000;
  f.runtime.tick();
  assert.equal(calls, 0);
  await f.runtime.pause("agent-0", false);
  f.runtime.tick();
  await settle(f.runtime);
  assert.equal(calls, 1);
  f.runtime.tick();
  await settle(f.runtime);
  assert.equal(calls, 1);
});
test("busy conversation retains a timer wake even after messages were marked read", async (t) => {
  const c = cfg();
  let release,
    calls = 0,
    now = Date.parse("2026-10-25T04:00:00Z");
  const f = fixture(t, {
    cfg: c,
    run: async () => {
      calls++;
      if (calls === 1) await new Promise((r) => (release = r));
    },
  });
  f.runtime.clock = () => new Date(now);
  const first = f.runtime.wake("agent-0", "group:20000");
  f.store.bind("agent-0").setState("group:20000", {
    readThroughSeq: 999,
    wakeConfig: { sleepUntil: now - 1 },
  });
  f.runtime.tick();
  assert.equal(calls, 1);
  release();
  await first;
  await settle(f.runtime);
  assert.equal(calls, 2);
});
test("scheduled silence suppresses wake, then resumes the queued mention once", async (t) => {
  const c = cfg();
  c.agents[0].silence = [
    { start: "12:00", end: "13:00", days: [0], timezone: "UTC" },
  ];
  let now = Date.parse("2026-10-25T12:30:00Z"),
    calls = 0;
  const f = fixture(t, { cfg: c, run: async () => calls++ });
  f.runtime.clock = () => new Date(now);
  await f.runtime.ingest("qq-0", raw(1));
  f.runtime.tick();
  assert.equal(calls, 0);
  now = Date.parse("2026-10-25T13:01:00Z");
  f.runtime.tick();
  await settle(f.runtime);
  assert.equal(calls, 1);
});
test("legacy proactive enable maps to one subject opportunity, with active gates", async (t) => {
  const c = cfg();
  c.agents[0].subject.intervalMs = 60000;
  Object.assign(c.agents[0].behavior.proactive, {
    enabled: true,
    minMs: 60000,
    maxMs: 60000,
    idleMs: 0,
    probability: 1,
    nightFactor: 1,
  });
  let now = Date.parse("2026-10-25T04:00:00Z"),
    calls = 0;
  const f = fixture(t, { cfg: c, run: async () => calls++ });
  f.runtime.clock = () => new Date(now);
  f.runtime.random = () => 0;
  f.store
    .bind("agent-0")
    .setState("group:20000", { lastIncomingAt: now - 1000 });
  f.runtime.tick();
  assert.equal(calls, 0);
  now += 60001;
  f.runtime.tick();
  await settle(f.runtime);
  assert.equal(calls, 1);
  await f.runtime.pause("all", true);
  now += 60001;
  f.runtime.tick();
  assert.equal(calls, 1);
});
test("wake rate limit queues rather than discarding a direct message", async (t) => {
  const c = cfg();
  c.agents[0].behavior.maxWakePerMinute = 1;
  let now = Date.parse("2026-10-25T04:00:00Z"),
    calls = 0;
  const f = fixture(t, { cfg: c, run: async () => calls++ });
  f.runtime.clock = () => new Date(now);
  await f.runtime.ingest("qq-0", raw(1));
  await settle(f.runtime);
  await f.runtime.ingest("qq-0", raw(2));
  await settle(f.runtime);
  assert.equal(calls, 1);
  now += 60001;
  f.runtime.tick();
  await settle(f.runtime);
  assert.equal(calls, 2);
});
