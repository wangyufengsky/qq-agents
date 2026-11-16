/* global window */
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
  bodyReasonLabels,
  activityFor,
} from "./renderer-shared.js";

const bodyIntentLabels = {
  "approach-window": "正在靠近关注窗口",
  "approach-peer": "正在靠近同伴",
  gather: "正在与同伴聚拢",
};

export function bindGuests(
  guestList,
  guestActivityList,
  clock,
  getRoom,
  windowObservationGrants,
) {
  const guests = new Map();
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
          const role = getRoom().roles.find((role) => role.id === id);
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
        !getRoom().interactionsAvailable ||
        getRoom().connectionLost ||
        (!here && !role.place);
      mark.hidden = !here;
      mark.disabled = busy || state === "moving";
      go.hidden = !here || !role.place;
      go.disabled = busy || role.place !== "saved";
      clear.hidden = !role.place;
      pointer.hidden = !here || !window.nest.follow || Boolean(role.follow);
      windowFollow.hidden = pointer.hidden || !getRoom().windowFollowAvailable;
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
        if (getRoom().connectionLost) return;
        const current = getRoom().roles.find(({ id }) => id === role.id);
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
        const target = getRoom()?.roles.find(({ id }) => id === role.id);
        if (target?.state === "here" && target.bodyVisitId)
          void window.nest.personal?.("open", {
            agentId: target.id,
            roomEpoch: getRoom().roomEpoch,
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
    decline.hidden = getRoom().live || role.state !== "invited";
    privateReply.hidden =
      !window.nest.personal ||
      !getRoom().connected ||
      role.state !== "here" ||
      !role.bodyVisitId;
    stop.hidden = seat.hidden = role.state !== "here" || !role.available;
    interactions.update(role);
    const [label, text] = {
      home: ["在家", "邀请"],
      invited: ["已邀请 · 等待回应", "取消邀请"],
      here: ["在桌边", "请回家"],
    }[role.state];
    const activity = activityFor(role, getRoom());
    const body = role.bodyStatus;
    const bodyState = body?.state;
    const paused = bodyState === "paused";
    const here = role.available && role.state === "here";
    let status = label;
    if (getRoom().connectionLost) status = "连接中断";
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
    if (getRoom().interactionsAvailable && role.place === "unavailable")
      details.push("常用停留点不可用，可重新标记");
    if (role.follow)
      details.push(
        followModeLabels[role.follow.mode],
        Number.isFinite(role.follow.until) &&
          `至 ${clock.format(role.follow.until)}`,
      );
    if (
      !getRoom().connectionLost &&
      (paused || bodyState === "waiting") &&
      Number.isFinite(body.until)
    )
      details.push(`至 ${clock.format(body.until)}`);
    const observation = getRoom().observation;
    const observationGrant = windowObservationGrants(observation).find(
      ({ agentId }) => agentId === role.id,
    );
    if (
      !getRoom().connectionLost &&
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
    action.hidden = !role.available || getRoom().knock?.actor === role.id;
    action.setAttribute(
      "aria-disabled",
      String(Boolean(getRoom().connectionLost)),
    );
    if (action.textContent !== text) action.textContent = text;
    action.setAttribute("aria-label", `${text} · ${role.name}`);
  }

  return { guests, guest };
}
