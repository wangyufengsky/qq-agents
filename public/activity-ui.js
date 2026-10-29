// 角色动态：按回合汇总一次聊天回复或一次空闲时间实际做了什么。
let activityAgentId,
  activityFilter = "all",
  activityItems = [],
  activityNext = null;
const activityFilters = [
  ["all", "全部"],
  ["subject", "空闲时间"],
  ["chat", "聊天回复"],
  ["browse", "浏览"],
];
const activityDid = {
  browsed: "浏览",
  searched: "搜索",
  read: "阅读",
  wrote: "写作",
  reviewed: "回顾",
  "reached-out": "联系",
  rested: "休息",
};
const activityRest = {
  recent: "刚做过",
  "no-interest": "暂时没兴趣",
  budget: "额度用完",
  quiet: "安静时段",
};
const activityReasons = {
  "subject-opportunity": "定时空闲时间",
  private: "私聊消息",
  mention: "被 @",
  question: "有人提问",
  speaker: "指定发言者",
  name: "提到名字",
  keyword: "关键词",
  poke: "拍一拍",
  message: "群聊消息",
  replyCheck: "回复检查",
  sleep: "潜水前观察",
  intent: "主动意图",
  scheduled: "定时任务",
  join: "有人入群",
};
const activityPlatforms = {
  bilibili: "B 站",
  heybox: "小黑盒",
  zhihu: "知乎",
  xiaohongshu: "小红书",
  tieba: "贴吧",
};
const activityStatus = {
  failed: "回合失败",
  cancelled: "已取消",
  interrupted: "被中断",
  running: "进行中",
};
const intentWords = {
  waiting: "等待时机",
  handedoff: "已交给聊天",
  selected: "决定发送",
  deferred: "暂缓",
  cancelled: "取消",
  completed: "完成",
  "awaiting-response": "等待回应",
  expired: "过期",
};
function activityWhere(e) {
  if (e.kind === "subject") return "空闲时间";
  const [kind, id] = e.conversation.split(":");
  return (kind === "group" ? "群 " : "私聊 ") + id;
}
function activityTitle(e) {
  if (e.kind === "subject") {
    if (!e.log) return "空闲时间";
    const rest = e.log.restReason
      ? `（${activityRest[e.log.restReason] || e.log.restReason}）`
      : "";
    return `空闲时间 · ${activityDid[e.log.did] || e.log.did}${rest}`;
  }
  const why = [...new Set(e.reasons.map((r) => activityReasons[r] || r))];
  return `${activityWhere(e)}${why.length ? " · " + why.join("、") : ""}`;
}
function activityTime(e) {
  const at = new Date(e.startedAt);
  const day = at.toLocaleDateString("zh-CN", {
    month: "numeric",
    day: "numeric",
  });
  const time = at.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
  const secs = e.endedAt ? Math.round((e.endedAt - e.startedAt) / 1000) : null;
  return `${day} ${time}${secs !== null ? ` · ${secs < 90 ? secs + " 秒" : Math.round(secs / 60) + " 分钟"}` : ""}`;
}
function activityBrowsing(b) {
  if (!b.items.length && !b.searches.length && !b.failures.length) return "";
  const read = b.items.filter((x) => x.read || x.comments.length),
    listed = b.items.filter((x) => !x.read && !x.comments.length),
    platform = (p) => esc(activityPlatforms[p] || p || "平台");
  const rows = read
    .map(
      (x) =>
        `<div class="act-line"><span>${platform(x.platform)} · ${esc(x.title)}</span><span class="hint">${[x.read ? "读了正文" : "", x.comments.length ? `评论 ${x.comments.length} 条` : ""].filter(Boolean).join(" · ")}</span></div>${x.comments.length ? `<details class="act-more"><summary>看评论</summary>${x.comments.map((c) => `<p class="hint">${esc(c.author || "匿名")}：${esc(c.text)}</p>`).join("")}</details>` : ""}`,
    )
    .join("");
  const list = listed.length
    ? `<details class="act-more"><summary>${platform(listed[0].platform)} 列表里扫过 ${listed.length} 条</summary>${listed.map((x) => `<p class="hint">${esc(x.title)}</p>`).join("")}</details>`
    : "";
  const searches = b.searches
    .map(
      (s) =>
        `<div class="act-line"><span>${platform(s.platform)} · 搜索「${esc(s.query)}」</span></div>`,
    )
    .join("");
  const failed = b.failures.length
    ? `<p class="hint">浏览失败 ${b.failures.length} 次：${esc([...new Set(b.failures.map((f) => f.error))].join("、"))}</p>`
    : "";
  return `<div class="act-box">${rows}${searches}${list}${failed}</div>`;
}
const activityCard = (c) =>
  `${esc(c.call || c.personId)} v${esc(c.revision)}${c.deleted ? "（已删除）" : ""}`;
const activityMood = (m) =>
  m.missing
    ? "记录已清理"
    : m.cleared
      ? "已经过去"
      : `${esc(m.mood)}（强度 ${esc(m.intensity)}）`;
// 发送时参考的人物卡和当时的心情；卡已删除或心情记录已清理时照实说明。
function activityBasis(b) {
  if (!b) return "";
  const parts = [];
  if (b.personCard) parts.push(`参考人物卡：${activityCard(b.personCard)}`);
  if (b.mood) parts.push(`当时心情：${activityMood(b.mood)}`);
  return `<p class="hint act-basis">${parts.join(" · ")}</p>`;
}
// 这一轮提示里附上的心情和人物卡（回合记录写下的）。
function activitySeen(s) {
  if (!s) return "";
  const parts = [];
  if (s.mood) parts.push(`心情：${activityMood(s.mood)}`);
  if (s.personCards)
    parts.push(`人物卡：${s.personCards.map(activityCard).join("、")}`);
  return `<p class="hint act-basis">这一轮附上的${parts.join(" · ")}</p>`;
}
// A private intent target with a person card: its call, and the card opens.
const activityTarget = (target, p) =>
  `${esc(conversationLabel(target))}${p ? `（${personCallText(p.call)}）` : ""}`;
const activityPersonButton = (p) => (p ? personCardButton(p.personId) : "");
function activityEntry(e) {
  const quiet =
    e.kind === "subject" &&
    (e.log?.did === "rested" || (!e.log && !e.tools?.total));
  const parts = [];
  if (e.log) {
    parts.push(`<p>${esc(e.log.summary)}</p>`);
    if (e.log.next)
      parts.push(`<p class="hint">下次想做：${esc(e.log.next)}</p>`);
  } else if (e.kind === "subject" && !e.tools)
    parts.push('<p class="hint">升级前的空闲时间，没有日志和工具记录。</p>');
  if (
    e.kind === "chat" &&
    !e.sent.length &&
    !e.browsing.items.length &&
    !e.diaries.length &&
    !e.intents.decided.length &&
    ["completed-no-send", "sent"].includes(e.status)
  )
    parts.push('<p class="hint">读了新消息，这次没有开口。</p>');
  if (e.sent.length)
    parts.push(
      `<div class="act-box"><p class="hint">发出 ${e.sent.length} 条</p>${e.sent
        .slice(0, 3)
        .map(
          (s) =>
            `<div class="act-sent"><p>${s.action ? "（动作）" : ""}${esc(s.text)}</p>${s.id ? `<button type="button" class="ghost act-open" data-act-read="${esc(s.id)}">读原文</button>` : ""}</div>${activityBasis(s.basis)}`,
        )
        .join(
          "",
        )}${e.sent.length > 3 ? `<p class="hint">另有 ${e.sent.length - 3} 条</p>` : ""}</div>`,
    );
  if (e.failedSends)
    parts.push(
      `<p class="hint">有 ${e.failedSends} 条发送失败或结果未知，可在概览的待核对发送中处理。</p>`,
    );
  parts.push(activityBrowsing(e.browsing));
  if (e.externalReads)
    parts.push(`<p class="hint">联网读取 ${e.externalReads} 次</p>`);
  for (const d of e.diaries)
    parts.push(
      `<p class="hint">${d.revised ? "修改日记" : "写日记"}：<button type="button" class="act-link" data-act-read="${esc(d.id)}" title="阅读这篇日记">${esc(d.title)}</button></p>`,
    );
  for (const i of e.intents.created)
    parts.push(
      `<p class="hint">想告诉 ${activityTarget(i.target, i.person)}：${esc(i.topic)}（${esc(intentWords[i.status] || i.status)}）${activityPersonButton(i.person)}</p>`,
    );
  for (const i of e.intents.decided)
    parts.push(
      `<p class="hint">处理主动意图「${esc(i.topic)}」：${esc(intentWords[i.status] || i.status)}${i.person ? ` · 对方${personCallText(i.person.call)}` : ""}${activityPersonButton(i.person)}</p>`,
    );
  parts.push(activitySeen(e.seen));
  // Read this turn where it happened, around its first sent message or what
  // it last heard (activityPage picks which).
  if (e.contextId)
    parts.push(
      `<div class="act-actions"><button type="button" class="ghost act-open" data-act-context="${esc(e.contextId)}">看前后文</button></div>`,
    );
  const tools = e.tools
    ? e.tools.total
      ? `工具：${e.tools.names.map(esc).join("、")}${e.tools.failed ? `（失败 ${e.tools.failed} 次）` : ""}`
      : "没有调用工具"
    : "";
  const status = activityStatus[e.status]
    ? tag(activityStatus[e.status], "warn")
    : "";
  return `<article class="act-entry${quiet ? " quiet" : ""}"><div class="row"><strong>${esc(activityTitle(e))}</strong><span class="hint">${esc(activityTime(e))}</span></div>${status}${parts.join("")}${tools ? `<p class="hint mono">${tools}</p>` : ""}</article>`;
}
function activityList() {
  const list = $("#activity-list");
  if (!list) return;
  list.innerHTML =
    activityItems.map(activityEntry).join("") ||
    '<p class="hint">这个范围里还没有动态。角色在聊天中回复或进入空闲时间后会出现在这里。</p>';
  if (activityNext)
    list.insertAdjacentHTML(
      "beforeend",
      '<button id="activity-more">加载更早的动态</button>',
    );
  const more = $("#activity-more");
  if (more) more.onclick = () => action(() => loadActivity(true));
  // The list always shows the selected role's entries (loadActivity checks).
  const agentId = activityAgentId;
  list
    .querySelectorAll("[data-act-read]")
    .forEach(
      (b) => (b.onclick = () => readMemory(b.dataset.actRead, { agentId })),
    );
  list.querySelectorAll("[data-act-context]").forEach(
    (b) =>
      (b.onclick = () =>
        readConversation({
          agentId,
          aroundId: b.dataset.actContext,
          contextSeconds: 1800,
        })),
  );
  bindPersonCards(list, agentId);
}
async function loadActivity(append = false) {
  const agentId = activityAgentId,
    filter = activityFilter;
  const query = new URLSearchParams({ agentId, filter });
  if (append && activityNext) query.set("before", String(activityNext));
  const page = await api("/api/activity?" + query);
  if (
    tab !== "activity" ||
    agentId !== activityAgentId ||
    filter !== activityFilter
  )
    return;
  activityItems = append ? [...activityItems, ...page.items] : page.items;
  activityNext = page.nextBefore;
  activityList();
}
function renderActivity() {
  if (!config.agents.some((a) => a.id === activityAgentId))
    activityAgentId = config.agents[0]?.id;
  if (!activityAgentId) {
    $("#content").innerHTML = '<div class="card">请先添加角色。</div>';
    return;
  }
  $("#content").innerHTML =
    `<section class="card"><div class="toolbar"><label>角色<select id="activity-agent">${config.agents.map((a) => `<option value="${esc(a.id)}" ${a.id === activityAgentId ? "selected" : ""}>${esc(a.name)}</option>`).join("")}</select></label><div class="act-filters" role="group" aria-label="筛选">${activityFilters.map(([id, label]) => `<button type="button" data-activity-filter="${id}" class="${id === activityFilter ? "primary" : "ghost"}" aria-pressed="${id === activityFilter}">${label}</button>`).join("")}</div><button type="button" id="activity-refresh">刷新</button></div><p class="hint">每一条是一次聊天回复或一次空闲时间。同一帖子的浏览、正文和评论合并在一起；升级前的回合没有工具记录。</p></section><section class="card" id="activity-list"><p class="hint">读取中…</p></section>`;
  $("#activity-agent").onchange = (e) => {
    activityAgentId = e.target.value;
    activityItems = [];
    action(() => loadActivity());
  };
  document.querySelectorAll("[data-activity-filter]").forEach(
    (b) =>
      (b.onclick = () => {
        activityFilter = b.dataset.activityFilter;
        renderActivity();
      }),
  );
  $("#activity-refresh").onclick = () => action(() => loadActivity());
  action(() => loadActivity());
}
