let parityAgentId,
  parityTasks = [],
  parityEditing = null,
  voiceObjectUrl;
const scheduleLabels = {
  once: "一次性",
  daily: "每天",
  weekly: "每周",
  workdays: "工作日",
  monthly: "每月几号",
  monthlyWeekday: "每月第几个星期几",
  yearly: "每年",
  dates: "特殊日期",
  everyNDays: "每隔 N 天",
  interval: "每隔 N 分钟",
  dailyRandom: "每天随机",
  monthlyRandom: "每月随机",
  cron: "高级 cron",
};
const parityOptions = (rows, value) =>
  rows
    .map(
      ([id, label]) =>
        `<option value="${esc(id)}" ${id === value ? "selected" : ""}>${esc(label)}</option>`,
    )
    .join("");
const parityNumber = (name, label, value, min = 0, step = 1) =>
  `<label>${esc(label)}<input name="${name}" type="number" min="${min}" step="${step}" value="${esc(value)}" required></label>`;
const parityOptionalNumber = (name, label, value) =>
  `<label>${esc(label)}<input name="${name}" type="number" min="1" step="1" value="${esc(value ?? "")}" placeholder="留空不额外限制"></label>`;
const parityField = (
  name,
  label,
  value = "",
  type = "text",
  placeholder = "",
) =>
  `<label>${esc(label)}<input name="${name}" type="${type}" value="${esc(value)}"${placeholder ? ` placeholder="${esc(placeholder)}"` : ""}></label>`;
const parityCheck = (name, label, value) =>
  `<label class="check"><input name="${name}" type="checkbox" ${value ? "checked" : ""}>${esc(label)}</label>`;
const parityTarget = (x) =>
  String(x)
    .replace(/^group:/, "群 ")
    .replace(/^private:/, "私聊 ");

// Words, dates and times as removable chips: the text cousin of ids() in
// app.js, with the same look. The hidden input sends the list the form always
// sent: comma-separated, or one "YYYY-MM-DD HH:mm" per line for "when".
const chipKinds = {
  text: {
    sep: ",",
    add: (hint) =>
      `<input type="text" maxlength="80" autocomplete="off" placeholder="${hint}">`,
  },
  date: { sep: ",", add: () => '<input type="date" aria-label="日期">' },
  time: { sep: ",", add: () => '<input type="time" aria-label="时刻">' },
  when: {
    sep: "\n",
    add: () =>
      '<input type="date" aria-label="日期"><input type="time" aria-label="时刻" value="09:00">',
  },
};
const chipsList = (values, kind = "text") => {
  const list = [
    ...new Set(
      (Array.isArray(values)
        ? values
        : String(values ?? "").split(kind === "when" ? /\r?\n/ : /[,，]/)
      )
        .map((x) => String(x).trim())
        .filter(Boolean),
    ),
  ];
  // Words keep the order they were added in; dates and times read in order.
  return kind === "text" ? list : list.sort();
};
const chipsChip = (value) =>
  `<span class="ids-chip" data-chip="${esc(value)}"><span class="ids-name" title="${esc(value)}">${esc(value)}</span><button type="button" class="ids-remove" data-chips-remove="${esc(value)}" aria-label="移除 ${esc(value)}">×</button></span>`;
function chips(
  key,
  label,
  values,
  { kind = "text", hint = "", placeholder = "" } = {},
) {
  const list = chipsList(values, kind);
  return `<div class="ids chips wide" data-chips="${kind}"><span class="ids-label">${esc(label)}</span><input type="hidden" name="${key}" value="${esc(list.join(chipKinds[kind].sep))}"><div class="ids-chips">${list.map(chipsChip).join("") || '<span class="ids-empty">还没有</span>'}</div><div class="ids-add chips-add">${chipKinds[kind].add(esc(placeholder))}<button type="button" class="ghost" data-chips-add aria-label="添加到${esc(label)}">添加</button></div>${hint ? `<p class="hint">${hint}</p>` : ""}</div>`;
}
function chipsSet(box, list) {
  const hidden = box.querySelector('input[type="hidden"]');
  hidden.value = list.join(chipKinds[box.dataset.chips].sep);
  hidden.dispatchEvent(new Event("change", { bubbles: true }));
  box.querySelector(".ids-chips").innerHTML =
    list.map(chipsChip).join("") || '<span class="ids-empty">还没有</span>';
}
// Adds what the add row holds; false when a date-time pair is half filled.
function chipsAdd(box) {
  const kind = box.dataset.chips,
    fields = [...box.querySelectorAll(".chips-add input")],
    hidden = box.querySelector('input[type="hidden"]');
  let values;
  if (kind === "when") {
    const [date, time] = fields;
    if (!date.value && !time.value) return true;
    const missing = date.value ? time : date;
    if (!date.value || !time.value) {
      missing.setCustomValidity("先选好日期和时刻");
      missing.reportValidity();
      return false;
    }
    values = [`${date.value} ${time.value}`];
    date.value = "";
  } else {
    values = chipsList(fields[0].value, kind);
    fields[0].value = "";
  }
  if (values.length)
    chipsSet(
      box,
      chipsList([...chipsList(hidden.value, kind), ...values], kind),
    );
  return true;
}
// Something typed but not yet added still counts when the form is saved. The
// first box decides: a date-time pair is untouched until a date is picked,
// since its time starts at 09:00. False when a picked date lacks its time.
function chipsFlush(form) {
  let complete = true;
  for (const box of form?.querySelectorAll?.("[data-chips]") || [])
    if (box.querySelector(".chips-add input")?.value)
      complete = chipsAdd(box) && complete;
  return complete;
}
document.addEventListener?.("click", (e) => {
  const box = e.target.closest?.("[data-chips]");
  if (!box) return;
  if (e.target.closest("[data-chips-add]")) chipsAdd(box);
  const gone = e.target.closest("[data-chips-remove]")?.dataset.chipsRemove;
  if (gone != null)
    chipsSet(
      box,
      chipsList(
        box.querySelector('input[type="hidden"]').value,
        box.dataset.chips,
      ).filter((x) => x !== gone),
    );
});
document.addEventListener?.("keydown", (e) => {
  const box =
    e.target.closest?.(".chips-add") && e.target.closest("[data-chips]");
  if (!box || e.key !== "Enter") return;
  // Enter adds the chip instead of submitting the form.
  e.preventDefault();
  chipsAdd(box);
});
// The add row has no named fields: a warning there must never hold up saving.
for (const type of ["input", "focusout"])
  document.addEventListener?.(type, (e) => {
    if (e.target.closest?.(".chips-add")) e.target.setCustomValidity("");
  });

// Time zones as a list: a few common ones first, then every zone this
// browser knows. A saved zone the list lacks is still offered.
const commonZones = [
  ["Asia/Shanghai", "北京时间"],
  ["Asia/Hong_Kong", "香港"],
  ["Asia/Taipei", "台北"],
  ["Asia/Tokyo", "东京"],
  ["Asia/Seoul", "首尔"],
  ["Asia/Singapore", "新加坡"],
  ["Europe/London", "伦敦"],
  ["Europe/Berlin", "柏林"],
  ["America/New_York", "纽约"],
  ["America/Los_Angeles", "洛杉矶"],
  ["UTC", "协调世界时"],
];
function zoneSelect(name, label, value) {
  let all = [];
  try {
    all = Intl.supportedValuesOf("timeZone");
  } catch {
    // Older browsers: the common zones and the saved one.
  }
  const common = new Set(commonZones.map(([z]) => z)),
    rest = all.filter((z) => !common.has(z));
  if (value && !common.has(value) && !rest.includes(value)) rest.unshift(value);
  return `<label>${esc(label)}<select name="${name}"><optgroup label="常用">${parityOptions(
    commonZones.map(([z, n]) => [z, `${n} · ${z}`]),
    value,
  )}</optgroup>${
    rest.length
      ? `<optgroup label="全部">${parityOptions(
          rest.map((z) => [z, z]),
          value,
        )}</optgroup>`
      : ""
  }</select></label>`;
}
const weekdayNames = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

// Fold summaries: the state of a section in a few words.
function wakeSummary(a) {
  const w = a.wake,
    b = a.behavior;
  const by = [
    w.mentions && "@",
    w.names && "叫名字",
    w.keywords.length && `${w.keywords.length} 个关键词`,
    w.speakerIds.length && `${w.speakerIds.length} 位指定发言者`,
    w.poke && "拍一拍",
    w.joins && "入群",
  ].filter(Boolean);
  const said = by.length
    ? `${by.length > 1 ? by.slice(0, -1).join("、") + "和" + by.at(-1) : by[0]}会唤醒`
    : "只有私聊会唤醒";
  return `${said} · ${b.batchWindowMs ? `合并窗口 ${b.batchWindowMs / 1000} 秒` : "不合并唤醒"}`;
}
const wakeMoreSummary = (b) =>
  `睡前观察 ${b.preSleepWaitMs / 1000} 秒 · 每小时最多唤醒 ${b.maxWakePerHour} 次 · 投递 ${b.maxSendPerMinute}/分 ${b.maxSendPerHour}/时`;
const schedulerSummary = (s) =>
  `${s.enabled ? "已启用" : "未启用"} · 时区 ${s.timezone} · 每日上限 ${s.totalPerDay}`;
const schedulerMoreSummary = (s) =>
  `${s.allowAiPrivate ? "管理员私聊可登记" : "AI 不能登记"} · 单任务每日 ${s.perTaskPerDay} 次 · 节假日 ${s.holidays.length} 天`;

function renderParity(page) {
  if (!config.agents.some((a) => a.id === parityAgentId))
    parityAgentId = config.agents[0]?.id;
  // Role pages follow the role picked in the section bar; the system page
  // has none, so it keeps its own picker.
  $("#content").innerHTML =
    page === "operations"
      ? `<div class="card toolbar"><label>角色<select id="parity-agent">${parityOptions(
          config.agents.map((a) => [a.id, a.name]),
          parityAgentId,
        )}</select></label><p class="hint">${status.mode === "isolated" ? "隔离模式下可编辑和预览，实际运行与投递保持关闭。" : "全局、角色与会话暂停始终优先于任何自动任务。"}</p></div><div id="parity-body"></div>`
      : '<div id="parity-body"></div>';
  const picker = $("#parity-agent");
  if (picker)
    picker.onchange = (e) => {
      parityAgentId = e.target.value;
      parityEditing = null;
      renderParity(page);
    };
  if (!parityAgentId) return;
  action(async () => {
    if (page === "schedule") await renderSchedules();
    else if (page === "voices") await renderVoices();
    else await renderOperations();
  });
}

const runStates = {
  reserved: ["已预留", ""],
  queued: ["已交给 AI", "live"],
  running: ["发送中", ""],
  sent: ["已发送", "live"],
  unknown: ["结果未知", "warn"],
  failed: ["失败", "bad"],
  skipped: ["已跳过", "off"],
  missed: ["已错过", "off"],
};
const runReasons = {
  PAUSED_OR_SILENCED: "暂停或静默中",
  QUIET_HOURS: "免打扰时段",
  TOTAL_DAILY_LIMIT: "到了每日全部目标上限",
  GROUP_DAILY_LIMIT: "到了每群每日上限",
  TASK_DAILY_LIMIT: "到了单任务每日上限",
  MISSED: "超过补发时间",
  SCHEDULER_DISABLED: "定时任务未启用",
  RESTART_INTERRUPTED_DO_NOT_REPLAY: "重启时中断，不重放",
  DELIVERY_UNKNOWN: "网络结果未知",
};
const parityWhen = (t) =>
  new Date(t).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
// One task, one fixed row: name, next run, rule, an on/off switch and edit.
// Long names and rules are cut; the full text shows on hover.
function scheduleRow(t) {
  const next = t.pendingConfirm
      ? "等待确认后开始"
      : t.enabled
        ? t.nextRunText || "没有下一次"
        : "已暂停",
    rule = `${t.scheduleText} · ${t.targets.map(parityTarget).join("、")} · ${t.kind === "ai" ? "叫 AI 来说" : "固定文字"}`,
    name = t.name || "未命名任务";
  return `<li class="task-row${t.enabled ? "" : " is-off"}"><div class="task-main"><div class="task-head"><strong class="task-name" title="${esc(name)}">${esc(name)}</strong>${t.pendingConfirm ? tag("待确认", "warn") : ""}</div><p class="task-next" title="${esc(next)}">${t.enabled && !t.pendingConfirm ? "<span>下次</span>" : ""}${esc(next)}</p><p class="task-rule" title="${esc(rule)}">${esc(rule)}</p></div><div class="task-actions"><label class="switch" title="${t.pendingConfirm ? "确认并启用" : t.enabled ? "已启用，点一下暂停" : "已暂停，点一下启用"}"><input type="checkbox" data-task-toggle="${esc(t.id)}" ${t.enabled ? "checked" : ""} aria-label="${t.pendingConfirm ? "确认并启用" : "启用"}「${esc(name)}」"><span class="switch-track" aria-hidden="true"></span></label><button type="button" data-task-edit="${esc(t.id)}">编辑</button></div></li>`;
}
function scheduleRunRow(r, names) {
  const [label, tone] = runStates[r.status] || [r.status, ""],
    what = `#${r.taskId} ${names.get(r.taskId) || ""} → ${parityTarget(r.target)}${r.reason ? " · " + (runReasons[r.reason] || r.reason) : ""}`;
  return `<li class="run-row">${tag(label, tone)}<span class="run-what" title="${esc(what)}">${esc(what)}</span><time>${esc(parityWhen(r.at))}</time></li>`;
}
async function renderSchedules() {
  const id = parityAgentId,
    a = find("agents", id),
    b = a.behavior,
    s = a.scheduler;
  const result = await api("/api/schedules?agentId=" + encodeURIComponent(id));
  if (tab !== "schedule" || id !== parityAgentId) return;
  parityTasks = result.tasks;
  const names = new Map(result.tasks.map((t) => [t.id, t.name])),
    runs = result.history.slice(-20).reverse();
  $("#parity-body").innerHTML =
    `<div class="section-title"><h2>定时任务 · ${result.tasks.length}</h2><button type="button" class="primary" id="new-schedule">+ 新建任务</button></div>
    ${s.enabled ? "" : '<div class="banner warn">定时任务总开关没有打开，下面的任务都不会执行。可在下方「定时任务设置」里启用。</div>'}<div id="task-form"></div>
    ${result.tasks.length ? `<ul class="card task-list">${result.tasks.map(scheduleRow).join("")}</ul>` : '<div class="card empty">尚无任务。创建后可以先预览时间，再决定启用。</div>'}
    <p class="hint">${status.mode === "isolated" ? "隔离模式下可编辑和预览，实际运行与投递保持关闭。" : "全局、角色与会话暂停始终优先于任何自动任务。"}</p>
    <div class="section-title"><h2>最近执行记录</h2></div>${
      runs.length
        ? `<div class="card"><ul class="run-list">${runs
            .slice(0, 8)
            .map((r) => scheduleRunRow(r, names))
            .join("")}</ul>${
            runs.length > 8
              ? `<details class="run-more"><summary>更早的 ${runs.length - 8} 条</summary><ul class="run-list">${runs
                  .slice(8)
                  .map((r) => scheduleRunRow(r, names))
                  .join("")}</ul></details>`
              : ""
          }</div>`
        : '<div class="card"><p class="hint">没有执行记录。保存和预览不会发送消息。</p></div>'
    }
    <div class="section-title"><h2>设置</h2></div>
    ${fold(
      "schedule-wake",
      "唤醒与回复节奏",
      `<form id="behavior-form"><p class="hint">除了被 @、私聊和提到名字，下面这些也会让角色醒来看看。主动检查与联系范围在「空闲时间」中设置。</p><div class="form-grid">
    ${chips("keywords", "关键词", a.wake.keywords, { placeholder: "输入关键词后回车；逗号可一次加几个", hint: "群里有人说到这些词时唤醒。" })}${ids("speakers", "指定发言者 QQ", a.wake.speakerIds, { kind: "person", hint: "这些人在群里说话时唤醒。" })}
    ${parityCheck("poke", "拍一拍唤醒", a.wake.poke)}${parityCheck("joins", "有人入群时唤醒", a.wake.joins)}
    ${range("quiet", "新消息后等安静", b.quietAfterNewMs / 1000, { min: 0, max: 60, step: 1, unit: " 秒" })}${range("batch", "合并唤醒：每条后等待", b.batchWindowMs / 1000, { min: 0, max: 60, step: 1, unit: " 秒" })}${range("batchMax", "合并唤醒：最长等待", b.batchMaxMs / 1000, { min: 0, max: 60, step: 1, unit: " 秒" })}
    </div><p class="hint">合并唤醒时每来一条消息都重新等待，从第一条算起不超过最长等待；最长等待不大于每条后等待时，从第一条起固定等待。</p>${fold(
      "schedule-wake-more",
      "高级设置：观察、回复检查与投递额度",
      `<div class="form-grid">${parityNumber("observe", "睡前观察（秒；0 关闭要求）", b.preSleepWaitMs / 1000)}${parityNumber("reply", "发言后回复检查（秒）", b.replyCheckMs / 1000, 1)}
    ${parityNumber("wakeHour", "单会话每小时唤醒上限", b.maxWakePerHour, 1)}${parityNumber("sendMinute", "角色总投递上限／分钟", b.maxSendPerMinute, 1)}${parityNumber("sendHour", "角色总投递上限／小时", b.maxSendPerHour, 1)}
    ${parityOptionalNumber("conversationSendMinute", "单会话投递上限／分钟（可选）", b.conversationMaxSendPerMinute)}${parityOptionalNumber("conversationSendHour", "单会话投递上限／小时（可选）", b.conversationMaxSendPerHour)}
    <p class="hint">角色总额度由所有群和私聊共享，文本、文件及其他投递统一计数；失败或未知回执也占用额度。连续回复批次另按角色设置限制。</p></div>`,
      { summary: esc(wakeMoreSummary(b)), cls: "fold-inner" },
    )}${fold(
      "schedule-rhythm",
      "作息与慢回复",
      `<div class="form-grid">${parityCheck("rhythmEnabled", "启用作息", b.rhythm.enabled)}
      ${parityField("rhythmTimezone", "时区（留空跟随主动联系）", b.rhythm.timezone || "", "text", "Asia/Shanghai")}
      ${parityField("rhythmStart", "入睡时间", b.rhythm.sleep.start, "time")}${parityField("rhythmEnd", "起床时间", b.rhythm.sleep.end, "time")}
      ${select("rhythmMode", "睡觉时收到消息", b.rhythm.sleepMode, [
        ["defer", "起床后处理"],
        ["slow", "慢一些回复"],
      ])}
      ${parityCheck("rhythmOwners", "主人私聊可叫醒", b.rhythm.urgentOwners)}
      ${range("rhythmJitter", "起床后随机延后上限", b.rhythm.wakeJitterMs / 60000, { min: 0, max: 120, step: 1, unit: " 分钟" })}
      ${range("rhythmProbability", "普通消息偶尔慢回复", b.rhythm.lateReply.probability * 100, { min: 0, max: 100, step: 1, unit: "%" })}
      ${range("rhythmMin", "慢回复最少等待", b.rhythm.lateReply.minMs / 60000, { min: 0, max: 60, step: 1, unit: " 分钟" })}${range("rhythmMax", "慢回复最多等待", b.rhythm.lateReply.maxMs / 60000, { min: 0, max: 60, step: 1, unit: " 分钟" })}
      </div><p class="hint">默认关闭。时区示例：Asia/Shanghai。只推迟普通唤醒，定时任务和已选定意图不受影响；睡觉时暂停空闲活动和主动联系，额度不增加。被 @ 或被引用不套用随机慢回复；睡觉期间遵循所选的处理方式。</p>`,
      {
        summary: b.rhythm.enabled
          ? `${esc(b.rhythm.sleep.start)}–${esc(b.rhythm.sleep.end)}`
          : "未开启",
        cls: "fold-inner",
      },
    )}${fold(
      "schedule-typing",
      "打字节奏",
      `<div class="form-grid">${parityCheck("typingEnabled", "按内容长度等待", b.typing.enabled)}${parityCheck("typingFirst", "首条也等待", b.typing.firstReply)}${parityCheck("typingIndicator", "私聊“正在输入”", b.typing.indicator)}
    ${range("typingChar", "每字耗时", b.typing.msPerChar, { min: 0, max: 2000, step: 10, unit: " 毫秒" })}${range("typingJitter", "打字抖动", b.typing.jitter, { min: 0, max: 1, step: 0.01, unit: "%" })}
    ${range("typingMin", "单条最短等待", b.typing.minMs / 1000, { min: 0, max: 30, step: 0.1, unit: " 秒" })}${range("typingMax", "单条最长等待", b.typing.maxMs / 1000, { min: 0, max: 30, step: 0.1, unit: " 秒" })}${range("typingFirstMax", "首条最长等待", b.typing.firstReplyMaxMs / 1000, { min: 0, max: 30, step: 0.1, unit: " 秒" })}
    </div><p class="hint">短句快、长段慢；表情、链接和图片各按一字计。连发时偶尔叠加走神停顿，显式 gapMs 优先。关闭后恢复原来的随机连发间隔，首条不等；固定定时文字和故障提示不等待。私聊输入状态尽力显示，网关不支持时照常发送。首条等待超过三秒时遇到新消息，会先让角色读完再决定。</p>`,
      {
        summary: b.typing.enabled
          ? "按长度等待 · 首条最多 " + b.typing.firstReplyMaxMs / 1000 + " 秒"
          : "已关闭 · 原随机间隔",
        cls: "fold-inner",
      },
    )}<button class="primary">保存唤醒与节奏</button></form>`,
      { summary: esc(wakeSummary(a)) },
    )}
    ${fold(
      "schedule-settings",
      "定时任务设置",
      `<form id="schedule-settings"><div class="form-grid">
    ${parityCheck("enabled", "启用定时任务", s.enabled)}${zoneSelect("timezone", "任务默认时区", s.timezone)}
    ${parityCheck("quietEnabled", "群定时任务免打扰", s.quietEnabled)}${parityField("quietStart", "免打扰开始", s.quietStart, "time")}${parityField("quietEnd", "免打扰结束", s.quietEnd, "time")}
    </div>${fold(
      "schedule-settings-more",
      "高级设置：AI 登记、每日上限、补发与节假日",
      `<div class="form-grid">${parityCheck("allowAiPrivate", "允许管理员私聊 AI 登记", s.allowAiPrivate)}${parityCheck("allowAiOtherTargets", "允许管理员私聊登记其他目标", s.allowAiOtherTargets)}${parityCheck("confirmAiOtherTargets", "其他目标登记或修改后需控制台确认", s.confirmAiOtherTargets !== false)}
    <p class="hint">关闭其他目标确认后，管理员私聊登记的任务可直接生效；目标仍限于角色允许的联系人和群，普通聊天不获得登记权限。</p>
    ${parityNumber("totalPerDay", "每日全部目标上限", s.totalPerDay, 1)}${parityNumber("perTaskPerDay", "单任务每日上限", s.perTaskPerDay, 1)}
    ${parityNumber("perGroupPerDay", "每群每日上限", s.perGroupPerDay, 1)}${parityNumber("missedGraceMin", "允许补发的迟到分钟数", s.missedGraceMin)}
    ${parityNumber("jitterMin", "固定时间随机偏移（分钟）", s.jitterMin)}${parityCheck("quietAllDay", "全天免打扰（仅群定时任务）", s.quietAllDay)}
    ${chips("holidays", "跳过的节假日", s.holidays, { kind: "date", hint: "工作日任务在这些日子不执行。不会自动拉取法定调休安排。" })}</div>`,
      { summary: esc(schedulerMoreSummary(s)), cls: "fold-inner" },
    )}<button class="primary">保存定时设置</button></form>`,
      { summary: esc(schedulerSummary(s)) },
    )}`;
  fillIds($("#parity-body"), id);
  $("#behavior-form").onsubmit = (e) =>
    action(async () => {
      e.preventDefault();
      chipsFlush(e.target);
      const f = new FormData(e.target),
        num = (n) => Number(f.get(n));
      const next = structuredClone(config),
        agent = next.agents.find((x) => x.id === id);
      Object.assign(agent.behavior, {
        preSleepWaitMs: num("observe") * 1000,
        quietAfterNewMs: num("quiet") * 1000,
        batchWindowMs: num("batch") * 1000,
        batchMaxMs: num("batchMax") * 1000,
        replyCheckMs: num("reply") * 1000,
        maxWakePerHour: num("wakeHour"),
        maxSendPerHour: num("sendHour"),
        maxSendPerMinute: num("sendMinute"),
        typing: {
          ...agent.behavior.typing,
          enabled: f.has("typingEnabled"),
          indicator: f.has("typingIndicator"),
          firstReply: f.has("typingFirst"),
          msPerChar: num("typingChar"),
          jitter: num("typingJitter"),
          minMs: Math.round(num("typingMin") * 1000),
          maxMs: Math.round(num("typingMax") * 1000),
          firstReplyMaxMs: Math.round(num("typingFirstMax") * 1000),
        },
      });
      agent.behavior.rhythm = {
        enabled: f.has("rhythmEnabled"),
        ...(String(f.get("rhythmTimezone")).trim()
          ? { timezone: String(f.get("rhythmTimezone")).trim() }
          : {}),
        sleep: {
          start: String(f.get("rhythmStart")),
          end: String(f.get("rhythmEnd")),
        },
        sleepMode: String(f.get("rhythmMode")),
        urgentOwners: f.has("rhythmOwners"),
        wakeJitterMs: Math.round(num("rhythmJitter") * 60000),
        lateReply: {
          probability: num("rhythmProbability") / 100,
          minMs: Math.round(num("rhythmMin") * 60000),
          maxMs: Math.round(num("rhythmMax") * 60000),
        },
      };
      for (const [input, key] of [
        ["conversationSendMinute", "conversationMaxSendPerMinute"],
        ["conversationSendHour", "conversationMaxSendPerHour"],
      ]) {
        const value = String(f.get(input) ?? "").trim();
        if (value) agent.behavior[key] = Number(value);
        else delete agent.behavior[key];
      }
      Object.assign(agent.wake, {
        keywords: String(f.get("keywords"))
          .split(/[,，]/)
          .map((x) => x.trim())
          .filter(Boolean),
        speakerIds: String(f.get("speakers"))
          .split(/[,，]/)
          .map((x) => x.trim())
          .filter(Boolean),
        poke: f.has("poke"),
        joins: f.has("joins"),
      });
      await api("/api/config", { config: next, revision }, "PUT");
      await load();
      notice("作息已保存；已有连接需手动重连");
    });
  $("#schedule-settings").onsubmit = (e) =>
    action(async () => {
      e.preventDefault();
      chipsFlush(e.target);
      const f = new FormData(e.target),
        next = structuredClone(config),
        agent = next.agents.find((x) => x.id === id);
      for (const key of [
        "enabled",
        "allowAiPrivate",
        "allowAiOtherTargets",
        "confirmAiOtherTargets",
        "quietEnabled",
        "quietAllDay",
      ])
        agent.scheduler[key] = f.has(key);
      for (const key of [
        "totalPerDay",
        "perTaskPerDay",
        "perGroupPerDay",
        "missedGraceMin",
        "jitterMin",
      ])
        agent.scheduler[key] = Number(f.get(key));
      for (const key of ["timezone", "quietStart", "quietEnd"])
        agent.scheduler[key] = f.get(key);
      agent.scheduler.holidays = String(f.get("holidays"))
        .split(/[,，]/)
        .map((x) => x.trim())
        .filter(Boolean);
      await api("/api/config", { config: next, revision }, "PUT");
      await load();
      notice("定时设置已保存");
    });
  $("#new-schedule").onclick = () => drawScheduleForm(null);
  const taskOf = (el) =>
    parityTasks.find(
      (t) => String(t.id) === (el.dataset.taskEdit ?? el.dataset.taskToggle),
    );
  document
    .querySelectorAll("[data-task-edit]")
    .forEach(
      (button) => (button.onclick = () => drawScheduleForm(taskOf(button))),
    );
  document.querySelectorAll("[data-task-toggle]").forEach(
    (box) =>
      (box.onchange = () =>
        action(async () => {
          try {
            await api("/api/schedules", {
              agentId: id,
              id: taskOf(box).id,
              action: "update",
              task: { enabled: box.checked },
              requestId: crypto.randomUUID(),
            });
          } finally {
            // A refused change puts the switch back where it was.
            await renderSchedules();
          }
        })),
  );
}
function drawScheduleForm(task) {
  parityEditing = task?.id || null;
  const a = find("agents", parityAgentId),
    t = task || {
      name: "",
      kind: "text",
      schedule: { type: "daily", times: ["09:00"] },
      targets: [],
      timezone: a.scheduler.timezone,
      enabled: false,
      jitterMin: a.scheduler.jitterMin,
    };
  const targets = [
    ...allowedGroupIds(a).map((x) => ["group:" + x, "群 " + x]),
    ...a.allow.users.map((x) => ["private:" + x, "私聊 " + x]),
  ];
  const live = status.mode !== "isolated" && !status.globalPaused;
  $("#task-form").innerHTML =
    `<form id="schedule-form" class="card task-editor"><h3>${task ? `编辑任务 · ${esc(t.name)}` : "新建任务"}</h3><div class="form-grid">${parityField("name", "任务名称", t.name)}
    <label>内容方式<select name="kind">${parityOptions(
      [
        ["text", "固定文字"],
        ["ai", "叫 AI 来说"],
      ],
      t.kind,
    )}</select></label>
    <label class="wide">文字 / 给 AI 的说明<textarea name="content" required>${esc(t.kind === "ai" ? t.instruction : t.text)}</textarea></label>
    <fieldset class="pick wide"><legend>发送目标（可多选）</legend>${
      targets
        .map(
          ([v, l]) =>
            `<label class="check"><input type="checkbox" name="targets" value="${esc(v)}" ${t.targets.includes(v) ? "checked" : ""}>${esc(l)}</label>`,
        )
        .join("") ||
      '<p class="hint">这个角色还没有允许的群或私聊，先在角色设置的白名单里添加。</p>'
    }</fieldset>
    <label>重复方式<select name="ruleType" id="rule-type">${parityOptions(Object.entries(scheduleLabels), t.schedule.type)}</select></label>
    <div id="rule-fields" class="form-grid wide"></div>
    ${parityCheck("enabled", "保存后启用（暂停仍优先）", t.enabled)}</div>${advanced(
      "更多：时区、随机偏移、执行次数与排除日期",
      `${zoneSelect("timezone", "时区", t.timezone)}${parityNumber("jitter", "随机偏移（分钟）", t.jitterMin)}
    ${parityField("maxRuns", "最多执行次数（空白不限）", t.maxRuns || "", "number")}${chips("exclude", "排除日期", t.schedule.excludeDates || [], { kind: "date" })}`,
    )}<div class="card-actions"><button type="button" id="preview-schedule">预览接下来五次</button><button class="primary">保存任务</button><button type="button" id="cancel-schedule">取消</button>${
      task
        ? `<span class="task-editor-gap"></span><button type="button" id="run-schedule" ${live ? "" : "disabled"} title="按已保存的设置立刻执行一次">立即执行一次</button><button type="button" class="danger" id="delete-schedule">删除任务</button>`
        : ""
    }</div><div id="schedule-preview" class="hint"></div></form>`;
  const rules = () => {
    const type = $("#rule-type").value,
      r = type === t.schedule.type ? t.schedule : {};
    let html = "";
    if (["once", "everyNDays"].includes(type))
      html += parityField(
        "date",
        type === "once" ? "日期" : "开始日期",
        r.date || r.startDate || new Date().toISOString().slice(0, 10),
        "date",
      );
    if (type === "once")
      html += parityField("times", "时刻", r.time || "09:00", "time");
    else if (
      !["dates", "cron", "interval", "dailyRandom", "monthlyRandom"].includes(
        type,
      )
    )
      html += chips("times", "时刻", r.times || ["09:00"], { kind: "time" });
    if (type === "weekly")
      html += `<fieldset class="pick wide"><legend>星期</legend>${weekdayNames
        .map(
          (d, i) =>
            `<label class="check"><input type="checkbox" name="weekdays" value="${i + 1}" ${(r.weekdays || [1, 3, 5]).includes(i + 1) ? "checked" : ""}>${d}</label>`,
        )
        .join("")}</fieldset>`;
    if (type === "monthly")
      html += parityField(
        "days",
        "每月几号（逗号分隔，-1 为月底）",
        (r.days || [1, -1]).join(","),
        "text",
        "例如 1,15,-1",
      );
    if (type === "monthlyWeekday")
      html += `<label>第几个<select name="nth">${parityOptions(
        [
          ["1", "第 1 个"],
          ["2", "第 2 个"],
          ["3", "第 3 个"],
          ["4", "第 4 个"],
          ["5", "第 5 个"],
          ["-1", "最后一个"],
        ],
        String(r.nth || 2),
      )}</select></label><label>星期几<select name="weekday">${parityOptions(
        weekdayNames.map((d, i) => [String(i + 1), d]),
        String(r.weekday || 6),
      )}</select></label>`;
    if (type === "yearly")
      html += parityField(
        "dates",
        "月日（MM-DD，逗号分隔）",
        (r.dates || ["12-31"]).join(","),
        "text",
        "例如 01-01,12-31",
      );
    if (type === "dates")
      html += chips(
        "dates",
        "特殊日期",
        (r.items || []).map((x) => x.date + " " + x.time),
        { kind: "when" },
      );
    if (type === "everyNDays")
      html += parityNumber("every", "每隔几天", r.every || 3, 1);
    if (["interval", "dailyRandom", "monthlyRandom"].includes(type))
      html +=
        parityField(
          "windowStart",
          "时间窗开始",
          r.window?.[0] || "09:00",
          "time",
        ) +
        parityField(
          "windowEnd",
          "时间窗结束",
          r.window?.[1] || "21:00",
          "time",
        );
    if (type === "interval")
      html += parityNumber(
        "everyMinutes",
        "每隔几分钟",
        r.everyMinutes || 60,
        10,
      );
    if (["dailyRandom", "monthlyRandom"].includes(type))
      html +=
        parityNumber("count", "随机次数", r.count || 3, 1) +
        parityNumber("minGapMin", "最小间隔（分钟）", r.minGapMin || 60, 1);
    if (type === "monthlyRandom")
      html += parityField(
        "dayRange",
        "日期范围（起止日，逗号分隔）",
        (r.dayRange || [1, 28]).join(","),
        "text",
        "例如 1,28",
      );
    if (type === "cron")
      html += parityField(
        "expr",
        "五段 cron 表达式",
        r.expr || "0 9 * * MON-FRI",
      );
    $("#rule-fields").innerHTML = html;
  };
  $("#rule-type").onchange = rules;
  rules();
  const read = () => {
    if (!chipsFlush($("#schedule-form")))
      throw Error("还没添加的日期缺少时刻，补上时刻或清空日期");
    const f = new FormData($("#schedule-form")),
      type = f.get("ruleType"),
      list = (n) =>
        String(f.get(n) || "")
          .split(/[,，]/)
          .map((x) => x.trim())
          .filter(Boolean),
      num = (n) => Number(f.get(n)),
      r = { type };
    if (type === "once")
      Object.assign(r, { date: f.get("date"), time: list("times")[0] });
    else if (
      [
        "daily",
        "weekly",
        "workdays",
        "monthly",
        "monthlyWeekday",
        "yearly",
        "everyNDays",
      ].includes(type)
    )
      r.times = list("times");
    if (type === "weekly") r.weekdays = f.getAll("weekdays").map(Number);
    if (type === "monthly") r.days = list("days").map(Number);
    if (type === "monthlyWeekday")
      Object.assign(r, { nth: num("nth"), weekday: num("weekday") });
    if (type === "yearly") r.dates = list("dates");
    if (type === "dates")
      r.items = String(f.get("dates"))
        .split("\n")
        .filter((x) => x.trim())
        .map((x) => {
          const [date, time] = x.trim().split(/\s+/);
          return { date, time };
        });
    if (type === "everyNDays")
      Object.assign(r, { every: num("every"), startDate: f.get("date") });
    if (["interval", "dailyRandom", "monthlyRandom"].includes(type))
      r.window = [f.get("windowStart"), f.get("windowEnd")];
    if (type === "interval") r.everyMinutes = num("everyMinutes");
    if (["dailyRandom", "monthlyRandom"].includes(type))
      Object.assign(r, { count: num("count"), minGapMin: num("minGapMin") });
    if (type === "monthlyRandom") r.dayRange = list("dayRange").map(Number);
    if (type === "cron") r.expr = f.get("expr");
    r.excludeDates = list("exclude");
    return {
      name: f.get("name"),
      kind: f.get("kind"),
      [f.get("kind") === "ai" ? "instruction" : "text"]: f.get("content"),
      targets: f.getAll("targets"),
      schedule: r,
      timezone: f.get("timezone"),
      jitterMin: num("jitter"),
      maxRuns: f.get("maxRuns") ? num("maxRuns") : null,
      enabled: f.has("enabled"),
    };
  };
  $("#preview-schedule").onclick = () =>
    action(async () => {
      const r = await api("/api/schedules", {
        agentId: parityAgentId,
        action: "preview",
        task: read(),
      });
      $("#schedule-preview").innerHTML =
        r.next
          .map(
            (x) =>
              `<p>${esc(x.text)}${x.silenced ? " · 位于静默时段" : ""}</p>`,
          )
          .join("") || "没有符合规则的未来时间";
    });
  $("#schedule-form").onsubmit = (e) =>
    action(async () => {
      e.preventDefault();
      const next = read();
      if (!next.targets.length) throw Error("至少选一个发送目标");
      await api("/api/schedules", {
        agentId: parityAgentId,
        action: parityEditing ? "update" : "create",
        id: parityEditing,
        task: next,
      });
      parityEditing = null;
      await renderSchedules();
      notice("任务已保存");
    });
  $("#cancel-schedule").onclick = () => {
    $("#task-form").innerHTML = "";
    parityEditing = null;
  };
  const run = $("#run-schedule"),
    remove = $("#delete-schedule");
  if (task && run)
    run.onclick = () =>
      action(async () => {
        await api("/api/schedules", {
          agentId: parityAgentId,
          id: task.id,
          action: "run",
          requestId: crypto.randomUUID(),
        });
        await renderSchedules();
        notice("已登记执行，结果见执行记录");
      });
  if (task && remove)
    remove.onclick = () =>
      action(async () => {
        if (!confirm(`删除任务「${task.name}」？已有的执行记录会保留。`))
          return;
        await api("/api/schedules", {
          agentId: parityAgentId,
          id: task.id,
          action: "delete",
          requestId: crypto.randomUUID(),
        });
        parityEditing = null;
        await renderSchedules();
        notice("任务已删除");
      });
  $("#task-form").scrollIntoView?.({ block: "nearest" });
}
const voiceMeta = (m) =>
  `${m.duration == null ? "时长未知" : m.duration.toFixed(1) + " 秒"} · ${m.codec} · ${(m.bytes / 1024).toFixed(1)} KB`;
async function renderVoices() {
  const id = parityAgentId,
    result = await api("/api/voices?agentId=" + encodeURIComponent(id));
  if (tab !== "voices" || id !== parityAgentId) return;
  $("#parity-body").innerHTML =
    `<div class="section-title"><h2>角色语音 · ${result.total}</h2><button type="button" class="primary" id="voice-import-open" aria-expanded="false" aria-controls="voice-import">+ 导入语音</button></div><form id="voice-import" class="card" hidden><h3>导入语音</h3><p class="hint">每个角色单独保存。导入会校验音频；试听只在本机播放，不向 QQ 投递。支持 WAV、MP3、Ogg、FLAC、M4A、AMR、SILK，最大 20 MiB。</p><div class="form-grid">${parityField("title", "语音名称", "", "text", "留空用文件名")}<label>音频文件<input name="audio" type="file" accept="audio/*,.silk,.slk" required></label></div><div class="card-actions"><button class="primary">导入</button><button type="button" id="voice-import-cancel">取消</button></div></form><audio id="voice-player" controls hidden></audio>${result.items.length ? `<div class="voice-list">${result.items.map((m) => `<article class="card voice-item"><div class="voice-text"><h3 title="${esc(m.title)}">${esc(m.title)}</h3><p class="hint" title="${esc(voiceMeta(m))}">${esc(voiceMeta(m))}</p></div><button type="button" data-audio="${esc(m.id)}">本机试听</button></article>`).join("")}</div>` : '<div class="card empty">暂无语音。点「导入语音」添加素材，或由已配置的音频 MCP 生成。</div>'}${result.total > result.items.length ? `<p class="hint">只列出前 ${result.items.length} 条。</p>` : ""}`;
  const form = $("#voice-import"),
    open = $("#voice-import-open");
  const show = (on) => {
    form.hidden = !on;
    open.setAttribute?.("aria-expanded", String(on));
    if (on) form.querySelector?.('input[name="title"]')?.focus();
  };
  open.onclick = () => show(form.hidden);
  $("#voice-import-cancel").onclick = () => show(false);
  form.onsubmit = (e) =>
    action(async () => {
      e.preventDefault();
      const f = new FormData(e.target),
        file = f.get("audio");
      if (file.size > 20971520) throw Error("音频不能超过 20 MiB");
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      await api("/api/voices/import", {
        agentId: id,
        title: f.get("title") || file.name,
        base64,
      });
      await renderVoices();
      notice("语音已导入");
    });
  document.querySelectorAll("[data-audio]").forEach(
    (b) =>
      (b.onclick = () =>
        action(async () => {
          const r = await fetch(
            `/api/voices/play?agentId=${encodeURIComponent(id)}&id=${encodeURIComponent(b.dataset.audio)}`,
            { headers: { "x-admin-token": token } },
          );
          if (!r.ok) throw Error("音频读取失败");
          if (voiceObjectUrl) URL.revokeObjectURL(voiceObjectUrl);
          voiceObjectUrl = URL.createObjectURL(await r.blob());
          const audio = $("#voice-player");
          audio.src = voiceObjectUrl;
          audio.hidden = false;
          await audio.play();
        })),
  );
}
// The operations level an agent holds now, per conversation.
function opsLevelsMarkup(levels) {
  return levels.length
    ? levels
        .map(
          (l) =>
            `<li>${tag(l.level, "warn")}<span>${esc(parityTarget(l.key.split("|").slice(1).join("|")))}</span><time>授予于 ${esc(parityWhen(l.grantedAt))}</time></li>`,
        )
        .join("")
    : `<li>${tag("L0")}<span>没有授予的管理员操作级别</span></li>`;
}
const opsSummary = (o) =>
  o.enabled
    ? `已开启 · ${o.allowL3 ? "允许 L3" : "最高 L2"} · 级别最长 ${Math.round(o.maxLevelMs / 60000)} 分钟`
    : "运维工具已关闭";
async function renderOperations() {
  const id = parityAgentId,
    a = find("agents", id),
    ops = await api("/api/operations");
  if (tab !== "operations" || id !== parityAgentId) return;
  const confirmOff = disabledReason([
    [status.mode === "isolated" || status.globalPaused, "opsBlocked"],
  ]);
  const pending = ops.pending.filter((p) => p.agentId === id),
    levels = (ops.levels || []).filter((l) => l.key.startsWith(id + "|")),
    o = a.operations;
  $("#parity-body").innerHTML =
    `<section id="protected-work"><p class="hint">读取中…</p></section><div class="section-title"><h2>管理员操作${pending.length ? ` · 待确认 ${pending.length}` : ""}</h2></div><div class="card"><ul class="ops-levels">${opsLevelsMarkup(levels)}</ul>${
      pending
        .map(
          (p) =>
            `<form class="ops-confirm" data-id="${esc(p.id)}" data-conversation="${esc(p.conversation)}"><h3>${esc(p.operation.type)} · ${esc(parityTarget(p.conversation))}</h3><pre>${esc(JSON.stringify(p.operation, null, 2))}</pre><p>本次确认码：<strong class="mono">${esc(p.confirmationCode)}</strong> · 两分钟内有效</p><div class="form-grid">${parityField("code", "输入本次确认码")}${parityField("otp", "L3 动态码", "", "password")}</div><button class="danger" ${disabledAttr(confirmOff)}>确认执行此项操作</button>${disabledHints(confirmOff)}</form>`,
        )
        .join("") || '<p class="hint">没有待确认操作。</p>'
    }</div>${fold(
      "ops-settings",
      "运维设置",
      `<p>${o.enabled ? "仅独立工作任务可申请运维；级别有时限，写入与命令逐项确认。" : "运维工具当前关闭。可在完整配置中指定专用工作区及允许命令后开启。"}</p><dl class="agent-meta"><dt>工作区</dt><dd class="mono">${esc(o.workspace || "未设置")}</dd><dt>允许命令</dt><dd>${o.allowedCommands.length ? esc(o.allowedCommands.join("、")) : "无"}</dd><dt>L3</dt><dd>${o.allowL3 ? `允许 · 动态码变量 ${esc(o.totpEnv || "未设置")}` : "不允许"}</dd><dt>级别时限</dt><dd>最长 ${Math.round(o.maxLevelMs / 60000)} 分钟，空闲 ${Math.round(o.idleMs / 60000)} 分钟后收回</dd></dl><div class="card-actions"><button type="button" id="ops-config">在完整配置中修改</button></div>`,
      { summary: esc(opsSummary(o)) },
    )}<div class="card danger-zone"><div><h3>回落到 L0</h3><p class="hint">立即收回「${esc(a.name)}」当前的管理员操作级别，并撤销全部待确认操作；之后需管理员重新申请。</p></div><button type="button" class="danger" id="revoke-ops">回落到 L0 并撤销待批准项</button></div>`;
  $("#ops-config").onclick = () => action(() => operate("advanced"));
  await renderProtectedWork(id);
  $("#revoke-ops").onclick = () =>
    action(async () => {
      if (
        !confirm(
          `回落到 L0 会立即收回「${a.name}」当前的管理员操作级别，并撤销全部待确认操作；之后需管理员重新申请。确定继续？`,
        )
      )
        return;
      await api("/api/operations", { action: "revoke", agentId: id });
      await renderOperations();
      notice("已回落到 L0");
    });
  document.querySelectorAll(".ops-confirm").forEach(
    (form) =>
      (form.onsubmit = (e) =>
        action(async () => {
          e.preventDefault();
          const f = new FormData(form);
          await api("/api/operations", {
            action: "confirm",
            agentId: id,
            conversation: form.dataset.conversation,
            id: form.dataset.id,
            code: f.get("code"),
            otp: f.get("otp"),
          });
          await renderOperations();
          notice("已处理确认请求");
        })),
  );
}

const workStates = {
  ready: ["待开始", ""],
  running: ["处理中", "live"],
  review: ["待审阅", "warn"],
  waiting: ["等待继续", ""],
  interrupted: ["已中断", "warn"],
  failed: ["任务失败", "bad"],
  cancelled: ["已取消", "off"],
  cancelling: ["正在取消", "off"],
  released: ["已交回聊天", "live"],
};
function workItem(t, targets) {
  const [label, tone] = workStates[t.status] || [t.status, ""],
    scope = t.operations
      ? "运维"
      : t.repositories?.length
        ? t.repositories.join("、")
        : "";
  const open = !["released", "cancelled", "cancelling"].includes(t.status);
  return `<article class="card work-item"><div class="work-head">${tag(label, tone)}${scope ? `<span class="work-scope" title="${esc(scope)}">${esc(scope)}</span>` : ""}<time>${esc(parityWhen(t.createdAt))}</time></div><p class="work-text" title="${esc(t.instruction)}">${esc(t.instruction)}</p>${t.error ? `<p class="hint">${esc(t.error)}</p>` : ""}${t.result ? `<h4>候选结果 · 第 ${t.revision} 版</h4><pre class="work-result">${esc(t.result.text)}</pre>` : ""}${
    open
      ? `<div class="card-actions"><button type="button" data-work-run="${esc(t.id)}" ${t.status === "running" ? "disabled" : ""}>${t.status === "ready" ? "开始任务" : "继续任务"}</button><button type="button" class="danger" data-work-cancel="${esc(t.id)}">取消任务</button></div>${t.result && t.status !== "running" ? `<form class="work-release" data-task="${esc(t.id)}"><label>交回结果的聊天<select name="target">${parityOptions(targets)}</select></label><label class="check"><input type="checkbox" required>我已审阅上方完整文字，同意解除这一版文字的工作保护并交回所选聊天</label><button class="danger">批准解除这段结果的保护</button></form>` : ""}`
      : t.release
        ? `<p class="hint">已交回 ${esc(parityTarget(t.release.target))}，未自动发送。</p>`
        : ""
  }</article>`;
}
async function renderProtectedWork(id) {
  const a = find("agents", id);
  const { tasks } = await api(
    `/api/protected-work?agentId=${encodeURIComponent(id)}`,
  );
  if (tab !== "operations" || id !== parityAgentId) return;
  const targets = [
    ...a.allow.users.map((x) => ["private:" + x, "私聊 " + x]),
    ...allowedGroupIds(a).map((x) => ["group:" + x, "群 " + x]),
  ];
  $("#protected-work").innerHTML =
    `<div class="section-title"><h2>受保护工作 · ${tasks.length}</h2><div class="section-actions"><button type="button" id="work-refresh">刷新</button><button type="button" class="primary" id="work-create-open" aria-expanded="false" aria-controls="work-create">+ 新建任务</button></div></div><form id="work-create" class="card" hidden><h3>新建受保护任务</h3><p class="hint">工作任务有独立模型会话。私有资料和运维结果留在这里；普通聊天与上网照常。批准会将所示文字解除工作保护，加入所选聊天及角色普通记忆；原始资料仍隔离，不自动发送 QQ。</p><label>任务说明<textarea name="instruction" required maxlength="12000" rows="3" placeholder="只填写本任务需要处理的内容"></textarea></label><label>私有仓库<select name="repository"><option value="">不读取私有仓库</option>${parityOptions(a.github.privateRepositories.map((x) => [x, x]))}</select></label><label class="check"><input name="operations" type="checkbox" ${a.operations.enabled ? "" : "disabled"}>仅运维任务（与仓库任务分开；操作仍逐项确认）</label><div class="card-actions"><button class="primary">创建受保护任务</button><button type="button" id="work-create-cancel">取消</button></div></form>${
      tasks.length
        ? `<div class="work-list">${tasks.map((t) => workItem(t, targets)).join("")}</div>`
        : '<div class="card empty">还没有受保护任务。私有仓库和运维只在这里处理。</div>'
    }`;
  $("#work-refresh").onclick = () => action(() => renderOperations());
  const create = $("#work-create"),
    open = $("#work-create-open");
  const show = (on) => {
    create.hidden = !on;
    open.setAttribute?.("aria-expanded", String(on));
    if (on) create.querySelector?.("textarea")?.focus();
  };
  open.onclick = () => show(create.hidden);
  $("#work-create-cancel").onclick = () => show(false);
  const repoSelect = $("#work-create select[name=repository]");
  const opsCheckbox = $("#work-create input[name=operations]");
  repoSelect.onchange = () => {
    if (repoSelect.value) opsCheckbox.checked = false;
    opsCheckbox.disabled = !a.operations.enabled || !!repoSelect.value;
  };
  opsCheckbox.onchange = () => {
    repoSelect.disabled = opsCheckbox.checked;
  };
  create.onsubmit = (event) => {
    event.preventDefault();
    action(async () => {
      const form = new FormData(event.target),
        repository = form.get("repository");
      await api("/api/protected-work", {
        agentId: id,
        instruction: form.get("instruction"),
        repositories: repository ? [repository] : [],
        operations: form.has("operations"),
      });
      await renderOperations();
    });
  };
  for (const b of document.querySelectorAll(
    "[data-work-run],[data-work-cancel]",
  ))
    b.onclick = () =>
      action(async () => {
        const run = b.dataset.workRun;
        if (
          !run &&
          !confirm(
            "取消这个受保护任务？正在进行的处理会停下，还没批准的候选结果不会交回聊天。",
          )
        )
          return;
        await api("/api/protected-work", {
          agentId: id,
          taskId: run || b.dataset.workCancel,
          action: run ? "run" : "cancel",
        });
        await renderOperations();
      });
  for (const form of document.querySelectorAll(".work-release"))
    form.onsubmit = (event) => {
      event.preventDefault();
      action(async () => {
        const task = tasks.find((t) => t.id === form.dataset.task);
        await api("/api/protected-work", {
          agentId: id,
          taskId: task.id,
          action: "release",
          revision: task.revision,
          digest: task.result.digest,
          target: new FormData(form).get("target"),
        });
        await renderOperations();
      });
    };
}
