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
let token = sessionStorage.getItem("qq-unified-token") || "",
  config,
  revision,
  tools = [],
  status,
  tab = "overview",
  editing;
const titles = {
  apps: ["浏览与分享", "按主体配置平台浏览，查看真实来源和分享决定。"],
  mind: ["Self 与主体", "当前自我、候选成长、主动意图与工作会话。"],
  permissions: ["权限", "分别设置每个 AI 的文件收发能力与独立文件库。"],
  schedule: ["主动与定时", "条件唤醒、睡前观察和定时任务，各自按规则运行。"],
  voices: ["语音库", "导入、试听和管理每个角色自己的语音素材。"],
  operations: ["词汇与运维", "核对黑话候选，逐项确认管理员操作。"],
  overview: ["概览", "在一个地方，照看每个独立的 AI。"],
  agents: ["智能体", "人格与经历归属于稳定身份，切换后端也能延续。"],
  connections: ["QQ 实例", "每个 QQ 账号独立连接，启停桥接不影响登录数据。"],
  backends: ["AI 后端", "管理 DSH、Codex 与各自的模型和工具。"],
  memory: ["经历与日记", "消息按实际发生记录；日记由 AI 自主书写。"],
  settings: ["运行设置", "隔离开发、全局参与边界与可迁移配置。"],
};
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
  if (!r.ok) throw Error(value.error || "请求失败");
  return value;
}
function notice(value) {
  $("#notice").textContent = value;
  $("#notice").hidden = false;
  clearTimeout(notice.timer);
  notice.timer = setTimeout(() => ($("#notice").hidden = true), 5000);
}
async function load() {
  const c = await api("/api/config");
  config = c.config;
  revision = c.revision;
  tools = c.tools;
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
  action(async () => {
    await api("/api/pause", { paused: true });
    await load();
    notice("全部智能体已暂停");
  });
document.querySelectorAll("nav button").forEach(
  (b) =>
    (b.onclick = () => {
      tab = b.dataset.tab;
      render();
    }),
);
$("#close-editor").onclick = () => $("#editor").close();
const tag = (text, cls = "") => `<span class="pill ${cls}">${esc(text)}</span>`;
const icon = (name, cls = "") =>
  `<svg class="i ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const meter = (ratio) =>
  `<svg class="meter" viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true"><rect class="track" width="100" height="4" rx="2"/><rect class="bar" width="${Math.max(0, Math.min(100, ratio * 100))}" height="4" rx="2"/></svg>`;
const find = (type, id) => config[type].find((x) => x.id === id);
function render() {
  const [title, subtitle] = titles[tab];
  $("#title").textContent = title;
  $("#crumb").textContent = title;
  $("#subtitle").textContent = subtitle;
  document.title = `${title} · QQ Agents`;
  document
    .querySelectorAll("nav button")
    .forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
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
  if (tab === "mind") {
    renderMind();
    return;
  }
  if (tab === "overview") {
    content.innerHTML = `<div class="banner ${status.mode === "isolated" ? "warn" : status.globalPaused ? "" : "ok"}">${icon(status.mode === "isolated" ? "shield" : "pulse")}<span>${status.mode === "isolated" ? "当前为隔离模式。不会连接 QQ 或启动模型回合。切换需要以 --live 启动并在管理台配置。" : status.globalPaused ? "全局暂停中。连接可记录收到的消息，智能体不会参与；解除全局暂停后，各角色的独立暂停仍生效。" : "全局允许参与。具体行为由每个角色的暂停、白名单、唤醒和静默配置决定。"}</span></div><div class="stats">${[
      ["智能体", config.agents.length, "独立人格与经历", "bot"],
      ["QQ 实例", config.connections.length, "账号与连接分离", "link"],
      ["AI 后端", config.backends.length, "模型可独立切换", "chip"],
      [
        "活动回合",
        status.agents.reduce((n, a) => n + a.activeTurns, 0),
        "当前进行中的对话",
        "pulse",
      ],
    ]
      .map(
        ([name, n, sub, ic]) =>
          `<div class="card stat"><div class="stat-head"><span>${name}</span>${icon(ic)}</div><span class="number">${n}</span><p class="hint">${sub}</p></div>`,
      )
      .join(
        "",
      )}</div><div class="section-title"><h2>角色状态</h2><button class="ghost" data-do="tab" data-id="agents">管理智能体${icon("arrow", "sm")}</button></div><div class="grid">${config.agents.map(agentCard).join("")}</div><div class="section-title"><h2>受限动作授权</h2>${tag("回忆发言由智能体自行判断", "accent")}</div><div class="card">${status.disclosureRequests.length ? status.disclosureRequests.map((r, i) => `<div class="record"><strong>${esc(find("agents", r.agentId)?.name)} → ${esc(r.conversation)}</strong><p>${r.records.length} 条资料涉及${r.reason === "external-service" ? "外部服务调用" : "本地运维内容"}。批准仅对当前回合、所示请求参数及资料集合有效。</p><p class="mono">${esc(r.records.join("\n"))}</p>${r.request ? `<pre>${esc(JSON.stringify(r.request, null, 2))}</pre><p>${esc(JSON.stringify(r.sourceClasses))}</p>` : ""}<button data-do="grant" data-id="${i}">批准本次披露</button></div>`).join("") : "<p>当前没有待批准的受限动作。</p>"}</div>`;
  } else if (["agents", "connections", "backends"].includes(tab)) {
    content.innerHTML = `<div class="section-title"><h2>${titles[tab][0]} · ${config[tab].length}</h2><button class="primary" data-do="add" data-id="${tab}">${icon("plus", "sm")}添加${{ agents: "智能体", connections: "实例", backends: "后端" }[tab]}</button></div><div class="grid">${config[tab].map(tab === "agents" ? agentCard : tab === "connections" ? connectionCard : backendCard).join("") || '<div class="card empty">添加第一个配置开始。</div>'}</div>`;
  } else if (tab === "apps") {
    renderApps();
  } else if (tab === "permissions") {
    renderFilePermissions();
  } else if (["schedule", "voices", "operations"].includes(tab)) {
    renderParity(tab);
  } else if (tab === "memory") {
    content.innerHTML = `<div class="card"><div class="toolbar"><label>智能体<select id="memory-agent">${config.agents.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join("")}</select></label><label>关键词<input id="memory-query" placeholder="约定、上次、某件事…"></label><label>记录类型<select id="memory-type"><option value="all">全部</option><option value="event">经历档案</option><option value="diary">个人日记</option></select></label><button class="primary" id="search-memory">搜索</button><button id="export-memory">导出</button></div><div class="form-grid"><label>人物 QQ<input id="memory-person" placeholder="按 QQ 身份检索"></label><label>来源<input id="memory-source" placeholder="group:10000 或 private:10000"></label></div><div class="card-actions"><button id="reset-session">重置此来源模型上下文</button><button id="resume-conversation">解除此来源暂停 / 静默</button></div><p class="hint">原始消息是“某人说过的话”，不自动等同于已核实事实。旧笔记标注 legacy 来源。</p><div id="memory-results" class="empty">搜索此角色自己的经历和日记。</div></div>`;
    $("#reset-session").onclick = () =>
      action(async () => {
        const conversation = $("#memory-source").value;
        if (!/^(group|private):\d+$/.test(conversation))
          throw Error("请先填写准确来源");
        await api("/api/session/reset", {
          agentId: $("#memory-agent").value,
          conversation,
        });
        notice("模型上下文已重置，经历档案保留");
      });
    $("#resume-conversation").onclick = () =>
      action(async () => {
        const conversation = $("#memory-source").value;
        if (!/^(group|private):\d+$/.test(conversation))
          throw Error("请先填写准确来源");
        await api("/api/conversation/state", {
          agentId: $("#memory-agent").value,
          conversation,
          paused: false,
        });
        notice("来源暂停已解除；角色和全局暂停仍独立生效");
      });
    $("#search-memory").onclick = () => searchMemory();
    $("#export-memory").onclick = () =>
      action(async () =>
        download(
          await api(
            "/api/export?agentId=" +
              encodeURIComponent($("#memory-agent").value),
          ),
          "agent-export.json",
        ),
      );
  } else {
    content.innerHTML = `<div class="card"><h2>参与控制</h2><p>启动时总是全局暂停。解除全局暂停不会自动解除角色暂停，也不会连接 QQ。</p><div class="card-actions"><button data-do="global-resume" ${status.mode === "isolated" ? "disabled" : ""}>解除全局暂停</button></div></div><div class="card section-title"><div><h2>完整配置</h2><p>支持配置任意数量的智能体、QQ 实例与后端。配置中的凭据仅填写环境变量名。</p></div><button data-do="advanced">打开配置编辑器</button></div><div class="card"><h2>迁移与备份</h2><p>先运行迁移预检，再导入到新数据目录。旧文件、原登录目录和 Docker 数据都保留。</p><p class="mono">npm run migrate -- --source /path/to/old-instance --agent agent-a --data /path/to/new-data</p><p class="hint">默认只生成统计预检。实际导入需 --apply；目标目录有运行锁时会拒绝。迁移不会修改旧实例，也不会启动 QQ。</p><button data-do="download-config">导出配置</button></div>`;
  }
  content
    .querySelectorAll("[data-do]")
    .forEach(
      (b) =>
        (b.onclick = () => action(() => operate(b.dataset.do, b.dataset.id))),
    );
}
function agentCard(a) {
  const s = status.agents.find((s) => s.id === a.id),
    c = find("connections", a.connectionId),
    b = find("backends", a.backendId);
  return `<article class="card"><div class="row"><div class="identity"><span class="avatar">${esc(a.name.slice(0, 1))}</span><div><h3>${esc(a.name)}</h3><span class="hint mono">${esc(a.id)}</span></div></div>${tag(a.paused ? "已暂停" : status.globalPaused ? "全局暂停" : "允许参与", a.paused ? "off" : status.globalPaused ? "warn" : "live")}</div><dl class="agent-meta"><dt>QQ 实例</dt><dd>${esc(c?.label)}</dd><dt>后端 / 模型</dt><dd>${esc(b?.label)} / <span class="mono">${esc(a.model || b?.model || "后端默认")}</span></dd><dt>参与率</dt><dd>${Math.round(a.wake.participation * 100)}%${meter(a.wake.participation)}</dd><dt>来源范围</dt><dd>${a.allow.groups.length} 个群 · ${a.allow.users.length} 位私聊对象</dd></dl>${s?.error ? `<p class="hint">${esc(s.error)}</p>` : ""}<div class="card-actions"><button data-do="edit-agent" data-id="${esc(a.id)}">${icon("settings", "sm")}配置角色</button><button class="ghost" data-do="toggle" data-id="${esc(a.id)}" ${status.mode === "isolated" && !a.paused ? "disabled" : ""}>${icon(a.paused ? "play" : "pause", "sm")}${a.paused ? "解除角色暂停" : "暂停角色"}</button></div></article>`;
}
function connectionCard(c) {
  const s = status.connections.find((s) => s.id === c.id);
  return `<article class="card"><div class="row"><div class="identity"><span class="avatar">${icon("link")}</span><div><h3>${esc(c.label)}</h3><span class="hint mono">${esc(c.id)}</span></div></div>${tag(s?.connected ? "已连接" : "未连接", s?.connected ? "live" : "off")}</div><dl class="agent-meta"><dt>QQ 账号</dt><dd class="mono">${esc(c.accountId)}</dd><dt>HTTP</dt><dd class="mono">${esc(c.httpUrl)}</dd><dt>WebSocket</dt><dd class="mono">${esc(c.wsUrl)}</dd><dt>部署方式</dt><dd>${esc(c.deployment)}</dd></dl><p class="hint">${esc(s?.error || "连接前核对实际登录账号，不匹配时拒绝接入。")}</p><div class="card-actions"><button data-do="edit-connection" data-id="${esc(c.id)}">${icon("settings", "sm")}编辑</button><button class="ghost" data-do="connect" data-id="${esc(c.id)}" ${status.mode === "isolated" || !c.enabled ? "disabled" : ""}>${s?.connected ? "断开桥接" : "连接桥接"}</button>${c.deployment !== "external" ? `<button class="ghost" data-do="process" data-id="${esc(c.id)}" ${status.mode === "isolated" || !c.enabled ? "disabled" : ""}>${s?.process?.managed ? "停止 QQ 进程" : "启动 QQ 进程"}</button>` : ""}</div></article>`;
}
function backendCard(b) {
  return `<article class="card"><div class="row"><div class="identity"><span class="avatar">${icon("chip")}</span><div><h3>${esc(b.label)}</h3><span class="hint mono">${esc(b.id)}</span></div></div>${tag(b.type.toUpperCase(), "accent")}</div><dl class="agent-meta"><dt>提供方</dt><dd>${esc(b.provider || "后端默认")}</dd><dt>模型</dt><dd class="mono">${esc(b.model || "后端默认")}</dd><dt>思考强度</dt><dd>${esc(b.effort)}</dd><dt>外部工具</dt><dd>${b.toolServers.length} 个 MCP 服务</dd></dl><p class="hint">${b.type === "dsh" ? "端口留空时动态识别 DSH。需安装本项目独立 preset。" : "专用 Codex home 位于数据目录，需单独登录。"}</p><div class="card-actions"><button data-do="edit-backend" data-id="${esc(b.id)}">${icon("settings", "sm")}编辑后端</button><button class="ghost" data-do="models" data-id="${esc(b.id)}" ${status.mode === "isolated" ? "disabled" : ""}>读取模型目录</button></div></article>`;
}
async function operate(kind, id) {
  if (kind === "tab") {
    tab = id;
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
    const a = find("agents", id);
    await api("/api/pause", { agentId: id, paused: !a.paused });
    await load();
    return;
  }
  if (kind === "process") {
    const managed = status.connections.find((s) => s.id === id)?.process
      ?.managed;
    await api("/api/process", { id, action: managed ? "stop" : "start" });
    await load();
    return;
  }
  if (kind === "models") {
    const a = config.agents.find((a) => a.backendId === id);
    if (!a) throw Error("请先将此后端绑定到一个智能体");
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
      token: r.token,
      ids: r.records,
      requestId: r.requestId,
    });
    await load();
    return;
  }
  if (kind === "global-resume") {
    await api("/api/pause", { paused: false });
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
    { agents: "智能体", connections: "QQ 实例", backends: "AI 后端" }[type];
  let html = input(
    "id",
    "稳定 ID",
    row.id,
    id ? "readonly" : 'required pattern="[a-z][a-z0-9_-]{0,63}"',
  );
  if (type === "agents") {
    html +=
      input("name", "角色名称", row.name, "required") +
      select(
        "connectionId",
        "QQ 实例",
        row.connectionId,
        config.connections.map((c) => [c.id, c.label]),
      ) +
      select(
        "backendId",
        "AI 后端",
        row.backendId,
        config.backends.map((c) => [c.id, c.label]),
      ) +
      input("model", "模型（空白则继承后端）", row.model) +
      input("effort", "思考强度（空白则继承）", row.effort) +
      area(
        "appearance",
        "固定外形（无固定外形时请明确填写）",
        row.appearance || "",
      ) +
      area(
        "persona",
        "初始化模板（仅建立首版 self；已有 self 请在专页编辑）",
        row.persona || "",
      ) +
      input(
        "maxConsecutiveSends",
        "每批连续回复上限（读到人类新消息后恢复）",
        row.maxConsecutiveSends ?? row.maxSendsPerTurn,
        'type="number" min="1" max="10" required',
      ) +
      area(
        "publicUrls",
        "允许随时读取的精确公开 URL（每行一个，不含私密参数）",
        (row.network?.publicUrls || []).join("\n"),
      ) +
      check(
        "autonomousNetwork",
        "允许自主搜索与联网浏览（无需命令或逐次确认）",
        row.network?.autonomous,
      ) +
      '<p class="hint">允许自行整理查询内容，提交给已启用的平台和外部工具。聊天经历不再触发逐次联网确认；平台开关、时段、预算与凭据保护仍生效。</p>' +
      input("aliases", "唤醒别名（逗号分隔）", (row.aliases || []).join(", ")) +
      input(
        "ownerIds",
        "AI 管理员 QQ（逗号分隔）",
        (row.ownerIds || []).join(", "),
      ) +
      input("groups", "群白名单（逗号分隔）", row.allow.groups.join(", ")) +
      input("users", "私聊白名单（逗号分隔）", row.allow.users.join(", ")) +
      input(
        "participation",
        "普通消息参与率（0—1）",
        row.wake.participation,
        'type="number" min="0" max="1" step="0.01"',
      ) +
      input(
        "cooldownMs",
        "唤醒冷却（毫秒）",
        row.wake.cooldownMs,
        'type="number" min="0"',
      ) +
      check("paused", "保持角色暂停", row.paused) +
      check("mentions", "被 @ 时唤醒", row.wake.mentions) +
      check("names", "提到名字时唤醒", row.wake.names) +
      check("private", "私聊时唤醒", row.wake.private) +
      check("questions", "问句唤醒", row.wake.questions) +
      check("peers", "参与其他智能体对话", row.wake.peers) +
      `<div class="wide"><h3>允许的工具</h3><div class="tools">${tools.map((t) => check("tool:" + t, esc(t), row.tools.includes(t))).join("")}</div></div>` +
      area(
        "silence",
        "定时静默（JSON：start、end、days 0—6、timezone）",
        JSON.stringify(row.silence, null, 2),
      );
  } else if (type === "connections") {
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
      ]) +
      input("provider", "模型提供方（可选）", row.provider) +
      input("model", "默认模型（留空使用后端默认）", row.model) +
      input("effort", "默认思考强度", row.effort || "high") +
      input("baseUrl", "DSH 地址（空白自动发现）", row.baseUrl) +
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
        row = {
          ...row,
          name: get("name"),
          connectionId: get("connectionId"),
          backendId: get("backendId"),
          model: get("model"),
          effort: get("effort"),
          persona: get("persona"),
          appearance: get("appearance"),
          maxConsecutiveSends: Number(get("maxConsecutiveSends")),
          network: {
            ...row.network,
            autonomous: f.has("autonomousNetwork"),
            publicUrls: get("publicUrls")
              .split(/\r?\n/)
              .map((s) => s.trim())
              .filter(Boolean),
          },
          aliases: list("aliases"),
          ownerIds: list("ownerIds"),
          allow: { groups: list("groups"), users: list("users") },
          paused: f.has("paused"),
          wake: {
            ...row.wake,
            participation: Number(get("participation")),
            cooldownMs: Number(get("cooldownMs")),
            mentions: f.has("mentions"),
            names: f.has("names"),
            private: f.has("private"),
            questions: f.has("questions"),
            peers: f.has("peers"),
          },
          tools: [
            ...row.tools.filter((t) => f.has("tool:" + t)),
            ...tools.filter(
              (t) => !row.tools.includes(t) && f.has("tool:" + t),
            ),
          ],
          silence: JSON.parse(get("silence") || "[]"),
        };
      else if (editing.type === "connections")
        row = {
          id: row.id,
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
          id: row.id,
          label: get("label"),
          type: get("type"),
          provider: get("provider"),
          model: get("model"),
          effort: get("effort"),
          ...(get("baseUrl") ? { baseUrl: get("baseUrl") } : {}),
          preset: get("preset"),
          command: get("command"),
          toolServers: JSON.parse(get("toolServers") || "[]"),
        };
      if (editing.type === "agents") {
        delete row.enabled;
        delete row.toolServers;
        // Keep the compatibility alias unchanged when the displayed value was
        // not edited, so a participation save does not become a policy change.
        if (
          !Object.hasOwn(editing.row, "maxConsecutiveSends") &&
          row.maxConsecutiveSends === editing.row.maxSendsPerTurn
        )
          delete row.maxConsecutiveSends;
      }
      const index = next[editing.type].findIndex((x) => x.id === editing.id);
      if (index < 0) next[editing.type].push(row);
      else next[editing.type][index] = row;
    }
    const result = await api("/api/config", { config: next, revision }, "PUT");
    $("#editor").close();
    await load();
    notice(
      result.reconnectRequired
        ? "已保存。QQ 连接需要手动重新接入。"
        : "已保存并生效，现有 QQ 连接和回合保持不变。",
    );
  });
};
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
async function searchMemory(cursor = null) {
  await action(async () => {
    const q = new URLSearchParams({
      agentId: $("#memory-agent").value,
      query: $("#memory-query").value,
      type: $("#memory-type").value,
    });
    if (cursor) q.set("cursor", JSON.stringify(cursor));
    if ($("#memory-person").value) q.set("person", $("#memory-person").value);
    if ($("#memory-source").value)
      q.set("conversation", $("#memory-source").value);
    const result = await api("/api/memory?" + q);
    const rows = [...result.items, ...result.diaries];
    const node = $("#memory-results");
    node.className = "";
    node.innerHTML =
      rows
        .map(
          (r) =>
            `<article class="record"><div class="row"><strong>${esc(r.title || r.type)}</strong>${tag(r.origin)}</div><p>${esc(r.body)}</p><small>${esc(r.conversation || "个人日记")} · ${esc(r.senderId || "")} · ${esc(r.occurredAt || r.updatedAt)}</small> <button type="button" data-read="${esc(r.id)}">展开原文</button>${sceneMarkup(r.scene)}</article>`,
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
async function readMemory(id, offset = 0) {
  await action(async () => {
    const r = await api(
      "/api/memory/read?" +
        new URLSearchParams({ agentId: $("#memory-agent").value, id, offset }),
    );
    editing = { type: "read" };
    $("#edit-title").textContent = "记录详情";
    $("#edit-fields").innerHTML =
      `<pre class="mono">${esc(r.chunk)}</pre>${r.nextOffset !== null ? '<button type="button" id="next-chunk">继续展开</button>' : ""}`;
    if (r.nextOffset !== null)
      $("#next-chunk").onclick = () => readMemory(id, r.nextOffset);
    $("#edit-form footer").hidden = true;
    if (!$("#editor").open) $("#editor").showModal();
  });
}
$("#editor").addEventListener(
  "close",
  () => ($("#edit-form footer").hidden = false),
);
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
  if (config && tab === "overview" && !$("#editor").open)
    action(async () => {
      status = await api("/api/status");
      render();
    });
}, 5000);
