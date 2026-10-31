import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { randomBytes } from "node:crypto";
import { fixture, config } from "./helpers.mjs";
import { createServer } from "../src/server.mjs";

// The role pages read like the home page: what the page is for comes first,
// less-used sections fold with their state on the title line, numbers are
// picked, and long text is cut with the whole of it on hover.
const T0 = Date.now() - 4 * 3600000;
let n = 0;
const heard = (m, conversation, senderId, t, raw = {}) =>
  m.append({
    dedupe: "pages-" + ++n,
    conversation,
    kind: "message.received",
    senderId,
    body: "说话",
    occurredAt: new Date(t).toISOString(),
    observedAt: new Date(t).toISOString(),
    payload: { raw },
  });

async function consoleFixture(t, cfg = config(2)) {
  const f = fixture(t, { cfg }),
    token = randomBytes(32).toString("hex");
  const app = createServer({ runtime: f.runtime, token, allowLive: true });
  const port = await app.listen();
  t.after(() => app.close());
  // The console's own fetch, with the admin token it would have after login.
  const request = (route, options = {}) =>
    fetch(`http://127.0.0.1:${port}${route}`, {
      ...options,
      headers: { ...options.headers, "x-admin-token": token },
    });
  return { ...f, request };
}

// app.js with the role scripts, as the browser loads them. Elements are
// stubs keyed by selector; a page's markup lands in #mind-body.
function consolePage(f) {
  const nodes = new Map(),
    storage = new Map(),
    notices = [];
  const node = (selector) => {
    if (!nodes.has(selector))
      nodes.set(selector, {
        innerHTML: "",
        dataset: {},
        style: {},
        classList: { add() {}, remove() {}, toggle() {} },
        querySelectorAll: () => [],
        addEventListener() {},
      });
    return nodes.get(selector);
  };
  const sandbox = vm.createContext({
    document: {
      querySelector: node,
      querySelectorAll: () => [],
      addEventListener() {},
      body: { classList: { add() {}, remove() {}, toggle() {} } },
    },
    sessionStorage: { getItem: () => "", setItem() {} },
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
    },
    setInterval() {},
    setTimeout() {},
    clearTimeout() {},
    fetch: f.request,
    URLSearchParams,
    CustomEvent,
    structuredClone,
    // A form's fields, read from the markup the way the browser would send it.
    FormData: class {
      constructor(form) {
        this.fields = form.fields;
      }
      get(k) {
        return this.fields.has(k) ? this.fields.get(k) : null;
      }
      has(k) {
        return this.fields.has(k);
      }
    },
    initialConfig: f.runtime.config,
    initialRevision: f.configStore.revision,
    notices,
    filled: [],
  });
  for (const name of [
    "app.js",
    "agent-form.js",
    "mood-ui.js",
    "people-ui.js",
    "mind-ui.js",
  ])
    vm.runInContext(
      fs.readFileSync(new URL(`../public/${name}`, import.meta.url), "utf8"),
      sandbox,
    );
  vm.runInContext(
    `config = initialConfig; revision = initialRevision;
     render = () => {}; notice = (m) => notices.push(m);
     fillIds = (root, agentId) => filled.push(agentId);
     bindMood = () => {}; bindPeople = () => {};`,
    sandbox,
  );
  const show = async (tab, agentId = "agent-0") => {
    vm.runInContext(
      `tab = ${JSON.stringify(tab)}; mindAgentId = ${JSON.stringify(agentId)}`,
      sandbox,
    );
    await vm.runInContext("renderMind()", sandbox);
    return node("#mind-body").innerHTML;
  };
  return { sandbox, node, storage, notices, show };
}
// The folded section `id` as rendered: whether it is open, and its title line.
function section(html, id) {
  const at = html.indexOf(`data-fold="${id}"`);
  assert.ok(at > 0, `section ${id} is on the page`);
  const tag = html.slice(
    html.lastIndexOf("<details", at),
    html.indexOf(">", at),
  );
  return {
    at,
    open: / open$/.test(tag),
    summary:
      html
        .slice(at)
        .match(/<span class="fold-summary">(.*?)<\/span><\/summary>/)?.[1] ??
      "",
  };
}
// What submitting the free-time form sends: named inputs, checked boxes.
function formFields(html) {
  const form = html.slice(
    html.indexOf('<form id="subject-form"'),
    html.indexOf("</form>"),
  );
  const fields = new Map();
  for (const [tag] of form.matchAll(/<input\b[^>]*>/g)) {
    const name = tag.match(/ name="([^"]*)"/)?.[1];
    if (!name) continue;
    if (/type="checkbox"/.test(tag)) {
      if (/ checked/.test(tag)) fields.set(name, "on");
    } else fields.set(name, tag.match(/ value="([^"]*)"/)?.[1] ?? "");
  }
  return fields;
}
const until = async (check) => {
  for (let i = 0; i < 200 && !check(); i++)
    await new Promise((r) => setTimeout(r, 10));
  assert.ok(check());
};

test("free time shows its log first and folds checks and settings, their state on the title line", async (t) => {
  const cfg = config(2);
  Object.assign(cfg.agents[0].subject, {
    enabled: true,
    groups: ["20000", "20001"],
    users: ["30000"],
    maxChecksPerDay: 24,
    maxContactsPerDay: 3,
  });
  const f = await consoleFixture(t, cfg);
  const now = Date.now();
  f.runtime.clock = () => new Date(now);
  const m = f.store.bind("agent-0");
  m.setState("@subject", {
    checks: [now - 600000],
    lastOpportunityAt: now - 600000,
    nextCheckAt: now + 3000000,
  });
  const call = (name, ok = true) => ({ name, ok, ms: 5 });
  m.identity.put("model_turns", {
    id: "free-1",
    conversation: "@subject",
    startedAt: now - 7200000,
    endedAt: now - 7200000 + 60000,
    status: "completed-no-send",
    selfVersion: 1,
    toolCalls: [
      call("memory_search"),
      call("web_fetch", false),
      call("memory_search"),
      call("subject_log"),
    ],
  });
  m.append({
    dedupe: "free-log-1",
    conversation: "@subject",
    kind: "subject.log",
    direction: "internal",
    occurredAt: new Date(now - 7200000 + 30000).toISOString(),
    observedAt: new Date(now - 7200000 + 30000).toISOString(),
    payload: {
      did: "browsed",
      summary: "读了<b>新闻</b>",
      found: [{ title: "光污染地图" }],
      next: "周末再看",
      turnId: "free-1",
    },
  });
  const page = consolePage(f);
  let html = await page.show("subject");

  // Log, then checks, then settings; only the log is open at first.
  const log = section(html, "subject-log"),
    quota = section(html, "subject-quota"),
    settings = section(html, "subject-settings");
  assert.ok(log.at < quota.at && quota.at < settings.at);
  assert.deepEqual([log.open, quota.open, settings.open], [true, false, false]);
  assert.match(log.summary, /^24 小时内 1 次 · 有行动 1 次 · 最近一条 /);
  const next = (await (await f.request("/api/mind?agentId=agent-0")).json())
    .subject.checkStatus.nextEligibleAt;
  assert.ok(
    quota.summary.startsWith("等待下次检查 · 24 小时内 1/24 次 · 下次最早 "),
  );
  assert.ok(
    quota.summary.endsWith(
      new Date(next).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
    ),
  );
  assert.equal(
    settings.summary,
    "已启用 · 2 个群 · 1 个私聊 · 每天最多联系 3 次",
  );

  // The log entry carries its turn's tools in one line, failures first and
  // counted in red; writing the log itself is not counted. Text is escaped
  // and cut, with all of it on hover.
  const entry = html.slice(log.at, quota.at);
  assert.match(
    entry,
    /<p class="mind-clip lines-3" tabindex="0" title="读了&lt;b&gt;新闻&lt;\/b&gt;">读了&lt;b&gt;新闻&lt;\/b&gt;<\/p>/,
  );
  assert.match(
    entry,
    /<summary>工具 3 次<span class="mind-failed">1 次失败<\/span><\/summary><div class="mind-chips"><span class="mind-chip is-failed" title="web_fetch · 失败 1 次">[^<]+ 失败<\/span><span class="mind-chip" title="memory_search · 2 次">[^<]+<b>×2<\/b><\/span><\/div>/,
  );
  assert.doesNotMatch(entry, /subject_log/);
  // Tools are named as the role form names them.
  assert.match(entry, /title="memory_search · 2 次">[^<a-z_]+<b>/);

  // Groups and private chats are picked as numbers; the form still sends the
  // comma lists, and the pickers are filled for this role.
  assert.match(html, /<input type="hidden" name="groups" value="20000,20001">/);
  assert.match(html, /<input type="hidden" name="users" value="30000">/);
  assert.doesNotMatch(html, /逗号分隔/);
  assert.deepEqual([...page.sandbox.filled], ["agent-0"]);
  const form = page.node("#subject-form");
  form.fields = formFields(html);
  form.fields.set("groups", "20001");
  form.onsubmit({ preventDefault() {}, target: form });
  await until(() => page.notices.length);
  assert.match(page.notices[0], /空闲时间设置已/);
  const saved = f.runtime.config.agents[0].subject;
  assert.deepEqual(saved.groups, ["20001"]);
  assert.deepEqual(saved.users, ["30000"]);
  assert.equal(
    saved.maxToolCallsPerTurn,
    cfg.agents[0].subject.maxToolCallsPerTurn ?? 8,
  );
  assert.equal(saved.maxContactsPerDay, 3);

  // What the viewer opened or closed stays that way after a refresh.
  page.storage.set("fold:subject-quota", "1");
  page.storage.set("fold:subject-log", "0");
  html = await page.show("subject");
  assert.deepEqual(
    [section(html, "subject-log").open, section(html, "subject-quota").open],
    [false, true],
  );
});

test("every log on the page shows its own turn's tools, however many turns came after", async (t) => {
  const f = await consoleFixture(t),
    m = f.store.bind("agent-0"),
    now = Date.now();
  // Twelve ended turns, newest last, each leaving a log; then one still
  // running that has logged but not yet recorded its tools.
  const turn = (k, extra) => {
    const startedAt = now - (13 - k) * 600000;
    m.identity.put("model_turns", {
      id: "turn-" + k,
      conversation: "@subject",
      startedAt,
      endedAt: startedAt + 60000,
      status: "completed-no-send",
      selfVersion: 1,
      ...extra,
    });
    m.append({
      dedupe: "turn-log-" + k,
      conversation: "@subject",
      kind: "subject.log",
      direction: "internal",
      occurredAt: new Date(startedAt + 30000).toISOString(),
      observedAt: new Date(startedAt + 30000).toISOString(),
      payload: {
        did: "browsed",
        summary: "第 " + k + " 次",
        turnId: "turn-" + k,
      },
    });
  };
  turn(0, {
    toolCalls: [
      { name: "web_fetch", ok: false },
      { name: "subject_log", ok: true },
    ],
  });
  // Recorded before tools were traced.
  turn(1, {});
  for (let k = 2; k < 12; k++)
    turn(k, { toolCalls: [{ name: "memory_search", ok: true }] });
  turn(12, { status: "running", endedAt: undefined });

  const data = await (await f.request("/api/mind?agentId=agent-0")).json();
  assert.equal(data.subject.turns.length, 10);
  const logOf = (k) =>
    data.subject.logs.find((l) => l.summary === "第 " + k + " 次");
  assert.deepEqual(
    logOf(0).toolCalls.map((c) => [c.name, c.ok]),
    [
      ["web_fetch", false],
      ["subject_log", true],
    ],
  );
  assert.equal(logOf(1).toolCalls, null);
  assert.equal("toolCalls" in logOf(12), false);

  const html = await consolePage(f).show("subject"),
    entry = (k) =>
      html.slice(html.indexOf(`>第 ${k} 次<`)).split("</article>")[0];
  // The oldest log is past the ten latest turns and still shows its failure.
  assert.match(entry(0), /工具 1 次<span class="mind-failed">1 次失败<\/span>/);
  assert.match(entry(1), /工具调用未记录（升级前的回合）/);
  assert.match(entry(11), /工具 1 次<\/summary>/);
  assert.doesNotMatch(entry(12), /工具/);
});

test("a turn's tools read as one line, and turns from before the upgrade say so", async (t) => {
  const page = consolePage(await consoleFixture(t));
  const tools = (calls) =>
    vm.runInContext(`toolCallsMarkup(${JSON.stringify(calls)})`, page.sandbox);
  assert.match(tools(undefined), /工具调用未记录（升级前的回合）/);
  assert.match(tools([]), /没有调用工具/);
  assert.match(tools([{ name: "subject_log", ok: true }]), /没有调用工具/);
  // A failed log is worth a look.
  assert.match(
    tools([{ name: "subject_log", ok: false }]),
    /工具 1 次<span class="mind-failed">1 次失败<\/span>[^]*mind-chip is-failed" title="subject_log/,
  );
  // An unknown tool keeps its name.
  assert.match(
    tools([
      { name: "x_tool", ok: true },
      { name: "x_tool", ok: true },
    ]),
    /<span class="mind-chip" title="x_tool · 2 次">x_tool<b>×2<\/b><\/span>/,
  );
});

test("Self shows the current self first and folds the rest with what each holds", async (t) => {
  const cfg = config(2);
  cfg.agents[0].persona = "初始人格";
  cfg.agents[0].appearance = "短发";
  // An old persona with no appearance yet must be confirmed before self changes.
  cfg.agents[1].persona = "旧人格";
  const f = await consoleFixture(t, cfg);
  const m = f.store.bind("agent-0"),
    agent = f.runtime.config.agents[0];
  m.identity.initialize(agent, T0);
  m.identity.adminEdit(
    { body: "第二版", reason: "管理员补充", expectedVersion: 1 },
    T0 + 1000,
  );
  for (const body of ["喜欢深夜聊天", "喜欢看星星"])
    m.identity.propose(
      { body, reason: "最近常这样", expectedVersion: 2 },
      { conversation: "group:20000" },
      agent.selfPolicy,
      T0 + 2000,
    );
  m.identity.put("self_candidates", {
    ...m.identity.list("self_candidates")[0],
    id: "closed",
    status: "accepted",
  });
  const page = consolePage(f);
  const html = await page.show("mind");

  const self = html.indexOf('<section class="card self-card">');
  assert.ok(self >= 0 && self < html.indexOf("<details"));
  assert.match(html, /<div id="self-view" class="self-view">第二版<\/div>/);
  assert.match(
    html,
    /<p class="self-meta"><span>管理员 · [^<]+<\/span><span class="self-reason" title="管理员补充">管理员补充<\/span><\/p>/,
  );
  const candidates = section(html, "self-candidates"),
    history = section(html, "self-history"),
    anchors = section(html, "self-anchors"),
    template = section(html, "self-template");
  assert.ok(
    candidates.at < history.at &&
      history.at < anchors.at &&
      anchors.at < template.at,
  );
  assert.deepEqual(
    [candidates, history, anchors, template].map((s) => s.open),
    [false, false, false, false],
  );
  assert.equal(
    candidates.summary,
    '<span class="mind-attn">2 个候选待回顾</span> · 共 3 个',
  );
  assert.match(history.summary, /^共 2 个版本 · 当前 v2 · .+ 管理员$/);
  assert.equal(anchors.summary, "角色0 · 已设定外形");
  assert.match(template.summary, /^v1 · /);
  assert.match(html, /<pre>初始人格<\/pre>/);
  // Candidates are named by what they say; versions by who wrote them, and why.
  assert.match(
    html,
    /<span class="mind-summary-main">兴趣 · 喜欢看星星<\/span><span class="mind-tag is-wait">待回顾<\/span>/,
  );
  assert.match(
    html,
    /<span class="mind-summary-main">v1 · 初始模板 · [^<]+ · 从初始模板建立 self<\/span>/,
  );

  // A role whose appearance still needs confirming says so, and opens it.
  const other = section(await page.show("mind", "agent-1"), "self-anchors");
  assert.equal(other.open, true);
  assert.equal(
    other.summary,
    '<span class="mind-attn">需要确认原有外形</span>',
  );
});

test("contacts and sessions list first, count what they list and keep rows one shape", async (t) => {
  const f = await consoleFixture(t),
    m = f.store.bind("agent-0"),
    now = Date.now();
  const e = heard(m, "private:30000", "30000", now - 60000);
  m.identity.savePersonCard(
    { personId: "30000", call: "阿明", body: "老朋友", evidence: [e.id] },
    { writtenIn: "private:30000", now },
  );
  const intent = (id, topic, target, status) =>
    m.identity.put("intentions", {
      id,
      topic,
      target,
      status,
      reason: "惦记着",
      evidence: [e.id],
      history: [{ at: now - 3600000, status: "waiting", reason: "提出" }],
      revision: 1,
      expiresAt: now + 3600000,
      sentAt: status === "completed" ? now - 60000 : null,
    });
  intent("live", "问问<书>看完没有", "private:30000", "waiting");
  intent("done", "约周末", "group:20000", "completed");
  m.setState("group:20000", {
    loadedSelfVersion: 1,
    lifecycle: { status: "active" },
    usage: { source: "measured", contextTokens: 91000, capacityTokens: 100000 },
  });
  m.setState("@subject", {
    loadedSelfVersion: 1,
    lifecycle: { status: "retired", reason: "admin-reset" },
  });
  const page = consolePage(f);

  const intents = await page.show("intents");
  assert.match(intents, /<span class="mind-count">进行中 1 · 共 2<\/span>/);
  assert.ok(intents.indexOf("mind-list") < intents.indexOf("mind-foot"));
  assert.match(
    intents,
    /<strong class="mind-title" title="问问&lt;书&gt;看完没有">问问&lt;书&gt;看完没有<\/strong><span class="mind-tag is-wait">等待机会<\/span>/,
  );
  assert.match(
    intents,
    /title="私聊 30000 · 惦记着">私聊 30000（叫「阿明」）<button[^>]*data-open-person="30000"/,
  );
  assert.match(intents, /title="群 20000 · 惦记着">群 20000 · 惦记着<\/p>/);
  assert.match(intents, /<span class="mind-tag is-ok">已完成<\/span>/);
  // Only an intent still in play can be cancelled; only a sent one has a send time.
  assert.equal(intents.split("data-cancel-intent=").length - 1, 1);
  assert.equal(intents.split("已确认发送").length - 1, 1);

  const sessions = await page.show("sessions");
  assert.match(sessions, /<span class="mind-count">共 2 个<\/span>/);
  assert.ok(sessions.indexOf("空闲时间") < sessions.indexOf("群 20000"));
  assert.match(sessions, /<span class="mind-tag is-off">已结束<\/span>/);
  assert.match(sessions, /<span class="mind-tag is-ok">进行中<\/span>/);
  assert.match(sessions, /class="meter mind-bar is-high"/);
  assert.match(sessions, /后端实测 91,000 \/ 100,000 tokens · 91%/);
  assert.match(sessions, /title="原因：admin-reset">原因：admin-reset<\/p>/);
  assert.ok(sessions.indexOf("mind-list") < sessions.indexOf("mind-foot"));
});

test("mood and person cards show their content before what the page is for", async (t) => {
  const f = await consoleFixture(t),
    m = f.store.bind("agent-0");
  const e = heard(m, "group:20000", "30000", Date.now() - 60000);
  m.identity.setMood(
    { mood: "开心", intensity: 3, reason: "群里热闹", evidence: [e.id] },
    { writtenIn: "group:20000", now: Date.now() - 1000 },
  );
  m.identity.savePersonCard(
    { personId: "30000", call: "阿明", body: "老朋友", evidence: [e.id] },
    { writtenIn: "group:20000", now: Date.now() },
  );
  const page = consolePage(f);
  const mood = await page.show("mood");
  assert.ok(mood.indexOf('class="mood-now') < mood.indexOf("mind-foot"));
  assert.ok(mood.indexOf('id="mood-log"') < mood.indexOf("mind-foot"));
  const people = await page.show("people");
  assert.ok(people.indexOf('id="people-grid"') < people.indexOf("mind-foot"));
});

test("retirement history exposes source and input stage without expanding by default", async (t) => {
  const f = await consoleFixture(t),
    m = f.store.bind("agent-0");
  m.identity.put("session_history", {
    id: "synthetic-retirement",
    conversation: "group:20000",
    session: { id: "session-synthetic" },
    reason: "cancelled",
    at: Date.now(),
    details: {
      source: "configuration",
      inputStage: "accepted",
      changes: ["agent.tools"],
    },
  });
  const page = consolePage(f),
    html = await page.show("sessions");
  assert.match(html, /最近会话更替/);
  assert.match(html, /配置变更 · 后端已确认输入/);
  assert.match(html, /session-synthetic/);
  assert.match(html, /agent.tools/);
  assert.equal(section(html, "retired-sessions").open, false);
});
