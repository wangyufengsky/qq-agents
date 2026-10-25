let appAgentId;
const appLabels = {
  bilibili: "B站",
  heybox: "小黑盒",
  zhihu: "知乎",
  xiaohongshu: "小红书",
  tieba: "贴吧",
};
function renderApps() {
  if (!config.agents.some((a) => a.id === appAgentId))
    appAgentId = config.agents[0]?.id;
  const a = config.agents.find((a) => a.id === appAgentId);
  if (!a) {
    $("#content").innerHTML = '<div class="card">请先添加机器人。</div>';
    return;
  }
  const p = a.apps;
  $("#content").innerHTML =
    `<section class="card"><label>机器人<select id="app-agent">${config.agents.map((x) => `<option value="${esc(x.id)}" ${x.id === a.id ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select></label><p>浏览记录和分享意图各自独立；同一平台账号的推荐可能受两个 AI 的共同浏览影响。</p></section>
 <form id="app-policy" class="card"><h2>自主浏览与分享</h2><div class="form-grid">${check("enabled", "允许此 AI 浏览平台", p.enabled)}${check("sharing", "允许此 AI 提出分享意图", p.sharing)}${Object.entries(
   appLabels,
 )
   .map(([id, label]) =>
     check("platform-" + id, label, p.platforms.includes(id)),
   )
   .join(
     "",
   )}${input("maxReadsPerTurn", "每回合最多读取次数", p.maxReadsPerTurn, 'type="number" min="1" max="30" required')}${input("maxReadsPerDay", "每日最多读取次数", p.maxReadsPerDay, 'type="number" min="1" max="200" required')}${input("maxSharesPerDay", "每日最多分享次数", p.maxSharesPerDay, 'type="number" min="1" max="30" required')}${input("start", "浏览开始时间", p.hours.start, 'type="time" required')}${input("end", "浏览结束时间", p.hours.end, 'type="time" required')}${input("timezone", "时区", p.hours.timezone, "required")}${input("ttlHours", "分享意图有效期（小时）", p.shareTtlMs / 3600000, 'type="number" min="1" max="168" required')}${input("dedupeDays", "同目标重复分享间隔（天）", p.dedupeMs / 86400000, 'type="number" min="1" max="30" required')}</div><p class="hint">主体提出意图，目标聊天根据现场选择发送、暂缓或放弃。全局暂停、角色暂停、主动联系范围及冷却继续生效；开启浏览不会自动解除暂停。视频仅可读取标题、简介和评论。</p><button class="primary">保存浏览设置</button></form>
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
                name +
                "（" +
                v.semantic +
                "，" +
                (v.pagination ? "可继续" : "单页样本") +
                "）",
            )
            .join("、"),
        )}</p><p>搜索分页：${esc(p.search)}；评论：${esc(p.comments)}；最近探测：${esc(p.lastProbe.status)}</p><a href="${esc(p.loginUrl)}" target="_blank" rel="noreferrer noopener">本机登录网址</a> <button data-app-probe="${esc(p.platform)}">检查登录</button><span data-app-login="${esc(p.platform)}"></span></article>`,
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
                  : ` ${result.status}`;
          } finally {
            b.disabled = false;
          }
        })),
  );
  $("#app-intents").innerHTML =
    data.intents
      .map(
        (i) =>
          `<article class="record"><strong>${esc(i.appShare.title || i.topic)}</strong> ${tag(i.status)}<p>目标：${esc(i.target)} · 阅读范围：${esc(i.appShare.readingScope)}</p><p>分享理由：${esc(i.reason)}</p><p>有效期：${esc(new Date(i.expiresAt).toLocaleString())} · 出站：${esc(i.deliveryId || "尚未投递")}</p><p><a href="${esc(i.appShare.url)}" target="_blank" rel="noreferrer noopener">来源链接</a> · 记录 ${esc(i.appShare.recordId)}</p>${["waiting", "deferred", "handedoff", "selected"].includes(i.status) ? `<button data-share-cancel="${esc(i.id)}" data-revision="${i.revision}">取消此意图</button>` : ""}</article>`,
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
          `<article class="record"><strong>${esc(x.title || x.error || "浏览记录")}</strong><p>${esc(x.platform)} · ${esc(x.coverage || x.readingScope || x.error)} · ${esc(x.fetchedAt)}</p>${x.url ? `<p><a href="${esc(x.url)}" target="_blank" rel="noreferrer noopener">打开来源</a></p>` : ""}<p>${esc(x.summary || "")}</p><p class="mono">${esc(x.recordId)}</p>${x.source ? `<p>来源会话：${esc(x.source.conversation)} · 消息：${esc(x.source.messageId)}</p>` : ""}</article>`,
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
