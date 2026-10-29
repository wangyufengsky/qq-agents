// Agent editor: builds the form, wires its widgets and turns the submitted
// form back into an agent row. The fields changed most often come first; the
// rest fold away under titled sections. The saved shape is unchanged: the
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
      file_read: "读取文本文件",
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
      person_item: "记下和某人之间的事（约定、经历、边界）",
      person_items: "查看和某人之间的事",
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
    desc: "只读搜索和阅读 GitHub 仓库，登录方式在「联网与 GitHub」中设置。",
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
// Reasoning effort levels offered until the backend's model catalog is read;
// then the chosen model's own list replaces them (DSH `reasoning.efforts`,
// Codex `supportedReasoningEfforts`). An OpenAI-compatible backend sends the
// value as `reasoning_effort` only when its `sendEffort` is on.
const AGENT_EFFORTS = {
  dsh: ["low", "medium", "high"],
  codex: ["minimal", "low", "medium", "high", "xhigh"],
  openai: ["minimal", "low", "medium", "high"],
};
const EFFORT_NAMES = {
  none: "不思考",
  minimal: "最低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "很高",
  max: "最高",
};
// Usual argument names of speech-to-text MCP tools. The console cannot read a
// tool's parameters, so these are offers and the fields stay free text.
const ASR_AUDIO_ARGUMENTS = ["audio", "file", "audio_base64", "data"];
const ASR_MIME_ARGUMENTS = ["mimeType", "mime_type", "format"];

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
    const cooldownSeconds =
      row.wake.cooldownMs === undefined ? "" : row.wake.cooldownMs / 1000;
    const asr = row.voice?.asr || {},
      backend = this.backendOf(row.backendId),
      notices = row.behavior || {},
      on = (v) => (v ? "开" : "关");
    const toolCount = row.tools.filter((t) => tools.includes(t)).length;
    return (
      '<div class="form-grid agent-form">' +
      "<h3>基本</h3>" +
      idField +
      input("name", "角色名称", row.name, 'required placeholder="例如 小满"') +
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
      this.modelField(row, backend) +
      select(
        "effort",
        "思考强度",
        row.effort || "",
        this.effortOptions(backend, row.effort),
      ) +
      `<div class="agent-models"><button type="button" class="ghost" data-models ${disabledAttr(this.modelsOff(row, row.backendId))}>读取可用模型</button><span class="hint" data-models-hint>${esc(this.modelsHint(row, backend))}</span></div>` +
      check("paused", "保持角色暂停", row.paused) +
      "<h3>聊天范围</h3>" +
      ids("groups", "群白名单", row.allow.groups, {
        kind: "group",
        hint: "只在这些群里接收和回复消息。",
      }) +
      ids("users", "私聊白名单", row.allow.users, {
        kind: "person",
        hint: "只接收和回复这些人的私聊。",
      }) +
      ids("ownerIds", "AI 管理员 QQ", row.ownerIds || [], {
        kind: "person",
        hint: "也就是主人：可以在私聊里登记定时任务，QQ 掉线时的提示也发给他们。",
      }) +
      "<h3>唤醒</h3>" +
      this.words("aliases", "唤醒别名", row.aliases || [], {
        hint: "消息里出现角色名或这些别名，就算叫到它（需开启“提到名字时唤醒”）。空格和逗号会分成几个别名。",
      }) +
      '<div class="agent-checks">' +
      check("mentions", "被 @ 时唤醒", row.wake.mentions) +
      check("names", "提到名字时唤醒", row.wake.names) +
      check("private", "私聊时唤醒", row.wake.private) +
      check("questions", "问句唤醒", row.wake.questions) +
      check("peers", "参与其他角色对话", row.wake.peers) +
      "</div>" +
      `<div class="agent-range">${range(
        "participation",
        "普通消息参与率（0–100%）",
        row.wake.participation,
        { min: 0, max: 1, step: 0.01, unit: "%" },
      )}<input type="hidden" name="participationShown"><p class="hint">没有被叫到时，每条普通消息有这么大的机会参与。</p></div>` +
      advanced(
        this.foldTitle(
          "唤醒冷却与连发上限",
          `冷却 ${cooldownSeconds === "" ? "未设" : cooldownSeconds + " 秒"} · 每批最多 ${row.maxConsecutiveSends ?? row.maxSendsPerTurn} 条`,
        ),
        input(
          "cooldownSeconds",
          "唤醒冷却（秒，0 起）",
          cooldownSeconds,
          'type="number" min="0" step="any" placeholder="1.5"',
        ) +
          input(
            "maxConsecutiveSends",
            "每批连续回复上限（1–10 条）",
            row.maxConsecutiveSends ?? row.maxSendsPerTurn,
            'type="number" min="1" max="10" required',
          ) +
          '<p class="hint">读到人类新消息后恢复；同伴私聊需冷却结束后收到并读到新消息。重读或重启不会恢复。</p>',
      ) +
      advanced(
        this.foldTitle(
          "人格与外形",
          row.appearance ? "已填写固定外形" : "未填写固定外形",
        ),
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
      advanced(
        this.foldTitle(
          "回复失败与掉线提示",
          `失败提示${on(notices.failureNotice?.enabled)} · 掉线提示${on(notices.outageNotice?.enabled)}`,
        ),
        check(
          "failureNotice",
          "回复失败时发一句固定提示",
          row.behavior?.failureNotice?.enabled,
        ) +
          input(
            "failureNoticeText",
            "固定提示内容（最多 200 字）",
            row.behavior?.failureNotice?.text ?? "",
            'maxlength="200" placeholder="我刚才没接上，稍后再回你。"',
          ) +
          `<p class="hint">私聊、被 @ 或被叫名字后，这一轮因 AI 后端出错或超时失败、又一句都没发出时，由程序发送这句话；同一会话每 ${Math.round((row.behavior?.failureNotice?.cooldownMs ?? 600000) / 60000)} 分钟最多一次，仍受暂停、静默和发送限额约束。</p>` +
          check(
            "outageNotice",
            "QQ 掉线时请其他角色告诉主人",
            row.behavior?.outageNotice?.enabled,
          ) +
          input(
            "outageNoticeText",
            "掉线提示内容（最多 200 字）",
            row.behavior?.outageNotice?.text ?? "",
            'maxlength="200" placeholder="{agent} 的 QQ 掉线了：{reason}。请到 NapCat 看一下。"',
          ) +
          check(
            "outageNoticeRecovered",
            "恢复连接后再说一句",
            row.behavior?.outageNotice?.notifyRecovered,
          ) +
          input(
            "outageNoticeRecoveredText",
            "恢复提示内容（最多 200 字）",
            row.behavior?.outageNotice?.recoveredText ?? "",
            'maxlength="200" placeholder="{agent} 的 QQ 已经恢复连接。"',
          ) +
          `<p class="hint">本角色的 QQ 已离线或自动重连用完次数时，由同一实例里排在最前、QQ 已连接、未暂停、私聊白名单包含该主人的另一个角色，把这句话私聊发给本角色的每位主人；{agent} 换成本角色名，{reason} 换成“QQ 已离线”或“自动重连失败”。同一连接的同类提示每 ${Math.round((row.behavior?.outageNotice?.cooldownMs ?? 1800000) / 60000)} 分钟最多一次，仍受暂停、静默和发送限额约束，被拦下不重试。需要先填写主人 QQ；只有一个角色时没有人代发。</p>`,
      ) +
      advanced(
        this.foldTitle("能力", `已开启 ${toolCount}/${tools.length} 项工具`),
        `<p class="hint">每组一个开关；部分开启的组显示为“部分”。展开“高级：逐项工具”可单独调整。</p>${this.toolGroupsMarkup(row)}`,
      ) +
      advanced(
        this.foldTitle(
          "语音转写",
          asr.enabled && asr.serverId
            ? `已开启 · ${asr.serverId} · ${asr.tool}`
            : asr.enabled
              ? "已开启"
              : "未开启",
        ),
        check("asrEnabled", "收到语音时自动转成文字", asr.enabled) +
          select(
            "asrTool",
            "转写工具（此角色 AI 后端的外部工具白名单）",
            this.asrToolValue(asr),
            this.asrToolOptions(row.backendId, asr),
          ) +
          this.offered(
            "asrAudioArgument",
            "音频参数名",
            asr.audioArgument ?? "audio",
            ASR_AUDIO_ARGUMENTS,
            'pattern="[A-Za-z_][A-Za-z0-9_]{0,63}" placeholder="例如 audio"',
          ) +
          this.offered(
            "asrMimeArgument",
            "MIME 参数名（工具不需要时留空）",
            asr.mimeArgument ?? "mimeType",
            ASR_MIME_ARGUMENTS,
            'pattern="([A-Za-z_][A-Za-z0-9_]{0,63})?" placeholder="例如 mimeType"',
          ) +
          '<p class="hint">参数名要和转写工具的参数定义一致；不确定时看该 MCP 服务的说明，常见的是 audio 和 mimeType。</p>' +
          input(
            "asrMaxSeconds",
            "单条语音最长（秒，1–600）",
            asr.maxSeconds ?? 90,
            'type="number" min="1" max="600"',
          ) +
          input(
            "asrMaxMegabytes",
            "单条语音最大（MB，0.0625–20）",
            this.megabytes(asr.maxBytes ?? 8388608),
            'type="number" min="0.0625" max="20" step="any"',
          ) +
          input(
            "asrTimeoutSeconds",
            "转写超时（秒，1–300）",
            (asr.timeoutMs ?? 60000) / 1000,
            'type="number" min="1" max="300" step="any"',
          ) +
          input(
            "asrWaitSeconds",
            "回合开始前最多等转写（秒，0–30）",
            (asr.waitMs ?? 8000) / 1000,
            'type="number" min="0" max="30" step="any"',
          ) +
          input(
            "asrMaxPerHour",
            "每小时最多转写条数（1–1000）",
            asr.maxPerHour ?? 60,
            'type="number" min="1" max="1000"',
          ) +
          this.note(
            "asrArguments",
            "固定附加参数（JSON，最多 10 个）",
            JSON.stringify(asr.arguments || {}),
            '{"language":"zh"}',
          ) +
          '<p class="hint">开启后，收到的语音会经 QQ 网关下载到此角色的语音库，再发给上面选择的外部工具转写，也就是把聊天语音交给该服务；只能选此角色 AI 后端里管理员白名单中的工具，改了 AI 后端请重新选择。转写结果单独保存并标明是机器转写，原消息不变。暂停、受保护会话、单条上限和每小时上限照常生效；失败时保留原占位并记一条诊断。</p>',
      ) +
      advanced(
        this.foldTitle(
          "作息与静默",
          row.silence.length
            ? `${row.silence.length} 个静默时段`
            : "未设置，全天可发言",
        ),
        `<div class="silence-editor"><p class="hint">静默时段内角色不会主动发言。结束早于开始表示跨夜（如 23:00—07:00），星期按开始时间所在的那天计算。</p><div data-silence-rows></div><button type="button" data-silence-add>${icon("plus", "sm")}添加静默时段</button></div>` +
          `<details class="wide"><summary>高级 JSON</summary>${area(
            "silence",
            "定时静默（JSON：start、end、days 0—6、timezone；起止相同须 allDay:true，00:00 表示日历整日）",
            JSON.stringify(row.silence, null, 2),
          )}</details>`,
      ) +
      advanced(
        this.foldTitle(
          "联网与 GitHub",
          [
            row.network?.autonomous ? "自主联网" : "",
            row.github?.enabled ? "GitHub 只读" : "",
          ]
            .filter(Boolean)
            .join(" · ") || "都未开启",
        ),
        check(
          "autonomousNetwork",
          "允许自主搜索与联网浏览（无需命令或逐次确认）",
          row.network?.autonomous,
        ) +
          '<p class="hint">允许自行整理查询内容，提交给已启用的平台和外部工具。聊天经历不再触发逐次联网确认；平台开关、时段、预算与凭据保护仍生效。</p>' +
          this.note(
            "publicUrls",
            "允许随时读取的精确公开 URL（每行一个，不含私密参数）",
            (row.network?.publicUrls || []).join("\n"),
            "https://example.com/status.json",
          ) +
          check(
            "githubEnabled",
            "启用 GitHub 只读搜索与文件阅读",
            row.github?.enabled,
          ) +
          select("githubAuth", "GitHub 登录方式", row.github?.auth || "token", [
            ["token", "独立只读令牌（推荐）"],
            ["gh", "本机 GitHub CLI 登录"],
          ]) +
          input(
            "githubTokenEnv",
            "GitHub 令牌环境变量名",
            row.github?.tokenEnv || "QQ_GITHUB_READ_TOKEN",
            'placeholder="例如 GITHUB_TOKEN"',
          ) +
          input(
            "githubToken",
            "GitHub 只读令牌（留空保留已保存值）",
            "",
            'type="password" autocomplete="new-password" placeholder="github_pat_…"',
          ) +
          this.note(
            "githubPrivateRepositories",
            "允许读取的私有仓库（每行 owner/repo）",
            (row.github?.privateRepositories || []).join("\n"),
            "例如 octocat/hello-world",
          ) +
          '<p class="hint">仅搜索与读取，不提供提交、评论或工作流操作。私有内容仅独立受保护工作任务可读，不自动转发到其他聊天或外部服务。本机 CLI 登录可能自带较大权限，推荐独立只读令牌；变量名填写在上一栏，令牌仅填写专用密码框并保存到本机私有配置。</p>',
      ) +
      "</div>"
    );
  },

  backendOf(id) {
    return config.backends.find((b) => b.id === id) || config.backends[0];
  },
  foldTitle(title, summary) {
    return `${title}<span class="adv-summary">${esc(summary)}</span>`;
  },
  /** A textarea with an example shown while it is empty. */
  note(key, label, value, example) {
    return `<label class="wide">${label}<textarea name="${key}" placeholder="${esc(example)}">${esc(value)}</textarea></label>`;
  },
  /** A free-text input that offers the usual values as it is typed in. */
  offered(key, label, value, offers, extra = "") {
    return `<label>${label}<input name="${key}" value="${esc(value)}" list="agent-${key}-list" autocomplete="off" ${extra}><datalist id="agent-${key}-list">${offers.map((v) => `<option value="${esc(v)}"></option>`).join("")}</datalist></label>`;
  },

  // Model: free text that offers the backend default, the models other roles
  // on this backend use and, once read, the backend's catalog. Empty keeps
  // inheriting the backend's model.
  modelField(row, backend) {
    return `<label>模型<input name="model" value="${esc(row.model || "")}" list="agent-model-list" autocomplete="off" placeholder="${esc(this.modelPlaceholder(backend))}"><datalist id="agent-model-list">${this.modelOptions(this.modelSuggestions(backend))}</datalist></label>`;
  },
  modelPlaceholder(backend) {
    return backend?.model
      ? `留空用后端默认：${backend.model}`
      : "留空用后端默认模型";
  },
  modelSuggestions(backend) {
    return [
      ...new Set(
        [
          backend?.model,
          ...config.agents
            .filter((a) => a.backendId === backend?.id)
            .map((a) => a.model),
        ].filter(Boolean),
      ),
    ].map((id) => ({ id, name: "" }));
  },
  modelOptions(models) {
    return models
      .map(
        (m) =>
          `<option value="${esc(m.id)}">${esc(m.name && m.name !== m.id ? m.name : "")}</option>`,
      )
      .join("");
  },
  /** Model ids with their effort levels, from any backend's model catalog. */
  catalogModels(catalog, provider = "") {
    const rows = Array.isArray(catalog)
      ? catalog
      : (catalog?.groups || [])
          .filter((g) => !provider || g.id === provider)
          .flatMap((g) => g.models || []);
    return rows
      .map((m) => ({
        id: String(m?.model || m?.id || ""),
        name: String(m?.displayName || m?.name || ""),
        efforts: (m?.reasoning?.efforts || m?.supportedReasoningEfforts || [])
          .map((e) =>
            typeof e === "string" ? e : e?.id || e?.reasoningEffort || "",
          )
          .filter(Boolean),
      }))
      .filter((m) => m.id);
  },
  effortName(v) {
    return EFFORT_NAMES[v] ? `${EFFORT_NAMES[v]}（${v}）` : v;
  },
  /** Inherit, the backend's levels (or a model's own), then the saved value. */
  effortOptions(backend, value = "", levels) {
    const options = [
      [
        "",
        `继承后端（${backend?.effort ? this.effortName(backend.effort) : "后端默认"}）`,
      ],
      ...(levels || AGENT_EFFORTS[backend?.type] || AGENT_EFFORTS.dsh).map(
        (v) => [v, this.effortName(v)],
      ),
    ];
    if (value && !options.some(([v]) => v === value))
      options.push([value, `${value}（当前值）`]);
    return options;
  },
  // The catalog is read through the saved role, so it needs one on the
  // backend it was saved with, outside isolated mode.
  modelsOff(row, backendId) {
    return !row.id
      ? "保存角色后可读取后端的模型目录"
      : backendId !== row.backendId
        ? "改了 AI 后端，保存后才能读取新后端的模型"
        : disabledReason([[status?.mode === "isolated", "isolatedBackend"]]);
  },
  modelsHint(row, backend, catalog) {
    const off = this.modelsOff(row, backend?.id);
    if (off) return off;
    if (backend?.type === "openai" && !backend.sendEffort)
      return "这个后端没有开启“发送思考强度”，思考强度不会发给模型。";
    return catalog
      ? `已读取 ${catalog.length} 个模型，可以在“模型”里直接选。`
      : "模型和思考强度留空时用后端的设置。";
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
    // The server grants file_read with file_list, also to configurations
    // saved before file_read existed (Runtime.toolsFor).
    if (enabled.has("file_list")) enabled.add("file_read");
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
    // The slider snaps the saved value to its step; parse() keeps the saved
    // value while the slider still shows that snapped position.
    const slider = root.querySelector('input[name="participation"]');
    root.querySelector('input[name="participationShown"]').value = slider.value;
    // A number typed but not added yet is added when the field is left, so
    // pressing save keeps it as the comma field did.
    for (const field of root.querySelectorAll("[data-ids] .ids-add input"))
      field.addEventListener("change", () =>
        field.closest("[data-ids]").querySelector("[data-ids-add]").click(),
      );
    this.bindSilence(root);
    this.bindWords(root);
    this.bindBackend(root, row);
    fillIds(root, row.id);
  },

  // Effort levels, model offers and transcription tools follow the selected
  // AI backend; a read catalog also follows the typed model.
  bindBackend(root, row) {
    const backend = root.querySelector('select[name="backendId"]'),
      model = root.querySelector('input[name="model"]'),
      effort = root.querySelector('select[name="effort"]'),
      offers = root.querySelector("#agent-model-list"),
      button = root.querySelector("[data-models]"),
      hint = root.querySelector("[data-models-hint]"),
      tool = root.querySelector('select[name="asrTool"]');
    let catalog = null;
    const fill = (select, options) => {
      const current = select.value;
      select.innerHTML = options
        .map(
          ([v, l]) =>
            `<option value="${esc(v)}" ${v === current ? "selected" : ""}>${esc(l)}</option>`,
        )
        .join("");
    };
    const levels = () => {
      const id = model.value.trim() || this.backendOf(backend.value)?.model,
        efforts = catalog?.find((m) => m.id === id)?.efforts;
      return efforts?.length ? efforts : undefined;
    };
    const refresh = () => {
      const b = this.backendOf(backend.value),
        off = this.modelsOff(row, backend.value);
      fill(effort, this.effortOptions(b, effort.value, levels()));
      model.placeholder = this.modelPlaceholder(b);
      const seen = new Set(catalog?.map((m) => m.id));
      offers.innerHTML = this.modelOptions([
        ...(catalog || []),
        ...this.modelSuggestions(b).filter((m) => !seen.has(m.id)),
      ]);
      button.disabled = Boolean(off);
      button.title = off;
      hint.textContent = this.modelsHint(row, b, catalog);
    };
    backend.addEventListener("change", () => {
      catalog = null;
      refresh();
      fill(tool, this.asrToolOptions(backend.value, row.voice?.asr));
    });
    model.addEventListener("input", () => {
      if (catalog)
        fill(
          effort,
          this.effortOptions(
            this.backendOf(backend.value),
            effort.value,
            levels(),
          ),
        );
    });
    button.onclick = () =>
      action(async () => {
        const r = await api("/api/models", { agentId: row.id });
        catalog = this.catalogModels(
          r.models,
          this.backendOf(backend.value)?.provider,
        );
        refresh();
      });
  },

  // Words as removable chips, the text version of ids() in app.js. The hidden
  // input sends the same comma list the plain field used to send.
  words(key, label, values, { hint = "" } = {}) {
    return `<div class="ids wide" data-words="${esc(JSON.stringify(values))}"><span class="ids-label">${label}</span><input type="hidden" name="${key}" value="${esc(values.join(", "))}"><div class="ids-chips">${this.wordChips(values)}</div><div class="ids-add"><input autocomplete="off" maxlength="80" placeholder="输入别名，按回车添加" aria-label="添加到${label}"><button type="button" class="ghost" data-words-add>添加</button></div>${hint ? `<p class="hint">${hint}</p>` : ""}</div>`;
  },
  wordChips(values) {
    return (
      values
        .map(
          (w, i) =>
            `<span class="ids-chip" data-index="${i}"><span class="ids-name">${esc(w)}</span><button type="button" class="ids-remove" data-word-remove aria-label="移除 ${esc(w)}">×</button></span>`,
        )
        .join("") || '<span class="ids-empty">还没有</span>'
    );
  },
  bindWords(root) {
    for (const box of root.querySelectorAll("[data-words]")) {
      const hidden = box.querySelector('input[type="hidden"]'),
        field = box.querySelector(".ids-add input"),
        words = JSON.parse(box.dataset.words);
      const show = () => {
        hidden.value = words.join(", ");
        box.querySelector(".ids-chips").innerHTML = this.wordChips(words);
      };
      // Saving splits on spaces and commas, so adding does the same.
      const add = () => {
        const next = field.value.split(/[,，\s]+/).filter(Boolean);
        if (!next.length) return;
        if (next.some((w) => w.length > 80)) {
          field.setCustomValidity("每个别名最多 80 个字");
          field.reportValidity();
          return;
        }
        field.setCustomValidity("");
        field.value = "";
        for (const w of next) if (!words.includes(w)) words.push(w);
        show();
      };
      box.addEventListener("click", (e) => {
        if (e.target.closest("[data-words-add]")) add();
        const chip = e.target.closest("[data-word-remove]")?.parentElement;
        if (chip) {
          words.splice(Number(chip.dataset.index), 1);
          show();
        }
      });
      field.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        // Enter adds the alias instead of submitting the form.
        e.preventDefault();
        add();
      });
      field.addEventListener("input", () => field.setCustomValidity(""));
      field.addEventListener("change", add);
    }
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

  /** Returns the edited agent row and an optional GitHub credential. */
  parse(f, original) {
    const get = (k) => String(f.get(k) || ""),
      list = (k) =>
        get(k)
          .split(/[,，\s]+/)
          .map((s) => s.trim())
          .filter(Boolean),
      // The number chips show a repeated number once; a list left as shown
      // keeps the saved one, repeats included.
      numbers = (k, saved = []) => {
        const next = list(k);
        return JSON.stringify(next) ===
          JSON.stringify([...new Set(saved.map((s) => String(s).trim()))])
          ? saved
          : next;
      },
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
        outageNotice: {
          ...original.behavior?.outageNotice,
          enabled: f.has("outageNotice"),
          notifyRecovered: f.has("outageNoticeRecovered"),
          // Empty fields keep the built-in default text.
          text: get("outageNoticeText").trim() || undefined,
          recoveredText: get("outageNoticeRecoveredText").trim() || undefined,
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
      ownerIds: numbers("ownerIds", original.ownerIds),
      allow: {
        groups: numbers("groups", original.allow.groups),
        users: numbers("users", original.allow.users),
      },
      paused: f.has("paused"),
      wake: {
        ...original.wake,
        participation:
          f.has("participationShown") &&
          get("participation") === get("participationShown")
            ? original.wake.participation
            : Number(get("participation")),
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
