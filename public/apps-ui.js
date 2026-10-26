let appAgentId;
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
function renderApps() {
  if (!config.agents.some((a) => a.id === appAgentId))
    appAgentId = config.agents[0]?.id;
  const a = config.agents.find((a) => a.id === appAgentId);
  if (!a) {
    $("#content").innerHTML = '<div class="card">请先添加智能体。</div>';
    return;
  }
  const p = a.apps;
  $("#content").innerHTML =
    `<section class="card"><label>智能体<select id="app-agent">${config.agents.map((x) => `<option value="${esc(x.id)}" ${x.id === a.id ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select></label><p>浏览记录和分享意图各自独立；同一平台账号的推荐可能受两个 AI 的共同浏览影响。</p></section>
 <form id="app-policy" class="card"><h2>自主浏览与分享</h2><div class="form-grid">${check("enabled", "允许此 AI 浏览平台", p.enabled)}${check("sharing", "允许此 AI 提出分享意图", p.sharing)}${Object.entries(
   appLabels,
 )
   .map(([id, label]) =>
     check("platform-" + id, label, p.platforms.includes(id)),
   )
   .join(
     "",
   )}${input("maxReadsPerTurn", "每回合最多读取次数", p.maxReadsPerTurn, 'type="number" min="1" max="30" required')}${input("maxReadsPerDay", "每日最多读取次数", p.maxReadsPerDay, 'type="number" min="1" max="200" required')}${input("maxSharesPerDay", "每日最多分享次数", p.maxSharesPerDay, 'type="number" min="1" max="30" required')}${check("hoursEnabled", "启用浏览时段限制", p.hours.enabled !== false)}${check("hoursAll", "时段也约束用户明确请求", p.hours.scope === "all")}${input("start", "浏览开始时间", p.hours.start, 'type="time" required')}${input("end", "浏览结束时间", p.hours.end, 'type="time" required')}${input("timezone", "时区", p.hours.timezone, "required")}${input("ttlHours", "分享意图有效期（小时）", p.shareTtlMs / 3600000, 'type="number" min="1" max="168" required')}${input("dedupeDays", "同目标重复分享间隔（天）", p.dedupeMs / 86400000, 'type="number" min="1" max="30" required')}</div><p class="hint">主体提出意图，目标聊天根据现场选择发送、暂缓或放弃。全局暂停、角色暂停、主动联系范围及冷却继续生效；开启浏览不会自动解除暂停。关闭时段限制后全天可浏览；默认仅限制自主浏览。用户请求须引用本轮已读取的人类原始 URL 或 /search、/browse、/boards 明确请求；读取预算始终有效。视频仅可读取标题、简介和评论。</p><button class="primary">保存浏览设置</button></form>
 <section class="card"><h2>平台能力与本机登录</h2><p class="hint">在已连接 OpenCLI 的 Chrome 内完成登录或扫码。不要在聊天中发送密码或 Cookie。登录检查只返回状态。</p><div id="app-platforms">正在读取…</div></section>
 <section class="card"><h2>${esc(a.name)}的浏览记录</h2><button id="app-refresh">刷新记录</button><div id="app-history"></div></section><section class="card"><h2>分享意图</h2><div id="app-intents">正在读取…</div></section>`;
  $("#app-agent").onchange = (e) => {
    appAgentId = e.target.value;
    renderApps();
  };
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
async function loadApps(agentId, offset = 0) {
  const data = await api(
    "/api/apps?" + new URLSearchParams({ agentId, offset }),
  );
  if (tab !== "apps" || appAgentId !== agentId) return;
  $("#app-platforms").innerHTML = data.capabilities.platforms
    .map(
      (p) =>
        `<article class="record"><h3>${esc(p.name)} ${tag(p.enabled ? "已启用" : "未启用")}</h3><p>入口：${esc(
          Object.entries(p.browse)
            .map(
              ([name, v]) =>
                appWord(name) +
                "（" +
                appWord(v.semantic) +
                "，" +
                (v.pagination ? "可继续" : "单页样本") +
                "）",
            )
            .join("、"),
        )}</p><p>搜索分页：${esc(appWord(p.search))}；评论：${esc(appWord(p.comments))}；最近探测：${esc(appWord(p.lastProbe.status))}</p><a href="${esc(p.loginUrl)}" target="_blank" rel="noreferrer noopener">本机登录网址</a> <button data-app-probe="${esc(p.platform)}">检查登录</button><span data-app-login="${esc(p.platform)}"></span></article>`,
    )
    .join("");
  document.querySelectorAll("[data-app-probe]").forEach(
    (b) =>
      (b.onclick = () =>
        action(async () => {
          b.disabled = true;
          try {
            const result = await api("/api/apps/probe", {
              agentId,
              platform: b.dataset.appProbe,
            });
            if (tab !== "apps" || appAgentId !== agentId) return;
            document.querySelector(
              `[data-app-login="${b.dataset.appProbe}"]`,
            ).textContent =
              result.loggedIn === true
                ? " 已登录"
                : result.loggedIn === false
                  ? " 未登录"
                  : ` ${appWord(result.status)}`;
          } finally {
            b.disabled = false;
          }
        })),
  );
  $("#app-intents").innerHTML =
    data.intents
      .map(
        (i) =>
          `<article class="record"><strong>${esc(i.appShare.title || i.topic)}</strong> ${tag(appWord(i.status))}<p>目标：${esc(i.target)} · 阅读范围：${esc(appWord(i.appShare.readingScope))}</p><p>分享理由：${esc(i.reason.slice(0, 220))}${i.reason.length > 220 ? "…" : ""}</p>${i.reason.length > 220 ? `<details><summary>展开完整理由</summary><p>${esc(i.reason)}</p></details>` : ""}<p>有效期：${esc(new Date(i.expiresAt).toLocaleString())} · 出站：${esc(i.deliveryId || "尚未投递")}</p><p><a href="${esc(i.appShare.url)}" target="_blank" rel="noreferrer noopener">来源链接</a> · 记录 ${esc(i.appShare.recordId)}</p>${["waiting", "deferred", "handedoff", "selected"].includes(i.status) ? `<button data-share-cancel="${esc(i.id)}" data-revision="${i.revision}">取消此意图</button>` : ""}</article>`,
      )
      .join("") ||
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
  $("#app-history").innerHTML =
    data.history.items
      .map(
        (x) =>
          `<article class="record"><strong>${esc(x.title || x.error || "浏览记录")}</strong><p>${esc(appLabels[x.platform] || x.platform)} · ${esc(appWord(x.coverage || x.readingScope || x.error))} · ${esc(x.fetchedAt)}</p>${x.url ? `<p><a href="${esc(x.url)}" target="_blank" rel="noreferrer noopener">打开来源</a></p>` : ""}<p>${esc(x.summary || "")}</p><p class="mono">${esc(x.recordId)}</p>${x.source ? `<p>来源会话：${esc(x.source.conversation)} · 消息：${esc(x.source.messageId)}</p>` : ""}</article>`,
      )
      .join("") || '<p class="hint">尚无浏览记录。</p>';
  if (data.progress.length)
    $("#app-history").insertAdjacentHTML(
      "beforeend",
      `<p class="hint">${data.progress.length} 个可继续的浏览进度；缓存 ${data.progress.reduce((n, x) => n + x.buffered, 0)} 条尚未展示的内容。进度有效期为 1 小时。</p>`,
    );
  if (data.history.nextOffset !== null) {
    $("#app-history").insertAdjacentHTML(
      "beforeend",
      '<button id="app-history-more">下一页</button>',
    );
    $("#app-history-more").onclick = () =>
      action(() => loadApps(agentId, data.history.nextOffset));
  }
}
