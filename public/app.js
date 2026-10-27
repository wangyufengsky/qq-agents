const $ = (s) => document.querySelector(s),
  esc = (s) =>
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
    );
let configMigrationWarnings = [];
let token = sessionStorage.getItem("qq-unified-token") || "",
  config,
  revision,
  tools = [],
  status,
  tab = "overview",
  editing,
  errorFilter = "",
  features = {},
  globalPausePending = false;
const titles = {
  apps: ["浏览与分享", "按主体配置平台浏览，查看真实来源和分享决定。"],
  mind: ["Self 与主体", "当前自我、候选成长、主动意图与工作会话。"],
  permissions: ["权限", "分别设置每个 AI 的文件收发能力与独立文件库。"],
  schedule: ["主动与定时", "条件唤醒、睡前观察和定时任务，各自按规则运行。"],
  voices: ["语音库", "导入、试听和管理每个角色自己的语音素材。"],
  operations: ["运维", "逐项确认管理员操作。"],
  overview: ["首页", "在一个地方，照看每个独立的 AI。"],
  links: [
    "连接",
    "QQ 账号与 AI 后端。连接前核对登录账号，后端可单独检测与恢复。",
  ],
  activity: ["动态", "每个角色最近做了什么：聊天回复、空闲时间、浏览与日记。"],
  agents: ["角色", "人格与经历归属于稳定身份，切换后端也能延续。"],
  connections: ["QQ 账号", "每个 QQ 账号独立连接，启停连接不影响登录数据。"],
  backends: ["AI 后端", "管理 DSH、Codex 与各自的模型和工具。"],
  memory: ["经历与日记", "消息按实际发生记录；日记由 AI 自主书写。"],
  settings: ["运行设置", "隔离开发、全局参与边界与可迁移配置。"],
};
// Config path below "<agents|connections|backends>.<index>." → editor input
// name. Paths not listed match an input of the same name (httpUrl, wsUrl,
// accountId, name, model…); add a row when a form field stores its value
// under a different config key. Unmatched paths are shown as-is.
const fieldInputs = {
  "allow.groups": "groups",
  "allow.users": "users",
  "wake.participation": "participation",
  "wake.cooldownMs": "cooldownSeconds",
  "network.autonomous": "autonomousNetwork",
  "network.publicUrls": "publicUrls",
  "github.enabled": "githubEnabled",
  "github.auth": "githubAuth",
  "github.tokenEnv": "githubTokenEnv",
  "github.privateRepositories": "githubPrivateRepositories",
  maxSendsPerTurn: "maxConsecutiveSends",
  "recovery.autoReconnect": "autoReconnect",
  "recovery.maxAttempts": "maxAttempts",
};
function fieldInput(path) {
  const [type, index, ...rest] = path.split(".");
  if (!$("#editor").open || !config?.[type] || editing?.type !== type)
    return null;
  const at = editing.id
    ? config[type].findIndex((x) => x.id === editing.id)
    : config[type].length;
  if (String(at) !== index) return null;
  for (let n = rest.length; n > 0; n--) {
    const key = rest.slice(0, n).join(".");
    const el = $("#edit-form").elements.namedItem(fieldInputs[key] || key);
    if (el?.tagName) return el;
  }
  return null;
}
function fieldErrorHint(fields) {
  const named = [],
    unmatched = [];
  let first;
  for (const path of fields) {
    const el = fieldInput(path);
    if (!el) {
      unmatched.push(path);
      continue;
    }
    el.classList.add("invalid");
    el.setAttribute("aria-invalid", "true");
    first ||= el;
    const label = [...(el.closest("label")?.childNodes || [])]
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent)
      .join("")
      .trim();
    if (!named.includes(label || path)) named.push(label || path);
  }
  if (first) {
    // The agent editor keeps fields in collapsible sections; reveal the field.
    for (
      let d = first.closest("details");
      d;
      d = d.parentElement?.closest("details")
    )
      d.open = true;
    first.scrollIntoView({ block: "center" });
    first.focus({ preventScroll: true });
  }
  return (
    [
      named.length && `格式不正确：${named.join("、")}，已在表单中标出`,
      unmatched.length && `配置校验未通过的字段：${unmatched.join("、")}`,
    ]
      .filter(Boolean)
      .join("；") + "。"
  );
}
async function api(url, data, method) {
  const r = await fetch(url, {
    method: method || (data ? "POST" : "GET"),
    headers: {
      "x-admin-token": token,
      ...(data ? { "content-type": "application/json" } : {}),
    },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  const value = await r.json();
  if (!r.ok) {
    const hint =
      (value.fields?.length && fieldErrorHint(value.fields)) ||
      {
        UNAUTHORIZED:
          "令牌不正确，请复制数据目录中 admin-token 文件的全部内容。",
        INVALID_REQUEST: "提交内容格式不正确，请检查后重试。",
        CONFIG_SAVE_FAILED:
          "配置保存失败，当前配置和回合保持原状。请检查最近错误中的磁盘诊断。",
        CONFIG_CONFLICT: "配置已变化，请刷新页面后重新核对修改。",
        FILE_METADATA_CORRUPT: "文件元数据损坏，请在文件库中查看并修复。",
        FILE_METADATA_MISSING:
          "文件内容仍存在但元数据缺失，请先修复，不能直接重传覆盖。",
        FILE_REMOVED_PROTECTED:
          "该内容已保留保护拦截记录，不能通过重新导入清除保护。",
        FILE_QUOTA_EXCEEDED:
          "文件库容量或数量额度不足；损坏、孤儿文件和元数据仍计入占用。",
        FILE_QUOTA_UNAVAILABLE:
          "无法完整统计文件占用，请检查文件权限和异常目录后重试。",
        FILE_REPAIR_NOT_NEEDED: "该文件正常，不需要损坏恢复操作。",
        SEND_BUDGET_CORRUPT:
          "发送预算记录损坏，已停止新增投递，请检查数据并从可信备份恢复。",
        RUNTIME_CLOSING: "服务正在停止，请等待服务恢复后刷新。",
        INTERNAL_ERROR: "服务内部故障，请查看概览中的最近错误。",
      }[value.error] ||
      value.error ||
      "请求失败";
    throw Error(
      hint +
        (value.requestId && value.error !== "UNAUTHORIZED"
          ? `（关联 ID：${value.requestId}）`
          : ""),
    );
  }
  return value;
}
function notice(value) {
  // The toast sits below the modal editor, so repeat it in the editor footer.
  if ($("#editor").open && !$("#edit-form footer").hidden) {
    $("#edit-status").textContent = value;
    $("#edit-status").classList.add("alert");
  }
  $("#notice").textContent = value;
  $("#notice").hidden = false;
  clearTimeout(notice.timer);
  notice.timer = setTimeout(() => ($("#notice").hidden = true), 5000);
}
async function load() {
  const c = await api("/api/config");
  config = c.config;
  configMigrationWarnings = c.migrationWarnings || [];
  revision = c.revision;
  tools = c.tools;
  features = c.features || {};
  status = await api("/api/status");
  $("#login").hidden = true;
  $("#content").hidden = false;
  document.body.classList.remove("locked");
  render();
}
async function action(fn) {
  try {
    await fn();
  } catch (e) {
    notice(e.message);
  }
}
$("#login-button").onclick = () =>
  action(async () => {
    token = $("#token").value.trim();
    await load();
    sessionStorage.setItem("qq-unified-token", token);
    $("#token").value = "";
  });
$("#token").onkeydown = (e) => {
  if (e.key === "Enter") $("#login-button").click();
};
$("#logout").onclick = () => {
  sessionStorage.removeItem("qq-unified-token");
  location.reload();
};
$("#pause-all").onclick = () =>
  action(() => setGlobalPaused(!status?.globalPaused));
function renderGlobalPauseControl() {
  const button = $("#pause-all"),
    paused = status?.globalPaused === true;
  button.innerHTML =
    icon(paused ? "play" : "pause", "sm") + (paused ? "全局恢复" : "全部暂停");
  button.className = paused ? "" : "danger";
  const off = disabledReason([
    [!status, "statusLoading"],
    [globalPausePending, "submitting"],
    [paused && status?.mode === "isolated", "isolatedResume"],
  ]);
  button.disabled = !!off;
  button.title =
    off ||
    (paused
      ? "恢复全局参与；单独暂停的角色和会话保持暂停，断开的连接需要另行恢复。"
      : "暂停所有角色参与，保留 QQ 连接。");
  let hint = $("#pause-all-hint");
  if (!hint) {
    hint = document.createElement("span");
    hint.id = "pause-all-hint";
    hint.className = "hint";
    button.after(hint);
  }
  // Only a lasting reason earns header space; the brief submitting state does not.
  hint.textContent = off && !globalPausePending && status ? off : "";
  hint.hidden = !hint.textContent;
}
async function setGlobalPaused(paused) {
  if (globalPausePending || !status || (!paused && status.mode === "isolated"))
    return;
  const active = status.agents.reduce((n, a) => n + a.activeTurns, 0);
  if (
    paused &&
    !confirm(
      `全部暂停后，所有角色立即停止参与${active ? `，进行中的 ${active} 个回合会被结束，未发出的回复不再发送` : ""}；QQ 连接保留。恢复全局参与后，单独暂停的角色和会话仍保持暂停。确定全部暂停？`,
    )
  )
    return;
  globalPausePending = true;
  renderGlobalPauseControl();
  try {
    await api("/api/pause", { paused });
    await load();
    notice(
      paused
        ? "全部角色已暂停"
        : "已恢复全局参与；单独暂停的角色和会话仍保持暂停，断开的连接需另行恢复",
    );
  } finally {
    globalPausePending = false;
    renderGlobalPauseControl();
  }
}
document.querySelectorAll("nav button").forEach(
  (b) =>
    (b.onclick = () => {
      const section = b.dataset.section;
      tab = lastPage[section] || sections[section].pages[0];
      render();
    }),
);
$("#close-editor").onclick = () => $("#editor").close();
$("#edit-form").addEventListener("input", (e) => {
  e.target.classList?.remove("invalid");
  e.target.removeAttribute?.("aria-invalid");
});
$("#editor").addEventListener("close", () => {
  $("#edit-status").textContent = $("#edit-status").dataset.default;
  $("#edit-status").classList.remove("alert");
});
const tag = (text, cls = "") => `<span class="pill ${cls}">${esc(text)}</span>`;
const icon = (name, cls = "") =>
  `<svg class="i ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const meter = (ratio) =>
  `<svg class="meter" viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true"><rect class="track" width="100" height="4" rx="2"/><rect class="bar" width="${Math.max(0, Math.min(100, ratio * 100))}" height="4" rx="2"/></svg>`;
const find = (type, id) => config[type].find((x) => x.id === id);
function recentErrorsMarkup(query = "") {
  const rows = (status.recentErrors || []).filter((r) =>
    [r.code, r.component, r.requestId].some((v) =>
      String(v).toLowerCase().includes(query.trim().toLowerCase()),
    ),
  );
  return (
    rows
      .map(
        (r) =>
          `<div class="record"><strong>${esc(r.code)}</strong> ${tag(r.component)}<p>${esc(r.at)} · 累计 ${esc(r.count)} 次${r.cause ? " · 原因：" + esc(r.cause) : ""}</p><p class="mono">关联 ID：${esc(r.requestId)}</p></div>`,
      )
      .join("") || "<p>暂无匹配的错误记录。</p>"
  );
}
// Home: per-role 24-hour summary, fetched at most every 30 s because the
// overview re-renders on each status refresh.
let homeData = null,
  homeFetchedAt = 0,
  errorsOpen = false;
function loadHome() {
  if (Date.now() - homeFetchedAt < 30000) return;
  homeFetchedAt = Date.now();
  api("/api/home")
    .then((data) => {
      homeData = data;
      const box = $("#home-roles");
      if (tab === "overview" && box) box.innerHTML = homeRolesMarkup();
    })
    .catch(() => (homeFetchedAt = 0));
}
const clipText = (s, n) => (!s ? "" : s.length > n ? s.slice(0, n) + "…" : s);
// Last character tells roles apart when names share a prefix (大肥鱼 / 大肥龙).
const avatarChar = (name) => [...String(name).trim()].pop() || "?";
const homeTime = (t) =>
  new Date(t).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
const homeDid = {
  browsed: "浏览",
  searched: "搜索",
  read: "阅读",
  wrote: "写作",
  reviewed: "回顾",
  rested: "休息",
};
function homeRoleCard(a) {
  const s = status.agents.find((x) => x.id === a.id),
    h = homeData?.agents?.find((x) => x.agentId === a.id),
    c = status.connections.find((x) => x.id === a.connectionId),
    b = status.backends?.find((x) => x.id === a.backendId),
    can = s && !s.blockers?.length;
  const latest = h?.latest
    ? `<p><span class="hint">${homeTime(h.latest.startedAt)} · ${h.latest.kind === "subject" ? "空闲时间" + (h.latest.did ? " · " + esc(homeDid[h.latest.did] || h.latest.did) : "") : esc(h.latest.conversation.replace(/^group:/, "群 ").replace(/^private:/, "私聊 "))}</span><br><span title="${esc(h.latest.text || "")}">${esc(clipText(h.latest.text, 110) || "（这一回合没有留下文字）")}</span></p>`
    : `<p class="hint">${homeData ? "还没有动态。" : "读取中…"}</p>`;
  const d = h?.last24h;
  const stats = d
    ? `<div class="home-stats"><span><b>${d.sent}</b>回复</span><span><b>${d.freeTimeTraced ? `${d.freeTimeActive}/${d.freeTimeTraced}` : d.freeTime}</b>${d.freeTimeTraced ? "空闲时有行动" : "空闲时间"}</span><span><b>${d.reads}</b>读文章</span><span><b>${d.diaries}</b>日记</span></div>`
    : "";
  return `<article class="card home-role"><div class="row"><div class="identity"><span class="avatar">${esc(avatarChar(a.name))}</span><div><h3>${esc(a.name)}</h3><span class="hint">QQ ${c?.connected ? "已连接" : "未连接"} · ${esc(backendLabels[b?.state] || "后端尚未检测")}</span></div></div>${tag(can ? "可以发言" : a.paused ? "已暂停" : "暂不发言", can ? "live" : a.paused ? "off" : "warn")}</div>${can ? "" : blockersMarkup(s)}${latest}${stats}${d ? `<p class="hint">最近 24 小时${h.nextFreeTimeAt && a.subject?.enabled ? ` · 下次空闲时间 ${homeTime(h.nextFreeTimeAt)}` : ""}</p>` : ""}<div class="card-actions"><button data-do="role" data-id="${esc(a.id)}">${icon("pulse", "sm")}查看动态</button><button class="ghost" data-do="role-settings" data-id="${esc(a.id)}">${icon("settings", "sm")}设置</button></div></article>`;
}
const homeRolesMarkup = () =>
  config.agents.map(homeRoleCard).join("") ||
  '<div class="card empty">还没有角色。到“角色”中添加第一个。</div>';
// Four sections; existing pages keep their keys and become sub-pages. Role
// pages all follow one selected role instead of each keeping its own picker.
const sections = {
  home: { pages: ["overview"] },
  role: {
    pages: [
      "activity",
      "agents",
      "mind",
      "memory",
      "schedule",
      "apps",
      "permissions",
      "voices",
    ],
  },
  links: { pages: ["links"] },
  system: { pages: ["operations", "settings"] },
};
const pageLabels = {
  activity: "动态",
  agents: "设置",
  mind: "Self 与主体",
  memory: "记忆与日记",
  schedule: "作息与定时",
  apps: "浏览与分享",
  permissions: "文件",
  voices: "语音",
  operations: "运维",
  settings: "运行设置",
};
const lastPage = {};
let roleId;
const sectionOf = (page) =>
  Object.keys(sections).find((s) => sections[s].pages.includes(page)) || "home";
function syncRole() {
  if (!config.agents.some((a) => a.id === roleId))
    roleId = config.agents[0]?.id;
  // Page modules keep their own selection variables (declared, initially
  // undefined, in their scripts); point them at the role. A module that is
  // not loaded (as in unit tests) simply has nothing to sync.
  for (const assign of [
    () => (activityAgentId = roleId),
    () => (appAgentId = roleId),
    () => (mindAgentId = roleId),
    () => (parityAgentId = roleId),
    () => (fileAgentId = roleId),
  ])
    try {
      assign();
    } catch {
      /* module not loaded */
    }
}
function renderSectionBar(section) {
  const bar = $("#section-bar");
  document.body.classList.toggle("in-role", section === "role");
  if (!bar) return;
  if (!["role", "system"].includes(section)) {
    bar.hidden = true;
    bar.innerHTML = "";
    return;
  }
  const role = section === "role" && find("agents", roleId);
  const picker =
    section === "role"
      ? `<div class="role-pick">${config.agents.map((a) => `<button type="button" data-role="${esc(a.id)}" class="${a.id === roleId ? "primary" : "ghost"}">${esc(a.name)}</button>`).join("")}<button type="button" class="ghost" data-role-add>${icon("plus", "sm")}添加角色</button></div>${role ? blockersMarkup(status.agents.find((s) => s.id === role.id)) : '<p class="hint">还没有角色。</p>'}`
      : "";
  bar.innerHTML = `${picker}<div class="sub-tabs" role="tablist">${sections[section].pages.map((p) => `<button type="button" role="tab" data-page="${p}" aria-selected="${p === tab}" class="${p === tab ? "active" : ""}">${pageLabels[p]}</button>`).join("")}</div>`;
  bar.hidden = false;
  bar.querySelectorAll?.("[data-role]").forEach(
    (b) =>
      (b.onclick = () => {
        roleId = b.dataset.role;
        render();
      }),
  );
  bar.querySelectorAll?.("[data-page]").forEach(
    (b) =>
      (b.onclick = () => {
        tab = b.dataset.page;
        render();
      }),
  );
  const add = bar.querySelector?.("[data-role-add]");
  if (add) add.onclick = () => action(() => operate("add", "agents"));
}
function render() {
  renderGlobalPauseControl();
  // Older links name the pages that were merged into one.
  if (["connections", "backends"].includes(tab)) tab = "links";
  const section = sectionOf(tab);
  lastPage[section] = tab;
  if (section === "role" && config) syncRole();
  const role = section === "role" && config && find("agents", roleId);
  const [pageTitle, subtitle] = titles[tab];
  const title = role ? `${role.name} · ${pageLabels[tab]}` : pageTitle;
  $("#title").textContent = title;
  $("#crumb").textContent = title;
  $("#subtitle").textContent = subtitle;
  document.title = `${title} · QQ Agents`;
  document
    .querySelectorAll("nav button")
    .forEach((b) =>
      b.classList.toggle("active", b.dataset.section === section),
    );
  $("#mode").textContent =
    status.mode === "isolated"
      ? "隔离模式"
      : status.globalPaused
        ? "全局暂停"
        : "运行模式";
  const tone =
    status.mode === "isolated" ? "warn" : status.globalPaused ? "off" : "live";
  $("#mode").className = "pill " + tone;
  $("#runtime-dot").className = "dot " + (tone === "off" ? "idle" : tone);
  $("#runtime-text").textContent = $("#mode").textContent;
  const content = $("#content");
  if (!config) return;
  renderSectionBar(section);
  if (tab === "mind") {
    renderMind();
    return;
  }
  if (tab === "overview") {
    const waiting = status.agents.reduce(
        (n, a) => n + (a.unresolvedDeliveries || 0),
        0,
      ),
      grants = status.disclosureRequests.length,
      errors = (status.recentErrors || []).length;
    content.innerHTML = `<div class="banner ${status.mode === "isolated" ? "warn" : status.globalPaused ? "" : "ok"}">${icon(status.mode === "isolated" ? "shield" : "pulse")}<span>${status.mode === "isolated" ? "隔离模式：不连接 QQ，也不运行模型。" : status.globalPaused ? "全局暂停中：连接照常记录消息，角色不参与。" : "运行中：各角色按自己的设置参与。"}</span></div><div class="section-title"><h2>角色</h2></div><div class="grid" id="home-roles">${homeRolesMarkup()}</div><div class="section-title"><h2>需要处理</h2>${grants + waiting ? "" : tag("暂无", "live")}</div>${grants ? `<div class="card"><h3>受限动作授权 · ${grants}</h3>${status.disclosureRequests.map((r, i) => `<div class="record"><strong>${esc(find("agents", r.agentId)?.name)} → ${esc(r.conversation)}</strong><p>${r.records.length} 条资料涉及${r.reason === "external-service" ? "外部服务调用" : "本地运维内容"}。${r.request ? "批准仅对当前回合、所示请求参数及资料集合有效。" : "批准仅对当前回合、当前会话所示资料集合有效。"}</p><p class="mono">${esc(r.records.join("\n"))}</p>${r.request ? `<pre>${esc(JSON.stringify(r.request, null, 2))}</pre><p>${esc(JSON.stringify(r.sourceClasses))}</p>` : ""}<button data-do="grant" data-id="${i}">批准本次披露</button></div>`).join("")}</div>` : ""}${waiting ? `<div class="card"><h3>待核对发送 · ${waiting}</h3><p class="hint">网络结果未知的发送不会自动重发。请在 QQ 中查看对应会话后标记结果。</p><div id="unresolved-deliveries">读取中…</div></div>` : ""}${grants + waiting ? "" : '<p class="hint">没有待批准的动作或待核对的发送。</p>'}`;
    renderOnboarding(content);
    if (waiting) action(renderUnresolved);
    content.insertAdjacentHTML(
      "beforeend",
      `<details class="card home-errors" ${errorsOpen || errorFilter ? "open" : ""}><summary>最近错误 · ${errors} 类</summary><label>筛选错误码、组件或关联 ID<input id="error-filter" value="${esc(errorFilter)}" placeholder="例如 CONFIG_SAVE_FAILED、http"></label><p class="hint">最多保留本次启动的 50 类错误，同类重复错误合并计数；完整留存取决于服务日志配置。</p><div id="recent-errors">${recentErrorsMarkup(errorFilter)}</div></details>`,
    );
    const details = content.querySelector?.(".home-errors");
    if (details) details.ontoggle = () => (errorsOpen = details.open);
    loadHome();
    if (configMigrationWarnings.length)
      content.insertAdjacentHTML(
        "afterbegin",
        '<div class="card"><p>已兼容旧静默设置：角色起止相同的时段明确标记为整日（从开始时刻到次日同一时刻）；定时任务起止相同继续保持不静默。可在角色及作息设置中核对，后续保存会写入明确选项。</p></div>',
      );
    $("#error-filter").oninput = (e) => {
      errorFilter = e.target.value;
      $("#recent-errors").innerHTML = recentErrorsMarkup(errorFilter);
    };
  } else if (tab === "agents") {
    const role = find("agents", roleId);
    content.innerHTML = role
      ? `<div class="grid">${agentCard(role)}</div><p class="hint">性格与相处方式在「Self 与主体」中发展；浏览、文件和作息有各自的标签页。</p>`
      : '<div class="card empty">还没有角色。点上方的“添加角色”开始。</div>';
  } else if (tab === "links") {
    const group = (type, label, card) =>
      `<div class="section-title"><h2>${label} · ${config[type].length}</h2><button class="primary" data-do="add" data-id="${type}">${icon("plus", "sm")}添加 ${label}</button></div><div class="grid">${config[type].map(card).join("") || '<div class="card empty">添加第一个配置开始。</div>'}</div>`;
    content.innerHTML =
      group("connections", "QQ 账号", connectionCard) +
      group("backends", "AI 后端", backendCard);
  } else if (tab === "activity") {
    renderActivity();
  } else if (tab === "apps") {
    renderApps();
  } else if (tab === "permissions") {
    renderFilePermissions();
  } else if (["schedule", "voices", "operations"].includes(tab)) {
    renderParity(tab);
  } else if (tab === "memory") {
    content.innerHTML = `<div class="card"><div class="toolbar"><label>角色<select id="memory-agent">${config.agents.map((a) => `<option value="${esc(a.id)}" ${a.id === roleId ? "selected" : ""}>${esc(a.name)}</option>`).join("")}</select></label><label>关键词<input id="memory-query" placeholder="约定、上次、某件事…"></label><label>记录类型<select id="memory-type"><option value="all">全部</option><option value="event">经历档案</option><option value="diary">个人日记</option></select></label><button class="primary" id="search-memory">搜索</button><button id="export-memory">导出</button></div><div class="form-grid"><label>人物 QQ<input id="memory-person" placeholder="按 QQ 身份检索"></label><label>来源<select id="memory-source"><option value="">全部来源</option></select></label><label id="memory-source-manual-field" hidden>手动来源<input id="memory-source-manual" placeholder="group:10000 或 private:10000"></label></div><p class="hint" id="memory-source-state"></p><div class="card-actions"><button id="reset-session">重置此来源模型上下文</button><button id="pause-conversation">暂停此来源</button><button id="resume-conversation">解除此来源暂停 / 静默</button></div><p class="hint">原始消息是“某人说过的话”，不自动等同于已核实事实。旧笔记标注 legacy 来源。</p><div id="memory-results" class="empty">搜索此角色自己的经历和日记。</div></div><div class="section-title"><h2>会话状态</h2></div><div class="card"><p class="hint">按会话单独暂停只影响此角色在该来源的参与；角色暂停和全局暂停仍独立生效。</p><div id="memory-conversations">读取中…</div></div>`;
    $("#memory-agent").onchange = () => action(loadConversations);
    $("#memory-source").onchange = () => {
      $("#memory-source-manual-field").hidden =
        $("#memory-source").value !== "manual";
      renderSourceState();
    };
    $("#memory-source-manual").oninput = renderSourceState;
    $("#reset-session").onclick = () =>
      action(() => conversationAction("reset", requireSource()));
    $("#pause-conversation").onclick = () =>
      action(() => conversationAction("pause", requireSource()));
    $("#resume-conversation").onclick = () =>
      action(() => conversationAction("resume", requireSource()));
    action(loadConversations);
    $("#search-memory").onclick = () => searchMemory();
    $("#export-memory").onclick = () =>
      action(async () => {
        const { ticket } = await api("/api/export/ticket", {
          agentId: $("#memory-agent").value,
        });
        const form = document.createElement("form");
        form.method = "POST";
        form.action = "/api/export/download";
        form.target = "_blank";
        form.rel = "noopener";
        const input = document.createElement("input");
        input.type = "hidden";
        input.name = "ticket";
        input.value = ticket;
        form.append(input);
        document.body.append(form);
        form.submit();
        form.remove();
        notice(
          "已请求导出；完成状态请查看浏览器下载列表，失败信息会在新窗口显示。",
        );
      });
  } else {
    content.innerHTML = `<div class="card"><h2>参与控制</h2><p>启动时总是全局暂停。解除全局暂停不会自动解除角色暂停，也不会连接 QQ。</p><p>当前：${status.globalPaused ? "全局暂停中" : "全局允许参与"}。全局暂停与恢复统一使用页面右上角的「${status.globalPaused ? "全局恢复" : "全部暂停"}」按钮。</p>${disabledHints(disabledReason([[status.globalPaused && status.mode === "isolated", "isolatedResume"]]))}</div><div class="card section-title"><div><h2>完整配置</h2><p>支持配置任意数量的角色、QQ 账号与后端。配置中的凭据仅填写环境变量名。</p></div><button data-do="advanced">打开配置编辑器</button></div><div class="card"><h2>迁移与备份</h2><p>先运行迁移预检，再导入到新数据目录。旧文件、原登录目录和 Docker 数据都保留。</p><p class="mono">npm run migrate -- --source /path/to/old-instance --agent agent-a --data /path/to/new-data</p><p class="hint">默认只生成统计预检。实际导入需 --apply；目标目录有运行锁时会拒绝。迁移不会修改旧实例，也不会启动 QQ。</p><button data-do="download-config">导出配置</button></div>`;
  }
  content
    .querySelectorAll("[data-do]")
    .forEach(
      (b) =>
        (b.onclick = () => action(() => operate(b.dataset.do, b.dataset.id))),
    );
}
const blockerLabels = {
  RUNTIME_CLOSING: "管理器正在关闭",
  RECONFIGURING: "配置正在生效",
  BACKEND_UNAVAILABLE: "AI 后端不可用",
  ISOLATED_MODE: "隔离模式",
  GLOBAL_PAUSED: "全局暂停",
  AGENT_PAUSED: "角色暂停",
  QUIET_HOURS: "静默时段",
  CONNECTION_DISABLED: "QQ 连接已停用",
  QQ_NOT_CONNECTED: "QQ 未连接",
};
const blockersMarkup = (s) =>
  s?.blockers?.length
    ? `<p class="hint">当前无法发言：${s.blockers.map((b) => esc(blockerLabels[b] || b)).join("、")}</p>`
    : s
      ? '<p class="hint">各道开关已就绪；具体会话仍受白名单、会话暂停与静默约束。</p>'
      : "";
let unresolved = [];
async function renderUnresolved() {
  const box = $("#unresolved-deliveries");
  if (!box) return;
  const agents = status.agents.filter((s) => s.unresolvedDeliveries > 0);
  if (!agents.length) {
    unresolved = [];
    box.innerHTML = "<p>没有结果未知的发送。</p>";
    return;
  }
  const pages = await Promise.all(
    agents.map((s) =>
      api("/api/deliveries?agentId=" + encodeURIComponent(s.id)).then(
        (page) => ({ agentId: s.id, ...page }),
      ),
    ),
  );
  if (!$("#unresolved-deliveries")) return;
  unresolved = pages.flatMap((page) =>
    page.items.map((item) => ({ ...item, agentId: page.agentId })),
  );
  box.innerHTML =
    unresolved
      .map(
        (d, i) =>
          `<div class="record"><strong>${esc(find("agents", d.agentId)?.name || d.agentId)} → ${esc(d.conversation)}</strong><p>${esc(d.preview || (d.mediaId ? "[媒体]" : "[无文字内容]"))}</p><p class="hint mono">${esc(d.requestId)} · ${esc(new Date(d.createdAt).toLocaleString())}</p><button data-reconcile="sent" data-index="${i}">已在 QQ 中看到</button><button class="ghost" data-reconcile="failed" data-index="${i}">确认未发出</button></div>`,
      )
      .join("") +
    pages
      .filter((page) => page.total > page.items.length)
      .map(
        (page) =>
          `<p class="hint">${esc(find("agents", page.agentId)?.name || page.agentId)} 另有 ${page.total - page.items.length} 条，处理后刷新查看。</p>`,
      )
      .join("");
  box.querySelectorAll("[data-reconcile]").forEach(
    (b) =>
      (b.onclick = () =>
        action(async () => {
          const d = unresolved[Number(b.dataset.index)],
            sent = b.dataset.reconcile === "sent";
          if (
            !confirm(
              sent
                ? "确认这条消息已出现在 QQ 中？标记后不会重发。"
                : "确认这条消息没有发出？标记后同一请求仍不会自动重发，角色可在之后的回合重新决定是否发送。",
            )
          )
            return;
          await api("/api/deliveries/reconcile", {
            agentId: d.agentId,
            requestId: d.requestId,
            resolution: b.dataset.reconcile,
          });
          await load();
        })),
  );
}
// Why a control is unavailable. The same sentence becomes the button title and
// the visible hint, so every disabled button explains itself in one wording.
const disabledReasons = {
  statusLoading: "尚未读取运行状态，请稍候",
  submitting: "正在提交，请稍候",
  isolatedResume: "隔离模式下不能解除全局暂停；{live}",
  isolatedAgent: "隔离模式下角色不会参与，无需暂停；{live}",
  isolatedConnection: "隔离模式下不能连接 QQ 或启停进程；{live}",
  isolatedBackend: "隔离模式下不连接 AI 后端；{live}",
  connectionDisabled: "连接未启用，请先在编辑中勾选启用",
  backendBusy: "正在处理上一项后端操作，请稍候",
  backendRecovering: "后端正在自动恢复，完成后可再次操作",
  notAllowed: "该来源已不在角色白名单中，不能重置上下文；可在角色配置中加回",
  opsBlocked: "隔离模式或全局暂停时不执行运维操作",
};
/** @param {[unknown, keyof typeof disabledReasons][]} checks */
// Started with --live, the remaining step is the mode switch on the overview.
const liveStep = () =>
  status?.allowLive
    ? "请先在概览的上线清单中切换到运行模式"
    : "需以 --live 重新启动服务，再切换到运行模式";
const disabledReason = (checks) =>
  (disabledReasons[checks.find(([on]) => on)?.[1]] || "").replace(
    "{live}",
    liveStep(),
  );
const disabledAttr = (reason) =>
  reason ? `disabled title="${esc(reason)}"` : "";
const disabledHints = (...reasons) =>
  [...new Set(reasons.filter(Boolean))]
    .map((r) => `<p class="hint">${esc(r)}</p>`)
    .join("");
function agentCard(a) {
  const s = status.agents.find((s) => s.id === a.id),
    c = find("connections", a.connectionId),
    b = find("backends", a.backendId);
  const toggleOff = disabledReason([
    [status.mode === "isolated" && !a.paused, "isolatedAgent"],
  ]);
  return `<article class="card"><div class="row"><div class="identity"><span class="avatar">${esc(avatarChar(a.name))}</span><div><h3>${esc(a.name)}</h3><span class="hint mono">${esc(a.id)}</span></div></div>${tag(a.paused ? "已暂停" : status.globalPaused ? "全局暂停" : "允许参与", a.paused ? "off" : status.globalPaused ? "warn" : "live")}</div><dl class="agent-meta"><dt>QQ 账号</dt><dd>${esc(c?.label)}</dd><dt>后端 / 模型</dt><dd>${esc(b?.label)} / <span class="mono">${esc(a.model || b?.model || "后端默认")}</span></dd><dt>后端连接</dt><dd>${esc(backendLabels[status.backends?.find((x) => x.id === a.backendId)?.state] || "尚未检测")}</dd><dt>参与率</dt><dd>${Math.round(a.wake.participation * 100)}%${meter(a.wake.participation)}</dd><dt>来源范围</dt><dd>${a.allow.groups.length} 个群 · ${a.allow.users.length} 位私聊对象</dd></dl>${blockersMarkup(s)}${s?.error ? `<p class="hint">${esc(s.error)}</p>` : ""}<div class="card-actions"><button data-do="role" data-id="${esc(a.id)}">${icon("pulse", "sm")}查看动态</button><button data-do="edit-agent" data-id="${esc(a.id)}">${icon("settings", "sm")}配置角色</button><button class="ghost" data-do="toggle" data-id="${esc(a.id)}" ${disabledAttr(toggleOff)}>${icon(a.paused ? "play" : "pause", "sm")}${a.paused ? "解除角色暂停" : "暂停角色"}</button></div>${disabledHints(toggleOff)}</article>`;
}
const recoveryText = (r) => {
  if (!r) return "";
  const at = (t) => new Date(t).toLocaleTimeString();
  const gap = r.lastGap
    ? `上次断线 ${at(r.lastGap.lostAt)}—${at(r.lastGap.recoveredAt)}，期间的消息未补录。`
    : "";
  if (r.state === "retrying")
    return `连接中断，自动重连等待中：已尝试 ${r.attempts}/${r.maxAttempts} 次，下次约 ${at(r.nextRetryAt)}。`;
  if (r.state === "reconnecting")
    return `连接中断，正在进行第 ${r.attempts}/${r.maxAttempts} 次自动重连。`;
  if (r.state === "exhausted")
    return `自动重连已停止（${r.error === "QQ_ACCOUNT_MISMATCH" ? "登录账号不匹配" : "多次失败"}），请检查实例后手动连接。`;
  if (r.state === "stopped") return "自动重连已关闭或连接已停用，请手动连接。";
  return (
    (r.enabled
      ? "断线后自动重连已开启，仅限本次手动连接后的中断。"
      : "断线后需手动重连。") + gap
  );
};
function connectionCard(c) {
  const s = status.connections.find((s) => s.id === c.id);
  const off = disabledReason([
    [status.mode === "isolated", "isolatedConnection"],
    [!c.enabled, "connectionDisabled"],
  ]);
  return `<article class="card"><div class="row"><div class="identity"><span class="avatar">${icon("link")}</span><div><h3>${esc(c.label)}</h3><span class="hint mono">${esc(c.id)}</span></div></div>${tag(s?.connected ? "已连接" : "未连接", s?.connected ? "live" : "off")}</div><dl class="agent-meta"><dt>QQ 账号</dt><dd class="mono">${esc(c.accountId)}</dd><dt>HTTP</dt><dd class="mono">${esc(c.httpUrl)}</dd><dt>WebSocket</dt><dd class="mono">${esc(c.wsUrl)}</dd><dt>部署方式</dt><dd>${esc(c.deployment)}</dd></dl><p class="hint">${esc(s?.error || "连接前核对实际登录账号，不匹配时拒绝接入。")}</p><p class="hint">${esc(recoveryText(s?.recovery))}</p><div class="card-actions"><button data-do="edit-connection" data-id="${esc(c.id)}">${icon("settings", "sm")}编辑</button><button class="ghost" data-do="connect" data-id="${esc(c.id)}" ${disabledAttr(off)}>${s?.connected ? "断开 QQ" : "连接 QQ"}</button>${c.deployment !== "external" ? `<button class="ghost" data-do="process" data-id="${esc(c.id)}" ${disabledAttr(off)}>${s?.process?.managed ? "停止 QQ 进程" : "启动 QQ 进程"}</button>` : ""}</div>${disabledHints(off)}</article>`;
}
const backendBusy = new Set();
const backendLabels = {
  unchecked: "尚未检测",
  ready: "已就绪",
  disconnected: "连接已断开",
  recovering: "恢复中",
  "login-required": "需要登录",
  "selection-required": "请选择 DSH 实例",
};
const backendErrors = {
  DSH_NOT_FOUND: "未找到 DSH，请先打开桌面应用，再恢复连接。",
  DSH_INSTANCE_UNAVAILABLE:
    "绑定的 DSH 实例尚未就绪。请等待启动完成，或选择其他实例。",
  DSH_SELECTION_REQUIRED:
    "发现的实例与原连接无法唯一对应，请选择要连接的 DSH。",
  CODEX_DEDICATED_LOGIN_REQUIRED:
    "Codex 专用实例需要登录。登录完成后再恢复连接。",
  BACKEND_MODEL_UNAVAILABLE:
    "后端可访问，但所选模型当前不可用，请检查模型配置。",
  BACKEND_NO_AGENTS: "请先将此后端绑定到一个角色。",
  OPENAI_API_KEY_ENV_MISSING:
    "未找到 API 密钥环境变量。请在启动环境或 secrets.json 中设置后再恢复连接。",
  OPENAI_AUTH_FAILED: "API 密钥被拒绝，请检查密钥和服务地址。",
  OPENAI_UNREACHABLE: "无法访问 API 服务地址，请检查网络和 baseUrl。",
};
const backendKinds = {
  dsh: "选择桌面实例后可跟随重启后的地址。",
  codex: "使用角色自己的 Codex 进程与登录目录。",
  openai:
    "直接调用 OpenAI 兼容 API；会话保存在本机数据目录。不支持原生生图和上下文压缩。",
};
function backendCard(b) {
  const s = status.backends?.find((x) => x.id === b.id) || {
    state: "unchecked",
  };
  const busy = backendBusy.has(b.id) || s.state === "recovering";
  const off = disabledReason([
    [status.mode === "isolated", "isolatedBackend"],
    [backendBusy.has(b.id), "backendBusy"],
    [s.state === "recovering", "backendRecovering"],
  ]);
  const disabled = disabledAttr(off);
  const checked = s.checkedAt
    ? new Date(s.checkedAt).toLocaleTimeString()
    : "尚未检测";
  return `<article class="card"><div class="row"><div class="identity"><span class="avatar">${icon("chip")}</span><div><h3>${esc(b.label)}</h3><span class="hint mono">${esc(b.id)} · ${esc(b.type.toUpperCase())}</span></div></div>${tag(busy ? "处理中" : backendLabels[s.state] || s.state, s.state === "ready" ? "live" : "warn")}</div>
    <dl class="agent-meta"><dt>提供方</dt><dd>${esc(b.provider || "后端默认")}</dd><dt>模型</dt><dd>${esc(b.model || "后端默认")}</dd><dt>思考强度</dt><dd>${esc(b.effort)}</dd><dt>外部工具</dt><dd>${b.toolServers.length} 个 MCP 服务</dd><dt>最近检测</dt><dd>${esc(checked)}</dd><dt>自动恢复</dt><dd>${s.autoReconnect ? "已开启" : "已关闭"}${s.attempts ? ` · 已尝试 ${s.attempts}/3 次` : ""}</dd>${b.type === "openai" ? `<dt>服务地址</dt><dd>${esc(b.baseUrl || "")}</dd><dt>密钥变量</dt><dd>${esc(b.apiKeyEnv || "无（本机服务）")}</dd>` : ""}${b.type === "dsh" ? `<dt>绑定实例</dt><dd>${esc(s.dshInstance?.replace(/^relay:/, "桌面 DSH · ") || b.baseUrl || "尚未选择")}</dd>` : ""}</dl>
    <p class="hint">${esc(s.error ? backendErrors[s.error] || "连接检查未通过：" + s.error : backendKinds[b.type] || "")}</p>
    ${s.attempts >= 3 ? '<p class="hint">自动恢复已停止，请检查原因后手动恢复。</p>' : ""}
    ${(s.agents || []).map((a) => `<p class="hint">${esc(find("agents", a.id)?.name || a.id)}：${esc(backendLabels[a.state] || a.state)}${a.endpoint ? " · " + esc(a.endpoint === "stdio" ? "专用 Codex 进程" : a.endpoint) : ""}</p>`).join("")}
    <div class="card-actions"><button data-do="backend-check" data-id="${esc(b.id)}" ${disabled}>检测连接</button><button data-do="backend-recover" data-id="${esc(b.id)}" ${disabled}>恢复连接</button>${b.type === "dsh" ? `<button data-do="backend-discover" data-id="${esc(b.id)}" ${disabled}>选择 DSH 实例</button>` : ""}<button data-do="backend-auto" data-id="${esc(b.id)}" ${disabled}>${s.autoReconnect ? "关闭" : "开启"}自动恢复</button><button class="ghost" data-do="edit-backend" data-id="${esc(b.id)}" ${disabled}>编辑后端</button><button class="ghost" data-do="models" data-id="${esc(b.id)}" ${disabled}>读取模型目录</button></div>${disabledHints(off)}</article>`;
}
async function backendDiscover(id) {
  const { candidates } = await api("/api/backend", { id, action: "discover" });
  editing = { type: "read" };
  $("#edit-title").textContent = "选择 DSH 实例";
  $("#edit-fields").innerHTML = candidates.length
    ? candidates
        .map(
          (c) =>
            `<div class="record"><strong>${esc(c.label)}</strong><p class="mono">${esc(c.url)} · PID ${esc(c.pid || "未知")}</p>${c.home ? `<p class="hint">${esc(c.home)}</p>` : ""}<p>${c.followsRestart ? "可跟随此桌面实例重启" : "固定地址；重启后可能需要重新选择"}</p><button type="button" data-backend-candidate="${esc(c.id)}">连接此实例</button></div>`,
        )
        .join("")
    : "<p>没有发现可连接的 DSH。请先打开桌面应用，再重新检测。</p>";
  $("#edit-form footer").hidden = true;
  $("#edit-fields")
    .querySelectorAll("[data-backend-candidate]")
    .forEach((button) => {
      button.onclick = () =>
        action(async () => {
          $("#editor").close();
          await backendAction(id, "recover", {
            candidateId: button.dataset.backendCandidate,
          });
        });
    });
  $("#editor").showModal();
}
async function backendAction(id, operation, extra = {}) {
  if (backendBusy.has(id)) return;
  backendBusy.add(id);
  render();
  try {
    const result = await api("/api/backend", {
      id,
      action: operation,
      ...extra,
    });
    await load();
    if (result.state === "selection-required") await backendDiscover(id);
    notice(
      result.error
        ? backendErrors[result.error] || "连接未恢复：" + result.error
        : operation === "settings"
          ? "自动恢复设置已保存"
          : operation === "recover"
            ? "后端连接已恢复；可用会话与 QQ 连接保留"
            : "后端连接检测通过",
    );
  } finally {
    backendBusy.delete(id);
    render();
  }
}
async function operate(kind, id) {
  if (kind.startsWith("backend-")) {
    const operation = kind.slice(8);
    if (operation === "discover") return backendDiscover(id);
    if (operation === "auto")
      return backendAction(id, "settings", {
        autoReconnect: !status.backends?.find((x) => x.id === id)
          ?.autoReconnect,
      });
    return backendAction(id, operation);
  }
  if (kind === "tab") {
    tab = id;
    render();
    return;
  }
  if (kind === "role") {
    roleId = id;
    tab = "activity";
    render();
    return;
  }
  if (kind === "role-settings") {
    roleId = id;
    tab = "agents";
    render();
    return;
  }
  if (kind === "add" || kind.startsWith("edit-")) {
    const type =
      kind === "add"
        ? id
        : {
            "edit-agent": "agents",
            "edit-connection": "connections",
            "edit-backend": "backends",
          }[kind];
    openEditor(type, kind === "add" ? null : id);
    return;
  }
  if (kind === "toggle") {
    const a = find("agents", id),
      active = status.agents.find((s) => s.id === id)?.activeTurns || 0;
    if (
      !a.paused &&
      active &&
      !confirm(
        `「${a.name}」有 ${active} 个进行中的回合。暂停角色会立即结束这些回合，未发出的回复不再发送。确定暂停？`,
      )
    )
      return;
    await api("/api/pause", { agentId: id, paused: !a.paused });
    await load();
    return;
  }
  if (kind === "process") {
    const managed = status.connections.find((s) => s.id === id)?.process
      ?.managed;
    if (
      managed &&
      !confirm(
        `停止 QQ 进程会先断开「${find("connections", id)?.label || id}」的连接，并让这个 QQ 账号下线；绑定它的角色都无法收发消息，期间的消息不会补录，需重新启动进程并连接。确定停止？`,
      )
    )
      return;
    await api("/api/process", { id, action: managed ? "stop" : "start" });
    await load();
    return;
  }
  if (kind === "models") {
    const a = config.agents.find((a) => a.backendId === id);
    if (!a) throw Error("请先将此后端绑定到一个角色");
    const r = await api("/api/models", { agentId: a.id });
    editing = { type: "read" };
    $("#edit-title").textContent = "后端模型目录";
    $("#edit-fields").innerHTML =
      '<pre class="mono">' + esc(JSON.stringify(r.models, null, 2)) + "</pre>";
    $("#edit-form footer").hidden = true;
    $("#editor").showModal();
    return;
  }
  if (kind === "connect") {
    const connected = status.connections.find((s) => s.id === id)?.connected;
    if (
      connected &&
      !confirm(
        `断开连接后，「${find("connections", id)?.label || id}」不再接收或发送 QQ 消息，绑定它的角色都无法发言，断开期间的消息不会补录；QQ 登录数据保留。确定断开？`,
      )
    )
      return;
    await api("/api/connection", {
      id,
      action: connected ? "disconnect" : "connect",
    });
    await load();
    return;
  }
  if (kind === "grant") {
    const r = status.disclosureRequests[Number(id)];
    await api("/api/disclosure", {
      approvalId: r.approvalId,
      agentId: r.agentId,
      conversation: r.conversation,
      ids: r.records,
      requestId: r.requestId,
    });
    await load();
    return;
  }
  if (kind === "download-config") {
    download(config, "qq-unified-config.json");
    return;
  }
  if (kind === "advanced") {
    editing = { type: "advanced" };
    $("#edit-title").textContent = "完整配置";
    $("#edit-fields").innerHTML =
      `<label>JSON 配置<textarea id="config-json" class="mono" rows="23">${esc(JSON.stringify(config, null, 2))}</textarea></label>`;
    $("#editor").showModal();
  }
}
const input = (key, label, value = "", extra = "") =>
  `<label>${label}<input name="${key}" value="${esc(value)}" ${extra}></label>`;
const check = (key, label, value) =>
  `<label class="check"><input type="checkbox" name="${key}" ${value ? "checked" : ""}>${label}</label>`;
// Less-used fields of a form, collapsed by default. Inputs keep their names,
// so FormData and saving are unchanged.
const advanced = (title, html) =>
  `<details class="adv"><summary>${title}</summary><div class="form-grid">${html}</div></details>`;
// A required field inside a collapsed section would block submit silently.
document.addEventListener?.(
  "invalid",
  (e) => {
    for (
      let d = e.target.closest?.("details");
      d;
      d = d.parentElement?.closest("details")
    )
      d.open = true;
  },
  true,
);
const area = (key, label, value) =>
  `<label class="wide">${label}<textarea name="${key}">${esc(value)}</textarea></label>`;
const select = (key, label, value, options) =>
  `<label>${label}<select name="${key}">${options.map(([v, l]) => `<option value="${esc(v)}" ${v === value ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>`;
function openEditor(type, id) {
  const row = id
    ? structuredClone(find(type, id))
    : {
        id: "",
        paused: true,
        enabled: false,
        wake: {
          mentions: true,
          names: true,
          private: true,
          participation: 0.05,
          peers: true,
          cooldownMs: 1500,
        },
        allow: { groups: [], users: [] },
        tools: [
          "memory_search",
          "memory_related",
          "memory_read",
          "conversation_read",
          "diary_write",
          "diary_revise",
          "qq_send",
          "qq_mark_read",
        ],
        silence: [],
        toolServers: [],
        maxSendsPerTurn: 3,
      };
  editing = { type, id, row };
  $("#edit-title").textContent =
    (id ? "编辑" : "添加") +
    { agents: "角色", connections: "QQ 账号", backends: "AI 后端" }[type];
  let html = input(
    "id",
    "稳定 ID",
    row.id,
    id ? "readonly" : 'required pattern="[a-z][a-z0-9_-]{0,63}"',
  );
  if (type === "agents") {
    $("#edit-fields").innerHTML = agentForm.build(row, html);
    agentForm.bind($("#edit-fields"), row);
    $("#editor").showModal();
    return;
  }
  if (type === "connections") {
    html +=
      input("label", "实例名称", row.label, "required") +
      input(
        "accountId",
        "QQ 账号",
        row.accountId,
        'required pattern="[0-9]+"',
      ) +
      select("deployment", "部署方式", row.deployment || "external", [
        ["external", "已有外部实例"],
        ["native", "原生 NapCat"],
        ["docker", "Docker NapCat"],
      ]) +
      input(
        "httpUrl",
        "OneBot HTTP 地址",
        row.httpUrl || "http://127.0.0.1:23010",
        "required",
      ) +
      input(
        "wsUrl",
        "OneBot WebSocket 地址",
        row.wsUrl || "ws://127.0.0.1:23011",
        "required",
      ) +
      input(
        "tokenEnv",
        "访问令牌的环境变量名",
        row.tokenEnv || "QQ_UNIFIED_ONEBOT_A",
      ) +
      input("webUrl", "NapCat Web 管理地址（可选）", row.webUrl) +
      check("enabled", "启用此连接配置", row.enabled) +
      check(
        "autoReconnect",
        "断线后自动重连（只恢复接收；不重发、不补录断线期间消息）",
        row.recovery?.autoReconnect ?? true,
      ) +
      input(
        "maxAttempts",
        "自动重连最多尝试次数",
        row.recovery?.maxAttempts ?? 8,
        'type="number" min="1" max="20"',
      ) +
      input("container", "Docker 容器名（须有实例归属标签）", row.container) +
      area(
        "process",
        "原生启动配置（JSON：command、args、env；可留空）",
        row.process ? JSON.stringify(row.process, null, 2) : "",
      );
  } else {
    html +=
      input("label", "后端名称", row.label, "required") +
      select("type", "适配器", row.type || "dsh", [
        ["dsh", "DeepSeek Harness"],
        ["codex", "Codex app-server"],
        ["openai", "OpenAI 兼容 API"],
      ]) +
      input("provider", "模型提供方（可选）", row.provider) +
      input("model", "默认模型（留空使用后端默认）", row.model) +
      input("effort", "默认思考强度", row.effort || "high") +
      input(
        "baseUrl",
        "服务地址（DSH：固定本机地址，可留空选择实例；OpenAI 兼容：如 https://api.deepseek.com/v1）",
        row.baseUrl,
      ) +
      input(
        "apiKeyEnv",
        "API 密钥环境变量名（OpenAI 兼容；本机服务可留空）",
        row.apiKeyEnv,
      ) +
      input(
        "contextWindow",
        "上下文窗口 tokens（OpenAI 兼容）",
        row.contextWindow ?? 128000,
        'type="number" min="1024"',
      ) +
      check("vision", "模型支持图片输入（OpenAI 兼容）", row.vision) +
      check(
        "sendEffort",
        "发送思考强度 reasoning_effort（OpenAI 兼容，仅推理模型）",
        row.sendEffort,
      ) +
      input("preset", "DSH preset", row.preset || "qq-unified") +
      input("command", "Codex 命令", row.command || "codex") +
      area(
        "toolServers",
        "允许的外部 MCP 服务（JSON，凭据用 env 引用）",
        JSON.stringify(row.toolServers, null, 2),
      );
  }
  $("#edit-fields").innerHTML = '<div class="form-grid">' + html + "</div>";
  $("#editor").showModal();
}
$("#edit-form").onsubmit = (e) => {
  e.preventDefault();
  if (editing?.type === "read") return;
  action(async () => {
    let next = structuredClone(config);
    let githubCredential;
    if (editing.type === "advanced") next = JSON.parse($("#config-json").value);
    else {
      const f = new FormData(e.target),
        get = (k) => String(f.get(k) || ""),
        list = (k) =>
          get(k)
            .split(/[,，\s]+/)
            .map((s) => s.trim())
            .filter(Boolean);
      let row = { ...editing.row, id: get("id") };
      if (editing.type === "agents")
        ({ row, githubCredential } = agentForm.parse(f, editing.row));
      else if (editing.type === "connections")
        row = {
          id: row.id,
          // Fields without a form control must survive an edit unchanged.
          ...(row.messageIdNamespace
            ? { messageIdNamespace: row.messageIdNamespace }
            : {}),
          ...(row.gateway ? { gateway: row.gateway } : {}),
          recovery: {
            ...row.recovery,
            autoReconnect: f.has("autoReconnect"),
            maxAttempts: Number(get("maxAttempts")) || 8,
          },
          label: get("label"),
          accountId: get("accountId"),
          deployment: get("deployment"),
          httpUrl: get("httpUrl"),
          wsUrl: get("wsUrl"),
          ...(get("tokenEnv") ? { tokenEnv: get("tokenEnv") } : {}),
          ...(get("webUrl") ? { webUrl: get("webUrl") } : {}),
          enabled: f.has("enabled"),
          ...(get("container") ? { container: get("container") } : {}),
          ...(get("process").trim()
            ? { process: JSON.parse(get("process")) }
            : {}),
        };
      else
        row = {
          ...row,
          id: row.id,
          label: get("label"),
          type: get("type"),
          provider: get("provider"),
          model: get("model"),
          effort: get("effort"),
          baseUrl: get("baseUrl") || undefined,
          recovery: {
            ...row.recovery,
            ...(get("baseUrl") !== (row.baseUrl || "")
              ? { dshInstance: undefined }
              : {}),
          },
          preset: get("preset"),
          command: get("command"),
          toolServers: JSON.parse(get("toolServers") || "[]"),
          ...(get("type") === "openai"
            ? {
                ...(get("apiKeyEnv") ? { apiKeyEnv: get("apiKeyEnv") } : {}),
                contextWindow: Number(get("contextWindow")) || 128000,
                ...(row.maxToolRounds
                  ? { maxToolRounds: row.maxToolRounds }
                  : {}),
                ...(row.requestTimeoutMs
                  ? { requestTimeoutMs: row.requestTimeoutMs }
                  : {}),
                vision: f.has("vision"),
                sendEffort: f.has("sendEffort"),
              }
            : {}),
        };
      const index = next[editing.type].findIndex((x) => x.id === editing.id);
      if (index < 0) next[editing.type].push(row);
      else next[editing.type][index] = row;
    }
    const result = await api("/api/config", { config: next, revision }, "PUT");
    if (githubCredential)
      await api("/api/github/credential", githubCredential, "POST");
    $("#editor").close();
    await load();
    notice(savedNotice(result));
  });
};
function savedNotice(result) {
  if (result.warnings?.length)
    return "配置已保存，但运行态更新未完成。请查看最近错误，处理故障后恢复服务。";
  if (result.restartRequired) return "已保存。监听端口将在重启服务后生效。";
  const reconnect = (result.reconnectConnections || []).map(
    (id) => config.connections.find((c) => c.id === id)?.label || id,
  );
  if (reconnect.length)
    return `已保存。${reconnect.map((l) => `“${l}”`).join("、")} 的连接设置已变化，需要手动重新连接后才能继续收发。`;
  if (result.reconnectRequired)
    return "已保存。改动的 QQ 账号未启用，无需重新连接。";
  return result.affectedAgents?.length
    ? "已保存并生效。受影响角色的旧回合已结束，其他角色继续运行。"
    : "已保存并生效，现有 QQ 连接和回合保持不变。";
}
function sceneMarkup(scene) {
  if (!scene) return "";
  const source = scene.source;
  const line = (m) =>
    `<li><small>${esc(m.occurredAt)} · ${esc(m.senderName || "名字未记录")}（${esc(m.senderId || "身份未知")}）${m.matched ? " · 命中" : ""}</small><p>${esc(m.body)}${m.bodyTruncated ? "…（原文未完整展示）" : ""}</p>${m.replyTo.length ? `<small>引用：${m.replyTo.map((r) => esc(r.messageId) + (r.status === "observed" ? "（有原文）" : "（未取得原文）")).join("、")}</small>` : ""} <button type="button" data-read="${esc(m.id)}">读原文</button></li>`;
  return `<details open><summary>${esc(source.name || "名称未记录")} · ${esc(source.conversation)} · 场景片段</summary><p class="hint">以下是时间相邻的消息，不代表同一话题。名称${source.nameObservedAt ? "观察于 " + esc(source.nameObservedAt) : "未知"}。</p><p>片段内发言者：${scene.participants.map((p) => `${esc(p.observedNames.join(" / ") || "名字未记录")}（${esc(p.id)}，${p.messageCount} 条）`).join("、") || "未知"}。这不是全群成员名单。</p><ol>${scene.messages.map(line).join("")}</ol>${scene.quoted.length ? `<p>另取的引用原文（不计入片段参与者）：</p><ol>${scene.quoted.map(line).join("")}</ol>` : ""}${scene.contextTruncated ? '<p class="hint">上下文受结果预算限制，已收缩；可继续展开。</p>' : ""}${!scene.timeKnown ? '<p class="hint">原消息时间不可靠，未自动拼接相邻发言。</p>' : ""}${scene.sharedRecords?.length ? `<p class="hint">${scene.sharedRecords.length} 条重叠记录已在本页前面的片段展示，按原记录 ID 去重。</p>` : ""}<button type="button" data-context="${esc(scene.anchorId)}">查看更多前后文</button> <button type="button" data-related="${esc(scene.anchorId)}">跨时间引用 / 撤回</button></details>`;
}
async function readRelated(id, afterSeq = 0) {
  await action(async () => {
    const r = await api(
      "/api/memory/related?" +
        new URLSearchParams({
          agentId: $("#memory-agent").value,
          id,
          afterSeq,
        }),
    );
    editing = { type: "read" };
    $("#edit-title").textContent = "明确引用与撤回";
    $("#edit-fields").innerHTML =
      `<p class="hint">这里只展示明确关系。引用不自动等于更正、赞同或因果；撤回不证明原话真假。可继续读原文判断。</p>${r.items.map((x) => `<article class="record"><small>${esc(x.record.senderName || "名字未记录")}（${esc(x.record.senderId || "未知")}）· ${esc(x.record.occurredAt || "")}</small><p>${esc(x.record.body || "摘要省略")}</p>${(x.links || []).map((l) => `<p>${l.relation === "recall-notice" ? "撤回通知" : "明确引用"} → ${esc(l.toMessageId)} ${l.toId ? `<button type="button" data-read="${esc(l.toId)}">引用原文</button>` : "（原文未归档）"}</p>`).join("")}<button type="button" data-read="${esc(x.record.id)}">读原文</button></article>`).join("") || "没有已归档的明确关系；不代表没有后续。"}${r.nextAfterSeq !== null ? '<button type="button" id="more-relations">继续读取关系</button>' : ""}`;
    $("#edit-fields")
      .querySelectorAll("[data-read]")
      .forEach((b) => (b.onclick = () => readMemory(b.dataset.read)));
    if (r.nextAfterSeq !== null)
      $("#more-relations").onclick = () => readRelated(id, r.nextAfterSeq);
    $("#edit-form footer").hidden = true;
    if (!$("#editor").open) $("#editor").showModal();
  });
}
async function readConversation(args) {
  await action(async () => {
    const r = await api(
      "/api/memory/conversation?" +
        new URLSearchParams({ agentId: $("#memory-agent").value, ...args }),
    );
    editing = { type: "read" };
    $("#edit-title").textContent = "同一来源的前后文";
    $("#edit-fields").innerHTML =
      `<p class="hint">原始记录按归档顺序排列；不是自动识别的话题。${r.truncated ? "本页受字符预算限制。" : ""}</p>${r.items.map((m) => `<article class="record"><small>${esc(m.conversation)} · ${esc(m.senderName || m.senderId || "身份未知")} · ${esc(m.occurredAt || "时间未知")}</small><p>${esc(m.body || "摘要未展示")} ${m.bodyTruncated ? "（可读原文）" : ""}</p><button type="button" data-read="${esc(m.id)}">读原文</button></article>`).join("") || "没有更多记录"}${r.items.length ? '<button type="button" id="older-context">更早记录</button> <button type="button" id="newer-context">更晚记录</button>' : ""}`;
    $("#edit-fields")
      .querySelectorAll("[data-read]")
      .forEach((b) => (b.onclick = () => readMemory(b.dataset.read)));
    const first = r.items[0],
      last = r.items.at(-1);
    if (first) {
      const scope = {
        conversation: first.conversation,
        connectionId: first.connectionId || "",
      };
      $("#older-context").onclick = () =>
        readConversation({ ...scope, beforeSeq: first.seq });
      $("#newer-context").onclick = () =>
        readConversation({ ...scope, afterSeq: last.seq });
    }
    $("#edit-form footer").hidden = true;
    if (!$("#editor").open) $("#editor").showModal();
  });
}
let memoryConversations = [];
const conversationLabel = (conversation) =>
  conversation.replace(/^group:/, "群 ").replace(/^private:/, "私聊 ");
function conversationStateText(c) {
  if (!c) return "尚无会话状态，按角色设置参与";
  return (
    [
      c.paused ? "已暂停" : "",
      c.silenceUntil > Date.now()
        ? `静默至 ${new Date(c.silenceUntil).toLocaleString()}`
        : "",
      c.allowed ? "" : "不在白名单",
    ]
      .filter(Boolean)
      .join(" · ") || "正常参与"
  );
}
const memorySource = () =>
  $("#memory-source").value === "manual"
    ? $("#memory-source-manual").value.trim()
    : $("#memory-source").value;
function requireSource() {
  const conversation = memorySource();
  if (!/^(group|private):\d+$/.test(conversation))
    throw Error("请先选择来源，或手动填写 group:群号 / private:QQ 号");
  return conversation;
}
function renderSourceState() {
  const conversation = memorySource(),
    known = memoryConversations.find((c) => c.conversation === conversation);
  $("#memory-source-state").textContent = conversation
    ? `${conversationLabel(conversation)}：${conversationStateText(known)}`
    : "选择来源后可暂停、解除暂停或重置其模型上下文。";
}
async function loadConversations() {
  const agentId = $("#memory-agent").value,
    a = find("agents", agentId);
  const rows = await api(
    "/api/conversations?agentId=" + encodeURIComponent(agentId),
  );
  if (tab !== "memory" || $("#memory-agent")?.value !== agentId) return;
  const allowed = new Set([
    ...a.allow.groups.map((x) => "group:" + x),
    ...a.allow.users.map((x) => "private:" + x),
  ]);
  // Allow-listed sources with no stored state yet are still pickable.
  memoryConversations = [
    ...rows,
    ...[...allowed]
      .filter((c) => !rows.some((r) => r.conversation === c))
      .map((conversation) => ({ conversation, paused: false })),
  ]
    .map((c) => ({ ...c, allowed: allowed.has(c.conversation) }))
    .sort((x, y) => x.conversation.localeCompare(y.conversation));
  const pick = $("#memory-source"),
    previous = pick.value;
  pick.innerHTML = `<option value="">全部来源</option>${memoryConversations.map((c) => `<option value="${esc(c.conversation)}">${esc(conversationLabel(c.conversation))} · ${esc(conversationStateText(c))}</option>`).join("")}<option value="manual">手动输入…</option>`;
  pick.value = [...pick.options].some((o) => o.value === previous)
    ? previous
    : "";
  $("#memory-source-manual-field").hidden = pick.value !== "manual";
  renderSourceState();
  const list = $("#memory-conversations");
  list.innerHTML =
    memoryConversations
      .map((c) => {
        const resetOff = disabledReason([[!c.allowed, "notAllowed"]]);
        return `<div class="record"><div class="row"><strong>${esc(conversationLabel(c.conversation))}</strong>${tag(conversationStateText(c), c.paused ? "off" : c.silenceUntil > Date.now() || !c.allowed ? "warn" : "live")}</div><p class="hint mono">${esc(c.conversation)}</p><button type="button" data-conv-pick="${esc(c.conversation)}">选为来源</button> ${c.paused || c.silenceUntil > Date.now() ? `<button type="button" data-conv="resume" data-conversation="${esc(c.conversation)}">解除暂停 / 静默</button>` : `<button type="button" data-conv="pause" data-conversation="${esc(c.conversation)}">暂停</button>`} <button type="button" class="ghost" data-conv="reset" data-conversation="${esc(c.conversation)}" ${disabledAttr(resetOff)}>重置模型上下文</button>${disabledHints(resetOff)}</div>`;
      })
      .join("") ||
    "<p>此角色还没有会话记录，白名单也为空。可在上方手动输入来源。</p>";
  list.querySelectorAll("[data-conv-pick]").forEach(
    (b) =>
      (b.onclick = () => {
        $("#memory-source").value = b.dataset.convPick;
        $("#memory-source").onchange();
      }),
  );
  list
    .querySelectorAll("[data-conv]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          action(() =>
            conversationAction(b.dataset.conv, b.dataset.conversation),
          )),
    );
}
async function conversationAction(kind, conversation) {
  const agentId = $("#memory-agent").value,
    name = find("agents", agentId)?.name || agentId,
    label = conversationLabel(conversation);
  if (kind === "reset") {
    if (
      !confirm(
        `重置后，「${name}」在「${label}」的模型上下文会清空，进行中的回合会被结束，下次回合重新建立会话；经历档案和日记保留。确定重置？`,
      )
    )
      return;
    await api("/api/session/reset", { agentId, conversation });
    notice(`「${label}」的模型上下文已重置，经历档案保留`);
  } else {
    const paused = kind === "pause";
    await api("/api/conversation/state", { agentId, conversation, paused });
    notice(
      paused
        ? `「${label}」已暂停，此来源进行中的回合已结束`
        : `「${label}」的暂停 / 静默已解除；角色和全局暂停仍独立生效`,
    );
  }
  await loadConversations();
}
async function searchMemory(cursor = null) {
  await action(async () => {
    const q = new URLSearchParams({
      agentId: $("#memory-agent").value,
      query: $("#memory-query").value,
      type: $("#memory-type").value,
    });
    if (cursor) q.set("cursor", JSON.stringify(cursor));
    if ($("#memory-person").value) q.set("person", $("#memory-person").value);
    if (memorySource()) q.set("conversation", memorySource());
    const result = await api("/api/memory?" + q);
    const rows = [...result.items, ...result.diaries];
    const node = $("#memory-results");
    node.className = "";
    node.innerHTML =
      rows
        .map(
          (r) =>
            `<article class="record"><div class="row"><strong>${esc(r.title || r.type)}</strong>${tag(r.origin)}</div><p>${esc(r.body)}${r.bodyTruncated ? "…" : ""}</p>${r.bodyTruncated ? '<p class="hint">这里是摘要，可打开阅读全文。</p>' : ""}<small>${esc(r.conversation || "个人日记")} · ${esc(r.senderId || "")} · ${esc(r.occurredAt || r.updatedAt)}</small> <button type="button" data-read="${esc(r.id)}">${r.type === "diary" ? "阅读全文" : "展开原文"}</button>${sceneMarkup(r.scene)}</article>`,
        )
        .join("") || '<p class="empty">没有匹配记录。</p>';
    node
      .querySelectorAll("[data-read]")
      .forEach((b) => (b.onclick = () => readMemory(b.dataset.read)));
    node
      .querySelectorAll("[data-context]")
      .forEach(
        (b) =>
          (b.onclick = () => readConversation({ aroundId: b.dataset.context })),
      );
    node
      .querySelectorAll("[data-related]")
      .forEach((b) => (b.onclick = () => readRelated(b.dataset.related)));
    if (result.nextCursor) {
      const b = document.createElement("button");
      b.textContent = "下一页";
      b.onclick = () => searchMemory(result.nextCursor);
      node.append(b);
    }
  });
}
let memoryReaderRequest = 0;
async function readMemory(id, options = {}) {
  const request = ++memoryReaderRequest;
  const agentId = options.agentId || $("#memory-agent").value;
  await action(async () => {
    const query = new URLSearchParams({ agentId, id });
    if (options.revision !== undefined) query.set("revision", options.revision);
    const r = await api("/api/memory/view?" + query);
    if (request !== memoryReaderRequest) return;
    const reader = { type: "read" };
    editing = reader;
    $("#edit-title").textContent = r.title || "经历原文";
    $("#edit-fields").innerHTML =
      `<article class="memory-reader"><p class="hint" id="memory-reader-meta"></p><div class="card-actions" id="memory-version-controls"><button type="button" id="memory-previous-version">上一版本</button><span id="memory-reader-version"></span><button type="button" id="memory-next-version">下一版本</button></div><div class="memory-reader-body" id="memory-reader-body"></div><p class="hint" id="memory-read-progress" aria-live="polite"></p><button type="button" id="memory-read-more">继续阅读</button></article>`;
    const author = config.agents.find((a) => a.id === agentId)?.name || agentId;
    const time = r.writtenAt || r.occurredAt || r.updatedAt;
    $("#memory-reader-meta").textContent = [
      author,
      r.type === "diary" ? "个人日记" : r.conversation,
      r.senderName || r.senderId,
      time ? new Date(time).toLocaleString() : "",
    ]
      .filter(Boolean)
      .join(" · ");
    $("#memory-reader-body").textContent = r.body;
    const versions = $("#memory-version-controls");
    versions.hidden = r.type !== "diary";
    if (r.type === "diary") {
      $("#memory-reader-version").textContent =
        `版本 ${r.revision} / ${r.latestRevision}`;
      $("#memory-previous-version").disabled = r.revision <= 1;
      $("#memory-next-version").disabled = r.revision >= r.latestRevision;
      $("#memory-previous-version").onclick = () =>
        readMemory(id, { agentId, revision: r.revision - 1 });
      $("#memory-next-version").onclick = () =>
        readMemory(id, { agentId, revision: r.revision + 1 });
      // Keep every continuation on the version that was initially displayed.
      query.set("revision", r.revision);
    }
    const more = $("#memory-read-more");
    let nextOffset = r.nextOffset,
      loading = false;
    const progress = () => {
      more.hidden = nextOffset === null;
      $("#memory-read-progress").textContent =
        nextOffset === null
          ? "正文已全部显示"
          : "下方还有正文，继续阅读会保留已显示的内容。";
    };
    progress();
    more.onclick = () =>
      action(async () => {
        if (loading || nextOffset === null) return;
        loading = true;
        more.disabled = true;
        try {
          query.set("offset", nextOffset);
          const page = await api("/api/memory/view?" + query);
          if (request !== memoryReaderRequest || editing !== reader) return;
          $("#memory-reader-body").textContent += page.body;
          nextOffset = page.nextOffset;
          progress();
        } finally {
          loading = false;
          more.disabled = false;
        }
      });
    $("#edit-form footer").hidden = true;
    if (!$("#editor").open) $("#editor").showModal();
  });
}
$("#editor").addEventListener("close", () => {
  memoryReaderRequest++;
  $("#edit-form footer").hidden = false;
});
function download(value, name) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
if (token) action(load);
setInterval(() => {
  if (
    config &&
    ["overview", "agents", "links"].includes(tab) &&
    !$("#editor").open
  )
    action(async () => {
      status = await api("/api/status");
      // Re-rendering replaces #content; never discard what the user is typing.
      const focused = document.activeElement;
      if (
        focused?.matches?.("input, textarea, select") &&
        $("#content").contains(focused)
      ) {
        renderGlobalPauseControl();
        if (tab === "overview" && $("#recent-errors"))
          $("#recent-errors").innerHTML = recentErrorsMarkup(errorFilter);
      } else render();
    });
}, 5000);
