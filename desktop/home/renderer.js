const query = new URLSearchParams(location.search);
const type = query.get("type");
const id = query.get("id");
const root = document.getElementById("root");

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function assetPath(asset) {
  return asset === "door"
    ? "../../public/home-preview/assets/door.webp"
    : `art/${asset}-paper.webp`;
}

function image(asset) {
  const img = element("img");
  if (asset) img.src = assetPath(asset);
  img.alt = "";
  img.draggable = false;
  return img;
}

function avatar(role) {
  const node = element("span", `portrait ${role.color}`);
  node.append(image(role.art ?? role.id));
  return node;
}

function button(className, text, label = text) {
  const node = element("button", className, text);
  node.type = "button";
  if (label) node.setAttribute("aria-label", label);
  return node;
}

const activityLabels = {
  move: "正在移动",
  qq: "回复 QQ",
  chat: "桌边聊天",
  observe: "观察桌面",
  control: "操控桌面",
  idle: "待机",
  sleep: "睡觉",
};

const bodyActivities = { moving: "move", observing: "observe", qq: "qq" };
const bodyStateLabels = {
  moving: "正在移动",
  waiting: "等待自主活动",
  observing: "正在观察桌面",
  qq: "QQ 优先处理",
  paused: "已暂停",
};
const bodyPoseLabels = { stand: "站立", sit: "坐下", look: "张望" };
const bodyFacingLabels = { left: "面向左侧", right: "面向右侧" };
const bodyGestureLabels = {
  jump: "跳跃",
  climb: "攀爬",
  land: "落地",
  wave: "挥手",
};
const followModeLabels = { pointer: "跟随鼠标", window: "跟随窗口" };
const followResultLabels = {
  busy: "请先完成当前窗口选择。",
  "no-sources": "没有可跟随的窗口。",
  permission: "请在系统设置中允许访问窗口。",
  "target-unavailable": "窗口已失效。",
  "target-unreachable": "无法到达窗口附近。",
  "target-blocked": "窗口附近没有可用落点。",
  "follow-target-minimized": "窗口已最小化。",
};
const observationPermissionHelp =
  "请在系统设置中恢复权限。macOS 需按系统提示允许桌面小窝录制屏幕，并允许 agent-desktop 使用辅助功能。";
const observationEndLabels = {
  "target-unavailable": "观察窗口已失效。请在聊天页选择其他窗口并重新授权。",
  "target-minimized": "观察窗口已最小化。恢复窗口后可继续观察。",
  permission: `观察权限已失效。${observationPermissionHelp}然后重新授权观察。`,
  unsupported: "当前后端不支持观察所需的图片输入。请在管理台检查角色的后端。",
};
const observationEligibilityLabels = {
  activity: "未开启自主活动",
  screen: "未获准查看屏幕",
  image: "未启用图片输入或后端不支持图片输入",
  blocked: "角色当前无法参与观察",
};
const bodyReasonLabels = {
  "manual-control": "拖动已打断移动",
  stopped: "动作已停止",
  "display-changed": "显示器布局已变化，请重新选择落点。",
  "target-unavailable": "移动目标已失效，请重新选择落点。",
  "target-unreachable": "没有可通行的路线，请重新选择落点。",
  "target-blocked": "落点被占用或位于禁停区，请重新选择。",
  "stale-layout": "桌面布局已变化，请重新选择落点。",
  "position-unconfirmed": "位置未确认，请检查桌宠当前所在位置。",
  disconnect: "连接中断。若持续断开，请确认管理台正在运行。",
  permission: "桌宠权限已失效，请在管理台检查该角色的桌宠控制权限。",
  qq: "已让位给 QQ",
  pause: "自主活动已暂停",
  rest: "已进入休息时段",
  hidden: "浮窗已隐藏",
  "action-unconfirmed": "窗口任务结果未确认，请先核对目标窗口。",
  "follow-expired": "临时跟随已到期",
  "follow-permission": "跟随权限已失效",
  "follow-target-minimized": "跟随窗口已最小化",
  "follow-qq": "已停止跟随，让位给 QQ",
  arrival: "已来到桌边",
  "wait-ended": "等待已结束",
  completed: "动作已完成",
  inactive: "到访已结束",
};

function activityFor(role, room) {
  if (role.bodyStatus) {
    const activity = bodyActivities[role.bodyStatus.state];
    if (Object.hasOwn(bodyActivities, role.bodyStatus.state)) return activity;
    if (role.bodyStatus.state === "paused" && role.activity !== "sleep")
      return "idle";
    if (["chat", "control", "sleep"].includes(role.activity))
      return role.activity;
  } else if (Object.hasOwn(activityLabels, role.activity)) return role.activity;
  return room.thinking === role.id || room.bubbles?.[role.id] ? "chat" : "idle";
}

function bindFloatingDrag(handle) {
  let pointer;
  let moved = false;
  const point = (event) => ({ x: event.screenX, y: event.screenY });
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || pointer) return;
    const origin = point(event);
    pointer = { id: event.pointerId, origin, last: origin };
    moved = false;
    handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener("pointermove", (event) => {
    if (pointer?.id !== event.pointerId) return;
    const last = (pointer.last = point(event));
    if (
      !moved &&
      Math.hypot(last.x - pointer.origin.x, last.y - pointer.origin.y) >= 5
    ) {
      moved = true;
      handle.dataset.dragging = "true";
      delete handle.dataset.motionTransition;
      delete handle.dataset.gesture;
      window.nest.act("drag-start", pointer.origin);
    }
    if (moved) window.nest.act("drag-move", last);
  });
  function endDrag(event) {
    if (pointer?.id !== event.pointerId) return;
    if (moved)
      window.nest.act(
        "drag-end",
        event.type === "pointerup" ? point(event) : pointer.last,
      );
    pointer = undefined;
    delete handle.dataset.dragging;
  }
  for (const event of ["pointerup", "pointercancel", "lostpointercapture"])
    handle.addEventListener(event, endDrag);
  handle.addEventListener("click", (event) => {
    if (!moved || event.detail === 0) window.nest.act("open");
    moved = false;
  });
}

function floating() {
  const space = element("main", "floating");
  const door = type === "door";
  const art = button(
    door ? "door-button" : "sprite-button",
    "",
    door ? "打开小窝的门" : "打开小窝聊天",
  );
  let pageVisible;
  function syncVisibility() {
    const visible = !document.hidden;
    if (pageVisible === visible) return;
    pageVisible = visible;
    art.toggleAttribute("data-page-hidden", !visible);
    if (!visible) {
      delete art.dataset.motionTransition;
      delete art.dataset.gesture;
    }
    window.nest.act("page-visible", visible);
  }
  window.addEventListener("load", syncVisibility, { once: true });
  document.addEventListener("visibilitychange", syncVisibility);
  art.title = door
    ? "点击打开小窝 · 拖动换位置"
    : "点击聊天 · 拖动换座位 · 右键菜单";
  const sprite = image(door ? "door" : undefined);
  const walkFrames = [];
  let gestureLayer;
  if (door) art.append(sprite);
  else {
    const body = element("span", "sprite-body");
    gestureLayer = element("span", "sprite-gesture");
    const pose = element("span", "sprite-pose");
    const cue = element("span", "sprite-cue");
    const walk = element("span", "sprite-walk");
    walkFrames.push(image(), image());
    cue.setAttribute("aria-hidden", "true");
    walk.setAttribute("aria-hidden", "true");
    walk.append(...walkFrames);
    sprite.className = "sprite-rest";
    body.addEventListener("animationend", (event) => {
      if (event.target === body) delete art.dataset.motionTransition;
    });
    gestureLayer.addEventListener("animationend", (event) => {
      if (event.target === gestureLayer) delete art.dataset.gesture;
    });
    pose.append(sprite, walk, cue);
    gestureLayer.append(pose);
    body.append(gestureLayer);
    art.append(body);
  }
  space.append(art);
  root.append(space);
  bindFloatingDrag(art);

  function subscribe(update) {
    window.nest.onRoom(update);
    window.nest.get().then((value) => {
      if (value) update(value.data);
    });
  }

  if (door) {
    const indicator = element("span", "door-knock", "有人敲门");
    indicator.hidden = true;
    art.append(indicator);
    subscribe((data) => {
      const visitor = data.roles.find(({ id }) => id === data.knock?.actor);
      indicator.hidden = !visitor;
      art.setAttribute(
        "aria-label",
        visitor ? `${visitor.name}敲门，打开小窝的门` : "打开小窝的门",
      );
    });
    return;
  }

  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const syncMotion = () => {
    if (motion.matches) delete art.dataset.motionTransition;
    delete art.dataset.gesture;
    window.nest.act("motion-preference", motion.matches);
  };
  syncMotion();
  motion.addEventListener("change", syncMotion);
  let role;
  let room;
  let lastGestureId;
  window.nest.onMotion?.((state) => {
    const previous = art.dataset.motion;
    if (previous === state) return;
    art.dataset.motion = state;
    if (state !== "moving") art.style.removeProperty("--travel-rate");
    if (state === "suspended") delete art.dataset.gesture;
    delete art.dataset.motionTransition;
    if (!motion.matches && pageVisible && !art.dataset.dragging) {
      if (state === "moving") art.dataset.motionTransition = "start";
      if (previous === "moving" && state === "still")
        art.dataset.motionTransition = "stop";
    }
    if (role) renderSprite();
  });
  window.nest.onMotionSpeed?.((speed) => {
    if (art.dataset.motion !== "moving" || speed <= 0) return;
    // Keep slow steps legible and cap the cadence of very short, fast moves.
    const rate =
      speed < 300
        ? 1 + 0.4 * (1 - Math.max(speed, 80) / 300)
        : 1 - 0.32 * Math.min(1, (speed - 300) / 450);
    art.style.setProperty("--travel-rate", rate);
  });
  function face(facing) {
    if (art.dataset.facing !== facing) art.dataset.facing = facing;
  }
  window.nest.onFacing?.(face);
  const speech = button("speech", "", "打开小窝聊天");
  const words = element("span");
  speech.append(words);
  speech.hidden = true;
  speech.addEventListener("click", () => window.nest.act("open"));
  space.prepend(speech);
  art.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    window.nest.act("menu");
  });

  function renderSprite() {
    const moving = art.dataset.motion === "moving";
    const roomActivity = activityFor(role, room);
    const activity = moving
      ? "move"
      : roomActivity === "move"
        ? "idle"
        : roomActivity;
    const pose = role.bodyStatus?.pose ?? art.dataset.pose ?? "sit";
    const roleArt = role.art ?? role.id;
    if (art.dataset.pose !== pose) art.dataset.pose = pose;
    if (art.dataset.appearance !== roleArt) {
      art.dataset.appearance = roleArt;
      walkFrames[0].src = `art/actions/${roleArt}-stride.webp`;
      walkFrames[1].src = `art/actions/${roleArt}-step.webp`;
    }
    if (art.dataset.activity !== activity) art.dataset.activity = activity;
    const gesture = role.bodyStatus?.gesture;
    const gestureLabel = bodyGestureLabels[gesture?.kind] ?? "";
    if (art.dataset.gestureLabel !== gestureLabel)
      art.dataset.gestureLabel = gestureLabel;
    const label = [
      role.name,
      activityLabels[activity],
      bodyPoseLabels[moving ? "stand" : pose],
      gestureLabel,
      "打开聊天",
    ]
      .filter(Boolean)
      .join(" · ");
    if (art.getAttribute("aria-label") !== label)
      art.setAttribute("aria-label", label);
    const stance =
      moving || (activity === "idle" && pose !== "sit") ? "stand" : activity;
    const asset = `art/actions/${roleArt}-${stance}.webp`;
    if (sprite.getAttribute("src") !== asset) sprite.src = asset;
  }

  function renderGesture(gesture) {
    if (
      gesture?.id === undefined ||
      !Object.hasOwn(bodyGestureLabels, gesture.kind) ||
      room.connectionLost
    ) {
      delete art.dataset.gesture;
      return;
    }
    if (gesture.id === lastGestureId) return;
    lastGestureId = gesture.id;
    if (
      !pageVisible ||
      art.dataset.dragging ||
      art.dataset.motion === "suspended"
    )
      return;
    if (art.dataset.gesture === gesture.kind) {
      // Flush the previous one-shot animation before replaying the same kind.
      delete art.dataset.gesture;
      gestureLayer.getBoundingClientRect();
    }
    art.dataset.gesture = gesture.kind;
  }

  subscribe((data) => {
    room = data;
    role = data.roles.find((item) => item.id === id);
    if (!role) {
      delete art.dataset.gesture;
      return;
    }
    const facing = role.bodyStatus?.facing;
    if (facing) face(facing);
    renderSprite();
    renderGesture(role.bodyStatus?.gesture);
    const message =
      data.bubbles?.[id]?.text ?? (data.thinking === id ? "正在想…" : "");
    words.textContent = message;
    speech.hidden = !message;
  });
}

function bindObservationReview(section, clock) {
  const scope = section.querySelector(".review-scope");
  const status = section.querySelector(".review-status");
  const candidate = section.querySelector(".review-candidate");
  const candidateMeta = candidate.querySelector(".review-candidate-meta");
  const response = candidate.querySelector(".review-response");
  const summary = candidate.querySelector(".review-summary");
  const published = section.querySelector(".review-published");
  const publishedMeta = published.querySelector(".review-published-meta");
  const records = section.querySelector(".review-records");
  const recordsStatus = records.querySelector(".review-records-status");
  const list = records.querySelector("ul");
  const dateTime = new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "short",
    timeStyle: "short",
  });
  const invoke = (action, data) => window.nest.observationReview(action, data);
  const roleName = (agentId) =>
    room?.roles.find(({ id }) => id === agentId)?.name ?? agentId;
  const setStatus = (text) => {
    if (status.textContent !== text) status.textContent = text;
    status.hidden = !text;
  };
  function setText(container, text = "") {
    const words = container.querySelector(".review-text");
    if (words.textContent !== text) words.textContent = text;
    container.hidden = !text;
  }
  let room;
  let session;
  let timer;

  function renderReview(review) {
    const pending = review?.candidate;
    const posted = review?.published;
    candidate.hidden = !pending;
    const candidateDescription = pending
      ? `${roleName(pending.agentId)} · 候选保留至 ${clock.format(pending.expiresAt)}`
      : "";
    if (candidateMeta.textContent !== candidateDescription)
      candidateMeta.textContent = candidateDescription;
    setText(response, pending?.response);
    setText(summary, pending?.summary);
    const author = posted ? roleName(posted.agentId) : "";
    if (publishedMeta.textContent !== author)
      publishedMeta.textContent = author;
    setText(published, posted?.text);
  }

  async function refreshReview(current) {
    if (current.busy || current.reading) return;
    current.reading = true;
    const revision = current.revision;
    try {
      const review = await invoke("status");
      if (session !== current || current.revision !== revision) return;
      current.candidate = review?.candidate;
      renderReview(review);
      setStatus(
        review
          ? current.notice || (review.candidate ? "" : "暂无待审核内容。")
          : "当前无法读取观察审核。",
      );
    } catch {
      if (session !== current || current.revision !== revision) return;
      current.candidate = undefined;
      renderReview();
      setStatus("当前无法读取观察审核。");
    } finally {
      current.reading = false;
    }
  }

  async function refreshRecords(current) {
    if (!records.open) return;
    const request = (current.recordRequest = Symbol());
    const currentRequest = () =>
      session === current && records.open && current.recordRequest === request;
    list.replaceChildren();
    recordsStatus.textContent = "正在读取观察摘要…";
    try {
      const result = await invoke("list");
      if (!currentRequest()) return;
      recordsStatus.textContent = result?.records.length
        ? ""
        : result
          ? "暂无已保存的摘要。"
          : "当前无法读取已保存的摘要。";
      for (const {
        id,
        agentId,
        summary,
        createdAt,
        expiresAt,
      } of result?.records ?? []) {
        const row = element("li");
        const remove = button("secondary", "删除摘要");
        remove.addEventListener("click", async () => {
          if (session !== current || remove.disabled) return;
          remove.disabled = true;
          try {
            if (!(await invoke("delete", { id, agentId }))?.deleted)
              throw Error("DESKTOP_OBSERVATION_REVIEW_UNAVAILABLE");
            if (session === current) await refreshRecords(current);
          } catch {
            if (session === current)
              recordsStatus.textContent = "未能删除摘要。";
            remove.disabled = false;
          }
        });
        row.append(
          element(
            "p",
            null,
            `${roleName(agentId)} · ${dateTime.format(createdAt)} 保存 · ${dateTime.format(expiresAt)} 到期`,
          ),
          element("p", "review-text", summary),
          remove,
        );
        list.append(row);
      }
    } catch {
      if (currentRequest())
        recordsStatus.textContent = "当前无法读取已保存的摘要。";
    }
  }

  const actions = [...candidate.querySelectorAll("[data-review]")];
  for (const button of actions) {
    button.addEventListener("click", async () => {
      const current = session;
      if (!current?.candidate || current.busy || button.disabled) return;
      const { review: action } = button.dataset;
      current.busy = true;
      current.revision++;
      for (const button of actions) button.disabled = true;
      let result;
      try {
        result = await invoke(action, { id: current.candidate.id });
      } catch {
        result = undefined;
      } finally {
        current.busy = false;
      }
      if (session !== current) return;
      updateActions();
      current.notice = result
        ? {
            publish: "回复已发布。",
            save: "摘要已保存。",
            discard: "候选已丢弃。",
          }[action]
        : "操作未完成。候选可能已失效。";
      if (result) {
        current.candidate = result.candidate;
        renderReview(result);
      }
      setStatus(current.notice);
      void refreshReview(current);
      if (result && action === "save") void refreshRecords(current);
    });
  }

  function updateActions() {
    for (const button of actions)
      button.disabled =
        Boolean(session?.busy) || room?.observation?.targetState !== "ready";
  }

  function updateContext() {
    const active =
      !section.hidden &&
      room?.connected &&
      !document.hidden &&
      document.hasFocus();
    const grant = room?.observation;
    const context = [
      room?.roomEpoch,
      grant?.grantedAgentId,
      grant?.expiresAt,
      grant?.targetState,
    ].join("/");
    if (session && (!active || session.context !== context)) {
      clearInterval(timer);
      session = undefined;
      renderReview();
      list.replaceChildren();
      recordsStatus.textContent = "";
      setStatus("");
    }
    if (!active || session) return;
    session = { context, revision: 0 };
    const current = session;
    void refreshReview(current);
    void refreshRecords(current);
    timer = setInterval(() => void refreshReview(current), 2000);
  }

  records.addEventListener("toggle", () => {
    if (session && records.open) void refreshRecords(session);
    else list.replaceChildren();
  });
  window.addEventListener("focus", updateContext);
  window.addEventListener("blur", updateContext);
  document.addEventListener("visibilitychange", updateContext);
  return (next) => {
    room = next;
    const grant = room?.observation;
    const description = grant?.grantedAgentId
      ? `${roleName(grant.grantedAgentId)} · ${grant.target ?? "授权窗口"} · 许可至 ${clock.format(grant.expiresAt)} · 剩余 ${grant.remaining} 次`
      : "当前没有观察授权。可在聊天页为在场角色授权窗口。";
    if (scope.textContent !== description) scope.textContent = description;
    updateContext();
    updateActions();
  };
}

function panel() {
  root.append(
    document.getElementById("panel-template").content.cloneNode(true),
  );
  const select = (selector) => root.querySelector(selector);
  const guestList = select(".guest-list");
  const bodyAnnouncement = select(".body-announcement");
  const observationEnded = root.querySelectorAll(".observation-ended");
  const observationTab = select('[data-tab="observation"]');
  const observationReview = select("#observation-review");
  const bodyZones = select(".body-zones");
  bodyZones.addEventListener("click", () => window.nest.act("body-zones"));
  const audience = select(".audience");
  const thread = select(".thread");
  const message = select("#message");
  const send = select('.composer button[type="submit"]');
  const taskOptions = select(".window-task-options");
  const taskScope = select("#window-task-scope");
  const taskRole = select("#window-task-role");
  const taskFeedback = select(".window-task-feedback");
  const taskStatus = select(".window-task-status");
  const taskStop = select(".window-task-stop");
  const attach = select(".attach");
  const attachmentStatus = select(".attachment-status");
  let attaching = false;
  const settings = select(".settings");
  const turnStatus = select(".turn-status");
  const activityControl = button("quiet", "暂停自主活动");
  activityControl.hidden = true;
  activityControl.addEventListener("click", () => {
    if (room?.activityEnabled)
      window.nest.act("activity-pause", !room.activityPaused);
  });
  turnStatus.after(activityControl);
  const settingsForm = select(".timer-settings");
  const minutes = select("#minutes");
  const timerOn = select("#timer-on");
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
  let room;
  let lastId;
  let roomEpoch;
  let lastRoster;
  let selectedWindowGrant;
  const guests = new Map();
  const announcedBodyFeedback = new Map();
  const clock = new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
  const updateObservationReview = bindObservationReview(
    observationReview,
    clock,
  );

  function bindDesktopPermission(selector, key, labels, notices) {
    const section = select(selector);
    const button = section.querySelector("button");
    const notice = section.querySelector(".desktop-permission-status");
    let choosing = false;
    let lastAgent;
    function refresh() {
      const policy = room?.[key];
      const agent = room?.roles.find(({ id }) => id === policy?.grantedAgentId);
      const canAuthorize = Boolean(agent || policy?.eligible.length);
      if (lastAgent !== agent?.id) {
        lastAgent = agent?.id;
        notice.hidden = true;
      }
      section.hidden =
        !room?.connected ||
        !window.nest[key] ||
        (!canAuthorize && !policy?.ineligible?.length);
      button.hidden = !canAuthorize;
      button.disabled = choosing;
      button.textContent = agent ? labels.revoke : labels.grant;
      button.title = agent ? `当前授权给${agent.name}` : labels.help;
    }
    button.addEventListener("click", async () => {
      if (section.hidden || button.hidden || choosing) return;
      choosing = true;
      refresh();
      let status;
      try {
        status = await window.nest[key]();
      } catch {
        status = "failed";
      } finally {
        choosing = false;
        refresh();
      }
      notice.hidden = !notices[status];
      notice.textContent = notices[status] ?? "";
    });
    return refresh;
  }

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
    },
  );

  function updateBrowserControl() {
    const policy = room?.browserControl;
    const eligible = (room?.roles ?? []).filter(({ id }) =>
      policy?.eligible.includes(id),
    );
    const agent = room?.roles.find(({ id }) => id === policy?.grantedAgentId);
    const visible =
      room?.connected &&
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
      (!visible || agent || room.roomEpoch !== browserEpoch)
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
    if (room.browserControl.grantedAgentId) {
      browserRevokeError = (await changeBrowser()) !== "revoked";
      updateBrowserControl();
      return;
    }
    browserForm.reset();
    browserError.hidden = true;
    browserEpoch = room.roomEpoch;
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

  function switchSection(section) {
    if (section === "observation" && observationTab.hidden) return;
    if (!["chat", "visits", "observation"].includes(section)) return;
    select("#visits").hidden = section !== "visits";
    select("#chat").hidden = section !== "chat";
    observationReview.hidden = section !== "observation";
    for (const tab of root.querySelectorAll("[data-tab]"))
      tab.setAttribute("aria-pressed", String(tab.dataset.tab === section));
    if (section === "chat") {
      closeSettings();
      thread.scrollTop = thread.scrollHeight;
      if (!message.disabled) message.focus();
    }
    updateObservationReview(room);
  }

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
          const role = room.roles.find((role) => role.id === id);
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
        !room.interactionsAvailable ||
        room.connectionLost ||
        (!here && !role.place);
      mark.hidden = !here;
      mark.disabled = busy || state === "moving";
      go.hidden = !here || !role.place;
      go.disabled = busy || role.place !== "saved";
      clear.hidden = !role.place;
      pointer.hidden = !here || !window.nest.follow || Boolean(role.follow);
      windowFollow.hidden = pointer.hidden || !room.windowFollowAvailable;
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
      info.append(name, state, detail, recent);
      const action = button("secondary");
      action.addEventListener("click", () => {
        if (room.connectionLost) return;
        const current = room.roles.find(({ id }) => id === role.id);
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
      controls.append(decline, stop, seat, action);
      const interactions = bindResidentInteractions(role.id);
      const portrait = avatar(role);
      node.append(portrait, info, controls, interactions.menu);
      guestList.append(node);
      guests.set(role.id, {
        node,
        name,
        portrait,
        state,
        detail,
        recent,
        action,
        decline,
        stop,
        seat,
        interactions,
      });
    }
    const {
      node,
      name,
      portrait,
      state,
      detail,
      recent,
      action,
      decline,
      stop,
      seat,
      interactions,
    } = guests.get(role.id);
    node.dataset.state = role.available ? role.state : "unavailable";
    if (name.textContent !== role.name) name.textContent = role.name;
    portrait.className = `portrait ${role.color}`;
    const sprite = portrait.querySelector("img");
    const src = assetPath(role.art ?? role.id);
    if (sprite.getAttribute("src") !== src) sprite.src = src;
    decline.hidden = room.live || role.state !== "invited";
    stop.hidden = seat.hidden = role.state !== "here" || !role.available;
    interactions.update(role);
    const [label, text] = {
      home: ["在家", "邀请"],
      invited: ["已邀请 · 等待回应", "取消邀请"],
      here: ["在桌边", "请回家"],
    }[role.state];
    const activity = activityFor(role, room);
    const body = role.bodyStatus;
    const bodyState = body?.state;
    const paused = bodyState === "paused";
    const here = role.available && role.state === "here";
    let status = label;
    if (room.connectionLost) status = "连接中断";
    else if (paused)
      status =
        (body.stateReason ?? body.reason) === "rest"
          ? "休息时段 · 已暂停"
          : bodyStateLabels.paused;
    else if (!role.available) status = "本轮未接入";
    else if (here && bodyStateLabels[bodyState])
      status = bodyStateLabels[bodyState];
    else if ((here || activity === "sleep") && activity !== "idle")
      status = activityLabels[activity];
    if (state.textContent !== status) state.textContent = status;

    const details = [];
    if (here)
      details.push(bodyPoseLabels[body?.pose], bodyFacingLabels[body?.facing]);
    if (room.interactionsAvailable && role.place === "unavailable")
      details.push("常用停留点不可用，可重新标记");
    if (role.follow)
      details.push(
        followModeLabels[role.follow.mode],
        Number.isFinite(role.follow.until) &&
          `至 ${clock.format(role.follow.until)}`,
      );
    if (
      !room.connectionLost &&
      (paused || bodyState === "waiting") &&
      Number.isFinite(body.until)
    )
      details.push(`至 ${clock.format(body.until)}`);
    const observation = room.observation;
    if (
      !room.connectionLost &&
      here &&
      bodyState === "observing" &&
      observation?.grantedAgentId === role.id
    ) {
      details.push(observation.target ?? "授权窗口");
      if (Number.isFinite(observation.expiresAt))
        details.push(`许可至 ${clock.format(observation.expiresAt)}`);
      if (Number.isInteger(observation.remaining))
        details.push(`剩余 ${observation.remaining} 次`);
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
    action.hidden = !role.available || room.knock?.actor === role.id;
    action.setAttribute("aria-disabled", String(Boolean(room.connectionLost)));
    if (action.textContent !== text) action.textContent = text;
    action.setAttribute("aria-label", `${text} · ${role.name}`);
  }

  function line(entry) {
    const speakerType =
      entry.speakerType ??
      (entry.actor === "system"
        ? "system"
        : entry.actor === "admin"
          ? "administrator"
          : "agent");
    if (speakerType === "system")
      return element("p", "message system", entry.text);
    const role =
      speakerType === "agent" &&
      room.roles.find(({ id }) => id === entry.actor);
    const row = element(
      "div",
      speakerType === "administrator" ? "message mine" : "message",
    );
    row.dataset.actor = entry.actor;
    const words = element("div", "words");
    const author = element(
      "span",
      "author",
      speakerType === "administrator"
        ? "你"
        : (entry.speaker ?? role?.name ?? entry.actor),
    );
    author.title = clock.format(entry.now);
    words.append(author);
    if (entry.text) words.append(element("p", "content", entry.text));
    for (const { name } of entry.attachments || [])
      words.append(element("p", "content attachment", `附件 · ${name}`));
    if (role) row.append(avatar(role));
    row.append(words);
    return row;
  }

  function updateThread() {
    if (room.roomEpoch !== roomEpoch) {
      roomEpoch = room.roomEpoch;
      lastId = undefined;
    }
    const latest = room.messages.at(-1)?.id ?? 0;
    if (latest === lastId) return;
    const pinned =
      thread.scrollHeight - thread.scrollTop - thread.clientHeight < 65;
    if (latest < (lastId ?? 0)) lastId = undefined;
    if (!lastId) thread.replaceChildren();
    if (room.messages.length) {
      for (const entry of room.messages) {
        if (entry.id > (lastId ?? 0)) thread.append(line(entry));
      }
      while (thread.childElementCount > room.messages.length)
        thread.firstElementChild.remove();
    } else
      thread.append(
        element("p", "empty", "桌边还没有消息。邀请一位角色，就可以开聊。"),
      );
    lastId = latest;
    if (pinned || document.activeElement === message)
      thread.scrollTop = thread.scrollHeight;
  }

  function windowTaskGrant(scope) {
    if (!scope || !room?.interactionsAvailable || room.connectionLost) return;
    const [id, grantId] =
      scope === "screen"
        ? [room.windowTaskScreenAgentId, room.windowTaskScreenGrantId]
        : [room.windowTaskNativeAgentId, room.windowTaskNativeGrantId];
    const role = room.roles.find(
      (role) =>
        role.id === id &&
        role.state === "here" &&
        role.available &&
        role.bodyControlAvailable,
    );
    if (role && grantId) return { role, grantId };
  }

  function selectedTask() {
    const current = windowTaskGrant(taskScope.value);
    if (current?.grantId === selectedWindowGrant) return current;
  }

  function refreshWindowTask() {
    const scope = taskScope.value;
    const status = room.windowTaskStatus;
    const active = ["approaching", "ready"].includes(status?.stage);
    let hasTaskOption = false;
    for (const option of [...taskScope.options].slice(1)) {
      const available = !active && Boolean(windowTaskGrant(option.value));
      option.disabled = !available;
      option.hidden = !available && option.value !== scope;
      hasTaskOption ||= available;
    }
    taskOptions.hidden = !hasTaskOption && !scope;
    const role = selectedTask()?.role;
    const roleLabel = role?.name ?? "授权已失效";
    taskRole.hidden = !scope;
    if (
      taskRole.value !== (role?.id ?? "") ||
      taskRole.options[0]?.text !== roleLabel
    ) {
      const option = element("option", null, roleLabel);
      option.value = role?.id ?? "";
      taskRole.replaceChildren(option);
    }
    taskRole.disabled = !role;
    const name =
      room.roles.find(({ id }) => id === status?.agentId)?.name ?? "角色";
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
    taskStop.disabled = Boolean(room.connectionLost);
    send.disabled = message.disabled || Boolean(scope && (!role || active));
    attach.hidden = Boolean(scope) || !room.framework || !window.nest.attach;
  }

  taskScope.addEventListener("change", () => {
    selectedWindowGrant = windowTaskGrant(taskScope.value)?.grantId;
    refreshWindowTask();
  });
  taskStop.addEventListener("click", () =>
    window.nest.act("window-task-stop", room.windowTaskStatus.id),
  );

  function update(next) {
    if (room && next.roomEpoch !== room.roomEpoch && taskScope.value) {
      taskScope.value = "";
      message.value = "";
      selectedWindowGrant = undefined;
    }
    room = next;
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
        room.doorMode !== "welcome" ||
        room.opportunity ||
        Boolean(room.knock) ||
        Boolean(room.thinking) ||
        (room.opportunityAt !== undefined &&
          Date.now() - room.opportunityAt < 30 * 60_000);
      trial.textContent = room.opportunity ? "等角色决定…" : "试一次敲门";
      select(".knock-card").hidden = !room.knock || room.connectionLost;
      if (room.knock && !room.connectionLost) {
        const role = room.roles.find(({ id }) => id === room.knock.actor);
        select(".knock-label").textContent =
          `${role.name}敲门了。${room.knock.text}`;
      }
    }
    for (const [id, { node }] of guests) {
      if (!room.roles.some((role) => role.id === id)) {
        node.remove();
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
      !room.observationReviewAvailable ||
      !room.connected ||
      !window.nest.observationReview;
    if (observationTab.hidden && !observationReview.hidden)
      switchSection("chat");
    updateObservationReview(room);
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
        const chip = element("span", `audience-role ${role.color}`);
        chip.append(avatar(role), document.createTextNode(role.name));
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
      (!room.attachmentInput?.text && !room.attachmentInput?.image);
    updateScreenView();
    updateObservation();
    observationRetention.hidden =
      Boolean(observation?.grantedAgentId) || !observation?.eligible.length;
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
    observationTarget.hidden = !observation?.grantedAgentId;
    const observationStatus = observation?.grantedAgentId
      ? `${observation.target ?? "授权窗口"} · ${clock.format(observation.expiresAt)} 到期 · 剩余 ${observation.remaining} 次`
      : "";
    if (observationTarget.textContent !== observationStatus)
      observationTarget.textContent = observationStatus;
    updateNativeControl();
    updateBrowserControl();
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
    activityControl.hidden = !room.activityEnabled;
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
    tab.addEventListener("click", () => switchSection(tab.dataset.tab));
  select(".close").addEventListener("click", () => window.nest.act("close"));
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (browserDialog.open) return;
    if (!settingsForm.hidden) {
      closeSettings();
      settings.focus();
    } else window.nest.act("close");
  });
  attach.addEventListener("click", async () => {
    if (attach.disabled || attaching) return;
    attaching = true;
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
        !room.attachmentInput?.text && !room.attachmentInput?.image;
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
      selectedWindowGrant = undefined;
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

if (type === "panel") panel();
else floating();
