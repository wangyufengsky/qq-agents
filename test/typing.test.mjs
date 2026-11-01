import test from "node:test";
import assert from "node:assert/strict";
import { fixture, config, context } from "./helpers.mjs";
import { behaviorSchema } from "../src/core/policy.mjs";
import { typingDelay, burstDelay } from "../src/core/typing.mjs";
import { knownErrorCodes } from "../src/core/error-codes.mjs";
import { safeToolFailure } from "../src/tools/errors.mjs";
import { transcriptKey } from "../src/memory/store.mjs";

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
function receive(
  f,
  body,
  {
    senderId = "30000",
    trustedInput = true,
    kind = "message.received",
    conversation = f.ctx.conversation,
    origin = "live",
    dedupe = "new-input",
  } = {},
) {
  return f.store.bind("agent-0").append({
    dedupe,
    conversation,
    connectionId: "qq-0",
    kind,
    direction: "in",
    origin,
    status: "observed",
    senderId,
    body,
    payload: { trustedInput },
  });
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

test("first reply waits inside delivery drain; confirmed duplicate and later sends do not wait", async (t) => {
  const f = setup(t, { firstReplyMaxMs: 300 });
  const p = f.runtime.send(f.ctx, { requestId: "first", text: "你好你好你好" });
  await flush();
  assert.equal(f.ctx.pendingDeliveries, 1);
  assert.equal(f.runtime.sendChains.size, 1);
  assert.equal(f.store.bind("agent-0").delivery("first"), undefined);
  t.mock.timers.tick(299);
  await flush();
  assert.equal(f.sent(), 0);
  t.mock.timers.tick(1);
  assert.equal((await p).status, "sent");
  assert.equal(f.ctx.pendingDeliveries, 0);
  const retry = context(f.runtime);
  assert.equal(
    (await f.runtime.send(retry, { requestId: "first", text: "你好你好你好" }))
      .duplicate,
    true,
  );
  await f.runtime.send(f.ctx, { requestId: "next", text: "不用首条等待" });
  assert.equal(f.sent(), 2);
});

test("parallel sends finish typing before entering the connection queue", async (t) => {
  const f = setup(t);
  const ps = ["one", "two"].map((requestId) =>
    f.runtime.send(f.ctx, { requestId, text: "你好" }),
  );
  await flush();
  t.mock.timers.tick(200);
  await Promise.all(ps);
  assert.equal(f.sent(), 2);
});

for (const conversation of ["group:20001", "private:30000"])
  test(
    "typing in one chat does not block another chat: " + conversation,
    async (t) => {
      const f = setup(t);
      const slow = f.runtime.send(f.ctx, {
        requestId: "slow-chat",
        text: "长".repeat(60),
      });
      const other = context(f.runtime, "agent-0", conversation);
      const fast = f.runtime.send(other, {
        requestId: "fast-chat",
        text: "短",
      });
      await flush();
      t.mock.timers.tick(100);
      await flush();
      const mem = f.store.bind("agent-0");
      assert.equal(mem.delivery("fast-chat")?.status, "sent");
      assert.equal(mem.delivery("slow-chat"), undefined);
      assert.equal((await fast).status, "sent");
      assert.equal(f.runtime.sendChains.size, 1);
      assert.equal(f.runtime.maintenance.begin().pending, 1);
      t.mock.timers.tick(5900);
      assert.equal((await slow).status, "sent");
      await flush();
      assert.equal(f.runtime.sendChains.size, 0);
      assert.equal(f.runtime.maintenance.snapshot().pending, 0);
    },
  );

test("voice typing does not block actions and ready sends remain serialized", async (t) => {
  const f = setup(t);
  f.runtime.voices = {
    metadata: () => ({ id: "voice-fixture", title: "语音", sources: [] }),
    segment: async () => ({ type: "record", data: { file: "fixture" } }),
  };
  const voice = f.runtime.callTool(f.ctx, "qq_send_voice", {
    requestId: "voice-wait",
    audioId: "voice-fixture",
  });
  await flush();
  const other = context(f.runtime, "agent-0", "group:20001");
  const actionReceipt = Promise.withResolvers();
  let actionStarted = false;
  const action = f.runtime.deliver(other, {
    requestId: "other-action",
    intent: { kind: "fixture-action" },
    action: true,
    send: () => {
      actionStarted = true;
      return actionReceipt.promise;
    },
  });
  await flush();
  assert.equal(actionStarted, true);
  t.mock.timers.tick(2000);
  await flush();
  assert.equal(f.sent(), 0);
  assert.equal(f.store.bind("agent-0").delivery("voice-wait"), undefined);
  actionReceipt.resolve({ confirmed: true });
  assert.equal((await action).actionConfirmed, true);
  assert.equal((await voice).status, "sent");
  assert.equal(f.sent(), 1);
});

test("a retry during network delivery waits for the queued receipt without typing again", async (t) => {
  const f = setup(t);
  const gateway = Promise.withResolvers();
  let calls = 0;
  f.runtime.transports.get("qq-0").send = () => {
    calls++;
    return gateway.promise;
  };
  const args = { requestId: "in-flight", text: "你好" };
  const first = f.runtime.send(f.ctx, args);
  await flush();
  t.mock.timers.tick(200);
  await flush();
  assert.equal(calls, 1);
  const retry = f.runtime.send(context(f.runtime), args);
  await flush();
  gateway.resolve({ messageId: "10000" });
  assert.equal((await first).status, "sent");
  assert.equal((await retry).duplicate, true);
  assert.equal(calls, 1);
});

test("typing cannot cross a recovery delivery fence", async (t) => {
  const f = setup(t);
  const pending = f.runtime.send(f.ctx, {
    requestId: "recovery-wait",
    text: "你好",
  });
  const rejected = assert.rejects(pending, /RECOVERY_DELIVERY_BLOCKED/);
  await flush();
  assert.equal(f.ctx.pendingDeliveries, 1);
  f.ctx.recoveryDeliveryBlocked = true;
  t.mock.timers.tick(200);
  await rejected;
  assert.equal(f.sent(), 0);
  assert.equal(f.store.bind("agent-0").delivery("recovery-wait"), undefined);
});

test("concurrent same-ID requests recheck receipts after typing", async (t) => {
  const f = setup(t);
  const args = { requestId: "same-id", text: "你好" };
  const sends = [f.runtime.send(f.ctx, args), f.runtime.send(f.ctx, args)];
  await flush();
  t.mock.timers.tick(200);
  const results = await Promise.all(sends);
  assert.equal(results.filter((r) => r.duplicate).length, 1);
  assert.equal(f.sent(), 1);
});

test("burst uses next length after first, explicit gap overrides it, and new input keeps prefix receipts", async (t) => {
  const f = setup(t);
  const p = f.runtime.callTool(f.ctx, "qq_send_burst", {
    requestId: "burst",
    messages: ["一", "二二", "三三三"],
  });
  await flush();
  t.mock.timers.tick(100);
  await flush();
  assert.equal(f.sent(), 1);
  receive(f, "连发时新输入");
  t.mock.timers.tick(199);
  await flush();
  assert.equal(f.sent(), 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(f.sent(), 2);
  t.mock.timers.tick(300);
  assert.equal((await p).receipts.length, 3);
  await f.runtime.callTool(f.ctx, "conversation_read", {});
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

for (const options of [{ enabled: false }, { firstReply: false }])
  test(
    "first reply opt-out sends immediately: " + JSON.stringify(options),
    async (t) => {
      const f = setup(t, options);
      await f.runtime.send(f.ctx, { requestId: "off", text: "立即发送" });
      assert.equal(f.sent(), 1);
    },
  );

test("internal deliveries skip both first and burst typing waits", async (t) => {
  const f = setup(t);
  f.ctx.internalDelivery = true;
  await f.runtime.send(f.ctx, { requestId: "fixed", text: "固定程序文字" });
  await f.runtime.callTool(f.ctx, "qq_send_burst", {
    requestId: "fixed-burst",
    messages: ["固定一", "固定二"],
  });
  assert.equal(f.sent(), 3);
});

for (const revoke of ["pause", "permission", "silence"])
  test(
    "typing cancellation or revoked authority prevents reservation: " + revoke,
    async (t) => {
      const f = setup(t);
      const p = f.runtime.send(f.ctx, {
        requestId: "cancel",
        text: "等待发送",
      });
      const rejected = assert.rejects(
        p,
        /AbortError|AGENT_PAUSED_OR_EXPIRED|CONVERSATION_SILENCED/,
      );
      await flush();
      if (revoke === "pause") await f.runtime.pause("agent-0");
      if (revoke === "permission") {
        const next = structuredClone(f.runtime.config);
        next.agents[0].allow.groups = [];
        await f.runtime.changeConfig(next, f.configStore.revision);
      }
      if (revoke === "silence") {
        const m = f.store.bind("agent-0");
        m.setState(f.ctx.conversation, {
          ...m.state(f.ctx.conversation),
          silenceUntil: f.runtime.now() + 1000,
        });
        t.mock.timers.tick(400);
      }
      await rejected;
      assert.equal(f.sent(), 0);
      assert.equal(f.store.bind("agent-0").delivery("cancel"), undefined);
    },
  );

test("long first wait requires complete human input review, without ledger or budget consumption", async (t) => {
  const f = setup(t);
  const p = f.runtime.send(f.ctx, {
    requestId: "review",
    text: "原".repeat(40),
  });
  const rejected = assert.rejects(p, /TYPING_NEW_INPUT_REVIEW_REQUIRED/);
  await flush();
  const row = receive(f, "新".repeat(2000));
  t.mock.timers.tick(4000);
  await rejected;
  const m = f.store.bind("agent-0");
  assert.equal(m.delivery("review"), undefined);
  assert.equal(m.state(f.ctx.conversation).sendTimes?.length || 0, 0);
  assert.equal(f.sent(), 0);
  f.ctx.shownSeq = row.seq;
  await assert.rejects(
    f.runtime.send(f.ctx, { requestId: "retry", text: "变换文字也不绕过" }),
    /TYPING_NEW_INPUT_REVIEW_REQUIRED/,
  );
  await f.runtime.callTool(f.ctx, "conversation_read", { maxChars: 512 });
  await assert.rejects(
    f.runtime.send(f.ctx, { requestId: "retry", text: "部分阅读不算" }),
    /TYPING_NEW_INPUT_REVIEW_REQUIRED/,
  );
  await f.runtime.callTool(f.ctx, "conversation_read", { maxChars: 8000 });
  await assert.rejects(
    f.runtime.send(f.ctx, { requestId: "retry", text: "仍是摘要" }),
    /TYPING_NEW_INPUT_REVIEW_REQUIRED/,
  );
  let offset = 0;
  do {
    const page = await f.runtime.callTool(f.ctx, "memory_read", {
      id: row.id,
      offset,
      maxChars: 512,
    });
    offset = page.nextOffset;
    if (offset !== null)
      await assert.rejects(
        f.runtime.send(f.ctx, { requestId: "retry", text: "尚未读完" }),
        /TYPING_NEW_INPUT_REVIEW_REQUIRED/,
      );
  } while (offset !== null);
  const q = f.runtime.send(f.ctx, { requestId: "review", text: "新决定" });
  await flush();
  t.mock.timers.tick(300);
  assert.equal((await q).status, "sent");
  assert(knownErrorCodes.has("TYPING_NEW_INPUT_REVIEW_REQUIRED"));
  assert.match(
    safeToolFailure(Error("TYPING_NEW_INPUT_REVIEW_REQUIRED")).hint,
    /Fully read/,
  );
});

for (const options of [
  { senderId: "10000" },
  { trustedInput: false },
  { kind: "notice.reaction" },
  { origin: "import" },
  { conversation: "group:20001" },
])
  test(
    "long typing ignores input without live human authority: " +
      JSON.stringify(options),
    async (t) => {
      const f = setup(t);
      const p = f.runtime.send(f.ctx, {
        requestId: "ignore",
        text: "字".repeat(40),
      });
      await flush();
      receive(f, "观察记录", options);
      t.mock.timers.tick(4000);
      assert.equal((await p).status, "sent");
    },
  );

test("short first wait keeps old semantics when new input arrives", async (t) => {
  const f = setup(t);
  const p = f.runtime.send(f.ctx, {
    requestId: "short",
    text: "字".repeat(30),
  });
  await flush();
  receive(f, "新的短消息");
  t.mock.timers.tick(3000);
  assert.equal((await p).status, "sent");
});

for (const source of ["fallback", "spokenText", "transcript"])
  test(
    "voice first reply uses text or fixed two seconds: " + source,
    async (t) => {
      const f = setup(t);
      const m = {
        id: "voice-fixture",
        title: "测试语音",
        duration: 1,
        sources: [],
      };
      if (source === "spokenText") m.spokenText = "合成文字";
      if (source === "transcript") {
        const row = receive(f, "语音来源");
        m.sources.push({ eventId: row.id });
        f.store.bind("agent-0").append({
          dedupe: transcriptKey(row.id),
          conversation: f.ctx.conversation,
          kind: "voice.transcript",
          body: "转写文字",
        });
      }
      f.runtime.voices = {
        metadata: () => m,
        segment: async () => ({ type: "record", data: { file: "fixture" } }),
      };
      const p = f.runtime.callTool(f.ctx, "qq_send_voice", {
        requestId: "voice",
        audioId: m.id,
      });
      await flush();
      const ms = source === "fallback" ? 2000 : 400;
      t.mock.timers.tick(ms - 1);
      await flush();
      assert.equal(f.sent(), 0);
      t.mock.timers.tick(1);
      assert.equal((await p).status, "sent");
    },
  );

test("burst long inter-message typing ignores fresh input and cancellation preserves prefix ledger", async (t) => {
  const f = setup(t);
  const p = f.runtime.callTool(f.ctx, "qq_send_burst", {
    requestId: "long-burst",
    messages: ["一", "二".repeat(40), "三".repeat(40)],
  });
  const rejected = assert.rejects(p, /AbortError|AGENT_PAUSED_OR_EXPIRED/);
  await flush();
  t.mock.timers.tick(100);
  await flush();
  receive(f, "新输入不改变连发回执");
  t.mock.timers.tick(4000);
  await flush();
  assert.equal(f.sent(), 2);
  await f.runtime.pause("agent-0");
  await rejected;
  const m = f.store.bind("agent-0");
  assert.equal(m.delivery("long-burst:0").status, "sent");
  assert.equal(m.delivery("long-burst:1").status, "sent");
  assert.equal(m.delivery("long-burst:2"), undefined);
});

test("typing rechecks a lower hot-updated send quota before reserving delivery", async (t) => {
  const f = setup(t);
  const fixed = context(f.runtime);
  fixed.internalDelivery = true;
  await f.runtime.send(fixed, {
    requestId: "existing-budget",
    text: "固定文字",
  });
  const p = f.runtime.send(f.ctx, {
    requestId: "quota-changed",
    text: "等待发送",
  });
  const rejected = assert.rejects(p, /SEND_RATE_LIMIT/);
  await flush();
  const next = structuredClone(f.runtime.config);
  next.agents[0].behavior.maxSendPerMinute = 1;
  await f.runtime.changeConfig(next, f.configStore.revision);
  assert.equal(f.ctx.controller.signal.aborted, false);
  t.mock.timers.tick(400);
  await rejected;
  assert.equal(f.sent(), 1);
  assert.equal(f.store.bind("agent-0").delivery("quota-changed"), undefined);
});

test("tone review runs before typing, then exact confirmation waits and retains duplicate receipts", async (t) => {
  const f = setup(t);
  const args = { requestId: "review-before-typing", text: "总结一下" };
  await assert.rejects(f.runtime.send(f.ctx, args), /TONE_REVIEW_SUGGESTED/);
  assert.equal(f.ctx.pendingDeliveries || 0, 0);
  assert.equal(f.store.bind("agent-0").delivery(args.requestId), undefined);
  const p = f.runtime.send(f.ctx, args);
  await flush();
  t.mock.timers.tick(399);
  await flush();
  assert.equal(f.sent(), 0);
  t.mock.timers.tick(1);
  assert.equal((await p).status, "sent");
  assert.equal((await f.runtime.send(f.ctx, args)).duplicate, true);
  assert.equal(f.sent(), 1);
});
