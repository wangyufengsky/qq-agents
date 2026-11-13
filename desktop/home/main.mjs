import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  powerMonitor,
  screen,
  systemPreferences,
  Tray,
} from "electron";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openNoFollowAsync } from "../../src/core/no-follow.mjs";
import { managedDesktopExecutable } from "../../src/home/desktop-dependencies.mjs";
import { clampToWorkArea, restoreWindowPoint } from "./window-placement.mjs";
import { parseBrowserOrigin } from "./browser-origin.mjs";
import { bodyDestination, DesktopBodyClient } from "./body-client.mjs";
import { createFrameworkClient } from "./framework-client.mjs";
import { NativeControlClient } from "./native-control-client.mjs";
import { createNativeDesktopDriver } from "./native-desktop-driver.mjs";
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
let doorPosition = saved.doorPosition;
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
let observationGrant;
let lastObservationGrant;
let screenCapture;
let choosingDesktopPermission = false;
let lastBrowserGrant;
let desktopLocked = false;
let bodyInputAfter = 0;
let pointerTimer;
const manuallyMoved = new Set();
const body = new DesktopBodyClient({
  claim: (data, current) => framework.result("body-claim", data, current),
  result: (data, current) => framework.result("body-result", data, current),
  execute: executeBodyAction,
  position: bodyPosition,
});
const nativeDriver = ["darwin", "win32"].includes(process.platform)
  ? createNativeDesktopDriver({
      executable:
        process.env.QQ_AGENTS_AGENT_DESKTOP_EXECUTABLE ||
        managedDesktopExecutable(frameworkRoot, "agent-desktop"),
    })
  : null;
const nativeControl = nativeDriver
  ? new NativeControlClient(nativeDriver, {
      command: (action, data) => framework.command(action, data),
      claim: (data, isCurrent) =>
        framework.result("native-claim", data, isCurrent),
      result: (data, isCurrent) =>
        framework.result("native-result", data, isCurrent),
    })
  : null;

function clearScreenGrant(observe = false) {
  if (observe) {
    const agentId = observationGrant?.agentId;
    observationGrant = undefined;
    if (agentId) body.stopObservation(agentId);
  } else screenGrant = undefined;
  if (screenCapture?.observe === observe) screenCapture.controller.abort();
}

function clearObservation() {
  const grant = observationGrant;
  clearScreenGrant(true);
  if (grant && framework && !shuttingDown)
    framework.act("observation-revoke", {
      roomEpoch: grant.roomEpoch,
      grantId: grant.grantId,
    });
}

function screenRequest(value, action) {
  const { room: current, screenRequest: request } = value;
  for (const observe of [false, true]) {
    const grant = observe ? observationGrant : screenGrant;
    const policy = observe ? current?.observation : current?.screenView;
    if (
      grant &&
      (current?.roomEpoch !== grant.roomEpoch ||
        !policy?.eligible.includes(grant.agentId) ||
        (!grant.pending && policy.grantedAgentId !== grant.agentId))
    )
      clearScreenGrant(observe);
  }
  const observe = request?.mode === "observation";
  const grant = observe ? observationGrant : screenGrant;
  if (
    action === "sync" &&
    screenCapture &&
    screenCapture.requestId !== request?.requestId
  )
    screenCapture.controller.abort();
  if (!grant) return;
  if (
    !request ||
    (observe && (hidden || desktopLocked || Date.now() >= grant.expiresAt)) ||
    screenCapture ||
    request.roomEpoch !== grant.roomEpoch ||
    request.grantId !== grant.grantId ||
    request.requestId === grant.lastRequest
  )
    return;
  grant.lastRequest = request.requestId;
  const { roomEpoch, grantId, requestId, maxEdge, maxBytes } = request;
  const controller = new AbortController();
  screenCapture = { controller, requestId, observe };
  const isCurrent = () =>
    (observe
      ? observationGrant === grant &&
        !hidden &&
        !desktopLocked &&
        Date.now() < grant.expiresAt
      : screenGrant === grant) &&
    !controller.signal.aborted &&
    !shuttingDown;
  void (async () => {
    try {
      if (observe) {
        const claim = await framework.result(
          "screen-claim",
          { roomEpoch, grantId, requestId },
          isCurrent,
        );
        if (!claim?.accepted || !isCurrent()) return;
      }
      let data = await captureScreen(
        grant.source,
        maxEdge,
        maxBytes,
        controller.signal,
      ).catch(() => undefined);
      let status;
      let digest;
      if (observe) {
        if (!data) status = "unavailable";
        else {
          digest = createHash("sha256").update(data).digest("hex");
          if (grant.digest === digest) {
            data = undefined;
            status = "duplicate";
          }
        }
      }
      if (isCurrent()) {
        await framework.result(
          "screen-result",
          { roomEpoch, grantId, requestId, data, status },
          isCurrent,
        );
        if (isCurrent() && digest && data) grant.digest = digest;
        if (isCurrent() && status === "unavailable") clearObservation();
      }
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
  writeFileSync(
    next,
    JSON.stringify({ minutes: room.minutes, positions, doorPosition }),
  );
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
  for (const entry of entries.values()) {
    send(entry, "room:update", data);
    updateMotion(entry);
  }
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
  return clampToWorkArea(point, width, height, work);
}

function windowPoint(id, type) {
  const point = type === "door" ? doorPosition : positions[id];
  const [width, height] = sizes[type];
  const fallback = () =>
    clampPoint(
      defaultPoint(id),
      width,
      height,
      screen.getPrimaryDisplay().workArea,
    );
  if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y))
    return fallback();
  return restoreWindowPoint(
    { ...point, width, height },
    screen.getAllDisplays(),
    fallback,
  );
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
    entry.reportedMotion = undefined;
    send(entry, "room:update", snapshot());
    send(entry, "room:section", entry.section);
    if (entry.facing) send(entry, "room:facing", entry.facing);
    updateMotion(entry);
  });
  win.once("ready-to-show", () => {
    if (hidden && !panel) return;
    if (panel) win.show();
    else win.showInactive();
    updateMotion(entry);
    updatePointerPolling();
  });
  win.on("closed", () => {
    stopMovement(entry);
    if (entries.get(id) === entry) entries.delete(id);
    updatePointerPolling();
  });
  win.loadFile(join(source, "index.html"), { query: { type, id } });
  return entry;
}

function showDoor() {
  hidden = false;
  if (!entries.has("door"))
    createWindow("door", "door", windowPoint("door", "door"));
  for (const entry of entries.values()) {
    if (entry.ready && entry.type !== "panel") entry.win.showInactive();
    updateMotion(entry);
  }
  updatePointerPolling();
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

function updateMotion(entry) {
  if (entry.type !== "sprite" || entry.win.isDestroyed()) return;
  const suspended = hidden || desktopLocked || !entry.win.isVisible();
  const state = suspended ? "suspended" : entry.movement ? "moving" : "still";
  if (entry.reportedMotion === state) return;
  if (!entry.ready) return;
  entry.reportedMotion = state;
  send(entry, "room:motion", state);
}

function stopMovement(entry) {
  clearInterval(entry.movement);
  entry.movement = undefined;
  updateMotion(entry);
}

function stopLocalMotion() {
  for (const entry of entries.values()) {
    entry.drag = null;
    if (entry.departing) entry.win.destroy();
    else stopMovement(entry);
  }
}

function restoreWindowLayout() {
  bodyInputAfter = Date.now();
  body.clear("display-changed");
  stopLocalMotion();
  const displays = screen.getAllDisplays();
  for (const entry of entries.values()) {
    if (entry.win.isDestroyed()) continue;
    const bounds = entry.win.getBounds();
    const fallback = () =>
      entry.type === "panel"
        ? clampPoint(
            bounds,
            bounds.width,
            bounds.height,
            screen.getPrimaryDisplay().workArea,
          )
        : windowPoint(entry.id, entry.type);
    const point = restoreWindowPoint(bounds, displays, fallback);
    if (point.x !== bounds.x || point.y !== bounds.y)
      entry.win.setPosition(point.x, point.y);
  }
  updatePointerRegions();
}

function animateTo(entry, point, complete, options = {}) {
  stopMovement(entry);
  const [width, height] = sizes[entry.type];
  const target = clampPoint(point, width, height, options.area);
  const [x, y] = entry.win.getPosition();
  if (target.x !== x) {
    entry.facing = target.x < x ? "left" : "right";
    send(entry, "room:facing", entry.facing);
  }
  const started = Date.now();
  const duration = options.duration ?? 450;
  if (
    entry.reducedMotion ||
    hidden ||
    desktopLocked ||
    (x === target.x && y === target.y)
  ) {
    entry.win.setPosition(target.x, target.y);
    complete?.();
    return;
  }
  entry.movement = setInterval(() => {
    if (entry.win.isDestroyed()) return stopMovement(entry);
    if (options.current && !options.current()) {
      stopMovement(entry);
      options.interrupted();
      return;
    }
    const progress = entry.reducedMotion
      ? 1
      : Math.min(1, (Date.now() - started) / duration);
    const eased = options.current ? progress : 1 - (1 - progress) ** 3;
    entry.win.setPosition(
      Math.round(x + (target.x - x) * eased),
      Math.round(y + (target.y - y) * eased),
    );
    if (progress === 1) {
      stopMovement(entry);
      complete?.();
    }
  }, 16);
  updateMotion(entry);
}

function bodyPosition(id) {
  const entry = entries.get(id);
  if (!entry || entry.win.isDestroyed()) return {};
  const bounds = entry.win.getBounds();
  return {
    position: {
      x: bounds.x,
      y: bounds.y,
      displayId: screen.getDisplayMatching(bounds).id,
    },
    facing: entry.facing ?? "right",
  };
}

function executeBodyAction({ agentId, inputAt, action }, current, finish) {
  const entry = entries.get(agentId);
  const fail = (reason, status = "cancelled") => finish({ status, reason });
  if (!entry || entry.departing || entry.win.isDestroyed())
    return fail("inactive");
  if (hidden || desktopLocked || !entry.win.isVisible()) return fail("hidden");
  if (
    entry.drag ||
    entries.get("door")?.drag ||
    inputAt <= Math.max(entry.bodyInputAfter ?? 0, bodyInputAfter)
  )
    return fail("manual-control");
  if (action.type === "state") return finish({ status: "completed" });
  if (action.type === "pose") {
    entry.facing = action.facing;
    send(entry, "room:facing", entry.facing);
    return finish({ status: "completed" });
  }

  const bounds = entry.win.getBounds();
  const display = screen.getDisplayMatching(bounds);
  const doorWindow = entries.get("door")?.win;
  const target = bodyDestination({
    door: doorWindow && !doorWindow.isDestroyed() && doorWindow.getBounds(),
    seat: windowPoint(agentId, "sprite"),
    display,
    displayAt: (rect) => screen.getDisplayMatching(rect),
    bounds,
    target: action.target,
    clamp: clampPoint,
  });
  if (!target) return fail("target-unavailable", "failed");
  const distance = Math.hypot(target.x - bounds.x, target.y - bounds.y);
  animateTo(
    entry,
    target,
    () => {
      const [x, y] = entry.win.getPosition();
      if (x === target.x && y === target.y) finish({ status: "completed" });
      else fail("position-unconfirmed", "failed");
    },
    {
      area: display.workArea,
      current,
      interrupted: () => fail("inactive"),
      duration: Math.min(2200, Math.max(900, Math.round(distance * 3))),
    },
  );
  const movement = entry.movement;
  return () => {
    if (entry.movement === movement) stopMovement(entry);
  };
}

function showSprite(role) {
  const previous = entries.get(role.id);
  if (previous) previous.win.destroy();
  const door = entries.get("door")?.win.getBounds();
  const point = windowPoint(role.id, "sprite");
  const entry = createWindow(
    role.id,
    "sprite",
    door ? { x: door.x - 36, y: door.y - 27 } : point,
  );
  entry.win.once("ready-to-show", () => animateTo(entry, point));
}

function hideAll() {
  hidden = true;
  clearObservation();
  framework?.sync();
  bodyInputAfter = Date.now();
  body.clear("hidden");
  stopLocalMotion();
  for (const { win } of entries.values()) win.hide();
  updatePointerPolling();
}

function animateHome(role) {
  const entry = entries.get(role.id);
  if (entry && !entry.departing) {
    body.stop(role.id, "inactive");
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
  nativeControl?.update(value, action);
  if (value.closed) {
    body.clear("inactive");
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
  const browserControl = value.room?.browserControl;
  if (value.room && value.room.roomEpoch !== lastBrowserGrant?.roomEpoch)
    lastBrowserGrant = undefined;
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
    observation: screenCaptureSupported &&
      value.room?.observation && {
        ...value.room.observation,
        target: observationGrant?.source.name,
      },
    nativeControl: nativeControl ? value.room?.nativeControl : undefined,
    browserControl: browserControl && {
      ...browserControl,
      grantedOrigin:
        browserControl.grantedAgentId === lastBrowserGrant?.agentId
          ? lastBrowserGrant?.origin
          : undefined,
    },
  };
  room.members = Object.fromEntries(roles.map(({ id, state }) => [id, state]));
  room.bubbles = { ...state.bubbles };
  room.turn = state.thinking ? { actor: state.thinking } : null;
  syncLive();
  body.update(value, action);
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

function updatePointerPolling() {
  const needed =
    !hidden &&
    !desktopLocked &&
    [...entries.values()].some(
      ({ type, win }) =>
        type !== "panel" && !win.isDestroyed() && win.isVisible(),
    );
  if (needed && !pointerTimer) {
    updatePointerRegions();
    pointerTimer = setInterval(updatePointerRegions, 32);
  } else if (!needed && pointerTimer) {
    clearInterval(pointerTimer);
    pointerTimer = undefined;
  }
}

function updatePointerRegions() {
  if (hidden || desktopLocked) return;
  const { x, y } = screen.getCursorScreenPoint();
  for (const entry of entries.values()) {
    const { win, type, id } = entry;
    if (
      type === "panel" ||
      entry.departing ||
      win.isDestroyed() ||
      !win.isVisible()
    )
      continue;
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
    entry.bodyInputAfter = Date.now();
    if (framework && entry.type === "sprite") {
      manuallyMoved.add(entry.id);
      framework.sync();
    }
    if (entry.type === "door") {
      bodyInputAfter = entry.bodyInputAfter;
      body.clear("manual-control");
    } else body.stop(entry.id, "manual-control");
    stopMovement(entry);
    entry.drag = { x, y, mouseX: data.x, mouseY: data.y };
  } else if (entry.drag) {
    const from = entry.drag;
    const target = clampPoint(
      {
        x: from.x + data.x - from.mouseX,
        y: from.y + data.y - from.mouseY,
      },
      ...sizes[entry.type],
    );
    entry.win.setPosition(target.x, target.y);
    if (action === "drag-end") {
      entry.drag = null;
      entry.bodyInputAfter = Date.now();
      if (framework && entry.type === "sprite") {
        manuallyMoved.add(entry.id);
        framework.sync();
      }
      if (entry.type === "door") {
        bodyInputAfter = entry.bodyInputAfter;
        doorPosition = target;
      } else positions[entry.id] = target;
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

function localLabel(value) {
  return value.replace(/[\p{Cc}\p{Cf}]/gu, "").slice(0, 90);
}

function desktopSourceMenu(win, availableRoles, sources, label) {
  return new Promise((resolve) => {
    let selection;
    const menu = Menu.buildFromTemplate(
      availableRoles.map(({ id, name }) => ({
        label: localLabel(name).replaceAll("&", "&&"),
        submenu: sources.map((source) => ({
          label: localLabel(label(source)).replaceAll("&", "&&"),
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

async function chooseScreenGrant(event, observe = false) {
  const entry = entries.get("panel");
  const win = entry?.win;
  const { roomEpoch } = remoteState ?? {};
  const policyKey = observe ? "observation" : "screenView";
  const command = observe ? "observation" : "screen";
  const screenView = remoteState?.[policyKey];
  if (
    !screenCaptureSupported ||
    !framework ||
    !roomEpoch ||
    !screenView ||
    !win ||
    win.webContents !== event.sender ||
    event.senderFrame !== win.webContents.mainFrame ||
    !win.isFocused() ||
    choosingDesktopPermission
  )
    return "unavailable";
  if (screenView.grantedAgentId) {
    const grant = observe ? lastObservationGrant : lastScreenGrant;
    clearScreenGrant(observe);
    try {
      if (
        grant?.roomEpoch !== roomEpoch ||
        grant.agentId !== screenView.grantedAgentId
      )
        return "unavailable";
      choosingDesktopPermission = true;
      const room = await framework.command(command + "-revoke", {
        roomEpoch,
        grantId: grant.grantId,
      });
      return room?.[policyKey]?.grantedAgentId ? "failed" : "revoked";
    } catch {
      return "failed";
    } finally {
      choosingDesktopPermission = false;
    }
  }
  choosingDesktopPermission = true;
  try {
    if (process.platform === "darwin") {
      const status = systemPreferences.getMediaAccessStatus("screen");
      if (status === "denied" || status === "restricted") return "permission";
    }
    let sources = await listScreenSources();
    if (observe) {
      const own = new Set(
        BrowserWindow.getAllWindows().map((window) =>
          window.getMediaSourceId(),
        ),
      );
      sources = sources.filter(
        ({ id }) => id.startsWith("window:") && !own.has(id),
      );
    }
    if (
      process.platform === "darwin" &&
      systemPreferences.getMediaAccessStatus("screen") !== "granted"
    )
      return "permission";
    if (win.isDestroyed() || !win.isFocused()) return "cancelled";
    if (!sources.length) return "no-sources";
    const eligible = roles.filter(({ id }) => screenView.eligible.includes(id));
    if (!eligible.length) return "unavailable";
    const selection = await desktopSourceMenu(
      win,
      eligible,
      sources,
      ({ id, name }) =>
        `${id.startsWith("screen:") ? "显示器" : "窗口"} · ${name}`,
    );
    if (!selection || win.isDestroyed() || !win.isVisible()) return "cancelled";
    if (
      remoteState?.roomEpoch !== roomEpoch ||
      remoteState?.[policyKey]?.grantedAgentId ||
      !remoteState?.[policyKey]?.eligible.includes(selection.agentId)
    )
      return "unavailable";
    const grant = {
      ...selection,
      ...(observe && { expiresAt: Date.now() + 15 * 60_000 }),
      roomEpoch,
      grantId: randomUUID(),
      pending: true,
    };
    const identity = {
      roomEpoch,
      grantId: grant.grantId,
      agentId: grant.agentId,
    };
    if (observe) {
      observationGrant = grant;
      lastObservationGrant = identity;
    } else {
      screenGrant = grant;
      lastScreenGrant = identity;
    }
    const current = () => (observe ? observationGrant : screenGrant) === grant;
    try {
      const room = await framework.command(command + "-grant", {
        roomEpoch,
        grantId: grant.grantId,
        agentId: grant.agentId,
      });
      grant.pending = false;
      if (observe && room?.observation?.expiresAt)
        grant.expiresAt = Math.min(grant.expiresAt, room.observation.expiresAt);
      if (
        current() &&
        room?.roomEpoch === roomEpoch &&
        room[policyKey]?.grantedAgentId === grant.agentId
      )
        return "granted";
      if (current()) clearScreenGrant(observe);
      return "unavailable";
    } catch {
      if (current()) clearScreenGrant(observe);
      return "failed";
    }
  } catch {
    return "failed";
  } finally {
    choosingDesktopPermission = false;
  }
}
ipcMain.handle("room:screen-view", (event) => chooseScreenGrant(event));
ipcMain.handle("room:observation", (event) => chooseScreenGrant(event, true));

ipcMain.handle("room:native-control", async (event) => {
  const win = entries.get("panel")?.win;
  const { nativeControl: policy, roomEpoch } = remoteState ?? {};
  if (
    !framework ||
    !nativeControl ||
    !roomEpoch ||
    !policy ||
    !win ||
    win.webContents !== event.sender ||
    event.senderFrame !== win.webContents.mainFrame ||
    !win.isFocused() ||
    choosingDesktopPermission
  )
    return "unavailable";
  choosingDesktopPermission = true;
  try {
    if (policy.grantedAgentId)
      return await nativeControl.revoke(roomEpoch, policy.grantedAgentId);
    let eligible = roles.filter(({ id }) => policy.eligible.includes(id));
    if (!eligible.length) return "unavailable";
    let windows;
    try {
      windows = await nativeDriver.listWindows({
        signal: AbortSignal.timeout(4000),
      });
    } catch (error) {
      if (
        process.platform !== "darwin" ||
        !["DESKTOP_NATIVE_TIMEOUT", "DESKTOP_NATIVE_CANCELLED"].includes(
          error?.message,
        )
      )
        throw error;
      // A stalled global AX inventory need not prevent a scoped app lookup.
      const applications = (
        await nativeDriver.listApplications({
          signal: AbortSignal.timeout(4000),
        })
      ).filter(({ pid }) => pid !== process.pid);
      if (win.isDestroyed() || !win.isFocused()) return "cancelled";
      if (!applications.length) return "no-sources";
      const selected = await desktopSourceMenu(
        win,
        eligible,
        applications,
        ({ app }) => app,
      );
      if (!selected || win.isDestroyed() || !win.isVisible())
        return "cancelled";
      eligible = eligible.filter(({ id }) => id === selected.agentId);
      windows = await nativeDriver.listWindows({
        application: selected.source,
        signal: AbortSignal.timeout(4000),
      });
    }
    const sources = windows.filter(({ pid }) => pid !== process.pid);
    if (win.isDestroyed() || !win.isFocused()) return "cancelled";
    if (!sources.length) return "no-sources";
    const selection = await desktopSourceMenu(
      win,
      eligible,
      sources,
      ({ app, title }) => `${app} · ${title}`,
    );
    if (!selection || win.isDestroyed() || !win.isVisible()) return "cancelled";
    if (
      selection.source.pid === process.pid ||
      remoteState?.roomEpoch !== roomEpoch ||
      remoteState?.nativeControl?.grantedAgentId ||
      !remoteState?.nativeControl?.eligible.includes(selection.agentId)
    )
      return "unavailable";
    return await nativeControl.grant({ ...selection, roomEpoch });
  } catch (error) {
    return error?.message === "DESKTOP_NATIVE_PERMISSION"
      ? "permission"
      : "failed";
  } finally {
    choosingDesktopPermission = false;
  }
});

ipcMain.handle("room:browser-control", async (event, selection) => {
  const win = entries.get("panel")?.win;
  const { browserControl: policy, roomEpoch } = remoteState ?? {};
  if (
    !framework ||
    !roomEpoch ||
    !policy ||
    !win ||
    win.webContents !== event.sender ||
    event.senderFrame !== win.webContents.mainFrame ||
    !win.isFocused() ||
    choosingDesktopPermission
  )
    return "unavailable";
  choosingDesktopPermission = true;
  try {
    if (selection === undefined && policy.grantedAgentId) {
      const grant = lastBrowserGrant;
      if (
        grant?.roomEpoch !== roomEpoch ||
        grant.agentId !== policy.grantedAgentId
      )
        return "unavailable";
      const room = await framework.command("browser-revoke", {
        roomEpoch,
        grantId: grant.grantId,
      });
      if (room?.browserControl?.grantedAgentId) return "failed";
      lastBrowserGrant = undefined;
      return "revoked";
    }
    const agent = roles.find(({ id }) => id === selection?.agentId);
    if (policy.grantedAgentId || !agent || !policy.eligible.includes(agent.id))
      return "unavailable";
    const origin = parseBrowserOrigin(selection.origin);
    if (!origin) return "invalid";
    const confirmed = await dialog.showMessageBox(win, {
      type: "question",
      title: "授权隔离浏览器",
      message: `允许 ${localLabel(agent.name)} 访问此站点？`,
      detail: origin,
      buttons: ["取消", "授权"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (confirmed.response !== 1 || win.isDestroyed() || !win.isVisible())
      return "cancelled";
    if (
      remoteState?.roomEpoch !== roomEpoch ||
      remoteState?.browserControl?.grantedAgentId ||
      !remoteState?.browserControl?.eligible.includes(agent.id)
    )
      return "unavailable";
    const grant = {
      roomEpoch,
      grantId: randomUUID(),
      agentId: agent.id,
      origin,
    };
    lastBrowserGrant = grant;
    const room = await framework.command("browser-grant", grant);
    return room?.roomEpoch === roomEpoch &&
      room.browserControl?.grantedAgentId === agent.id
      ? "granted"
      : "unavailable";
  } catch {
    return "failed";
  } finally {
    choosingDesktopPermission = false;
  }
});

function controlResident(id, action) {
  const entry = entries.get(id);
  if (
    room.members[id] !== "here" ||
    entry?.type !== "sprite" ||
    entry.departing ||
    entry.drag ||
    entry.win.isDestroyed() ||
    !entry.win.isVisible() ||
    hidden ||
    desktopLocked
  )
    return;
  entry.bodyInputAfter = Date.now();
  body.stop(id, "manual-control");
  stopMovement(entry);
  if (framework) {
    manuallyMoved.add(id);
    framework.sync();
  }
  if (action === "body-seat") animateTo(entry, windowPoint(id, "sprite"));
}

ipcMain.on("room:action", (event, action, data) => {
  const entry = [...entries.values()].find(
    ({ win }) => win.webContents === event.sender,
  );
  if (!entry || entry.departing) return;
  if (live) live.tick();
  else if (refreshIfDue(room)) update();
  if (
    entry.type !== "panel" &&
    ["drag-start", "drag-move", "drag-end"].includes(action)
  ) {
    handleDrag(entry, action, data);
    return;
  }
  if (entry.type === "door") {
    if (action === "open") showPanel("visits");
    return;
  }
  if (entry.type === "sprite") {
    if (action === "motion-preference" && typeof data === "boolean") {
      entry.reducedMotion = data;
      return;
    }
    const role = roles.find(({ id }) => id === entry.id);
    if (action === "open") showPanel("chat");
    if (action === "menu") {
      Menu.buildFromTemplate([
        { label: "打开聊天", click: () => showPanel("chat") },
        {
          label: "坐回默认位置",
          click: () => {
            entry.bodyInputAfter = Date.now();
            body.stop(role.id, "manual-control");
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
    return;
  }
  const role = roles.find(({ id }) => id === data);
  if (["body-stop", "body-seat"].includes(action)) {
    if (
      event.senderFrame === entry.win.webContents.mainFrame &&
      entry.win.isFocused() &&
      role
    )
      controlResident(role.id, action);
    return;
  }
  if (framework) {
    if (action === "close") entry.win.hide();
    else if (
      [
        "invite",
        "leave",
        "send",
        "door-mode",
        "knock-answer",
        "activity-pause",
      ].includes(action)
    ) {
      if (action === "leave" && role) body.stop(role.id, "inactive");
      framework.act(action, data);
    }
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
    clearScreenGrant(true);
    body.clear("inactive");
    clearScreenGrant();
    nativeControl?.clear();
    void Promise.allSettled([
      (framework ?? live).close(),
      nativeDriver?.close(),
    ]).then(() => app.quit());
  });
  app.whenReady().then(() => {
    if (process.platform === "darwin") app.setActivationPolicy("accessory");
    for (const event of [
      "display-added",
      "display-removed",
      "display-metrics-changed",
    ])
      screen.on(event, restoreWindowLayout);
    powerMonitor.on("lock-screen", () => {
      desktopLocked = true;
      clearObservation();
      framework?.sync();
      body.clear("hidden");
      stopLocalMotion();
      updatePointerPolling();
    });
    powerMonitor.on("unlock-screen", () => {
      desktopLocked = false;
      bodyInputAfter = Date.now();
      for (const entry of entries.values()) updateMotion(entry);
      updatePointerPolling();
    });
    powerMonitor.on("suspend", () => {
      desktopLocked = true;
      clearObservation();
      framework?.sync();
      body.clear("hidden");
      stopLocalMotion();
      updatePointerPolling();
    });
    powerMonitor.on("resume", () => {
      desktopLocked = powerMonitor.getSystemIdleState(1) === "locked";
      bodyInputAfter = Date.now();
      restoreWindowLayout();
      for (const entry of entries.values()) updateMotion(entry);
      updatePointerPolling();
    });
    if (frameworkRoot) {
      roles = [];
      framework = createFrameworkClient(
        frameworkRoot,
        applyFramework,
        frameworkPort,
        () => {
          const dragged = [...manuallyMoved].slice(0, 24);
          for (const id of dragged) manuallyMoved.delete(id);
          return {
            visible:
              !hidden &&
              !desktopLocked &&
              [...entries.values()].some(
                ({ type, win }) =>
                  type === "sprite" && !win.isDestroyed() && win.isVisible(),
              ),
            dragged,
          };
        },
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
    setInterval(() => {
      if (live) live.tick();
      else if (!framework && refreshIfDue(room)) update();
    }, 500);
  });
}
