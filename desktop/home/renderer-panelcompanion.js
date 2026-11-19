/* global window */
import { element } from "./renderer-shared.js";

const frameLabels = {
  "framework-received": "框架已收到画面",
  "model-submitted": "画面已提交模型",
  "result-unconfirmed": "框架已收到画面，提交结果未确认",
};

export function bindCompanion(select, getRoom, clock, windowObservationGrants) {
  const companionOptions = select(".companion-options");
  const companionSelect = select(".companion-mode");
  const companionStatus = select(".companion-status");
  const applicationsOptions = select(".blocked-applications");
  const sensitiveInput = select(".sensitive-applications");
  const sensitiveSave = select(".sensitive-applications-save");
  const applicationsStatus = select(".blocked-applications-status");
  const frameReceiptSection = select(".frame-receipts");
  let displayedFrameReceipts;
  let displayedApplications;
  let changingCompanion = false;

  function updateFrameReceipts(room) {
    const visible = [];
    for (const receipt of room.frameReceipts ?? []) {
      const { agentId, at, requestId, roomEpoch, source, state, visitId } =
        receipt;
      const role = room.roles.find(({ id }) => id === agentId);
      if (
        role?.state !== "here" ||
        !Number.isFinite(at) ||
        !Object.hasOwn(frameLabels, state) ||
        (requestId && typeof requestId !== "string") ||
        ((requestId || roomEpoch || visitId) &&
          (!visitId ||
            visitId !== role.bodyVisitId ||
            roomEpoch !== room.roomEpoch))
      )
        continue;
      visible.push({ at, name: role.name, requestId, source, state });
    }
    const rendered = JSON.stringify(visible);
    frameReceiptSection.hidden = !visible.length;
    if (rendered === displayedFrameReceipts) return;
    displayedFrameReceipts = rendered;
    frameReceiptSection.querySelector("ul").replaceChildren(
      ...visible.map(({ at, name, requestId, source, state }) => {
        const request = requestId ? ` · 请求 ${requestId.slice(0, 8)}` : "";
        const label =
          source === "manual" && !requestId && state === "framework-received"
            ? "画面已提交给框架，模型接收未确认"
            : frameLabels[state];
        const row = element(
          "li",
          null,
          `${clock.format(at)} · ${name}${request} · ${label}`,
        );
        if (requestId) row.title = `请求 ${requestId}`;
        return row;
      }),
    );
  }

  function updateCompanion() {
    const room = getRoom();
    const preference = room?.companion;
    const connected = room?.connected;
    const canEdit = connected && window.nest.companionMode;
    companionOptions.hidden = !canEdit || room.desktopUnified || !preference;
    applicationsOptions.hidden =
      !canEdit || (room.desktopUnified ? !room.nativeControl : !preference);
    const applying = changingCompanion || !preference?.ready;
    sensitiveSave.disabled = room?.desktopUnified
      ? changingCompanion
      : applying;
    const applications = (
      room?.blockedApplications ??
      preference?.applications ??
      []
    ).join("\n");
    if (displayedApplications !== applications) {
      displayedApplications = applications;
      sensitiveInput.value = applications;
    }
    updateFrameReceipts(connected ? room : { roles: [] });
    if (companionOptions.hidden) return;
    companionSelect.value = preference.mode;
    companionSelect.disabled = changingCompanion;
    const controls =
      room.nativeControl?.grantedAgentId || room.browserControl?.grantedAgentId;
    const viewing =
      room.screenView?.grants?.length ||
      room.screenView?.grantedAgentId ||
      windowObservationGrants(room.observation).length ||
      room.observation?.displays?.length;
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
    if (action === "applications") applicationsStatus.hidden = true;
    updateCompanion();
    let applied;
    try {
      applied = await window.nest.companionMode({ action, value });
    } catch {
      applied = false;
    } finally {
      changingCompanion = false;
      updateCompanion();
      if (action === "applications") {
        applicationsStatus.hidden = false;
        applicationsStatus.textContent = applied
          ? "已保存。"
          : "暂无法保存，请重试。";
      } else if (!applied) companionStatus.textContent = "暂无法保存，请重试。";
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
  return updateCompanion;
}
