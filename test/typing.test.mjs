import test from "node:test";
import assert from "node:assert/strict";
import { fixture, config, context } from "./helpers.mjs";
import { behaviorSchema } from "../src/core/policy.mjs";
import { typingDelay, burstDelay } from "../src/core/typing.mjs";

const defaults = behaviorSchema.parse({});
const mid = () => 0.5;
const flush = async () => {
  for (let i = 0; i < 3; i++)
    await new Promise((resolve) => setImmediate(resolve));
};
function setup(t, typing = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const cfg = config(1);
  cfg.agents[0].behavior.typing = {
    ...defaults.typing,
    msPerChar: 100,
    jitter: 0,
    minMs: 0,
    ...typing,
  };
  cfg.agents[0].behavior.longGapProbability = 0;
  cfg.agents[0].tools.push("qq_send_burst", "qq_send_voice");
  const f = fixture(t, { cfg });
  f.runtime.random = mid;
  const ctx = context(f.runtime);
  const sent = () => f.runtime.transports.get("qq-0").sent.length;
  return { ...f, ctx, sent };
}
test("typing defaults fill old configuration, retain explicit values and reject invalid bounds", () => {
  assert.deepEqual(defaults.typing, {
    enabled: true,
    indicator: true,
    msPerChar: 180,
    jitter: 0.35,
    minMs: 600,
    maxMs: 12000,
    firstReply: true,
    firstReplyMaxMs: 6000,
  });
  assert.equal(
    behaviorSchema.parse({ typing: { enabled: false, msPerChar: 42 } }).typing
      .msPerChar,
    42,
  );
  for (const typing of [
    { minMs: 10, maxMs: 9 },
    { jitter: 1.1 },
    { firstReplyMaxMs: -1 },
    { unknown: true },
  ])
    assert.throws(() => behaviorSchema.parse({ typing }));
});

test("typing delay grows with visible length, counts rich items once and clamps after jitter", () => {
  const typing = { ...defaults.typing, minMs: 0, jitter: 0 };
  assert.equal(typingDelay("你好", typing, mid), 360);
  assert.equal(typingDelay("你好呀", typing, mid), 540);
  for (const text of [
    "😀",
    "👩🏽‍💻",
    "👨‍👩‍👧‍👦",
    "https://example.com/long/path",
    "[标题](https://example.com)",
    "![图片](https://example.com/a.png)",
    "[CQ:face,id=14]",
    "[QQ表情：微笑]",
    "[图片]",
    "**字**",
  ])
    assert.equal(typingDelay(text, typing, mid), 180, text);
  assert.equal(
    typingDelay("a", defaults.typing, () => 0),
    600,
  );
  assert.equal(
    typingDelay("a".repeat(200), defaults.typing, () => 1),
    12000,
  );
  assert.equal(
    typingDelay("a".repeat(10), defaults.typing, () => 0),
    1170,
  );
  assert.equal(
    typingDelay("a".repeat(10), defaults.typing, () => 1),
    2430,
  );
});

test("burst adds a long pause to typing, honors explicit gap and preserves disabled random algorithm", () => {
  const b = {
    ...defaults,
    typing: { ...defaults.typing, jitter: 0, minMs: 0 },
  };
  assert.equal(
    burstDelay("你好", b, () => 0, undefined),
    8360,
  );
  assert.equal(burstDelay("你好", b, mid, undefined), 360);
  assert.equal(
    burstDelay(
      "长".repeat(100),
      b,
      () => {
        throw Error("RANDOM_NOT_NEEDED");
      },
      17,
    ),
    17,
  );
  b.typing.enabled = false;
  assert.equal(
    burstDelay("你好", b, () => 0, undefined),
    8000,
  );
  assert.equal(burstDelay("长".repeat(100), b, mid, undefined), 2000);
});

for (const firstReplyMaxMs of [0, 100, 6000])
  test(
    "first reply enters the queue without waiting at any old limit: " +
      firstReplyMaxMs,
    async (t) => {
      const f = setup(t, { firstReplyMaxMs });
      const args = { requestId: "first", text: "首条".repeat(60) };
      assert.equal((await f.runtime.send(f.ctx, args)).status, "sent");
      assert.equal(
        (await f.runtime.send(context(f.runtime), args)).duplicate,
        true,
      );
      assert.equal(f.sent(), 1);
    },
  );

for (const separateContexts of [false, true])
  for (const limit of [1, 5])
    test(`same-chat sends preserve order and shared quota: contexts=${separateContexts}, limit=${limit}`, async (t) => {
      const f = setup(t);
      f.runtime.agent("agent-0").maxConsecutiveSends = limit;
      const first = f.runtime.send(f.ctx, {
        requestId: "first",
        text: "长".repeat(60),
      });
      const second = f.runtime.send(
        separateContexts ? context(f.runtime) : f.ctx,
        { requestId: "second", text: "短" },
      );
      if (limit === 1) await assert.rejects(second, /REPLY_BURST_LIMIT/);
      else assert.equal((await second).status, "sent");
      assert.equal((await first).status, "sent");
      const sent = f.runtime.transports.get("qq-0").sent;
      assert.equal(sent.length, limit === 1 ? 1 : 2);
      assert.equal(sent[0].segments[0].data.text, "长".repeat(60));
    });

test("unready voice stays in the drain without holding other conversations", async (t) => {
  const f = setup(t);
  const segment = Promise.withResolvers();
  f.runtime.voices = {
    metadata: () => ({ id: "voice-fixture", title: "语音", sources: [] }),
    segment: () => segment.promise,
  };
  const voice = f.runtime.callTool(f.ctx, "qq_send_voice", {
    requestId: "voice-wait",
    audioId: "voice-fixture",
  });
  const other = context(f.runtime, "agent-0", "group:20001");
  assert.equal(
    (await f.runtime.send(other, { requestId: "ready", text: "短" })).status,
    "sent",
  );
  assert.equal(f.ctx.pendingDeliveries, 1);
  assert.equal(f.runtime.maintenance.begin().pending, 1);
  assert.equal(f.store.bind("agent-0").delivery("voice-wait"), undefined);
  segment.resolve({ type: "record", data: { file: "fixture" } });
  assert.equal((await voice).status, "sent");
  await f.runtime.maintenance.wait();
  assert.equal(f.runtime.maintenance.snapshot().pending, 0);
});

test("an in-flight send returns exactly one gateway receipt to concurrent same-ID requests", async (t) => {
  const f = setup(t);
  const gateway = Promise.withResolvers();
  let calls = 0;
  f.runtime.transports.get("qq-0").send = () => {
    calls++;
    return gateway.promise;
  };
  const args = { requestId: "in-flight", text: "你好" };
  const first = f.runtime.send(f.ctx, args);
  const retry = f.runtime.send(context(f.runtime), args);
  await flush();
  assert.equal(calls, 1);
  gateway.resolve({ messageId: "10000" });
  assert.equal((await first).status, "sent");
  assert.equal((await retry).duplicate, true);
  assert.equal(calls, 1);
});

test("a queued delivery rechecks recovery and hot-updated quotas before reserving", async (t) => {
  const f = setup(t);
  const gateway = Promise.withResolvers();
  f.runtime.transports.get("qq-0").send = () => gateway.promise;
  const other = context(f.runtime, "agent-0", "group:20001");
  const first = f.runtime.send(other, {
    requestId: "blocking",
    text: "先发送",
  });
  const pending = f.runtime.send(f.ctx, {
    requestId: "recovery",
    text: "等待发送",
  });
  const rejected = assert.rejects(pending, /RECOVERY_DELIVERY_BLOCKED/);
  const third = f.runtime.send(context(f.runtime), {
    requestId: "quota",
    text: "等待额度",
  });
  const limited = assert.rejects(third, /SEND_RATE_LIMIT/);
  f.ctx.recoveryDeliveryBlocked = true;
  const next = structuredClone(f.runtime.config);
  next.agents[0].behavior.maxSendPerMinute = 1;
  await f.runtime.changeConfig(next, f.configStore.revision);
  gateway.resolve({ messageId: "10000" });
  assert.equal((await first).status, "sent");
  await Promise.all([rejected, limited]);
  const memory = f.store.bind("agent-0");
  assert.equal(memory.delivery("recovery"), undefined);
  assert.equal(memory.delivery("quota"), undefined);
});

test("burst gaps depend on the next item and explicit gapMs overrides them", async (t) => {
  const f = setup(t);
  const agent = f.runtime.agent("agent-0");
  agent.maxConsecutiveSends = 6;
  agent.behavior.maxSendPerMinute = 6;
  const p = f.runtime.callTool(f.ctx, "qq_send_burst", {
    requestId: "burst",
    messages: ["一", "二二", "三三三"],
  });
  await flush();
  assert.equal(f.sent(), 1);
  t.mock.timers.tick(199);
  await flush();
  assert.equal(f.sent(), 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(f.sent(), 2);
  t.mock.timers.tick(300);
  assert.equal((await p).receipts.length, 3);
  const q = f.runtime.callTool(f.ctx, "qq_send_burst", {
    requestId: "explicit",
    messages: ["一", "很长".repeat(50)],
    gapMs: 7,
  });
  await flush();
  assert.equal(f.sent(), 4);
  t.mock.timers.tick(7);
  assert.equal((await q).status, "sent");
  assert.equal(f.sent(), 5);
});

test("internal deliveries skip burst typing waits", async (t) => {
  const f = setup(t);
  f.ctx.internalDelivery = true;
  await f.runtime.callTool(f.ctx, "qq_send_burst", {
    requestId: "fixed-burst",
    messages: ["固定一", "固定二"],
  });
  assert.equal(f.sent(), 2);
});

test("burst review stops between items and preserves the confirmed prefix", async (t) => {
  const f = setup(t);
  const p = f.runtime.callTool(f.ctx, "qq_send_burst", {
    requestId: "long-burst",
    messages: ["一", "二".repeat(40), "三".repeat(40)],
  });
  await flush();
  f.store.bind("agent-0").append({
    dedupe: "burst-new-input",
    conversation: f.ctx.conversation,
    connectionId: "qq-0",
    kind: "message.received",
    senderId: "30000",
    body: "条件写错了，先别发",
    payload: { trustedInput: true },
  });
  t.mock.timers.tick(4000);
  await flush();
  assert.equal(f.sent(), 1);
  const result = await p;
  assert.equal(result.error, "INPUT_REVIEW_REQUIRED");
  assert.deepEqual(
    result.draft.items.map(({ status }) => status),
    ["sent", "unsubmitted", "unsubmitted"],
  );
  const m = f.store.bind("agent-0");
  assert.equal(m.delivery("long-burst:0").status, "sent");
  assert.equal(m.delivery("long-burst:1"), undefined);
  assert.equal(m.delivery("long-burst:2"), undefined);
});

test("tone review reserves nothing and exact confirmation retains duplicate receipts", async (t) => {
  const f = setup(t);
  const args = { requestId: "tone-review", text: "总结一下" };
  await assert.rejects(f.runtime.send(f.ctx, args), /TONE_REVIEW_SUGGESTED/);
  assert.equal(f.store.bind("agent-0").delivery(args.requestId), undefined);
  assert.equal((await f.runtime.send(f.ctx, args)).status, "sent");
  assert.equal((await f.runtime.send(f.ctx, args)).duplicate, true);
  assert.equal(f.sent(), 1);
});
