/* global window */
import {
  bindGardenWorkspace,
  gardenLabels,
  gardenEventOperation,
  gardenReceipt,
  gardenRecordsMarkup,
} from "../../public/garden-art/workspace.js";

export function bindGarden(panel, getRoom) {
  const content = panel.querySelector(".garden-content");
  const message = panel.querySelector(".garden-message");
  const refresh = panel.querySelector(".garden-refresh");
  const workspace = bindGardenWorkspace(content, {
    act: (action) => void request(action),
    onStatus: (text) => (message.textContent = text),
    compact: true,
    records: gardenRecordsMarkup,
  });
  let pending;
  let active;
  async function request(action) {
    if (active) return;
    const room = getRoom();
    if (!room?.connected || !room.roomEpoch) return;
    const key = action && JSON.stringify(action);
    if (key && pending?.key !== key)
      pending = { key, requestId: window.crypto.randomUUID() };
    const attempt = Symbol();
    active = attempt;
    content.setAttribute("aria-busy", "true");
    message.textContent = "正在读取花园…";
    try {
      const response = await window.nest.garden(
        room.roomEpoch,
        action ? { requestId: pending.requestId, action } : undefined,
      );
      if (
        active !== attempt ||
        panel.hidden ||
        getRoom()?.roomEpoch !== room.roomEpoch
      )
        return;
      if (!response?.garden) {
        if (response?.error) pending = undefined;
        message.textContent =
          gardenLabels[response?.error] || "花园操作暂不可用，请刷新后查看。";
        return;
      }
      if (action) pending = undefined;
      const { garden, receipt } = response;
      const status = action ? gardenReceipt(garden, action, receipt) : "";
      const eventReceipt = action && gardenEventOperation(action.kind);
      message.textContent = eventReceipt ? "" : status;
      if (garden.initialized)
        workspace.draw(garden, eventReceipt ? status : "");
      else content.textContent = "花园尚未开园，可在管理台创建。";
    } catch {
      if (active === attempt && getRoom()?.roomEpoch === room.roomEpoch)
        message.textContent = "暂时连不上花园，请刷新后查看。";
    } finally {
      if (active === attempt) {
        active = undefined;
        content.removeAttribute("aria-busy");
      }
    }
  }

  refresh.onclick = () => void request();
  return {
    refresh: () => void request(),
    clear: () => {
      pending = undefined;
      active = undefined;
      content.removeAttribute("aria-busy");
      workspace.clear();
    },
  };
}
