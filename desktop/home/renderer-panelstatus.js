/* global document, window */
export function bindStatusCard(root) {
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
  return (next) => {
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
  };
}
