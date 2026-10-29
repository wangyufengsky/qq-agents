import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { fixture } from "./helpers.mjs";
import { activityPage, homeSummary } from "../src/core/activity.mjs";
import { createServer } from "../src/server.mjs";

const T0 = Date.parse("2026-10-27T15:02:14Z");
const at = (s) => new Date(T0 + s * 1000).toISOString();
function turn(m, id, conversation, start, extra = {}) {
  m.identity.put("model_turns", {
    id,
    conversation,
    startedAt: T0 + start * 1000,
    endedAt: T0 + (start + 90) * 1000,
    status: "completed-no-send",
    reason: [conversation === "@subject" ? "subject-opportunity" : "mention"],
    ...extra,
  });
}
let n = 0;
function app(m, conversation, s, value) {
  m.append({
    dedupe: "app:" + n++,
    conversation,
    kind: "app.observation",
    direction: "internal",
    observedAt: at(s),
    body: value.title || "",
    payload: { app: { ok: true, origin: "app-browser", ...value } },
  });
}
function seed(m) {
  turn(m, "free", "@subject", 0, {
    toolCalls: [
      { name: "app_browse", ok: true, ms: 1 },
      { name: "app_read", ok: true, ms: 1 },
      { name: "app_comments", ok: true, ms: 1 },
      { name: "subject_log", ok: true, ms: 1 },
    ],
  });
  for (const [key, title] of [
    ["heybox:1", "以前的游戏确实不罐头"],
    ["heybox:2", "ChatGPT 的新说话方式"],
  ])
    app(m, "@subject", 25, {
      platform: "heybox",
      operation: "browse",
      key,
      title,
    });
  app(m, "@subject", 35, {
    platform: "heybox",
    operation: "read",
    key: "heybox:1",
    title: "以前的游戏确实不罐头",
  });
  for (const text of ["村长的房间布置确实挺有钱的", "猎魔人任务就是好"])
    app(m, "@subject", 47, {
      platform: "heybox",
      operation: "comments",
      key: "heybox:1",
      title: "",
      author: "玩家",
      text,
    });
  m.append({
    dedupe: "log:free",
    conversation: "@subject",
    kind: "subject.log",
    direction: "internal",
    observedAt: at(80),
    body: "逛了小黑盒",
    payload: {
      did: "read",
      summary: "逛了小黑盒推荐",
      next: "找剧情材料",
      turnId: "free",
    },
  });
  // Learner turns (left by slang learning, removed in 0.5.3) are internal and
  // never appear on the timeline.
  turn(m, "learn", "learner:group:20000", 200);
  turn(m, "chat", "group:20000", 300);
}

test("a free-time turn groups browsing by content and links its log and diary", (t) => {
  const { store } = fixture(t);
  const m = store.bind("agent-0");
  seed(m);
  const diary = m.diaryWrite(
    { title: "任务不是只有感叹号", body: "……" },
    "ai-diary",
    { conversation: "@subject", connectionId: "qq-0" },
  );
  // Pin the diary inside the turn window.
  m.db
    .prepare("UPDATE diaries SET created_at=?, updated_at=? WHERE id=?")
    .run(at(70), at(70), diary.id);
  const page = activityPage(store, "agent-0", { now: T0 + 3600000 });
  assert.deepEqual(
    page.items.map((e) => e.turnId),
    ["chat", "free"],
  );
  const free = page.items[1];
  assert.equal(free.kind, "subject");
  assert.equal(free.log.summary, "逛了小黑盒推荐");
  assert.deepEqual(free.tools.names, [
    "app_browse",
    "app_read",
    "app_comments",
    "subject_log",
  ]);
  const [read, listed] = free.browsing.items;
  assert.equal(read.title, "以前的游戏确实不罐头");
  assert.equal(read.read, true);
  assert.equal(read.comments.length, 2);
  assert.equal(listed.read, false);
  assert.deepEqual(
    free.diaries.map((d) => d.title),
    ["任务不是只有感叹号"],
  );
  assert.equal(page.items[0].browsing.items.length, 0);
});

test("filters and pagination skip internal learner turns", (t) => {
  const { store } = fixture(t);
  const m = store.bind("agent-0");
  seed(m);
  const ids = (filter, before) =>
    activityPage(store, "agent-0", {
      filter,
      before,
      now: T0 + 3600000,
    }).items.map((e) => e.turnId);
  assert.deepEqual(ids("subject"), ["free"]);
  assert.deepEqual(ids("chat"), ["chat"]);
  assert.deepEqual(ids("browse"), ["free"]);
  for (let i = 0; i < 25; i++) turn(m, "c" + i, "group:20000", 1000 + i);
  const first = activityPage(store, "agent-0", { now: T0 + 3600000 });
  assert.equal(first.items.length, 20);
  assert(first.nextBefore);
  const second = activityPage(store, "agent-0", {
    before: first.nextBefore,
    now: T0 + 3600000,
  });
  assert.deepEqual(
    second.items.map((e) => e.turnId),
    ["c4", "c3", "c2", "c1", "c0", "chat", "free"],
  );
  assert.equal(second.nextBefore, null);
});

test("the activity API validates the filter", async (t) => {
  const f = fixture(t);
  seed(f.store.bind("agent-0"));
  const token = randomBytes(32).toString("hex"),
    app_ = createServer({ runtime: f.runtime, token });
  const port = await app_.listen();
  t.after(() => app_.close());
  const get = (q) =>
    fetch(`http://127.0.0.1:${port}/api/activity?${q}`, {
      headers: { "x-admin-token": token },
    });
  assert.equal((await get("agentId=agent-0&filter=everything")).status, 400);
  const page = await (await get("agentId=agent-0&filter=subject")).json();
  assert.deepEqual(
    page.items.map((e) => e.turnId),
    ["free"],
  );
});

test("the home summary counts the last 24 hours and shows the latest entry", (t) => {
  const { store } = fixture(t);
  const m = store.bind("agent-0");
  seed(m);
  m.append({
    dedupe: "sent:1",
    conversation: "group:20000",
    kind: "message.sent",
    direction: "out",
    observedAt: at(310),
    body: "晚上好",
    payload: {},
  });
  m.setState("@subject", { nextCheckAt: T0 + 3600000 });
  const h = homeSummary(store, "agent-0", { now: T0 + 600000 });
  assert.deepEqual(h.last24h, {
    chatTurns: 1,
    sent: 1,
    freeTime: 1,
    freeTimeActive: 1,
    freeTimeTraced: 1,
    reads: 1,
    diaries: 0,
  });
  assert.equal(h.latest.kind, "chat");
  assert.equal(h.latest.text, "晚上好");
  assert.equal(h.nextFreeTimeAt, T0 + 3600000);
});
