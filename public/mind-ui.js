let mindAgentId;
const mindTime = (value) => (value ? new Date(value).toLocaleString() : "—");
const mindStates = {
  waiting: "等待机会",
  deferred: "已暂缓",
  handedoff: "已交接",
  selected: "目标决定发言",
  "awaiting-response": "已投递 · 等回应",
  completed: "已完成",
  cancelled: "已取消",
  expired: "已过期",
  failed: "失败",
  unknown: "发送未知",
  pending: "待回顾",
  observing: "继续观察",
  accepted: "已采纳",
  rejected: "已放弃",
  withdrawn: "已撤回",
};
async function renderMind() {
  if (!config.agents.some((a) => a.id === mindAgentId))
    mindAgentId = config.agents[0]?.id;
  const a = config.agents.find((a) => a.id === mindAgentId);
  if (!a) {
    $("#content").textContent = "请先添加机器人。";
    return;
  }
  $("#content").innerHTML =
    `<div class="card toolbar"><label>机器人<select id="mind-agent">${config.agents.map((x) => `<option value="${esc(x.id)}" ${x.id === a.id ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select></label><button id="mind-refresh">刷新</button></div><div id="mind-body">正在读取…</div>`;
  $("#mind-agent").onchange = (e) => {
    mindAgentId = e.target.value;
    action(renderMind);
  };
  $("#mind-refresh").onclick = () => action(renderMind);
  const data = await api("/api/mind?" + new URLSearchParams({ agentId: a.id }));
  if (tab !== "mind" || a.id !== mindAgentId) return;
  const current = data.current,
    p = a.subject;
  const histories = data.history
    .map((v, index) => {
      const before = data.history[index + 1]?.body || "",
        oldLines = new Set(before.split("\n")),
        newLines = new Set(v.body.split("\n"));
      const removed = [...oldLines].filter((l) => !newLines.has(l)).join("\n"),
        added = [...newLines].filter((l) => !oldLines.has(l)).join("\n");
      return `<details class="record"><summary>v${v.version} · ${esc(v.actor)} · ${mindTime(v.at)}</summary><p>${esc(v.reason)}</p><pre>${esc(v.body)}</pre><p>较前一版删除</p><pre>${esc(removed || "无")}</pre><p>较前一版新增</p><pre>${esc(added || "无")}</pre><p class="mono">来源：${esc((v.evidence || []).join(", ") || "无")}</p>${v.template !== undefined ? `<details><summary>初始化模板</summary><pre>${esc(v.template)}</pre></details>` : ""}${v.version !== current.version ? `<button data-restore="${v.version}">恢复为新版本</button>` : ""}</details>`;
    })
    .join("");
  $("#mind-body").innerHTML =
    `<section class="card"><h2>身份锚点</h2><p>${esc(a.name)} · ${esc(a.id)}</p><p>${esc(a.appearance || "沿用初始化模板中的外形")}</p><p class="hint">名字、外形、账号与管理权限来自配置；性格与相处方式通过下方 self 发展。</p></section>
  <form id="self-form" class="card"><h2>当前 self · v${current.version}</h2>${area("body", "当前自我", current.body)}${input("reason", "管理员修改理由", "", "required")}<button class="primary">保存新版本</button><p class="hint">下一回合生效；运行中的回合保持原版本。版本冲突会拒绝覆盖。</p></form>
  <section class="card"><h2>候选与回顾</h2>${data.candidates.map((c) => `<details class="record"><summary>${esc(mindStates[c.status] || c.status)} · ${esc(c.scope)} · 基于 v${c.baseVersion}</summary><pre>${esc(c.body)}</pre><p>${esc(c.reason)}</p><p>最早回顾：${mindTime(c.reviewAfter)} · ${esc(c.conversation)}</p><p class="mono">来源：${esc(c.evidence.join(", "))}<br>反例：${esc(c.counterEvidence.join(", "))}</p>${c.reviews.map((r) => `<p>${esc(r.action)} · ${esc(r.reason)} · ${mindTime(r.at)}</p>`).join("")}</details>`).join("") || '<p class="hint">没有候选。普通聊天提出候选，主体统一回顾。</p>'}</section>
  <section class="card"><h2>版本历史与差异</h2>${histories}</section>
  <form class="card" id="subject-form"><h2>主体机会与联系范围</h2><div class="form-grid">${check("enabled", "启用主体空闲思考", p.enabled || a.behavior.proactive.enabled)}${check("owners", "允许主动联系主人", p.owners)}${check("peers", "允许主动联系同伴机器人", p.peers)}${check("offlineReview", "离线时允许内部回顾", p.offlineReview)}${check("reviewInSilence", "勿扰期间允许内部回顾", p.reviewInSilence)}${input("interval", "检查间隔（分钟）", p.intervalMs / 60000, 'type="number" min="1" required')}${input("checks", "24 小时检查上限", p.maxChecksPerDay, 'type="number" min="1" required')}${input("contacts", "24 小时主动联系上限", p.maxContactsPerDay, 'type="number" min="1" required')}${input("cooldown", "联系冷却（分钟）", p.contactCooldownMs / 60000, 'type="number" min="1" required')}${input("unanswered", "未回应冷却（小时）", p.unansweredCooldownMs / 3600000, 'type="number" min="1" required')}${input("groups", "明确启用的群（逗号分隔）", p.groups.join(","))}${input("users", "额外启用的私聊（逗号分隔）", p.users.join(","))}</div><p class="hint">联系范围还受回复白名单约束。全局暂停会阻止模型检查；主体可以不行动。保存设置会中止本角色回合，连接需手动恢复。</p><button>保存主体设置</button></form>
  <section class="card"><h2>机会与决策</h2><p>最近机会：${mindTime(data.subject.lastOpportunityAt)} · 下次条件检查：${mindTime(data.subject.nextCheckAt)}</p><p>最近 24 小时检查 ${(data.subject.checks || []).filter((t) => t > Date.now() - 86400000).length} 次；主动联系 ${(data.subject.contacts || []).filter((t) => t > Date.now() - 86400000).length} 次</p>${
    data.turns
      .filter((t) => t.conversation === "@subject")
      .slice(0, 10)
      .map(
        (t) =>
          `<p>${mindTime(t.startedAt)} · self v${t.selfVersion} · ${esc(t.status)}</p>`,
      )
      .join("") || '<p class="hint">尚未思考；程序检查条件不等于调用模型。</p>'
  }</section>
  <section class="card"><h2>聊天意图与结果</h2>${data.intents.map((i) => `<details class="record"><summary>${esc(i.topic)} · ${esc(mindStates[i.status] || i.status)}</summary><p>${esc(i.target)} · ${esc(i.reason)}</p><p>有效期至 ${mindTime(i.expiresAt)} · 已确认发送 ${mindTime(i.sentAt)}</p><p class="mono">来源：${esc(i.evidence.join(", "))}</p>${i.history.map((h) => `<p>${mindTime(h.at)} · ${esc(mindStates[h.status] || h.status)} · ${esc(h.reason || "")}</p>`).join("")}${!["completed", "cancelled", "expired", "failed", "unknown"].includes(i.status) ? `<button data-cancel-intent="${esc(i.id)}" data-revision="${i.revision}">取消意图</button>` : ""}</details>`).join("") || '<p class="hint">没有意图。已考虑、已交接和已确认投递分别记录。</p>'}</section>
  <section class="card"><h2>工作会话</h2>${data.sessions.map((s) => `<article class="record"><strong>${esc(s.conversation === "@subject" ? "主体思考" : s.conversation)}</strong><p>self v${s.loadedSelfVersion || "—"} · ${esc(s.lifecycle?.status || "尚未初始化")} · ${esc(s.lifecycle?.reason || "")}</p><p>${s.usage ? `${s.usage.source === "measured" ? "后端实测" : "估算"} ${s.usage.contextTokens} / ${s.usage.capacityTokens || a.contextPolicy.capacityTokens} tokens（另预留 ${a.contextPolicy.reserveTokens}）` : "用量尚不可用"}</p><p>连续已见 ${s.seenThroughSeq || 0} · 已处理 ${s.readThroughSeq || 0}</p><button data-reset-session="${esc(s.conversation)}">结束当前会话，下次再初始化</button></article>`).join("")}</section>`;
  $("#self-form").onsubmit = (e) => {
    e.preventDefault();
    action(async () => {
      const f = new FormData(e.target);
      await api("/api/self", {
        agentId: a.id,
        action: "edit",
        expectedVersion: current.version,
        body: f.get("body"),
        reason: f.get("reason"),
      });
      await renderMind();
      notice("新 self 已保存");
    });
  };
  document.querySelectorAll("[data-restore]").forEach(
    (b) =>
      (b.onclick = () =>
        action(async () => {
          await api("/api/self", {
            agentId: a.id,
            action: "restore",
            version: Number(b.dataset.restore),
            expectedVersion: current.version,
            reason: `管理台恢复 v${b.dataset.restore}`,
          });
          await renderMind();
        })),
  );
  document.querySelectorAll("[data-cancel-intent]").forEach(
    (b) =>
      (b.onclick = () =>
        action(async () => {
          await api("/api/intent/cancel", {
            agentId: a.id,
            id: b.dataset.cancelIntent,
            expectedRevision: Number(b.dataset.revision),
          });
          await renderMind();
        })),
  );
  document.querySelectorAll("[data-reset-session]").forEach(
    (b) =>
      (b.onclick = () =>
        action(async () => {
          await api("/api/session/reset", {
            agentId: a.id,
            conversation: b.dataset.resetSession,
          });
          await renderMind();
        })),
  );
  $("#subject-form").onsubmit = (e) => {
    e.preventDefault();
    action(async () => {
      const f = new FormData(e.target),
        next = structuredClone(config),
        agent = next.agents.find((x) => x.id === a.id),
        list = (k) =>
          String(f.get(k))
            .split(/[,，\s]+/)
            .filter(Boolean);
      Object.assign(agent.subject, {
        enabled: f.has("enabled"),
        owners: f.has("owners"),
        peers: f.has("peers"),
        offlineReview: f.has("offlineReview"),
        reviewInSilence: f.has("reviewInSilence"),
        intervalMs: Number(f.get("interval")) * 60000,
        maxChecksPerDay: Number(f.get("checks")),
        maxContactsPerDay: Number(f.get("contacts")),
        contactCooldownMs: Number(f.get("cooldown")) * 60000,
        unansweredCooldownMs: Number(f.get("unanswered")) * 3600000,
        groups: list("groups"),
        users: list("users"),
      });
      agent.behavior.proactive.enabled = false;
      await api("/api/config", { config: next, revision }, "PUT");
      await load();
      notice("主体设置已保存，请按需手动连接");
    });
  };
}
