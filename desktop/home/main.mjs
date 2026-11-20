import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  net,
  protocol,
  powerMonitor,
  screen,
  systemPreferences,
  Tray,
} from "electron";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { managedDesktopExecutable } from "../../src/home/desktop-dependencies.mjs";
import {
  clampToWorkArea,
  desktopBodyBounds,
  spriteWindowSize,
  restoreWindowPoint,
} from "./window-placement.mjs";
import { parseBrowserOrigin } from "./browser-origin.mjs";
import {
  createPreferencesStore,
  validSpriteSize,
  validIdleFrequency,
  readDesktopPreferences,
  writeDesktopPreferences,
} from "./preferences.mjs";
import { createScreenRequests } from "./screen-requests.mjs";
import { createObservationController } from "./observation-controller.mjs";
import { createObservationTargets } from "./observation-targets.mjs";
import { desktopResourcePath } from "./resource-protocol.mjs";
import { createWindowManager } from "./window-manager.mjs";
import { createWindowMotion } from "./window-motion.mjs";
import { createBodyActions } from "./body-actions.mjs";
import { createDesktopSnapshot } from "./snapshot.mjs";
import {
  createDesktopCaptureHandler,
  createFullDesktopCapture,
} from "./full-desktop-capture.mjs";
import { createOwnerInput } from "./owner-input.mjs";
import { createPointerController } from "./pointer-controller.mjs";
import { createFrameworkStateController } from "./framework-state-controller.mjs";
import { startDesktopLifecycle } from "./lifecycle.mjs";
import { createWindowTasks } from "./window-tasks.mjs";
import { registerActionIpc } from "./action-ipc.mjs";
import { createWindowView } from "./window-view.mjs";
import { registerFollowIpc } from "./follow-ipc.mjs";
import { createCompanionController } from "./companion-controller.mjs";
import { createLocalRoomActions } from "./local-room-actions.mjs";
import { createIpcRouter } from "./ipc-router.mjs";
import { registerRoomIpc } from "./room-ipc.mjs";
import { registerPersonalIpc } from "./personal-ipc.mjs";
import { registerReadGrantsIpc } from "./read-grants-ipc.mjs";
import { registerWindowObservationIpc } from "./window-observation-ipc.mjs";
import { registerNativeControlIpc } from "./native-control-ipc.mjs";
import { createBrowserControlHandler } from "./browser-control-handler.mjs";
import { createObservationReviewHandler } from "./observation-review-handler.mjs";
import { DesktopBodyClient } from "./body-client.mjs";
import {
  DesktopExclusionStore,
  DesktopSpace,
  displayFingerprint,
} from "./space.mjs";
import { createSpaceEditor } from "./space-editor.mjs";
import { DesktopFollow, geometryFailure } from "./follow.mjs";
import { createFrameworkClient } from "./framework-client.mjs";
import { NativeControlClient } from "./native-control-client.mjs";
import { createNativeDesktopDriver } from "./native-desktop-driver.mjs";
import { LiveRoom } from "./live-room.mjs";
import { startModelClient } from "./model-client.mjs";
import {
  captureScreenSource,
  listScreenSources,
  screenCapturePermission,
  screenCaptureSupported,
} from "./screen-capture.mjs";
import {
  observationDisplayTarget,
  observationSources,
} from "./screen-source.mjs";
import {
  DEFAULT_MINUTES,
  MAX_TURNS,
  createRoom,
  refreshIfDue,
  roles as prototypeRoles,
} from "./room.mjs";

protocol.registerSchemesAsPrivileged([
  { scheme: "nest", privileges: { standard: true, secure: true } },
]);

const source = fileURLToPath(new URL(".", import.meta.url));
const trialProfile = process.env.DESKTOP_HOME_TRIAL_PROFILE;
if (trialProfile) app.setPath("userData", trialProfile);
const preferences = createPreferencesStore(app.getPath("userData"));
const {
  saved,
  spriteSize: initialSpriteSize,
  idleFrequency: initialIdleFrequency,
  positions,
  places,
  doorPosition: initialDoorPosition,
  selectedMode: initialMode,
  blockedApplications: initialBlockedApplications,
} = readDesktopPreferences(preferences);
const verifiedWindowSurface = process.platform === "darwin";
const petPreferences = {
  spriteSize: initialSpriteSize,
  idleFrequency: initialIdleFrequency,
};
let selectedMode = initialMode;
let blockedApplications = initialBlockedApplications;
let syncingMode;
let doorPosition = initialDoorPosition;
const validInterval = (value) =>
  Number.isInteger(value) && value >= 0 && value <= 1440;
let roles = prototypeRoles;
const room = createRoom(
  validInterval(saved.minutes) ? saved.minutes : DEFAULT_MINUTES,
);
const entries = new Map();
const bubbles = new Map();
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
const screenGrants = new Map();
let screenPicker;
let batchScreenGrants = false;
let approachedWindowTask;
let localWindowTaskStatus;
const windowGrants = new Map();
const displayGrants = new Map();
let displayObservation = false;
let displayPicker;
let choosingDesktopPermission = false;
let lastBrowserGrant;
let desktopLocked = false;
let bodyInputAfter = 0;
const manuallyMoved = new Set();
const manualTouches = new Map();
const ownerInput = createOwnerInput();
const desktopCapture = createDesktopCaptureHandler({
  available: () => screenCaptureSupported,
  blocked: () => desktopLocked,
  capture: createFullDesktopCapture({
    getDisplays: () => screen.getAllDisplays(),
    getSources: (options) => desktopCapturer.getSources(options),
    permission: () =>
      process.platform === "darwin"
        ? systemPreferences.getMediaAccessStatus("screen")
        : "granted",
  }),
  send: (data, current) =>
    framework.result("desktop-capture-result", data, current),
});
let bodyProtocol = false;
let bodyCrossDisplay = false;
let bodyInteractions = false;
let bodyWindowApproach = false;
let publicPerception = false;
let observationProtocol = false;
let recoveryPositionPending = false;
let observationEnded;
const exclusions = new DesktopExclusionStore(
  join(app.getPath("userData"), "desktop-exclusions.json"),
);
const space = new DesktopSpace({
  displays: () => screen.getAllDisplays(),
  displayAt: (bounds) => screen.getDisplayMatching(bounds),
  door: () => visibleBounds(entries.get("door")),
  residents: () =>
    [...entries.values()].flatMap((entry) => {
      const bounds = entry.type === "sprite" && visibleBounds(entry);
      return bounds
        ? [
            {
              id: entry.id,
              name: roles.find(({ id }) => id === entry.id)?.name,
              visit: entry.bodyVisit,
              bounds,
              facing: entry.facing ?? "right",
              pose: entry.pose ?? "sit",
              action: entry.bodyAction,
              privatePosition: entry.privatePosition,
            },
          ]
        : [];
    }),
  seat: (id) => windowPoint(id, "sprite"),
  zones: () => exclusions.list(),
  bodyBounds: (type, bounds) =>
    desktopBodyBounds(type, bounds, petPreferences.spriteSize),
});
const spaceEditor = createSpaceEditor({
  screen,
  store: exclusions,
  changed: () => {
    space.invalidate();
    bodyInputAfter = Date.now();
    body.clear("stale-layout");
    follow.stop("stale-layout");
    for (const entry of entries.values()) stopLocalSeat(entry, "stale-layout");
  },
});

function visibleBounds(entry) {
  return entry && !entry.departing && windowVisible(entry)
    ? entry.win.getBounds()
    : undefined;
}
function windowVisible({ win, pageVisible }) {
  return (
    !win.isDestroyed() &&
    win.isVisible() &&
    !win.isMinimized() &&
    pageVisible !== false
  );
}

const body = new DesktopBodyClient({
  claim: (data, current) => framework.result("body-claim", data, current),
  result: (data, current) => framework.result("body-result", data, current),
  execute: (request, current, finish) =>
    pointerController.executeBody(request, current, finish, (settle) =>
      executeVerifiedBodyAction(request, current, settle),
    ),
  position: (id) => (entries.get(id)?.privatePosition ? {} : bodyPosition(id)),
});
const nativeExecutable =
  screenCaptureSupported &&
  (process.env.QQ_AGENTS_AGENT_DESKTOP_EXECUTABLE ||
    managedDesktopExecutable(frameworkRoot, "agent-desktop"));
const nativeDriver = screenCaptureSupported
  ? createNativeDesktopDriver({ executable: nativeExecutable })
  : null;
const observationDriver = nativeExecutable
  ? createNativeDesktopDriver({ executable: nativeExecutable })
  : null;
const geometryDriver = nativeExecutable
  ? createNativeDesktopDriver({ executable: nativeExecutable })
  : null;
const nativeControl = nativeDriver
  ? new NativeControlClient(nativeDriver, {
      command: (action, data) =>
        action === "native-revoke"
          ? framework.authorization(action, data)
          : framework.command(action, data),
      claim: (data, isCurrent) =>
        framework.result("native-claim", data, isCurrent),
      result: (data, isCurrent) =>
        framework.result("native-result", data, isCurrent),
      verifyTarget: verifyApproachedWindow,
      verifyGrant: verifyNativeGrant,
    })
  : null;

async function windowGeometry(source, { signal } = {}) {
  if (!geometryDriver || !source || source.pid === process.pid) return null;
  const result = await geometryDriver.windowGeometry(source, { signal });
  if (!result) return null;
  const { x, y, width, height } = result.bounds;
  const rounded = {
    x: Math.floor(x),
    y: Math.floor(y),
    width: Math.ceil(x + width) - Math.floor(x),
    height: Math.ceil(y + height) - Math.floor(y),
  };
  const bounds =
    process.platform === "win32"
      ? screen.screenToDipRect(null, rounded)
      : rounded;
  return bounds.width > 0 && bounds.height > 0 ? { bounds } : null;
}

async function verifyNativeGrant(grant, signal) {
  if (grant.unified) return !signal.aborted && !deniedWindow(grant.source);
  const current = () =>
    !signal.aborted &&
    permissionRevision("control") !== undefined &&
    deniedWindow(grant.source) === false;
  if (!current()) return false;
  const revoke = () => {
    if (current())
      void nativeControl.revoke(grant.roomEpoch, grant.agentId).catch(() => {});
    return false;
  };
  try {
    if (!(await windowGeometry(grant.source, { signal }))) return revoke();
    return (
      current() &&
      (await captureCoverage(
        { targetId: grant.source.id, pid: grant.source.pid },
        signal,
      )) &&
      current()
    );
  } catch (error) {
    return error?.message === "DESKTOP_NATIVE_PERMISSION" ? revoke() : false;
  }
}

function followBlocked({ entry, roomEpoch, visitId }) {
  if (!remoteState?.connected) return "disconnect";
  const role = remoteState.roles.find(({ id }) => id === entry.id);
  if (
    !role ||
    entries.get(entry.id) !== entry ||
    role.state !== "here" ||
    !visitId ||
    role.bodyVisitId !== visitId ||
    remoteState.roomEpoch !== roomEpoch ||
    entry.departing ||
    shuttingDown
  )
    return "inactive";
  if (hidden || desktopLocked || !windowVisible(entry)) return "hidden";
  if (entry.drag || entries.get("door")?.drag) return "manual-control";
  if (role.bodyStatus?.state === "qq") return "follow-qq";
  if (
    !remoteState.interactionsAvailable ||
    !role.bodyControlAvailable ||
    role.bodyStatus?.state === "paused"
  )
    return "follow-permission";
}

const follow = new DesktopFollow({
  blocked: followBlocked,
  display: (bounds) => screen.getDisplayMatching(bounds).id,
  readWindow: async (source, signal) =>
    (
      await windowGeometry(source, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(2500)]),
      })
    )?.bounds,
  move: ({ entry, mode, until }, bounds, current, fail) => {
    let done = false;
    const cancel = moveResident(
      entry,
      { target: { type: mode, bounds } },
      {
        current,
        expiresAt: until,
        crossDisplay: false,
        local: true,
        duration: mode === "pointer" ? 325 : 525,
        finish: () => {
          done = true;
        },
        fail: (reason) => {
          done = true;
          fail(reason);
        },
      },
    );
    return () => {
      if (!done) cancel?.();
    };
  },
  changed: (entry, reason) => {
    if (reason) recordBodyFeedback(entry, reason);
    else {
      entry.bodyFeedback = undefined;
      update();
    }
  },
});

function activeFollow(entry) {
  return Boolean(entry && follow.active(entry));
}

const {
  permissionRevision,
  syncCompanionMode,
  clearVisualPermissions,
  stopCompanionControl,
  invalidatePermissions,
  deniedWindow,
  register: registerCompanionIpc,
} = createCompanionController({
  context: {
    get remoteState() {
      return remoteState;
    },
    get framework() {
      return framework;
    },
    get nativeControl() {
      return nativeControl;
    },
    get desktopLocked() {
      return desktopLocked;
    },
    get hidden() {
      return hidden;
    },
    get shuttingDown() {
      return shuttingDown;
    },
    get syncingMode() {
      return syncingMode;
    },
    set syncingMode(value) {
      syncingMode = value;
    },
    get selectedMode() {
      return selectedMode;
    },
    set selectedMode(value) {
      selectedMode = value;
    },
    get blockedApplications() {
      return blockedApplications;
    },
    set blockedApplications(value) {
      blockedApplications = value;
    },
    get screenPicker() {
      return screenPicker;
    },
    set screenPicker(value) {
      screenPicker = value;
    },
    get displayPicker() {
      return displayPicker;
    },
    set displayPicker(value) {
      displayPicker = value;
    },
    get lastBrowserGrant() {
      return lastBrowserGrant;
    },
    set lastBrowserGrant(value) {
      lastBrowserGrant = value;
    },
  },
  clearScreenGrant: (...args) => clearScreenGrant(...args),
  displayGrants,
  removeObservation: (...args) => removeObservation(...args),
  stopLocalWindowTask,
  savePreferences,
  update,
});

const {
  ownScreenSources,
  observationError,
  captureCoverage,
  readDisplayTarget,
  readObservationTarget,
} = createObservationTargets({
  screen,
  BrowserWindow,
  observationDriver,
  deniedWindow,
  listScreenSources,
  screenCapturePermission,
});

const {
  clearScreenGrant,
  clearManualScreen,
  localScreen,
  stopObservation,
  localObservation,
  observationCurrent,
  probeObservation,
  reportObservationState,
  monitorObservation,
  removeObservation,
  clearObservation,
  verifyObservationRequest,
} = createObservationController({
  context: {
    get screenCapture() {
      return screenRequests.active;
    },
    get hidden() {
      return hidden;
    },
    get desktopLocked() {
      return desktopLocked;
    },
    get shuttingDown() {
      return shuttingDown;
    },
    get framework() {
      return framework;
    },
    set observationEnded(value) {
      observationEnded = value;
    },
    set displayPicker(value) {
      displayPicker = value;
    },
  },
  screenGrants,
  windowGrants,
  displayGrants,
  body,
  permissionRevision,
  readDisplayTarget,
  readObservationTarget,
  update,
});

const windowTasks = createWindowTasks({
  nativeControl,
  screenGrants,
  screenCapturePermission,
  entries,
  activeFollow,
  windowVisible,
  windowGeometry,
  stopLocalSeat: (...args) => stopLocalSeat(...args),
  moveResident,
  context: {
    get screenCapture() {
      return screenRequests.active;
    },
    get remoteState() {
      return remoteState;
    },
    get hidden() {
      return hidden;
    },
    get desktopLocked() {
      return desktopLocked;
    },
    get shuttingDown() {
      return shuttingDown;
    },
    get approachedWindowTask() {
      return approachedWindowTask;
    },
    set approachedWindowTask(value) {
      approachedWindowTask = value;
    },
    get bodyInputAfter() {
      return bodyInputAfter;
    },
  },
});
function windowTaskGrant(...args) {
  return windowTasks.windowTaskGrant(...args);
}
function controllableResident(...args) {
  return windowTasks.controllableResident(...args);
}
function stopLocalWindowTask(...args) {
  return windowTasks.stopLocalWindowTask(...args);
}
function verifyApproachedWindow(...args) {
  return windowTasks.verifyApproachedWindow(...args);
}
function sameRectangle(...args) {
  return windowTasks.sameRectangle(...args);
}
function executeWindowTask(...args) {
  return windowTasks.executeWindowTask(...args);
}

const screenRequests = createScreenRequests({
  context: {
    get framework() {
      return framework;
    },
    get hidden() {
      return hidden;
    },
    get desktopLocked() {
      return desktopLocked;
    },
    get shuttingDown() {
      return shuttingDown;
    },
  },
  screenGrants,
  windowGrants,
  displayGrants,
  removeObservation,
  clearManualScreen,
  localObservation,
  localScreen,
  permissionRevision,
  observationCurrent,
  probeObservation,
  verifyApproachedWindow,
  readDisplayTarget,
  readObservationTarget,
  captureScreenSource,
  reportObservationState,
});
const screenRequest = screenRequests.handle;

function savePreferences() {
  writeDesktopPreferences(preferences, {
    ...petPreferences,
    minutes: room.minutes,
    positions,
    doorPosition,
    selectedMode,
    blockedApplications,
    places,
  });
}

const desktopSnapshot = createDesktopSnapshot({
  MAX_TURNS,
  DEFAULT_MINUTES,
  room,
  places,
  screen,
  displayFingerprint,
  entries,
  clampPoint,
  screenGrants,
  windowTaskGrant,
  permissionRevision,
  verifiedWindowSurface,
  geometryDriver,
  visibleBounds,
  activeFollow,
  follow,
  context: {
    get sizes() {
      return sizes;
    },
    get frameworkRoot() {
      return frameworkRoot;
    },
    get remoteState() {
      return remoteState;
    },
    get liveRoot() {
      return liveRoot;
    },
    get live() {
      return live;
    },
    get roles() {
      return roles;
    },
    get hidden() {
      return hidden;
    },
    get desktopLocked() {
      return desktopLocked;
    },
    get localWindowTaskStatus() {
      return localWindowTaskStatus;
    },
    get observationProtocol() {
      return observationProtocol;
    },
    get selectedMode() {
      return selectedMode;
    },
    get syncingMode() {
      return syncingMode;
    },
    get blockedApplications() {
      return blockedApplications;
    },
    get observationEnded() {
      return observationEnded;
    },
  },
});
function snapshot(...args) {
  return desktopSnapshot.snapshot(...args);
}
function savedPlace(...args) {
  return desktopSnapshot.savedPlace(...args);
}

function recordBodyFeedback(entry, reason) {
  entry.bodyFeedback = { reason, at: Date.now() };
  const panel = entries.get("panel");
  if (panel?.ready) send(panel, "room:update", snapshot(true));
}

function send(entry, channel, value) {
  if (entry?.ready && !entry.win.isDestroyed())
    entry.win.webContents.send(channel, value);
}

function update() {
  if (
    personal.selection &&
    !personal.personalTarget(
      personal.selection.agentId,
      personal.selection.roomEpoch,
      personal.selection.visitId,
    )
  )
    personal.clearSelection();
  const data = snapshot();
  for (const entry of entries.values()) {
    send(entry, "room:update", entry.type === "panel" ? snapshot(true) : data);
    updateMotion(entry);
  }
}

const sizes = {
  door: [100, 118],
  panel: [430, 574],
  sprite: spriteWindowSize(petPreferences.spriteSize),
};

const windowView = createWindowView({
  screen,
  positions,
  sizes,
  clampToWorkArea,
  restoreWindowPoint,
  entries,
  clearOwnerDrag: (entry) => pointerController.clearOwnerDrag(entry),
  createWindow: (...args) => createWindow(...args),
  send,
  snapshot,
  updatePointerPolling,
  windowVisible,
  follow,
  stopLocalWindowTask,
  body,
  stopLocalSeat: (...args) => stopLocalSeat(...args),
  stopMovement: (...args) => stopMovement(...args),
  reportSpeed: (...args) => reportSpeed(...args),
  spaceEditor,
  space,
  updatePointerRegions,
  visibleBounds,
  animateTo: (...args) => animateTo(...args),
  invalidatePermissions,
  context: {
    get roles() {
      return roles;
    },
    get doorPosition() {
      return doorPosition;
    },
    get hidden() {
      return hidden;
    },
    set hidden(value) {
      hidden = value;
    },
    get desktopLocked() {
      return desktopLocked;
    },
    get framework() {
      return framework;
    },
    get bodyInputAfter() {
      return bodyInputAfter;
    },
    set bodyInputAfter(value) {
      bodyInputAfter = value;
    },
    get publicPerception() {
      return publicPerception;
    },
    get remoteState() {
      return remoteState;
    },
  },
});
function clampPoint(...args) {
  return windowView.clampPoint(...args);
}
function windowPoint(...args) {
  return windowView.windowPoint(...args);
}
function showDoor(...args) {
  return windowView.showDoor(...args);
}
function showPanel(...args) {
  return windowView.showPanel(...args);
}
function schedulePositionReport(...args) {
  return windowView.schedulePositionReport(...args);
}
function windowVisibilityChanged(...args) {
  return windowView.windowVisibilityChanged(...args);
}
function updateMotion(...args) {
  return windowView.updateMotion(...args);
}
function stopLocalMotion(...args) {
  return windowView.stopLocalMotion(...args);
}
function restoreWindowLayout(...args) {
  return windowView.restoreWindowLayout(...args);
}
function publicSpace(...args) {
  return windowView.publicSpace(...args);
}
function bodyPosition(...args) {
  return windowView.bodyPosition(...args);
}
function showSprite(...args) {
  return windowView.showSprite(...args);
}
function hideAll(...args) {
  return windowView.hideAll(...args);
}
function animateHome(...args) {
  return windowView.animateHome(...args);
}

const createWindow = createWindowManager({
  BrowserWindow,
  source,
  sizes,
  clampPoint,
  entries,
  send,
  snapshot,
  updateMotion,
  updatePointerPolling,
  windowVisibilityChanged,
  isHidden: () => hidden,
  onClosed(entry) {
    follow.stop("inactive", entry);
    body.stop(entry.id, "inactive");
    stopLocalSeat(entry, "inactive");
    stopMovement(entry);
  },
});

const { reportSpeed, stopMovement, stopLocalSeat, animateTo } =
  createWindowMotion({
    context: {
      get hidden() {
        return hidden;
      },
      get desktopLocked() {
        return desktopLocked;
      },
    },
    sizes,
    clampPoint,
    send,
    schedulePositionReport,
    updateMotion,
    windowVisible,
  });

const bodyActions = createBodyActions({
  executeWindowTask,
  localObservation,
  observationCurrent,
  probeObservation,
  reportObservationState,
  controllableResident,
  windowGrants,
  stopLocalSeat,
  update,
  recordBodyFeedback,
  windowGeometry,
  sameRectangle,
  entries,
  space,
  visibleBounds,
  screen,
  windowVisible,
  activeFollow,
  stopMovement,
  randomUUID,
  send,
  bodyPosition,
  animateTo,
  context: {
    get remoteState() {
      return remoteState;
    },
    get bodyWindowApproach() {
      return bodyWindowApproach;
    },
    get selectedMode() {
      return selectedMode;
    },
    get hidden() {
      return hidden;
    },
    get desktopLocked() {
      return desktopLocked;
    },
    get bodyInputAfter() {
      return bodyInputAfter;
    },
    get bodyInteractions() {
      return bodyInteractions;
    },
    get publicPerception() {
      return publicPerception;
    },
  },
});
function executeVerifiedBodyAction(...args) {
  return bodyActions.executeVerifiedBodyAction(...args);
}
function moveResident(...args) {
  return bodyActions.moveResident(...args);
}

const frameworkStateController = createFrameworkStateController({
  body,
  clearVisualPermissions,
  nativeControl,
  stopLocalWindowTask,
  follow,
  screenRequest,
  room,
  update,
  screenCaptureSupported,
  windowGrants,
  displayGrants,
  verifyObservationRequest,
  app,
  snapshot,
  animateHome,
  verifiedWindowSurface,
  localScreen,
  localObservation,
  syncCompanionMode,
  bubbles,
  entries,
  showSprite,
  context: {
    get bodyCrossDisplay() {
      return bodyCrossDisplay;
    },
    set bodyCrossDisplay(value) {
      bodyCrossDisplay = value;
    },
    get bodyInteractions() {
      return bodyInteractions;
    },
    set bodyInteractions(value) {
      bodyInteractions = value;
    },
    get bodyWindowApproach() {
      return bodyWindowApproach;
    },
    set bodyWindowApproach(value) {
      bodyWindowApproach = value;
    },
    get publicPerception() {
      return publicPerception;
    },
    set publicPerception(value) {
      publicPerception = value;
    },
    get displayObservation() {
      return displayObservation;
    },
    set displayObservation(value) {
      displayObservation = value;
    },
    get batchScreenGrants() {
      return batchScreenGrants;
    },
    set batchScreenGrants(value) {
      batchScreenGrants = value;
    },
    get remoteState() {
      return remoteState;
    },
    set remoteState(value) {
      remoteState = value;
    },
    get syncingMode() {
      return syncingMode;
    },
    set syncingMode(value) {
      syncingMode = value;
    },
    get localWindowTaskStatus() {
      return localWindowTaskStatus;
    },
    set localWindowTaskStatus(value) {
      localWindowTaskStatus = value;
    },
    get recoveryPositionPending() {
      return recoveryPositionPending;
    },
    set recoveryPositionPending(value) {
      recoveryPositionPending = value;
    },
    get bodyProtocol() {
      return bodyProtocol;
    },
    set bodyProtocol(value) {
      bodyProtocol = value;
    },
    get observationProtocol() {
      return observationProtocol;
    },
    set observationProtocol(value) {
      observationProtocol = value;
    },
    get observationEnded() {
      return observationEnded;
    },
    set observationEnded(value) {
      observationEnded = value;
    },
    get lastBrowserGrant() {
      return lastBrowserGrant;
    },
    set lastBrowserGrant(value) {
      lastBrowserGrant = value;
    },
    get roles() {
      return roles;
    },
    set roles(value) {
      roles = value;
    },
    get approachedWindowTask() {
      return approachedWindowTask;
    },
    set approachedWindowTask(value) {
      approachedWindowTask = value;
    },
  },
});
function applyFramework(value, action) {
  if (action === "sync" || action === "heartbeat" || value.offline)
    ownerInput.update(value, { heartbeat: action === "heartbeat" });
  if (action === "sync" || value.offline) void desktopCapture.update(value);
  return frameworkStateController.applyFramework(value, action);
}
function syncLive(...args) {
  return frameworkStateController.syncLive(...args);
}

const { act: localRoomAction, returnHome } = createLocalRoomActions({
  context: {
    get live() {
      return live;
    },
    get framework() {
      return framework;
    },
  },
  room,
  bubbles,
  animateHome,
  showSprite,
  validInterval,
  savePreferences,
  update,
});

const pointerController = createPointerController({
  entries,
  windowVisible,
  screen,
  follow,
  desktopBodyBounds: (type, bounds) =>
    desktopBodyBounds(type, bounds, petPreferences.spriteSize),
  room,
  space,
  stopLocalWindowTask,
  stopCompanionControl,
  manuallyMoved,
  body,
  stopLocalSeat,
  stopMovement,
  send,
  snapshot,
  clampPoint,
  sizes,
  manualTouches,
  ownerInput,
  positions,
  savePreferences,
  context: {
    get hidden() {
      return hidden;
    },
    get desktopLocked() {
      return desktopLocked;
    },
    get remoteState() {
      return remoteState;
    },
    get framework() {
      return framework;
    },
    get bodyInputAfter() {
      return bodyInputAfter;
    },
    set bodyInputAfter(value) {
      bodyInputAfter = value;
    },
    get doorPosition() {
      return doorPosition;
    },
    set doorPosition(value) {
      doorPosition = value;
    },
  },
});
function updatePointerPolling(...args) {
  return pointerController.updatePointerPolling(...args);
}
function updatePointerRegions(...args) {
  return pointerController.updatePointerRegions(...args);
}
function handleDrag(...args) {
  return pointerController.handleDrag(...args);
}

const ipc = createIpcRouter(ipcMain, entries);

ipc.handle("room:get-pet-preferences", () => petPreferences);
ipc.on("room:speech-bounds", (event, rect) => {
  const entry = ipc.actionEntry(event);
  if (entry?.type !== "sprite" || !rect) return;
  const { x, y, width, height } = rect;
  if ([x, y, width, height].every(Number.isFinite))
    entry.speechBounds = { x, y, width, height };
});

ipc.on("room:set-pet-preference", (event, name, value) => {
  if (ipc.actionEntry(event)?.type !== "panel") return;
  const valid =
    (name === "spriteSize" && validSpriteSize(value)) ||
    (name === "idleFrequency" && validIdleFrequency(value));
  if (!valid || petPreferences[name] === value) return;
  petPreferences[name] = value;
  if (name === "spriteSize") sizes.sprite = spriteWindowSize(value);
  for (const entry of entries.values()) {
    if (entry.type !== "sprite" || entry.win.isDestroyed()) continue;
    if (name === "spriteSize") {
      const old = entry.win.getBounds();
      const [width, height] = sizes.sprite;
      const point = clampPoint(
        { x: old.x + (old.width - width) / 2, y: old.y + old.height - height },
        width,
        height,
        screen.getDisplayMatching(old).workArea,
      );
      entry.win.setBounds({ ...point, width, height });
    }
    entry.win.webContents.send("room:pet-preferences", petPreferences);
  }
  savePreferences();
});

registerRoomIpc({
  ipc,
  context: {
    get remoteState() {
      return remoteState;
    },
    get framework() {
      return framework;
    },
    get hidden() {
      return hidden;
    },
    get desktopLocked() {
      return desktopLocked;
    },
    get shuttingDown() {
      return shuttingDown;
    },
  },
  updatePointerRegions,
  windowVisible,
  snapshot,
});

let openingStatusCard;
ipc.handle("room:status-card", async (event, data) => {
  const entry = ipc.actionEntry(event);
  const current = () => {
    const agentId = entry?.type === "sprite" ? entry.id : data?.agentId;
    const role = remoteState?.roles.find(({ id }) => id === agentId);
    return (
      (entry?.type === "sprite" || entry?.type === "panel") &&
      ipc.actionEntry(event) === entry &&
      windowVisible(entry) &&
      personal.personalTarget(agentId, data?.roomEpoch, data?.visitId) &&
      role?.statusCard?.ref === data?.ref
    );
  };
  if (!current() || (entry.type === "panel" && !entry.win.isFocused()))
    return false;
  const focusedWindow = BrowserWindow.getFocusedWindow();
  const opening = {};
  openingStatusCard = opening;
  const currentOpening = () => openingStatusCard === opening && current();
  try {
    const value = await framework.personal("status-card", {
      agentId: entry.type === "sprite" ? entry.id : data.agentId,
      roomEpoch: data.roomEpoch,
      visitId: data.visitId,
      ref: data.ref,
    });
    if (
      !currentOpening() ||
      value?.status !== "ok" ||
      BrowserWindow.getFocusedWindow() !== focusedWindow
    )
      return false;
    showPanel("chat");
    const panel = entries.get("panel");
    const deliver = () => {
      if (currentOpening() && entries.get("panel") === panel)
        send(panel, "room:status-card", {
          title: value.title,
          text: value.text,
          target: {
            agentId: entry.type === "sprite" ? entry.id : data.agentId,
            roomEpoch: data.roomEpoch,
            visitId: data.visitId,
            ref: data.ref,
          },
        });
    };
    if (panel?.ready) deliver();
    else panel?.win.webContents.once("did-finish-load", deliver);
    return true;
  } catch {
    return false;
  }
});

// Personal drops never enter the shared room snapshot or renderer event bus.
const personal = registerPersonalIpc({
  ipc,
  dialog,
  showPanel,
  entries,
  send,
  context: {
    get framework() {
      return framework;
    },
    get remoteState() {
      return remoteState;
    },
    get hidden() {
      return hidden;
    },
    get desktopLocked() {
      return desktopLocked;
    },
  },
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

registerFollowIpc({
  ipc,
  entries,
  follow,
  space,
  followBlocked,
  body,
  stopLocalSeat,
  stopMovement,
  screen,
  geometryDriver,
  deniedWindow,
  desktopSourceMenu,
  windowGeometry,
  geometryFailure,
  context: {
    get remoteState() {
      return remoteState;
    },
    get approachedWindowTask() {
      return approachedWindowTask;
    },
    get choosingDesktopPermission() {
      return choosingDesktopPermission;
    },
    set choosingDesktopPermission(value) {
      choosingDesktopPermission = value;
    },
  },
});

registerWindowObservationIpc({
  entries,
  permissionRevision,
  verifiedWindowSurface,
  screenCaptureSupported,
  observationDriver,
  clearScreenGrant,
  systemPreferences,
  listScreenSources,
  screenCapturePermission,
  observationSources,
  ownScreenSources,
  deniedWindow,
  screenPickerVisits,
  desktopSourceMenu,
  readObservationTarget,
  randomUUID,
  windowGrants,
  monitorObservation,
  clearObservation,
  removeObservation,
  observationError,
  ipc,
  context: {
    get remoteState() {
      return remoteState;
    },
    get observationProtocol() {
      return observationProtocol;
    },
    get framework() {
      return framework;
    },
    get choosingDesktopPermission() {
      return choosingDesktopPermission;
    },
    set choosingDesktopPermission(value) {
      choosingDesktopPermission = value;
    },
    get hidden() {
      return hidden;
    },
    get desktopLocked() {
      return desktopLocked;
    },
    get roles() {
      return roles;
    },
    get observationEnded() {
      return observationEnded;
    },
    set observationEnded(value) {
      observationEnded = value;
    },
  },
});

function permissionPanel(event, roomEpoch) {
  const win = entries.get("panel")?.win;
  return (
    framework &&
    remoteState?.connected &&
    remoteState.roomEpoch === roomEpoch &&
    !hidden &&
    !desktopLocked &&
    win &&
    !win.isDestroyed() &&
    win.isVisible() &&
    win.isFocused() &&
    event.sender === win.webContents &&
    event.senderFrame === win.webContents.mainFrame
  );
}

ipc.handle("room:garden", async (event, roomEpoch, action, journal) => {
  if (
    !permissionPanel(event, roomEpoch) ||
    entries.get("panel")?.section !== "garden"
  )
    return false;
  try {
    const response = await framework.personal("garden", {
      roomEpoch,
      action,
      journal,
    });
    return permissionPanel(event, roomEpoch) &&
      entries.get("panel")?.section === "garden"
      ? response
      : false;
  } catch {
    return false;
  }
});

registerCompanionIpc(ipc, permissionPanel);

function screenPickerVisits() {
  return new Map(
    remoteState.roles
      .filter(({ state }) => state === "here")
      .map(({ id, bodyVisitId }) => [id, bodyVisitId]),
  );
}

registerReadGrantsIpc({
  displayGrants,
  screenGrants,
  permissionRevision,
  verifiedWindowSurface,
  screenCaptureSupported,
  permissionPanel,
  removeObservation,
  clearManualScreen,
  systemPreferences,
  listScreenSources,
  screenCapturePermission,
  screen,
  displayFingerprint,
  observationDisplayTarget,
  randomUUID,
  geometryDriver,
  observationDriver,
  observationSources,
  ownScreenSources,
  deniedWindow,
  screenPickerVisits,
  localLabel,
  windowGeometry,
  readDisplayTarget,
  stopObservation,
  clearObservation,
  monitorObservation,
  observationError,
  ipc,
  context: {
    get remoteState() {
      return remoteState;
    },
    get displayPicker() {
      return displayPicker;
    },
    set displayPicker(value) {
      displayPicker = value;
    },
    get screenPicker() {
      return screenPicker;
    },
    set screenPicker(value) {
      screenPicker = value;
    },
    get choosingDesktopPermission() {
      return choosingDesktopPermission;
    },
    set choosingDesktopPermission(value) {
      choosingDesktopPermission = value;
    },
    get framework() {
      return framework;
    },
    get screenCapture() {
      return screenRequests.active;
    },
    get batchScreenGrants() {
      return batchScreenGrants;
    },
    get displayObservation() {
      return displayObservation;
    },
  },
});

ipc.handle(
  "room:observation-review",
  createObservationReviewHandler({
    get entries() {
      return entries;
    },
    get remoteState() {
      return remoteState;
    },
    permissionRevision: () => permissionRevision("control"),
    get framework() {
      return framework;
    },
    get observationProtocol() {
      return observationProtocol;
    },
    get hidden() {
      return hidden;
    },
    get desktopLocked() {
      return desktopLocked;
    },
  }),
);

registerNativeControlIpc({
  ipc,
  entries,
  permissionRevision,
  verifiedWindowSurface,
  nativeControl,
  screenPickerVisits,
  nativeDriver,
  desktopSourceMenu,
  deniedWindow,
  dialog,
  localLabel,
  context: {
    get remoteState() {
      return remoteState;
    },
    get framework() {
      return framework;
    },
    get choosingDesktopPermission() {
      return choosingDesktopPermission;
    },
    set choosingDesktopPermission(value) {
      choosingDesktopPermission = value;
    },
    get roles() {
      return roles;
    },
  },
});

ipc.handle(
  "room:browser-control",
  createBrowserControlHandler({
    get entries() {
      return entries;
    },
    get remoteState() {
      return remoteState;
    },
    get framework() {
      return framework;
    },
    get choosingDesktopPermission() {
      return choosingDesktopPermission;
    },
    set choosingDesktopPermission(value) {
      choosingDesktopPermission = value;
    },
    get lastBrowserGrant() {
      return lastBrowserGrant;
    },
    set lastBrowserGrant(value) {
      lastBrowserGrant = value;
    },
    get roles() {
      return roles;
    },
    get parseBrowserOrigin() {
      return parseBrowserOrigin;
    },
    get dialog() {
      return dialog;
    },
    get localLabel() {
      return localLabel;
    },
    get randomUUID() {
      return randomUUID;
    },
  }),
);

registerActionIpc({
  places,
  controllableResident,
  entries,
  recordBodyFeedback,
  screen,
  displayFingerprint,
  clampPoint,
  savePreferences,
  update,
  room,
  windowVisible,
  follow,
  stopLocalWindowTask,
  body,
  stopLocalSeat,
  stopMovement,
  stopCompanionControl,
  manuallyMoved,
  savedPlace,
  space,
  moveResident,
  windowVisibilityChanged,
  refreshIfDue,
  handleDrag,
  showPanel,
  randomUUID,
  manualTouches,
  ownerInput,
  Menu,
  positions,
  returnHome,
  spaceEditor,
  windowTaskGrant,
  permissionRevision,
  ipc,
  localRoomAction,
  context: {
    get roles() {
      return roles;
    },
    get remoteState() {
      return remoteState;
    },
    get framework() {
      return framework;
    },
    get live() {
      return live;
    },
    get hidden() {
      return hidden;
    },
    get desktopLocked() {
      return desktopLocked;
    },
    get bodyInputAfter() {
      return bodyInputAfter;
    },
    set bodyInputAfter(value) {
      bodyInputAfter = value;
    },
    get localWindowTaskStatus() {
      return localWindowTaskStatus;
    },
    set localWindowTaskStatus(value) {
      localWindowTaskStatus = value;
    },
  },
});

startDesktopLifecycle({
  app,
  showDoor,
  follow,
  spaceEditor,
  clearVisualPermissions,
  body,
  nativeControl,
  nativeDriver,
  observationDriver,
  geometryDriver,
  protocol,
  desktopResourcePath,
  source,
  net,
  pathToFileURL,
  screen,
  displayGrants,
  clearObservation,
  screenGrants,
  clearManualScreen,
  restoreWindowLayout,
  powerMonitor,
  invalidatePermissions,
  stopLocalMotion,
  updatePointerPolling,
  entries,
  updateMotion,
  frameworkRoot,
  createFrameworkClient,
  applyFramework,
  frameworkPort,
  manuallyMoved,
  manualTouches,
  ownerInput,
  screenCaptureSupported,
  visibleBounds,
  bodyPosition,
  windowVisible,
  publicSpace,
  liveRoot,
  LiveRoom,
  room,
  startModelClient,
  syncLive,
  nativeImage,
  join,
  Tray,
  Menu,
  showPanel,
  hideAll,
  refreshIfDue,
  update,
  context: {
    get live() {
      return live;
    },
    set live(value) {
      live = value;
    },
    get framework() {
      return framework;
    },
    set framework(value) {
      framework = value;
    },
    get shuttingDown() {
      return shuttingDown;
    },
    set shuttingDown(value) {
      shuttingDown = value;
    },
    get displayPicker() {
      return displayPicker;
    },
    set displayPicker(value) {
      displayPicker = value;
    },
    get screenPicker() {
      return screenPicker;
    },
    set screenPicker(value) {
      screenPicker = value;
    },
    get desktopLocked() {
      return desktopLocked;
    },
    set desktopLocked(value) {
      desktopLocked = value;
    },
    get bodyInputAfter() {
      return bodyInputAfter;
    },
    set bodyInputAfter(value) {
      bodyInputAfter = value;
    },
    get roles() {
      return roles;
    },
    set roles(value) {
      roles = value;
    },
    get recoveryPositionPending() {
      return recoveryPositionPending;
    },
    set recoveryPositionPending(value) {
      recoveryPositionPending = value;
    },
    get remoteState() {
      return remoteState;
    },
    set remoteState(value) {
      remoteState = value;
    },
    get hidden() {
      return hidden;
    },
    set hidden(value) {
      hidden = value;
    },
    get batchScreenGrants() {
      return batchScreenGrants;
    },
    set batchScreenGrants(value) {
      batchScreenGrants = value;
    },
    get observationProtocol() {
      return observationProtocol;
    },
    set observationProtocol(value) {
      observationProtocol = value;
    },
    get displayObservation() {
      return displayObservation;
    },
    set displayObservation(value) {
      displayObservation = value;
    },
    get bodyProtocol() {
      return bodyProtocol;
    },
    set bodyProtocol(value) {
      bodyProtocol = value;
    },
    get bodyCrossDisplay() {
      return bodyCrossDisplay;
    },
    set bodyCrossDisplay(value) {
      bodyCrossDisplay = value;
    },
    get bodyInteractions() {
      return bodyInteractions;
    },
    set bodyInteractions(value) {
      bodyInteractions = value;
    },
    get bodyWindowApproach() {
      return bodyWindowApproach;
    },
    set bodyWindowApproach(value) {
      bodyWindowApproach = value;
    },
    get publicPerception() {
      return publicPerception;
    },
    set publicPerception(value) {
      publicPerception = value;
    },
    get tray() {
      return tray;
    },
    set tray(value) {
      tray = value;
    },
  },
});
