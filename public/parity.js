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
const parityField = (name, label, value = "", type = "text") =>
  `<label>${esc(label)}<input name="${name}" type="${type}" value="${esc(value)}"></label>`;
const parityCheck = (name, label, value) =>
  `<label class="check"><input name="${name}" type="checkbox" ${value ? "checked" : ""}>${esc(label)}</label>`;
function renderParity(page) {
  if (!config.agents.some((a) => a.id === parityAgentId))
    parityAgentId = config.agents[0]?.id;
  $("#content").innerHTML =
    `<div class="card toolbar"><label>角色<select id="parity-agent">${parityOptions(
      config.agents.map((a) => [a.id, a.name]),
      parityAgentId,
    )}</select></label><p class="hint">${status.mode === "isolated" ? "隔离模式下可编辑和预览，实际运行与投递保持关闭。" : "全局、角色与会话暂停始终优先于任何自动任务。"}</p></div><div id="parity-body"></div>`;
  $("#parity-agent").onchange = (e) => {
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
async function renderSchedules() {
  const id = parityAgentId,
    a = find("agents", id),
    b = a.behavior,
    p = b.proactive,
    s = a.scheduler;
  const result = await api("/api/schedules?agentId=" + encodeURIComponent(id));
  if (tab !== "schedule" || id !== parityAgentId) return;
  parityTasks = result.tasks;
  $("#parity-body").innerHTML =
    `<details class="card" open><summary>作息与主动参与</summary><form id="behavior-form"><div class="form-grid">
    <p class="hint">主体主动检查与联系范围请在「Self 与主体」设置；旧逐聊天随机主动入口已停用。</p>
    ${parityNumber("observe", "睡前观察（秒；0 关闭要求）", b.preSleepWaitMs / 1000)}${parityNumber("quiet", "新消息后的安静窗口（秒）", b.quietAfterNewMs / 1000)}
    ${parityNumber("batch", "合并唤醒窗口（秒）", b.batchWindowMs / 1000)}${parityNumber("reply", "发言后回复检查（秒）", b.replyCheckMs / 1000, 1)}
    ${parityNumber("wakeHour", "单会话每小时唤醒上限", b.maxWakePerHour, 1)}${parityNumber("sendMinute", "角色总投递上限／分钟", b.maxSendPerMinute, 1)}${parityNumber("sendHour", "角色总投递上限／小时", b.maxSendPerHour, 1)}
    ${parityOptionalNumber("conversationSendMinute", "单会话投递上限／分钟（可选）", b.conversationMaxSendPerMinute)}${parityOptionalNumber("conversationSendHour", "单会话投递上限／小时（可选）", b.conversationMaxSendPerHour)}
    <p class="hint">角色总额度由所有群和私聊共享，文本、文件及其他投递统一计数；失败或未知回执也占用额度。连续回复批次另按角色设置限制。升级会保留近期已消耗额度。</p>
    ${parityField("keywords", "关键词（逗号分隔）", a.wake.keywords.join(","))}${parityField("speakers", "指定发言者 QQ（逗号分隔）", a.wake.speakerIds.join(","))}
    ${parityCheck("poke", "拍一拍唤醒", a.wake.poke)}${parityCheck("joins", "入群事件唤醒", a.wake.joins)}
    </div><button class="primary">保存作息设置</button></form></details>
    <details class="card"><summary>定时任务开关与限额</summary><form id="schedule-settings"><div class="form-grid">
    ${parityCheck("enabled", "启用定时任务", s.enabled)}${parityField("timezone", "任务默认时区", s.timezone)}
    ${parityCheck("allowAiPrivate", "允许管理员私聊 AI 登记", s.allowAiPrivate)}${parityCheck("allowAiOtherTargets", "允许 AI 申请其他目标（仍需确认）", s.allowAiOtherTargets)}
    ${parityNumber("totalPerDay", "每日全部目标上限", s.totalPerDay, 1)}${parityNumber("perTaskPerDay", "单任务每日上限", s.perTaskPerDay, 1)}
    ${parityNumber("perGroupPerDay", "每群每日上限", s.perGroupPerDay, 1)}${parityNumber("missedGraceMin", "允许补发的迟到分钟数", s.missedGraceMin)}
    ${parityNumber("jitterMin", "固定时间随机偏移（分钟）", s.jitterMin)}${parityCheck("quietEnabled", "启用群定时免打扰", s.quietEnabled)}
    ${parityCheck("quietAllDay", "全天免打扰（仅群定时任务）", s.quietAllDay)}${parityField("quietStart", "免打扰开始", s.quietStart, "time")}${parityField("quietEnd", "免打扰结束", s.quietEnd, "time")}
    ${parityField("holidays", "跳过的节假日（YYYY-MM-DD，逗号分隔）", s.holidays.join(","))}</div><button>保存定时设置</button></form></details>
    <div class="section-title"><h2>定时任务</h2><button id="new-schedule">+ 新建任务</button></div><div id="task-form"></div>
    <div class="grid">${result.tasks.map((t) => `<article class="card"><div class="row"><h3>${esc(t.name)}</h3>${tag(t.pendingConfirm ? "待确认" : t.enabled ? "启用" : "暂停")}</div><p>${esc(t.scheduleText)}</p><p class="hint">${esc(t.nextRunText || "无下一次")} · ${esc(t.timezone)}</p><p>${esc(t.kind === "ai" ? t.instruction : t.text)}</p><p class="mono">${esc(t.targets.join(", "))}</p><div class="card-actions"><button data-task="edit" data-id="${t.id}">编辑</button><button data-task="toggle" data-id="${t.id}">${t.enabled ? "暂停" : "启用 / 确认"}</button><button data-task="run" data-id="${t.id}" ${status.mode === "isolated" || status.globalPaused ? "disabled" : ""}>立即执行</button><button data-task="delete" data-id="${t.id}">删除</button></div></article>`).join("") || '<div class="card empty">尚无任务。创建后可以先预览时间，再决定启用。</div>'}</div>
    <div class="section-title"><h2>最近执行记录</h2></div><div class="card">${
      result.history
        .slice(-20)
        .reverse()
        .map(
          (r) =>
            `<div class="record"><strong>#${r.taskId} · ${esc(r.status)}</strong><p>${esc(r.target)} · ${new Date(r.at).toLocaleString()} · ${esc(r.reason || "")}</p></div>`,
        )
        .join("") ||
      '<p class="hint">没有执行记录。保存和预览不会发送消息。</p>'
    }</div>`;
  $("#behavior-form").onsubmit = (e) =>
    action(async () => {
      e.preventDefault();
      const f = new FormData(e.target),
        num = (n) => Number(f.get(n));
      const next = structuredClone(config),
        agent = next.agents.find((x) => x.id === id);
      Object.assign(agent.behavior, {
        preSleepWaitMs: num("observe") * 1000,
        quietAfterNewMs: num("quiet") * 1000,
        batchWindowMs: num("batch") * 1000,
        replyCheckMs: num("reply") * 1000,
        maxWakePerHour: num("wakeHour"),
        maxSendPerHour: num("sendHour"),
        maxSendPerMinute: num("sendMinute"),
      });
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
      const f = new FormData(e.target),
        next = structuredClone(config),
        agent = next.agents.find((x) => x.id === id);
      for (const key of [
        "enabled",
        "allowAiPrivate",
        "allowAiOtherTargets",
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
  document.querySelectorAll("[data-task]").forEach(
    (button) =>
      (button.onclick = () =>
        action(async () => {
          const task = parityTasks.find(
              (t) => t.id === Number(button.dataset.id),
            ),
            kind = button.dataset.task;
          if (kind === "edit") return drawScheduleForm(task);
          await api("/api/schedules", {
            agentId: id,
            id: task.id,
            action: kind === "toggle" ? "update" : kind,
            task: { enabled: !task.enabled },
            requestId: crypto.randomUUID(),
          });
          await renderSchedules();
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
  $("#task-form").innerHTML =
    `<form id="schedule-form" class="card"><h3>${task ? "编辑任务" : "新建任务"}</h3><div class="form-grid">${parityField("name", "任务名称", t.name)}
    <label>内容方式<select name="kind">${parityOptions(
      [
        ["text", "固定文字"],
        ["ai", "叫 AI 来说"],
      ],
      t.kind,
    )}</select></label>
    <label class="wide">文字 / 给 AI 的说明<textarea name="content" required>${esc(t.kind === "ai" ? t.instruction : t.text)}</textarea></label>
    <label>发送目标（可多选）<select name="targets" multiple required>${parityOptions([...a.allow.groups.map((x) => ["group:" + x, "群 " + x]), ...a.allow.users.map((x) => ["private:" + x, "私聊 " + x])], null)}</select></label>
    <label>重复方式<select name="ruleType" id="rule-type">${parityOptions(Object.entries(scheduleLabels), t.schedule.type)}</select></label>
    <div id="rule-fields" class="form-grid wide"></div>${parityField("timezone", "时区", t.timezone)}${parityNumber("jitter", "随机偏移（分钟）", t.jitterMin)}
    ${parityField("maxRuns", "最多执行次数（空白不限）", t.maxRuns || "", "number")}${parityField("exclude", "排除日期（逗号分隔）", (t.schedule.excludeDates || []).join(","))}
    ${parityCheck("enabled", "保存后启用（暂停仍优先）", t.enabled)}</div><div class="card-actions"><button type="button" id="preview-schedule">预览接下来五次</button><button class="primary">保存任务</button><button type="button" id="cancel-schedule">取消</button></div><div id="schedule-preview" class="hint"></div></form>`;
  for (const option of $("#schedule-form").elements.targets.options)
    option.selected = t.targets.includes(option.value);
  const rules = () => {
    const type = $("#rule-type").value,
      r = type === t.schedule.type ? t.schedule : {};
    let html = "";
    if (["once", "everyNDays"].includes(type))
      html += parityField(
        "date",
        "日期",
        r.date || r.startDate || new Date().toISOString().slice(0, 10),
        "date",
      );
    if (
      !["dates", "cron", "interval", "dailyRandom", "monthlyRandom"].includes(
        type,
      )
    )
      html += parityField(
        "times",
        "时刻（多个用逗号分隔）",
        r.time || (r.times || ["09:00"]).join(","),
      );
    if (type === "weekly")
      html += parityField(
        "weekdays",
        "星期（1 周一 … 7 周日）",
        (r.weekdays || [1, 3, 5]).join(","),
      );
    if (type === "monthly")
      html += parityField(
        "days",
        "每月几号（-1 为月底）",
        (r.days || [1, -1]).join(","),
      );
    if (type === "monthlyWeekday")
      html +=
        parityNumber("nth", "第几个（-1 最后一个）", r.nth || 2, -1) +
        parityNumber("weekday", "星期（1—7）", r.weekday || 6, 1);
    if (type === "yearly")
      html += parityField(
        "dates",
        "月日（MM-DD，逗号分隔）",
        (r.dates || ["12-31"]).join(","),
      );
    if (type === "dates")
      html += `<label class="wide">特殊日期（每行 YYYY-MM-DD HH:mm）<textarea name="dates">${esc((r.items || []).map((x) => x.date + " " + x.time).join("\n"))}</textarea></label>`;
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
    if (type === "weekly") r.weekdays = list("weekdays").map(Number);
    if (type === "monthly") r.days = list("days").map(Number);
    if (type === "monthlyWeekday")
      Object.assign(r, { nth: num("nth"), weekday: num("weekday") });
    if (type === "yearly") r.dates = list("dates");
    if (type === "dates")
      r.items = String(f.get("dates"))
        .split("\n")
        .filter(Boolean)
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
      await api("/api/schedules", {
        agentId: parityAgentId,
        action: parityEditing ? "update" : "create",
        id: parityEditing,
        task: read(),
      });
      parityEditing = null;
      await renderSchedules();
      notice("任务已保存");
    });
  $("#cancel-schedule").onclick = () => {
    $("#task-form").innerHTML = "";
    parityEditing = null;
  };
}
async function renderVoices() {
  const id = parityAgentId,
    result = await api("/api/voices?agentId=" + encodeURIComponent(id));
  if (tab !== "voices" || id !== parityAgentId) return;
  $("#parity-body").innerHTML =
    `<div class="card"><h2>导入语音</h2><p class="hint">每个角色单独保存。导入会校验音频；试听只在本机播放，不向 QQ 投递。</p><form id="voice-import"><div class="form-grid">${parityField("title", "语音名称")}<label>音频文件<input name="audio" type="file" accept="audio/*,.silk,.slk" required></label></div><button class="primary">导入</button></form></div><div class="section-title"><h2>角色语音 · ${result.total}</h2></div><div class="grid">${result.items.map((m) => `<article class="card"><h3>${esc(m.title)}</h3><p>${m.duration == null ? "时长未提供" : m.duration.toFixed(1) + " 秒"} · ${esc(m.codec)} · ${(m.bytes / 1024).toFixed(1)} KB</p><button data-audio="${esc(m.id)}">本机试听</button></article>`).join("") || '<div class="card empty">暂无语音。可导入素材或由已配置的音频 MCP 生成。</div>'}</div><audio id="voice-player" controls hidden></audio>`;
  $("#voice-import").onsubmit = (e) =>
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
async function renderOperations() {
  const id = parityAgentId,
    a = find("agents", id),
    ops = await api("/api/operations");
  if (tab !== "operations" || id !== parityAgentId) return;
  const confirmOff = disabledReason([
    [status.mode === "isolated" || status.globalPaused, "opsBlocked"],
  ]);
  $("#parity-body").innerHTML =
    `${features.slang ? `<div class="card"><h2>黑话候选</h2><div class="toolbar"><label>来源<select id="slang-source">${parityOptions(a.allow.groups.map((x) => ["group:" + x, "群 " + x]))}</select></label><button id="load-slang">读取候选</button></div><p class="hint">候选与联网资料不自动成为事实，确认后才标为已确认。</p><div id="slang-rows"></div></div>` : ""}<div class="section-title"><h2>管理员操作</h2><button id="revoke-ops">回落到 L0 并撤销待批准项</button></div><div class="banner">${a.operations.enabled ? "只接受管理员私聊身份；级别有时限，写入与命令逐项确认。" : "运维工具当前关闭。可在完整配置中指定专用工作区及允许命令后开启。"}</div>${
      ops.pending
        .filter((p) => p.agentId === id)
        .map(
          (p) =>
            `<form class="card ops-confirm" data-id="${esc(p.id)}" data-conversation="${esc(p.conversation)}"><h3>${esc(p.operation.type)} · ${esc(p.conversation)}</h3><pre>${esc(JSON.stringify(p.operation, null, 2))}</pre><p>本次确认码：${esc(p.confirmationCode)} · 两分钟内有效</p><div class="form-grid">${parityField("code", "输入本次确认码")}${parityField("otp", "L3 动态码", "", "password")}</div><button ${disabledAttr(confirmOff)}>确认此项操作</button>${disabledHints(confirmOff)}</form>`,
        )
        .join("") || '<div class="card empty">没有待确认操作。</div>'
    }`;
  if ($("#load-slang"))
    $("#load-slang").onclick = () =>
      action(async () => {
        const conversation = $("#slang-source").value;
        if (!conversation) return;
        const s = await api(
          `/api/slang?agentId=${encodeURIComponent(id)}&conversation=${encodeURIComponent(conversation)}`,
        );
        $("#slang-rows").innerHTML =
          (s.entries || [])
            .map(
              (e) =>
                `<div class="record"><strong>${esc(e.term)}</strong> ${tag(e.status)}<p>${esc(e.meaning)}</p><p class="hint">证据 ${e.evidenceIds.length} 条${e.research ? " · 已有研究资料，待人工核对" : ""}</p><button data-slang="${esc(e.id)}" data-state="confirmed">确认</button> <button data-slang="${esc(e.id)}" data-state="rejected">否决</button></div>`,
            )
            .join("") || '<p class="hint">没有候选</p>';
        document.querySelectorAll("[data-slang]").forEach(
          (b) =>
            (b.onclick = () =>
              action(async () => {
                await api("/api/slang", {
                  agentId: id,
                  conversation,
                  id: b.dataset.slang,
                  status: b.dataset.state,
                });
                $("#load-slang").click();
              })),
        );
      });
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
