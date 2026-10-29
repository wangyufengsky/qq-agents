import test from "node:test";
import assert from "node:assert/strict";
import { fixture, config, settle } from "./helpers.mjs";

const scope = "group:20000";
const MINUTE = 60000;
const SURPRISE = "SURPRISE_TEXT 生日快乐，蛋糕在冰箱第二层";
const LINE = "这个聊天接下来的定时任务";
const GONE = "现在没有待执行的定时任务";
function setup(t) {
  const c = config(1),
    a = c.agents[0];
  a.ownerIds = ["30000"];
  a.subject.enabled = true;
  a.subject.groups = ["20000"];
  Object.assign(a.scheduler, {
    enabled: true,
    quietEnabled: false,
    jitterMin: 0,
  });
  const prompts = [];
  const f = fixture(t, {
    cfg: c,
    run: async (p) => {
      prompts.push({ conversation: p.conversation, prompt: p.prompt });
      p.saveSession({ id: "s-" + p.conversation, backend: "fixture" });
    },
  });
  // 08:00 in the agent's time zone (Asia/Shanghai).
  let now = Date.parse("2026-10-25T00:00:00Z");
  f.runtime.clock = () => new Date(now);
  const last = () => prompts.at(-1).prompt;
  return {
    ...f,
    s: f.runtime.scheduler,
    prompts,
    last,
    advance: (ms) => (now += ms),
    turn: async (conversation = scope) => {
      await f.runtime.wake("agent-0", conversation);
      return last();
    },
  };
}
const task = (patch = {}) => ({
  name: "晚安",
  kind: "text",
  text: SURPRISE,
  targets: [scope],
  schedule: { type: "daily", times: ["22:00"] },
  ...patch,
});
const listed = (prompt) =>
  JSON.parse(prompt.split(LINE)[1].split("）：")[1].split("\n\n")[0]);

test("upcoming lists only enabled tasks for one chat, soonest first, without text or instruction", (t) => {
  const f = setup(t);
  const late = f.s.create("agent-0", task());
  const soon = f.s.create(
    "agent-0",
    task({
      name: "早报",
      kind: "ai",
      instruction: "SECRET_INSTRUCTION 讲讲今天的新闻",
      schedule: { type: "daily", times: ["09:00"] },
    }),
  );
  f.s.create("agent-0", task({ targets: ["group:20001"] }));
  f.s.create("agent-0", task({ enabled: false }));
  const upcoming = f.s.upcoming("agent-0", scope);
  assert.deepEqual(
    upcoming.map((x) => x.id),
    [soon.id, late.id],
  );
  assert.doesNotMatch(JSON.stringify(upcoming), /SURPRISE|SECRET/);
  assert.equal(upcoming[0].nextRunAt, Date.parse("2026-10-25T01:00:00Z"));
  // A name /remind cut from the text would give the text away.
  const reminded = f.s.create(
    "agent-0",
    task({
      name: SURPRISE.slice(0, 20),
      schedule: { type: "daily", times: ["23:00"] },
    }),
  );
  assert.equal(
    f.s.upcoming("agent-0", scope).find((x) => x.id === reminded.id).name,
    "",
  );
  f.runtime.config.agents[0].scheduler.enabled = false;
  assert.deepEqual(f.s.upcoming("agent-0", scope), []);
});

test("a chat is told its coming tasks once per session, and again only when the list changes", async (t) => {
  const f = setup(t);
  // Nothing scheduled: nothing said.
  assert.doesNotMatch(await f.turn(), new RegExp(LINE + "|" + GONE));
  const evening = f.s.create("agent-0", task());
  f.s.create(
    "agent-0",
    task({
      name: "早报",
      kind: "ai",
      instruction: "SECRET_INSTRUCTION 讲讲今天的新闻",
      schedule: { type: "daily", times: ["09:00"] },
    }),
  );
  const first = await f.turn();
  assert.match(first, new RegExp(LINE));
  assert.match(first, /管理员安排的/);
  assert.match(first, /不要再答应一遍同样的事/);
  const { tasks } = listed(first);
  assert.deepEqual(tasks, [
    {
      name: "早报",
      kind: "AI 任务",
      next: "2026-10-25 09:00（北京时间 UTC+8）",
      rule: "每天 09:00",
    },
    {
      name: "晚安",
      kind: "固定文字",
      next: "2026-10-25 22:00（北京时间 UTC+8）",
      rule: "每天 22:00",
    },
  ]);
  assert(!first.includes(SURPRISE));
  assert.doesNotMatch(first, /SECRET_INSTRUCTION/);

  assert.doesNotMatch(await f.turn(), new RegExp(LINE));

  // The AI task's own run moves it to tomorrow; that is no change.
  f.advance(60 * MINUTE + 1);
  f.runtime.tick();
  await settle(f.runtime);
  const scheduled = f.last();
  assert.match(scheduled, /"reason":"scheduled"/);
  assert.doesNotMatch(scheduled, new RegExp(LINE + "|" + GONE));

  // Rescheduled by the administrator: told again, with the new time.
  f.s.update("agent-0", evening.id, {
    schedule: { type: "daily", times: ["21:30"] },
  });
  const moved = await f.turn();
  assert.match(moved, new RegExp(LINE));
  // Soonest first: today's 21:30 before tomorrow's 09:00.
  assert.deepEqual(
    listed(moved).tasks.map((x) => [x.name, x.rule, x.next]),
    [
      ["晚安", "每天 21:30", "2026-10-25 21:30（北京时间 UTC+8）"],
      ["早报", "每天 09:00", "2026-10-26 09:00（北京时间 UTC+8）"],
    ],
  );
  assert.doesNotMatch(await f.turn(), new RegExp(LINE));

  // Added: told again.
  f.s.create(
    "agent-0",
    task({
      name: "周报",
      schedule: { type: "weekly", weekdays: [5], times: ["18:00"] },
    }),
  );
  assert.match(await f.turn(), new RegExp(LINE));

  // A new session starts with nothing seen. Its handoff does not list the
  // same tasks again, and the fixed text is in neither.
  f.runtime.contexts.retire("agent-0", scope, "test");
  const fresh = await f.turn();
  assert.equal(listed(fresh).tasks.length, 3);
  const handoff = JSON.parse(fresh.split("程序交接状态：")[1].split("\n\n")[0]);
  assert.deepEqual(handoff.scheduled, []);
  assert(!fresh.includes(SURPRISE));
  assert.doesNotMatch(fresh, /SECRET_INSTRUCTION/);

  // Every task removed: told once that none is left.
  for (const t of f.s.state("agent-0").tasks) f.s.remove("agent-0", t.id);
  assert.match(await f.turn(), new RegExp(GONE));
  assert.doesNotMatch(await f.turn(), new RegExp(LINE + "|" + GONE));
});

test("at most three tasks are listed, the rest counted", async (t) => {
  const f = setup(t);
  for (const time of ["10:00", "11:00", "12:00", "13:00"])
    f.s.create(
      "agent-0",
      task({
        name: "整点 " + time,
        schedule: { type: "daily", times: [time] },
      }),
    );
  const prompt = await f.turn();
  const shown = listed(prompt);
  assert.deepEqual(
    shown.tasks.map((x) => x.name),
    ["整点 10:00", "整点 11:00", "整点 12:00"],
  );
  assert.equal(shown.more, 1);
  // The fourth is still in the handoff, without its text.
  const handoff = JSON.parse(
    prompt.split("程序交接状态：")[1].split("\n\n")[0],
  );
  assert.deepEqual(
    handoff.scheduled.map((x) => x.name),
    ["整点 13:00"],
  );
  assert(!prompt.includes(SURPRISE));
});

test("a task on another clock names its zone beside the rule; the next run is local", async (t) => {
  const f = setup(t);
  f.s.create(
    "agent-0",
    task({
      timezone: "America/New_York",
      schedule: { type: "daily", times: ["09:00"] },
    }),
  );
  f.s.create(
    "agent-0",
    task({ name: "本地", schedule: { type: "daily", times: ["22:00"] } }),
  );
  const { tasks } = listed(await f.turn());
  assert.deepEqual(
    tasks.map((x) => [x.next, x.rule]),
    [
      [
        "2026-10-25 21:00（北京时间 UTC+8）",
        "每天 09:00（America/New_York 时间）",
      ],
      ["2026-10-25 22:00（北京时间 UTC+8）", "每天 22:00"],
    ],
  );
});

test("free time and other chats get no coming-up line, and never the fixed text", async (t) => {
  const f = setup(t);
  f.s.create("agent-0", task());
  f.s.create("agent-0", task({ name: SURPRISE.slice(0, 20) }));
  const subject = await f.turn("@subject");
  assert.doesNotMatch(subject, new RegExp(LINE));
  assert.match(subject, /晚安/);
  assert(!subject.includes(SURPRISE.slice(0, 20)));
  const other = await f.turn("group:20001");
  assert.doesNotMatch(other, new RegExp(LINE));
  const here = await f.turn();
  assert.match(here, new RegExp(LINE));
  assert(!here.includes(SURPRISE.slice(0, 20)));
  assert.equal(f.store.bind("agent-0").state(scope).scheduleShown.length, 64);
});
