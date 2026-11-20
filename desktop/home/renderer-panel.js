/* global document, window */
import { bindRecentBubbles } from "./renderer-bubbles.js";
import {
  element,
  avatar,
  button,
  observationPermissionHelp,
  observationEndLabels,
  observationEligibilityLabels,
  bodyReasonLabels,
} from "./renderer-shared.js";
import { bindObservationResults } from "./renderer-observation.js";
import { bindStatusCard } from "./renderer-panelstatus.js";
import { bindCompanion } from "./renderer-panelcompanion.js";
import { bindThread } from "./renderer-panelchat.js";
import { bindGuests } from "./renderer-panelguests.js";
import { desktopPermissionFactory } from "./renderer-panelpermission.js";
import { bindUnifiedGrants } from "./renderer-panelgrants.js";
import { bindBrowserControl } from "./renderer-panelbrowser.js";
import { bindPanelSheet } from "./renderer-panelsheet.js";
import { bindWindowTask } from "./renderer-paneltask.js";
import { bindGarden } from "./renderer-garden.js";
import { bindPersonal } from "./renderer-personal.js";

export function panel(root) {
  root.append(
    document.getElementById("panel-template").content.cloneNode(true),
  );
  const updatePersonal = bindPersonal(root);
  const updateStatusCard = bindStatusCard(root);
  const select = (selector) => root.querySelector(selector);
  const size = select("#sprite-size");
  const percent = select('output[for="sprite-size"]');
  function showSize(value) {
    size.value = String(value);
    percent.value = size.value + "%";
    size.setAttribute("aria-valuetext", percent.value);
  }
  window.nest.getSpriteSize?.().then((value) => {
    showSize(value);
    size.disabled = false;
  });
  size.addEventListener("input", () => {
    showSize(size.valueAsNumber);
    window.nest.setSpriteSize(size.valueAsNumber);
  });
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
  const taskScope = select("#window-task-scope");
  const attach = select(".attach");
  const attachmentStatus = select(".attachment-status");
  let attaching = false;
  const settings = select(".settings");
  const turnStatus = select(".turn-status");
  const activityControl = button("quiet", "暂停自主活动");
  activityControl.hidden = true;
  activityControl.addEventListener("click", () => {
    if (room?.activityEnabled && !room.desktopUnified)
      window.nest.act("activity-pause", !room.activityPaused);
  });
  select(".desktop-permissions").prepend(activityControl);
  const settingsForm = select(".timer-settings");
  const minutes = select("#minutes");
  const timerOn = select("#timer-on");
  let room;
  const gardenPanel = select("#garden-panel"),
    gardenTab = select('[data-tab="garden"]');
  const garden = bindGarden(gardenPanel, () => room);
  let lastRoster;
  const announcedBodyFeedback = new Map();
  const clock = new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
  const toolsLauncher = select(".tools-launch");
  const toolsList = select(".desktop-permissions");
  function windowObservationGrants(policy) {
    if (policy?.windowGrants?.length) return policy.windowGrants;
    return policy?.grantedAgentId
      ? [{ ...policy, agentId: policy.grantedAgentId }]
      : [];
  }

  const updateCompanion = bindCompanion(
    select,
    () => room,
    clock,
    windowObservationGrants,
  );
  const task = bindWindowTask(
    select,
    message,
    send,
    attach,
    () => room,
    () => sheet,
  );
  const { selectedTask, refreshWindowTask, clearWindowGrant } = task;
  const sheet = bindPanelSheet({
    root,
    select,
    toolsList,
    toolsLauncher,
    taskScope,
    message,
    clock,
    getRoom: () => room,
    windowObservationGrants,
    refreshWindowTask: () => refreshWindowTask(),
    clearWindowGrant,
  });
  const {
    chatSheet,
    composerMenu,
    toggleComposerMenu,
    closeChatSheet,
    refreshDisplayGrants,
  } = sheet;

  const updateObservationResults = bindObservationResults(
    observationResults,
    clock,
  );

  const bindDesktopPermission = desktopPermissionFactory(
    select,
    () => room,
    windowObservationGrants,
  );

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

  const updateUnifiedGrants = bindUnifiedGrants(select, () => room);
  const { browserDialog, updateBrowserControl } = bindBrowserControl(
    select,
    () => room,
  );

  function switchSection(section, report = false) {
    if (section === "observation" && observationTab.hidden) return;
    if (section === "garden" && gardenTab.hidden) return;
    if (!["chat", "visits", "observation", "garden"].includes(section)) return;
    if (report) window.nest.setSection?.(section);
    select("#visits").hidden = section !== "visits";
    select("#chat").hidden = section !== "chat";
    observationResults.hidden = section !== "observation";
    gardenPanel.hidden = section !== "garden";
    if (section === "garden") {
      closeSettings();
      garden.refresh();
    }
    for (const tab of root.querySelectorAll("[data-tab]"))
      tab.setAttribute("aria-pressed", String(tab.dataset.tab === section));
    if (section === "chat") {
      closeSettings();
      thread.scrollTop = thread.scrollHeight;
      if (!message.disabled) message.focus();
    }
    updateObservationResults(room);
  }

  const { guests, guest } = bindGuests(
    guestList,
    guestActivityList,
    clock,
    () => room,
    windowObservationGrants,
  );

  const updateThread = bindThread(thread, message, clock, () => room);

  function update(next) {
    updatePersonal(next);
    updateStatusCard(next);
    if (room && next.roomEpoch !== room.roomEpoch && taskScope.value) {
      taskScope.value = "";
      message.value = "";
      clearWindowGrant();
    }
    if (room?.roomEpoch !== next.roomEpoch || !next.connected) garden.clear();
    room = next;
    gardenTab.hidden =
      !room.framework || !room.connected || !window.nest.garden;
    if (gardenTab.hidden && !gardenPanel.hidden) switchSection("visits", true);
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
      room.desktopUnified ||
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
    if (room.desktopUnified)
      for (const selector of [
        ".screen-view",
        ".observation",
        ".display-observation",
        ".native-control",
        ".browser-control",
      ])
        select(selector).hidden = true;
    updateUnifiedGrants();
    toolsLauncher.hidden = !room.framework || !room.connected;
    const hasGrant =
      [
        room.screenView,
        room.observation,
        room.nativeControl,
        room.browserControl,
      ].some((policy) => policy?.grantedAgentId || policy?.grants?.length) ||
      (room.desktopUnified && room.desktopObservationEnabled) ||
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
    activityControl.hidden = room.desktopUnified || !room.activityEnabled;
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
      clearWindowGrant();
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
