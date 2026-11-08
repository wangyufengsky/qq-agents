import test from "node:test";
import assert from "node:assert/strict";
import { OneBot } from "../src/transport/onebot.mjs";
import { config, fixture, context } from "./helpers.mjs";
import { startTypingIndicator } from "../src/core/typing-indicator.mjs";
import { Diagnostics } from "../src/core/diagnostics.mjs";

const flush = async () => {
  for (let i = 0; i < 3; i++)
    await new Promise((resolve) => setImmediate(resolve));
};
function setup(t, conversation = "private:30000", run) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const cfg = config(1);
  cfg.agents[0].tools.push("qq_send_burst");
  const f = fixture(t, { cfg, run });
  const ctx = context(f.runtime, "agent-0", conversation);
  const agent = f.runtime.agent("agent-0");
  agent.behavior.typing ??= {};
  Object.assign(agent.behavior.typing, { enabled: true, indicator: true });
  const transport = f.runtime.transports.get("qq-0");
  const calls = [],
    lines = [];
  transport.setTyping = async (conversation, options) => {
    calls.push({ conversation, ...options });
  };
  f.runtime.diagnostics = new Diagnostics({
    write: (line) => lines.push(line),
  });
  return { ...f, ctx, agent, transport, calls, lines };
}

const response = (value) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });

test("OneBot sends the NapCat private input status extension with exact string parameters", async () => {
  const calls = [];
  const bot = new OneBot(config(1).connections[0], {
    fetchImpl: async (url, options) => {
      calls.push({
        url,
        body: JSON.parse(options.body),
        signal: options.signal,
      });
      return response({ status: "ok", retcode: 0, data: null });
    },
  });
  await bot.setTyping("group:20000");
  await bot.setTyping("@subject");
  await bot.setTyping("private:not-a-number");
  assert.equal(calls.length, 0);
  const controller = new AbortController();
  await bot.setTyping("private:30000", { signal: controller.signal });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:9/set_input_status");
  assert.deepEqual(calls[0].body, { user_id: "30000", event_type: 1 });
  controller.abort();
  assert.equal(calls[0].signal.aborted, true);
  await bot.setTyping("private:30000", { signal: controller.signal });
  assert.equal(
    calls.length,
    1,
    "already-cancelled signals must not reach the gateway",
  );
});

test("OneBot input status has a one-second bounded request and small response budget", async () => {
  const bot = new OneBot(config(1).connections[0]);
  let call;
  bot.call = async (...args) => {
    call = args;
  };
  const controller = new AbortController();
  await bot.setTyping("private:30000", { signal: controller.signal });
  assert.equal(call[2], 1000);
  assert.deepEqual(call[3], { signal: controller.signal, maxBytes: 4096 });
});

test("unsupported input status preserves only the generic gateway error", async () => {
  const bot = new OneBot(config(1).connections[0], {
    fetchImpl: async () =>
      response({
        status: "failed",
        retcode: 1404,
        wording: "untrusted gateway detail",
      }),
  });
  await assert.rejects(bot.setTyping("private:30000"), {
    message: "ONEBOT_REJECTED",
  });
});

test("input status is cosmetic: one request, no chat event, receipt or send budget", async (t) => {
  const f = setup(t);
  const m = f.store.bind("agent-0");
  const before = m.db.prepare("SELECT COUNT(*) AS n FROM events").get().n;
  const stop = startTypingIndicator(f.runtime, f.ctx);
  t.mock.timers.tick(500);
  await flush();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].conversation, "private:30000");
  stop();
  stop();
  await flush();
  assert.equal(f.calls[0].signal.aborted, true);
  assert.equal(
    m.db.prepare("SELECT COUNT(*) AS n FROM events").get().n,
    before,
  );
  assert.equal(m.db.prepare("SELECT COUNT(*) AS n FROM deliveries").get().n, 0);
  assert.equal(m.state(f.ctx.conversation).sendTimes?.length || 0, 0);
  assert.equal(f.transport.sent.length, 0);
  assert.equal(f.runtime.diagnostics.snapshot().length, 0);
});

test("input status gateway failures produce only one sanitized diagnostic", async (t) => {
  const f = setup(t);
  f.transport.setTyping = async () => {
    throw Error("untrusted gateway detail");
  };
  const stop = startTypingIndicator(f.runtime, f.ctx);
  t.mock.timers.tick(500);
  await flush();
  assert.equal(f.runtime.diagnostics.snapshot().length, 1);
  assert.equal(
    f.runtime.diagnostics.snapshot()[0].code,
    "TYPING_INDICATOR_UNAVAILABLE",
  );
  assert.equal(f.runtime.diagnostics.snapshot()[0].count, 1);
  assert.equal(f.lines.length, 1);
  assert(!f.lines[0].includes("untrusted gateway detail"));
  assert(!f.lines[0].includes("30000"));
  t.mock.timers.tick(1000);
  stop();
  await flush();
  assert.equal(f.runtime.diagnostics.snapshot()[0].count, 1);
});

test("input status times out once even when an unsupported transport ignores cancellation", async (t) => {
  const f = setup(t);
  let signal;
  f.transport.setTyping = (_conversation, options) => {
    signal = options.signal;
    return new Promise(() => {});
  };
  const stop = startTypingIndicator(f.runtime, f.ctx);
  t.mock.timers.tick(500);
  await flush();
  t.mock.timers.tick(999);
  await flush();
  assert.equal(f.runtime.diagnostics.snapshot().length, 0);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(signal.aborted, true);
  assert.equal(f.runtime.diagnostics.snapshot()[0].count, 1);
  t.mock.timers.tick(5000);
  stop();
  await flush();
  assert.equal(f.runtime.diagnostics.snapshot()[0].count, 1);
});

for (const cause of ["turn-finished", "turn-aborted"])
  test(
    "cosmetic request cancellation is not a gateway failure: " + cause,
    async (t) => {
      const f = setup(t);
      let signal;
      f.transport.setTyping = (_conversation, options) =>
        new Promise((_, reject) => {
          signal = options.signal;
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      const stop = startTypingIndicator(f.runtime, f.ctx);
      t.mock.timers.tick(500);
      await flush();
      if (cause === "turn-finished") stop();
      else f.ctx.controller.abort();
      await flush();
      assert.equal(signal.aborted, true);
      t.mock.timers.tick(1000);
      await flush();
      assert.equal(f.runtime.diagnostics.snapshot().length, 0);
      assert.equal(f.lines.length, 0);
    },
  );

for (const reason of [
  "group",
  "internal",
  "indicator-disabled",
  "disconnected",
  "isolated",
  "paused",
  "revoked",
  "expired",
])
  test(
    "input status cannot escape conversation and authority gates: " + reason,
    async (t) => {
      const f = setup(t, reason === "group" ? "group:20000" : "private:30000");
      if (reason === "internal") f.ctx.internalDelivery = true;
      if (reason === "indicator-disabled")
        f.agent.behavior.typing.indicator = false;
      if (reason === "disconnected") f.transport.connected = false;
      if (reason === "isolated") f.runtime.config.mode = "isolated";
      if (reason === "paused") f.agent.paused = true;
      if (reason === "revoked") f.agent.allow.users = [];
      if (reason === "expired") f.ctx.expires = Date.now() - 1;
      const stop = startTypingIndicator(f.runtime, f.ctx);
      t.mock.timers.tick(500);
      await flush();
      stop();
      assert.equal(f.calls.length, 0);
      assert.equal(f.runtime.diagnostics.snapshot().length, 0);
    },
  );

test("a pause before the scheduled request starts prevents a late indication", async (t) => {
  const f = setup(t);
  const stop = startTypingIndicator(f.runtime, f.ctx);
  f.agent.paused = true;
  t.mock.timers.tick(500);
  await flush();
  stop();
  assert.equal(f.calls.length, 0);
  assert.equal(f.runtime.diagnostics.snapshot().length, 0);
});

test("a first private reply sends immediately without starting a synthetic typing request", async (t) => {
  const f = setup(t);
  assert.equal(
    (
      await f.runtime.send(f.ctx, {
        requestId: "immediate-first",
        text: "你好".repeat(60),
      })
    ).status,
    "sent",
  );
  assert.equal(f.transport.sent.length, 1);
  assert.equal(f.calls.length, 0);
});

test("private burst gaps alone do not start an input status request", async (t) => {
  const f = setup(t);
  const p = f.runtime.callTool(f.ctx, "qq_send_burst", {
    requestId: "indicator-burst",
    messages: ["第一条", "第二条", "第三条"],
    gapMs: 900,
  });
  await flush();
  assert.equal(f.transport.sent.length, 1);
  t.mock.timers.tick(900);
  await flush();
  assert.equal(f.transport.sent.length, 2);
  t.mock.timers.tick(900);
  assert.equal((await p).receipts.length, 3);
  assert.equal(f.calls.length, 0);
});

test("a fast private backend response completes and never schedules a late input status", async (t) => {
  const f = setup(t, "private:30000", async (p) => {
    await p.callTool("qq_send", { requestId: "fast", text: "你好" });
  });
  assert.equal(
    (await f.runtime.wake(f.ctx.agentId, f.ctx.conversation)).status,
    "sent",
  );
  assert.equal(f.transport.sent.length, 1);
  t.mock.timers.tick(2000);
  await flush();
  assert.equal(f.calls.length, 0);
});

test("slow private processing starts once at 500 ms independently of burst typing and never delays a reply", async (t) => {
  const proceed = Promise.withResolvers();
  const f = setup(t, "private:30000", async (p) => {
    await proceed.promise;
    await p.callTool("qq_send", { requestId: "slow", text: "你好" });
  });
  f.agent.behavior.typing.enabled = false;
  f.transport.setTyping = (conversation, options) => {
    f.calls.push({ conversation, ...options });
    return new Promise(() => {});
  };
  const turn = f.runtime.wake(f.ctx.agentId, f.ctx.conversation);
  t.mock.timers.tick(499);
  await flush();
  assert.equal(f.calls.length, 0);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].conversation, f.ctx.conversation);
  assert.equal(f.calls[0].signal.aborted, false);
  proceed.resolve();
  assert.equal((await turn).status, "sent");
  assert.equal(f.transport.sent.length, 1);
  assert.equal(f.calls[0].signal.aborted, true);
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(f.calls.length, 1);
  assert.equal(f.runtime.diagnostics.snapshot().length, 0);
});

for (const outcome of ["completed-no-send", "failed", "cancelled"])
  test("processing releases pending input status on " + outcome, async (t) => {
    const proceed = Promise.withResolvers();
    const f = setup(t, "private:30000", async ({ signal }) => {
      signal.addEventListener("abort", () => proceed.resolve(), { once: true });
      await proceed.promise;
      if (outcome === "failed") throw Error("SYNTHETIC_BACKEND_FAILURE");
    });
    f.transport.setTyping = (conversation, options) => {
      f.calls.push({ conversation, ...options });
      return new Promise(() => {});
    };
    const turn = f.runtime.wake(f.ctx.agentId, f.ctx.conversation);
    t.mock.timers.tick(500);
    await flush();
    assert.equal(f.calls.length, 1);
    if (outcome === "cancelled") await f.runtime.pause("agent-0");
    else proceed.resolve();
    assert.equal((await turn).status, outcome);
    assert.equal(f.calls[0].signal.aborted, true);
    t.mock.timers.tick(5000);
    await flush();
    assert.equal(f.calls.length, 1);
    assert.equal(f.transport.sent.length, 0);
    assert(
      !f.runtime.diagnostics
        .snapshot()
        .some(({ code }) => code === "TYPING_INDICATOR_UNAVAILABLE"),
    );
  });

test("slow group processing does not schedule a private status request", async (t) => {
  const proceed = Promise.withResolvers();
  const f = setup(t, "group:20000", () => proceed.promise);
  const turn = f.runtime.wake(f.ctx.agentId, f.ctx.conversation);
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(f.calls.length, 0);
  proceed.resolve();
  assert.equal((await turn).status, "completed-no-send");
});

test("waiting for input preparation does not start the backend typing timer", async (t) => {
  const prepared = Promise.withResolvers();
  const handled = Promise.withResolvers();
  const f = setup(t, "private:30000", () => handled.promise);
  t.mock.method(f.runtime.transcripts, "settle", () => prepared.promise);
  const turn = f.runtime.wake(f.ctx.agentId, f.ctx.conversation);
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(f.calls.length, 0);
  prepared.resolve();
  await flush();
  t.mock.timers.tick(499);
  await flush();
  assert.equal(f.calls.length, 0);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(f.calls.length, 1);
  handled.resolve();
  assert.equal((await turn).status, "completed-no-send");
});
