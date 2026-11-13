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
  "target-blocked": "落点被占用或位于禁停区，请重新选择。",
  "stale-layout": "桌面布局已变化，请重新选择落点。",
  "position-unconfirmed": "位置未确认，请检查桌宠当前所在位置。",
  disconnect: "连接中断。若持续断开，请确认管理台正在运行。",
  permission: "桌宠权限已失效，请在管理台检查该角色的桌宠控制权限。",
  qq: "已让位给 QQ",
  pause: "自主活动已暂停",
  rest: "已进入休息时段",
  hidden: "浮窗已隐藏",
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
  art.title = door
    ? "点击打开小窝 · 拖动换位置"
    : "点击聊天 · 拖动换座位 · 右键菜单";
  const sprite = image(door ? "door" : undefined);
  if (door) art.append(sprite);
  else {
    const pose = element("span", "sprite-pose");
    const cue = element("span", "sprite-cue");
    cue.setAttribute("aria-hidden", "true");
    pose.append(sprite, cue);
    art.append(pose);
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
  const syncMotion = () => window.nest.act("motion-preference", motion.matches);
  syncMotion();
  motion.addEventListener("change", syncMotion);
  window.nest.onMotion?.((state) => {
    art.dataset.motion = state;
  });
  window.nest.onFacing?.((facing) => {
    art.dataset.facing = facing === "left" ? "left" : "right";
  });
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

  subscribe((data) => {
    const role = data.roles.find((item) => item.id === id);
    if (!role) return;
    const activity = activityFor(role, data);
    const pose = role.bodyStatus?.pose;
    art.dataset.pose = pose ?? "stand";
    const roleArt = role.art ?? role.id;
    art.dataset.appearance = roleArt;
    if (art.dataset.activity !== activity) art.dataset.activity = activity;
    art.setAttribute(
      "aria-label",
      [role.name, activityLabels[activity], bodyPoseLabels[pose], "打开聊天"]
        .filter(Boolean)
        .join(" · "),
    );
    const asset = `art/actions/${roleArt}-${activity === "move" ? "idle" : activity}.webp`;
    if (sprite.getAttribute("src") !== asset) sprite.src = asset;
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
  const guests = new Map();
  const announcedStops = new Map();
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
      const portrait = avatar(role);
      node.append(portrait, info, controls);
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
    } = guests.get(role.id);
    node.dataset.state = role.available ? role.state : "unavailable";
    if (name.textContent !== role.name) name.textContent = role.name;
    portrait.className = `portrait ${role.color}`;
    const sprite = portrait.querySelector("img");
    const src = assetPath(role.art ?? role.id);
    if (sprite.getAttribute("src") !== src) sprite.src = src;
    decline.hidden = room.live || role.state !== "invited";
    stop.hidden = seat.hidden = role.state !== "here" || !role.available;
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

  function update(next) {
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
    const stopped = [];
    for (const role of room.roles) {
      guest(role);
      const body = role.bodyStatus;
      if (
        body?.reason === "manual-control" &&
        Number.isFinite(body.at) &&
        body.at > (announcedStops.get(role.id) ?? -Infinity)
      ) {
        announcedStops.set(role.id, body.at);
        stopped.push(`已停止${role.name}的移动`);
      }
    }
    if (stopped.length) bodyAnnouncement.textContent = stopped.join("。");
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
    send.disabled = message.disabled;
    attach.hidden = !room.framework || !window.nest.attach;
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
    const active = here.find(({ id }) => id === room.activityActor);
    const status = room.connectionLost
      ? room.notice
      : thinking
        ? `${thinking.name}正在想…`
        : active
          ? `${active.name}正在自主活动…`
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
    if (!text || message.disabled) return;
    window.nest.act("send", text);
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
