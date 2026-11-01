import test from "node:test";
import assert from "node:assert/strict";
import { fixture, config, raw, settle } from "./helpers.mjs";
import { validateConfig } from "../src/core/config.mjs";
import {
  sleepWindow,
  rhythmStatus,
  rhythmEnvironment,
} from "../src/core/rhythm.mjs";

function setup(t, overrides = {}, at = "2026-11-01T18:00:00Z") {
  const cfg = config(1);
  cfg.agents[0].behavior.rhythm = {
    enabled: true,
    wakeJitterMs: 1800000,
    ...overrides,
  };
  cfg.agents[0].ownerIds = ["30001"];
  cfg.agents[0].allow.users.push("30001");
  const f = fixture(t, { cfg: validateConfig(cfg) });
  let now = Date.parse(at);
  f.runtime.clock = () => new Date(now);
  f.runtime.random = () => 0.5;
  const wakes = [];
  f.runtime.wake = async (id, conversation, options) => {
    wakes.push({ id, conversation, ...options });
  };
  return {
    ...f,
    wakes,
    setTime: (value) => {
      now = Date.parse(value);
    },
    agent: f.runtime.agent("agent-0"),
  };
}

test("sleep intervals cross midnight and inherit the proactive timezone", (t) => {
  const f = setup(t, { sleep: { start: "23:00", end: "08:30" } });
  const w = sleepWindow(f.agent.behavior, Date.parse("2026-11-01T18:00:00Z"));
  assert.equal(new Date(w.start).toISOString(), "2026-11-01T15:00:00.000Z");
  assert.equal(new Date(w.end).toISOString(), "2026-11-02T00:30:00.000Z");
  assert.equal(
    sleepWindow(f.agent.behavior, Date.parse("2026-11-02T01:00:00Z")),
    null,
  );
});

test("sleep jitter persists across scheduler recreation and new messages", async (t) => {
  const f = setup(t);
  await f.runtime.ingest("qq-0", raw());
  const memory = f.store.bind(f.agent.id);
  const first = memory.state("group:20000");
  assert.equal(first.wakeDueAt, Date.parse("2026-11-02T00:45:00Z"));
  f.runtime.random = () => {
    throw Error("must not draw again");
  };
  assert.equal(rhythmStatus(f.runtime, f.agent, true).until, first.wakeDueAt);
  f.runtime.conversations = new f.runtime.conversations.constructor(f.runtime);
  f.runtime.conversations.request(f.agent.id, "group:20000", "mention", {
    seq: first.lastReceivedSeq,
    direct: true,
  });
  assert.equal(memory.state("group:20000").wakeDueAt, first.wakeDueAt);
  assert.equal(f.wakes.length, 0);
  f.setTime("2026-11-02T00:46:00Z");
  f.runtime.conversations.flush(f.agent.id, "group:20000");
  await settle(f.runtime);
  assert.equal(f.wakes.length, 1);
  const wake = f.wakes[0].reasons[0].rhythmWake;
  assert.ok(wake);
  assert.match(
    rhythmEnvironment(f.runtime, f.agent, {
      conversation: "group:20000",
      rhythmWake: wake,
    }),
    /你刚起床/,
  );
  assert.doesNotMatch(
    rhythmEnvironment(f.runtime, f.agent, { conversation: "group:20000" }),
    /你刚起床/,
  );
  assert.equal(memory.state("group:20000").rhythmSleepPeriod, undefined);
});

test("owner private and scheduled wakeups bypass sleep without reply credit", (t) => {
  const f = setup(t);
  f.runtime.conversations.request(f.agent.id, "private:30001", "private");
  f.runtime.conversations.request(f.agent.id, "group:20000", "scheduled", {
    taskRunId: "task",
    immediate: true,
  });
  assert.equal(f.wakes.length, 2);
  assert.equal(
    f.store.bind(f.agent.id).state("private:30001").replyBatchSends,
    undefined,
  );
  assert.match(
    rhythmEnvironment(f.runtime, f.agent, { conversation: "private:30001" }),
    /睡觉中被主人叫醒/,
  );
});

test("direct mentions and own-message quotes skip random late replies", async (t) => {
  const f = setup(
    t,
    { lateReply: { probability: 1, minMs: 60000, maxMs: 60000 } },
    "2026-11-01T04:00:00Z",
  );
  await f.runtime.ingest(
    "qq-0",
    raw(1, { message: [{ type: "at", data: { qq: "10000" } }] }),
  );
  assert.equal(f.wakes.length, 1);
  const memory = f.store.bind(f.agent.id);
  memory.append({
    dedupe: "own",
    connectionId: "qq-0",
    conversation: "group:20001",
    kind: "message.sent",
    direction: "out",
    senderId: "10000",
    messageId: "40000",
    body: "好",
    status: "confirmed",
  });
  await f.runtime.ingest(
    "qq-0",
    raw(2, {
      group_id: 20001,
      message: [
        { type: "reply", data: { id: "40000" } },
        { type: "text", data: { text: "再说说？" } },
      ],
    }),
  );
  assert.equal(f.wakes.length, 2);
});

test("ordinary late delay is bounded and drawn once per pending batch", (t) => {
  const f = setup(
    t,
    { lateReply: { probability: 1, minMs: 60000, maxMs: 600000 } },
    "2026-11-01T04:00:00Z",
  );
  f.runtime.conversations.request(f.agent.id, "group:20000", "message");
  const memory = f.store.bind(f.agent.id);
  const due = memory.state("group:20000").wakeDueAt;
  assert.equal(due, Date.parse("2026-11-01T04:05:30Z"));
  f.runtime.random = () => {
    throw Error("must not redraw");
  };
  f.runtime.conversations.request(f.agent.id, "group:20000", "message");
  assert.equal(memory.state("group:20000").wakeDueAt, due);
});

test("disabled rhythm leaves wake timing unchanged", (t) => {
  const f = setup(t, { enabled: false });
  f.runtime.random = () => {
    throw Error("disabled must not draw");
  };
  f.runtime.conversations.request(f.agent.id, "group:20000", "message");
  assert.equal(f.wakes.length, 1);
  assert.equal(
    rhythmEnvironment(f.runtime, f.agent, { conversation: "group:20000" }),
    "",
  );
});

test("sleep suppresses subject opportunities and contact without consuming quota", (t) => {
  const f = setup(t);
  f.agent.subject.enabled = true;
  const memory = f.store.bind(f.agent.id);
  memory.setState("@subject", { nextCheckAt: f.runtime.now() - 1 });
  f.runtime.subject.tick();
  assert.equal(f.wakes.length, 0);
  assert.equal(memory.state("@subject").checks, undefined);
  assert.equal(
    f.runtime.subject.contactOpportunity(f.agent, "private:30001"),
    false,
  );
  f.setTime("2026-11-02T01:00:00Z");
  f.runtime.subject.tick();
  assert.equal(f.wakes.length, 1);
});

test("slow sleep defers briefly even for mentions", (t) => {
  const f = setup(t, {
    sleepMode: "slow",
    lateReply: { probability: 0, minMs: 60000, maxMs: 60000 },
  });
  f.runtime.conversations.request(f.agent.id, "group:20000", "mention", {
    direct: true,
  });
  assert.equal(
    f.store.bind(f.agent.id).state("group:20000").wakeDueAt,
    f.runtime.now() + 60000,
  );
  f.setTime("2026-11-01T18:01:01Z");
  f.runtime.conversations.flush(f.agent.id, "group:20000");
  assert.equal(f.wakes.length, 1);
});

test("a later direct message removes only random delay, retaining the batch window", async (t) => {
  const f = setup(
    t,
    { lateReply: { probability: 1, minMs: 600000, maxMs: 600000 } },
    "2026-11-01T04:00:00Z",
  );
  f.agent.behavior.batchWindowMs = 5000;
  f.agent.behavior.batchMaxMs = 10000;
  await f.runtime.ingest("qq-0", raw(1));
  assert.equal(f.wakes.length, 0);
  f.setTime("2026-11-01T04:00:01Z");
  await f.runtime.ingest(
    "qq-0",
    raw(2, { message: [{ type: "at", data: { qq: "10000" } }] }),
  );
  const state = f.store.bind(f.agent.id).state("group:20000");
  assert.equal(state.wakeDueAt, Date.parse("2026-11-01T04:00:06Z"));
  f.setTime("2026-11-01T04:00:07Z");
  f.runtime.conversations.tick();
  assert.equal(f.wakes.length, 1);
});

test("disabling rhythm refreshes far-future due indexes and preserves existing reply budgets", async (t) => {
  const f = setup(t);
  const memory = f.store.bind(f.agent.id);
  memory.setState("group:20000", { replyBatchSends: 3 });
  await f.runtime.ingest("qq-0", raw(1));
  assert.equal(f.wakes.length, 0);
  const next = structuredClone(f.runtime.config);
  next.agents[0].behavior.rhythm.enabled = false;
  await f.runtime.changeConfig(next, f.configStore.revision);
  assert.ok(
    f.store.due.current(f.agent.id, "group:20000").next_due_at <=
      f.runtime.now(),
  );
  f.runtime.conversations.tick();
  assert.equal(f.wakes.length, 1);
  assert.equal(memory.state("group:20000").replyBatchSends, 3);
});

test("pausing while sleep is pending never wakes the role at sunrise", async (t) => {
  const f = setup(t);
  await f.runtime.ingest("qq-0", raw(1));
  await f.runtime.pause(f.agent.id, true);
  f.setTime("2026-11-02T01:00:00Z");
  f.runtime.conversations.tick();
  assert.equal(f.wakes.length, 0);
});

test("DST repeated-hour boundaries use the same absolute interval for state and wakeups", (t) => {
  const f = setup(
    t,
    {
      timezone: "America/New_York",
      sleep: { start: "23:00", end: "01:30" },
      wakeJitterMs: 0,
      lateReply: { probability: 0, minMs: 60000, maxMs: 60000 },
    },
    "2026-11-01T06:15:00Z",
  );
  assert.equal(sleepWindow(f.agent.behavior, f.runtime.now()), null);
  assert.equal(rhythmStatus(f.runtime, f.agent).state, "awake");
  f.runtime.conversations.request(f.agent.id, "group:20000", "message");
  assert.equal(f.wakes.length, 1);
  f.agent.behavior.rhythm.sleep = { start: "01:30", end: "02:30" };
  const window = sleepWindow(f.agent.behavior, f.runtime.now());
  assert.equal(window.start, Date.parse("2026-11-01T05:30:00Z"));
  assert.equal(window.end, Date.parse("2026-11-01T07:30:00Z"));
  assert.equal(rhythmStatus(f.runtime, f.agent).state, "sleeping");
  f.runtime.conversations.request(f.agent.id, "group:20001", "message");
  assert.equal(
    f.store.bind(f.agent.id).state("group:20001").wakeDueAt,
    window.end,
  );
});
