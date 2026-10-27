// 概览顶部的“上线清单”：只读 /api/status 的 readiness，修复动作复用现有管理接口。
let onboardingAgentId,
  onboardingExpanded = false,
  modePending = false;
const placeholderPill = () => tag("示例占位", "warn");
const readinessBackendStates = {
  unchecked: "尚未检测",
  disconnected: "连接已断开",
  recovering: "恢复中",
  "login-required": "需要登录",
  "selection-required": "需要选择 DSH 实例",
};
function onboardingStep(s, r, liveReady) {
  const a = find("agents", s.agentId),
    c = find("connections", s.connectionId),
    b = find("backends", s.backendId),
    placeholder =
      s.id === "account" && r.placeholders.connections.includes(s.connectionId),
    cName = `「${esc(c?.label || s.connectionId)}」`,
    need = liveReady ? "" : "disabled title='请先完成前两步'";
  const fix = (attrs, label, cls = "") =>
    `<button class="${cls}" ${attrs}>${label}</button>`;
  const doFix = (kind, id, label, extra = "") =>
    fix(`data-do="${kind}" data-id="${esc(id)}" ${extra}`, label);
  const texts = {
    "live-flag": () => [
      "以 --live 启动服务",
      s.done
        ? "本次服务带 --live 启动，允许真实接入。"
        : "当前进程没有带 --live，不能连接 QQ。请停止服务，加上 --live 重新启动（例如 node src/main.mjs --data 数据目录 --live）。",
      "",
    ],
    mode: () => [
      "切换到运行模式",
      s.done
        ? "配置为运行模式；可随时切回隔离模式。"
        : "配置仍是隔离模式：不会连接 QQ，也不会启动模型回合。",
      s.done
        ? fix(
            `data-onboard="mode" data-mode="isolated" ${modePending ? "disabled" : ""}`,
            "切回隔离模式",
            "ghost",
          )
        : fix(
            `data-onboard="mode" data-mode="live" ${!status.allowLive ? "disabled title='需要先以 --live 重启服务'" : modePending ? "disabled" : ""}`,
            "切换到运行模式",
            "primary",
          ),
    ],
    account: () => [
      "填写真实 QQ 账号",
      !c
        ? "角色绑定的 QQ 账号不存在，请在角色配置中重新选择。"
        : s.done
          ? `实例${cName}使用账号 ${esc(c.accountId)}。`
          : `实例${cName}仍是示例账号 ${esc(c.accountId)}，连接时会因登录账号不匹配被拒绝。`,
      !c
        ? doFix("edit-agent", s.agentId, "配置角色")
        : s.done
          ? ""
          : doFix("edit-connection", c.id, "编辑实例"),
    ],
    "connection-enabled": () => [
      "启用 QQ 账号",
      s.done
        ? `实例${cName}已启用。`
        : `实例${cName}未启用，无法连接。请在实例编辑中勾选“启用”。`,
      s.done || !c ? "" : doFix("edit-connection", c.id, "编辑实例"),
    ],
    "connection-connected": () => [
      "连接 QQ",
      s.done
        ? `实例${cName}已连接。`
        : `实例${cName}尚未连接${s.detail?.error ? "（" + esc(s.detail.error) + "）" : ""}。连接前会核对实际登录账号。`,
      s.done || !c
        ? ""
        : doFix(
            "connect",
            c.id,
            "连接 QQ",
            liveReady && c.enabled ? "" : "disabled title='请先完成前面的步骤'",
          ),
    ],
    whitelist: () => [
      "设置群聊或私聊白名单",
      s.done
        ? `已允许 ${s.detail.groups} 个群、${s.detail.users} 位私聊对象。`
        : "角色还没有允许任何群或私聊对象，不会回应任何会话。",
      s.done ? "" : doFix("edit-agent", s.agentId, "配置角色"),
    ],
    "global-pause": () => [
      "解除全局暂停",
      s.done
        ? "全局参与已开启。"
        : "每次启动都会全局暂停；解除后各角色自己的暂停仍然生效。",
      s.done ? "" : fix(`data-onboard="resume" ${need}`, "解除全局暂停"),
    ],
    "agent-pause": () => [
      "解除角色暂停",
      s.done
        ? `${esc(a?.name)} 已允许参与。`
        : `${esc(a?.name)} 仍处于暂停状态，不会发言。`,
      s.done ? "" : doFix("toggle", s.agentId, "解除角色暂停", need),
    ],
    backend: () => [
      "检测 AI 后端",
      s.done
        ? `后端「${esc(b?.label || s.backendId)}」已就绪。`
        : `后端「${esc(b?.label || s.backendId)}」${esc(readinessBackendStates[s.detail?.state] || s.detail?.state)}${s.blocking ? "，角色暂时无法回应。" : "；建议先检测一次，确认模型可用。"}`,
      s.done ? "" : doFix("backend-check", s.backendId, "检测连接", need),
    ],
    other: () => [
      blockerLabels[s.detail?.code] || s.detail?.code,
      "这项限制不在清单内，例如静默时段会在时段结束后自动解除。",
      "",
    ],
    agent: () => [
      "添加角色",
      "还没有任何角色。",
      doFix("add", "agents", "添加角色"),
    ],
  }[s.id];
  const text = texts ? texts() : [s.id, "", ""];
  const state = s.done ? "done" : s.blocking ? "blocking" : "pending";
  return `<li class="step ${state}"><span class="step-mark" aria-label="${s.done ? "已完成" : "待处理"}">${s.done ? "✓" : ""}</span><div class="step-body"><strong>${esc(text[0])}</strong>${placeholder ? placeholderPill() : ""}<p class="hint">${text[1]}</p></div>${text[2] ? `<div class="step-fix">${text[2]}</div>` : ""}</li>`;
}
function onboardingMarkup() {
  const r = status.readiness;
  if (!r) return "";
  if (!config.agents.some((a) => a.id === onboardingAgentId))
    onboardingAgentId = r.focusAgentId;
  const entry = r.agents.find((a) => a.agentId === onboardingAgentId),
    steps = entry?.steps || r.steps,
    a = find("agents", onboardingAgentId),
    done = steps.filter((s) => s.done).length,
    liveReady = status.allowLive && status.mode === "live",
    agentPlaceholder = r.placeholders.agents.includes(onboardingAgentId);
  const picker =
    config.agents.length > 1
      ? `<label class="onboarding-agent">目标角色<select id="onboarding-agent">${config.agents.map((x) => `<option value="${esc(x.id)}" ${x.id === onboardingAgentId ? "selected" : ""}>${esc(x.name)}${r.placeholders.agents.includes(x.id) ? "（示例占位）" : ""}${r.agents.find((y) => y.agentId === x.id)?.ready ? " · 已就绪" : ""}</option>`).join("")}</select></label>`
      : "";
  if (entry?.ready && !onboardingExpanded)
    return `<section class="card onboarding ready" id="onboarding"><div class="row">${tag("已就绪", "live")}<span class="onboarding-summary">${esc(a?.name)} 已通过全部上线检查，可在白名单会话中发言。</span><button class="ghost" data-onboard="expand">查看清单</button></div></section>`;
  return `<section class="card onboarding" id="onboarding"><div class="row"><h2>上线清单 ${tag(`${done}/${steps.length}`, entry?.ready ? "live" : "accent")}</h2>${picker}</div><p class="hint">按顺序完成以下各项，${a ? `「${esc(a.name)}」` : "角色"}才会在 QQ 中发言。每一步都可单独撤回，启动后总是先回到全局暂停。</p>${agentPlaceholder ? `<p class="hint">${placeholderPill()} 该角色的名称或人格仍是安装时的示例，建议在“配置角色”中改成自己的设定。</p>` : ""}<ol class="checklist">${steps.map((s) => onboardingStep(s, r, liveReady)).join("")}</ol>${entry?.ready ? '<div class="card-actions"><button class="ghost" data-onboard="collapse">收起</button></div>' : ""}</section>`;
}
async function switchMode(mode) {
  const message =
    mode === "live"
      ? "切换到运行模式？\n\n· 配置会写入 mode: live。之后必须带 --live 启动，否则服务会拒绝启动。\n· 切换本身不会连接 QQ，也不会解除任何暂停：全局暂停和角色暂停仍然生效。\n· 所有 QQ 账号会按新模式重新配置，需要再手动连接。\n\n随时可以在这里切回隔离模式。"
      : "切回隔离模式？\n\n· 立即断开所有 QQ 连接，角色不再收发 QQ 消息，进行中的回合也无法再发送。\n· 暂停设置和白名单保持不变。\n· 之后需要重新切换到运行模式并手动连接。";
  if (modePending || !confirm(message)) return;
  modePending = true;
  bindOnboarding();
  try {
    await api("/api/mode", { mode, revision });
    await load();
    notice(
      mode === "live"
        ? "已切换到运行模式；QQ 连接与暂停状态保持不变，请继续完成清单"
        : "已切回隔离模式，所有 QQ 连接已断开",
    );
  } finally {
    modePending = false;
    if (tab === "overview") bindOnboarding();
  }
}
function bindOnboarding() {
  const box = $("#onboarding");
  if (!box) return;
  box.outerHTML = onboardingMarkup();
  wireOnboarding();
}
function wireOnboarding() {
  const box = $("#onboarding");
  if (!box) return;
  box
    .querySelectorAll("[data-do]")
    .forEach(
      (b) =>
        (b.onclick = () => action(() => operate(b.dataset.do, b.dataset.id))),
    );
  box.querySelectorAll("[data-onboard]").forEach(
    (b) =>
      (b.onclick = () => {
        const kind = b.dataset.onboard;
        if (kind === "mode") return action(() => switchMode(b.dataset.mode));
        if (kind === "resume") return action(() => setGlobalPaused(false));
        onboardingExpanded = kind === "expand";
        bindOnboarding();
      }),
  );
  const picker = $("#onboarding-agent");
  if (picker)
    picker.onchange = () => {
      onboardingAgentId = picker.value;
      onboardingExpanded = false;
      bindOnboarding();
    };
}
function renderOnboarding(content) {
  content.insertAdjacentHTML("afterbegin", onboardingMarkup());
  wireOnboarding();
}
