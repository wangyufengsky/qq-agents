/* global window */
import { element } from "./renderer-shared.js";

export function bindBrowserControl(select, getRoom) {
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
  function updateBrowserControl() {
    const policy = getRoom()?.browserControl;
    const eligible = (getRoom()?.roles ?? []).filter(({ id }) =>
      policy?.eligible.includes(id),
    );
    const agent = getRoom()?.roles.find(
      ({ id }) => id === policy?.grantedAgentId,
    );
    const visible =
      getRoom()?.connected &&
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
      (!visible || agent || getRoom().roomEpoch !== browserEpoch)
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
    if (getRoom().browserControl.grantedAgentId) {
      browserRevokeError = (await changeBrowser()) !== "revoked";
      updateBrowserControl();
      return;
    }
    browserForm.reset();
    browserError.hidden = true;
    browserEpoch = getRoom().roomEpoch;
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

  return { browserDialog, updateBrowserControl };
}
