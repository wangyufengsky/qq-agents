import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { randomBytes } from "node:crypto";
import { config as makeConfig, fixture } from "./helpers.mjs";
import { createServer } from "../src/server.mjs";
import { appService } from "../src/apps/tools.mjs";
import { appsPolicySchema } from "../src/apps/policy.mjs";

// The browse-and-share and file pages show what the role read, wants to
// share and keeps first; their settings fold below with the state in the
// title line, and saving sends what it always sent.
const MiB = 1024 * 1024;
const script = (name) =>
  fs.readFileSync(new URL(`../public/${name}`, import.meta.url), "utf8");
const flush = () => new Promise((resolve) => setImmediate(resolve));

// app.js and both pages in one sandbox; elements are kept per selector and
// remember what the pages write into them. Requests go to `replies`.
function page({ storage = new Map(), replies = {} } = {}) {
  const nodes = new Map(),
    calls = [];
  const element = () => ({
    innerHTML: "",
    textContent: "",
    dataset: {},
    style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {},
    querySelectorAll: () => [],
    insertAdjacentHTML(where, html) {
      this.innerHTML =
        where === "afterbegin" ? html + this.innerHTML : this.innerHTML + html;
    },
  });
  const $ = (s) => {
    if (!nodes.has(s)) nodes.set(s, element());
    return nodes.get(s);
  };
  const sandbox = vm.createContext({
    document: {
      querySelector: $,
      querySelectorAll: () => [],
      addEventListener() {},
      body: { classList: { remove() {}, toggle() {} } },
    },
    sessionStorage: { getItem: () => "" },
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
    },
    setInterval() {},
    setTimeout() {},
    clearTimeout() {},
    fetch: () => new Promise(() => {}),
    URLSearchParams,
    FormData: class {
      constructor(values) {
        return new Map(Object.entries(values));
      }
    },
    reply: async (url, data, method) => {
      calls.push({ url, data: data && structuredClone(data), method });
      const r = replies[url.split("?")[0]];
      if (r instanceof Error) throw r;
      return typeof r === "function" ? r(data) : (r ?? {});
    },
  });
  for (const name of ["app.js", "files-ui.js", "apps-ui.js"])
    vm.runInContext(script(name), sandbox);
  const run = (code) => vm.runInContext(code, sandbox);
  run(
    "api = reply; action = (fn) => fn(); load = async () => {}; notice = () => {}; revision = 7;",
  );
  return { run, $, calls, replies };
}
const roles = (edit) => {
  const cfg = makeConfig(1);
  edit(cfg.agents[0]);
  return JSON.stringify(cfg);
};
const site = (platform, name, lastProbe) => ({
  platform,
  name,
  loginUrl: `https://${platform}.example/login`,
  browse: {
    hot: { semantic: "hot-list", pagination: false },
    recommend: { semantic: "personalized-recommendations", pagination: true },
  },
  search: "page",
  comments: "sample",
  lastProbe,
  enabled: ["bilibili", "heybox"].includes(platform),
});
const at = "2026-10-29T06:30:00.000Z";
const appsReply = (items = []) => ({
  intents: [],
  progress: [],
  readsLastDay: 3,
  capabilities: {
    platforms: [
      site("bilibili", "B站", { status: "checked", loggedIn: true }),
      site("heybox", "小黑盒", { status: "ok", loggedIn: true }),
      site("zhihu", "知乎", { status: "APP_LOGIN_REQUIRED" }),
      site("xiaohongshu", "小红书", { status: "not-tested" }),
      site("tieba", "贴吧", { status: "not-tested" }),
    ],
  },
  history: { items, nextOffset: null },
});
const browsing = (a) =>
  Object.assign(a.apps, {
    enabled: true,
    sharing: true,
    platforms: ["heybox", "bilibili"],
    maxReadsPerDay: 20,
    hours: {
      enabled: true,
      scope: "autonomous",
      start: "09:00",
      end: "23:00",
      timezone: "Asia/Shanghai",
    },
  });
async function apps(options = {}, edit = browsing, items = []) {
  const p = page({ ...options, replies: { "/api/apps": appsReply(items) } });
  p.run(`config = ${roles(edit)}; tab = "apps"; renderApps();`);
  await flush();
  return p;
}

test("browse and share leads with history and intents, settings and platforms folded with their state", async () => {
  const p = await apps();
  const html = p.$("#content").innerHTML,
    order = [
      "<h2>浏览记录</h2>",
      "<h2>分享意图</h2>",
      'data-fold="apps-policy"',
      'data-fold="apps-platforms"',
    ].map((s) => html.indexOf(s));
  assert(order.every((n, i) => n >= 0 && (i === 0 || n > order[i - 1])));
  // Both folds stay closed until this browser opens them.
  assert.match(html, /data-fold="apps-policy"><summary>/);
  assert.match(html, /data-fold="apps-platforms"><summary>/);
  // Before the history arrives the summary names the daily cap; afterwards
  // the reads spent in the last day.
  assert.match(
    html,
    /<span id="app-policy-summary">已启用 B站、小黑盒 · 09:00–23:00 · 每天最多读 20 次<\/span>/,
  );
  assert.equal(
    p.$("#app-policy-summary").textContent,
    "已启用 B站、小黑盒 · 09:00–23:00 · 24 小时内已读 3/20",
  );
  assert.equal(
    p.$("#app-login-summary").textContent,
    "2 个已登录 · 1 个需要登录 · 2 个未检查",
  );
  // Each platform is one line: name, whether this role uses it, login.
  const sites = p.$("#app-platforms").innerHTML;
  assert.equal(sites.match(/<details class="app-site">/g).length, 5);
  assert.match(
    sites,
    /<summary><span class="app-site-name">知乎<\/span><span class="pill off">未启用<\/span><span class="app-site-state" data-app-login="zhihu"><span class="pill warn">需要登录<\/span><\/span><\/summary>/,
  );
  assert.match(
    sites,
    /<span class="app-chip" title="热榜">热门<small>单页<\/small><\/span>/,
  );
  assert.match(sites, /推荐<small>可继续<\/small>/);

  // What this browser opened before stays open.
  const opened = await apps({
    storage: new Map([["fold:apps-policy", "1"]]),
  });
  assert.match(opened.$("#content").innerHTML, /data-fold="apps-policy" open>/);
  assert.match(
    opened.$("#content").innerHTML,
    /data-fold="apps-platforms"><summary>/,
  );
});

test("the settings summary says when browsing is off, all day or not sharing", async () => {
  const p = page();
  const summary = (apps) =>
    p.run(`appPolicySummary(${JSON.stringify(apps)}, ${apps.reads})`);
  const base = {
    enabled: true,
    sharing: true,
    platforms: ["tieba", "zhihu"],
    maxReadsPerDay: 30,
    hours: { enabled: true, start: "22:00", end: "02:00" },
  };
  assert.equal(summary({ ...base, enabled: false }), "未开启");
  assert.equal(
    summary({ ...base, reads: 0 }),
    "已启用 知乎、贴吧 · 22:00–02:00 · 24 小时内已读 0/30",
  );
  assert.equal(
    summary({
      ...base,
      platforms: [],
      sharing: false,
      hours: { ...base.hours, enabled: false },
    }),
    "已开启，未选平台 · 全天 · 每天最多读 30 次 · 不提出分享",
  );
  assert.equal(
    p.run(
      `appLoginSummary([{ lastProbe: { status: "APP_VERIFICATION_REQUIRED" } }, { lastProbe: { status: "public-read" } }, { lastProbe: { status: "APP_BACKEND_FAILED" } }])`,
    ),
    "1 个需要登录 · 1 个出错 · 1 个可读取",
  );
  assert.equal(p.run("appLoginSummary([])"), "没有平台");
});

test("history rows keep one shape: platform, cut title, time, then what was read as tags", async () => {
  const long = "一个很长很长的标题".repeat(20);
  const p = await apps({}, browsing, [
    {
      recordId: "rec-read",
      platform: "bilibili",
      operation: "read",
      ok: true,
      title: long,
      coverage: "video-metadata",
      fetchedAt: at,
      url: "https://www.bilibili.com/video/BV1xx411c7mD",
    },
    {
      recordId: "rec-comments",
      platform: "zhihu",
      operation: "comments",
      ok: true,
      title: "评论区",
      coverage: "sampled-comments",
      fetchedAt: at,
    },
    {
      recordId: "rec-failed",
      platform: "zhihu",
      operation: "browse",
      ok: false,
      error: "APP_LOGIN_REQUIRED",
      fetchedAt: at,
    },
    {
      recordId: "rec-card",
      platform: "bilibili",
      origin: "qq-card",
      ok: true,
      title: "<b>卡片</b>",
      summary: "分享卡片里的简介",
      readingScope: "card-summary",
      source: { conversation: "group:20000", messageId: "m-1" },
      fetchedAt: at,
    },
  ]);
  const history = p.$("#app-history").innerHTML;
  assert.equal(history.match(/<article class="app-row/g).length, 4);
  assert.equal(history.match(/<div class="app-row-head">/g).length, 4);
  assert.equal(history.match(/<div class="app-row-meta">/g).length, 4);
  // The whole title is kept for hovering; the row cuts it to one line.
  assert.match(
    history,
    new RegExp(
      `<span class="app-badge is-bilibili">B站</span><strong class="app-row-title" title="${long}">${long}</strong><time class="app-row-time" datetime="${at}">`,
    ),
  );
  assert.match(history, /<span class="app-chip is-deep">读过正文<\/span>/);
  assert.match(history, /<span class="app-chip is-deep">看过评论<\/span>/);
  assert.match(
    history,
    /<span class="app-chip is-quiet">视频标题和简介<\/span>/,
  );
  assert.match(
    history,
    /<article class="app-row is-failed">.*?读取失败.*?<span class="app-chip">浏览列表<\/span><span class="app-chip is-bad">需要本机登录<\/span>/,
  );
  assert.match(history, /&lt;b&gt;卡片&lt;\/b&gt;/);
  assert.match(history, /<span class="app-chip">QQ 分享卡片<\/span>/);
  assert.match(history, /来自群 20000/);
  assert.match(history, /<p class="app-row-text" title="分享卡片里的简介">/);

  // Rows from two platforms offer a filter; picking one narrows the list.
  assert.match(
    history,
    /<div class="app-filter" role="group" aria-label="按平台筛选"><button type="button" data-app-filter="all" class="primary" aria-pressed="true">全部<small>4<\/small><\/button><button type="button" data-app-filter="bilibili" class="ghost" aria-pressed="false">B站<small>2<\/small><\/button><button type="button" data-app-filter="zhihu" class="ghost" aria-pressed="false">知乎<small>2<\/small><\/button><\/div>/,
  );
  const pick = (appFilter) =>
    p.$("#app-history").onclick({
      target: { closest: () => ({ dataset: { appFilter } }) },
    });
  pick("zhihu");
  const zhihu = p.$("#app-history").innerHTML;
  assert.equal(zhihu.match(/<article class="app-row/g).length, 2);
  assert.doesNotMatch(zhihu, /rec-read|rec-card/);
  assert.match(zhihu, /data-app-filter="zhihu" class="primary"/);
  // Clicks outside the filter change nothing.
  p.$("#app-history").onclick({ target: { closest: () => null } });
  assert.equal(p.$("#app-history").innerHTML, zhihu);
  pick("all");
  assert.equal(
    p.$("#app-history").innerHTML.match(/<article class="app-row/g).length,
    4,
  );

  // One platform needs no filter.
  const single = await apps({}, browsing, [
    {
      recordId: "rec-1",
      platform: "tieba",
      operation: "browse",
      ok: true,
      title: "热帖",
      fetchedAt: at,
    },
  ]);
  assert.doesNotMatch(single.$("#app-history").innerHTML, /app-filter/);
});

test("share intents show target, expiry and a two-line reason, with the full reason one click away", async () => {
  const p = page({
    replies: {
      "/api/apps": {
        ...appsReply(),
        intents: [
          {
            id: "intent-1",
            revision: 2,
            status: "waiting",
            target: "private:30000",
            topic: "话题",
            reason: "因为".repeat(50),
            expiresAt: at,
            appShare: {
              platform: "zhihu",
              title: "一篇回答",
              url: "https://www.zhihu.com/question/1/answer/2",
              recordId: "rec-9",
              readingScope: "answer-text",
            },
          },
          {
            id: "intent-2",
            revision: 1,
            status: "failed",
            target: "group:20000",
            topic: "没标题时用话题",
            reason: "短理由",
            expiresAt: at,
            deliveryId: "delivery-1",
            appShare: { platform: "tieba", recordId: "rec-8" },
          },
        ],
      },
    },
  });
  p.run(`config = ${roles(browsing)}; tab = "apps"; renderApps();`);
  await flush();
  const intents = p.$("#app-intents").innerHTML;
  assert.match(
    intents,
    /<strong class="app-row-title" title="一篇回答">一篇回答<\/strong><span class="pill ">等待目标会话<\/span>/,
  );
  assert.match(intents, /发给私聊 30000/);
  assert.match(intents, /尚未投递/);
  assert.match(intents, /<span class="app-chip is-quiet">回答正文<\/span>/);
  assert.match(
    intents,
    /<details class="app-more"><summary>完整理由<\/summary>/,
  );
  assert.match(intents, /data-share-cancel="intent-1" data-revision="2"/);
  // A finished intent has no cancel button and no expansion for a short reason.
  const second = intents.slice(intents.indexOf("没标题时用话题"));
  assert.match(second, /<span class="pill warn">失败<\/span>/);
  assert.match(second, /出站 delivery-1/);
  assert.doesNotMatch(second, /data-share-cancel|app-more|来源链接/);
});

test("checking a login updates that platform's line and the fold summary", async () => {
  const p = await apps();
  p.replies["/api/apps/probe"] = { status: "checked", loggedIn: true };
  const button = { dataset: { appProbe: "zhihu" } };
  await p.run("appProbe")("agent-0", button);
  assert.equal(button.disabled, false);
  assert.deepEqual(p.calls.at(-1).data, {
    agentId: "agent-0",
    platform: "zhihu",
  });
  assert.match(p.$('[data-app-login="zhihu"]').innerHTML, /已登录/);
  assert.match(p.$('[data-app-checked="zhihu"]').textContent, /^已检查 · /);
  assert.equal(
    p.$("#app-login-summary").textContent,
    "3 个已登录 · 2 个未检查",
  );
  // A failed check still shows what the server said, then reports it.
  p.replies["/api/apps/probe"] = Error(
    "APP_VERIFICATION_REQUIRED（关联 ID：r-1）",
  );
  await assert.rejects(
    p.run("appProbe")("agent-0", { dataset: { appProbe: "tieba" } }),
    /APP_VERIFICATION_REQUIRED/,
  );
  assert.match(p.$('[data-app-login="tieba"]').innerHTML, /需要验证/);
  assert.equal(
    p.$("#app-login-summary").textContent,
    "3 个已登录 · 1 个需要登录 · 1 个未检查",
  );
});

test("the time zone is picked from the browser's list, common ones first, or typed where there is none", () => {
  const p = page();
  const field = p.run('appZoneField("Asia/Shanghai")');
  assert.match(
    field,
    /^<label>时区<select name="timezone" required><optgroup label="常用"><option value="Asia\/Shanghai" selected>北京时间 · Asia\/Shanghai<\/option>/,
  );
  assert.match(
    field,
    /<optgroup label="全部">.*<option value="Europe\/Paris">/,
  );
  assert.equal(field.match(/value="Asia\/Shanghai"/g).length, 1);
  assert.equal(field.match(/ selected/g).length, 1);
  // A saved zone the browser does not list stays chosen.
  const kept = p.run('appZoneField("Etc/GMT-8")');
  assert.match(
    kept,
    /<option value="Etc\/GMT-8" selected>Etc\/GMT-8<\/option>/,
  );
  assert.match(
    p.run('appZoneField("UTC")'),
    /<option value="UTC" selected>协调世界时 · UTC<\/option>/,
  );
  // Without the list (older browsers) the box is typed, as before.
  const typed =
    '<label>时区<input name="timezone" value="Asia/Shanghai" required placeholder="例如 Asia/Shanghai"></label>';
  p.run('Intl.supportedValuesOf = () => { throw Error("unsupported") }');
  assert.equal(p.run('appZoneField("Asia/Shanghai")'), typed);
  p.run("delete Intl.supportedValuesOf");
  assert.equal(p.run('appZoneField("Asia/Shanghai")'), typed);
  p.run("Intl.supportedValuesOf = () => []");
  assert.equal(p.run('appZoneField("Asia/Shanghai")'), typed);
});

test("saving browse settings sends the same policy as before, from the same field names", async () => {
  const p = await apps();
  const html = p.$("#content").innerHTML;
  for (const name of [
    "enabled",
    "sharing",
    "platform-bilibili",
    "platform-heybox",
    "platform-zhihu",
    "platform-xiaohongshu",
    "platform-tieba",
    "hoursEnabled",
    "hoursAll",
    "start",
    "end",
    "timezone",
    "maxReadsPerTurn",
    "maxReadsPerDay",
    "maxSharesPerDay",
    "ttlHours",
    "dedupeDays",
  ])
    assert.match(html, new RegExp(`name="${name}"`), name);
  // Times are picked, counts carry their unit and range.
  assert.match(html, /<input name="start" value="09:00" type="time" required>/);
  assert.match(
    html,
    /<input name="maxReadsPerTurn" type="number" min="1" max="30" value="6" required><span>次<\/span><\/span><small class="field-hint">1–30 次<\/small>/,
  );
  assert.match(
    html,
    /name="ttlHours" type="number" min="1" max="168" value="6" required><span>小时<\/span>/,
  );
  const saved = JSON.parse(p.run("JSON.stringify(config.agents[0].apps)"));
  await p.$("#app-policy").onsubmit({
    preventDefault() {},
    target: {
      enabled: "on",
      "platform-bilibili": "on",
      "platform-tieba": "on",
      hoursEnabled: "on",
      hoursAll: "on",
      start: "08:30",
      end: "22:00",
      timezone: "Europe/London",
      maxReadsPerTurn: "4",
      maxReadsPerDay: "50",
      maxSharesPerDay: "2",
      ttlHours: "12",
      dedupeDays: "3",
    },
  });
  const put = p.calls.find((c) => c.url === "/api/permissions/apps");
  assert.deepEqual(put, {
    url: "/api/permissions/apps",
    method: "PUT",
    data: {
      agentId: "agent-0",
      revision: 7,
      apps: {
        ...saved,
        enabled: true,
        sharing: false,
        platforms: ["bilibili", "tieba"],
        maxReadsPerTurn: 4,
        maxReadsPerDay: 50,
        maxSharesPerDay: 2,
        hours: {
          enabled: true,
          scope: "all",
          start: "08:30",
          end: "22:00",
          timezone: "Europe/London",
        },
        shareTtlMs: 12 * 3600000,
        dedupeMs: 3 * 86400000,
      },
    },
  });
  assert.deepEqual(appsPolicySchema.parse(put.data.apps), put.data.apps);
});

const filing = (edit) => (a) =>
  Object.assign(a.files, {
    enabled: true,
    download: false,
    receive: true,
    send: false,
    create: false,
    maxBytes: 20 * MiB,
    maxTotalBytes: 200 * MiB,
    maxFiles: 1000,
    localRoots: [],
    ...edit,
  });
const library = {
  storedFiles: 2,
  usedBytes: 50 * MiB,
  total: 2,
  items: [
    {
      fileId: "a".repeat(64),
      name: "季度报告<最终版>-很长很长很长很长很长很长很长很长的名字.pdf",
      bytes: 1536,
      createdAt: at,
    },
    {
      fileId: "b".repeat(64),
      name: "README",
      bytes: 3 * MiB,
      createdAt: at,
      protectionUnknown: true,
    },
  ],
  corruptCount: 0,
  corrupt: [],
  usageComplete: true,
  nextOffset: null,
  nextCorruptOffset: null,
};
async function files(edit = {}, options = {}) {
  const p = page({ ...options, replies: { "/api/files": library } });
  p.run(
    `config = ${roles(filing(edit))}; tab = "permissions"; renderFilePermissions();`,
  );
  await flush();
  return p;
}

test("files lead with the library and fold the permissions with what is allowed", async () => {
  const p = await files();
  const html = p.$("#content").innerHTML;
  assert(html.indexOf("<h2>文件库</h2>") >= 0);
  assert(
    html.indexOf("<h2>文件库</h2>") <
      html.indexOf('data-fold="files-permissions"'),
  );
  assert.match(
    html,
    /data-fold="files-permissions"><summary><span class="fold-title">自主文件收发<\/span><span class="fold-summary">已允许接收 · 上限 20 MiB<\/span><\/summary>/,
  );
  // Folders can only be typed, so the box shows what a path looks like.
  assert.match(
    html,
    /<textarea name="localRoots" rows="3" placeholder="例如：\n\/Volumes\/Data\/qq-files\n\/srv\/qq-agents\/shared\nD:\\qq-files"><\/textarea>/,
  );
  assert.match(
    html,
    /<input name="maxMiB" type="number" value="20" min="0.001" max="50" step="any" required><span>MiB<\/span><\/span><small class="field-hint">最大 50 MiB<\/small>/,
  );
  const opened = await files(
    {},
    { storage: new Map([["fold:files-permissions", "1"]]) },
  );
  assert.match(
    opened.$("#content").innerHTML,
    /data-fold="files-permissions" open>/,
  );

  const summary = (f) => p.run(`fileSummary(${JSON.stringify(f)})`);
  const base = JSON.parse(p.run("JSON.stringify(config.agents[0].files)"));
  assert.equal(summary({ ...base, enabled: false }), "未开启");
  assert.equal(
    summary({
      ...base,
      download: true,
      send: true,
      create: true,
      maxBytes: 0.5 * MiB,
      localRoots: ["/srv/a", "/srv/b"],
    }),
    "已允许下载链接、接收、发送、生成文本 · 上限 0.5 MiB · 2 个导入目录",
  );
  assert.equal(
    summary({ ...base, receive: false }),
    "已开启，未允许任何操作 · 上限 20 MiB",
  );
});

test("each file is one line: kind, cut name, size and date, download at the end", async () => {
  const p = await files();
  const lib = p.$("#file-library").innerHTML;
  assert.match(
    lib,
    /<div class="file-usage"><p><span>已用 <b>50\.00<\/b> \/ 200 MiB<\/span><span>2 \/ 1000 个占用条目<\/span><\/p><svg class="meter"[^>]*><rect class="track"[^>]*\/><rect class="bar" width="25" /,
  );
  assert.equal(lib.match(/<article class="file-row">/g).length, 2);
  assert.match(
    lib,
    /<span class="file-kind">PDF<\/span><div class="file-main"><strong class="file-name" title="季度报告&lt;最终版&gt;-很长很长很长很长很长很长很长很长的名字\.pdf">/,
  );
  assert.match(lib, /<span>1\.5 KiB<\/span>/);
  assert.match(lib, /<span>3\.00 MiB<\/span>/);
  assert.match(lib, /<span class="file-kind">文件<\/span>/);
  assert.match(
    lib,
    /<span class="file-warn">保护信息不完整，发送需批准<\/span>/,
  );
  assert.match(
    lib,
    new RegExp(`data-file="${"a".repeat(64)}">下载到本机</button></article>`),
  );
  assert.equal(p.run("fileSize(900)"), "900 字节");
});

test("saving file permissions sends the same policy as before", async () => {
  const p = await files({ localRoots: ["/srv/old"] });
  const saved = JSON.parse(p.run("JSON.stringify(config.agents[0].files)"));
  await p.$("#file-permissions").onsubmit({
    preventDefault() {},
    target: {
      enabled: "on",
      download: "on",
      send: "on",
      maxMiB: "0.5",
      totalMiB: "1024",
      maxFiles: "200",
      localRoots: " /srv/qq-agents/shared \n\nD:\\qq-files\n",
    },
  });
  const put = p.calls.find((c) => c.url === "/api/permissions/files");
  assert.deepEqual(put, {
    url: "/api/permissions/files",
    method: "PUT",
    data: {
      agentId: "agent-0",
      revision: 7,
      files: {
        ...saved,
        enabled: true,
        download: true,
        receive: false,
        send: true,
        create: false,
        maxBytes: 0.5 * MiB,
        maxTotalBytes: 1024 * MiB,
        maxFiles: 200,
        localRoots: ["/srv/qq-agents/shared", "D:\\qq-files"],
      },
    },
  });
});

test("the browse page's reads are the last day's spent reads", async (t) => {
  const f = fixture(t),
    token = randomBytes(32).toString("hex"),
    app = createServer({ runtime: f.runtime, token });
  const port = await app.listen();
  t.after(() => app.close());
  const reads = async () =>
    (
      await (
        await fetch(`http://127.0.0.1:${port}/api/apps?agentId=agent-0`, {
          headers: { "x-admin-token": token },
        })
      ).json()
    ).readsLastDay;
  assert.equal(await reads(), 0);
  const now = f.runtime.now(),
    service = appService(f.runtime);
  service.save("agent-0", {
    calls: [now - 25 * 3600000, now - 3600000, now - 1000],
  });
  assert.equal(await reads(), 2);
  assert.equal(service.readsLastDay("agent-1"), 0);
});
