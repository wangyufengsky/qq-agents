/* global window */
export function desktopPermissionFactory(
  select,
  getRoom,
  windowObservationGrants,
) {
  return function bindDesktopPermission(selector, key, labels, notices) {
    const section = select(selector);
    const button = section.querySelector("button");
    const notice = section.querySelector(".desktop-permission-status");
    let choosing = false;
    let lastAgent;
    function refresh() {
      const policy = getRoom()?.[key];
      const selected =
        key === "observation" ? windowObservationGrants(policy) : [];
      const agentId = selected.length
        ? selected[0].agentId
        : policy?.grantedAgentId;
      const agent = getRoom()?.roles.find(({ id }) => id === agentId);
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
        !getRoom()?.connected ||
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
      if (key === "screenView" && Array.isArray(getRoom()?.screenView?.grants))
        return;
      void change();
    });
    section
      .querySelector(".native-switch")
      ?.addEventListener("click", () => void change("switch"));
    return refresh;
  };
}
