/* global window */
import { element, bodyReasonLabels } from "./renderer-shared.js";

export function bindWindowTask(
  select,
  message,
  send,
  attach,
  getRoom,
  getSheet,
) {
  const taskOptions = select(".window-task-options");
  const taskScope = select("#window-task-scope");
  const taskRole = select("#window-task-role");
  const taskFeedback = select(".window-task-feedback");
  const taskStatus = select(".window-task-status");
  const taskStop = select(".window-task-stop");
  let selectedWindowGrant;
  function windowTaskGrants(scope) {
    if (!scope || !getRoom()?.interactionsAvailable || getRoom().connectionLost)
      return [];
    const grants =
      scope === "screen"
        ? (getRoom().windowTaskScreenGrants ?? [
            {
              agentId: getRoom().windowTaskScreenAgentId,
              grantId: getRoom().windowTaskScreenGrantId,
            },
          ])
        : [
            {
              agentId: getRoom().windowTaskNativeAgentId,
              grantId: getRoom().windowTaskNativeGrantId,
            },
          ];
    return grants.flatMap(({ agentId, grantId }) => {
      const role = getRoom().roles.find(
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
    const {
      chatSheet,
      taskPicker,
      plus,
      openTask,
      taskDraft,
      useTask,
      toggleComposerMenu,
    } = getSheet();
    const scope = taskScope.value;
    const status = getRoom().windowTaskStatus;
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
      (Boolean(scope) || !getRoom().framework || !window.nest.attach);
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
    taskDraft.hidden =
      !scope || (chatSheet.open && getSheet().sheetView === taskPicker);
    taskDraft.firstElementChild.textContent = scope
      ? `窗口任务 · ${roleLabel} · ${scope === "screen" ? "查看窗口" : "操作窗口"}`
      : "";
    const name =
      getRoom().roles.find(({ id }) => id === status?.agentId)?.name ?? "角色";
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
    taskStop.disabled = Boolean(getRoom().connectionLost);
    send.disabled = message.disabled || Boolean(scope && (!role || active));
    attach.hidden =
      Boolean(scope) || !getRoom().framework || !window.nest.attach;
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
    window.nest.act("window-task-stop", getRoom().windowTaskStatus.id),
  );

  return {
    selectedTask,
    refreshWindowTask,
    clearWindowGrant() {
      selectedWindowGrant = undefined;
    },
  };
}
