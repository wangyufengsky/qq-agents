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

function image(asset) {
  const img = element("img");
  img.src = `art/${asset}.png`;
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

function floating() {
  const space = element("main", "floating");
  const door = type === "door";
  const art = button(
    door ? "door-button" : "sprite-button",
    "",
    door ? "打开小窝的门" : "打开小窝聊天",
  );
  art.title = door ? "桌面小窝" : "点击聊天 · 拖动换座位 · 右键菜单";
  art.append(image(door ? "door" : id));
  space.append(art);
  root.append(space);

  if (door) {
    const indicator = element("span", "door-knock", "有人敲门");
    indicator.hidden = true;
    art.append(indicator);
    function updateDoor(data) {
      const visitor = data.roles.find(({ id }) => id === data.knock?.actor);
      indicator.hidden = !visitor;
      art.setAttribute(
        "aria-label",
        visitor ? `${visitor.name}敲门，打开小窝的门` : "打开小窝的门",
      );
    }
    window.nest.onRoom(updateDoor);
    window.nest.get().then((value) => {
      if (value) updateDoor(value.data);
    });
    art.addEventListener("click", () => window.nest.act("open"));
    return;
  }

  const speech = button("speech", "", "打开小窝聊天");
  const words = element("span");
  speech.append(words);
  speech.hidden = true;
  speech.addEventListener("click", () => window.nest.act("open"));
  space.prepend(speech);

  let pointer;
  let moved = false;
  const position = (event) => ({ x: event.screenX, y: event.screenY });
  art.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    pointer = position(event);
    moved = false;
    art.setPointerCapture(event.pointerId);
  });
  art.addEventListener("pointermove", (event) => {
    if (!pointer) return;
    const current = position(event);
    if (
      !moved &&
      Math.hypot(current.x - pointer.x, current.y - pointer.y) >= 5
    ) {
      moved = true;
      window.nest.act("drag-start", pointer);
    }
    if (moved) window.nest.act("drag-move", current);
  });
  function endDrag(event) {
    if (!pointer) return;
    if (moved) window.nest.act("drag-end", position(event));
    pointer = null;
  }
  art.addEventListener("pointerup", endDrag);
  art.addEventListener("pointercancel", endDrag);
  art.addEventListener("click", () => {
    if (!moved) window.nest.act("open");
    moved = false;
  });
  art.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    window.nest.act("menu");
  });

  function update(data) {
    const role = data.roles.find((item) => item.id === id);
    if (!role) return;
    art.setAttribute("aria-label", `${role.name} · 打开聊天`);
    const sprite = art.querySelector("img");
    const asset = `art/${role.art ?? role.id}.png`;
    if (sprite.getAttribute("src") !== asset) sprite.src = asset;
    const message =
      data.bubbles[id]?.text ?? (data.thinking === id ? "正在想…" : "");
    words.textContent = message;
    speech.hidden = !message;
  }
  window.nest.onRoom(update);
  window.nest.get().then((value) => {
    if (value) update(value.data);
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
  const settingsForm = select(".timer-settings");
  const minutes = select("#minutes");
  const timerOn = select("#timer-on");
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

  function switchSection(section) {
    if (!["chat", "visits"].includes(section)) return;
    select("#visits").hidden = section !== "visits";
    select("#chat").hidden = section !== "chat";
    for (const tab of root.querySelectorAll("[data-tab]"))
      tab.setAttribute("aria-pressed", String(tab.dataset.tab === section));
    if (section === "chat") {
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
      info.append(element("strong", null, role.name), state);
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
      node.append(avatar(role), info, controls);
      guestList.append(node);
      guests.set(role.id, { node, state, action, decline });
    }
    const { state, action, decline } = guests.get(role.id);
    decline.hidden = room.live || role.state !== "invited";
    const [label, text] = {
      home: ["在家", "邀请"],
      invited: ["已邀请 · 等待回应", "取消邀请"],
      here: ["在桌边", "请回家"],
    }[role.state];
    const status = role.available ? label : "本轮未接入";
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

  function showBudget() {
    if (!room) return;
    const parts = [];
    if (room.thinking)
      parts.push(
        `${room.roles.find(({ id }) => id === room.thinking)?.name}在想…`,
      );
    else if (!room.budget) parts.push("等你接话");
    if (room.nextRefill === null) parts.push("发出新消息时刷新");
    else {
      const remaining = Math.max(
        0,
        Math.ceil((room.nextRefill - Date.now()) / 1000),
      );
      const formatted =
        remaining >= 60
          ? `${Math.ceil(remaining / 60)} 分钟`
          : `${remaining} 秒`;
      parts.push(`${formatted}后刷新`);
    }
    const detail = select(".budget-detail");
    const text = parts.join(" · ");
    if (detail.textContent !== text) detail.textContent = text;
    const live = select(".turn-status");
    const status = room.thinking ? parts[0] : room.budget ? "" : "等你接话";
    if (live.textContent !== status) live.textContent = status;
  }

  function update(next) {
    room = next;
    settings.hidden = Boolean(room.framework);
    if (room.live) {
      select(".edition").textContent = room.framework
        ? "QQ Agents"
        : "隔离试聊";
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
    const roster = here.map(({ id }) => id).join();
    if (lastRoster !== roster) {
      audience.replaceChildren(
        document.createTextNode("在场"),
        element("span", null, "你"),
      );
      for (const role of here)
        audience.append(element("span", role.color, role.name));
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
    updateNativeControl();
    updateThread();
    const budget = select(".budget-label");
    const label = `共用回合 ${room.budget} / ${room.maxTurns}`;
    if (budget.textContent !== label) {
      budget.textContent = label;
      const pips = select(".pips");
      pips.replaceChildren(
        ...Array.from({ length: room.maxTurns }, (_, index) =>
          element("span", index < room.budget ? "pip available" : "pip"),
        ),
      );
    }
    showBudget();
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
  setInterval(showBudget, 1000);
}

if (type === "panel") panel();
else floating();
