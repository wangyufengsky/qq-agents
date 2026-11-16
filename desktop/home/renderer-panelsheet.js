/* global document, window */
import {
  element,
  button,
  avatar,
  observationEligibilityLabels,
} from "./renderer-shared.js";

export function bindPanelSheet({
  root,
  select,
  toolsList,
  toolsLauncher,
  taskScope,
  message,
  clock,
  getRoom,
  windowObservationGrants,
  refreshWindowTask,
  clearWindowGrant,
}) {
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
    if (getRoom()) refreshWindowTask();
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
    const role = getRoom()?.roles.find(({ id }) => id === agentId);
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
    const observation = getRoom()?.observation;
    const screen = getRoom()?.screenView;
    const displays = observation?.displays;
    const showDisplays =
      getRoom()?.connected &&
      window.nest.displayObservation &&
      Array.isArray(displays);
    const showScreens =
      getRoom()?.connected &&
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
        getRoom().roomEpoch !== pickerEpoch ||
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
    const roles = getRoom().roles.filter(({ state }) => state === "here");
    const history = observe ? observation.displayHistory : undefined;
    const key = JSON.stringify([
      getRoom().roomEpoch,
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
    if (displayBusy || !getRoom()?.connected) return;
    const epoch = getRoom().roomEpoch;
    const scope = readScope;
    const observe = scope === "display";
    const policy = observe ? getRoom().observation : getRoom().screenView;
    const visitAtOpen = new Map(
      getRoom()
        .roles.filter(
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
      getRoom().roomEpoch !== epoch ||
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
    const limits = getRoom().observation?.displayLimits;
    pickerLimits = JSON.stringify(limits);
    readChoices.replaceChildren();
    readCommonTarget.replaceChildren(...targetOptions(result.displays));
    readRoster = getRoom()
      .roles.filter(
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
      (readScope === "display" ? getRoom().observation : getRoom().screenView)
        ?.eligible ?? [];
    const stale = [];
    const valid = readRoster.filter(({ role, check, target }) => {
      const available =
        eligible.includes(role.id) &&
        getRoom().roles.some(
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
    if (!Array.isArray(getRoom()?.screenView?.grants)) return;
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
    clearWindowGrant();
    refreshWindowTask();
    message.focus();
  });
  useTask.addEventListener("click", () => {
    closeChatSheet();
    refreshWindowTask();
    message.focus();
  });

  return {
    chatSheet,
    taskPicker,
    plus,
    composerMenu,
    openTask,
    taskDraft,
    useTask,
    toggleComposerMenu,
    closeChatSheet,
    refreshDisplayGrants,
    get sheetView() {
      return sheetView;
    },
  };
}
