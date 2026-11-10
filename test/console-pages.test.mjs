import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { randomBytes } from "node:crypto";
import { fixture } from "./helpers.mjs";
import { createServer } from "../src/server.mjs";

// The memory, runtime settings and activity pages after the redesign:
// content first, settings folded with their state in the title line, and
// rows that keep one shape whatever they say.
const T0 = Date.parse("2026-10-29T08:00:00Z");
const at = (s) => new Date(T0 + s * 1000).toISOString();
let n = 0;
const heard = (m, conversation, senderId, s, body, name = "") =>
  m.append({
    dedupe: "pages-" + ++n,
    conversation,
    kind: "message.received",
    senderId,
    body,
    occurredAt: at(s),
    observedAt: at(s),
    payload: name ? { raw: { sender: { nickname: name } } } : {},
  });

function stubNode() {
  return {
    innerHTML: "",
    value: "",
    options: [],
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {},
    close() {
      this.open = false;
    },
    insertAdjacentHTML() {},
    querySelectorAll: () => [],
  };
}
// app.js against a real server, every element a stub that keeps what the
// page writes into it.
async function consolePage(t, f) {
  const token = randomBytes(32).toString("hex"),
    app = createServer({ runtime: f.runtime, token });
  const port = await app.listen();
  t.after(() => app.close());
  const nodes = new Map();
  const node = (s) => {
    if (!nodes.has(s)) nodes.set(s, stubNode());
    return nodes.get(s);
  };
  const sandbox = vm.createContext({
    document: {
      querySelector: node,
      querySelectorAll: () => [],
      body: { classList: { remove() {}, toggle() {} } },
    },
    sessionStorage: { getItem: () => "" },
    setInterval() {},
    setTimeout() {},
    clearTimeout() {},
    structuredClone,
    URLSearchParams,
    fetch: (url, options) =>
      fetch(`http://127.0.0.1:${port}${url}`, {
        ...options,
        headers: { ...options?.headers, "x-admin-token": token },
      }),
  });
  // Keep the real render() under another name: load() would draw the home
  // page, which needs the onboarding script.
  vm.runInContext(
    fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8") +
      "\nvar renderPage = render;",
    sandbox,
  );
  const run = (code) => vm.runInContext(code, sandbox);
  run("var loading = load(); render = () => {};");
  await run("loading");
  run("render = renderPage;");
  return { node, run };
}

test("memory shows the latest records first, a compact search and the sessions folded with their state", async (t) => {
  const f = fixture(t),
    m = f.store.bind("agent-0");
  heard(m, "group:20000", "30000", 0, "约好的蛋糕", "老王");
  heard(m, "group:20000", "30001", 5, "我也来", "小李");
  heard(m, "private:30000", "30000", 10, "晚上好", "老王");
  m.person("30000", "老王");
  m.setState("group:20001", { ...m.state("group:20001"), paused: true });
  const c = await consolePage(t, f);
  // A stub select does not take its value from the markup.
  c.node("#memory-agent").value = "agent-0";
  c.node("#memory-type").value = "all";
  c.run('tab = "memory"; roleId = "agent-0"; render();');
  const page = c.node("#content").innerHTML;
  // Search bar, then results, then the folded sessions — closed by default.
  const order = [
    "mem-search",
    "mem-results",
    'data-fold="memory-conversations"',
  ];
  assert.deepEqual(
    order.map((x) => page.indexOf(x)),
    order.map((x) => page.indexOf(x)).sort((a, b) => a - b),
  );
  assert.match(
    page,
    /<details class="card fold" data-fold="memory-conversations"><summary>/,
  );
  assert.match(
    page,
    /<span class="fold-title">会话状态<\/span><span class="fold-summary"><span id="memory-conversations-summary">读取中…<\/span>/,
  );
  // A person is picked from the people this role knows, or typed.
  assert.match(
    page,
    /<input id="memory-person" list="memory-people" inputmode="numeric"/,
  );
  assert.match(page, /<label>来源<select id="memory-source">/);
  // The page loads the session states, the people and the latest records.
  await c.run("loadConversations()");
  await c.run('knownTargets("agent-0")');
  await c.run("searchMemory()");
  assert.equal(
    c.node("#memory-conversations-summary").textContent,
    "3 个会话 · 1 个暂停",
  );
  assert.match(
    c.node("#memory-people").innerHTML,
    /<option value="30000">老王<\/option>/,
  );
  assert.equal(
    c.node("#memory-results-head").textContent,
    "最近的经历档案 · 3 条",
  );
  const results = c.node("#memory-results").innerHTML;
  assert.match(
    results,
    /<article class="record mem-record"><div class="mem-head"><strong title="[^"]*">/,
  );
  assert.match(results, /<p class="mem-body" title="晚上好">晚上好<\/p>/);
  // The source bar shows only once a source is chosen.
  c.run("renderSourceState()");
  assert.equal(c.node("#memory-source-bar").hidden, true);
  c.node("#memory-source").value = "group:20001";
  c.run("renderSourceState()");
  assert.equal(c.node("#memory-source-bar").hidden, false);
  assert.equal(c.node("#memory-source-state").textContent, "群 20001：已暂停");
  // A search names what was asked.
  c.node("#memory-source").value = "";
  c.node("#memory-query").value = "蛋糕";
  await c.run("searchMemory()");
  assert.equal(
    c.node("#memory-results-head").textContent,
    "“蛋糕”的经历档案 · 1 条",
  );
  assert.equal(c.run("conversationsSummary([])"), "还没有会话");
  assert.equal(
    c.run(
      "conversationsSummary([{ paused: false, silenceUntil: Date.now() + 60000 }, { paused: false }])",
    ),
    "2 个会话 · 没有暂停 · 1 个静默",
  );
});

test("runtime settings put participation first and fold the full config and migration with a summary", async (t) => {
  const f = fixture(t);
  const c = await consolePage(t, f);
  c.run('tab = "settings"; render();');
  const page = c.node("#content").innerHTML;
  assert.match(
    page,
    /^<section class="card settings-control"><div class="row"><h2>参与控制<\/h2><span class="pill live">全局允许参与<\/span><\/div>/,
  );
  assert.match(page, /<dt>QQ 连接<\/dt><dd title="3\/3 个已连接">/);
  assert.match(page, /右上角的「全部暂停」/);
  assert.match(
    page,
    /<details class="card fold" data-fold="settings-config"><summary><span class="fold-title">完整配置<\/span><span class="fold-summary">JSON · 3 个角色 · 3 个 QQ 账号 · 1 个后端<\/span>/,
  );
  assert.match(
    page,
    /<details class="card fold" data-fold="settings-migrate"><summary><span class="fold-title">迁移与备份<\/span><span class="fold-summary">先预检再导入/,
  );
  assert.match(page, /data-do="advanced">打开配置编辑器/);
  assert.match(page, /data-do="download-config">导出配置/);
  assert(page.indexOf("参与控制") < page.indexOf("settings-config"));
  assert(page.indexOf("settings-config") < page.indexOf("settings-migrate"));
});

function activityScripts() {
  const nodes = new Map();
  const node = (s) => {
    if (!nodes.has(s)) nodes.set(s, stubNode());
    return nodes.get(s);
  };
  const sandbox = vm.createContext({
    $: node,
    document: { querySelectorAll: () => [] },
    esc: (s) =>
      String(s ?? "").replace(
        /[&<>"']/g,
        (c) =>
          ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;",
          })[c],
      ),
    tag: (text, cls = "") => `<span class="pill ${cls}">${text}</span>`,
    icon: (name) => `<svg data-icon="${name}"></svg>`,
    action() {},
    config: { agents: [{ id: "agent-0", name: "角色0" }] },
    tab: "activity",
  });
  vm.runInContext(
    fs.readFileSync(
      new URL("../public/activity-ui.js", import.meta.url),
      "utf8",
    ),
    sandbox,
  );
  return { node, run: (code) => vm.runInContext(code, sandbox), sandbox };
}

test("activity keeps a slim filter bar and one head line per entry, long text cut with the full text on hover", () => {
  const a = activityScripts();
  a.run("renderActivity()");
  const page = a.node("#content").innerHTML;
  assert.match(
    page,
    /^<div class="act-bar"><label>角色<select id="activity-agent">/,
  );
  assert.match(
    page,
    /<div class="act-filters" role="group" aria-label="筛选"><button type="button" data-activity-filter="all" class="is-on" aria-pressed="true">全部<\/button><button type="button" data-activity-filter="subject" class="" aria-pressed="false">空闲时间<\/button>/,
  );
  assert.match(
    page,
    /<button type="button" class="ghost" id="activity-refresh" aria-label="刷新" title="刷新"><svg data-icon="pulse"><\/svg><span>刷新<\/span><\/button><\/div><section class="card act-list" id="activity-list">/,
  );
  assert.match(
    page,
    /<\/section><p class="hint act-foot">每一条是一次聊天回复或一次空闲时间/,
  );

  const long = "看了一篇很长的文章，".repeat(40);
  a.sandbox.entry = {
    kind: "subject",
    status: "failed",
    startedAt: T0,
    endedAt: T0 + 30000,
    log: { did: "read", summary: long, next: "<明天>继续读" },
    sent: [],
    browsing: { items: [], searches: [], failures: [] },
    diaries: [],
    intents: { created: [], decided: [] },
    tools: { total: 2, names: ["app_read", "diary_write"], failed: 1 },
    seen: { mood: { mood: "平静", intensity: 2 }, personCards: [] },
  };
  const html = a.run("activityEntry(entry)");
  assert.match(
    html,
    /^<article class="act-entry act-subject"><div class="act-head"><i class="act-dot" aria-hidden="true"><\/i><strong class="act-title" title="空闲时间 · 阅读">空闲时间 · 阅读<\/strong><span class="pill warn">回合失败<\/span><span class="act-time">[^<]+ · 30 秒<\/span><\/div>/,
  );
  assert(html.includes(`<p class="act-summary" title="${long}">${long}</p>`));
  assert.match(
    html,
    /<p class="hint act-next" title="&lt;明天&gt;继续读">下次想做：&lt;明天&gt;继续读<\/p>/,
  );
  assert.match(
    html,
    /<p class="act-basis"><span class="act-k">这一轮附上<\/span><span class="act-chip"><small>心情<\/small>平静（强度 2）<\/span><\/p>/,
  );
  assert.match(
    html,
    /<p class="hint mono act-tools" title="工具：app_read、diary_write（失败 1 次）">/,
  );
  // An entry with nothing attached has no empty chip line.
  a.sandbox.entry = { ...a.sandbox.entry, seen: { personCards: [] } };
  assert.doesNotMatch(a.run("activityEntry(entry)"), /act-basis/);
});

test("activity displays the delivered contribution and distinguishes an empty recall", () => {
  const a = activityScripts();
  a.sandbox.entry = {
    kind: "chat",
    conversation: "group:20000",
    reasons: [],
    status: "completed",
    startedAt: T0,
    sent: [],
    browsing: { items: [], searches: [], failures: [] },
    diaries: [],
    intents: { created: [], decided: [] },
    memoryRecall: {
      opening: {
        status: "matched",
        reason: "local-semantic",
        matched: 1,
        presented: 1,
        waitMs: 100,
        contribution: "核对了<访客>安排。",
      },
      active: {
        status: "empty",
        reason: "tool",
        matched: 0,
        presented: 0,
        waitMs: 100,
      },
    },
  };
  const html = a.run("activityEntry(entry)");
  assert.match(html, /回复前补充的信息 · 核对了&lt;访客&gt;安排/);
  assert.match(html, /主动回想[^<]*无新增信息/);
});

test("activity separates delivery, model, process and session outcomes", () => {
  const a = activityScripts();
  a.sandbox.entry = {
    kind: "chat",
    conversation: "group:20000",
    reasons: [],
    status: "failed",
    startedAt: T0,
    endedAt: T0 + 1000,
    backendOutcome: "failed",
    workerOutcome: "exit-warning",
    sessionDisposition: "retiring",
    backendDiagnostics: [
      {
        origin: "process-exit",
        exitCode: 7,
        workerOutcome: "exit-warning",
        summary: "private diagnostic summary",
        providerText: "private provider response",
      },
    ],
    sent: [{ text: "confirmed message", action: false }],
    failedSends: 1,
    unknownSends: 1,
    browsing: { items: [], searches: [], failures: [] },
    diaries: [],
    intents: { created: [], decided: [] },
    tools: null,
  };
  const failed = a.run("activityEntry(entry)");
  assert.match(failed, /进程退出告警/);
  assert.match(failed, /会话退休未完成/);
  assert.match(failed, /消息已送达，回合后续失败/);
  assert.match(failed, /消息已送达 1 条/);
  assert.match(failed, /1 条发送失败/);
  assert.match(failed, /1 条发送结果未知（原因未记录）/);
  assert.match(failed, /进程退出 · 进程退出告警 · 进程退出码 7/);
  assert.doesNotMatch(
    failed,
    /private diagnostic summary|private provider response/,
  );

  a.sandbox.entry = {
    ...a.sandbox.entry,
    status: "completed-no-send",
    backendOutcome: "success",
    workerOutcome: "recycled",
    sessionDisposition: "retired",
    backendDiagnostics: [],
    sent: [],
    failedSends: 0,
    unknownSends: 0,
  };
  const success = a.run("activityEntry(entry)");
  assert.match(success, /模型成功/);
  assert.match(success, /进程已回收/);
  assert.match(success, /会话已退休/);
  assert.doesNotMatch(success, /消息已送达|失败原因未记录/);

  a.sandbox.entry = {
    ...a.sandbox.entry,
    status: "failed",
    sent: [{ text: "confirmed message", action: false }],
  };
  const localFailure = a.run("activityEntry(entry)");
  assert.match(localFailure, /模型成功/);
  assert.match(localFailure, /消息已送达，回合后续失败/);

  a.sandbox.entry = {
    ...a.sandbox.entry,
    status: "completed-no-send",
    sent: [{ text: "confirmed action", action: true }],
  };
  const action = a.run("activityEntry(entry)");
  assert.match(action, /动作已确认 1 项/);
  assert.doesNotMatch(action, /消息已送达/);

  a.sandbox.entry = {
    ...a.sandbox.entry,
    status: "failed",
    backendOutcome: undefined,
    workerOutcome: undefined,
    sessionDisposition: undefined,
  };
  assert.match(a.run("activityEntry(entry)"), /失败原因未记录/);
});

test("memory and diary menus keep their own record type, search filters and full readers", async (t) => {
  const f = fixture(t),
    m = f.store.bind("agent-0");
  heard(m, "private:30000", "30000", 0, "合成经历原文");
  m.diaryWrite({ title: "合成日记标题", body: "仅日记里出现的正文" });
  const c = await consolePage(t, f);
  c.node("#memory-agent").value = "agent-0";
  c.node("#memory-query").value = "";
  c.node("#memory-person").value = "";
  c.node("#memory-source").value = "";
  c.run('tab = "memory"; roleId = "agent-0"; render();');
  await c.run("searchMemory()");
  assert.equal(c.node("#memory-type").value, "event");
  assert.match(c.node("#memory-results").innerHTML, /合成经历原文/);
  assert.doesNotMatch(
    c.node("#memory-results").innerHTML,
    /仅日记里出现的正文/,
  );
  const navigation = c.node("#section-bar").innerHTML;
  assert.match(navigation, /data-page="memory"[^>]*>记忆</);
  assert.match(navigation, /data-page="diary"[^>]*>日记</);
  assert.match(navigation, /data-page="visits"[^>]*>访问</);
  c.run('tab = "diary"; render();');
  await c.run("searchMemory()");
  assert.equal(c.node("#memory-type").value, "diary");
  assert.match(c.node("#memory-results").innerHTML, /仅日记里出现的正文/);
  assert.doesNotMatch(c.node("#memory-results").innerHTML, /合成经历原文/);
  assert.match(c.node("#content").innerHTML, /id="memory-person"/);
  assert.match(c.node("#content").innerHTML, /id="memory-source"/);
  c.node("#memory-query").value = "查无此内容";
  await c.run("searchMemory()");
  assert.doesNotMatch(
    c.node("#memory-results").innerHTML,
    /仅日记里出现的正文/,
  );
});

test("leaving a record page invalidates an unfinished search before it can paint another menu", async (t) => {
  const f = fixture(t),
    c = await consolePage(t, f);
  c.node("#memory-agent").value = "agent-0";
  c.node("#memory-query").value = "";
  c.node("#memory-type").value = "event";
  c.node("#memory-person").value = "";
  c.node("#memory-source").value = "";
  c.run(
    'tab = "memory"; var heldResolve; var originalApi = api; api = (url, ...args) => url.startsWith("/api/memory?") ? new Promise(resolve => heldResolve = resolve) : originalApi(url, ...args); var delayedSearch = searchMemory();',
  );
  c.run('tab = "settings"; render();');
  c.run(
    'heldResolve({items:[{id:"synthetic-old-record",body:"上一页的私人正文"}],diaries:[],people:{}})',
  );
  await c.run("delayedSearch");
  assert.doesNotMatch(c.node("#content").innerHTML, /上一页的私人正文/);
  assert.doesNotMatch(
    c.node("#memory-results").innerHTML || "",
    /上一页的私人正文/,
  );
});

for (const helper of [
  "readConversation({agentId:'agent-0',aroundId:'synthetic-anchor'})",
  "readRelated('synthetic-anchor')",
])
  test(`late auxiliary reader cannot reopen the previous role after navigation: ${helper}`, async (t) => {
    const f = fixture(t),
      c = await consolePage(t, f);
    c.node("#memory-agent").value = "agent-0";
    c.run(
      'roleId = "agent-0"; tab = "memory"; var heldReaderResolve; var originalReaderApi = api; api = (url, ...args) => (url.includes("/api/memory/conversation?") || url.includes("/api/memory/related?")) ? new Promise(resolve => heldReaderResolve = resolve) : originalReaderApi(url, ...args); var renderVisits = () => {};',
    );
    c.run(`var delayedReader = ${helper};`);
    c.run('roleId = "agent-1"; tab = "visits"; render();');
    c.run(
      'heldReaderResolve({items:[{id:"synthetic-record",body:"旧角色迟到的私人原文",record:{id:"synthetic-related",body:"旧角色迟到的私人原文"},links:[]}],nextAfterSeq:null})',
    );
    await c.run("delayedReader");
    assert.notEqual(c.node("#editor").open, true);
    assert.doesNotMatch(c.node("#edit-fields").innerHTML || "", /旧角色迟到/);
  });
