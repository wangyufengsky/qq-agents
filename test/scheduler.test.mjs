import test from "node:test";
import assert from "node:assert/strict";
import { ConfigStore } from "../src/core/config.mjs";
import { temp } from "./helpers.mjs";
import { MemoryStore } from "../src/memory/store.mjs";
import { Runtime } from "../src/core/runtime.mjs";
import { fixture, config, context, settle } from "./helpers.mjs";
import { TaskScheduler } from "../src/core/scheduler.mjs";
import { TOOL_NAMES, toolSpecs } from "../src/tools/index.mjs";

function setup(t, run = async () => {}) {
  const c = config(1);
  c.agents[0].ownerIds = ["30000"];
  c.agents[0].tools = TOOL_NAMES;
  Object.assign(c.agents[0].scheduler, {
    enabled: true,
    quietEnabled: false,
    jitterMin: 0,
  });
  const f = fixture(t, { cfg: c, run });
  let now = Date.parse("2026-10-25T00:00:00Z");
  f.runtime.clock = () => new Date(now);
  return { ...f, s: f.runtime.scheduler, advance: (ms) => (now += ms) };
}
const task = (patch = {}) => ({
  name: "提醒",
  kind: "text",
  text: "喝水",
  targets: ["private:30000"],
  schedule: { type: "daily", times: ["08:01"] },
  ...patch,
});
const rules = [
  { type: "once", date: "2026-10-26", time: "09:00" },
  { type: "daily", times: ["09:00"] },
  { type: "weekly", weekdays: [1, 3, 5], times: ["09:00"] },
  { type: "workdays", times: ["09:00"] },
  { type: "monthly", days: [1, -1], times: ["09:00"] },
  { type: "monthlyWeekday", nth: -1, weekday: 5, times: ["09:00"] },
  { type: "yearly", dates: ["02-29", "12-31"], times: ["09:00"] },
  { type: "dates", items: [{ date: "2026-12-31", time: "23:00" }] },
  { type: "everyNDays", every: 3, startDate: "2026-10-25", times: ["09:00"] },
  { type: "interval", everyMinutes: 60, window: ["09:00", "21:00"] },
  { type: "dailyRandom", count: 3, window: ["09:00", "21:00"], minGapMin: 60 },
  {
    type: "monthlyRandom",
    count: 4,
    dayRange: [1, 28],
    window: ["09:00", "21:00"],
    minGapMin: 60,
  },
  { type: "cron", expr: "0 9 * * MON-FRI" },
];
test("AI scheduling schema describes every supported rule and accepts their real payloads", async (t) => {
  const schedule = toolSpecs(["qq_schedule_create"])[0].inputSchema.properties
    .schedule;
  assert.equal(schedule.oneOf.length, 12);
  const daily = schedule.oneOf.find((s) => s.properties.type.const === "daily");
  assert.ok(daily.required.includes("times"));
  assert.equal(daily.properties.times.items.type, "string");
  const checkItems = (value) => {
    if (!value || typeof value !== "object") return;
    assert.ok(
      !Array.isArray(value.items),
      "provider schemas require homogeneous array items",
    );
    Object.values(value).forEach(checkItems);
  };
  checkItems(schedule);
  const f = setup(t),
    ctx = context(f.runtime, "agent-0", "private:30000");
  for (const rule of rules.filter((r) => r.type !== "cron"))
    await f.runtime.callTool(
      ctx,
      "qq_schedule_create",
      task({ schedule: rule, enabled: false }),
    );
  assert.equal(f.s.state("agent-0").tasks.length, 12);
});
for (const rule of rules)
  test(`schedule preview and validation: ${rule.type}`, (t) => {
    const f = setup(t),
      r = f.s.preview("agent-0", task({ schedule: rule }));
    assert.ok(r.length > 0);
    assert.ok(r.every((x) => x.at > f.runtime.now()));
    const saved = f.s.create("agent-0", task({ schedule: rule }));
    assert.ok(saved.scheduledAt > f.runtime.now());
  });
test("timezone dates and deterministic random rules are independent of machine zone", (t) => {
  const f = setup(t),
    input = task({
      schedule: rules[10],
      timezone: "America/New_York",
      seed: "fixed",
    });
  assert.deepEqual(
    f.s.preview("agent-0", input),
    f.s.preview("agent-0", input),
  );
  const next = f.s.preview(
    "agent-0",
    task({ timezone: "UTC", schedule: { type: "daily", times: ["09:00"] } }),
  );
  assert.equal(new Date(next[0].at).toISOString(), "2026-10-25T09:00:00.000Z");
});
test("task persists reservation before send and cannot repeat after unknown delivery", async (t) => {
  const f = setup(t);
  f.s.create("agent-0", task());
  f.runtime.transports.get("qq-0").failure = "TIMEOUT";
  f.advance(60001);
  f.runtime.tick();
  await settle(f.runtime);
  assert.equal(f.s.state("agent-0").history[0].status, "unknown");
  f.runtime.scheduler = new TaskScheduler(f.runtime);
  f.runtime.tick();
  await settle(f.runtime);
  assert.equal(f.runtime.transports.get("qq-0").sent.length, 1);
});
test("global pause skips due tasks without model or QQ work", async (t) => {
  let calls = 0;
  const f = setup(t, async () => calls++);
  f.s.create("agent-0", task());
  f.s.create("agent-0", task({ kind: "ai", instruction: "聊一句" }));
  await f.runtime.pause("all", true);
  f.advance(60001);
  f.runtime.tick();
  await settle(f.runtime);
  assert.equal(calls, 0);
  assert.equal(f.runtime.transports.get("qq-0").sent.length, 0);
  assert.ok(f.s.state("agent-0").history.every((r) => r.status === "skipped"));
});
test("missed tasks are recorded, next run advances, and no late burst occurs", async (t) => {
  const f = setup(t);
  f.s.create("agent-0", task());
  f.advance(3600000);
  f.runtime.tick();
  await settle(f.runtime);
  assert.equal(f.s.state("agent-0").history[0].status, "missed");
  assert.equal(f.runtime.transports.get("qq-0").sent.length, 0);
});
test("AI scheduler tool is owner-private only and cross-target edits require approval again", async (t) => {
  const f = setup(t),
    group = context(f.runtime),
    owner = context(f.runtime, "agent-0", "private:30000");
  await assert.rejects(
    f.runtime.callTool(group, "qq_schedule_create", task()),
    /TOOL_DISABLED/,
  );
  f.runtime.agent("agent-0").scheduler.allowAiOtherTargets = true;
  const created = f.s.create(
    "agent-0",
    task({ targets: ["group:20000"] }),
    owner,
  );
  assert.equal(created.enabled, false);
  assert.equal(created.pendingConfirm, true);
  f.s.update("agent-0", created.id, { enabled: true });
  assert.equal(f.s.list("agent-0")[0].enabled, true);
  const edited = f.s.update(
    "agent-0",
    created.id,
    { enabled: true, text: "新的文本" },
    owner,
  );
  assert.equal(edited.enabled, false);
  assert.throws(
    () =>
      f.s.create(
        "agent-0",
        task({ schedule: { type: "cron", expr: "0 9 * * *" } }),
        owner,
      ),
    /CRON_ADMIN/,
  );
});
test("tasks accept ordinary recollection but cannot bypass protected file disclosure", async (t) => {
  const f = setup(t),
    owner = context(f.runtime, "agent-0", "private:30000");
  owner.privateRead.add("elsewhere");
  assert.ok(f.s.create("agent-0", task(), owner).id);
  owner.privateRead.add("operations:protected-file");
  assert.throws(() => f.s.create("agent-0", task(), owner), /DISCLOSURE/);
});
test("AI task instruction survives busy queue and has a non-send outcome if model stays silent", async (t) => {
  let release,
    calls = 0,
    last;
  const f = setup(t, async (p) => {
    calls++;
    last = p.prompt;
    if (calls === 1) await new Promise((r) => (release = r));
  });
  const first = f.runtime.wake("agent-0", "private:30000");
  f.s.create("agent-0", task({ kind: "ai", instruction: "提醒检查实验" }));
  f.advance(60001);
  f.runtime.tick();
  assert.equal(f.s.state("agent-0").history[0].status, "queued");
  release();
  await first;
  await settle(f.runtime);
  assert.equal(calls, 2);
  assert.match(last, /提醒检查实验/);
  assert.equal(f.s.state("agent-0").history[0].status, "completed-no-send");
});
test("manual run is idempotent and consumes shared daily budgets", async (t) => {
  const f = setup(t);
  f.runtime.agent("agent-0").scheduler.totalPerDay = 1;
  const one = f.s.create("agent-0", task());
  f.s.runNow("agent-0", one.id, "click-one");
  await settle(f.runtime);
  f.s.runNow("agent-0", one.id, "click-one");
  await settle(f.runtime);
  f.s.runNow("agent-0", one.id, "click-two");
  await settle(f.runtime);
  assert.equal(f.runtime.transports.get("qq-0").sent.length, 1);
  assert.equal(f.s.state("agent-0").history.at(-1).reason, "TOTAL_DAILY_LIMIT");
});
test("restart does not resume queued AI instructions with uncertain prior execution", (t) => {
  const f = setup(t),
    state = f.s.state("agent-0");
  state.history.push({ id: "interrupted", status: "queued" });
  f.s.save("agent-0", state);
  f.store.bind("agent-0").setState("group:20000", {
    pendingWakes: [{ taskRunId: "interrupted", reason: "scheduled" }],
  });
  const reboot = new TaskScheduler(f.runtime);
  assert.equal(reboot.state("agent-0").history[0].status, "unknown");
  assert.deepEqual(
    f.store.bind("agent-0").state("group:20000").pendingWakes,
    [],
  );
});

test("closed and reopened SQLite preserves task times and suppresses interrupted work", async (t) => {
  const root = temp(t),
    cfg = config(1),
    store = new MemoryStore(root + "/memory.sqlite"),
    configStore = new ConfigStore(root + "/config.json", cfg);
  const runtime1 = new Runtime({
    memory: store,
    configStore,
    backendFactory: () => {
      throw Error("MUST_NOT_START");
    },
  });
  runtime1.clock = () => new Date("2026-10-25T00:00:00Z");
  const f = {
    root,
    store,
    configStore,
    runtime: runtime1,
    s: runtime1.scheduler,
  };
  const saved = f.s.create("agent-0", task());
  const state = f.s.state("agent-0");
  state.history.push({
    id: "restart-run",
    taskId: saved.id,
    status: "reserved",
  });
  f.s.save("agent-0", state);
  await f.runtime.close();
  f.store.close();
  const reopened = new MemoryStore(f.root + "/memory.sqlite");
  const runtime = new Runtime({
    memory: reopened,
    configStore: f.configStore,
    backendFactory: () => {
      throw Error("MUST_NOT_START");
    },
  });
  t.after(async () => {
    await runtime.close();
    reopened.close();
  });
  const restored = runtime.scheduler.state("agent-0");
  assert.equal(restored.tasks[0].nextRunAt, saved.nextRunAt);
  assert.equal(restored.history[0].status, "unknown");
  assert.equal(restored.history[0].reason, "RESTART_INTERRUPTED_DO_NOT_REPLAY");
});

test("preview marks scheduler quiet hours for group targets but not private targets", (t) => {
  const f = setup(t);
  f.runtime.agent("agent-0").scheduler.quietEnabled = true;
  const input = task({
    targets: ["group:20000"],
    schedule: { type: "daily", times: ["01:00"] },
  });
  assert.ok(f.s.preview("agent-0", input).every((r) => r.silenced));
  assert.ok(
    f.s
      .preview("agent-0", { ...input, targets: ["private:30000"] })
      .every((r) => !r.silenced),
  );
});
