let mindAgentId;
const mindTime = (value) => (value ? new Date(value).toLocaleString() : "—");
// "22:59" today, "10/30 08:05" on another day: short enough for a summary.
const mindClock = (value) => {
  if (!value) return "—";
  const d = new Date(value),
    time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString()
    ? time
    : `${d.getMonth() + 1}/${d.getDate()} ${time}`;
};
// A row's time: short on the row, in full on hover.
const mindAt = (value) =>
  `<time title="${esc(mindTime(value))}">${esc(mindClock(value))}</time>`;
// The pages' folded sections; on a phone their state wraps under the title
// instead of being cut.
const mindFold = (id, title, body, options) =>
  fold(id, title, body, { ...options, cls: "mind-fold" });
// Long text keeps to a few lines; hovering shows all of it, and a tap (focus)
// opens it in place on touch screens.
const mindClip = (text, lines = 2, html = esc(text)) =>
  `<p class="mind-clip lines-${lines}" tabindex="0" title="${esc(text)}">${html}</p>`;
// One state as a coloured tag: is-ok done, is-wait in progress, is-off
// ended without effect, is-bad needs a look.
const mindTag = (text, tone = "") =>
  `<span class="mind-tag${tone ? " is-" + tone : ""}">${esc(text)}</span>`;
const subjectCheckStates = {
  inactive: "运行未启用",
  disabled: "自主思考未开启",
  paused: "已暂停",
  offline: "等待 QQ 连接恢复",
  silenced: "勿扰期间暂停检查",
  recovering: "后端恢复中",
  running: "正在思考",
  "budget-exhausted": "检查额度已用完",
  waiting: "等待下次检查",
  due: "已到时间，等待执行",
};
const subjectTurnStates = {
  "completed-no-send": "已完成（无 QQ 发送）",
  sent: "已完成（有 QQ 投递）",
  failed: "思考失败",
  cancelled: "已取消",
  interrupted: "运行被中断",
  running: "正在思考",
};
const subjectDid = {
  browsed: "浏览",
  searched: "搜索",
  read: "阅读",
  wrote: "写作",
  reviewed: "回顾",
  "reached-out": "联系",
  rested: "休息",
};
const restReasons = {
  recent: "刚做过",
  "no-interest": "暂时没兴趣",
  budget: "额度用完",
  quiet: "安静时段",
};
// Tools read as what they do, named where the role form lists them; the raw
// name stays in the tooltip.
const toolLabel = (name) =>
  (typeof agentForm === "undefined" ? [] : agentForm.groups).find((g) =>
    Object.hasOwn(g.tools, name),
  )?.tools[name] || name;
// A turn's tool calls in one line, "工具 6 次", with a chip per tool inside;
// failures come first and are counted in red on the line itself. Writing the
// log is how a turn ends, not work, so subject_log shows only when it failed.
function toolCallsMarkup(calls) {
  if (!Array.isArray(calls))
    return '<p class="mind-tools is-none">工具调用未记录（升级前的回合）</p>';
  const shown = calls.filter((c) => c.name !== "subject_log" || !c.ok);
  if (!shown.length) return '<p class="mind-tools is-none">没有调用工具</p>';
  const tools = new Map();
  for (const c of shown) {
    const key = c.name + (c.ok ? "" : "\n");
    if (!tools.has(key)) tools.set(key, { name: c.name, ok: !!c.ok, n: 0 });
    tools.get(key).n++;
  }
  const failed = shown.filter((c) => !c.ok).length,
    chips = [...tools.values()]
      .sort((x, y) => x.ok - y.ok)
      .map(
        (x) =>
          `<span class="mind-chip${x.ok ? "" : " is-failed"}" title="${esc(x.name)} · ${x.ok ? "" : "失败 "}${x.n} 次">${esc(toolLabel(x.name))}${x.ok ? "" : " 失败"}${x.n > 1 ? `<b>×${x.n}</b>` : ""}</span>`,
      )
      .join("");
  return `<details class="mind-tools"><summary>工具 ${shown.length} 次${failed ? `<span class="mind-failed">${failed} 次失败</span>` : ""}</summary><div class="mind-chips">${chips}</div></details>`;
}
// The turn a log was written in: its time falls inside the turn.
const subjectTurnOf = (turns, at) => {
  const t = Date.parse(at);
  return turns.find((x) => x.startedAt <= t && t <= (x.endedAt ?? Infinity));
};
const subjectDidTone = { "reached-out": "ok", rested: "off" };
function subjectLogMarkup(subject) {
  const s = subject.stats24h || {},
    turns = subject.turns || [];
  const header = `<p class="mind-lead">最近 24 小时：空闲时间 ${s.turns || 0} 次，其中有实际行动 ${s.active || 0} 次，留下日志 ${s.logged || 0} 次，共调用工具 ${s.toolCalls || 0} 次${s.traced < s.turns ? `（${s.turns - s.traced} 次为升级前回合，未记录工具调用）` : ""}。</p>`;
  const items = (subject.logs || [])
    .map((l) => {
      const turn = subjectTurnOf(turns, l.at);
      return `<article class="mind-row"><div class="mind-row-head">${mindTag(subjectDid[l.did] || l.did, subjectDidTone[l.did] || "wait")}${l.restReason ? `<span class="mind-sub">${esc(restReasons[l.restReason] || l.restReason)}</span>` : ""}${l.protected ? mindTag("含受保护资料", "warn") : ""}${mindAt(l.at)}</div>${mindClip(l.summary, 3)}${l.found.length ? mindClip("发现：" + l.found.join("；"), 1) : ""}${l.next ? mindClip("下次想做：" + l.next, 1) : ""}${turn ? toolCallsMarkup(turn.toolCalls) : ""}</article>`;
    })
    .join("");
  return mindFold(
    "subject-log",
    "空闲时间日志",
    `${header}${items ? `<div class="mind-list">${items}</div>` : '<p class="hint">还没有日志。升级后，每次空闲时间结束都会在这里记一笔。</p>'}`,
    {
      open: true,
      summary: esc(
        [
          `24 小时内 ${s.turns || 0} 次`,
          `有行动 ${s.active || 0} 次`,
          subject.logs?.length
            ? `最近一条 ${mindClock(subject.logs[0].at)}`
            : "还没有日志",
        ].join(" · "),
      ),
    },
  );
}
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
const mindTones = {
  completed: "ok",
  accepted: "ok",
  sent: "ok",
  "completed-no-send": "",
  cancelled: "off",
  expired: "off",
  rejected: "off",
  withdrawn: "off",
  interrupted: "off",
  failed: "bad",
  unknown: "bad",
};
const mindState = (status, labels = mindStates) =>
  mindTag(labels[status] || status, mindTones[status] ?? "wait");
function mindEvidence(proof) {
  if (!proof || proof.status !== "frozen")
    return '<p class="hint">历史依据未冻结版本；不以当前日记替代，旧候选需重新提出。</p>';
  return `<details><summary>冻结依据 · ${mindTime(proof.capturedAt)} · ${proof.roots.length} 个去重来源</summary>${proof.references
    .map((ref) => {
      const available = proof.availability?.find((row) => row.id === ref.id);
      return `<article class="record"><p class="mono">${esc(ref.id)}${ref.revision ? ` · 日记 v${ref.revision}` : ""}</p><p>${available?.available === false ? "原记录已不可用，以下为冻结摘录" : available?.changed ? `当前已修订为 v${available.currentRevision}，以下仍为提出时依据` : "提出时依据"}</p><pre>${esc(ref.excerpt)}${ref.excerptTruncated ? "\n［摘录已截断］" : ""}</pre><p class="hint">${esc(ref.metadata?.readingScope || ref.metadata?.epistemic || ref.metadata?.kind || "")} · 父引用 ${esc(ref.parents.join(", ") || "无")}</p><p class="mono">摘要校验 ${esc(ref.digest)}</p></article>`;
    })
    .join("")}</details>`;
}
// The role's inner life, one job per tab. Every tab reads /api/mind and
// renders and wires only its own blocks.
const MIND_TABS = ["mind", "mood", "people", "subject", "intents", "sessions"];
const selfActors = {
  "initial-template": "初始模板",
  administrator: "管理员",
  "subject-review": "空闲时间回顾",
};
const selfActor = (actor) => selfActors[actor] || actor;
const selfScopes = { interest: "兴趣", habit: "习惯", relationship: "关系" };
// Candidates still waiting for the free-time review.
const SELF_OPEN = ["pending", "observing"];
function selfMarkup(a, data) {
  const current = data.current,
    anchors = data.anchors || {},
    open = data.candidates.filter((c) => SELF_OPEN.includes(c.status)).length,
    templates = data.history.filter((v) => v.template !== undefined);
  const histories = data.history
    .map((v, index) => {
      const before = data.history[index + 1]?.body || "",
        oldLines = new Set(before.split("\n")),
        newLines = new Set(v.body.split("\n"));
      const removed = [...oldLines].filter((l) => !newLines.has(l)).join("\n"),
        added = [...newLines].filter((l) => !oldLines.has(l)).join("\n");
      return `<details class="record"><summary><span class="mind-summary-main">v${v.version} · ${esc(selfActor(v.actor))} · ${mindClock(v.at)} · ${esc(v.reason)}</span>${v.version === current.version ? mindTag("当前", "ok") : ""}</summary>${mindClip(v.reason, 2)}<pre>${esc(v.body)}</pre><p>较前一版删除</p><pre>${esc(removed || "无")}</pre><p>较前一版新增</p><pre>${esc(added || "无")}</pre><p class="mono">来源：${esc((v.evidence || []).join(", ") || "无")}</p>${mindEvidence(v.evidenceSnapshot)}${v.version !== current.version ? `<button data-restore="${v.version}">恢复为新版本</button>` : ""}</details>`;
    })
    .join("");
  const candidates = data.candidates
    .map(
      (c) =>
        `<details class="record"><summary><span class="mind-summary-main">${esc(selfScopes[c.scope] || c.scope)} · ${esc(c.body)}</span>${mindState(c.status)}</summary><pre>${esc(c.body)}</pre><p>${esc(c.reason)}</p><p class="mind-meta">基于 v${c.baseVersion} · 提出于 ${esc(conversationLabel(c.conversation))}</p><p>最早回顾：${mindTime(c.reviewAfter)}</p><p class="mono">来源：${esc(c.evidence.join(", "))}<br>反例：${esc(c.counterEvidence.join(", "))}</p>${mindEvidence(c.evidenceSnapshot)}${c.counterEvidence.length ? mindEvidence(c.counterEvidenceSnapshot) : ""}${c.reviews.map((r) => `<p>${esc(r.action)} · ${esc(r.reason)} · ${mindTime(r.at)}</p>`).join("")}</details>`,
    )
    .join("");
  const appearance =
    anchors.appearance ||
    (anchors.requiresMigration
      ? "请在角色设置中确认原有外形；确认前保留初始 self，禁止替换。"
      : "未设置固定外形");
  return `<section class="card self-card"><div class="row"><h2>当前 self · v${current.version}</h2><button type="button" id="self-edit">修改</button></div><p class="self-meta"><span>${esc(selfActor(current.actor))} · ${mindTime(current.at)}</span>${current.reason ? `<span class="self-reason" title="${esc(current.reason)}">${esc(current.reason)}</span>` : ""}</p><div id="self-view" class="self-view">${esc(current.body)}</div><button type="button" id="self-more" class="self-more" hidden>显示全部</button><form id="self-form" hidden><label class="wide">当前自我<textarea id="self-body" name="body">${esc(current.body)}</textarea></label>${input("reason", "管理员修改理由", "", "required")}<div class="card-actions"><button class="primary">保存新版本</button><button type="button" id="self-cancel">取消</button></div><p class="hint">下一回合生效；运行中的回合保持原版本。版本冲突会拒绝覆盖。</p></form></section>
  ${mindFold("self-candidates", "候选与回顾", candidates ? `<div class="mind-details">${candidates}</div>` : '<p class="hint">没有候选。普通聊天提出候选，空闲时间统一回顾。</p>', { summary: open ? `<span class="mind-attn">${open} 个候选待回顾</span>${data.candidates.length > open ? ` · 共 ${data.candidates.length} 个` : ""}` : data.candidates.length ? `没有待回顾的 · 共 ${data.candidates.length} 个` : "没有候选" })}
  ${mindFold("self-history", "版本历史与差异", `<div class="mind-details">${histories}</div>`, { summary: esc(`共 ${data.history.length} 个版本 · 当前 v${current.version} · ${mindClock(current.at)} ${selfActor(current.actor)}`) })}
  ${mindFold("self-anchors", "身份锚点", `<p>${esc(a.name)} · ${esc(a.id)}</p><p>${esc(appearance)}</p><p class="hint">名字、外形、账号与管理权限来自配置；性格与相处方式通过上方 self 发展。</p>`, { open: !!anchors.requiresMigration, summary: anchors.requiresMigration ? '<span class="mind-attn">需要确认原有外形</span>' : esc(`${a.name} · ${anchors.appearance ? "已设定外形" : "未设置固定外形"}`) })}
  ${templates.length ? mindFold("self-template", "初始化模板", templates.map((v) => `<p class="hint">v${v.version} 建立 self 时使用</p><pre>${esc(v.template || "（空）")}</pre>`).join(""), { summary: esc(templates.map((v) => `v${v.version} · ${mindClock(v.at)}`).join("、")) }) : ""}`;
}
// Free time reads in the order it is used: the log first, then how checks
// stand, then the settings. Both of the latter fold, their state on the
// title line.
function subjectMarkup(a, data) {
  return `${subjectLogMarkup(data.subject)}${subjectStatusMarkup(data.subject)}${subjectFormMarkup(a)}`;
}
function subjectStatusMarkup(subject) {
  const checkStatus = subject.checkStatus,
    contacts = (subject.contacts || []).filter(
      (t) => t > Date.now() - 86400000,
    ).length,
    stat = (label, value, hint = "") =>
      `<div class="mind-stat"><span>${label}</span><b>${value}</b>${hint ? `<small>${hint}</small>` : ""}</div>`;
  const turns = (subject.turns || [])
    .map(
      (t) =>
        `<article class="mind-row"><div class="mind-row-head">${mindState(t.status, subjectTurnStates)}<span class="mind-sub">self v${t.selfVersion}</span>${mindAt(t.startedAt)}</div>${toolCallsMarkup(t.toolCalls)}</article>`,
    )
    .join("");
  const summary = [
    subjectCheckStates[checkStatus.state] || checkStatus.state,
    `24 小时内 ${checkStatus.used}/${checkStatus.limit} 次`,
    checkStatus.nextEligibleAt
      ? `下次最早 ${mindClock(checkStatus.nextEligibleAt)}`
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return mindFold(
    "subject-quota",
    "检查状态与额度",
    `<div class="mind-stats">${stat("24 小时检查", `${checkStatus.used} / ${checkStatus.limit}`, `剩余 ${checkStatus.remaining} 次`)}${stat("主动联系", contacts, "最近 24 小时")}${stat("待检查来信", subject.pendingActivities || 0)}${stat("最近机会", subject.lastOpportunityAt ? mindClock(subject.lastOpportunityAt) : "—")}</div><p>${esc(subjectCheckStates[checkStatus.state] || checkStatus.state)} · ${checkStatus.nextEligibleAt ? `下次最早可检查：${mindTime(checkStatus.nextEligibleAt)}（需保持启用及连接条件）` : "恢复上述运行条件后重新计算下次检查时间。"}</p><p class="hint">检查额度按滚动 24 小时计算，午夜不清零。完成但未发送 QQ 也属于已运行的思考。</p><h3 class="mind-subhead">最近 ${(subject.turns || []).length} 次回合</h3>${turns ? `<div class="mind-list">${turns}</div>` : '<p class="hint">尚无空闲时间回合记录；条件检查不等于模型回合完成。</p>'}`,
    { summary: esc(summary) },
  );
}
function subjectFormMarkup(a) {
  const p = a.subject,
    enabled = p.enabled || a.behavior.proactive.enabled;
  const summary = [
    enabled ? "已启用" : "未启用",
    `${p.groups.length} 个群`,
    p.users.length ? `${p.users.length} 个私聊` : "",
    `每天最多联系 ${p.maxContactsPerDay} 次`,
  ]
    .filter(Boolean)
    .join(" · ");
  return mindFold(
    "subject-settings",
    "空闲时间设置与联系范围",
    `<form id="subject-form"><div class="form-grid">${check("enabled", "启用主体空闲思考", enabled)}${check("owners", "允许主动联系主人", p.owners)}${check("peers", "允许主动联系同伴角色", p.peers)}${ids("groups", "明确启用的群", p.groups, { kind: "group" })}${ids("users", "额外启用的私聊", p.users, { kind: "person", hint: "联系范围还受回复白名单约束。" })}</div><div class="form-grid">${input("interval", "检查间隔（分钟）", p.intervalMs / 60000, 'type="number" min="1" required')}${input("checks", "24 小时检查上限", p.maxChecksPerDay, 'type="number" min="1" required')}${input("contacts", "24 小时主动联系上限", p.maxContactsPerDay, 'type="number" min="1" required')}${range("toolCalls", "每次空闲时间最多调用工具数", p.maxToolCallsPerTurn ?? 8, { min: 1, max: 30, step: 1, unit: " 个" })}${input("cooldown", "联系冷却（分钟）", p.contactCooldownMs / 60000, 'type="number" min="1" required')}${input("unanswered", "未回应冷却（小时）", p.unansweredCooldownMs / 3600000, 'type="number" min="1" required')}</div>${advanced("离线与勿扰时", `${check("offlineReview", "离线时允许内部回顾", p.offlineReview)}${check("reviewInSilence", "勿扰期间允许内部回顾", p.reviewInSilence)}`)}<p class="hint">全局暂停会阻止模型检查；每次空闲时间结束，主体会用日志记下做了什么或为什么休息。仅修改检查间隔和次数会立即生效，保留连接与当前回合；修改权限或联系范围会结束该角色当前的回合，QQ 连接不受影响。</p><button class="primary">保存空闲时间设置</button></form>`,
    { summary: esc(summary) },
  );
}
// A private target with a person card is named by its call and opens the
// card; group targets and people without a card show as "群 …" / "私聊 …".
function intentTarget(target, cards) {
  const [kind, id] = String(target).split(":"),
    card = kind === "private" && cards.find((c) => c.personId === id);
  return card
    ? `${esc(conversationLabel(target))}（${personCallText(card.call)}）${personCardButton(id)}`
    : esc(conversationLabel(String(target)));
}
// The page's list under a title line that counts it; what the page is for
// sits below the list.
const mindPage = (title, count, list, empty, foot) =>
  `<section class="card mind-card"><div class="mind-head"><h2>${title}</h2>${count ? `<span class="mind-count">${esc(count)}</span>` : ""}</div>${list ? `<div class="mind-list">${list}</div>` : `<p class="hint">${empty}</p>`}<p class="hint mind-foot">${foot}</p></section>`;
const INTENT_DONE = ["completed", "cancelled", "expired", "failed", "unknown"];
function intentsMarkup(data) {
  const cards = data.personCards || [],
    live = data.intents.filter((i) => !INTENT_DONE.includes(i.status)).length;
  const rows = data.intents
    .map(
      (i) =>
        `<article class="mind-row"><div class="mind-row-head"><strong class="mind-title" title="${esc(i.topic)}">${esc(i.topic)}</strong>${mindState(i.status)}</div>${mindClip(`${conversationLabel(i.target)} · ${i.reason}`, 2, `${intentTarget(i.target, cards)} · ${esc(i.reason)}`)}<p class="mind-meta">有效期至 ${mindClock(i.expiresAt)}${i.sentAt ? ` · 已确认发送 ${mindClock(i.sentAt)}` : ""}</p><details class="mind-more"><summary>来源与经过 · ${i.history.length} 步</summary><p class="mono">来源：${esc(i.evidence.join(", ") || "无")}</p>${i.history.map((h) => `<p>${mindTime(h.at)} · ${esc(mindStates[h.status] || h.status)}${h.reason ? ` · ${esc(h.reason)}` : ""}</p>`).join("")}</details>${!INTENT_DONE.includes(i.status) ? `<div class="mind-actions"><button type="button" class="ghost" data-cancel-intent="${esc(i.id)}" data-revision="${i.revision}">取消意图</button></div>` : ""}</article>`,
    )
    .join("");
  return mindPage(
    "聊天意图与结果",
    data.intents.length ? `进行中 ${live} · 共 ${data.intents.length}` : "",
    rows,
    "没有意图。已考虑、已交接和已确认投递分别记录。",
    "空闲时间想主动找人时会留下意图，由目标聊天决定发送、暂缓或放弃。",
  );
}
const sessionStates = {
  active: "进行中",
  organizing: "整理上下文",
  retired: "已结束",
};
const sessionTones = { active: "ok", retired: "off" };
// Free time first, then the chats as the server lists them.
function sessionsMarkup(a, data) {
  const sessions = [...data.sessions].sort(
    (x, y) => (y.conversation === "@subject") - (x.conversation === "@subject"),
  );
  const rows = sessions
    .map((s) => {
      const status = s.lifecycle?.status,
        name =
          s.conversation === "@subject"
            ? "空闲时间"
            : conversationLabel(s.conversation),
        capacity = s.usage?.capacityTokens || a.contextPolicy.capacityTokens,
        share = s.usage ? Math.min(1, s.usage.contextTokens / capacity) : 0;
      return `<article class="mind-row"><div class="mind-row-head"><strong class="mind-title" title="${esc(s.conversation)}">${esc(name)}</strong>${mindTag(sessionStates[status] || status || "尚未初始化", status ? sessionTones[status] || "wait" : "off")}</div>${s.usage ? `<div class="mind-usage"><svg class="meter mind-bar${share > 0.8 ? " is-high" : ""}" viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true"><rect class="track" width="100" height="4" rx="2"/><rect class="bar" width="${(share * 100).toFixed(1)}" height="4" rx="2"/></svg><span>${s.usage.source === "measured" ? "后端实测" : "估算"} ${Number(s.usage.contextTokens).toLocaleString()} / ${Number(capacity).toLocaleString()} tokens · ${Math.round(share * 100)}%（另预留 ${Number(a.contextPolicy.reserveTokens).toLocaleString()}）</span></div>` : '<p class="mind-meta">用量尚不可用</p>'}<p class="mind-meta">self v${s.loadedSelfVersion || "—"} · 连续已见 ${s.seenThroughSeq || 0} · 已处理 ${s.readThroughSeq || 0}</p>${s.lifecycle?.reason ? mindClip("原因：" + s.lifecycle.reason, 1) : ""}<div class="mind-actions"><button type="button" class="ghost" data-reset-session="${esc(s.conversation)}" title="结束当前会话，下次再初始化">结束当前会话</button></div></article>`;
    })
    .join("");
  return mindPage(
    "工作会话",
    sessions.length ? `共 ${sessions.length} 个` : "",
    rows,
    "还没有工作会话。",
    "每个聊天和空闲时间各有一个模型会话；结束后下一回合重新初始化，聊天记录和记忆都保留。",
  );
}
function bindSelf(a, current) {
  // Self is read in full by default; 修改 swaps in a textarea that grows
  // with its content. 取消 resets the form, discarding unsaved edits.
  const selfView = $("#self-view"),
    selfMore = $("#self-more"),
    selfForm = $("#self-form"),
    selfBody = $("#self-body"),
    selfEdit = $("#self-edit"),
    growSelf = () => {
      selfBody.style.height = "auto";
      selfBody.style.height = selfBody.scrollHeight + 2 + "px";
    },
    setSelfEditing = (editing) => {
      selfForm.hidden = !editing;
      selfView.hidden = editing;
      selfEdit.hidden = editing;
      selfMore.hidden = editing || !selfView.dataset.long;
    };
  if (selfView.scrollHeight > 720) {
    selfView.dataset.long = "1";
    selfView.classList.add("collapsed");
    selfMore.hidden = false;
  }
  selfMore.onclick = () => {
    const collapsed = selfView.classList.toggle("collapsed");
    selfMore.textContent = collapsed ? "显示全部" : "收起";
    if (collapsed) selfView.scrollIntoView({ block: "nearest" });
  };
  selfEdit.onclick = () => {
    setSelfEditing(true);
    growSelf();
    selfBody.setSelectionRange(0, 0);
    selfBody.focus({ preventScroll: true });
  };
  selfBody.oninput = growSelf;
  $("#self-cancel").onclick = () => {
    selfForm.reset();
    setSelfEditing(false);
    selfView.scrollIntoView({ block: "nearest" });
  };
  selfForm.onsubmit = (e) => {
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
}
function bindSubject(a) {
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
        maxToolCallsPerTurn: Number(f.get("toolCalls")),
        maxContactsPerDay: Number(f.get("contacts")),
        contactCooldownMs: Number(f.get("cooldown")) * 60000,
        unansweredCooldownMs: Number(f.get("unanswered")) * 3600000,
        groups: list("groups"),
        users: list("users"),
      });
      agent.behavior.proactive.enabled = false;
      const result = await api(
        "/api/config",
        { config: next, revision },
        "PUT",
      );
      await load();
      notice(
        result.reconnectRequired
          ? "空闲时间设置已保存，请按需手动连接"
          : "空闲时间设置已生效，连接与当前回合保持；到期后按新额度检查",
      );
    });
  };
}
function bindIntents(a) {
  bindPersonCards(document, a.id);
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
}
function bindSessions(a) {
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
}
async function renderMind() {
  const view = MIND_TABS.includes(tab) ? tab : "mind";
  if (!config.agents.some((a) => a.id === mindAgentId))
    mindAgentId = config.agents[0]?.id;
  const a = config.agents.find((a) => a.id === mindAgentId);
  if (!a) {
    $("#content").textContent = "请先添加角色。";
    return;
  }
  $("#content").innerHTML =
    `<div class="toolbar mind-toolbar"><label>角色<select id="mind-agent">${config.agents.map((x) => `<option value="${esc(x.id)}" ${x.id === a.id ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select></label><button type="button" class="ghost" id="mind-refresh">刷新</button></div><div id="mind-body">正在读取…</div>`;
  $("#mind-agent").onchange = (e) => {
    mindAgentId = e.target.value;
    action(renderMind);
  };
  $("#mind-refresh").onclick = () => action(renderMind);
  const data = await api("/api/mind?" + new URLSearchParams({ agentId: a.id }));
  if (tab !== view || a.id !== mindAgentId) return;
  const now = Date.now(),
    body = $("#mind-body");
  if (view === "mind") {
    body.innerHTML = selfMarkup(a, data);
    bindSelf(a, data.current);
  } else if (view === "mood") {
    body.innerHTML = moodMarkup(data.mood, now);
    bindMood(data.mood, now, a.id);
  } else if (view === "people") {
    body.innerHTML = peopleMarkup(data.personCards);
    bindPeople(data.personCards, a.id);
  } else if (view === "subject") {
    body.innerHTML = subjectMarkup(a, data);
    bindSubject(a);
    fillIds(body, a.id);
  } else if (view === "intents") {
    body.innerHTML = intentsMarkup(data);
    bindIntents(a);
  } else {
    body.innerHTML = sessionsMarkup(a, data);
    bindSessions(a);
  }
}
