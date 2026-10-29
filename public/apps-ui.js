let appAgentId,
  // The platform the history is narrowed to ("all" for every one).
  appFilter = "all",
  // The platforms as last read, so a login check can update its row.
  appSites = [];
const appLabels = {
  bilibili: "B站",
  heybox: "小黑盒",
  zhihu: "知乎",
  xiaohongshu: "小红书",
  tieba: "贴吧",
};
const appWords = {
  following: "关注流",
  hot: "热门",
  ranking: "排行榜",
  recommend: "推荐",
  board: "板块",
  page: "按页继续",
  cursor: "连续分页",
  offset: "连续分页",
  scroll: "滚动继续",
  "search-results-scroll": "搜索结果（滚动读取）",
  APP_LOGIN_REQUIRED: "需要本机登录",
  APP_VERIFICATION_REQUIRED: "需要在官网完成验证",
  APP_SEARCH_UNAVAILABLE: "搜索暂不可用",
  APP_CURSOR_RESTARTED: "浏览页面已失效，请重新开始",
  sample: "有限样本",
  "first-page": "首批结果",
  "following-timeline": "关注动态",
  "popular-list": "热门内容",
  "hot-list": "热榜",
  "hot-topics": "热门话题",
  "personalized-recommendations": "推荐信息流",
  "recommendations-account-dependent": "推荐内容（受账号状态影响）",
  "forum-posts": "板块帖子",
  "not-tested": "尚未检查",
  checked: "已检查",
  ok: "读取成功",
  "login-required": "需要本机登录",
  "credential-present-unverified": "发现本机登录信息，账号有效性待核验",
  "public-read": "公开读取可用，登录状态未核验",
  "answer-text": "回答正文",
  "post-text": "帖子正文",
  "dynamic-text": "动态文字",
  "dynamic-summary": "动态摘要",
  "dynamic-metadata": "动态元数据",
  "note-text": "笔记正文",
  "post-metadata": "帖子元数据",
  "note-metadata": "笔记元数据",
  "video-metadata": "视频标题和简介",
  "sampled-comments": "评论样本",
  "thread-replies": "楼层回复",
  "thread-comments": "帖子评论",
  "thread-text": "帖子与楼层",
  "card-summary": "分享卡片摘要",
  waiting: "等待目标会话",
  deferred: "暂缓",
  handedoff: "已交给目标会话",
  selected: "目标会话决定发送",
  completed: "已完成",
  cancelled: "已取消",
  expired: "已过期",
  failed: "失败",
  unknown: "送达结果未知",
};
const appWord = (x) => appWords[x] || x || "暂无";
// What a record says the role did with its source.
const appOps = {
  read: "读过正文",
  comments: "看过评论",
  browse: "浏览列表",
  search: "搜索",
  boards: "看板块",
};
const appPlatform = (id) => appLabels[id] || id || "其他";
const appTime = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
};
// Common time zones lead the picker; the browser's own list follows.
const appCommonZones = [
  ["Asia/Shanghai", "北京时间"],
  ["Asia/Hong_Kong", "香港"],
  ["Asia/Taipei", "台北"],
  ["Asia/Tokyo", "东京"],
  ["Asia/Singapore", "新加坡"],
  ["UTC", "协调世界时"],
  ["Europe/London", "伦敦"],
  ["America/New_York", "纽约"],
  ["America/Los_Angeles", "洛杉矶"],
];
// The browser's time zone names, or null where it cannot list them.
function appZones() {
  try {
    const zones = Intl.supportedValuesOf("timeZone");
    return zones?.length ? zones : null;
  } catch {
    return null;
  }
}
// A picker of time zones that keeps the saved one even if the browser does
// not list it; a plain box where the browser has no list at all.
function appZoneField(value) {
  const zones = appZones();
  if (!zones)
    return input(
      "timezone",
      "时区",
      value,
      'required placeholder="例如 Asia/Shanghai"',
    );
  const common = appCommonZones.map(([z]) => z),
    rest = [...new Set([value, ...zones])]
      .filter((z) => z && !common.includes(z))
      .sort(),
    option = (z, text = z) =>
      `<option value="${esc(z)}"${z === value ? " selected" : ""}>${esc(text)}</option>`;
  return `<label>时区<select name="timezone" required><optgroup label="常用">${appCommonZones.map(([z, name]) => option(z, `${name} · ${z}`)).join("")}</optgroup><optgroup label="全部">${rest.map((z) => option(z)).join("")}</optgroup></select></label>`;
}
// A count with its unit after the box and the allowed range under it.
const appNumber = (key, label, value, min, max, unit) =>
  `<label>${label}<span class="unit-field"><input name="${key}" type="number" min="${min}" max="${max}" value="${esc(value)}" required><span>${unit}</span></span><small class="field-hint">${min}–${max} ${unit}</small></label>`;
// The saved settings in one line: platforms, hours, reads against the cap.
function appPolicySummary(p, reads) {
  if (!p.enabled) return "未开启";
  const names = Object.keys(appLabels)
    .filter((id) => p.platforms.includes(id))
    .map((id) => appLabels[id]);
  return [
    names.length ? `已启用 ${names.join("、")}` : "已开启，未选平台",
    p.hours.enabled === false ? "全天" : `${p.hours.start}–${p.hours.end}`,
    reads === undefined
      ? `每天最多读 ${p.maxReadsPerDay} 次`
      : `24 小时内已读 ${reads}/${p.maxReadsPerDay}`,
    p.sharing ? "" : "不提出分享",
  ]
    .filter(Boolean)
    .join(" · ");
}
// The last check of a platform's local login: [pill, tone, group].
function appLogin(probe = {}) {
  const s = probe.status;
  if (probe.loggedIn === true) return ["已登录", "live", "已登录"];
  if (
    probe.loggedIn === false ||
    ["APP_LOGIN_REQUIRED", "login-required"].includes(s)
  )
    return ["需要登录", "warn", "需要登录"];
  if (s === "APP_VERIFICATION_REQUIRED")
    return ["需要验证", "warn", "需要登录"];
  if (!s || s === "not-tested") return ["未检查", "", "未检查"];
  if (/^APP_/.test(s)) return ["出错", "warn", "出错"];
  return [
    {
      ok: "读取正常",
      "public-read": "公开可读",
      "credential-present-unverified": "登录待核验",
    }[s] || "已检查",
    "",
    "可读取",
  ];
}
// "2 个已登录 · 1 个需要登录" over every platform.
function appLoginSummary(sites) {
  const groups = sites.map((p) => appLogin(p.lastProbe)[2]);
  return (
    ["已登录", "需要登录", "出错", "可读取", "未检查"]
      .map((g) => [g, groups.filter((x) => x === g).length])
      .filter(([, n]) => n)
      .map(([g, n]) => `${n} 个${g}`)
      .join(" · ") || "没有平台"
  );
}
const appChecked = (probe = {}) =>
  [appWord(probe.status), probe.at ? appTime(probe.at) : ""]
    .filter(Boolean)
    .join(" · ");
// One platform as one line; its entries, limits and login open below it.
const appSite = (p) =>
  `<details class="app-site"><summary><span class="app-site-name">${esc(p.name)}</span>${tag(p.enabled ? "已启用" : "未启用", p.enabled ? "" : "off")}<span class="app-site-state" data-app-login="${esc(p.platform)}">${tag(...appLogin(p.lastProbe).slice(0, 2))}</span></summary><dl class="app-facts"><dt>入口</dt><dd class="app-chips">${Object.entries(
    p.browse,
  )
    .map(
      ([name, v]) =>
        `<span class="app-chip" title="${esc(appWord(v.semantic))}">${esc(appWord(name))}<small>${v.pagination ? "可继续" : "单页"}</small></span>`,
    )
    .join(
      "",
    )}</dd><dt>搜索</dt><dd>${esc(appWord(p.search))}</dd><dt>评论</dt><dd>${esc(appWord(p.comments))}</dd><dt>最近检查</dt><dd data-app-checked="${esc(p.platform)}">${esc(appChecked(p.lastProbe))}</dd></dl><div class="app-site-actions"><a href="${esc(p.loginUrl)}" target="_blank" rel="noreferrer noopener">打开登录网址</a><button type="button" data-app-probe="${esc(p.platform)}">检查登录</button></div></details>`;
const appChip = (text, cls = "") =>
  `<span class="app-chip${cls ? " " + cls : ""}">${esc(text)}</span>`;
// Every history row has one shape: platform, title cut to one line, time;
// then what was read as small tags; then at most two lines of summary.
function appHistoryRow(x) {
  const failed = x.ok === false,
    title = x.title || (failed ? "读取失败" : "浏览记录"),
    scope = x.coverage || x.readingScope;
  return `<article class="app-row${failed ? " is-failed" : ""}"><div class="app-row-head"><span class="app-badge is-${esc(x.platform || "other")}">${esc(appPlatform(x.platform))}</span><strong class="app-row-title" title="${esc(title)}">${esc(title)}</strong><time class="app-row-time" datetime="${esc(x.fetchedAt)}">${esc(appTime(x.fetchedAt))}</time></div><div class="app-row-meta">${x.origin === "qq-card" ? appChip("QQ 分享卡片") : ""}${appOps[x.operation] ? appChip(appOps[x.operation], ["read", "comments"].includes(x.operation) ? "is-deep" : "") : ""}${failed ? appChip(appWord(x.error), "is-bad") : scope ? appChip(appWord(scope), "is-quiet") : ""}${x.source?.conversation ? `<span title="消息 ${esc(x.source.messageId)}">来自${esc(conversationLabel(x.source.conversation))}</span>` : ""}${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noreferrer noopener">打开来源</a>` : ""}<small class="app-row-id mono" title="记录 ID">${esc(x.recordId)}</small></div>${x.summary ? `<p class="app-row-text" title="${esc(x.summary)}">${esc(x.summary)}</p>` : ""}</article>`;
}
const appOpen = ["waiting", "deferred", "handedoff", "selected"];
const appIntentTone = (s) =>
  ["failed", "unknown"].includes(s)
    ? "warn"
    : ["cancelled", "expired"].includes(s)
      ? "off"
      : "";
function appIntentRow(i) {
  const s = i.appShare,
    title = s.title || i.topic,
    reason = i.reason || "";
  return `<article class="app-row"><div class="app-row-head"><span class="app-badge is-${esc(s.platform || "other")}">${esc(appPlatform(s.platform))}</span><strong class="app-row-title" title="${esc(title)}">${esc(title)}</strong>${tag(appWord(i.status), appIntentTone(i.status))}</div><div class="app-row-meta"><span>发给${esc(conversationLabel(String(i.target || "")))}</span><span>有效至 ${esc(appTime(i.expiresAt))}</span><span class="app-row-id">${i.deliveryId ? "出站 " + esc(i.deliveryId) : "尚未投递"}</span>${s.readingScope ? appChip(appWord(s.readingScope), "is-quiet") : ""}</div><p class="app-row-text" title="${esc(reason)}">${esc(reason)}</p>${reason.length > 60 ? `<details class="app-more"><summary>完整理由</summary><p>${esc(reason)}</p></details>` : ""}<div class="app-row-meta">${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noreferrer noopener">来源链接</a>` : ""}<small class="app-row-id mono" title="记录 ID">${esc(s.recordId)}</small>${appOpen.includes(i.status) ? `<button type="button" data-share-cancel="${esc(i.id)}" data-revision="${i.revision}">取消此意图</button>` : ""}</div></article>`;
}
function renderApps() {
  if (!config.agents.some((a) => a.id === appAgentId))
    appAgentId = config.agents[0]?.id;
  const a = config.agents.find((a) => a.id === appAgentId);
  if (!a) {
    $("#content").innerHTML = '<div class="card">请先添加角色。</div>';
    return;
  }
  const p = a.apps;
  // What the role read and wants to share comes first; the settings and the
  // platforms fold below with their state in the title line.
  $("#content").innerHTML =
    `<section class="card"><div class="app-head"><h2>浏览记录</h2><button type="button" id="app-refresh" class="ghost">刷新</button></div><p class="hint">每条是一次读取：读过正文、看过评论，还是只浏览了列表。</p><div id="app-history"><p class="hint">正在读取…</p></div></section>
 <section class="card"><div class="app-head"><h2>分享意图</h2></div><p class="hint">看到值得分享的内容时留下的意图，由目标聊天决定说不说；和浏览记录分开保存。</p><div id="app-intents"><p class="hint">正在读取…</p></div></section>
 ${fold(
   "apps-policy",
   "浏览设置",
   `<form id="app-policy" class="app-form"><p class="hint">开启后，这个角色会在空闲时间和聊天中自行浏览勾选的平台，看到值得分享的内容时交给对应聊天决定说不说。</p><div class="form-grid">${check("enabled", "允许浏览平台", p.enabled)}${check("sharing", "允许提出分享", p.sharing)}</div><h3>平台</h3><div class="app-picks">${Object.entries(
     appLabels,
   )
     .map(([id, label]) =>
       check("platform-" + id, label, p.platforms.includes(id)),
     )
     .join(
       "",
     )}</div><h3>时段</h3><div class="form-grid">${check("hoursEnabled", "只在这个时段自主浏览", p.hours.enabled !== false)}${check("hoursAll", "时段也约束用户的明确请求", p.hours.scope === "all")}</div><div class="form-grid app-three">${input("start", "开始", p.hours.start, 'type="time" required')}${input("end", "结束", p.hours.end, 'type="time" required')}${appZoneField(p.hours.timezone)}</div><h3>额度</h3><div class="form-grid app-three">${appNumber("maxReadsPerTurn", "每回合最多读取", p.maxReadsPerTurn, 1, 30, "次")}${appNumber("maxReadsPerDay", "每天最多读取", p.maxReadsPerDay, 1, 200, "次")}${appNumber("maxSharesPerDay", "每天最多分享", p.maxSharesPerDay, 1, 30, "次")}</div><h3>分享</h3><div class="form-grid">${appNumber("ttlHours", "分享意图有效期", p.shareTtlMs / 3600000, 1, 168, "小时")}${appNumber("dedupeDays", "同一目标重复分享间隔", p.dedupeMs / 86400000, 1, 30, "天")}</div><p class="hint">读取额度始终有效；暂停、主动联系范围和冷却继续生效。用户请求须引用本轮读到的原始链接或 /search、/browse、/boards 指令。视频只能读标题、简介和评论。</p><button class="primary">保存浏览设置</button></form>`,
   {
     summary: `<span id="app-policy-summary">${esc(appPolicySummary(p))}</span>`,
   },
 )}
 ${fold(
   "apps-platforms",
   "平台能力与本机登录",
   '<p class="hint">在已连接 OpenCLI 的 Chrome 内完成登录或扫码，不要在聊天中发送密码或 Cookie；登录检查只返回状态。同一平台账号的推荐可能受两个 AI 的共同浏览影响。</p><div id="app-platforms"><p class="hint">正在读取…</p></div>',
   { summary: '<span id="app-login-summary">正在读取…</span>' },
 )}`;
  $("#app-policy").onsubmit = (e) => {
    e.preventDefault();
    action(async () => {
      const d = new FormData(e.target);
      await api(
        "/api/permissions/apps",
        {
          agentId: a.id,
          revision,
          apps: {
            ...p,
            enabled: d.has("enabled"),
            sharing: d.has("sharing"),
            platforms: Object.keys(appLabels).filter((id) =>
              d.has("platform-" + id),
            ),
            maxReadsPerTurn: Number(d.get("maxReadsPerTurn")),
            maxReadsPerDay: Number(d.get("maxReadsPerDay")),
            maxSharesPerDay: Number(d.get("maxSharesPerDay")),
            hours: {
              enabled: d.has("hoursEnabled"),
              scope: d.has("hoursAll") ? "all" : "autonomous",
              start: d.get("start"),
              end: d.get("end"),
              timezone: d.get("timezone"),
            },
            shareTtlMs: Number(d.get("ttlHours")) * 3600000,
            dedupeMs: Number(d.get("dedupeDays")) * 86400000,
          },
        },
        "PUT",
      );
      await load();
      notice("浏览设置已保存，暂停状态保留。");
    });
  };
  $("#app-refresh").onclick = () => action(() => loadApps(a.id));
  action(() => loadApps(a.id));
}
async function appProbe(agentId, b) {
  const platform = b.dataset.appProbe;
  let probe, failure;
  b.disabled = true;
  try {
    const result = await api("/api/apps/probe", { agentId, platform });
    probe = { status: result.status || "checked", loggedIn: result.loggedIn };
  } catch (e) {
    failure = e;
    // A failed check names its APP_ code; the row shows it as the server
    // records it.
    const code = /APP_[A-Z_]+/.exec(e.message)?.[0];
    if (code) probe = { status: code };
  } finally {
    b.disabled = false;
  }
  if (probe && tab === "apps" && appAgentId === agentId) {
    const site = appSites.find((p) => p.platform === platform);
    if (site) site.lastProbe = { ...probe, at: new Date().toISOString() };
    document.querySelector(`[data-app-login="${platform}"]`).innerHTML = tag(
      ...appLogin(probe).slice(0, 2),
    );
    document.querySelector(`[data-app-checked="${platform}"]`).textContent =
      appChecked(site?.lastProbe || probe);
    $("#app-login-summary").textContent = appLoginSummary(appSites);
  }
  if (failure) throw failure;
}
// The history page as read, narrowed to one platform when picked.
function showAppHistory(agentId, data) {
  const rows = data.history.items,
    present = Object.keys(appLabels).filter((id) =>
      rows.some((x) => x.platform === id),
    );
  if (!present.includes(appFilter)) appFilter = "all";
  const pick = (id, label, n) =>
    `<button type="button" data-app-filter="${id}" class="${id === appFilter ? "primary" : "ghost"}" aria-pressed="${id === appFilter}">${label}<small>${n}</small></button>`;
  $("#app-history").innerHTML =
    (present.length > 1
      ? `<div class="app-filter" role="group" aria-label="按平台筛选">${pick("all", "全部", rows.length)}${present.map((id) => pick(id, appLabels[id], rows.filter((x) => x.platform === id).length)).join("")}</div>`
      : "") +
    (rows
      .filter((x) => appFilter === "all" || x.platform === appFilter)
      .map(appHistoryRow)
      .join("") || '<p class="hint">尚无浏览记录。</p>') +
    (data.progress.length
      ? `<p class="hint">${data.progress.length} 个可继续的浏览进度；缓存 ${data.progress.reduce((n, x) => n + x.buffered, 0)} 条尚未展示的内容。进度有效期为 1 小时。</p>`
      : "") +
    (data.history.nextOffset !== null
      ? '<button type="button" id="app-history-more">更早的记录</button>'
      : "");
  $("#app-history").onclick = (e) => {
    const id = e.target.closest?.("[data-app-filter]")?.dataset.appFilter;
    if (!id) return;
    appFilter = id;
    showAppHistory(agentId, data);
  };
  if (data.history.nextOffset !== null)
    $("#app-history-more").onclick = () =>
      action(() => loadApps(agentId, data.history.nextOffset));
}
async function loadApps(agentId, offset = 0) {
  const data = await api(
    "/api/apps?" + new URLSearchParams({ agentId, offset }),
  );
  if (tab !== "apps" || appAgentId !== agentId) return;
  const p = config.agents.find((a) => a.id === agentId)?.apps;
  if (p && data.readsLastDay !== undefined)
    $("#app-policy-summary").textContent = appPolicySummary(
      p,
      data.readsLastDay,
    );
  appSites = data.capabilities.platforms;
  $("#app-login-summary").textContent = appLoginSummary(appSites);
  $("#app-platforms").innerHTML = appSites.map(appSite).join("");
  document
    .querySelectorAll("[data-app-probe]")
    .forEach((b) => (b.onclick = () => action(() => appProbe(agentId, b))));
  $("#app-intents").innerHTML =
    data.intents.map(appIntentRow).join("") ||
    '<p class="hint">尚无分享意图；没有意图不表示需要强行分享。</p>';
  document.querySelectorAll("[data-share-cancel]").forEach(
    (b) =>
      (b.onclick = () =>
        action(async () => {
          await api("/api/apps/cancel", {
            agentId,
            id: b.dataset.shareCancel,
            revision: Number(b.dataset.revision),
          });
          await loadApps(agentId);
          notice("分享意图已取消。");
        })),
  );
  showAppHistory(agentId, data);
}
