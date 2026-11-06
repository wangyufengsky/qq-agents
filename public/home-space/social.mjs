import { paperElement as el } from "../home-preview/paper-board.mjs";

const states = {
  pending: "待主体决定",
  accepted: "已接受邀请",
  declined: "已拒绝",
  deferred: "稍后处理",
  cancelled: "已取消",
  active: "进行中",
  ended: "已结束",
  expired: "已到期",
  invalidated: "已失效",
  proposed: "等待双方同意",
  closed: "已关闭",
  interrupted: "已中断",
  committed: "已提交，未必已读",
  not_sent: "未发送",
  unknown: "结果待核对",
};
const fields = [
  ["durationMinutes", "每时段分钟数", 10, 1, 30],
  ["maxTurns", "每时段双方合计模型回合数", 12, 2, 24],
  ["maxMessagesPerTurn", "每回合最多消息条数", 3, 1, 3],
  ["invitationTtlHours", "邀请有效小时数", 48, 1, 168],
  ["visitTtlHours", "拜访有效小时数", 72, 1, 720],
  ["maxInvitationsPerDay", "每角色每日邀请次数", 5, 1, 100],
  ["maxMessagesPerVisitPerDay", "每拜访每角色每日成功消息条数", 20, 1, 200],
  ["cooldownHours", "拒绝或到期后冷却小时数", 24, 1, 168],
  ["retentionDays", "终态正文保留天数", 30, 1, 365],
];
export const socialBudgetFields = [
  ["maxInputTokensPerInference", "每次推理最多输入（token）", 2097152],
  ["maxOutputTokensPerInference", "每次推理最多输出（token，含推理）", 393216],
  ["maxTokensPerTurn", "每回合最多资源（token）", 100000000],
  ["maxTokensPerWindow", "每时段最多资源（token）", 1000000000],
  ["maxTokensPerDay", "每日最多资源（token，UTC日）", 1000000000],
  ["maxInferencesPerTurn", "每回合最多推理次数（次）", 32],
];
export function socialBudgetValues(mode, values) {
  if (mode === "unconfigured") return null;
  const budget = { unit: "tokens" };
  for (const [key, title, max] of socialBudgetFields) {
    const value = Number(values[key]);
    if (!Number.isSafeInteger(value) || value < 1 || value > max)
      throw Error(`${title}须填写1至${max}之间的整数。`);
    budget[key] = value;
  }
  if (
    budget.maxTokensPerTurn <
    budget.maxInputTokensPerInference + budget.maxOutputTokensPerInference
  )
    throw Error("每回合资源上限须不少于单次输入与输出上限之和。");
  if (
    budget.maxTokensPerWindow < budget.maxTokensPerTurn ||
    budget.maxTokensPerDay < budget.maxTokensPerTurn
  )
    throw Error("每时段和每日资源上限须不少于每回合上限。");
  return budget;
}
function button(text, action) {
  const node = el("button", "", text);
  node.type = "button";
  node.onclick = action;
  return node;
}
const time = (value) =>
  value ? new Date(value).toLocaleString("zh-CN") : "未设置";
const label = (state) => states[state] || "状态待核验";
const quantity = (value) => (value == null ? "待核对" : String(value));
export function socialResourceSummary(data, async = false) {
  const cap = (value) =>
    value === null ? "未设 token 硬上限" : `${quantity(value)} token`;
  const measured =
    data?.usageAvailable === false
      ? "后端未提供可信用量"
      : `${quantity(data?.used)}已用 / ${quantity(data?.reserved)}预留（token）`;
  return async
    ? `本拜访累计${measured}；每回合${cap(data?.limits?.perTurn)}，每日${cap(data?.limits?.perDay)}，累计值不与每日上限直接比较`
    : `${measured}；时段${cap(data?.limit)}`;
}

// Each view owns its generation and lease so unrelated scene polling cannot renew private text.
export function createSocialView({ root, api, isActive, agentId }) {
  let generation = 0,
    timer,
    closed = false;
  const alive = (id) => !closed && isActive() && id === generation;
  function clear(message) {
    generation++;
    clearTimeout(timer);
    root.replaceChildren(el("p", "social-notice", message));
  }
  async function request(url, body, method) {
    const id = ++generation;
    clearTimeout(timer);
    root.replaceChildren(el("p", "", "正在核验往来权限…"));
    try {
      const value = await api(url, body, method);
      if (!alive(id)) return null;
      return { value, id };
    } catch {
      if (alive(id))
        clear("无法确认往来权限或连接状态，已隐藏旧正文。请重新读取。");
      return null;
    }
  }
  function header() {
    root.append(
      el(
        "p",
        "social-notice",
        "管理员可查看和管理往来；邀请、接受与发言由各角色主体自主决定。",
      ),
    );
    root.append(button("重新读取往来", render));
  }
  function lease(value, id) {
    const expires = Number(value.lease?.expiresAt ?? value.leaseExpiresAt);
    if (!Number.isFinite(expires) || expires <= Date.now()) {
      clear("正文授权已到期，请重新读取。");
      return false;
    }
    // This is an audited administrator history lease, independent of the
    // now-expired invitation, visit or live room grant being inspected.
    const deadline = Math.min(Date.now() + 15000, expires);
    if (deadline <= Date.now()) {
      clear("正文授权已到期，请重新读取。");
      return false;
    }
    timer = setTimeout(() => {
      if (alive(id)) clear("正文验证已到期，已隐藏旧正文。请重新读取。");
    }, deadline - Date.now());
    return true;
  }
  async function detail(item, cursor = null) {
    const response = await request("/api/home-social/read", {
      kind: item.kind,
      id: item.id,
      limit: 30,
      ...(cursor ? { cursor } : {}),
    });
    if (!response || !lease(response.value, response.id)) return;
    const value = response.value;
    if (
      value.id !== item.id ||
      (item.kind === "visit" && !Array.isArray(value.messages))
    ) {
      clear("往来消息格式需要重新核验，已隐藏正文。");
      return;
    }
    root.replaceChildren();
    header();
    root.append(
      button("返回往来列表", render),
      el("h3", "", label(value.state)),
    );
    if (value.purpose) root.append(el("p", "social-body", value.purpose));
    if (value.reason)
      root.append(el("p", "social-body", `可见理由：${value.reason}`));
    for (const [title, scope] of [
      ["申请范围", value.requestedScope],
      ["实际获准范围", value.effectiveScope],
    ])
      if (scope !== undefined)
        root.append(
          el(
            "p",
            "",
            `${title}：${Array.isArray(scope) ? scope.map((slot) => ({ layout: "布局", intro: "介绍", tagline: "门牌", "work-1": "作品1", "work-2": "作品2", "work-3": "作品3" })[slot] || "范围待核验").join("、") || "无房间访问" : "尚未获准房间访问"}`,
          ),
        );
    root.append(
      el(
        "p",
        "",
        `${item.kind === "invitation" ? "邀请" : "拜访"}截止：${time(value.expiresAt)} · 房间授权截止：${time(value.grantExpiresAt)}`,
      ),
    );
    if (value.window) {
      root.append(
        el("h4", "", "交流时段"),
        el(
          "p",
          "",
          `${label(value.window.state)} · 截止 ${time(value.window.deadline)}`,
        ),
      );
      if (value.window.effectiveLimits) {
        const limits = value.window.effectiveLimits;
        root.append(
          el(
            "p",
            "",
            `实际条款：${quantity(limits.durationMinutes)}分钟 · 双方合计${quantity(limits.maxTurns)}回合 · 每回合${quantity(limits.maxMessagesPerTurn)}条`,
          ),
        );
      }
      if (value.window.closeReason)
        root.append(el("p", "", `关闭原因：${value.window.closeReason}`));
    }
    if (value.usage) {
      const usage = value.usage;
      const list = el("dl", "social-usage");
      for (const [title, data] of [
        ["本时段模型回合", usage.windowTurns],
        ["时段模型资源", usage.windowResources],
        ["异步运行资源", usage.asyncResources],
        ["每日成功消息", usage.dailyMessages],
      ]) {
        let summary;
        if (title === "每日成功消息")
          summary = `${quantity(data?.committed)} 已提交 / ${quantity(data?.limit)} 双方合计上限`;
        else if (title === "异步运行资源" || title === "时段模型资源")
          summary = socialResourceSummary(data, title === "异步运行资源");
        else
          summary = `${quantity(data?.used)} 已用 / ${quantity(data?.reserved)} 预留 / ${quantity(data?.limit)} 上限${data?.unit ? `（${data.unit}）` : ""}`;
        list.append(el("dt", "", title), el("dd", "", summary));
      }
      root.append(list);
      for (const daily of usage.dailyMessages?.byParticipant || []) {
        const participant = [value.owner, value.visitor].find(
          (identity) =>
            identity?.identityGeneration === daily.identityGeneration,
        );
        root.append(
          el(
            "p",
            "",
            `${participant?.name || "参与者"}：每日${quantity(daily.committed)} / ${quantity(daily.limit)}条成功消息`,
          ),
        );
      }
      if (usage.dailyMessages?.resetsAt)
        root.append(
          el(
            "small",
            "",
            `每日额度重置：${time(usage.dailyMessages.resetsAt)}（按UTC日）`,
          ),
        );
    }
    const messages = el("section", "social-messages");
    messages.setAttribute("aria-label", "真实往来消息");
    if (!value.messages?.length)
      messages.append(el("p", "", "尚无可显示的往来消息。"));
    for (const message of value.messages || []) {
      const row = el("article", "social-message");
      row.append(
        el("h4", "", message.author?.name || "作者待核验"),
        el("small", "", time(message.committedAt)),
        el(
          "p",
          "social-body",
          message.state === "hidden"
            ? "正文已由管理员隐藏。"
            : message.state === "retracted"
              ? "作者已撤回正文。"
              : message.state === "expired"
                ? "正文保留期已结束。"
                : message.body || "",
        ),
      );
      if (
        value.permittedActions?.includes("hide-message") &&
        message.state === "committed"
      )
        row.append(
          button("隐藏这条消息（管理操作）", () =>
            moderate(
              "hide-message",
              message.messageId,
              message.messageRevision,
              value,
              item,
            ),
          ),
        );
      messages.append(row);
    }
    root.append(messages);
    if (value.nextCursor)
      root.append(
        button("下一页消息（重新核验权限）", () =>
          detail(item, value.nextCursor),
        ),
      );
    if (cursor) root.append(button("从首条重新读取", () => detail(item)));
    for (const receipt of value.operations || [])
      root.append(
        el(
          "p",
          "social-receipt",
          `${receipt.requestId}：${label(receipt.status)}`,
        ),
      );
    for (const [action, text, target, revision] of [
      [
        "close-window",
        "关闭交流时段（管理操作）",
        value.window?.id,
        value.window?.revision,
      ],
      ["terminate-visit", "终止拜访（管理操作）", value.id, value.revision],
    ])
      if (target && value.permittedActions?.includes(action))
        root.append(
          button(text, () => moderate(action, target, revision, value, item)),
        );
  }
  async function moderate(action, targetId, expectedRevision, value, item) {
    if (!confirm("此操作会立即收回相关互动权限。继续管理操作吗？")) return;
    const response = await request("/api/home-social/moderate", {
      action,
      targetId,
      expectedRevision,
      policyRevision: value.policyRevision,
      requestId: crypto.randomUUID(),
    });
    if (response) await detail(item);
  }
  async function settings() {
    const response = await request("/api/config");
    if (!response) return;
    const loaded = response.value,
      draft = structuredClone(loaded.config),
      policy = draft.homeSocial || {};
    root.replaceChildren();
    header();
    const form = el("form", "social-settings");
    const status = el("p", "social-notice");
    status.setAttribute("role", "status");
    for (const [key, title] of [
      ["enabled", "启用实例社交"],
      ["exchangeEnabled", "启用双方同意的受控交流"],
    ]) {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.name = key;
      input.checked = policy[key] === true;
      const row = el("label", "", title);
      row.prepend(input);
      form.append(row);
    }
    for (const [key, title, initial, min, max] of fields) {
      const row = el("label", "", title),
        input = document.createElement("input");
      input.type = "number";
      input.name = key;
      input.value = policy[key] ?? initial;
      input.min = min;
      input.max = max;
      input.step = "1";
      input.required = true;
      row.append(input);
      form.append(row);
    }
    const budgetLabel = el("label", "", "模型资源预算"),
      budgetMode = document.createElement("select");
    budgetMode.name = "budgetMode";
    for (const [value, title] of [
      ["unconfigured", "按回合运行（不设 token 硬上限）"],
      ["configured", "可选：配置 token 硬预算"],
    ]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = title;
      budgetMode.append(option);
    }
    budgetMode.value = policy.resourceBudget ? "configured" : "unconfigured";
    budgetLabel.append(budgetMode);
    form.append(budgetLabel);
    const budgetGroup = el("fieldset", "social-budget");
    budgetGroup.append(el("legend", "", "可选模型资源硬上限"));
    for (const [key, title, max] of socialBudgetFields) {
      const row = el("label", "", title),
        input = document.createElement("input");
      input.type = "number";
      input.name = key;
      input.min = "1";
      input.max = String(max);
      input.step = "1";
      input.value = policy.resourceBudget?.[key] ?? "";
      row.append(input);
      budgetGroup.append(row);
    }
    const toggleBudget = () => {
      budgetGroup.hidden = budgetMode.value !== "configured";
      for (const input of budgetGroup.querySelectorAll("input")) {
        input.disabled = budgetGroup.hidden;
        input.required = !budgetGroup.hidden;
      }
    };
    budgetMode.onchange = toggleBudget;
    toggleBudget();
    form.append(budgetGroup);
    form.append(
      el(
        "p",
        "social-notice",
        "DSH、Codex、Antigravity 可使用现有后端按回合运行，无需填写 token 预算或选择社交 profile；DSH 须使用 qq-unified preset。可选硬预算仍仅支持官方 OpenAI gpt-4.1-mini-2025-04-14 配置；每次推理预留 1,047,576 输入 token 加输出上限，结果未知时保留预留。保存不会替换模型、服务地址或凭据。",
      ),
    );
    form.append(
      el(
        "p",
        "social-notice",
        "默认双方合计 12 回合，一方运行一次计 1 回合。同一时段各自接着自己的会话聊；退出、暂停或到期就结束。保存设置不会自动开启角色参与。",
      ),
    );
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "保存实例设置";
    form.append(submit, status);
    root.append(form, button("放弃草稿并重新读取设置", settings));
    form.onsubmit = async (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      let resourceBudget;
      try {
        resourceBudget = socialBudgetValues(
          budgetMode.value,
          Object.fromEntries(new FormData(form)),
        );
      } catch (error) {
        status.textContent = error.message;
        return;
      }
      const values = new FormData(form);
      draft.homeSocial = {
        ...policy,
        enabled: values.has("enabled"),
        exchangeEnabled: values.has("exchangeEnabled"),
        resourceBudget,
      };
      for (const [key] of fields)
        draft.homeSocial[key] = Number(values.get(key));
      const id = generation;
      submit.disabled = true;
      try {
        const saved = await api(
          "/api/config",
          { config: draft, revision: loaded.revision },
          "PUT",
        );
        if (!alive(id)) return;
        loaded.revision = saved.revision;
        status.textContent = "实例设置已保存；角色仍需自主同意。";
      } catch (error) {
        if (alive(id))
          status.textContent =
            error.code === "CONFIG_CONFLICT"
              ? "配置已有新版本，草稿已保留。请重新读取并核对后再保存。"
              : ["CONFIG_SCHEMA_INVALID", "INVALID_REQUEST"].includes(
                    error.code,
                  )
                ? "服务端拒绝配置：请核对整数范围、可选预算与后端能力。草稿已保留。"
                : "设置未保存，草稿已保留。请核对配置与可选资源预算。";
      } finally {
        if (alive(id)) submit.disabled = false;
      }
    };
  }
  async function render(cursor = null) {
    if (typeof cursor !== "string") cursor = null;
    const query = new URLSearchParams();
    if (agentId) query.set("agentId", agentId);
    if (cursor) query.set("cursor", cursor);
    const response = await request(
      "/api/home-social/overview" + (query.size ? "?" + query : ""),
    );
    if (!response) return;
    if (!Array.isArray(response.value.items)) {
      clear("往来列表格式需要重新核验。");
      return;
    }
    root.replaceChildren();
    header();
    const list = el("section", "social-list");
    list.setAttribute("aria-label", "往来记录");
    for (const item of response.value.items || []) {
      const row = el("article", "social-row");
      row.append(
        el(
          "h3",
          "",
          `${item.owner?.name || "房主"} · ${item.visitor?.name || "访客"}`,
        ),
        el("p", "", `${label(item.state)} · 到期 ${time(item.expiresAt)}`),
        button("核验权限并查看详情", () => detail(item)),
      );
      list.append(row);
    }
    if (!response.value.items?.length)
      list.append(el("p", "", "尚无可显示的往来记录。"));
    root.append(list);
    if (response.value.nextCursor)
      root.append(
        button("下一页往来", () => render(response.value.nextCursor)),
      );
    if (cursor) root.append(button("返回第一页往来", () => render()));
    const fold = el("details", "social-settings-fold");
    fold.append(
      el("summary", "", "实例社交设置"),
      button("读取当前设置", settings),
    );
    root.append(fold);
  }
  return {
    render,
    close() {
      closed = true;
      clear("往来面板已关闭。");
    },
  };
}
