import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { randomBytes } from "node:crypto";
import { fixture } from "./helpers.mjs";
import { createServer } from "../src/server.mjs";
import { activityPage } from "../src/core/activity.mjs";

// The console's pages point at each other: a home card shows the role's
// mood, an activity entry opens what it sent, wrote and heard, and people
// named in memory results, activity and contacts open their person cards.
const group = "group:20000",
  dm = "private:30000";
const T0 = Date.parse("2026-10-29T08:00:00Z");
const at = (s) => new Date(T0 + s * 1000).toISOString();
let n = 0;
const append = (m, conversation, kind, s, extra) =>
  m.append({
    dedupe: "cross-" + ++n,
    conversation,
    kind,
    occurredAt: at(s),
    observedAt: at(s),
    ...extra,
  });
const heard = (m, conversation, senderId, s, body = "说话", name = "") =>
  append(m, conversation, "message.received", s, {
    senderId,
    body,
    payload: name ? { raw: { sender: { nickname: name } } } : {},
  });
const said = (m, conversation, s, body, kind = "message.sent") =>
  append(m, conversation, kind, s, {
    direction: "out",
    senderId: "10000",
    body,
  });
const turn = (m, id, conversation, start, extra = {}) =>
  m.identity.put("model_turns", {
    id,
    conversation,
    startedAt: T0 + start * 1000,
    endedAt: T0 + (start + 60) * 1000,
    status: "completed-no-send",
    reason: ["mention"],
    ...extra,
  });
const card = (m, personId, call, evidence) =>
  m.identity.savePersonCard(
    { personId, call, body: "老朋友", evidence: [evidence] },
    { writtenIn: group, now: T0 },
  );

async function consoleApi(t, f) {
  const token = randomBytes(32).toString("hex"),
    app = createServer({ runtime: f.runtime, token });
  const port = await app.listen();
  t.after(() => app.close());
  const request = (route) =>
    fetch(`http://127.0.0.1:${port}${route}`, {
      headers: { "x-admin-token": token },
    });
  const api = async (route) => {
    const r = await request(route);
    return { ok: r.ok, body: await r.json() };
  };
  return { api, request };
}

// Elements the markup rendered that carry `attr`, as stubs with their data-*
// attributes; a click is calling the onclick a script gave them.
function stubs(html, attr) {
  return [...html.matchAll(/<[a-z]+\b[^>]*>/g)]
    .map(([tag]) => tag)
    .filter((tag) => tag.includes(` ${attr}=`))
    .map((tag) => ({
      dataset: Object.fromEntries(
        [...tag.matchAll(/ data-([\w-]+)="([^"]*)"/g)].map(([, k, v]) => [
          k.replace(/-(\w)/g, (_, c) => c.toUpperCase()),
          v,
        ]),
      ),
    }));
}
function stubNode() {
  const node = {
    innerHTML: "",
    found: {},
    addEventListener() {},
    insertAdjacentHTML() {},
    showModal() {
      this.open = true;
    },
    querySelectorAll(selector) {
      return (node.found[selector] = stubs(
        node.innerHTML,
        selector.slice(1, -1),
      ));
    },
  };
  return node;
}
// An event bus standing in for document, so open-person-card reaches the
// people script's listener.
function stubDocument(node, all = () => []) {
  const listeners = {};
  return {
    querySelector: node,
    querySelectorAll: all,
    body: { classList: { remove() {}, toggle() {} } },
    addEventListener: (type, fn) => (listeners[type] = fn),
    dispatchEvent: (e) => listeners[e.type]?.(e),
  };
}
const run = (sandbox, names) => {
  for (const name of names)
    vm.runInContext(
      fs.readFileSync(new URL(`../public/${name}`, import.meta.url), "utf8"),
      sandbox,
    );
  // Rendering a whole page needs a real DOM; record where it would go.
  vm.runInContext('render = () => rendered.push(tab + " " + roleId)', sandbox);
};
// The real console: app.js with the people script, against a real server.
function consoleScripts(f, request) {
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, stubNode());
    return nodes.get(id);
  };
  const sandbox = vm.createContext({
    document: stubDocument(node),
    sessionStorage: { getItem: () => "" },
    setInterval() {},
    setTimeout() {},
    clearTimeout() {},
    fetch: request,
    URLSearchParams,
    CustomEvent,
    initialConfig: f.runtime.config,
    rendered: [],
  });
  run(sandbox, ["app.js", "people-ui.js"]);
  vm.runInContext("config = initialConfig", sandbox);
  return { sandbox, node };
}
const until = async (check) => {
  for (let i = 0; i < 200 && !check(); i++)
    await new Promise((r) => setTimeout(r, 10));
  assert.ok(check());
};

test("a home card shows the mood still in effect and opens the mood tab", async (t) => {
  const f = fixture(t);
  f.runtime.clock = () => new Date(T0);
  const happy = f.store
    .bind("agent-0")
    .identity.setMood(
      { mood: "开心<b>", intensity: 3, reason: "群里热闹", hours: 2 },
      { writtenIn: group, now: T0 - 600000 },
    );
  // agent-1's mood has run out; agent-2 wrote that its mood passed.
  f.store
    .bind("agent-1")
    .identity.setMood(
      { mood: "烦", intensity: 2, reason: "等太久", hours: 0.5 },
      { writtenIn: group, now: T0 - 3600000 },
    );
  const m2 = f.store.bind("agent-2");
  m2.identity.setMood(
    { mood: "累", intensity: 2, reason: "忙了一天" },
    { writtenIn: group, now: T0 - 60000 },
  );
  m2.identity.setMood(
    { clear: true, reason: "睡了一觉" },
    { writtenIn: group, now: T0 - 1000 },
  );
  const { api, request } = await consoleApi(t, f);
  const home = (await api("/api/home")).body;
  const of = (id) => home.agents.find((x) => x.agentId === id);
  assert.deepEqual(of("agent-0").mood, {
    mood: "开心<b>",
    intensity: 3,
    expiresAt: happy.expiresAt,
  });
  assert.equal(of("agent-1").mood, null);
  assert.equal(of("agent-2").mood, null);

  const { sandbox, node } = consoleScripts(f, request);
  const today = new Date(),
    tomorrow = new Date();
  today.setHours(22, 30, 0, 0);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(8, 5, 0, 0);
  sandbox.moods = {
    today: { mood: { mood: "开心<b>", intensity: 3, expiresAt: +today } },
    tomorrow: { mood: { mood: "困", intensity: 1, expiresAt: +tomorrow } },
    calm: { mood: null },
  };
  const line = (key) =>
    vm.runInContext(
      `homeMood(find("agents", "agent-0"), ${key ? `moods.${key}` : "undefined"})`,
      sandbox,
    );
  assert.match(
    line("today"),
    /<button type="button" class="home-mood" data-do="role-mood" data-id="agent-0"[^>]*>心情：开心&lt;b&gt;（3\/5）· 到 22:30<\/button>/,
  );
  // A mood that lasts past midnight names the day it ends.
  assert.match(line("tomorrow"), /心情：困（1\/5）· 到 \d+\/\d+ 08:05/);
  assert.match(
    line("calm"),
    /class="home-mood is-calm" data-do="role-mood"[^>]*>心情：平常</,
  );
  // Before the summary arrives there is nothing to say.
  assert.equal(line(), "");

  // The summary fills the cards after the page drew them; the mood line
  // still opens the role's mood tab.
  vm.runInContext(
    'tab = "overview"; status = { agents: [], connections: [], backends: [] }',
    sandbox,
  );
  vm.runInContext("loadHome()", sandbox);
  const box = node("#home-roles");
  await until(() => box.innerHTML.includes("开心&lt;b&gt;"));
  assert.match(box.innerHTML, /data-id="agent-1"[^>]*>心情：平常/);
  const mood = box.found["[data-do]"].find(
    (b) => b.dataset.do === "role-mood" && b.dataset.id === "agent-0",
  );
  mood.onclick();
  await until(() => sandbox.rendered.length);
  assert.deepEqual(sandbox.rendered, ["mood agent-0"]);
});

test("activity entries carry the records they point at", (t) => {
  const f = fixture(t),
    m = f.store.bind("agent-0");
  const ming = heard(m, dm, "30000", 0, "以后叫我阿明");
  card(m, "30000", "阿<明>", ming.id);
  // Replied: read around its first sent message.
  heard(m, group, "30001", 90, "有人在吗");
  const reply = said(m, group, 105, "在的");
  said(m, group, 110, "第二句");
  turn(m, "replied", group, 100, { status: "sent" });
  const diary = m.diaryWrite({ title: "今天<聊天>", body: "很热闹" });
  m.db
    .prepare("UPDATE diaries SET created_at=?, updated_at=? WHERE id=?")
    .run(at(120), at(120), diary.id);
  // Stayed quiet: read around the last message it heard before it started.
  heard(m, group, "30001", 280, "早");
  const last = heard(m, group, "30002", 295, "早上好");
  heard(m, group, "30002", 305, "开始以后才到的");
  turn(m, "quiet", group, 300);
  // Only a poke: an action has no place on the message timeline.
  const before = heard(m, dm, "30000", 490, "戳我一下");
  said(m, dm, 505, "（戳一戳）", "action.confirmed");
  turn(m, "poked", dm, 500, { status: "sent" });
  // Nothing heard within the hour before, nothing sent: nowhere to read.
  turn(m, "alone", "private:30003", 9000);
  turn(m, "free", "@subject", 600, { reason: ["subject-opportunity"] });
  // Intents: a private target with a card, one without, and a group.
  const intent = (id, target, extra) =>
    m.identity.put("intentions", {
      id,
      topic: "想说的事 " + id,
      target,
      status: "waiting",
      createdIn: "@subject",
      createdAt: T0 + 610000,
      history: [],
      ...extra,
    });
  intent("to-ming", dm);
  intent("to-stranger", "private:30003");
  intent("to-group", group);
  intent("decided", dm, {
    createdAt: T0,
    history: [{ status: "completed", at: T0 + 510000 }],
  });

  const items = activityPage(f.store, "agent-0", {
    now: T0 + 9999000,
  }).items;
  const of = (id) => items.find((x) => x.turnId === id);
  const replied = of("replied");
  assert.deepEqual(
    replied.sent.map((s) => s.text),
    ["在的", "第二句"],
  );
  assert.equal(replied.sent[0].id, reply.id);
  assert.equal(replied.contextId, reply.id);
  assert.deepEqual(replied.diaries, [
    { id: diary.id, title: "今天<聊天>", revised: false },
  ]);
  assert.equal(of("quiet").contextId, last.id);
  assert.equal(of("poked").contextId, before.id);
  assert.equal(of("alone").contextId, null);
  assert.equal(of("free").contextId, null);
  const created = of("free").intents.created;
  const target = (id) => created.find((i) => i.topic === "想说的事 " + id);
  assert.deepEqual(target("to-ming").person, {
    personId: "30000",
    call: "阿<明>",
  });
  assert.equal("person" in target("to-stranger"), false);
  assert.equal("person" in target("to-group"), false);
  assert.deepEqual(of("poked").intents.decided, [
    {
      topic: "想说的事 decided",
      status: "completed",
      person: { personId: "30000", call: "阿<明>" },
    },
  ]);

  // The page renders each link escaped and wires it to this role.
  const list = stubNode(),
    calls = [];
  const sandbox = vm.createContext({
    $: (s) => (s === "#activity-list" ? list : null),
    esc: (x) =>
      String(x ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`),
    conversationLabel: (c) =>
      c.replace(/^group:/, "群 ").replace(/^private:/, "私聊 "),
    tag: () => "",
    action: (fn) => fn(),
    readMemory: (id, o) => calls.push(["read", id, o.agentId]),
    readConversation: (o) =>
      calls.push(["context", o.aroundId, o.agentId, o.contextSeconds]),
    CustomEvent,
    document: stubDocument(() => null),
    roleId: "agent-0",
    tab: "activity",
    rendered: [],
    items,
  });
  run(sandbox, ["activity-ui.js", "people-ui.js"]);
  vm.runInContext(
    'activityItems = items; activityAgentId = "agent-1"; activityList()',
    sandbox,
  );
  const html = list.innerHTML;
  assert.match(
    html,
    new RegExp(
      `<p>在的</p><button type="button" class="ghost act-open" data-act-read="${reply.id}">读原文</button>`,
    ),
  );
  assert.match(
    html,
    new RegExp(
      `写日记：<button type="button" class="act-link" data-act-read="${diary.id}"[^>]*>今天&#60;聊天&#62;</button>`,
    ),
  );
  assert.match(
    html,
    /想告诉 私聊 30000（叫「阿&#60;明&#62;」）：想说的事 to-ming（等待时机）<button type="button" class="ghost person-open" data-open-person="30000"/,
  );
  assert.match(
    html,
    /想告诉 私聊 30003：想说的事 to-stranger（等待时机）<\/p>/,
  );
  assert.match(html, /想告诉 群 20000：想说的事 to-group（等待时机）<\/p>/);
  assert.match(
    html,
    /处理主动意图「想说的事 decided」：完成 · 对方叫「阿&#60;明&#62;」<button[^>]*data-open-person="30000"/,
  );
  assert.equal(html.split("data-act-context=").length - 1, 3);
  assert.equal(html.split("data-open-person=").length - 1, 2);

  // Clicks open the records for the role whose activity is shown, which the
  // page's own picker set; the person card opens under that role too.
  // Newest first: the poke, then the quiet turn, then the reply.
  list.found["[data-act-read]"].forEach((b) => b.onclick());
  list.found["[data-act-context]"].forEach((b) => b.onclick());
  assert.deepEqual(calls, [
    ["read", of("poked").sent[0].id, "agent-1"],
    ["read", reply.id, "agent-1"],
    ["read", replied.sent[1].id, "agent-1"],
    ["read", diary.id, "agent-1"],
    ["context", before.id, "agent-1", 1800],
    ["context", last.id, "agent-1", 1800],
    ["context", reply.id, "agent-1", 1800],
  ]);
  list.found["[data-open-person]"][0].onclick();
  assert.equal(vm.runInContext("peopleOpen", sandbox), "30000");
  assert.deepEqual(sandbox.rendered, ["people agent-1"]);
});

test("memory results name speakers by their card and open it under the searched role", async (t) => {
  const f = fixture(t),
    m = f.store.bind("agent-1");
  const first = heard(m, group, "30000", 0, "以后叫我阿明", "老王");
  heard(m, group, "30001", 5, "我没有卡", "路人");
  heard(m, group, "30002", 10, "卡上没写称呼", "小李");
  card(m, "30000", "阿<明>", first.id);
  card(m, "30002", "", first.id);
  // A card for someone not on this page stays out of the map.
  card(m, "30005", "不相干", first.id);
  const match = heard(m, group, "30000", 15, "约好的蛋糕", "老王");

  const { api, request } = await consoleApi(t, f);
  const result = (
    await api(
      "/api/memory?" +
        new URLSearchParams({ agentId: "agent-1", query: "蛋糕" }),
    )
  ).body;
  assert.equal(result.items[0].id, match.id);
  assert.deepEqual(result.items[0].scene.participants.map((p) => p.id).sort(), [
    "30000",
    "30001",
    "30002",
  ]);
  assert.deepEqual(result.people, {
    30000: { call: "阿<明>" },
    30002: { call: "" },
  });
  // No speakers, no map entries; another role's cards are its own.
  assert.deepEqual(
    (
      await api(
        "/api/memory?" +
          new URLSearchParams({ agentId: "agent-0", query: "蛋糕" }),
      )
    ).body.people,
    {},
  );

  const { sandbox, node } = consoleScripts(f, request);
  for (const [id, value] of [
    ["#memory-agent", "agent-1"],
    ["#memory-query", "蛋糕"],
    ["#memory-type", "all"],
    ["#memory-person", ""],
    ["#memory-source", ""],
  ])
    node(id).value = value;
  vm.runInContext('roleId = "agent-0"', sandbox);
  await vm.runInContext("searchMemory()", sandbox);
  const results = node("#memory-results");
  const html = results.innerHTML;
  // The result row and each scene line name a carded speaker by their call.
  assert.match(
    html,
    /<small>group:20000 · <span title="QQ 30000">老王<\/span>（叫「阿&lt;明&gt;」）<button type="button" class="ghost person-open" data-open-person="30000"/,
  );
  assert.match(html, /路人（30001）/);
  assert.match(
    html,
    /<span title="QQ 30002">小李<\/span>（未记称呼）<button[^>]*data-open-person="30002"/,
  );
  assert.match(
    html,
    /片段内发言者：[^]*<span title="QQ 30000">老王<\/span>（叫「阿&lt;明&gt;」，1 条）<button[^>]*data-open-person="30000"/,
  );
  assert.match(html, /路人（30001，1 条）/);
  assert.doesNotMatch(html, /30005/);

  // The picker moves on; the card still opens under the role searched.
  node("#memory-agent").value = "agent-2";
  results.found["[data-open-person]"][0].onclick();
  assert.equal(vm.runInContext("peopleOpen", sandbox), "30000");
  assert.deepEqual(sandbox.rendered, ["people agent-1"]);
});

test("the contacts tab names private targets by their card; the mood tab opens cards under its role", (t) => {
  const cards = [{ personId: "30000", call: "阿<明>" }],
    clicks = [];
  const sandbox = vm.createContext({
    $: () => null,
    esc: (x) =>
      String(x ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`),
    input: () => "",
    conversationLabel: (c) =>
      c.replace(/^group:/, "群 ").replace(/^private:/, "私聊 "),
    CustomEvent,
    document: {
      ...stubDocument(() => null),
      querySelectorAll: (s) =>
        s === "[data-open-person]" || s === "[data-mood-person]" ? clicks : [],
    },
    roleId: "agent-0",
    tab: "intents",
    rendered: [],
  });
  run(sandbox, ["mood-ui.js", "people-ui.js", "mind-ui.js"]);
  const intent = (target) => ({
    id: "i-" + target,
    topic: "想说的事",
    target,
    status: "waiting",
    reason: "惦记着",
    evidence: [],
    history: [],
    revision: 1,
  });
  sandbox.data = {
    intents: [intent(dm), intent("private:30003"), intent(group)],
    personCards: cards,
  };
  const html = vm.runInContext("intentsMarkup(data)", sandbox);
  assert.match(
    html,
    /<p>私聊 30000（叫「阿&#60;明&#62;」）<button type="button" class="ghost person-open" data-open-person="30000"[^>]*>人物卡<\/button> · 惦记着<\/p>/,
  );
  assert.match(html, /<p>private:30003 · 惦记着<\/p>/);
  assert.match(html, /<p>group:20000 · 惦记着<\/p>/);
  assert.equal(html.split("data-open-person=").length - 1, 1);

  // The tab's own picker may show another role than the one selected.
  clicks.push({ dataset: { openPerson: "30000" } });
  vm.runInContext('bindIntents({ id: "agent-2" })', sandbox);
  clicks[0].onclick();
  assert.deepEqual(sandbox.rendered, ["people agent-2"]);

  // So may the mood tab's.
  clicks.length = 0;
  clicks.push({ dataset: { moodPerson: "30000" } });
  vm.runInContext("drawMoodChart = () => {}", sandbox);
  vm.runInContext(
    'bindMood({ current: null, history: [] }, Date.now(), "agent-1")',
    sandbox,
  );
  clicks[0].onclick();
  assert.equal(sandbox.rendered.at(-1), "people agent-1");
});
