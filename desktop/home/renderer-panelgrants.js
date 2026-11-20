/* global window */
import { element } from "./renderer-shared.js";

const browserStatuses = {
  "ready-to-open": "独立标签页 · 待打开",
  open: "独立标签页 · 已打开",
  unavailable: "独立标签页 · 已不可用",
};

const notices = {
  denied: "已拒绝请求。",
  timeout: "读取窗口超时，请确认目标应用可以响应后重试。",
  driver: "窗口驱动未就绪，请在管理台准备桌面组件后重新打开小窝。",
  granted: "已授权。",
  revoked: "已撤销授权。",
  permission: "请在系统设置中允许辅助功能访问后重试。",
  "no-sources": "当前没有可选窗口。",
  unavailable: "当前无法更改授权。",
  failed: "授权操作失败。",
};

export function bindUnifiedGrants(select, getRoom) {
  const section = select(".unified-desktop-grants");
  const observation = select(".unified-observation-state");
  const nativeList = select(".unified-native-list");
  const browserList = select(".unified-browser-list");
  const nativeAdd = select(".unified-native-add");
  const existingBrowser = select(".unified-existing-browser");
  const requestList = select(".unified-control-requests");
  const browserAdd = select(".unified-browser-add");
  const browserDialog = select(".unified-browser-dialog");
  const browserForm = browserDialog.querySelector("form");
  const browserRole = select("#unified-browser-role");
  const browserCancel = select(".unified-browser-cancel");
  const status = select(".unified-grant-status");
  let signature;
  let choosing = false;
  let dialogEpoch;

  function name(agentId) {
    return getRoom().roles.find(({ id }) => id === agentId)?.name ?? agentId;
  }

  async function change(kind, input) {
    if (choosing || !getRoom()?.connected || !getRoom()?.desktopUnified) return;
    choosing = true;
    status.textContent = "";
    update();
    try {
      const result = await window.nest[kind](input);
      status.textContent = notices[result] ?? "";
      if (result === "granted" && browserDialog.open) browserDialog.close();
    } catch {
      status.textContent = notices.failed;
    } finally {
      choosing = false;
      update();
    }
  }

  function renderGrants(list, grants, kind, targetLabel) {
    list.replaceChildren(
      ...grants.map((grant) => {
        const label = `${name(grant.agentId)} · ${targetLabel(grant)}`;
        const row = element("li", null, label);
        const revoke = element("button", "quiet", "撤销");
        revoke.type = "button";
        revoke.disabled = choosing;
        revoke.setAttribute("aria-label", `撤销 ${label} 的授权`);
        revoke.addEventListener(
          "click",
          () => void change(kind, { type: "revoke", grantId: grant.grantId }),
        );
        row.append(revoke);
        return row;
      }),
    );
  }

  function update() {
    const room = getRoom();
    if (
      browserDialog.open &&
      (!room?.desktopUnified ||
        !room.connected ||
        room.roomEpoch !== dialogEpoch)
    )
      browserDialog.close();
    select(".control-request-count").textContent =
      room?.connected &&
      room.desktopUnified &&
      room.nativeControl?.requests?.length
        ? " · 待授权 " + room.nativeControl.requests.length
        : "";
    section.hidden = !room?.desktopUnified || !room.connected;
    if (section.hidden) {
      signature = undefined;
      status.textContent = "";
      return;
    }
    observation.textContent = room.desktopObservationEnabled
      ? "已授权所有在场角色查看全部显示器。"
      : "全桌面观察已关闭，可在管理台的桌面设置开启。";
    const native = room.nativeControl;
    const browser = room.browserControl;
    const roster = room.roles.filter(({ id }) =>
      browser?.targetEligible?.includes(id),
    );
    const key = JSON.stringify([
      room.roomEpoch,
      room.roles.map(({ id, name }) => [id, name]),
      native?.requests,
      native?.grants,
      browser?.grants,
      native?.targetEligible,
      browser?.targetEligible,
      choosing,
    ]);
    if (key === signature) return;
    signature = key;
    nativeAdd.disabled =
      choosing || !native?.targetEligible?.length || !window.nest.nativeControl;
    existingBrowser.disabled = nativeAdd.disabled;
    requestList.replaceChildren(
      ...(native?.requests ?? []).map(({ requestId, agentId, target }) => {
        const row = element(
          "li",
          null,
          name(agentId) +
            (target === "browser"
              ? " 请求操作浏览器窗口"
              : " 请求操作本机窗口"),
        );
        for (const [type, label] of [
          ["grant", "选择目标并授权"],
          ["deny", "拒绝"],
        ]) {
          const control = element("button", "quiet", label);
          control.type = "button";
          control.disabled = choosing;
          control.addEventListener(
            "click",
            () =>
              void change("nativeControl", {
                type,
                agentId,
                target,
                requestId,
              }),
          );
          row.append(control);
        }
        return row;
      }),
    );
    browserAdd.disabled =
      choosing || !roster.length || !window.nest.browserControl;
    browserForm.querySelector('[type="submit"]').disabled = choosing;
    renderGrants(
      nativeList,
      native?.grants ?? [],
      "nativeControl",
      ({ title, targetId }) => title || `窗口 ${targetId.slice(0, 8)}`,
    );
    renderGrants(
      browserList,
      browser?.grants ?? [],
      "browserControl",
      ({ targetStatus, targetId }) =>
        `${browserStatuses[targetStatus] ?? "独立标签页"} · ${targetId.slice(0, 8)}`,
    );
    const selected = browserRole.value;
    const placeholder = element("option", null, "请选择角色");
    placeholder.value = "";
    browserRole.replaceChildren(
      placeholder,
      ...roster.map(({ id, name }) => {
        const option = element("option", null, name);
        option.value = id;
        return option;
      }),
    );
    if (roster.some(({ id }) => id === selected)) browserRole.value = selected;
  }

  existingBrowser.addEventListener(
    "click",
    () => void change("nativeControl", { type: "grant", target: "browser" }),
  );
  nativeAdd.addEventListener(
    "click",
    () => void change("nativeControl", { type: "grant" }),
  );
  browserAdd.addEventListener("click", () => {
    dialogEpoch = getRoom().roomEpoch;
    browserRole.value = "";
    status.textContent = "";
    browserDialog.showModal();
  });
  browserCancel.addEventListener("click", () => browserDialog.close());
  browserForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (browserRole.value)
      void change("browserControl", {
        type: "grant",
        agentId: browserRole.value,
      });
  });

  return update;
}
