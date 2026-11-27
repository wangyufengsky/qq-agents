import test from "node:test";
import assert from "node:assert/strict";
import { config, fixture } from "./helpers.mjs";
import { DreamScheduler, dreamLag } from "../src/dream/scheduler.mjs";
import { beginRoleRest, settleRoleRest } from "../src/core/role-rest.mjs";

const min = 60000;
const empty = {
  schemaVersion: 1,
  operations: [],
  awakeningSummary: "",
  noChangesReason: "无变化。",
};
function setup(t, count = 1, configure = () => {}, run) {
  const cfg = config(count);
  for (const role of cfg.agents) {
    role.dream.enabled = true;
    role.behavior.proactive.timezone = "UTC";
  }
  configure(cfg);
  let time = Date.UTC(2026, 0, 1, 0);
  const f = fixture(t, {
    cfg,
    run: run ?? ((p) => p.callTool("dream_cognition_submit", empty)),
  });
  f.runtime.clock = () => new Date(time);
  f.runtime.dreamScheduler = new DreamScheduler(f.runtime);
  const add = (i, role = "agent-0") =>
    f.store.bind(role).append({
      dedupe: `fixture-${i}`,
      conversation: "group:20000",
      kind: "message.received",
      body: "一条合格来信。",
      payload: { trustedInput: true },
    });
  const tick = async (minutes) => {
    time += minutes * min;
    await f.runtime.dreamScheduler.tick();
    while (f.runtime.work.size) await Promise.allSettled([...f.runtime.work]);
  };
  return {
    ...f,
    add,
    tick,
    rows: () =>
      f.store.db.prepare("SELECT * FROM dream_runs ORDER BY rowid").all(),
  };
}

test("nap waits for idle and the configured valid-event threshold", async (t) => {
  const f = setup(t, 1, (cfg) => {
    cfg.agents[0].dream.cognitive.deepDaily = false;
    cfg.agents[0].dream.cognitive.napMinEvents = 2;
  });
  f.add(1);
  await f.tick(14);
  assert.equal(f.rows().length, 0);
  await f.tick(1);
  assert.equal(f.rows().length, 0);
  f.add(2);
  await f.tick(1);
  assert.deepEqual(
    f.rows().map(({ mode, trigger, status }) => [mode, trigger, status]),
    [["nap", "idle", "COMMITTED"]],
  );
});

test("deep work starts after ten minutes of rhythm sleep or role rest and only once each day", async (t) => {
  for (const trigger of ["rhythm-sleep", "rest"])
    await t.test(trigger, async (t) => {
      const f = setup(t, 1, (cfg) => {
        const role = cfg.agents[0];
        if (trigger === "rhythm-sleep")
          role.behavior.rhythm = {
            ...role.behavior.rhythm,
            enabled: true,
            timezone: "UTC",
            sleep: {
              ...role.behavior.rhythm.sleep,
              start: "00:00",
              end: "06:00",
            },
          };
        if (trigger === "rest")
          role.subject = { ...role.subject, enabled: true, inboxEnabled: true };
      });
      if (trigger === "rest") {
        const role = f.runtime.agent("agent-0");
        beginRoleRest(f.runtime, role, {
          durationMs: 60 * min,
          earlyWake: "never",
        });
        settleRoleRest(f.runtime, role);
      }
      f.add(1);
      await f.tick(9);
      assert.equal(f.rows().length, 0);
      await f.tick(1);
      assert.deepEqual(
        f.rows().map((row) => [row.mode, row.trigger, row.status]),
        [["deep", trigger, "COMMITTED"]],
      );
      f.add(2);
      await f.tick(6);
      assert.equal(f.rows().length, 1);
    });
});

test("automatic scheduling respects isolated, global, role and dream pause gates", async (t) => {
  for (const gate of ["isolated", "global", "role", "dream"])
    await t.test(gate, async (t) => {
      const f = setup(t, 1, (cfg) => {
        if (gate === "isolated") cfg.mode = "isolated";
        if (gate === "global") cfg.globalPaused = true;
        if (gate === "role") cfg.agents[0].paused = true;
        cfg.agents[0].dream.cognitive.napMinEvents = 1;
      });
      if (gate === "dream")
        f.store.bind("agent-0").setState("@dream", { paused: true });
      f.add(1);
      await f.tick(20);
      assert.equal(f.rows().length, 0);
    });
});

test("one manual queue outranks automatic scheduling, and pause cancels a queued request", async (t) => {
  const ready = Promise.withResolvers(),
    released = Promise.withResolvers();
  const f = setup(
    t,
    3,
    (cfg) => {
      for (const role of cfg.agents) {
        role.dream.budget.maxGlobalConcurrency = 1;
        role.dream.budget.maxRunsPerDay = 1;
      }
    },
    async (p) => {
      if (p.conversation.startsWith("agent-0/")) {
        ready.resolve();
        await released.promise;
      }
      p.onUsage?.({ source: "measured", contextTokens: 123 });
      await p.callTool("dream_cognition_submit", empty);
    },
  );
  const first = f.runtime.dreams.run("agent-0", { idempotencyKey: "first" });
  await ready.promise;
  const queued = f.runtime.dreams.trigger("agent-1", "deep");
  const cancelled = f.runtime.dreams.trigger("agent-2", "nap");
  assert.equal(queued.status, "QUEUED");
  assert.equal(cancelled.status, "QUEUED");
  assert.throws(
    () => f.runtime.dreams.trigger("agent-1", "nap"),
    /DREAM_ALREADY_RUNNING/,
  );
  f.store.bind("agent-2").setState("@dream", { paused: true });
  f.runtime.dreams.pause("agent-2");
  released.resolve();
  const firstResult = await first;
  while (f.runtime.work.size) await Promise.allSettled([...f.runtime.work]);
  assert.deepEqual(
    f.rows().map((row) => [row.agent_id, row.status]),
    [
      ["agent-0", "COMMITTED"],
      ["agent-1", "COMMITTED"],
      ["agent-2", "CANCELLED"],
    ],
  );
  assert.equal(f.rows()[1].run_id, queued.runId);
  assert.equal(JSON.parse(f.rows()[1].usage_json).source, "measured");
  assert.deepEqual(
    await f.runtime.dreams.run("agent-0", { idempotencyKey: "first" }),
    { runId: firstResult.runId, status: "COMMITTED" },
  );
  assert.throws(
    () => f.runtime.dreams.trigger("agent-0", "nap"),
    /DREAM_BUDGET_EXCEEDED/,
  );
});

test("overview lag counts all eligible diaries and corrections and filters protected rows", async (t) => {
  const f = setup(t);
  const memory = f.store.bind("agent-0");
  for (let i = 0; i < 3; i++) {
    const event = f.add(i);
    memory.diaryWrite({
      title: "日记",
      body: "合成资料",
      evidence: [event.id],
    });
    memory.corrections.put({
      id: `fixture-correction-${i}`,
      sourceId: event.id,
      oldBelief: "旧判断",
      current: "新判断",
      createdAt: new Date(f.runtime.now()).toISOString(),
    });
  }
  memory.append({
    dedupe: "protected",
    conversation: "@work:fixture",
    kind: "message.received",
    body: "不可用",
  });
  assert.deepEqual(await dreamLag(f.runtime, "agent-0"), {
    events: 3,
    diaries: 3,
    corrections: 3,
  });
});

test("manual work waits through maintenance and counts the local day it actually starts", async (t) => {
  const ready = Promise.withResolvers(),
    released = Promise.withResolvers();
  const f = setup(
    t,
    2,
    (cfg) => {
      for (const role of cfg.agents) role.dream.budget.maxGlobalConcurrency = 1;
      cfg.agents[1].dream.budget.maxRunsPerDay = 1;
    },
    async (p) => {
      if (p.conversation.startsWith("agent-0/")) {
        ready.resolve();
        await released.promise;
      }
      await p.callTool("dream_cognition_submit", empty);
    },
  );
  const before = Date.UTC(2026, 0, 1, 23, 59),
    after = Date.UTC(2026, 0, 2, 0, 1);
  f.runtime.clock = () => new Date(before);
  const occupied = f.runtime.dreams.run("agent-0");
  await ready.promise;
  const queued = f.runtime.dreams.trigger("agent-1", "nap");
  assert.equal(queued.status, "QUEUED");
  let maintenance = true;
  t.mock.getter(f.runtime.maintenance, "active", () => maintenance);
  f.runtime.clock = () => new Date(after);
  released.resolve();
  await occupied;
  assert.equal(f.rows()[1].status, "QUEUED");
  maintenance = false;
  await f.runtime.dreamScheduler.tick();
  while (f.runtime.work.size) await Promise.allSettled([...f.runtime.work]);
  const row = f.rows()[1];
  assert.equal(row.status, "COMMITTED");
  assert.equal(row.created_at, new Date(before).toISOString());
  assert.equal(row.started_at, new Date(after).toISOString());
  assert.throws(
    () => f.runtime.dreams.trigger("agent-1", "nap"),
    /DREAM_BUDGET_EXCEEDED/,
  );
});
