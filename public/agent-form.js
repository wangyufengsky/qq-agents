// Agent editor: builds the sectioned form, wires its widgets and turns the
// submitted form back into an agent row. The saved shape is unchanged: the
// same `tools` names, `silence` objects and `wake.cooldownMs`.
// Top-level code only declares values so tests can load this file in a VM.

// Every tool belongs to exactly one group (test/agent-form.test.mjs checks
// this against TOOL_NAMES). Tools missing here still show under "其他".
// `managedBy` groups are rewritten by their own page, so the editor only
// shows their state and keeps them as they were.
const AGENT_TOOL_GROUPS = [
  {
    id: "chat",
    title: "聊天发言",
    desc: "在群聊和私聊里发消息、分条回复、拍一拍、转发和标记已读。",
    tools: {
      qq_send: "发送文字或图片",
      qq_send_burst: "分多条连续发送",
      qq_mark_read: "标记已读",
      qq_wait_for_messages: "等待对方继续说完",
      qq_send_poke: "拍一拍",
      qq_forward_read: "展开合并转发",
      qq_forward_send: "发送合并转发",
      qq_cross_group_query: "查询已授权的跨群统计",
    },
  },
  {
    id: "memory",
    title: "记忆与日记",
    desc: "回忆过去的经历、翻阅聊天记录、写日记。",
    tools: {
      memory_search: "检索经历与日记",
      memory_related: "查看引用与撤回关系",
      memory_read: "展开记录原文",
      conversation_read: "按会话翻阅聊天记录",
      diary_write: "写日记",
      diary_revise: "修订日记",
      slang_query: "查询黑话候选",
      slang_submit: "提交黑话候选",
      slang_research: "联网研究黑话",
    },
  },
  {
    id: "media",
    title: "图片与表情",
    desc: "看图、保存图片、收藏和发送表情，包括 QQ 官方收藏表情。",
    tools: {
      qq_image_read: "查看聊天中的图片",
      image_save: "保存图片到图片库",
      media_list: "浏览自己的图片库",
      generated_image_list: "列出生成的图片",
      sticker_list: "搜索表情收藏",
      sticker_collect: "收藏表情",
      sticker_read: "查看表情或动图",
      qq_official_stickers: "读取 QQ 官方收藏表情",
      qq_official_sticker_read: "登记官方表情到图片库",
      qq_official_sticker_collect: "收藏到 QQ 官方表情",
      qq_official_sticker_remark: "修改官方表情备注",
    },
  },
  {
    id: "voice",
    title: "语音",
    desc: "使用自己的语音库发送语音，或用本机 TTS 合成语音。",
    tools: {
      qq_list_voices: "查看语音库",
      qq_voice_read: "读取语音",
      qq_send_voice: "发送语音",
      voice_synthesize: "合成语音（TTS）",
    },
  },
  {
    id: "files",
    title: "文件收发",
    desc: "下载、生成和发送文件，使用自己的独立文件库。",
    managedBy: { tab: "permissions", page: "文件", policy: "files" },
    tools: {
      file_list: "查看文件库",
      file_download: "下载文件",
      file_create: "生成文本文件",
      file_import: "从指定目录导入",
      qq_send_file: "发送文件",
    },
  },
  {
    id: "apps",
    title: "平台浏览与分享",
    desc: "自主浏览已授权的内容平台，并把看到的内容分享到聊天。",
    managedBy: { tab: "apps", page: "浏览与分享", policy: "apps" },
    tools: {
      app_capabilities: "查看平台入口",
      app_boards: "查看板块",
      app_browse: "浏览推荐与热门",
      app_search: "在平台内搜索",
      app_read: "阅读正文",
      app_record: "继续阅读已保存正文",
      app_comments: "阅读评论",
      app_history: "查看浏览历史",
      app_image: "保存浏览到的图片",
      app_share_propose: "提议分享",
      app_share_send: "在聊天中分享",
      qq_read_share_card: "读取 QQ 分享卡片",
    },
  },
  {
    id: "web",
    title: "浏览与联网",
    desc: "读取公开网页、截图、只读社交平台内容，以及管理员允许的外部工具。",
    tools: {
      web_fetch: "读取公开网页",
      web_screenshot: "网页截图",
      app_screenshot: "已浏览 App 页面截图",
      social_search: "社交平台搜索",
      social_read: "社交平台阅读",
      social_comments: "社交平台评论",
      social_status: "社交平台连接状态",
      external_tools: "列出外部工具",
      external_tool: "调用外部工具",
    },
  },
  {
    id: "schedule",
    title: "定时与作息",
    desc: "管理员私聊中登记定时任务，自己设置睡眠、唤醒条件和潜水。",
    tools: {
      qq_schedule_create: "创建定时任务",
      qq_schedule_list: "查看定时任务",
      qq_schedule_update: "修改定时任务",
      qq_schedule_delete: "删除定时任务",
      qq_set_wake_config: "设置睡眠与条件唤醒",
      qq_set_silence: "让当前会话潜水",
    },
  },
  {
    id: "self",
    title: "Self 与主体",
    desc: "读取和提议成长自己的 self，记录未完成的话题，发起主动聊天意图。",
    tools: {
      self_read: "读取当前 self",
      self_history: "查看 self 历史",
      self_candidates: "查看候选成长",
      self_propose: "提出成长候选",
      self_review: "回顾候选（仅主体）",
      self_withdraw: "撤回候选",
      work_note: "记录未完成话题",
      work_notes: "查看未完成话题",
      person_note: "记下人物卡（称呼与印象）",
      person_notes: "查看人物卡",
      mood_set: "记下当前心情与原因",
      mood_read: "查看自己的心情",
      intent_create: "创建主动意图",
      intent_list: "查看主动意图",
      intent_update: "暂缓或取消意图",
      subject_log: "记录空闲时间（主体自动可用）",
      intent_decide: "决定是否执行意图",
    },
  },
  {
    id: "ops",
    title: "运维",
    desc: "只在独立受保护工作任务中使用，写入和命令仍需逐项确认。",
    tools: {
      protected_work_submit: "提交受保护任务结果（工作区自动可用）",
      ops_request_level: "申请运维等级",
      ops_read: "读取工作区文件",
      ops_propose: "提议写文件或运行命令",
      ops_result: "读取已确认结果",
    },
  },
  {
    id: "github",
    title: "GitHub",
    desc: "只读搜索和阅读 GitHub 仓库，登录方式在「高级」中设置。",
    tools: {
      github_capabilities: "查看 GitHub 权限",
      github_search: "搜索仓库与代码",
      github_read: "阅读仓库文件",
    },
  },
];

const SILENCE_TIMEZONES = [
  ["Asia/Shanghai", "北京时间（Asia/Shanghai）"],
  ["Asia/Hong_Kong", "香港（Asia/Hong_Kong）"],
  ["Asia/Taipei", "台北（Asia/Taipei）"],
  ["Asia/Tokyo", "东京（Asia/Tokyo）"],
  ["Asia/Singapore", "新加坡（Asia/Singapore）"],
  ["UTC", "UTC"],
  ["Europe/London", "伦敦（Europe/London）"],
  ["America/New_York", "纽约（America/New_York）"],
  ["America/Los_Angeles", "洛杉矶（America/Los_Angeles）"],
];
// Displayed Monday first; values are the stored 0 (Sunday) — 6 numbers.
const SILENCE_DAYS = [
  [1, "一"],
  [2, "二"],
  [3, "三"],
  [4, "四"],
  [5, "五"],
  [6, "六"],
  [0, "日"],
];

const agentForm = {
  groups: AGENT_TOOL_GROUPS,
  /** Group id for a tool name; unknown tools fall back to "other". */
  groupOf(name) {
    return (
      AGENT_TOOL_GROUPS.find((g) => Object.hasOwn(g.tools, name))?.id || "other"
    );
  },
  managedTools() {
    return new Set(
      AGENT_TOOL_GROUPS.filter((g) => g.managedBy).flatMap((g) =>
        Object.keys(g.tools),
      ),
    );
  },

  build(row, idField) {
    const section = (title, body, open = false) =>
      `<details class="agent-section"${open ? " open" : ""}><summary>${title}</summary><div class="form-grid">${body}</div></details>`;
    const cooldownSeconds =
      row.wake.cooldownMs === undefined ? "" : row.wake.cooldownMs / 1000;
    const asr = row.voice?.asr || {};
    return (
      section(
        "基本信息",
        idField +
          input("name", "角色名称", row.name, "required") +
          select(
            "connectionId",
            "QQ 账号",
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
          check("paused", "保持角色暂停", row.paused),
        true,
      ) +
      section(
        "人格与外形",
        area(
          "appearance",
          "固定外形（无固定外形时请明确填写）",
          row.appearance || "",
        ) +
          area(
            "persona",
            "初始化模板（仅建立首版 self；已有 self 请在专页编辑）",
            row.persona || "",
          ),
      ) +
      section(
        "聊天范围与唤醒",
        input(
          "groups",
          "群白名单（逗号分隔群号）",
          row.allow.groups.join(", "),
        ) +
          input(
            "users",
            "私聊白名单（逗号分隔 QQ 号）",
            row.allow.users.join(", "),
          ) +
          `<div class="wide conversation-picker"><button type="button" data-conversations ${row.id ? "" : "disabled"}>从见过的会话中选择</button><span class="hint">${row.id ? "勾选即加入对应白名单，取消勾选即移除。" : "保存角色并收到消息后，可在这里从见过的会话中选择。"}</span><div class="conversation-list" data-conversation-list hidden></div></div>` +
          input(
            "ownerIds",
            "AI 管理员 QQ（逗号分隔）",
            (row.ownerIds || []).join(", "),
          ) +
          input(
            "aliases",
            "唤醒别名（逗号分隔）",
            (row.aliases || []).join(", "),
          ) +
          check("mentions", "被 @ 时唤醒", row.wake.mentions) +
          check("names", "提到名字时唤醒", row.wake.names) +
          check("private", "私聊时唤醒", row.wake.private) +
          check("questions", "问句唤醒", row.wake.questions) +
          check("peers", "参与其他角色对话", row.wake.peers) +
          input(
            "participation",
            "普通消息参与率（0—1）",
            row.wake.participation,
            'type="number" min="0" max="1" step="0.01"',
          ) +
          input(
            "cooldownSeconds",
            "唤醒冷却（秒）",
            cooldownSeconds,
            'type="number" min="0" step="any"',
          ) +
          input(
            "maxConsecutiveSends",
            "每批连续回复上限",
            row.maxConsecutiveSends ?? row.maxSendsPerTurn,
            'type="number" min="1" max="10" required',
          ) +
          '<p class="hint">读到人类新消息后恢复；同伴私聊需冷却结束后收到并读到新消息。重读或重启不会恢复。</p>' +
          check(
            "failureNotice",
            "回复失败时发一句固定提示",
            row.behavior?.failureNotice?.enabled,
          ) +
          input(
            "failureNoticeText",
            "固定提示内容",
            row.behavior?.failureNotice?.text ?? "",
            'maxlength="200" placeholder="我刚才没接上，稍后再回你。"',
          ) +
          `<p class="hint">私聊、被 @ 或被叫名字后，这一轮因 AI 后端出错或超时失败、又一句都没发出时，由程序发送这句话；同一会话每 ${Math.round((row.behavior?.failureNotice?.cooldownMs ?? 600000) / 60000)} 分钟最多一次，仍受暂停、静默和发送限额约束。</p>`,
      ) +
      section(
        "能力",
        `<p class="hint">每组一个开关；部分开启的组显示为“部分”。展开“高级：逐项工具”可单独调整。</p>${this.toolGroupsMarkup(row)}` +
          check(
            "autonomousNetwork",
            "允许自主搜索与联网浏览（无需命令或逐次确认）",
            row.network?.autonomous,
          ) +
          '<p class="hint">允许自行整理查询内容，提交给已启用的平台和外部工具。聊天经历不再触发逐次联网确认；平台开关、时段、预算与凭据保护仍生效。</p>' +
          check(
            "githubEnabled",
            "启用 GitHub 只读搜索与文件阅读",
            row.github?.enabled,
          ),
      ) +
      section(
        "语音转写",
        check("asrEnabled", "收到语音时自动转成文字", asr.enabled) +
          select(
            "asrTool",
            "转写工具（此角色 AI 后端的外部工具白名单）",
            this.asrToolValue(asr),
            this.asrToolOptions(row.backendId, asr),
          ) +
          input(
            "asrAudioArgument",
            "音频参数名",
            asr.audioArgument ?? "audio",
            'pattern="[A-Za-z_][A-Za-z0-9_]{0,63}"',
          ) +
          input(
            "asrMimeArgument",
            "MIME 参数名（工具不需要时留空）",
            asr.mimeArgument ?? "mimeType",
            'pattern="([A-Za-z_][A-Za-z0-9_]{0,63})?"',
          ) +
          input(
            "asrMaxSeconds",
            "单条语音最长（秒）",
            asr.maxSeconds ?? 90,
            'type="number" min="1" max="600"',
          ) +
          input(
            "asrMaxMegabytes",
            "单条语音最大（MB）",
            this.megabytes(asr.maxBytes ?? 8388608),
            'type="number" min="0.0625" max="20" step="any"',
          ) +
          input(
            "asrTimeoutSeconds",
            "转写超时（秒）",
            (asr.timeoutMs ?? 60000) / 1000,
            'type="number" min="1" max="300" step="any"',
          ) +
          input(
            "asrWaitSeconds",
            "回合开始前最多等转写（秒）",
            (asr.waitMs ?? 8000) / 1000,
            'type="number" min="0" max="30" step="any"',
          ) +
          input(
            "asrMaxPerHour",
            "每小时最多转写条数",
            asr.maxPerHour ?? 60,
            'type="number" min="1" max="1000"',
          ) +
          area(
            "asrArguments",
            '固定附加参数（JSON，例如 {"language":"zh"}）',
            JSON.stringify(asr.arguments || {}),
          ) +
          '<p class="hint">开启后，收到的语音会经 QQ 网关下载到此角色的语音库，再发给上面选择的外部工具转写，也就是把聊天语音交给该服务；只能选此角色 AI 后端里管理员白名单中的工具，改了 AI 后端请重新选择。转写结果单独保存并标明是机器转写，原消息不变。暂停、受保护会话、单条上限和每小时上限照常生效；失败时保留原占位并记一条诊断。</p>',
      ) +
      section(
        "作息与静默",
        `<div class="silence-editor"><p class="hint">静默时段内角色不会主动发言。结束早于开始表示跨夜（如 23:00—07:00），星期按开始时间所在的那天计算。</p><div data-silence-rows></div><button type="button" data-silence-add>${icon("plus", "sm")}添加静默时段</button></div>` +
          `<details class="wide"><summary>高级 JSON</summary>${area(
            "silence",
            "定时静默（JSON：start、end、days 0—6、timezone；起止相同须 allDay:true，00:00 表示日历整日）",
            JSON.stringify(row.silence, null, 2),
          )}</details>`,
      ) +
      section(
        "高级",
        area(
          "publicUrls",
          "允许随时读取的精确公开 URL（每行一个，不含私密参数）",
          (row.network?.publicUrls || []).join("\n"),
        ) +
          select("githubAuth", "GitHub 登录方式", row.github?.auth || "token", [
            ["token", "独立只读令牌（推荐）"],
            ["gh", "本机 GitHub CLI 登录"],
          ]) +
          input(
            "githubTokenEnv",
            "GitHub 令牌环境变量名",
            row.github?.tokenEnv || "QQ_GITHUB_READ_TOKEN",
          ) +
          input(
            "githubToken",
            "GitHub 只读令牌（留空保留已保存值）",
            "",
            'type="password" autocomplete="new-password"',
          ) +
          area(
            "githubPrivateRepositories",
            "允许读取的私有仓库（每行 owner/repo）",
            (row.github?.privateRepositories || []).join("\n"),
          ) +
          '<p class="hint">仅搜索与读取，不提供提交、评论或工作流操作。私有内容仅独立受保护工作任务可读，不自动转发到其他聊天或外部服务。本机 CLI 登录可能自带较大权限，推荐独立只读令牌；变量名填写在上一栏，令牌仅填写专用密码框并保存到本机私有配置。</p>',
      )
    );
  },

  megabytes(bytes) {
    return Math.round((bytes / 1048576) * 1000) / 1000;
  },
  asrToolValue(asr) {
    return asr.serverId && asr.tool
      ? JSON.stringify([asr.serverId, asr.tool])
      : "";
  },
  /** Allowlisted MCP tools of a backend, plus the saved choice if gone. */
  asrToolOptions(backendId, asr = {}) {
    const backend =
      config.backends.find((b) => b.id === backendId) || config.backends[0];
    const options = [["", "未选择"]];
    for (const s of backend?.toolServers || [])
      for (const t of s.allowedTools)
        options.push([JSON.stringify([s.id, t]), `${s.id} · ${t}`]);
    const saved = this.asrToolValue(asr);
    if (saved && !options.some(([v]) => v === saved))
      options.push([
        saved,
        `${asr.serverId} · ${asr.tool}（不在当前后端白名单）`,
      ]);
    return options;
  },

  toolGroupsMarkup(row) {
    const enabled = new Set(row.tools);
    const known = new Set(
      AGENT_TOOL_GROUPS.flatMap((g) => Object.keys(g.tools)),
    );
    const other = [...new Set([...tools, ...row.tools])].filter(
      (t) => !known.has(t),
    );
    const groups = [
      ...AGENT_TOOL_GROUPS,
      ...(other.length
        ? [
            {
              id: "other",
              title: "其他",
              desc: "尚未归类的工具，按原名显示。",
              tools: Object.fromEntries(other.map((t) => [t, t])),
            },
          ]
        : []),
    ];
    return `<div class="wide tool-groups">${groups
      .map((g) => {
        // Withheld features (not in the server's tool list) are not offered.
        const names = Object.keys(g.tools).filter((t) => tools.includes(t)),
          on = names.filter((t) => enabled.has(t)).length;
        const items = names
          .map(
            (t) =>
              `<label class="check" title="${esc(t)}"><input type="checkbox" ${g.managedBy ? "disabled" : `name="tool:${esc(t)}"`} ${enabled.has(t) ? "checked" : ""}><span>${esc(g.tools[t])}<code>${esc(t)}</code></span></label>`,
          )
          .join("");
        const head = g.managedBy
          ? `<strong>${esc(g.title)}</strong><span data-group-state>${this.stateTag(on, names.length)}</span>${
              row.id
                ? `<button type="button" class="ghost" data-goto-tab="${g.managedBy.tab}">在「${g.managedBy.page}」页管理${icon("arrow", "sm")}</button>`
                : ""
            }`
          : `<label class="check"><input type="checkbox" data-group-toggle><strong>${esc(g.title)}</strong></label><span data-group-state></span>`;
        const managedHint = g.managedBy
          ? `<p class="hint">由「${g.managedBy.page}」页统一开关${row.id ? "（离开此窗口不会保存这里的修改）" : "，保存角色后可在该页开启"}；此处保存会保持原状。</p>`
          : "";
        return `<div class="tool-group${g.managedBy ? " managed" : ""}" data-group="${g.id}"><div class="tool-group-head">${head}</div><p class="hint">${esc(g.desc)}</p>${managedHint}<details><summary>高级：逐项工具（${names.length}）</summary><div class="tools">${items}</div></details></div>`;
      })
      .join("")}</div>`;
  },

  stateTag(on, total) {
    return on === 0
      ? tag("未开启")
      : on === total
        ? tag("已开启", "live")
        : tag(`部分 ${on}/${total}`, "warn");
  },

  bind(root, row) {
    // Collapsed sections hide invalid fields from the browser's validation
    // bubble, so open them first.
    root.addEventListener(
      "invalid",
      (e) => {
        for (
          let d = e.target.closest("details");
          d;
          d = d.parentElement?.closest("details")
        )
          d.open = true;
      },
      true,
    );
    for (const group of root.querySelectorAll(".tool-group:not(.managed)")) {
      const toggle = group.querySelector("[data-group-toggle]"),
        boxes = [...group.querySelectorAll('input[name^="tool:"]')],
        sync = () => {
          const on = boxes.filter((b) => b.checked).length;
          toggle.checked = on === boxes.length;
          toggle.indeterminate = on > 0 && on < boxes.length;
          group.querySelector("[data-group-state]").innerHTML = this.stateTag(
            on,
            boxes.length,
          );
        };
      toggle.onchange = () => {
        for (const b of boxes) b.checked = toggle.checked;
        sync();
      };
      for (const b of boxes) b.onchange = sync;
      sync();
    }
    for (const b of root.querySelectorAll("[data-goto-tab]"))
      b.onclick = () => {
        $("#editor").close();
        // Open that sub-page for the role being edited (sections in app.js).
        if (row.id) roleId = row.id;
        tab = b.dataset.gotoTab;
        render();
      };
    this.bindSilence(root);
    this.bindConversations(root, row);
    this.bindAsr(root, row);
  },

  // The tool choices follow the selected AI backend.
  bindAsr(root, row) {
    const backend = root.querySelector('select[name="backendId"]'),
      tool = root.querySelector('select[name="asrTool"]');
    if (!backend || !tool) return;
    backend.addEventListener("change", () => {
      const current = tool.value;
      tool.innerHTML = this.asrToolOptions(backend.value, row.voice?.asr)
        .map(
          ([v, l]) =>
            `<option value="${esc(v)}" ${v === current ? "selected" : ""}>${esc(l)}</option>`,
        )
        .join("");
    });
  },

  bindSilence(root) {
    const list = root.querySelector("[data-silence-rows]"),
      json = root.querySelector('textarea[name="silence"]');
    let rows = [];
    const write = () => (json.value = JSON.stringify(rows, null, 2));
    const warning = (r) =>
      !r.days?.length
        ? "未选择星期，此时段不会生效。"
        : r.allDay !== true && r.start === r.end
          ? "开始和结束相同，请改时间或勾选“全天”。"
          : "";
    const render = () => {
      try {
        rows = JSON.parse(json.value || "[]");
      } catch {
        rows = null;
      }
      if (
        !Array.isArray(rows) ||
        rows.some((r) => !r || typeof r !== "object" || Array.isArray(r))
      ) {
        list.innerHTML =
          '<p class="hint">高级 JSON 当前无法按时段显示，请在其中修改。</p>';
        return;
      }
      list.innerHTML = rows.length
        ? rows
            .map((r, i) => {
              const tz = r.timezone || "Asia/Shanghai",
                zones = SILENCE_TIMEZONES.some(([v]) => v === tz)
                  ? SILENCE_TIMEZONES
                  : [[tz, tz], ...SILENCE_TIMEZONES];
              return `<div class="silence-row" data-index="${i}"><label>开始<input type="time" data-k="start" value="${esc(r.start)}" required></label><label>结束<input type="time" data-k="end" value="${esc(r.end)}" ${r.allDay === true ? "disabled" : ""} required></label><label class="check"><input type="checkbox" data-k="allDay" ${r.allDay === true ? "checked" : ""}>全天（从开始时间起 24 小时）</label><div class="silence-days" role="group" aria-label="星期">${SILENCE_DAYS.map(([d, l]) => `<label class="check"><input type="checkbox" data-day="${d}" ${(r.days || []).includes(d) ? "checked" : ""}>周${l}</label>`).join("")}</div><label>时区<select data-k="timezone">${zones.map(([v, l]) => `<option value="${esc(v)}" ${v === tz ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label><button type="button" class="ghost" data-silence-remove>删除此时段</button><p class="hint warn" data-warning>${esc(warning(r))}</p></div>`;
            })
            .join("")
        : '<p class="hint">未设置静默时段，角色全天可以发言。</p>';
    };
    // Rows only rewrite the JSON when edited, so an untouched form saves the
    // original objects byte for byte.
    list.addEventListener("change", (e) => {
      const el = e.target.closest(".silence-row");
      if (!el) return;
      const r = rows[Number(el.dataset.index)],
        q = (k) => el.querySelector(`[data-k="${k}"]`);
      r.start = q("start").value || r.start;
      if (q("allDay").checked) {
        r.allDay = true;
        r.end = r.start;
        q("end").value = r.start;
        q("end").disabled = true;
      } else {
        delete r.allDay;
        q("end").disabled = false;
        r.end = q("end").value || r.end;
      }
      r.days = [...el.querySelectorAll("[data-day]:checked")]
        .map((b) => Number(b.dataset.day))
        .sort((a, b) => a - b);
      r.timezone = q("timezone").value;
      el.querySelector("[data-warning]").textContent = warning(r);
      write();
    });
    list.addEventListener("click", (e) => {
      const el = e.target.closest("[data-silence-remove]");
      if (!el) return;
      rows.splice(Number(el.closest(".silence-row").dataset.index), 1);
      write();
      render();
    });
    root.querySelector("[data-silence-add]").onclick = () => {
      if (!Array.isArray(rows)) return;
      rows.push({
        start: "23:00",
        end: "07:00",
        days: [0, 1, 2, 3, 4, 5, 6],
        timezone: "Asia/Shanghai",
      });
      write();
      render();
    };
    json.addEventListener("input", render);
    render();
  },

  bindConversations(root, row) {
    const button = root.querySelector("[data-conversations]"),
      box = root.querySelector("[data-conversation-list]"),
      fields = {
        group: root.querySelector('input[name="groups"]'),
        private: root.querySelector('input[name="users"]'),
      },
      ids = (kind) =>
        fields[kind].value
          .split(/[,，\s]+/)
          .map((s) => s.trim())
          .filter(Boolean);
    const syncChecks = () => {
      for (const b of box.querySelectorAll("[data-kind]"))
        b.checked = ids(b.dataset.kind).includes(b.value);
    };
    button.onclick = () =>
      action(async () => {
        const seen = await api(
          "/api/conversations?agentId=" + encodeURIComponent(row.id),
        );
        const items = seen
          .map((c) => /^(group|private):(.+)$/.exec(c.conversation))
          .filter(Boolean);
        box.hidden = false;
        box.innerHTML = items.length
          ? items
              .map(
                ([, kind, id]) =>
                  `<label class="check"><input type="checkbox" data-kind="${kind}" value="${esc(id)}">${kind === "group" ? "群" : "私聊"} · <span class="mono">${esc(id)}</span></label>`,
              )
              .join("")
          : '<p class="hint">此角色还没有见过任何群聊或私聊。</p>';
        syncChecks();
      });
    box.addEventListener("change", (e) => {
      const b = e.target,
        field = fields[b.dataset.kind],
        next = ids(b.dataset.kind).filter((id) => id !== b.value);
      if (b.checked) next.push(b.value);
      field.value = next.join(", ");
    });
    for (const field of Object.values(fields))
      field.addEventListener("input", syncChecks);
  },

  /** Returns the edited agent row and an optional GitHub credential. */
  parse(f, original) {
    const get = (k) => String(f.get(k) || ""),
      list = (k) =>
        get(k)
          .split(/[,，\s]+/)
          .map((s) => s.trim())
          .filter(Boolean),
      lines = (k) =>
        get(k)
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean);
    const managed = this.managedTools();
    // A field left as shown keeps its stored value, so saving an unchanged
    // form is not a policy change; a field missing from the form keeps it too.
    const asr = original.voice?.asr || {},
      edited = (key, shown, convert, saved) =>
        !f.has(key) || get(key).trim() === String(shown)
          ? saved
          : convert(get(key).trim()),
      asrTool = !f.has("asrTool")
        ? [asr.serverId, asr.tool]
        : get("asrTool")
          ? JSON.parse(get("asrTool"))
          : ["", ""];
    const seconds = Number(get("cooldownSeconds")),
      cooldownMs =
        original.wake.cooldownMs !== undefined &&
        String(original.wake.cooldownMs / 1000) === get("cooldownSeconds")
          ? original.wake.cooldownMs
          : Math.round(seconds * 1000);
    const row = {
      ...original,
      id: get("id"),
      name: get("name"),
      connectionId: get("connectionId"),
      backendId: get("backendId"),
      model: get("model"),
      effort: get("effort"),
      persona: get("persona"),
      appearance: get("appearance"),
      maxConsecutiveSends: Number(get("maxConsecutiveSends")),
      behavior: {
        ...original.behavior,
        failureNotice: {
          ...original.behavior?.failureNotice,
          enabled: f.has("failureNotice"),
          // An empty field keeps the built-in default text.
          text: get("failureNoticeText").trim() || undefined,
        },
      },
      network: {
        ...original.network,
        autonomous: f.has("autonomousNetwork"),
        publicUrls: lines("publicUrls"),
      },
      voice: {
        ...original.voice,
        asr: {
          ...asr,
          enabled: f.has("asrEnabled"),
          serverId: asrTool[0],
          tool: asrTool[1],
          audioArgument: edited(
            "asrAudioArgument",
            asr.audioArgument,
            String,
            asr.audioArgument,
          ),
          mimeArgument: edited(
            "asrMimeArgument",
            asr.mimeArgument,
            String,
            asr.mimeArgument,
          ),
          arguments: edited(
            "asrArguments",
            JSON.stringify(asr.arguments || {}),
            (v) => JSON.parse(v || "{}"),
            asr.arguments,
          ),
          maxSeconds: edited(
            "asrMaxSeconds",
            asr.maxSeconds,
            Number,
            asr.maxSeconds,
          ),
          maxBytes: edited(
            "asrMaxMegabytes",
            asr.maxBytes === undefined ? "" : this.megabytes(asr.maxBytes),
            (v) => Math.round(Number(v) * 1048576),
            asr.maxBytes,
          ),
          timeoutMs: edited(
            "asrTimeoutSeconds",
            asr.timeoutMs === undefined ? "" : asr.timeoutMs / 1000,
            (v) => Math.round(Number(v) * 1000),
            asr.timeoutMs,
          ),
          waitMs: edited(
            "asrWaitSeconds",
            asr.waitMs === undefined ? "" : asr.waitMs / 1000,
            (v) => Math.round(Number(v) * 1000),
            asr.waitMs,
          ),
          maxPerHour: edited(
            "asrMaxPerHour",
            asr.maxPerHour,
            Number,
            asr.maxPerHour,
          ),
        },
      },
      github: {
        ...original.github,
        enabled: f.has("githubEnabled"),
        auth: get("githubAuth"),
        tokenEnv: get("githubTokenEnv"),
        privateRepositories: lines("githubPrivateRepositories"),
      },
      aliases: list("aliases"),
      ownerIds: list("ownerIds"),
      allow: { groups: list("groups"), users: list("users") },
      paused: f.has("paused"),
      wake: {
        ...original.wake,
        participation: Number(get("participation")),
        cooldownMs,
        mentions: f.has("mentions"),
        names: f.has("names"),
        private: f.has("private"),
        questions: f.has("questions"),
        peers: f.has("peers"),
      },
      // Managed groups are owned by their pages and kept as they were.
      tools: [
        ...original.tools.filter((t) => managed.has(t) || f.has("tool:" + t)),
        ...tools.filter(
          (t) =>
            !original.tools.includes(t) &&
            !managed.has(t) &&
            f.has("tool:" + t),
        ),
      ],
      silence: JSON.parse(get("silence") || "[]"),
    };
    delete row.enabled;
    delete row.toolServers;
    // Keep the compatibility alias unchanged when the displayed value was
    // not edited, so a participation save does not become a policy change.
    if (
      !Object.hasOwn(original, "maxConsecutiveSends") &&
      row.maxConsecutiveSends === original.maxSendsPerTurn
    )
      delete row.maxConsecutiveSends;
    const token = get("githubToken").trim();
    return {
      row,
      githubCredential: token ? { agentId: row.id, token } : undefined,
    };
  },
};
