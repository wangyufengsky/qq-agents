import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { randomBytes } from "node:crypto";
import { fixture } from "./helpers.mjs";
import { createServer } from "../src/server.mjs";
import { activityPage } from "../src/core/activity.mjs";

// The console follows a card, a mood or a turn to the records it points at:
// messages sent under a card version, chats with the person, diaries written
// in a mood, and what a turn was shown. All read by reference.
const group = "group:20000",
  dm = "private:30000";
const T0 = Date.parse("2026-10-29T08:00:00Z");
const at = (s) => new Date(T0 + s * 1000).toISOString();
let n = 0;
const said = (m, conversation, senderId, s, body = "说话") =>
  m.append({
    dedupe: "links-" + ++n,
    conversation,
    kind: "message.received",
    senderId,
    body,
    occurredAt: at(s),
    observedAt: at(s),
  });
const sent = (m, conversation, s, body, personCard) =>
  m.append({
    dedupe: "links-" + ++n,
    conversation,
    kind: "message.sent",
    direction: "out",
    senderId: "10000",
    body,
    occurredAt: at(s),
    observedAt: at(s),
    payload: personCard ? { personCard } : {},
  });

async function console_(t, f) {
  const token = randomBytes(32).toString("hex"),
    app = createServer({ runtime: f.runtime, token });
  const port = await app.listen();
  t.after(() => app.close());
  return async (route) => {
    const r = await fetch(`http://127.0.0.1:${port}${route}`, {
      headers: { "x-admin-token": token },
    });
    return { ok: r.ok, body: await r.json() };
  };
}

function scripts(names, extra = {}) {
  const sandbox = vm.createContext({
    $: () => null,
    esc: (x) =>
      String(x ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`),
    input: () => "",
    conversationLabel: (c) =>
      c.replace(/^group:/, "群 ").replace(/^private:/, "私聊 "),
    tag: () => "",
    CustomEvent,
    document: {
      querySelectorAll: () => [],
      addEventListener: () => {},
    },
    ...extra,
  });
  for (const name of names)
    vm.runInContext(
      fs.readFileSync(new URL(`../public/${name}`, import.meta.url), "utf8"),
      sandbox,
    );
  return sandbox;
}

test("a card's panel lists what was sent under each version and where the person spoke", async (t) => {
  const f = fixture(t),
    m = f.store.bind("agent-0");
  const first = said(m, group, "30000", 0, "以后叫我阿明");
  const v1 = m.identity.savePersonCard(
    { personId: "30000", call: "阿明", body: "老朋友", evidence: [first.id] },
    { writtenIn: group, now: T0 },
  );
  for (let i = 1; i <= 4; i++)
    sent(m, group, i, `阿明你好 ${i}`, {
      id: v1.id,
      personId: "30000",
      revision: 1,
    });
  const v2 = m.identity.savePersonCard(
    {
      personId: "30000",
      call: "明哥",
      body: "老朋友，喜欢被叫明哥",
      evidence: [first.id],
      expectedRevision: 1,
    },
    { writtenIn: group, now: T0 + 10000 },
  );
  sent(m, dm, 20, "明哥<早>", { id: v2.id, personId: "30000", revision: 2 });
  // Not resting on this card: no reference, or a card since deleted.
  sent(m, dm, 21, "没有依据的一句");
  sent(m, dm, 22, "旧卡", { id: "gone", personId: "30000", revision: 1 });
  said(m, group, "30000", 30);
  const lastInGroup = said(m, group, "30000", 40);
  const lastInDm = said(m, dm, "30000", 50);
  said(m, group, "30001", 60);

  const api = await console_(t, f);
  const links = await api(
    "/api/person-card/links?agentId=agent-0&personId=30000",
  );
  assert.equal(links.ok, true);
  assert.deepEqual(
    links.body.sent.map((g) => [g.revision, g.count, g.recent.length]),
    [
      [2, 1, 1],
      [1, 4, 3],
    ],
  );
  assert.deepEqual(
    links.body.sent[1].recent.map((x) => x.text),
    ["阿明你好 4", "阿明你好 3", "阿明你好 2"],
  );
  assert.equal(links.body.sent[0].recent[0].conversation, dm);
  assert.deepEqual(
    links.body.chats.map((c) => [c.conversation, c.messages, c.lastId]),
    [
      [dm, 1, lastInDm.id],
      [group, 3, lastInGroup.id],
    ],
  );
  // No card yet: nothing sent under one, but chats still show.
  const stranger = await api(
    "/api/person-card/links?agentId=agent-0&personId=30001",
  );
  assert.deepEqual(stranger.body.sent, []);
  assert.deepEqual(
    stranger.body.chats.map((c) => c.conversation),
    [group],
  );
  assert.equal(
    (await api("/api/person-card/links?agentId=agent-0&personId=abc")).ok,
    false,
  );

  // The panel leaves a slot under each version and renders it escaped.
  const ui = scripts(["people-ui.js"]);
  ui.card = { ...m.identity.personCard("30000"), names: [] };
  const detail = vm.runInContext("personDetail(card)", ui);
  assert.match(detail, /data-rev-sent="2" hidden/);
  assert.match(detail, /data-rev-sent="1" hidden/);
  assert.match(detail, /id="person-chats" hidden/);
  ui.links = links.body;
  const under = vm.runInContext("personSent(links.sent[0])", ui);
  assert.match(under, /这一版下发出 1 条/);
  assert.match(under, /明哥&#60;早&#62;/);
  assert.match(
    under,
    new RegExp(`data-read-record="${links.body.sent[0].recent[0].id}"`),
  );
  assert.match(
    vm.runInContext("personSent(links.sent[1])", ui),
    /另有 1 条更早的/,
  );
  const chats = vm.runInContext("personChats(links.chats)", ui);
  assert.match(chats, /最近聊天[\s\S]*私聊 30000[\s\S]*说过 1 条/);
  assert.match(chats, /data-chat="1"/);
});

test("the mood timeline lists the diaries written while each mood held", async (t) => {
  const f = fixture(t),
    m = f.store.bind("agent-0");
  const happy = m.identity.setMood(
    { mood: "开心", intensity: 3, reason: "吃到蛋糕" },
    { writtenIn: group, now: Date.now() },
  );
  const cake = m.diaryWrite({ title: "蛋糕<甜>", body: "好吃" });
  await new Promise((r) => setTimeout(r, 2));
  const again = m.diaryWrite({ title: "还想吃", body: "明天再买" });
  const calm = m.identity.setMood(
    { mood: "平静", intensity: 2, reason: "吃饱了" },
    { writtenIn: group, now: Date.now() + 1 },
  );
  const walk = m.diaryWrite({ title: "散步", body: "晚上走走" });

  const api = await console_(t, f);
  const { body } = await api("/api/mind?agentId=agent-0");
  const byId = new Map(body.mood.history.map((x) => [x.id, x]));
  assert.deepEqual(
    byId.get(happy.id).diaries.map((d) => d.id),
    [again.id, cake.id],
  );
  assert.deepEqual(
    byId.get(calm.id).diaries.map((d) => d.title),
    ["散步"],
  );
  assert.deepEqual(Object.keys(byId.get(calm.id).diaries[0]).sort(), [
    "id",
    "title",
    "updatedAt",
  ]);

  // A title opens the diary for this role, from the mood tab.
  const opened = [],
    buttons = [{ dataset: { readDiary: walk.id } }];
  const ui = scripts(["mood-ui.js"], {
    readMemory: (id, options) => opened.push([id, options]),
    document: {
      querySelectorAll: (s) =>
        s === ".mood-card [data-read-diary]" ? buttons : [],
      addEventListener: () => {},
    },
  });
  ui.mood = body.mood;
  const markup = vm.runInContext("moodMarkup(mood, Date.now())", ui);
  assert.match(markup, /当时写的日记/);
  assert.match(markup, /data-read-diary="[^"]+"[^>]*>蛋糕&#60;甜&#62;</);
  vm.runInContext("drawMoodChart = () => {}", ui);
  vm.runInContext("bindMood(mood, Date.now(), 'agent-0')", ui);
  buttons[0].onclick();
  // Options come from the script's own realm, so compare their fields.
  assert.deepEqual(
    opened.map(([id, o]) => [id, o.agentId]),
    [[walk.id, "agent-0"]],
  );
});

test("each activity entry shows the mood and cards its turn was shown", (t) => {
  const f = fixture(t),
    m = f.store.bind("agent-0");
  const e = said(m, group, "30000", 0);
  const ming = m.identity.savePersonCard(
    { personId: "30000", call: "阿明", body: "老朋友", evidence: [e.id] },
    { writtenIn: group, now: T0 },
  );
  m.identity.savePersonCard(
    { personId: "30001", call: "小新", body: "新朋友", evidence: [e.id] },
    { writtenIn: group, now: T0 },
  );
  const mood = m.identity.setMood(
    { mood: "开心", intensity: 3, reason: "群里热闹" },
    { writtenIn: group, now: T0 },
  );
  const cleared = m.identity.setMood(
    { clear: true, reason: "回到平常" },
    { writtenIn: group, now: T0 + 1 },
  );
  const turn = (id, start, extra) =>
    m.identity.put("model_turns", {
      id,
      conversation: group,
      startedAt: T0 + start * 1000,
      endedAt: T0 + (start + 30) * 1000,
      status: "completed-no-send",
      reason: ["mention"],
      ...extra,
    });
  turn("saw", 100, {
    moodShown: mood.id,
    personCards: [
      { id: ming.id, personId: "30000", revision: 1 },
      // Recorded before cards carried an id: matched by person and revision.
      { personId: "30001", revision: 1 },
      // Deleted since.
      { id: "gone", personId: "30002", revision: 3 },
    ],
  });
  turn("passed", 200, { moodShown: cleared.id });
  turn("plain", 300, {});
  const items = activityPage(f.store, "agent-0", {
    now: T0 + 400000,
  }).items;
  const of = (id) => items.find((x) => x.turnId === id);
  assert.deepEqual(of("saw").seen, {
    mood: { mood: "开心", intensity: 3 },
    personCards: [
      { personId: "30000", revision: 1, call: "阿明" },
      { personId: "30001", revision: 1, call: "小新" },
      { personId: "30002", revision: 3, deleted: true },
    ],
  });
  assert.deepEqual(of("passed").seen, { mood: { cleared: true } });
  assert.equal("seen" in of("plain"), false);

  const ui = scripts(["activity-ui.js"]);
  ui.entry = of("saw");
  assert.match(
    vm.runInContext("activitySeen(entry.seen)", ui),
    /这一轮附上的心情：开心（强度 3） · 人物卡：阿明 v1、小新 v1、30002 v3（已删除）/,
  );
  ui.entry = of("passed");
  assert.match(
    vm.runInContext("activitySeen(entry.seen)", ui),
    /心情：已经过去/,
  );
  assert.equal(vm.runInContext("activitySeen(undefined)", ui), "");
});
