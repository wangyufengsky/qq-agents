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

function activityFor(role, room) {
  if (Object.hasOwn(activityLabels, role.activity)) return role.activity;
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
    const roleArt = role.art ?? role.id;
    art.dataset.appearance = roleArt;
    if (art.dataset.activity !== activity) art.dataset.activity = activity;
    art.setAttribute(
      "aria-label",
      `${role.name} · ${activityLabels[activity]} · 打开聊天`,
    );
    const asset = `art/actions/${roleArt}-${activity === "move" ? "idle" : activity}.webp`;
    if (sprite.getAttribute("src") !== asset) sprite.src = asset;
    const message =
      data.bubbles?.[id]?.text ?? (data.thinking === id ? "正在想…" : "");
    words.textContent = message;
    speech.hidden = !message;
  });
}

function panel() {
  root.append(
    document.getElementById("panel-template").content.cloneNode(true),
  );
  const select = (selector) => root.querySelector(selector);
  const guestList = select(".guest-list");
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
  const clock = new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });

  function bindDesktopPermission(selector, key, labels, notices) {
    const section = select(selector);
    const button = section.querySelector("button");
    const notice = section.querySelector(".desktop-permission-status");
    let choosing = false;
    let lastAgent;
    function refresh() {
      const policy = room?.[key];
      const agent = room?.roles.find(({ id }) => id === policy?.grantedAgentId);
      if (lastAgent !== agent?.id) {
        lastAgent = agent?.id;
        notice.hidden = true;
      }
      section.hidden =
        !room?.connected ||
        !window.nest[key] ||
        (!agent && !policy?.eligible.length);
      button.disabled = choosing;
      button.textContent = agent ? labels.revoke : labels.grant;
      button.title = agent ? `当前授权给${agent.name}` : labels.help;
    }
    button.addEventListener("click", async () => {
      if (section.hidden || choosing) return;
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
      permission: "请在系统设置中允许屏幕录制后重试。",
      "no-sources": "当前没有可选窗口。",
      unavailable: "当前无法更改自主观察授权。",
      failed: "自主观察授权操作失败。",
    },
  );
  const observationTarget = select(".observation-target");
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
    if (!["chat", "visits"].includes(section)) return;
    select("#visits").hidden = section !== "visits";
    select("#chat").hidden = section !== "chat";
    for (const tab of root.querySelectorAll("[data-tab]"))
      tab.setAttribute("aria-pressed", String(tab.dataset.tab === section));
    if (section === "chat") {
      closeSettings();
      thread.scrollTop = thread.scrollHeight;
      if (!message.disabled) message.focus();
    }
  }

  function guest(role) {
    if (!guests.has(role.id)) {
      const node = element("article", "guest");
      node.dataset.role = role.id;
      const info = element("div");
      const state = element("small");
      const name = element("strong", null, role.name);
      info.append(name, state);
      const action = button("secondary");
      action.addEventListener("click", () => {
        const current = room.roles.find(({ id }) => id === role.id);
        window.nest.act(current.state === "here" ? "leave" : "invite", role.id);
      });
      const decline = button("quiet", "模拟婉拒", `模拟婉拒 · ${role.name}`);
      decline.addEventListener("click", () =>
        window.nest.act("decline", role.id),
      );
      const controls = element("div", "guest-controls");
      controls.append(decline, action);
      const portrait = avatar(role);
      node.append(portrait, info, controls);
      guestList.append(node);
      guests.set(role.id, { node, name, portrait, state, action, decline });
    }
    const { node, name, portrait, state, action, decline } = guests.get(
      role.id,
    );
    node.dataset.state = role.available ? role.state : "unavailable";
    if (name.textContent !== role.name) name.textContent = role.name;
    portrait.className = `portrait ${role.color}`;
    const sprite = portrait.querySelector("img");
    const src = assetPath(role.art ?? role.id);
    if (sprite.getAttribute("src") !== src) sprite.src = src;
    decline.hidden = room.live || role.state !== "invited";
    const [label, text] = {
      home: ["在家", "邀请"],
      invited: ["已邀请 · 等待回应", "取消邀请"],
      here: ["在桌边", "请回家"],
    }[role.state];
    const activity = activityFor(role, room);
    const status = !role.available
      ? "本轮未接入"
      : activity !== "idle" && (role.state === "here" || activity === "sleep")
        ? activityLabels[activity]
        : label;
    if (state.textContent !== status) state.textContent = status;
    action.hidden = !role.available || room.knock?.actor === role.id;
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
      select(".knock-card").hidden = !room.knock;
      if (room.knock) {
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
    for (const role of room.roles) guest(role);
    const notice = select(".room-notice");
    if (notice.textContent !== room.notice) notice.textContent = room.notice;
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
    message.disabled = !here.length;
    message.placeholder = here.length
      ? "说点什么…（可用 @ 名字）"
      : "邀请一位角色开始聊天";
    send.disabled = !here.length;
    attach.hidden = !room.framework || !window.nest.attach;
    attach.disabled =
      attaching ||
      (!room.attachmentInput?.text && !room.attachmentInput?.image);
    updateScreenView();
    updateObservation();
    const observation = room.observation;
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
    const status = thinking
      ? `${thinking.name}正在想…`
      : active
        ? `${active.name}正在自主活动…`
        : "";
    activityControl.hidden = !room.activityEnabled;
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
