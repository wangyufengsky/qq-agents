import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fixture, config, context, temp, FakeTransport } from "./helpers.mjs";
import { Runtime } from "../src/core/runtime.mjs";
import { ConfigStore } from "../src/core/config.mjs";
import { MemoryStore } from "../src/memory/store.mjs";
import { restoreExport } from "../src/memory/migrate.mjs";

const send = (runtime, ctx, requestId) =>
  runtime.send(ctx, { requestId, text: "合成消息" });

test("a damaged persisted role budget cannot silently become an empty allowance", async (t) => {
  const f = fixture(t, { cfg: config(1) });
  await send(f.runtime, context(f.runtime), "before");
  f.store.bind("agent-0").setState("internal:send-budget", { version: 1 });
  await assert.rejects(
    send(f.runtime, context(f.runtime, "agent-0", "group:20001"), "after"),
    /SEND_BUDGET_CORRUPT/,
  );
  assert.equal(f.runtime.transports.get("qq-0").sent.length, 1);
});

test("one role shares its last minute allowance across concurrent conversations", async (t) => {
  const cfg = config(2);
  cfg.agents[0].behavior.maxSendPerMinute = 1;
  const { runtime } = fixture(t, { cfg });
  const first = context(runtime),
    second = context(runtime, "agent-0", "group:20001");
  const results = await Promise.allSettled([
    send(runtime, first, "first"),
    send(runtime, second, "second"),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.match(
    results.find((r) => r.status === "rejected").reason.message,
    /SEND_RATE_LIMIT/,
  );
  assert.equal(runtime.transports.get("qq-0").sent.length, 1);
  assert.equal((await send(runtime, first, "first")).duplicate, true);
  assert.equal(
    (await send(runtime, context(runtime, "agent-1"), "other-role")).status,
    "sent",
  );
});

test("optional conversation limits leave other conversations available within the role budget", async (t) => {
  const cfg = config(1);
  cfg.agents[0].behavior.conversationMaxSendPerMinute = 1;
  const { runtime } = fixture(t, { cfg });
  const ctx = context(runtime);
  await send(runtime, ctx, "one");
  await assert.rejects(
    send(runtime, ctx, "two"),
    /CONVERSATION_SEND_RATE_LIMIT/,
  );
  await send(runtime, context(runtime, "agent-0", "group:20001"), "elsewhere");
});

function boot(t, root, cfg, seed = () => {}) {
  const store = new MemoryStore(path.join(root, "memory.sqlite"));
  seed(store);
  const runtime = new Runtime({
    memory: store,
    configStore: new ConfigStore(path.join(root, "config.json"), cfg),
    backendFactory: () => ({}),
  });
  runtime.transports.set("qq-0", new FakeTransport());
  let stopped = false;
  const close = async () => {
    if (stopped) return;
    stopped = true;
    await runtime.close();
    store.close();
  };
  t.after(close);
  return { runtime, store, close };
}

test("legacy timestamps keep multiplicity and survive cancellation, restart and export restore", async (t) => {
  const root = temp(t),
    cfg = config(1),
    now = Date.now();
  cfg.agents[0].behavior.maxSendPerHour = 3;
  const first = boot(t, root, cfg, (store) => {
    const mem = store.bind("agent-0");
    mem.setState("group:20000", { sendTimes: [now, now - 3600001] });
    mem.setState("group:20001", { sendTimes: [now] });
  });
  await send(first.runtime, context(first.runtime), "third");
  await first.runtime.resetSession("agent-0", "group:20000");
  await assert.rejects(
    send(
      first.runtime,
      context(first.runtime, "agent-0", "private:30000"),
      "fourth",
    ),
    /SEND_RATE_LIMIT/,
  );
  const data = first.store.bind("agent-0").export();
  await first.close();
  const reopened = boot(t, root, cfg);
  await assert.rejects(
    send(
      reopened.runtime,
      context(reopened.runtime, "agent-0", "private:30000"),
      "after-restart",
    ),
    /SEND_RATE_LIMIT/,
  );
  const restored = boot(t, temp(t), cfg, (store) =>
    restoreExport(store.bind("agent-0"), data),
  );
  await assert.rejects(
    send(
      restored.runtime,
      context(restored.runtime, "agent-0", "private:30000"),
      "after-restore",
    ),
    /SEND_RATE_LIMIT/,
  );
});

test("re-upgrade reconciles sends made by an older version without double charging earlier sends", async (t) => {
  const root = temp(t),
    cfg = config(1);
  cfg.agents[0].behavior.maxSendPerHour = 2;
  const first = boot(t, root, cfg);
  await send(first.runtime, context(first.runtime), "first");
  await first.close();
  const reopened = boot(t, root, cfg, (store) => {
    store.bind("agent-0").setState("group:20001", { sendTimes: [Date.now()] });
  });
  await assert.rejects(
    send(
      reopened.runtime,
      context(reopened.runtime, "agent-0", "private:30000"),
      "third",
    ),
    /SEND_RATE_LIMIT/,
  );
});

for (const failure of ["ONEBOT_REJECTED", "DELIVERY_UNCONFIRMED"])
  test(`role budget charges ${failure} and never replays the attempt`, async (t) => {
    const cfg = config(1);
    cfg.agents[0].behavior.maxSendPerMinute = 1;
    const { runtime } = fixture(t, { cfg }),
      ctx = context(runtime);
    const transport = runtime.transports.get("qq-0");
    transport.failure = failure;
    await assert.rejects(
      send(runtime, ctx, "failure"),
      /DELIVERY_(FAILED|UNKNOWN)/,
    );
    transport.failure = null;
    await assert.rejects(send(runtime, ctx, "failure"), /ALREADY_ATTEMPTED/);
    await assert.rejects(
      send(runtime, context(runtime, "agent-0", "group:20001"), "replacement"),
      /SEND_RATE_LIMIT/,
    );
    assert.equal(transport.sent.length, 1);
  });

test("outbox reservation failure rolls back both budget scopes", async (t) => {
  const cfg = config(1);
  cfg.agents[0].behavior.maxSendPerMinute = 1;
  const { runtime, store } = fixture(t, { cfg });
  store.db.exec(
    "CREATE TRIGGER synthetic_fail BEFORE INSERT ON deliveries BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END",
  );
  await assert.rejects(
    send(runtime, context(runtime), "failed-reservation"),
    /synthetic failure/,
  );
  store.db.exec("DROP TRIGGER synthetic_fail");
  await send(runtime, context(runtime, "agent-0", "group:20001"), "allowed");
  assert.equal(runtime.transports.get("qq-0").sent.length, 1);
});

test("minute and hour windows expire at their boundaries without resetting on new contexts", async (t) => {
  const cfg = config(1);
  Object.assign(cfg.agents[0].behavior, {
    maxSendPerMinute: 1,
    maxSendPerHour: 2,
  });
  const { runtime } = fixture(t, { cfg });
  let now = Date.now();
  runtime.clock = () => new Date(now);
  await send(runtime, context(runtime), "one");
  now += 59999;
  await assert.rejects(
    send(runtime, context(runtime, "agent-0", "group:20001"), "early"),
    /SEND_RATE_LIMIT/,
  );
  now++;
  await send(runtime, context(runtime, "agent-0", "group:20001"), "two");
  now += 60000;
  await assert.rejects(
    send(runtime, context(runtime, "agent-0", "private:30000"), "hour-limited"),
    /SEND_RATE_LIMIT/,
  );
  now += 3480000;
  await send(
    runtime,
    context(runtime, "agent-0", "private:30000"),
    "after-hour",
  );
});
