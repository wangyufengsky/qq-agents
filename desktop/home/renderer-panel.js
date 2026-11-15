/* global document, window */
import { bindRecentBubbles } from "./renderer-bubbles.js";
import {
  element,
  assetPath,
  avatar,
  button,
  activityLabels,
  bodyStateLabels,
  bodyPoseLabels,
  bodyFacingLabels,
  followModeLabels,
  followResultLabels,
  observationPermissionHelp,
  observationEndLabels,
  observationEligibilityLabels,
  bodyReasonLabels,
  activityFor,
} from "./renderer-shared.js";
import { bindObservationResults } from "./renderer-observation.js";
import { bindPersonal } from "./renderer-personal.js";

const bodyIntentLabels = {
  "approach-window": "正在靠近关注窗口",
  "approach-peer": "正在靠近同伴",
  gather: "正在与同伴聚拢",
};

export function panel(root) {
  root.append(
    document.getElementById("panel-template").content.cloneNode(true),
  );
  const updatePersonal = bindPersonal(root);
  const statusDialog = document.createElement("dialog");
  statusDialog.className = "status-dialog";
  const statusTitle = document.createElement("h2");
  const statusText = document.createElement("p");
  statusText.className = "personal-history";
  const statusClose = document.createElement("button");
  statusClose.type = "button";
  statusClose.textContent = "关闭";
  statusClose.addEventListener("click", () => statusDialog.close());
  statusDialog.addEventListener("close", () => {
    if (statusDialog.open) return;
    statusTarget = undefined;
    statusTitle.textContent = "";
    statusText.textContent = "";
  });
  statusDialog.append(statusTitle, statusText, statusClose);
  root.append(statusDialog);
  let statusTarget;
  window.nest.onStatusCard?.((value) => {
    if (typeof value.title !== "string" || typeof value.text !== "string")
      return;
    statusTarget = value.target;
    statusTitle.textContent = value.title;
    statusText.textContent = value.text;
    if (!statusDialog.open) statusDialog.showModal();
  });
  const select = (selector) => root.querySelector(selector);
  const guestList = select(".guest-list");
  const guestActivities = select(".guest-activities");
  const guestActivityList = select(".guest-activity-list");
  const updateRecentBubbles = bindRecentBubbles(select(".recent-bubbles"));
  const bodyAnnouncement = select(".body-announcement");
  const observationEnded = root.querySelectorAll(".observation-ended");
  const observationTab = select('[data-tab="observation"]');
  const observationResults = select("#observation-results");
  const bodyZones = select(".body-zones");
  bodyZones.addEventListener("click", () => window.nest.act("body-zones"));
  const audience = select(".audience");
  const thread = select(".thread");
  const message = select("#message");
  const send = select('.composer button[type="submit"]');
  const taskOptions = select(".window-task-options");
  const taskScope = select("#window-task-scope");
  const taskRole = select("#window-task-role");
  const taskFeedback = select(".window-task-feedback");
  const taskStatus = select(".window-task-status");
  const taskStop = select(".window-task-stop");
  const attach = select(".attach");
  const attachmentStatus = select(".attachment-status");
  let attaching = false;
  const settings = select(".settings");
  const turnStatus = select(".turn-status");
  const activityControl = button("quiet", "暂停自主活动");
  activityControl.hidden = true;
  activityControl.addEventListener("click", () => {
    if (room?.activityEnabled)
      window.nest.act("activity-pause", !room.activityPaused);
  });
  select(".desktop-permissions").prepend(activityControl);
  const settingsForm = select(".timer-settings");
  const minutes = select("#minutes");
  const timerOn = select("#timer-on");
  const browserControl = select(".browser-control");
  const browserControlButton = select(".browser-control-button");
  const browserStatus = browserControl.querySelector("p");
  const browserDialog = select(".browser-permission-dialog");
  const browserForm = select(".browser-permission-form");
  const browserRole = select("#browser-role");
  const browserOrigin = select("#browser-origin");
  const browserError = select(".browser-permission-error");
  const browserSubmit = select(".browser-permission-submit");
  let changingBrowser = false;
  let browserRoster;
  let browserEpoch;
  let browserRevokeError = false;
  let room;
  let lastId;
  let roomEpoch;
  let lastRoster;
  let selectedWindowGrant;
  const guests = new Map();
  const announcedBodyFeedback = new Map();
  const clock = new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
  const toolsLauncher = select(".tools-launch");
  const toolsList = select(".desktop-permissions");
  const companionOptions = select(".companion-options");
  const companionSelect = select(".companion-mode");
  const companionStatus = select(".companion-status");
  const sensitiveInput = select(".sensitive-applications");
  const sensitiveSave = select(".sensitive-applications-save");
  const frameReceiptSection = select(".frame-receipts");
  let displayedFrameReceipts;
  let displayedApplications;
  let changingCompanion = false;

  function windowObservationGrants(policy) {
    if (policy?.windowGrants?.length) return policy.windowGrants;
    return policy?.grantedAgentId
      ? [{ ...policy, agentId: policy.grantedAgentId }]
      : [];
  }

  function updateCompanion() {
    const preference = room?.companion;
    companionOptions.hidden =
      !room?.connected || !preference || !window.nest.companionMode;
    if (companionOptions.hidden) return;
    companionSelect.value = preference.mode;
    const applying = changingCompanion || !preference.ready;
    companionSelect.disabled = changingCompanion;
    sensitiveSave.disabled = applying;
    const applications = preference.applications?.join("\n") ?? "";
    if (displayedApplications !== applications) {
      displayedApplications = applications;
      sensitiveInput.value = applications;
    }
    const controls =
      room.nativeControl?.grantedAgentId || room.browserControl?.grantedAgentId;
    const viewing =
      room.screenView?.grants?.length ||
      room.screenView?.grantedAgentId ||
      windowObservationGrants(room.observation).length ||
      room.observation?.displays?.length;
    const frameReceipts = room.frameReceipts ?? [];
    const renderedFrames = JSON.stringify(frameReceipts);
    frameReceiptSection.hidden = !frameReceipts.length;
    if (renderedFrames !== displayedFrameReceipts) {
      displayedFrameReceipts = renderedFrames;
      const labels = {
        "model-submitted": "画面已提交模型",
        "framework-received": "画面已提交给框架，模型接收未确认",
      };
      frameReceiptSection
        .querySelector("ul")
        .replaceChildren(
          ...frameReceipts
            .filter(
              ({ at, state }) =>
                Number.isFinite(at) && Object.hasOwn(labels, state),
            )
            .map(({ agentId, at, state }) =>
              element(
                "li",
                null,
                `${clock.format(at)} · ${room.roles.find(({ id }) => id === agentId)?.name ?? "来访角色"} · ${labels[state]}`,
              ),
            ),
        );
    }
    const handoff = room.nativeControl?.handoff;
    companionStatus.textContent =
      handoff === "pending" || handoff === "unconfirmed"
        ? "已发出操作，结果未确认。"
        : applying
          ? "正在同步陪伴模式…"
          : preference.mode === "privacy"
            ? "屏幕、窗口和网页权限已关闭。"
            : preference.verifiedWindowSurface === false
              ? "暂无法核验入镜窗口，屏幕与本机窗口权限不可用。"
              : controls || viewing
                ? "当前目标已授权。"
                : "待确认目标";
  }

  async function changeCompanion(action, value) {
    if (changingCompanion || !window.nest.companionMode) return;
    changingCompanion = true;
    updateCompanion();
    let applied;
    try {
      applied = await window.nest.companionMode({ action, value });
    } catch {
      applied = false;
    } finally {
      changingCompanion = false;
      updateCompanion();
      if (!applied) companionStatus.textContent = "暂无法保存，请重试。";
    }
  }
  companionSelect.addEventListener(
    "change",
    () => void changeCompanion("mode", companionSelect.value),
  );
  sensitiveSave.addEventListener(
    "click",
    () =>
      void changeCompanion(
        "applications",
        sensitiveInput.value
          .split(/\r?\n/)
          .map((value) => value.trim())
          .filter(Boolean),
      ),
  );
  const chatSheet = select(".chat-sheet");
  const sheetTitle = select("#chat-sheet-title");
  const manager = select(".display-manager");
  const picker = select(".display-picker");
  const taskPicker = select(".task-picker");
  const grantRoster = select(".display-roster");
  const readSelection = select(".read-selection");
  const readChoices = select(".read-choices");
  const readSelectAll = select(".read-select-all");
  const readCommonTarget = select(".read-common-target");
  const screenViewButton = select(".screen-view-button");
  const screenGrantCount = select(".screen-grant-count");
  const revokeAll = select(".read-revoke-all");
  const displayConfirm = select(".display-confirm");
  const displayError = select(".display-error");
  const plus = select(".composer-plus");
  const composerMenu = select(".composer-menu");
  const openTask = select(".open-task");
  const taskDraft = select(".task-draft");
  const useTask = select(".use-task");
  let sheetOrigin;
  let sheetView;
  let pickerEpoch;
  let displayBusy = false;
  let displayRosterKey;
  let pickerLimits;
  let readScope = "display";
  let readRoster = [];

  function toggleComposerMenu(open, focus = false) {
    composerMenu.hidden = !open;
    plus.setAttribute("aria-expanded", String(open));
    if (focus) {
      const next = open
        ? composerMenu.querySelector("button:not([hidden]):not(:disabled)")
        : plus;
      next?.focus();
    }
  }

  function openChatSheet(view, title, origin) {
    toggleComposerMenu(false);
    sheetView = view;
    for (const part of [toolsList, manager, picker, taskPicker])
      part.hidden = part !== view;
    displayError.hidden = true;
    sheetTitle.textContent = title;
    if (!chatSheet.open) {
      sheetOrigin = origin ?? document.activeElement;
      chatSheet.showModal();
    }
    chatSheet.querySelector(".chat-sheet-body").scrollTop = 0;
    select(".sheet-close").focus({ preventScroll: true });
  }

  function closeChatSheet() {
    if (!chatSheet.open) return;
    chatSheet.close();
    if (room) refreshWindowTask();
    sheetOrigin?.focus({ preventScroll: true });
  }

  const openTools = () => openChatSheet(toolsList, "小窝工具");
  const readTitle = () =>
    readScope === "display" ? "自主观察显示器" : "查看屏幕";
  const openManager = () => {
    openChatSheet(manager, readTitle());
    refreshDisplayGrants();
  };
  toolsLauncher.addEventListener("click", openTools);
  select(".sheet-close").addEventListener("click", closeChatSheet);
  chatSheet.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeChatSheet();
  });
  chatSheet.addEventListener("click", (event) => {
    if (event.target === chatSheet) closeChatSheet();
  });
  select(".display-manage").addEventListener("click", () => {
    readScope = "display";
    openManager();
  });
  select(".display-back").addEventListener("click", openTools);
  for (const cancel of root.querySelectorAll(".display-cancel"))
    cancel.addEventListener("click", openManager);

  function displayNotice(status, agentId) {
    const message = {
      permission: "请在系统设置中允许屏幕录制后重试。",
      "no-sources": "当前没有可用的显示器或窗口。",
      unavailable: "角色资格或目标已变更，请重新选择。",
      failed: "未能更新授权，请重试。",
    }[status];
    const role = room?.roles.find(({ id }) => id === agentId);
    displayError.textContent =
      message && role ? `${role.name} · ${message}` : (message ?? "");
    displayError.hidden = !message;
  }

  async function chooseRead(action, data) {
    try {
      const choose =
        readScope === "display"
          ? window.nest.displayObservation
          : window.nest.screenView;
      return await choose(action, data);
    } catch {
      return { status: "failed" };
    }
  }

  async function revokeRead(action, data) {
    if (displayBusy) return;
    displayBusy = true;
    refreshDisplayGrants();
    const result = await chooseRead(action, data);
    displayBusy = false;
    if (chatSheet.open && sheetView === manager) {
      displayNotice(result?.status, result?.agentId);
      refreshDisplayGrants();
    }
  }

  function observationStatus(grant, ended) {
    if (ended?.state === "revoked") return "已撤销";
    if (ended?.state === "unavailable") return "授权已失效";
    const status = {
      waiting: "等待空闲机会",
      deciding: "她在决定",
      declined: "她选择这次不看",
      capturing: "她想看一眼 · 等待取图",
      viewed: "已看一眼",
      incomplete: "本次未完成",
    }[grant?.opportunity ?? ended?.opportunity];
    if (ended?.state === "expired")
      return `授权已到期${ended.opportunity === "waiting" ? " · 到期前未轮到" : status ? ` · ${status}` : ""}`;
    const waiting = grant?.waiting;
    const reason = {
      target: "正在确认显示器",
      quota: "本小时空闲额度已用完",
      chat: "正在处理桌边聊天",
      rest: waiting?.until && `休息到 ${clock.format(waiting.until)}`,
      wait: waiting?.until && `等待到 ${clock.format(waiting.until)}`,
    }[waiting?.reason];
    return status && reason ? `${status} · ${reason}` : status;
  }

  function refreshDisplayGrants() {
    const observation = room?.observation;
    const screen = room?.screenView;
    const displays = observation?.displays;
    const showDisplays =
      room?.connected &&
      window.nest.displayObservation &&
      Array.isArray(displays);
    const showScreens =
      room?.connected &&
      window.nest.screenView &&
      Array.isArray(screen?.grants);
    select(".display-observation").hidden = !showDisplays;
    select(".display-grant-count").textContent = displays?.length
      ? `${displays.length} 位角色已授权`
      : "按角色选择一块屏幕";
    if (showScreens) {
      select(".screen-view").hidden = false;
      screenViewButton.hidden = false;
      screenViewButton.disabled = false;
      screenViewButton.textContent = "管理 ›";
      screenViewButton.setAttribute("aria-label", "管理查看屏幕");
      screenGrantCount.hidden = false;
      screenGrantCount.textContent = screen.grants.length
        ? `${screen.grants.length} 位角色已授权`
        : "可授权多位角色";
    } else {
      screenViewButton.removeAttribute("aria-label");
      screenGrantCount.hidden = true;
    }
    const observe = readScope === "display";
    const available = observe ? showDisplays : showScreens;
    const policy = observe ? observation : screen;
    const grants = observe ? displays : screen?.grants;
    const eligible = policy?.eligible ?? [];
    if (sheetView === picker && chatSheet.open) {
      if (
        !available ||
        room.roomEpoch !== pickerEpoch ||
        (observe && pickerLimits !== JSON.stringify(observation.displayLimits))
      ) {
        openManager();
        return;
      }
      refreshDisplayChoice();
    }
    if (sheetView !== manager || !chatSheet.open) return;
    select(".read-help").textContent = observe
      ? "角色空闲时，可以自己决定是否看一眼获准的屏幕。"
      : "获准角色可在桌边回合里查看选定的窗口或显示器。";
    select(".display-add").textContent = observe
      ? "选择角色与显示器"
      : "选择角色与查看目标";
    select(".display-add").disabled =
      !available || !eligible.length || displayBusy;
    revokeAll.hidden = !grants?.length;
    revokeAll.disabled = displayBusy;
    if (!available) {
      displayRosterKey = undefined;
      grantRoster.replaceChildren();
      return;
    }
    const roles = room.roles.filter(({ state }) => state === "here");
    const history = observe ? observation.displayHistory : undefined;
    const key = JSON.stringify([
      room.roomEpoch,
      readScope,
      displayBusy,
      roles.map(({ id, name, art, color }) => [id, name, art, color]),
      eligible,
      grants,
      history,
      policy.ineligible,
    ]);
    if (key === displayRosterKey) return;
    displayRosterKey = key;
    grantRoster.replaceChildren();
    for (const role of roles) {
      const grant = grants.find(({ agentId }) => agentId === role.id);
      const ended = history?.find(({ agentId }) => agentId === role.id);
      const row = element("div", "resident-grant");
      const identity = element("div", "resident-grant-id");
      const words = element("div");
      const permitted = eligible.includes(role.id);
      const detail = grant
        ? observe
          ? `${grant.target ?? "显示器"} · ${clock.format(grant.expiresAt)} 到期 · 剩余 ${grant.remaining} 次`
          : (grant.target ?? "已授权")
        : permitted
          ? "未授权"
          : (observationEligibilityLabels[
              policy.ineligible?.find(({ id }) => id === role.id)?.reason
            ] ?? "暂不可授权");
      words.append(element("strong", null, role.name));
      if (!ended || grant)
        words.append(element("p", grant ? "display-active" : null, detail));
      const state = observe && observationStatus(grant, ended);
      if (state) words.append(element("p", "observation-opportunity", state));
      identity.append(avatar(role), words);
      const actions = element("div", "grant-actions");
      if (grant) {
        const revoke = button("quiet", "撤销");
        revoke.setAttribute(
          "aria-label",
          `撤销${role.name}的${observe ? "显示器授权" : "看屏授权"}`,
        );
        revoke.disabled = displayBusy;
        revoke.addEventListener(
          "click",
          () =>
            void revokeRead("revoke", {
              agentId: role.id,
              grantId: grant.grantId,
            }),
        );
        actions.append(revoke);
      }
      const edit = button("secondary", grant ? "更换" : "授权");
      edit.setAttribute(
        "aria-label",
        `${grant ? "更换" : "授权"}${role.name}的${observe ? "显示器" : "看屏目标"}`,
      );
      edit.disabled = !permitted || displayBusy;
      edit.addEventListener("click", () => void openPicker(role.id));
      actions.append(edit);
      row.append(identity, actions);
      grantRoster.append(row);
    }
  }

  function targetOptions(targets) {
    const empty = element("option", null, "请选择目标");
    empty.value = "";
    return [
      empty,
      ...targets.map(({ id, name, number, primary }) => {
        const label = number
          ? `显示器 ${number} · ${name}${primary ? "（主屏）" : ""}`
          : `窗口 · ${name}`;
        const option = element("option", null, label);
        option.value = id;
        return option;
      }),
    ];
  }

  async function openPicker(agentId) {
    if (displayBusy || !room?.connected) return;
    const epoch = room.roomEpoch;
    const scope = readScope;
    const observe = scope === "display";
    const policy = observe ? room.observation : room.screenView;
    const visitAtOpen = new Map(
      room.roles
        .filter(
          ({ id, state }) => state === "here" && policy.eligible.includes(id),
        )
        .map((role) => [role.id, role.bodyVisitId]),
    );
    displayBusy = true;
    refreshDisplayGrants();
    const result = await chooseRead("list");
    displayBusy = false;
    if (
      !chatSheet.open ||
      sheetView !== manager ||
      room.roomEpoch !== epoch ||
      scope !== readScope
    )
      return;
    if (result?.status !== "listed" || !result.displays?.length) {
      displayNotice(
        result?.status === "listed" ? "no-sources" : result?.status,
      );
      refreshDisplayGrants();
      return;
    }
    pickerEpoch = epoch;
    const limits = room.observation?.displayLimits;
    pickerLimits = JSON.stringify(limits);
    readChoices.replaceChildren();
    readCommonTarget.replaceChildren(...targetOptions(result.displays));
    readRoster = room.roles
      .filter(
        ({ id, bodyVisitId }) =>
          visitAtOpen.has(id) && visitAtOpen.get(id) === bodyVisitId,
      )
      .map((role) => {
        const row = element("div", "read-choice");
        const label = element("label");
        const check = document.createElement("input");
        check.type = "checkbox";
        check.checked = role.id === agentId;
        label.append(check, document.createTextNode(role.name));
        const target = document.createElement("select");
        target.setAttribute("aria-label", `${role.name}的查看目标`);
        target.replaceChildren(...targetOptions(result.displays));
        row.append(label, target);
        readChoices.append(row);
        return { role, target, check };
      });
    select(".display-limits").textContent =
      observe && limits
        ? `每位角色最长 ${limits.minutes} 分钟，最多尝试取图 ${limits.attempts} 次。回复和摘要留在本机观察页。确认后替换所选角色已有的显示器授权。`
        : "确认后替换所选角色已有的看屏授权。";
    select(".display-cancel").textContent = `‹ ${readTitle()}`;
    openChatSheet(picker, observe ? "授权观察显示器" : "授权查看屏幕");
    refreshDisplayChoice();
    (
      readRoster.find(({ check }) => check.checked)?.target ?? readSelectAll
    ).focus();
  }

  function refreshDisplayChoice() {
    const eligible =
      (readScope === "display" ? room.observation : room.screenView)
        ?.eligible ?? [];
    const stale = [];
    const valid = readRoster.filter(({ role, check, target }) => {
      const available =
        eligible.includes(role.id) &&
        room.roles.some(
          ({ id, state, bodyVisitId }) =>
            id === role.id &&
            state === "here" &&
            role.bodyVisitId === bodyVisitId,
        );
      check.disabled = !available && !check.checked;
      if (!available && check.checked) stale.push(role.id);
      target.disabled = !available || !check.checked;
      return available;
    });
    if (stale.length) displayNotice("unavailable", stale[0]);
    const selected = valid.filter(({ check }) => check.checked);
    readSelection.disabled = displayBusy;
    readSelectAll.disabled = !valid.length;
    readSelectAll.checked =
      valid.length > 0 && valid.length === selected.length;
    readSelectAll.indeterminate = selected.length > 0 && !readSelectAll.checked;
    readCommonTarget.disabled = !selected.length;
    displayConfirm.disabled =
      displayBusy ||
      stale.length > 0 ||
      !selected.length ||
      selected.some(({ target }) => !target.value);
  }

  screenViewButton.addEventListener("click", () => {
    if (!Array.isArray(room?.screenView?.grants)) return;
    readScope = "screen";
    openManager();
  });
  revokeAll.addEventListener("click", () => void revokeRead("revoke-all"));
  select(".display-add").addEventListener("click", () => void openPicker());
  readSelectAll.addEventListener("change", () => {
    for (const { check } of readRoster)
      if (!check.disabled) check.checked = readSelectAll.checked;
  });
  readCommonTarget.addEventListener("change", () => {
    for (const { check, target } of readRoster)
      if (check.checked && !check.disabled && readCommonTarget.value)
        target.value = readCommonTarget.value;
    readCommonTarget.value = "";
  });
  picker.addEventListener("change", refreshDisplayChoice);
  picker.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (displayConfirm.disabled) return;
    const selections = readRoster
      .filter(({ check }) => check.checked && !check.disabled)
      .map(({ role, target }) => ({ agentId: role.id, display: target.value }));
    displayBusy = true;
    refreshDisplayChoice();
    const result = await chooseRead("grant", { selections });
    displayBusy = false;
    if (sheetView !== picker || !chatSheet.open) return;
    if (result?.status === "granted") openManager();
    else {
      displayNotice(result?.status, result?.agentId);
      refreshDisplayChoice();
    }
  });
  plus.addEventListener("click", () =>
    toggleComposerMenu(composerMenu.hidden, composerMenu.hidden),
  );
  document.addEventListener("pointerdown", (event) => {
    if (
      !composerMenu.hidden &&
      !composerMenu.contains(event.target) &&
      !plus.contains(event.target)
    )
      toggleComposerMenu(false);
  });
  openTask.addEventListener("click", () =>
    openChatSheet(taskPicker, "窗口任务", plus),
  );
  select(".task-clear").addEventListener("click", () => {
    taskScope.value = "";
    selectedWindowGrant = undefined;
    refreshWindowTask();
    message.focus();
  });
  useTask.addEventListener("click", () => {
    closeChatSheet();
    refreshWindowTask();
    message.focus();
  });

  const updateObservationResults = bindObservationResults(
    observationResults,
    clock,
  );

  function bindDesktopPermission(selector, key, labels, notices) {
    const section = select(selector);
    const button = section.querySelector("button");
    const notice = section.querySelector(".desktop-permission-status");
    let choosing = false;
    let lastAgent;
    function refresh() {
      const policy = room?.[key];
      const selected =
        key === "observation" ? windowObservationGrants(policy) : [];
      const agentId = selected.length
        ? selected[0].agentId
        : policy?.grantedAgentId;
      const agent = room?.roles.find(({ id }) => id === agentId);
      const hasAuthorization =
        key === "observation" ? selected.length > 0 : Boolean(agent);
      const canAuthorize = Boolean(hasAuthorization || policy?.eligible.length);
      const grantIdentity =
        key === "observation"
          ? selected.map(({ grantId, agentId }) => grantId ?? agentId).join(",")
          : agent?.id;
      if (lastAgent !== grantIdentity) {
        lastAgent = grantIdentity;
        notice.hidden = true;
      }
      section.hidden =
        !room?.connected ||
        !window.nest[key] ||
        (!canAuthorize && !policy?.ineligible?.length);
      button.hidden = !canAuthorize;
      button.disabled = choosing;
      button.textContent = hasAuthorization ? labels.revoke : labels.grant;
      button.title = hasAuthorization
        ? agent
          ? `当前授权给${agent.name}`
          : "当前已有授权"
        : labels.help;
      if (key === "nativeControl") {
        const holder = section.querySelector(".native-holder");
        holder.hidden = !agent && !policy?.handoff;
        holder.textContent =
          policy?.handoff === "pending"
            ? "等待上一项操作回执"
            : policy?.handoff === "unconfirmed"
              ? "请先核对窗口"
              : agent
                ? `${agent.name} · ${policy.target ?? "已选窗口"}`
                : "";
        const change = section.querySelector(".native-switch");
        change.hidden = !agent || !policy.eligible.length;
        change.disabled = choosing || policy?.handoff === "pending";
        if (policy?.handoff === "pending" && !agent) button.disabled = true;
      }
    }
    const change = async (action) => {
      if (section.hidden || button.hidden || choosing) return;
      choosing = true;
      refresh();
      let status;
      try {
        status = await window.nest[key](action);
      } catch {
        status = "failed";
      } finally {
        choosing = false;
        refresh();
      }
      notice.hidden = !notices[status];
      notice.textContent = notices[status] ?? "";
    };
    button.addEventListener("click", () => {
      if (key === "screenView" && Array.isArray(room?.screenView?.grants))
        return;
      void change();
    });
    section
      .querySelector(".native-switch")
      ?.addEventListener("click", () => void change("switch"));
    return refresh;
  }

  const updateScreenView = bindDesktopPermission(
    ".screen-view",
    "screenView",
    {
      grant: "授权查看屏幕",
      revoke: "撤销屏幕授权",
      help: "选择可查看的角色和窗口或显示器",
    },
    {
      granted: "已授权。角色请求时会截取一帧。",
      revoked: "已撤销屏幕授权。",
      permission: "请在系统设置中允许屏幕录制后重试。",
      "no-sources": "当前没有可选窗口或显示器。",
      unavailable: "当前无法更改屏幕授权。",
      failed: "屏幕授权操作失败。",
    },
  );
  const updateObservation = bindDesktopPermission(
    ".observation",
    "observation",
    {
      grant: "授权自主观察窗口",
      revoke: "撤销自主观察",
      help: "为在场角色选择一个窗口，许可最长 15 分钟",
    },
    {
      granted: "已授权。最多尝试观察四次。",
      revoked: "已撤销自主观察。",
      permission: observationPermissionHelp,
      "no-sources": "当前没有可选窗口。",
      "missing-helper":
        "缺少 agent-desktop。请运行 npm run setup -- desktop --data <数据目录> 后重新打开桌面小窝。",
      unavailable: "当前无法更改自主观察授权。",
      failed: "自主观察授权操作失败。",
    },
  );
  const observationTarget = select(".observation-target");
  const observationRetention = select("#observation-retention-notice");
  const observationIneligible = select(".observation-ineligible");
  let lastObservationIneligible;
  const updateNativeControl = bindDesktopPermission(
    ".native-control",
    "nativeControl",
    {
      grant: "授权控制窗口",
      revoke: "撤销窗口控制",
      help: "选择可以操作窗口的角色和目标窗口",
    },
    {
      granted: "已授权。角色可以在桌面回合中操作选定窗口。",
      revoked: "已撤销窗口控制。",
      permission: "请在系统设置中允许辅助功能访问后重试。",
      "no-sources": "当前没有可选窗口。",
      unavailable: "当前无法更改窗口控制授权。",
      failed: "窗口控制授权操作失败。",
      pending: "旧权限已撤销，等待操作回执后可授予新角色。",
      unconfirmed: "请先核对窗口，再确认授予新角色。",
    },
  );

  function updateBrowserControl() {
    const policy = room?.browserControl;
    const eligible = (room?.roles ?? []).filter(({ id }) =>
      policy?.eligible.includes(id),
    );
    const agent = room?.roles.find(({ id }) => id === policy?.grantedAgentId);
    const visible =
      room?.connected &&
      window.nest.browserControl &&
      (agent || eligible.length);
    browserControl.hidden = !visible;
    browserControlButton.disabled = changingBrowser;
    browserControlButton.textContent = agent ? "撤销站点授权" : "授权访问站点";
    browserStatus.hidden = !agent;
    if (!agent) browserRevokeError = false;
    browserStatus.textContent = agent
      ? `${agent.name} · ${policy.grantedOrigin ?? "站点已授权"}${browserRevokeError ? " · 未能撤销站点授权。" : ""}`
      : "";
    if (
      browserDialog.open &&
      (!visible || agent || room.roomEpoch !== browserEpoch)
    )
      browserDialog.close();
    const roster = JSON.stringify(eligible.map(({ id, name }) => [id, name]));
    if (roster !== browserRoster) {
      const selected = browserRole.value;
      const placeholder = element("option", null, "请选择角色");
      placeholder.value = "";
      browserRole.replaceChildren(
        placeholder,
        ...eligible.map(({ id, name }) => {
          const option = element("option", null, name);
          option.value = id;
          return option;
        }),
      );
      browserRole.value = eligible.some(({ id }) => id === selected)
        ? selected
        : "";
      browserRoster = roster;
    }
  }

  async function changeBrowser(selection) {
    changingBrowser = true;
    browserSubmit.disabled = true;
    updateBrowserControl();
    try {
      return await window.nest.browserControl(selection);
    } catch {
      return "failed";
    } finally {
      changingBrowser = false;
      browserSubmit.disabled = false;
      updateBrowserControl();
    }
  }

  browserControlButton.addEventListener("click", async () => {
    if (changingBrowser || browserControl.hidden) return;
    if (room.browserControl.grantedAgentId) {
      browserRevokeError = (await changeBrowser()) !== "revoked";
      updateBrowserControl();
      return;
    }
    browserForm.reset();
    browserError.hidden = true;
    browserEpoch = room.roomEpoch;
    browserDialog.showModal();
  });
  select(".browser-permission-cancel").addEventListener("click", () =>
    browserDialog.close(),
  );
  browserDialog.addEventListener("close", () => browserForm.reset());
  browserForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (changingBrowser || !browserDialog.open) return;
    const status = await changeBrowser({
      agentId: browserRole.value,
      origin: browserOrigin.value,
    });
    if (status === "granted" && browserDialog.open) browserDialog.close();
    if (!browserDialog.open || status === "cancelled") return;
    browserError.hidden = false;
    browserError.textContent =
      status === "invalid"
        ? "请输入使用默认端口的 HTTP 或 HTTPS 站点来源，例如 https://example.com。"
        : "当前无法授权访问这个站点。";
  });

  function switchSection(section, report = false) {
    if (section === "observation" && observationTab.hidden) return;
    if (!["chat", "visits", "observation"].includes(section)) return;
    if (report) window.nest.setSection?.(section);
    select("#visits").hidden = section !== "visits";
    select("#chat").hidden = section !== "chat";
    observationResults.hidden = section !== "observation";
    for (const tab of root.querySelectorAll("[data-tab]"))
      tab.setAttribute("aria-pressed", String(tab.dataset.tab === section));
    if (section === "chat") {
      closeSettings();
      thread.scrollTop = thread.scrollHeight;
      if (!message.disabled) message.focus();
    }
    updateObservationResults(room);
  }

  function bindResidentInteractions(id) {
    const menu = element("details", "resident-interactions");
    const heading = element("summary", null, "桌宠互动");
    const note = element("small");
    note.setAttribute("role", "status");
    const controls = element("div", "guest-controls");
    let choosing = false;
    const localAction = (text, action) => {
      const control = button("quiet", text);
      control.addEventListener("click", () => window.nest.act(action, id));
      return control;
    };
    const mark = localAction("标记当前停留点", "body-mark-place");
    const go = localAction("去常用停留点", "body-go-place");
    const clear = localAction("清除停留点", "body-clear-place");
    const followAction = (text, mode) => {
      const control = button("quiet", text);
      control.addEventListener("click", async () => {
        choosing = true;
        pointer.disabled = windowFollow.disabled = stop.disabled = true;
        note.textContent = "";
        try {
          const result = await window.nest.follow(id, mode);
          if (!["started", "stopped", "cancelled"].includes(result))
            note.textContent =
              followResultLabels[result] ?? "当前无法改变跟随状态。";
        } catch {
          note.textContent = "当前无法改变跟随状态。";
        } finally {
          choosing = false;
          const role = room.roles.find((role) => role.id === id);
          if (role) updateControls(role);
        }
      });
      return control;
    };
    const pointer = followAction(followModeLabels.pointer, "pointer");
    const windowFollow = followAction(followModeLabels.window, "window");
    const stop = followAction("停止跟随", "stop");
    controls.append(mark, go, clear, pointer, windowFollow, stop);
    menu.append(heading, controls, note);
    function updateControls(role) {
      const here =
        role.state === "here" && role.available && role.bodyControlAvailable;
      const state = role.bodyStatus?.state;
      const busy = ["qq", "paused"].includes(state) || Boolean(role.follow);
      menu.hidden =
        !room.interactionsAvailable ||
        room.connectionLost ||
        (!here && !role.place);
      mark.hidden = !here;
      mark.disabled = busy || state === "moving";
      go.hidden = !here || !role.place;
      go.disabled = busy || role.place !== "saved";
      clear.hidden = !role.place;
      pointer.hidden = !here || !window.nest.follow || Boolean(role.follow);
      windowFollow.hidden = pointer.hidden || !room.windowFollowAvailable;
      stop.hidden = !role.follow;
      pointer.disabled = windowFollow.disabled = stop.disabled = choosing;
    }
    return { menu, update: updateControls };
  }

  function guest(role) {
    if (!guests.has(role.id)) {
      const node = element("article", "guest");
      node.dataset.role = role.id;
      const info = element("div");
      const state = element("small", "guest-state");
      const detail = element("small", "guest-detail");
      const recent = element("small", "guest-recent");
      const name = element("strong", null, role.name);
      info.append(name, state);
      const action = button("secondary");
      action.addEventListener("click", () => {
        if (room.connectionLost) return;
        const current = room.roles.find(({ id }) => id === role.id);
        window.nest.act(current.state === "here" ? "leave" : "invite", role.id);
      });
      const decline = button("quiet", "模拟婉拒", `模拟婉拒 · ${role.name}`);
      decline.addEventListener("click", () =>
        window.nest.act("decline", role.id),
      );
      const controls = element("div", "guest-controls");
      const stop = button("quiet", "停止动作", `停止动作 · ${role.name}`);
      const seat = button("quiet", "回到座位", `回到座位 · ${role.name}`);
      stop.addEventListener("click", () =>
        window.nest.act("body-stop", role.id),
      );
      seat.addEventListener("click", () =>
        window.nest.act("body-seat", role.id),
      );
      controls.append(stop, seat);
      const interactions = bindResidentInteractions(role.id);
      const portrait = avatar(role);
      const visitControls = element("div", "guest-controls");
      const privateReply = button("quiet", "私密对话");
      privateReply.addEventListener("click", () => {
        const target = room?.roles.find(({ id }) => id === role.id);
        if (target?.state === "here" && target.bodyVisitId)
          void window.nest.personal?.("open", {
            agentId: target.id,
            roomEpoch: room.roomEpoch,
            visitId: target.bodyVisitId,
          });
      });
      visitControls.append(action, decline, privateReply);
      node.append(portrait, info, visitControls);
      guestList.append(node);

      const activityCard = element("article", "guest-activity");
      const activityHeader = element("div", "guest-activity-header");
      const activityName = element("h4", null, role.name);
      activityHeader.append(activityName, controls);
      activityCard.append(activityHeader, detail, recent, interactions.menu);
      guestActivityList.append(activityCard);
      guests.set(role.id, {
        node,
        activityCard,
        activityName,
        name,
        portrait,
        state,
        detail,
        recent,
        action,
        decline,
        privateReply,
        stop,
        seat,
        interactions,
      });
    }
    const {
      node,
      activityCard,
      activityName,
      name,
      portrait,
      state,
      detail,
      recent,
      action,
      decline,
      privateReply,
      stop,
      seat,
      interactions,
    } = guests.get(role.id);
    node.dataset.state = role.available ? role.state : "unavailable";
    if (name.textContent !== role.name) {
      name.textContent = activityName.textContent = role.name;
      stop.setAttribute("aria-label", `停止动作 · ${role.name}`);
      seat.setAttribute("aria-label", `回到座位 · ${role.name}`);
    }
    portrait.className = `portrait ${role.color}`;
    const sprite = portrait.querySelector("img");
    const src = assetPath(role.art ?? role.id);
    if (sprite.getAttribute("src") !== src) sprite.src = src;
    decline.hidden = room.live || role.state !== "invited";
    privateReply.hidden =
      !window.nest.personal ||
      !room.connected ||
      role.state !== "here" ||
      !role.bodyVisitId;
    stop.hidden = seat.hidden = role.state !== "here" || !role.available;
    interactions.update(role);
    const [label, text] = {
      home: ["在家", "邀请"],
      invited: ["已邀请 · 等待回应", "取消邀请"],
      here: ["在桌边", "请回家"],
    }[role.state];
    const activity = activityFor(role, room);
    const body = role.bodyStatus;
    const bodyState = body?.state;
    const paused = bodyState === "paused";
    const here = role.available && role.state === "here";
    let status = label;
    if (room.connectionLost) status = "连接中断";
    else if (paused)
      status =
        (body.stateReason ?? body.reason) === "rest"
          ? "休息时段 · 已暂停"
          : bodyStateLabels.paused;
    else if (!role.available) status = "本轮未接入";
    else if (
      here &&
      bodyState !== "qq" &&
      Object.hasOwn(bodyIntentLabels, body?.intent)
    )
      status = bodyIntentLabels[body.intent];
    else if (here && bodyStateLabels[bodyState])
      status = bodyStateLabels[bodyState];
    else if ((here || activity === "sleep") && activity !== "idle")
      status = activityLabels[activity];
    if (state.textContent !== status) state.textContent = status;

    const details = [];
    if (here)
      details.push(bodyPoseLabels[body?.pose], bodyFacingLabels[body?.facing]);
    if (room.interactionsAvailable && role.place === "unavailable")
      details.push("常用停留点不可用，可重新标记");
    if (role.follow)
      details.push(
        followModeLabels[role.follow.mode],
        Number.isFinite(role.follow.until) &&
          `至 ${clock.format(role.follow.until)}`,
      );
    if (
      !room.connectionLost &&
      (paused || bodyState === "waiting") &&
      Number.isFinite(body.until)
    )
      details.push(`至 ${clock.format(body.until)}`);
    const observation = room.observation;
    const observationGrant = windowObservationGrants(observation).find(
      ({ agentId }) => agentId === role.id,
    );
    if (
      !room.connectionLost &&
      here &&
      bodyState === "observing" &&
      observationGrant
    ) {
      details.push(observation.target ?? "授权窗口");
      if (Number.isFinite(observationGrant.expiresAt))
        details.push(`许可至 ${clock.format(observationGrant.expiresAt)}`);
      if (Number.isInteger(observationGrant.remaining))
        details.push(`剩余 ${observationGrant.remaining} 次`);
    }
    const description = details.filter(Boolean).join(" · ");
    detail.hidden = !description;
    if (detail.textContent !== description) detail.textContent = description;
    const reason = Object.hasOwn(bodyReasonLabels, body?.reason)
      ? bodyReasonLabels[body.reason]
      : "";
    const history =
      reason && Number.isFinite(body.at)
        ? `最近 · ${clock.format(body.at)} · ${reason}`
        : "";
    recent.hidden = !history;
    if (recent.textContent !== history) recent.textContent = history;
    activityCard.hidden =
      detail.hidden && recent.hidden && stop.hidden && interactions.menu.hidden;
    action.hidden = !role.available || room.knock?.actor === role.id;
    action.setAttribute("aria-disabled", String(Boolean(room.connectionLost)));
    if (action.textContent !== text) action.textContent = text;
    action.setAttribute("aria-label", `${text} · ${role.name}`);
  }

  function line(entry) {
    const speakerType =
      entry.speakerType ??
      (entry.actor === "system"
        ? "system"
        : entry.actor === "admin"
          ? "administrator"
          : "agent");
    if (speakerType === "system")
      return element("p", "message system", entry.text);
    const role =
      speakerType === "agent" &&
      room.roles.find(({ id }) => id === entry.actor);
    const row = element(
      "div",
      speakerType === "administrator" ? "message mine" : "message",
    );
    row.dataset.actor = entry.actor;
    const words = element("div", "words");
    const author = element(
      "span",
      "author",
      speakerType === "administrator"
        ? "你"
        : (entry.speaker ?? role?.name ?? entry.actor),
    );
    author.title = clock.format(entry.now);
    words.append(author);
    if (entry.text) words.append(element("p", "content", entry.text));
    for (const { name } of entry.attachments || [])
      words.append(element("p", "content attachment", `附件 · ${name}`));
    if (role) row.append(avatar(role));
    row.append(words);
    return row;
  }

  function updateThread() {
    if (room.roomEpoch !== roomEpoch) {
      roomEpoch = room.roomEpoch;
      lastId = undefined;
    }
    const latest = room.messages.at(-1)?.id ?? 0;
    if (latest === lastId) return;
    const pinned =
      thread.scrollHeight - thread.scrollTop - thread.clientHeight < 65;
    if (latest < (lastId ?? 0)) lastId = undefined;
    if (!lastId) thread.replaceChildren();
    if (room.messages.length) {
      for (const entry of room.messages) {
        if (entry.id > (lastId ?? 0)) thread.append(line(entry));
      }
      while (thread.childElementCount > room.messages.length)
        thread.firstElementChild.remove();
    } else
      thread.append(
        element("p", "empty", "桌边还没有消息。邀请一位角色，就可以开聊。"),
      );
    lastId = latest;
    if (pinned || document.activeElement === message)
      thread.scrollTop = thread.scrollHeight;
  }

  function windowTaskGrants(scope) {
    if (!scope || !room?.interactionsAvailable || room.connectionLost)
      return [];
    const grants =
      scope === "screen"
        ? (room.windowTaskScreenGrants ?? [
            {
              agentId: room.windowTaskScreenAgentId,
              grantId: room.windowTaskScreenGrantId,
            },
          ])
        : [
            {
              agentId: room.windowTaskNativeAgentId,
              grantId: room.windowTaskNativeGrantId,
            },
          ];
    return grants.flatMap(({ agentId, grantId }) => {
      const role = room.roles.find(
        (role) =>
          role.id === agentId &&
          role.state === "here" &&
          role.available &&
          role.bodyControlAvailable,
      );
      return role && grantId ? [{ role, grantId }] : [];
    });
  }

  function selectedTask() {
    return windowTaskGrants(taskScope.value).find(
      ({ grantId }) => grantId === selectedWindowGrant,
    );
  }

  function refreshWindowTask() {
    const scope = taskScope.value;
    const status = room.windowTaskStatus;
    const active = ["approaching", "ready"].includes(status?.stage);
    let hasTaskOption = false;
    for (const option of [...taskScope.options].slice(1)) {
      const available = !active && windowTaskGrants(option.value).length > 0;
      option.disabled = !available;
      option.hidden = !available && option.value !== scope;
      hasTaskOption ||= available;
    }
    taskOptions.hidden = !hasTaskOption && !scope;
    openTask.hidden = taskOptions.hidden;
    plus.hidden =
      openTask.hidden &&
      (Boolean(scope) || !room.framework || !window.nest.attach);
    if (plus.hidden) toggleComposerMenu(false);
    const role = selectedTask()?.role;
    const roleLabel = role?.name ?? "授权已失效";
    taskRole.hidden = !scope;
    const taskGrants = windowTaskGrants(scope);
    const roleOptions = taskGrants.map(({ role, grantId }) => [
      role.id,
      role.name,
      grantId,
    ]);
    const roleKey = JSON.stringify(roleOptions);
    if (taskRole.dataset.key !== roleKey) {
      taskRole.dataset.key = roleKey;
      taskRole.replaceChildren(
        ...roleOptions.map(([id, name]) => {
          const option = element("option", null, name);
          option.value = id;
          return option;
        }),
      );
    }
    taskRole.value = role?.id ?? "";
    taskRole.disabled = taskGrants.length < 2;
    useTask.disabled = !scope || !role;
    taskDraft.hidden = !scope || (chatSheet.open && sheetView === taskPicker);
    taskDraft.firstElementChild.textContent = scope
      ? `窗口任务 · ${roleLabel} · ${scope === "screen" ? "查看窗口" : "操作窗口"}`
      : "";
    const name =
      room.roles.find(({ id }) => id === status?.agentId)?.name ?? "角色";
    const taskLabel = status?.scope === "native" ? "操作窗口" : "查看窗口";
    const reason = bodyReasonLabels[status?.reason] ?? "可在重新授权后再试。";
    const feedback =
      {
        approaching: `${name}正在靠近目标窗口…`,
        ready: `${name}已到位 · ${taskLabel}`,
        completed: `${name}已完成窗口任务`,
        failed: `窗口任务已停止 · ${reason}`,
      }[status?.stage] ??
      (scope && !role
        ? "窗口授权已变化。请切换发送方式后重新选择窗口任务。"
        : "");
    taskFeedback.hidden = !feedback;
    if (taskStatus.textContent !== feedback) taskStatus.textContent = feedback;
    taskStop.hidden = !active;
    taskStop.disabled = Boolean(room.connectionLost);
    send.disabled = message.disabled || Boolean(scope && (!role || active));
    attach.hidden = Boolean(scope) || !room.framework || !window.nest.attach;
  }

  taskRole.addEventListener("change", () => {
    selectedWindowGrant = windowTaskGrants(taskScope.value).find(
      ({ role }) => role.id === taskRole.value,
    )?.grantId;
    refreshWindowTask();
  });
  taskScope.addEventListener("change", () => {
    selectedWindowGrant = windowTaskGrants(taskScope.value)[0]?.grantId;
    refreshWindowTask();
  });
  taskStop.addEventListener("click", () =>
    window.nest.act("window-task-stop", room.windowTaskStatus.id),
  );

  function update(next) {
    updatePersonal(next);
    if (
      statusTarget &&
      (!next.connected ||
        next.connectionLost ||
        next.roomEpoch !== statusTarget.roomEpoch ||
        !next.roles.some(
          (role) =>
            role.id === statusTarget.agentId &&
            role.state === "here" &&
            role.bodyVisitId === statusTarget.visitId &&
            role.statusCard?.ref === statusTarget.ref,
        ))
    ) {
      statusTarget = undefined;
      statusTitle.textContent = "";
      statusText.textContent = "";
      if (statusDialog.open) statusDialog.close();
    }
    if (room && next.roomEpoch !== room.roomEpoch && taskScope.value) {
      taskScope.value = "";
      message.value = "";
      selectedWindowGrant = undefined;
    }
    room = next;
    updateRecentBubbles(room);
    select(".sample-settings").hidden = Boolean(room.framework);
    const edition = select(".edition");
    edition.hidden = Boolean(room.framework);
    edition.textContent = room.live ? "隔离试聊" : "模拟样机";
    if (room.live) {
      select(".door-settings").hidden = false;
      select("#door-mode").value = room.doorMode ?? "off";
      select("#door-mode").disabled = room.framework && !room.connected;
      const trial = select(".knock-trial");
      trial.hidden = room.subjectKnocks;
      trial.disabled =
        !["welcome", "always"].includes(room.doorMode) ||
        room.opportunity ||
        Boolean(room.knock) ||
        Boolean(room.thinking) ||
        (room.opportunityAt !== undefined &&
          Date.now() - room.opportunityAt < 30 * 60_000);
      trial.textContent = room.opportunity
        ? "等角色决定…"
        : room.doorMode === "always"
          ? "试一次来访"
          : "试一次敲门";
      select(".knock-card").hidden = !room.knock || room.connectionLost;
      if (room.knock && !room.connectionLost) {
        const role = room.roles.find(({ id }) => id === room.knock.actor);
        select(".knock-label").textContent =
          `${role.name}敲门了。${room.knock.text}`;
      }
    }
    for (const [id, { node, activityCard }] of guests) {
      if (!room.roles.some((role) => role.id === id)) {
        node.remove();
        activityCard.remove();
        guests.delete(id);
      }
    }
    const feedback = [];
    for (const role of room.roles) {
      guest(role);
      const body = role.bodyStatus;
      if (
        ["manual-control", "target-unreachable"].includes(body?.reason) &&
        Number.isFinite(body.at) &&
        body.at > (announcedBodyFeedback.get(role.id) ?? -Infinity)
      ) {
        announcedBodyFeedback.set(role.id, body.at);
        feedback.push(
          body.reason === "manual-control"
            ? `已停止${role.name}的移动`
            : `${role.name}无法到达。${bodyReasonLabels[body.reason]}`,
        );
      }
    }
    guestActivities.hidden = !guestActivityList.querySelector(
      ":scope > :not([hidden])",
    );
    if (feedback.length) bodyAnnouncement.textContent = feedback.join("。");
    const notice = select(".room-notice");
    if (notice.textContent !== room.notice) notice.textContent = room.notice;
    const observation = room.observation;
    const ended =
      !(
        room.observationEnded === "unsupported" &&
        observation?.ineligible?.some(({ reason }) => reason === "image")
      ) && Object.hasOwn(observationEndLabels, room.observationEnded)
        ? observationEndLabels[room.observationEnded]
        : "";
    for (const notice of observationEnded) {
      notice.hidden = !ended;
      if (notice.textContent !== ended) notice.textContent = ended;
    }
    observationTab.hidden =
      !room.observationReviewAvailable ||
      !room.connected ||
      !window.nest.observationReview;
    if (observationTab.hidden && !observationResults.hidden)
      switchSection("chat", true);
    updateObservationResults(room);
    bodyZones.hidden = room.bodyZones !== true;
    const here = room.roles.filter((role) => role.state === "here");
    const roster = JSON.stringify(
      here.map(({ id, name, color, art }) => [id, name, color, art]),
    );
    if (lastRoster !== roster) {
      audience.replaceChildren(
        document.createTextNode("在场"),
        element("span", null, "你"),
      );
      for (const role of here) {
        const chip = button(`audience-role ${role.color}`, "");
        chip.title = `点名${role.name}`;
        chip.append(avatar(role), document.createTextNode(role.name));
        chip.addEventListener("click", () => {
          if (message.disabled || taskScope.value) return;
          const mention = `@${role.name} `;
          const start = message.selectionStart ?? message.value.length;
          const end = message.selectionEnd ?? start;
          if (
            message.value.length - (end - start) + mention.length >
            message.maxLength
          )
            return;
          message.setRangeText(mention, start, end, "end");
          message.focus();
        });
        audience.append(chip);
      }
      lastRoster = roster;
    }
    message.disabled = !here.length || Boolean(room.connectionLost);
    message.placeholder = here.length
      ? "说点什么…（可用 @ 名字）"
      : "邀请一位角色开始聊天";
    refreshWindowTask();
    attach.disabled =
      attaching ||
      (!room.attachmentInput?.text &&
        !room.attachmentInput?.image &&
        !room.attachmentInput?.video);
    updateCompanion();
    updateScreenView();
    updateObservation();
    const windowGrants = windowObservationGrants(observation);
    observationRetention.hidden =
      Boolean(windowGrants.length) || !observation?.eligible.length;
    const unavailable = (observation?.ineligible ?? []).flatMap(
      ({ id, reason }) =>
        Object.hasOwn(observationEligibilityLabels, reason)
          ? [
              `${room.roles.find((role) => role.id === id)?.name ?? id} · ${observationEligibilityLabels[reason]}`,
            ]
          : [],
    );
    const ineligible = JSON.stringify(unavailable);
    if (lastObservationIneligible !== ineligible) {
      lastObservationIneligible = ineligible;
      observationIneligible.hidden = !unavailable.length;
      observationIneligible.replaceChildren(
        ...unavailable.map((text) => element("li", null, text)),
      );
    }
    observationTarget.hidden = !windowGrants.length;
    const observationStatus = windowGrants.length
      ? `${observation.target ?? "授权窗口"} · ${windowGrants.length} 位角色已授权`
      : "";
    if (observationTarget.textContent !== observationStatus)
      observationTarget.textContent = observationStatus;
    updateNativeControl();
    updateBrowserControl();
    refreshDisplayGrants();
    toolsLauncher.hidden = !room.framework || !room.connected;
    const hasGrant =
      [
        room.screenView,
        room.observation,
        room.nativeControl,
        room.browserControl,
      ].some((policy) => policy?.grantedAgentId) ||
      Boolean(windowGrants.length || room.observation?.displays?.length);
    select(".grant-indicator").hidden = !hasGrant;
    toolsLauncher.setAttribute(
      "aria-label",
      hasGrant ? "小窝工具，当前有授权" : "小窝工具",
    );
    if (!room.connected && chatSheet.open) closeChatSheet();
    updateThread();
    const thinking = here.find(({ id }) => id === room.thinking);
    const active = here.filter(({ id }) =>
      (room.activityActors ?? [room.activityActor]).includes(id),
    );
    const status = room.connectionLost
      ? room.notice
      : thinking
        ? `${thinking.name}正在想…`
        : active.length
          ? `${active.map(({ name }) => name).join("、")}正在自主活动…`
          : "";
    activityControl.hidden = !room.activityEnabled;
    activityControl.disabled = Boolean(room.connectionLost);
    const activityLabel = room.activityPaused ? "继续自主活动" : "暂停自主活动";
    if (activityControl.textContent !== activityLabel)
      activityControl.textContent = activityLabel;
    turnStatus.hidden = !status;
    if (turnStatus.textContent !== status) turnStatus.textContent = status;
  }

  function closeSettings() {
    settingsForm.hidden = true;
    settings.setAttribute("aria-expanded", "false");
  }

  for (const tab of root.querySelectorAll("[data-tab]"))
    tab.addEventListener("click", () => switchSection(tab.dataset.tab, true));
  select(".close").addEventListener("click", () => window.nest.act("close"));
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (browserDialog.open) return;
    if (chatSheet.open) {
      event.preventDefault();
      closeChatSheet();
      refreshWindowTask();
      return;
    }
    if (!composerMenu.hidden) {
      toggleComposerMenu(false, true);
      return;
    }
    if (!settingsForm.hidden) {
      closeSettings();
      settings.focus();
    } else window.nest.act("close");
  });
  attach.addEventListener("click", async () => {
    if (attach.disabled || attaching) return;
    attaching = true;
    toggleComposerMenu(false);
    attach.disabled = true;
    attachmentStatus.hidden = false;
    attachmentStatus.textContent = "等待选择附件…";
    let status;
    try {
      status = await window.nest.attach();
    } catch {
      status = "failed";
    } finally {
      attaching = false;
      attach.disabled =
        !room.attachmentInput?.text &&
        !room.attachmentInput?.image &&
        !room.attachmentInput?.video;
      attachmentStatus.hidden = status === "cancelled" || status === "sent";
      attachmentStatus.textContent =
        status === "invalid"
          ? "文件类型不受支持或超过大小限制。"
          : "附件未能发送。";
    }
  });
  select(".composer").addEventListener("submit", (event) => {
    event.preventDefault();
    const text = message.value.trim();
    if (!text || send.disabled) return;
    const scope = taskScope.value;
    if (scope) {
      const selection = selectedTask();
      if (!selection) return;
      window.nest.act("window-task", {
        agentId: selection.role.id,
        scope,
        grantId: selection.grantId,
        text,
      });
      taskScope.value = "";
      selectedWindowGrant = undefined;
      refreshWindowTask();
    } else window.nest.act("send", text);
    message.value = "";
    message.focus();
  });
  settings.addEventListener("click", () => {
    if (!settingsForm.hidden) return closeSettings();
    timerOn.checked = Boolean(room.minutes);
    minutes.value = room.minutes || 60;
    minutes.disabled = !timerOn.checked;
    settingsForm.hidden = false;
    settings.setAttribute("aria-expanded", "true");
    if (minutes.disabled) timerOn.focus();
    else minutes.focus();
  });
  timerOn.addEventListener("change", () => {
    minutes.disabled = !timerOn.checked;
  });
  settingsForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = timerOn.checked ? minutes.valueAsNumber : 0;
    if (Number.isInteger(value)) window.nest.act("interval", value);
    closeSettings();
    settings.focus();
  });

  select("#door-mode").addEventListener("change", (event) =>
    window.nest.act("door-mode", event.target.value),
  );
  select(".knock-trial").addEventListener("click", () =>
    window.nest.act("knock-trial"),
  );
  select(".knock-accept").addEventListener("click", () =>
    window.nest.act("knock-answer", true),
  );
  select(".knock-dismiss").addEventListener("click", () =>
    window.nest.act("knock-answer", false),
  );

  window.nest.onRoom(update);
  window.nest.onSection(switchSection);
  window.nest.get().then((value) => {
    if (!value) return;
    update(value.data);
    switchSection(value.section);
  });
}
