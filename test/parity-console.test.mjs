import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { config as makeConfig } from "./helpers.mjs";
import { validateConfig } from "../src/core/config.mjs";

// 作息与定时, 语音 and 受保护工作 (public/parity.js) on the real console
// helpers from app.js: what the page is for comes first, settings fold below
// with their state in the summary row, and forms still save the same shapes.
function kit({ cfg = makeConfig(1), routes = {}, mode = "live" } = {}) {
  const nodes = new Map(),
    lists = {},
    calls = [],
    notices = [];
  const node = (s) => {
    if (!nodes.has(s))
      nodes.set(s, {
        innerHTML: "",
        dataset: {},
        style: {},
        values: {},
        classList: { add() {}, remove() {}, toggle() {} },
        addEventListener() {},
        setAttribute() {},
        querySelector: () => null,
        querySelectorAll: () => [],
      });
    return nodes.get(s);
  };
  let confirmed = true;
  const listeners = {};
  const sandbox = vm.createContext({
    document: {
      querySelector: node,
      querySelectorAll: (s) => lists[s] || [],
      addEventListener: (type, fn) => (listeners[type] ||= []).push(fn),
      body: { classList: { remove() {}, toggle() {} } },
    },
    Event: class {
      constructor(type) {
        this.type = type;
      }
    },
    sessionStorage: { getItem: () => "" },
    localStorage: { getItem: () => null, setItem() {} },
    setInterval() {},
    setTimeout() {},
    clearTimeout() {},
    fetch: () => new Promise(() => {}),
    URLSearchParams,
    structuredClone,
    crypto: { randomUUID: () => "request-1" },
    confirm: () => confirmed,
    // Form values by name; a list stands for several checked boxes.
    FormData: class {
      constructor(form) {
        this.v = form?.values ?? form ?? {};
      }
      get(k) {
        const x = this.v[k];
        return x === undefined ? null : Array.isArray(x) ? x[0] : x;
      }
      getAll(k) {
        return this.v[k] === undefined ? [] : [].concat(this.v[k]);
      }
      has(k) {
        return k in this.v;
      }
    },
  });
  for (const file of ["app.js", "parity.js"])
    vm.runInContext(
      fs.readFileSync(new URL(`../public/${file}`, import.meta.url), "utf8"),
      sandbox,
    );
  sandbox.__setup = {
    cfg,
    status: { mode, globalPaused: false, agents: [] },
    notices,
    api: async (url, payload, method) => {
      calls.push({ url, payload: structuredClone(payload), method });
      if (url === "/api/config") {
        const saved = validateConfig(payload.config);
        vm.runInContext(
          "config = __saved",
          Object.assign(sandbox, { __saved: saved }),
        );
        return {};
      }
      const route = Object.keys(routes).find((r) => url.startsWith(r));
      return route ? routes[route](payload) : {};
    },
  };
  vm.runInContext(
    `config = __setup.cfg; status = __setup.status; revision = "r1";
     api = __setup.api; load = async () => {}; notice = (m) => __setup.notices.push(m);
     parityAgentId = config.agents[0].id;`,
    sandbox,
  );
  const run = (code) => vm.runInContext(code, sandbox);
  return {
    run,
    node,
    lists,
    calls,
    notices,
    config: () => run("config"),
    confirm: (yes) => (confirmed = yes),
    fire: (type, target) =>
      (listeners[type] || []).forEach((fn) => fn({ target })),
  };
}
const order = (html, ...marks) => {
  const at = marks.map((m) => html.indexOf(m));
  assert.ok(
    at.every((x, i) => x >= 0 && (i === 0 || x > at[i - 1])),
    `expected in this order: ${marks.join(" → ")}`,
  );
};
const T = Date.parse("2026-10-29T01:00:00Z");
const task = (extra = {}) => ({
  id: 1,
  name: "早安问候",
  kind: "text",
  text: "早上好",
  instruction: "",
  schedule: { type: "daily", times: ["09:00"], excludeDates: [] },
  targets: ["group:20000"],
  timezone: "Asia/Shanghai",
  enabled: true,
  pendingConfirm: false,
  jitterMin: 0,
  maxRuns: null,
  scheduleText: "每天 09:00",
  nextRunText: "2026-10-30 09:00（北京时间 UTC+8）",
  ...extra,
});

test("the schedule page lists tasks and runs first and folds its settings with their state", async () => {
  const cfg = makeConfig(1),
    a = cfg.agents[0];
  a.behavior.batchWindowMs = 10000;
  a.wake.keywords = ["早安", "开会"];
  a.scheduler.enabled = true;
  a.scheduler.totalPerDay = 20;
  const k = kit({
    cfg,
    routes: {
      "/api/schedules": () => ({
        tasks: [task(), task({ id: 2, name: "周报", enabled: false })],
        history: [
          {
            taskId: 1,
            target: "group:20000",
            status: "skipped",
            reason: "QUIET_HOURS",
            at: T,
          },
          { taskId: 2, target: "private:30000", status: "sent", at: T + 1 },
        ],
      }),
    },
  });
  k.run('tab = "schedule"; renderParity("schedule")');
  await new Promise((r) => setImmediate(r));
  // Role pages follow the section bar's role; only the system page has a picker.
  assert.doesNotMatch(k.node("#content").innerHTML, /parity-agent/);
  const html = k.node("#parity-body").innerHTML;
  order(
    html,
    "定时任务 · 2",
    'class="card task-list"',
    "最近执行记录",
    'data-fold="schedule-wake"',
    'data-fold="schedule-settings"',
  );
  // Folded unless this browser opened them, each with its state in the summary.
  for (const id of [
    "schedule-wake",
    "schedule-wake-more",
    "schedule-settings",
    "schedule-settings-more",
  ])
    assert.match(html, new RegExp(`data-fold="${id}"><summary>`));
  assert.match(
    html,
    /<span class="fold-title">唤醒与回复节奏<\/span><span class="fold-summary">@、叫名字、2 个关键词和拍一拍会唤醒 · 合并窗口 10 秒<\/span>/,
  );
  assert.match(
    html,
    /<span class="fold-title">定时任务设置<\/span><span class="fold-summary">已启用 · 时区 Asia\/Shanghai · 每日上限 20<\/span>/,
  );
  assert.match(
    html,
    /class="card fold fold-inner" data-fold="schedule-wake-more"/,
  );
  // Runs read as state, task and target, with reasons in words.
  assert.match(
    html,
    /已跳过<\/span><span class="run-what" title="#1 早安问候 → 群 20000 · 免打扰时段">/,
  );
  assert.match(
    html,
    /已发送<\/span><span class="run-what" title="#2 周报 → 私聊 30000">/,
  );
  // Keywords and speakers are chips; the speaker box offers people.
  assert.match(html, /data-chips="text"[^]*name="keywords" value="早安,开会"/);
  assert.match(html, /data-ids="person"[^]*name="speakers"/);
  assert.match(html, /<select name="timezone">/);
  assert.match(html, /data-chips="date"[^]*name="holidays" value=""/);
  // A switched-off scheduler says so above the list.
  a.scheduler.enabled = false;
  await k.run("renderSchedules()");
  assert.match(k.node("#parity-body").innerHTML, /定时任务总开关没有打开/);
});

test("each task is one fixed row: name, next run, rule, switch and edit", () => {
  const k = kit();
  const row = k.run(
    `scheduleRow(${JSON.stringify(task({ name: "很长的名字".repeat(20) }))})`,
  );
  assert.match(row, /<strong class="task-name" title="(很长的名字){20}">/);
  assert.match(
    row,
    /<p class="task-next" title="[^"]+"><span>下次<\/span>2026-10-30 09:00/,
  );
  assert.match(
    row,
    /<p class="task-rule" title="每天 09:00 · 群 20000 · 固定文字">/,
  );
  assert.match(
    row,
    /<input type="checkbox" data-task-toggle="1" checked aria-label="启用「/,
  );
  assert.match(row, /<button type="button" data-task-edit="1">编辑<\/button>/);
  // Run now and delete moved into the editor, so rows keep their shape.
  assert.doesNotMatch(row, /立即执行|删除/);
  const pending = k.run(
    `scheduleRow(${JSON.stringify(task({ enabled: false, pendingConfirm: true, kind: "ai" }))})`,
  );
  assert.match(pending, /待确认/);
  assert.match(
    pending,
    /<p class="task-next" title="等待确认后开始">等待确认后开始/,
  );
  assert.match(pending, /aria-label="确认并启用「早安问候」"/);
  assert.match(pending, /叫 AI 来说/);
  assert.match(
    k.run(`scheduleRow(${JSON.stringify(task({ enabled: false }))})`),
    /class="task-row is-off"[^]*<p class="task-next" title="已暂停">已暂停<\/p>/,
  );
});

test("the task switch saves enabled and redraws even when refused", async () => {
  let refuse = false;
  const k = kit({
    routes: {
      "/api/schedules": (p) => {
        if (p && refuse) throw Error("TASK_TARGET_NOT_ALLOWED");
        return { tasks: [task()], history: [] };
      },
    },
  });
  k.run('tab = "schedule"');
  await k.run("renderSchedules()");
  const box = { dataset: { taskToggle: "1" }, checked: false };
  k.lists["[data-task-toggle]"] = [box];
  await k.run("renderSchedules()");
  k.calls.length = 0;
  await box.onchange();
  assert.deepEqual(k.calls[0].payload, {
    agentId: "agent-0",
    id: 1,
    action: "update",
    task: { enabled: false },
    requestId: "request-1",
  });
  assert.equal(k.calls.at(-1).url, "/api/schedules?agentId=agent-0");
  refuse = true;
  k.calls.length = 0;
  await box.onchange();
  assert.deepEqual(k.notices.at(-1), "TASK_TARGET_NOT_ALLOWED");
  assert.equal(k.calls.at(-1).url, "/api/schedules?agentId=agent-0");
});

test("chips keep the comma list for words and dates and one per line for dated times", () => {
  const k = kit();
  const words = k.run('chips("keywords", "关键词", "早安，开会,早安 ,")');
  assert.match(
    words,
    /<input type="hidden" name="keywords" value="早安,开会">/,
  );
  assert.equal(words.match(/class="ids-chip"/g).length, 2);
  assert.match(words, /data-chips-remove="早安"/);
  // Escaped like everything else on the page.
  assert.match(
    k.run('chips("keywords", "关键词", ["<b>"])'),
    /value="&lt;b&gt;"/,
  );
  // Dates and times read in order, whatever order they were saved in.
  assert.match(
    k.run(
      'chips("holidays", "节假日", ["2026-10-02", "2026-10-01"], { kind: "date" })',
    ),
    /name="holidays" value="2026-10-01,2026-10-02"[^]*<input type="date"/,
  );
  assert.match(
    k.run(
      'chips("dates", "特殊日期", ["2026-12-01 18:30", "2026-11-01 09:00"], { kind: "when" })',
    ),
    /name="dates" value="2026-11-01 09:00\n2026-12-01 18:30"[^]*<input type="date" aria-label="日期"><input type="time"/,
  );
  assert.match(k.run('chips("x", "空", [])'), /还没有/);
});

test("wake and scheduler forms save the same shapes as before", async () => {
  const k = kit({
    routes: { "/api/schedules": () => ({ tasks: [], history: [] }) },
  });
  k.run('tab = "schedule"');
  await k.run("renderSchedules()");
  const submit = (id, values) =>
    k.node(id).onsubmit({ preventDefault() {}, target: values });
  const values = {
    rhythmEnabled: "on",
    rhythmTimezone: "Asia/Tokyo",
    rhythmStart: "23:00",
    rhythmEnd: "08:00",
    rhythmMode: "defer",
    rhythmOwners: "on",
    rhythmJitter: "0.25",
    rhythmProbability: "0.25",
    rhythmMin: "1.5",
    rhythmMax: "8",
    keywords: "早安,开会",
    speakers: "30000,30001",
    poke: "on",
    quiet: "10",
    batch: "4",
    batchMax: "12",
    observe: "300",
    reply: "30",
    wakeHour: "60",
    sendMinute: "2",
    sendHour: "10",
    conversationSendMinute: "",
    conversationSendHour: "",
  };
  const html = k.node("#parity-body").innerHTML;
  const initial =
    /<input type="range" data-range="rhythmProbability" min="0" max="1" step="0.01" value="0.1" data-unit="%"><input type="hidden" name="rhythmProbability" value="([^"]+)"><output>10%<\/output>/.exec(
      html,
    );
  assert.ok(
    initial,
    "the actual percentage helper renders a normalized probability as 10%",
  );
  assert.match(
    html,
    /data-range="typingJitter"[^]*?value="0.35"[^]*?<output>35%<\/output>/,
  );
  // Saving untouched markup preserves the stored probability, even when other settings change.
  await submit("#behavior-form", { ...values, rhythmProbability: initial[1] });
  const agent = () => k.config().agents[0];
  assert.equal(agent().behavior.rhythm.lateReply.probability, 0.1);
  assert.match(k.notices.at(-1), /已保存并生效/);
  assert.doesNotMatch(k.notices.at(-1), /需手动重连|需要手动重新连接/);
  const output = { textContent: "10%" },
    hidden = { value: initial[1] };
  const slider = {
    type: "range",
    value: "0.25",
    dataset: { unit: "%" },
    parentElement: {
      querySelector: (selector) => (selector === "output" ? output : hidden),
    },
  };
  k.fire("input", slider);
  assert.equal(output.textContent, "25%");
  assert.equal(hidden.value, "0.25");
  await submit("#behavior-form", {
    ...values,
    rhythmProbability: hidden.value,
  });
  assert.deepEqual(agent().wake.keywords, ["早安", "开会"]);
  assert.deepEqual(agent().wake.speakerIds, ["30000", "30001"]);
  assert.equal(agent().wake.poke, true);
  assert.equal(agent().wake.joins, false);
  assert.equal(agent().behavior.batchWindowMs, 4000);
  assert.equal(agent().behavior.quietAfterNewMs, 10000);
  assert.deepEqual(agent().behavior.rhythm, {
    enabled: true,
    timezone: "Asia/Tokyo",
    sleep: { start: "23:00", end: "08:00" },
    sleepMode: "defer",
    urgentOwners: true,
    wakeJitterMs: 15000,
    lateReply: { probability: 0.25, minMs: 90000, maxMs: 480000 },
  });
  await submit("#schedule-settings", {
    enabled: "on",
    quietEnabled: "on",
    totalPerDay: "50",
    perTaskPerDay: "12",
    perGroupPerDay: "10",
    missedGraceMin: "10",
    jitterMin: "0",
    timezone: "Asia/Tokyo",
    quietStart: "00:00",
    quietEnd: "07:00",
    holidays: "2026-10-01,2026-10-02",
  });
  assert.equal(agent().scheduler.timezone, "Asia/Tokyo");
  assert.deepEqual(agent().scheduler.holidays, ["2026-10-01", "2026-10-02"]);
  assert.equal(agent().scheduler.enabled, true);
});

test("time zones are a list with common ones first, keeping a saved zone the list lacks", () => {
  const k = kit();
  const html = k.run('zoneSelect("timezone", "时区", "Asia/Shanghai")');
  assert.match(
    html,
    /<optgroup label="常用"><option value="Asia\/Shanghai" selected>北京时间 · Asia\/Shanghai<\/option>/,
  );
  assert.equal(html.match(/ selected>/g).length, 1);
  assert.match(html, /<optgroup label="全部">/);
  const odd = k.run('zoneSelect("timezone", "时区", "Mars/Olympus")');
  assert.match(
    odd,
    /<option value="Mars\/Olympus" selected>Mars\/Olympus<\/option>/,
  );
});

test("the task editor picks dates, times, weekdays and targets but sends the same task", async () => {
  const k = kit({
    routes: { "/api/schedules": () => ({ tasks: [], history: [] }) },
  });
  k.run('tab = "schedule"');
  const items = [
    { date: "2026-11-01", time: "09:00" },
    { date: "2026-12-01", time: "18:30" },
  ];
  k.node("#rule-type").value = "dates";
  k.run(
    `drawScheduleForm(${JSON.stringify(task({ schedule: { type: "dates", items, excludeDates: ["2026-11-02"] } }))})`,
  );
  const form = k.node("#task-form").innerHTML;
  assert.match(
    form,
    /<fieldset class="pick wide"><legend>发送目标（可多选）<\/legend><label class="check"><input type="checkbox" name="targets" value="group:20000" checked>群 20000/,
  );
  assert.match(form, /<option value="Asia\/Shanghai" selected>/);
  assert.match(form, /data-chips="date"[^]*name="exclude" value="2026-11-02"/);
  // Editing an existing task offers run-now and a delete that asks first.
  assert.match(form, /id="run-schedule"[^>]*>立即执行一次/);
  assert.match(form, /class="danger" id="delete-schedule">删除任务/);
  assert.match(
    k.node("#rule-fields").innerHTML,
    /data-chips="when"[^]*name="dates" value="2026-11-01 09:00\n2026-12-01 18:30"/,
  );
  const values = {
    name: "纪念日",
    kind: "text",
    content: "到了",
    targets: ["group:20000", "private:30000"],
    ruleType: "dates",
    dates: "2026-11-01 09:00\n2026-12-01 18:30",
    timezone: "Asia/Shanghai",
    jitter: "0",
    maxRuns: "",
    exclude: "2026-11-02,2026-11-03",
    enabled: "on",
  };
  k.node("#schedule-form").values = values;
  k.calls.length = 0;
  await k.node("#schedule-form").onsubmit({ preventDefault() {} });
  assert.deepEqual(k.calls[0].payload, {
    agentId: "agent-0",
    action: "update",
    id: 1,
    task: {
      name: "纪念日",
      kind: "text",
      text: "到了",
      targets: ["group:20000", "private:30000"],
      schedule: {
        type: "dates",
        items,
        excludeDates: ["2026-11-02", "2026-11-03"],
      },
      timezone: "Asia/Shanghai",
      jitterMin: 0,
      maxRuns: null,
      enabled: true,
    },
  });
  // Weekly: boxes for weekdays, chips for times.
  k.node("#rule-type").value = "weekly";
  k.run("drawScheduleForm(null)");
  const weekly = k.node("#rule-fields").innerHTML;
  assert.match(weekly, /name="weekdays" value="1" checked>周一/);
  assert.match(weekly, /name="weekdays" value="2" >周二/);
  assert.match(weekly, /data-chips="time"[^]*name="times" value="09:00"/);
  k.node("#schedule-form").values = {
    ...values,
    ruleType: "weekly",
    times: "09:00,18:00",
    weekdays: ["1", "5"],
    exclude: "",
  };
  k.calls.length = 0;
  await k.node("#preview-schedule").onclick();
  assert.deepEqual(k.calls[0].payload.task.schedule, {
    type: "weekly",
    times: ["09:00", "18:00"],
    weekdays: [1, 5],
    excludeDates: [],
  });
  // No target: the console says so instead of sending.
  k.node("#schedule-form").values = { ...values, targets: [] };
  k.calls.length = 0;
  await k.node("#schedule-form").onsubmit({ preventDefault() {} });
  assert.equal(k.calls.length, 0);
  assert.equal(k.notices.at(-1), "至少选一个发送目标");
});

test("deleting a task asks first", async () => {
  const k = kit({
    routes: { "/api/schedules": () => ({ tasks: [], history: [] }) },
  });
  k.run('tab = "schedule"');
  k.node("#rule-type").value = "daily";
  k.run(`drawScheduleForm(${JSON.stringify(task())})`);
  k.confirm(false);
  await k.node("#delete-schedule").onclick();
  assert.equal(k.calls.length, 0);
  k.confirm(true);
  await k.node("#delete-schedule").onclick();
  assert.equal(k.calls[0].payload.action, "delete");
  assert.equal(k.calls[0].payload.id, 1);
  assert.equal(k.notices.at(-1), "任务已删除");
});

// The special-date add row starts at 09:00 with no date. Left alone it is
// not a pending date: preview and save go through with the saved dates, and
// no warning is left on the row to block the browser's form check.
test("an untouched special-date row neither blocks nor joins preview and save", async () => {
  const k = kit({
    routes: { "/api/schedules": () => ({ tasks: [], history: [] }) },
  });
  k.run('tab = "schedule"');
  const items = [{ date: "2026-11-01", time: "09:00" }];
  k.node("#rule-type").value = "dates";
  k.run(
    `drawScheduleForm(${JSON.stringify(task({ schedule: { type: "dates", items, excludeDates: [] } }))})`,
  );
  const field = (value) => ({
    value,
    warning: "",
    reported: false,
    setCustomValidity(m) {
      this.warning = m;
    },
    reportValidity() {
      this.reported = true;
    },
    closest: (s) => (s === ".chips-add" ? {} : null),
  });
  const date = field(""),
    time = field("09:00"),
    hidden = { value: "2026-11-01 09:00", dispatchEvent() {} },
    shown = { innerHTML: "" };
  const box = {
    dataset: { chips: "when" },
    querySelector: (s) =>
      ({
        ".chips-add input": date,
        'input[type="hidden"]': hidden,
        ".ids-chips": shown,
      })[s] ?? null,
    querySelectorAll: (s) => (s === ".chips-add input" ? [date, time] : []),
  };
  const form = k.node("#schedule-form");
  form.querySelectorAll = (s) => (s === "[data-chips]" ? [box] : []);
  form.values = {
    name: "纪念日",
    kind: "text",
    content: "到了",
    targets: ["group:20000"],
    ruleType: "dates",
    dates: hidden.value,
    timezone: "Asia/Shanghai",
    jitter: "0",
    maxRuns: "",
    exclude: "",
  };
  const sent = () =>
    k.calls.filter((c) => c.payload).map((c) => c.payload.action);
  await k.node("#preview-schedule").onclick();
  assert.deepEqual(k.calls[0].payload.task.schedule.items, items);
  await form.onsubmit({ preventDefault() {} });
  assert.deepEqual(sent(), ["preview", "update"]);
  assert.equal(date.warning, "");
  assert.equal(date.reported, false);
  assert.equal(hidden.value, "2026-11-01 09:00");
  // A picked date takes the row's time and joins the list.
  date.value = "2026-12-24";
  k.calls.length = 0;
  await k.node("#preview-schedule").onclick();
  assert.deepEqual(sent(), ["preview"]);
  assert.equal(hidden.value, "2026-11-01 09:00\n2026-12-24 09:00");
  assert.equal(date.value, "");
  // A picked date without a time stops both, saying why, and the warning
  // goes away once the row is left.
  date.value = "2027-01-01";
  time.value = "";
  k.calls.length = 0;
  await k.node("#preview-schedule").onclick();
  await form.onsubmit({ preventDefault() {} });
  assert.deepEqual(sent(), []);
  assert.equal(k.notices.at(-1), "还没添加的日期缺少时刻，补上时刻或清空日期");
  assert.equal(time.warning, "先选好日期和时刻");
  assert.equal(time.reported, true);
  assert.equal(date.value, "2027-01-01");
  k.fire("focusout", time);
  assert.equal(time.warning, "");
});

test("the voice page lists voices first and opens the import form on demand", async () => {
  const k = kit({
    routes: {
      "/api/voices": () => ({
        total: 1,
        items: [
          {
            id: "v1",
            title: "很长的语音名".repeat(10),
            duration: 3.25,
            codec: "mp3",
            bytes: 2048,
          },
        ],
      }),
    },
  });
  k.run('tab = "voices"; renderParity("voices")');
  await new Promise((r) => setImmediate(r));
  const html = k.node("#parity-body").innerHTML;
  order(
    html,
    "角色语音 · 1",
    "+ 导入语音",
    '<form id="voice-import" class="card" hidden>',
    'class="voice-list"',
  );
  assert.match(html, /<h3 title="(很长的语音名){10}">/);
  assert.match(html, /3\.3 秒 · mp3 · 2\.0 KB/);
  const form = k.node("#voice-import");
  form.hidden = true;
  k.node("#voice-import-open").onclick();
  assert.equal(form.hidden, false);
  k.node("#voice-import-cancel").onclick();
  assert.equal(form.hidden, true);
});

test("protected work and operations come first, settings fold and dangerous steps ask", async () => {
  const cfg = makeConfig(1);
  cfg.agents[0].allow.users = ["30000"];
  const k = kit({
    cfg,
    routes: {
      "/api/operations": () => ({
        pending: [
          {
            id: "op-1",
            agentId: "agent-0",
            conversation: "@work:abc",
            operation: { type: "write", path: "notes.txt" },
            confirmationCode: "123456",
          },
        ],
        levels: [{ key: "agent-0|@work:abc", level: "L2", grantedAt: T }],
      }),
      "/api/protected-work": () => ({
        tasks: [
          {
            id: "w1",
            status: "review",
            createdAt: T,
            instruction: "整理".repeat(200),
            repositories: [],
            operations: true,
            revision: 1,
            result: { text: "结果", digest: "d" },
          },
        ],
      }),
    },
  });
  k.run('tab = "operations"; renderParity("operations")');
  await new Promise((r) => setImmediate(r));
  // The system page keeps its own role picker.
  assert.match(k.node("#content").innerHTML, /id="parity-agent"/);
  const html = k.node("#parity-body").innerHTML;
  order(
    html,
    '<section id="protected-work">',
    "管理员操作 · 待确认 1",
    "L2",
    'class="ops-confirm"',
    'data-fold="ops-settings"><summary>',
    'class="card danger-zone"',
  );
  assert.match(html, /<span class="fold-summary">运维工具已关闭<\/span>/);
  assert.match(html, /<button class="danger" >确认执行此项操作<\/button>/);
  assert.match(html, /<button type="button" class="danger" id="revoke-ops">/);
  const work = k.node("#protected-work").innerHTML;
  order(
    work,
    "受保护工作 · 1",
    "+ 新建任务",
    '<form id="work-create" class="card" hidden>',
    'class="work-list"',
  );
  assert.match(work, /<p class="work-text" title="(整理){200}">/);
  assert.match(work, /待审阅/);
  assert.match(work, /class="danger" data-work-cancel="w1">取消任务/);
  assert.match(work, /<button class="danger">批准解除这段结果的保护<\/button>/);
  // Falling back to L0 and cancelling work both ask first.
  k.confirm(false);
  k.calls.length = 0;
  await k.node("#revoke-ops").onclick();
  assert.equal(k.calls.length, 0);
  const cancel = { dataset: { workCancel: "w1" } };
  k.lists["[data-work-run],[data-work-cancel]"] = [cancel];
  await k.run('renderProtectedWork("agent-0")');
  k.calls.length = 0;
  await cancel.onclick();
  assert.equal(k.calls.length, 0);
  k.confirm(true);
  await cancel.onclick();
  assert.deepEqual(k.calls[0].payload, {
    agentId: "agent-0",
    taskId: "w1",
    action: "cancel",
  });
  k.calls.length = 0;
  await k.node("#revoke-ops").onclick();
  assert.deepEqual(k.calls[0].payload, {
    action: "revoke",
    agentId: "agent-0",
  });
});
