import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  systemPreferences,
  Tray,
} from "electron";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openNoFollowAsync } from "../../src/core/no-follow.mjs";
import { createFrameworkClient } from "./framework-client.mjs";
import { LiveRoom } from "./live-room.mjs";
import { startModelClient } from "./model-client.mjs";
import {
  captureScreen,
  listScreenSources,
  screenCaptureSupported,
} from "./screen-capture.mjs";
import {
  DEFAULT_MINUTES,
  MAX_TURNS,
  arrive,
  cancelInvite,
  createRoom,
  decline,
  finishTurn,
  invite,
  leave,
  refreshIfDue,
  roles as prototypeRoles,
  setIntervalMinutes,
  speak,
  startTurn,
} from "./room.mjs";

const source = fileURLToPath(new URL(".", import.meta.url));
const trialProfile = process.env.DESKTOP_HOME_TRIAL_PROFILE;
if (trialProfile) app.setPath("userData", trialProfile);
const preferencesPath = join(
  app.getPath("userData"),
  "prototype-preferences.json",
);

function readPreferences() {
  try {
    return JSON.parse(readFileSync(preferencesPath, "utf8"));
  } catch {
    return {};
  }
}

const saved = readPreferences();
const positions = saved.positions ?? {};
const validInterval = (value) =>
  Number.isInteger(value) && value >= 0 && value <= 1440;
let roles = prototypeRoles;
const room = createRoom(
  validInterval(saved.minutes) ? saved.minutes : DEFAULT_MINUTES,
);
const entries = new Map();
const invitations = new Map();
const bubbles = new Map();
let finishTimer;
let hidden = false;
let tray;
const liveRoot = process.env.DESKTOP_HOME_LIVE_ROOT;
const dataArgument = process.argv.indexOf("--data");
const portArgument = process.argv.indexOf("--port");
const port =
  process.env.DESKTOP_HOME_PORT ??
  (portArgument >= 0 ? process.argv[portArgument + 1] : undefined);
const frameworkPort = port === undefined ? undefined : Number(port);
const frameworkRoot =
  process.env.DESKTOP_HOME_DATA_ROOT ||
  (dataArgument >= 0 ? process.argv[dataArgument + 1] : null);
let framework;
let remoteState;
let live;
let shuttingDown = false;
let screenGrant;
let lastScreenGrant;
let screenCapture;
let choosingScreen = false;

function clearScreenGrant() {
  screenGrant = undefined;
  screenCapture?.controller.abort();
}

function screenRequest(value, action) {
  const grant = screenGrant;
  const { room: current, screenRequest: request } = value;
  if (!grant) return;
  if (
    current?.roomEpoch !== grant.roomEpoch ||
    !current.screenView?.eligible.includes(grant.agentId) ||
    (!grant.pending && current.screenView.grantedAgentId !== grant.agentId)
  ) {
    clearScreenGrant();
    return;
  }
  if (
    action === "sync" &&
    screenCapture &&
    screenCapture.requestId !== request?.requestId
  )
    screenCapture.controller.abort();
  if (
    !request ||
    screenCapture ||
    request.roomEpoch !== grant.roomEpoch ||
    request.grantId !== grant.grantId ||
    request.requestId === grant.lastRequest
  )
    return;
  grant.lastRequest = request.requestId;
  const { roomEpoch, grantId, requestId, maxEdge, maxBytes } = request;
  const controller = new AbortController();
  screenCapture = { controller, requestId };
  const isCurrent = () =>
    screenGrant === grant && !controller.signal.aborted && !shuttingDown;
  void (async () => {
    try {
      const data = await captureScreen(
        grant.source,
        maxEdge,
        maxBytes,
        controller.signal,
      ).catch(() => undefined);
      if (isCurrent())
        await framework.screenResult(
          { roomEpoch, grantId, requestId, data },
          isCurrent,
        );
    } catch {
      // The host owns request expiry and rejects stale results.
    } finally {
      screenCapture = undefined;
    }
  })();
}

function savePreferences() {
  mkdirSync(app.getPath("userData"), { recursive: true });
  const next = `${preferencesPath}.next`;
  writeFileSync(next, JSON.stringify({ minutes: room.minutes, positions }));
  renameSync(next, preferencesPath);
}

function snapshot() {
  if (frameworkRoot)
    return (
      remoteState ?? {
        live: true,
        framework: true,
        subjectKnocks: true,
        roles: [],
        messages: [],
        budget: MAX_TURNS,
        maxTurns: MAX_TURNS,
        minutes: DEFAULT_MINUTES,
        nextRefill: null,
        thinking: null,
        bubbles: {},
        knock: null,
        notice: "正在连接管理台…",
      }
    );
  return {
    live: Boolean(liveRoot),
    subjectKnocks: Boolean(live?.runner.subjectActor),
    doorMode: live?.doorMode,
    opportunity: Boolean(live?.opportunity),
    opportunityAt: live?.lastOpportunityAt,
    knock: live?.knock ?? null,
    roles: roles.map(({ id, name, title, color }) => ({
      id,
      name,
      title,
      color,
      state: room.members[id],
      available: !liveRoot || live?.supported.has(id),
    })),
    messages: room.messages,
    budget: room.budget,
    maxTurns: MAX_TURNS,
    minutes: room.minutes,
    nextRefill: room.nextRefill,
    thinking: room.turn?.actor ?? null,
    bubbles: room.bubbles,
    notice: room.notice,
  };
}

function send(entry, channel, value) {
  if (entry?.ready && !entry.win.isDestroyed())
    entry.win.webContents.send(channel, value);
}

function update() {
  const data = snapshot();
  for (const entry of entries.values()) send(entry, "room:update", data);
}

const sizes = {
  door: [100, 118],
  panel: [430, 574],
  sprite: [194, 156],
};

function defaultPoint(id) {
  const { x, y, width, height } = screen.getPrimaryDisplay().workArea;
  if (id === "door") return { x: x + width - 122, y: y + height - 138 };
  const index = roles.findIndex((role) => role.id === id);
  return {
    x: x + width - 290 - index * 142,
    y: y + height - 171 - (index % 2) * 28,
  };
}

function clampPoint(point, width, height, area) {
  const work =
    area ?? screen.getDisplayMatching({ ...point, width, height }).workArea;
  return {
    x: Math.round(
      Math.min(
        Math.max(point.x, work.x),
        Math.max(work.x, work.x + work.width - width),
      ),
    ),
    y: Math.round(
      Math.min(
        Math.max(point.y, work.y),
        Math.max(work.y, work.y + work.height - height),
      ),
    ),
  };
}

function spritePoint(id) {
  const point = positions[id];
  return Number.isFinite(point?.x) && Number.isFinite(point?.y)
    ? point
    : defaultPoint(id);
}

function createWindow(id, type, point, options = {}) {
  const [width, height] = sizes[type];
  const panel = type === "panel";
  const win = new BrowserWindow({
    ...clampPoint(point, width, height, options.area),
    width,
    height,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: panel,
    resizable: false,
    movable: panel,
    focusable: panel,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    enableLargerThanScreen: false,
    webPreferences: {
      preload: join(source, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  const entry = { win, id, type, ready: false, section: options.section };
  entries.set(id, entry);
  if (panel) win.setAlwaysOnTop(true, "floating", 1);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.on("did-finish-load", () => {
    entry.ready = true;
    send(entry, "room:update", snapshot());
    send(entry, "room:section", entry.section);
  });
  win.once("ready-to-show", () => {
    if (hidden && !panel) return;
    if (panel) win.show();
    else win.showInactive();
  });
  win.on("closed", () => {
    clearInterval(entry.movement);
    if (entries.get(id) === entry) entries.delete(id);
  });
  win.loadFile(join(source, "index.html"), { query: { type, id } });
  return entry;
}

function showDoor() {
  hidden = false;
  if (!entries.has("door")) createWindow("door", "door", defaultPoint("door"));
  for (const entry of entries.values()) {
    if (entry.ready && entry.type !== "panel") entry.win.showInactive();
  }
}

function showPanel(section) {
  showDoor();
  const existing = entries.get("panel");
  if (existing) {
    existing.section = section;
    send(existing, "room:section", section);
    existing.win.show();
    existing.win.focus();
    return;
  }
  const door = entries.get("door").win.getBounds();
  const area = screen.getDisplayMatching(door).workArea;
  createWindow(
    "panel",
    "panel",
    {
      x: door.x + door.width - sizes.panel[0],
      y: door.y - sizes.panel[1] - 36,
    },
    { area, section },
  );
}

function animateTo(entry, point, complete) {
  clearInterval(entry.movement);
  const [width, height] = sizes[entry.type];
  const target = clampPoint(point, width, height);
  const [x, y] = entry.win.getPosition();
  const reduced =
    process.platform === "darwin" && app.isAccessibilitySupportEnabled();
  const started = Date.now();
  if (reduced || hidden) {
    entry.win.setPosition(target.x, target.y);
    complete?.();
    return;
  }
  entry.movement = setInterval(() => {
    if (entry.win.isDestroyed()) return clearInterval(entry.movement);
    const progress = Math.min(1, (Date.now() - started) / 450);
    const eased = 1 - (1 - progress) ** 3;
    entry.win.setPosition(
      Math.round(x + (target.x - x) * eased),
      Math.round(y + (target.y - y) * eased),
    );
    if (progress === 1) {
      clearInterval(entry.movement);
      complete?.();
    }
  }, 16);
}

function showSprite(role) {
  const previous = entries.get(role.id);
  if (previous) previous.win.destroy();
  const door = entries.get("door")?.win.getBounds();
  const point = spritePoint(role.id);
  const entry = createWindow(
    role.id,
    "sprite",
    door ? { x: door.x - 36, y: door.y - 27 } : point,
  );
  entry.win.once("ready-to-show", () => animateTo(entry, point));
}

function hideAll() {
  hidden = true;
  for (const { win } of entries.values()) win.hide();
}

function animateHome(role) {
  const entry = entries.get(role.id);
  if (entry && !entry.departing) {
    entry.departing = true;
    entry.win.setIgnoreMouseEvents(true);
    const door = entries.get("door")?.win.getBounds();
    if (door)
      animateTo(entry, { x: door.x - 36, y: door.y - 27 }, () =>
        entry.win.destroy(),
      );
    else entry.win.destroy();
  }
}

function applyFramework(value, action) {
  screenRequest(value, action);
  if (value.closed) {
    app.quit();
    return;
  }
  const state = value.room ?? {
    ...snapshot(),
    roles: [],
    messages: [],
    bubbles: {},
    knock: null,
    thinking: null,
    notice: value.offline
      ? "连接管理台失败，正在重试。"
      : value.busy
        ? "另一个桌面小窝正在使用这个实例。"
        : "请在管理台的纸页小窝里开启桌面小窝。",
  };
  for (const role of roles)
    if (!state.roles.some(({ id }) => id === role.id)) animateHome(role);
  roles = state.roles;
  remoteState = {
    ...state,
    live: true,
    framework: true,
    subjectKnocks: true,
    connected: !!value.room,
    screenView: screenCaptureSupported ? value.room?.screenView : undefined,
  };
  room.members = Object.fromEntries(roles.map(({ id, state }) => [id, state]));
  room.bubbles = { ...state.bubbles };
  room.turn = state.thinking ? { actor: state.thinking } : null;
  syncLive();
}

function syncLive() {
  for (const role of roles) {
    if (room.members[role.id] === "here") {
      const message = room.bubbles[role.id];
      if (message && bubbles.get(role.id)?.id !== message.id) {
        clearTimeout(bubbles.get(role.id)?.timer);
        const timer = setTimeout(() => {
          if (room.bubbles[role.id] === message) delete room.bubbles[role.id];
          bubbles.delete(role.id);
          update();
        }, 4900);
        bubbles.set(role.id, { id: message.id, timer });
      }
      const entry = entries.get(role.id);
      if (!entry || entry.departing) showSprite(role);
    } else animateHome(role);
  }
  update();
}

function returnHome(role, self = false) {
  if (framework) return framework.act("leave", role.id);
  if (live) return live.leave(role);
  const turn = room.turn;
  if (!leave(room, role, Date.now(), self)) return;
  clearTimeout(bubbles.get(role.id));
  bubbles.delete(role.id);
  animateHome(role);
  if (room.turn !== turn) {
    clearTimeout(finishTimer);
    advance();
  }
  update();
}

function advance() {
  const turn = startTurn(room);
  if (!turn) return;
  update();
  finishTimer = setTimeout(() => {
    if (!finishTurn(room, turn)) return;
    clearTimeout(bubbles.get(turn.actor));
    const message = room.bubbles[turn.actor];
    bubbles.set(
      turn.actor,
      setTimeout(() => {
        if (room.bubbles[turn.actor] === message)
          delete room.bubbles[turn.actor];
        bubbles.delete(turn.actor);
        update();
      }, 4900),
    );
    update();
    advance();
  }, 1250);
}

function changeInvitation(role) {
  if (room.members[role.id] === "invited") {
    clearTimeout(invitations.get(role.id));
    invitations.delete(role.id);
    cancelInvite(room, role);
  } else if (invite(room, role)) {
    invitations.set(
      role.id,
      setTimeout(() => {
        invitations.delete(role.id);
        if (arrive(room, role)) showSprite(role);
        update();
      }, 2750),
    );
  }
  update();
}

function updatePointerRegions() {
  if (hidden) return;
  const { x, y } = screen.getCursorScreenPoint();
  for (const entry of entries.values()) {
    const { win, type, id } = entry;
    if (type === "panel" || entry.departing || !win.isVisible()) continue;
    const bounds = win.getBounds();
    const dx = x - bounds.x;
    const dy = y - bounds.y;
    const active =
      type === "door"
        ? dx >= 9 && dx <= 91 && dy >= 6 && dy <= 107
        : (dx >= 44 && dx <= 150 && dy >= 45 && dy <= 152) ||
          ((room.bubbles[id] || room.turn?.actor === id) &&
            dx >= 10 &&
            dx <= 184 &&
            dy >= 2 &&
            dy <= 54);
    const ignored = !active && !entry.drag;
    if (ignored === entry.ignored) continue;
    entry.ignored = ignored;
    win.setIgnoreMouseEvents(ignored);
  }
}

function handleDrag(entry, action, data) {
  if (!Number.isFinite(data?.x) || !Number.isFinite(data?.y)) return;
  const [x, y] = entry.win.getPosition();
  if (action === "drag-start") {
    clearInterval(entry.movement);
    entry.drag = { x, y, mouseX: data.x, mouseY: data.y };
  } else if (entry.drag) {
    const from = entry.drag;
    const target = clampPoint(
      {
        x: from.x + data.x - from.mouseX,
        y: from.y + data.y - from.mouseY,
      },
      ...sizes.sprite,
    );
    entry.win.setPosition(target.x, target.y);
    if (action === "drag-end") {
      entry.drag = null;
      positions[entry.id] = target;
      savePreferences();
    }
  }
}

ipcMain.handle("room:get", (event) => {
  const entry = [...entries.values()].find(
    ({ win }) => win.webContents === event.sender,
  );
  if (entry) return { data: snapshot(), section: entry.section };
});

let choosingAttachment = false;
ipcMain.handle("room:attach", async (event) => {
  const entry = [...entries.values()].find(
    ({ win }) => win.webContents === event.sender,
  );
  const availability = remoteState?.attachmentInput;
  const roomEpoch = remoteState?.roomEpoch;
  if (
    !framework ||
    !roomEpoch ||
    entry?.type !== "panel" ||
    entry.departing ||
    entry.section !== "chat" ||
    !entry.win.isFocused() ||
    choosingAttachment ||
    (!availability?.text && !availability?.image)
  )
    return "unavailable";
  const imageExtensions = ["png", "jpg", "jpeg", "webp"];
  const extensions = [
    ...(availability.text ? ["txt", "md", "csv", "json"] : []),
    ...(availability.image ? imageExtensions : []),
  ];
  choosingAttachment = true;
  try {
    const selection = await dialog.showOpenDialog(entry.win, {
      title: "发送附件到桌面小窝",
      buttonLabel: "发送",
      properties: ["openFile"],
      filters: [{ name: "桌面小窝支持的附件", extensions }],
    });
    if (selection.canceled) return "cancelled";
    const [selected] = selection.filePaths;
    const name = basename(selected);
    const extension = extname(name).slice(1).toLowerCase();
    if (!extensions.includes(extension) || name.length > 120) return "invalid";
    const maxBytes = imageExtensions.includes(extension)
      ? 2 * 1024 * 1024
      : 12 * 1024;
    const file = await openNoFollowAsync(selected);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > maxBytes)
        return "invalid";
      const buffer = Buffer.alloc(maxBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(
          buffer,
          length,
          buffer.length - length,
        );
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (!length || length > maxBytes) return "invalid";
      await framework.attach({
        roomEpoch,
        name,
        data: buffer.subarray(0, length).toString("base64"),
      });
      return "sent";
    } finally {
      await file.close();
    }
  } catch {
    return "failed";
  } finally {
    choosingAttachment = false;
  }
});

function screenSourceMenu(win, availableRoles, sources) {
  return new Promise((resolve) => {
    let selection;
    const menu = Menu.buildFromTemplate(
      availableRoles.map(({ id, name }) => ({
        label: name.replaceAll("&", "&&"),
        submenu: sources.map((source) => ({
          label: `${source.id.startsWith("screen:") ? "显示器" : "窗口"} · ${source.name
            .replace(/[\p{Cc}\p{Cf}]/gu, "")
            .slice(0, 90)
            .replaceAll("&", "&&")}`,
          click: () => {
            selection = { agentId: id, source };
          },
        })),
      })),
    );
    menu.popup({
      window: win,
      callback: () => setImmediate(() => resolve(selection)),
    });
  });
}

ipcMain.handle("room:screen-view", async (event) => {
  const entry = entries.get("panel");
  const win = entry?.win;
  const { screenView, roomEpoch } = remoteState ?? {};
  if (
    !screenCaptureSupported ||
    !framework ||
    !roomEpoch ||
    !screenView ||
    !win ||
    win.webContents !== event.sender ||
    event.senderFrame !== win.webContents.mainFrame ||
    !win.isFocused() ||
    choosingScreen
  )
    return "unavailable";
  if (screenView.grantedAgentId) {
    const grant = lastScreenGrant;
    clearScreenGrant();
    try {
      if (
        grant?.roomEpoch !== roomEpoch ||
        grant.agentId !== screenView.grantedAgentId
      )
        return "unavailable";
      choosingScreen = true;
      const room = await framework.screenCommand("screen-revoke", {
        roomEpoch,
        grantId: grant.grantId,
      });
      return room?.screenView?.grantedAgentId ? "failed" : "revoked";
    } catch {
      return "failed";
    } finally {
      choosingScreen = false;
    }
  }
  choosingScreen = true;
  try {
    if (process.platform === "darwin") {
      const status = systemPreferences.getMediaAccessStatus("screen");
      if (status === "denied" || status === "restricted") return "permission";
    }
    const sources = await listScreenSources();
    if (
      process.platform === "darwin" &&
      systemPreferences.getMediaAccessStatus("screen") !== "granted"
    )
      return "permission";
    if (win.isDestroyed() || !win.isFocused()) return "cancelled";
    if (!sources.length) return "no-sources";
    const eligible = roles.filter(({ id }) => screenView.eligible.includes(id));
    if (!eligible.length) return "unavailable";
    const selection = await screenSourceMenu(win, eligible, sources);
    if (!selection || win.isDestroyed() || !win.isVisible()) return "cancelled";
    if (
      remoteState?.roomEpoch !== roomEpoch ||
      remoteState?.screenView?.grantedAgentId ||
      !remoteState?.screenView?.eligible.includes(selection.agentId)
    )
      return "unavailable";
    const grant = {
      ...selection,
      roomEpoch,
      grantId: randomUUID(),
      pending: true,
    };
    screenGrant = grant;
    lastScreenGrant = {
      roomEpoch,
      grantId: grant.grantId,
      agentId: grant.agentId,
    };
    try {
      const room = await framework.screenCommand("screen-grant", {
        roomEpoch,
        grantId: grant.grantId,
        agentId: grant.agentId,
      });
      grant.pending = false;
      if (
        screenGrant === grant &&
        room?.roomEpoch === roomEpoch &&
        room.screenView?.grantedAgentId === grant.agentId
      )
        return "granted";
      if (screenGrant === grant) clearScreenGrant();
      return "unavailable";
    } catch {
      if (screenGrant === grant) clearScreenGrant();
      return "failed";
    }
  } catch {
    return "failed";
  } finally {
    choosingScreen = false;
  }
});

ipcMain.on("room:action", (event, action, data) => {
  const entry = [...entries.values()].find(
    ({ win }) => win.webContents === event.sender,
  );
  if (!entry || entry.departing) return;
  if (live) live.tick();
  else if (refreshIfDue(room)) update();
  if (entry.type === "door") {
    if (action === "open") showPanel("visits");
    return;
  }
  if (entry.type === "sprite") {
    const role = roles.find(({ id }) => id === entry.id);
    if (action === "open") showPanel("chat");
    if (action === "menu") {
      Menu.buildFromTemplate([
        { label: "打开聊天", click: () => showPanel("chat") },
        {
          label: "坐回默认位置",
          click: () => {
            delete positions[role.id];
            savePreferences();
            animateTo(entry, defaultPoint(role.id));
          },
        },
        { type: "separator" },
        { label: "请回家", click: () => returnHome(role) },
        ...(live || framework
          ? []
          : [
              {
                label: "模拟角色自行回家",
                click: () => returnHome(role, true),
              },
            ]),
      ]).popup({ window: entry.win });
    }
    if (["drag-start", "drag-move", "drag-end"].includes(action))
      handleDrag(entry, action, data);
    return;
  }
  const role = roles.find(({ id }) => id === data);
  if (framework) {
    if (action === "close") entry.win.hide();
    else if (
      ["invite", "leave", "send", "door-mode", "knock-answer"].includes(action)
    )
      framework.act(action, data);
    return;
  }
  if (action === "invite" && role) {
    if (live) void live.invite(role);
    else changeInvitation(role);
  }
  if (action === "decline" && !live && role && decline(room, role)) {
    clearTimeout(invitations.get(role.id));
    invitations.delete(role.id);
    update();
  }
  if (action === "leave" && role) returnHome(role);
  if (action === "send" && typeof data === "string") {
    if (live) live.send(data);
    else if (speak(room, data)) {
      clearTimeout(finishTimer);
      advance();
      update();
    }
  }
  if (action === "interval" && validInterval(data) && data !== room.minutes) {
    if (live) live.interval(data);
    else setIntervalMinutes(room, data);
    savePreferences();
    update();
  }
  if (action === "door-mode") live?.setDoorMode(data);
  if (action === "knock-trial") void live?.offerOpportunity({ trial: true });
  if (action === "knock-answer" && typeof data === "boolean")
    live?.answerKnock(data);
  if (action === "close") entry.win.hide();
});

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", showDoor);
  app.on("window-all-closed", () => {});
  app.on("before-quit", (event) => {
    if ((!live && !framework) || shuttingDown) return;
    event.preventDefault();
    shuttingDown = true;
    clearScreenGrant();
    void (framework ?? live).close().finally(() => app.quit());
  });
  app.whenReady().then(() => {
    if (process.platform === "darwin") app.setActivationPolicy("accessory");
    if (frameworkRoot) {
      roles = [];
      framework = createFrameworkClient(
        frameworkRoot,
        applyFramework,
        frameworkPort,
      );
    } else if (liveRoot) {
      live = new LiveRoom(
        room,
        startModelClient(liveRoot, process.env.DESKTOP_HOME_NODE),
        syncLive,
      );
    }
    const trayImage = nativeImage.createFromPath(
      join(source, "art", "trayTemplate.png"),
    );
    if (process.platform === "darwin") trayImage.setTemplateImage(true);
    tray = new Tray(trayImage.resize({ width: 16, height: 16 }));
    tray.setToolTip(
      framework
        ? "桌面小窝"
        : live
          ? "桌面小窝 · 隔离试聊"
          : "桌面小窝 · 模拟样机",
    );
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "显示小门", click: showDoor },
        { label: "打开聊天", click: () => showPanel("chat") },
        { label: "隐藏小窝", click: hideAll },
        { type: "separator" },
        { label: "退出桌面小窝", click: () => app.quit() },
      ]),
    );
    showDoor();
    setInterval(updatePointerRegions, 32);
    setInterval(() => {
      if (live) live.tick();
      else if (!framework && refreshIfDue(room)) update();
    }, 500);
  });
}
