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
  captureScreen,
  captureScreenSource,
  listScreenSources,
  screenCapturePermission,
  screenCaptureSupported,
} from "./screen-capture.mjs";
import {
  observationSources,
  observationTarget,
  readObservationFrame,
} from "./screen-source.mjs";
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
const places = new Map(
  Object.entries(saved.places ?? {}).filter(
    ([, place]) =>
      place &&
      /^[a-f0-9]{64}$/.test(place.display) &&
      [place.x, place.y].every(Number.isSafeInteger),
  ),
);
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
let approachedWindowTask;
let localWindowTaskStatus;
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
let bodyProtocol = false;
let bodyCrossDisplay = false;
let bodyInteractions = false;
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
  execute: executeVerifiedBodyAction,
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
      command: (action, data) => framework.command(action, data),
      claim: (data, isCurrent) =>
        framework.result("native-claim", data, isCurrent),
      result: (data, isCurrent) =>
        framework.result("native-result", data, isCurrent),
      verifyTarget: verifyApproachedWindow,
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

function clearScreenGrant(observe = false) {
  if (observe) {
    const grant = observationGrant;
    observationGrant = undefined;
    if (grant) {
      grant.controller.abort();
      clearInterval(grant.monitor);
      body.stopObservation(grant.agentId);
    }
  } else screenGrant = undefined;
  if (screenCapture?.observe === observe) screenCapture.controller.abort();
}

function observationCurrent(grant) {
  return (
    observationGrant === grant &&
    !grant.controller.signal.aborted &&
    !hidden &&
    !desktopLocked &&
    !shuttingDown &&
    Date.now() < grant.expiresAt
  );
}

function ownScreenSources() {
  return BrowserWindow.getAllWindows().map((win) => win.getMediaSourceId());
}

function observationError(error) {
  return error.message === "DESKTOP_NATIVE_PERMISSION" ||
    !screenCapturePermission()
    ? "permission"
    : "unavailable";
}

async function readObservationTarget(source, signal) {
  try {
    if (!screenCapturePermission()) return { state: "permission" };
    const sources = await listScreenSources(true);
    const windows = await observationDriver.observationWindows({
      signal: AbortSignal.any([signal, AbortSignal.timeout(2500)]),
      app: source.identity.app,
    });
    if (!screenCapturePermission()) return { state: "permission" };
    return observationTarget(
      sources,
      windows,
      source,
      ownScreenSources(),
      process.pid,
    );
  } catch (error) {
    return { state: observationError(error) };
  }
}

function probeObservation(grant, signal = grant.controller.signal) {
  // A check queued after a capture must read the native window again.
  const probe = grant.probe.then(() =>
    observationCurrent(grant) && !signal.aborted
      ? readObservationTarget(grant.source, signal)
      : { state: "unavailable" },
  );
  grant.probe = probe;
  return probe;
}

function reportObservationState(grant, state) {
  if (!observationCurrent(grant)) return;
  const changed = grant.state !== state;
  const now = Date.now();
  if (!changed && (state !== "ready" || now - grant.reportedAt < 1200)) return;
  grant.state = state;
  grant.proofUntil = state === "ready" ? now + 5000 : 0;
  grant.reportedAt = now;
  const { roomEpoch, grantId, agentId } = grant;
  framework.act("observation-state", { roomEpoch, grantId, state });
  if (!changed) return;
  observationEnded = {
    minimized: "target-minimized",
    unavailable: "target-unavailable",
    permission: "permission",
  }[state];
  if (state === "minimized") {
    if (screenCapture?.observe) screenCapture.controller.abort();
    body.stopObservation(agentId);
  }
  if (state === "unavailable" || state === "permission") clearScreenGrant(true);
  update();
}

function monitorObservation(grant) {
  if (grant.monitoring) return;
  if (!observationCurrent(grant)) {
    if (observationGrant === grant) clearObservation();
    return;
  }
  grant.monitoring = true;
  void probeObservation(grant)
    .then(({ state }) => reportObservationState(grant, state))
    .finally(() => {
      grant.monitoring = false;
    });
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

function verifyObservationRequest(value, action) {
  const grant = observationGrant;
  if (action !== "sync" || !grant || !observationCurrent(grant)) return;
  const request = value.observationVerify;
  if (grant.verify?.requestId !== request?.requestId) {
    grant.verify?.controller.abort();
    grant.verify = undefined;
  }
  if (
    !request ||
    grant.state !== "ready" ||
    request.roomEpoch !== grant.roomEpoch ||
    request.grantId !== grant.grantId ||
    request.requestId === grant.lastVerify
  )
    return;
  const { roomEpoch, grantId, requestId } = request;
  const controller = new AbortController();
  grant.verify = { controller, requestId };
  grant.lastVerify = requestId;
  const signal = AbortSignal.any([controller.signal, grant.controller.signal]);
  const current = () =>
    !signal.aborted &&
    observationCurrent(grant) &&
    grant.state === "ready" &&
    grant.verify?.requestId === requestId;
  void (async () => {
    let state;
    try {
      ({ state } = await probeObservation(grant, signal));
      if (!current()) return;
      await framework.result(
        "observation-verify",
        { roomEpoch, grantId, requestId, state },
        current,
      );
    } catch {
      // The host rejects requests that expired while checking the window.
    } finally {
      if (current() && state) reportObservationState(grant, state);
    }
  })();
}

function windowTaskGrant(scope, agentId, roomEpoch) {
  if (!agentId || !roomEpoch || !remoteState?.interactionsAvailable) return;
  const policy =
    scope === "screen" ? remoteState.screenView : remoteState.nativeControl;
  if (
    policy?.grantedAgentId !== agentId ||
    remoteState?.roomEpoch !== roomEpoch
  )
    return;
  if (scope === "native")
    return nativeControl?.selectedWindow(agentId, roomEpoch);
  if (
    screenGrant?.geometrySource &&
    !screenGrant.pending &&
    screenGrant.roomEpoch === roomEpoch &&
    screenGrant.agentId === agentId &&
    screenCapturePermission()
  )
    return screenGrant;
}

function controllableResident(agentId, roomEpoch, visitId) {
  const role = remoteState?.roles.find(({ id }) => id === agentId);
  const entry = entries.get(agentId);
  if (
    (remoteState?.interactionsAvailable || remoteState?.socialBodyAvailable) &&
    remoteState.roomEpoch === roomEpoch &&
    !remoteState.connectionLost &&
    !hidden &&
    !desktopLocked &&
    !shuttingDown &&
    role?.state === "here" &&
    role.bodyVisitId === visitId &&
    role.bodyControlAvailable &&
    !["paused", "qq"].includes(role.bodyStatus?.state) &&
    entry &&
    !entry.departing &&
    !entry.drag &&
    !entries.get("door")?.drag &&
    !activeFollow(entry) &&
    windowVisible(entry)
  )
    return entry;
}

function stopLocalWindowTask(reason, agentId) {
  const task = approachedWindowTask;
  if (task && (!agentId || task.agentId === agentId)) {
    approachedWindowTask = undefined;
    if (screenCapture?.windowTaskId === task.id)
      screenCapture.controller.abort();
    nativeControl?.stopWindowTask(task.id);
  }
  for (const entry of entries.values()) {
    if (agentId && entry.id !== agentId) continue;
    const cancel = entry.localComboCancel;
    entry.localComboCancel = undefined;
    cancel?.(reason);
  }
}

async function verifyApproachedWindow(request, signal) {
  if (!request.windowTaskId) return true;
  const task = approachedWindowTask;
  if (
    !task ||
    request.windowTaskId !== task.id ||
    request.roomEpoch !== task.roomEpoch ||
    request.grantId !== task.grant.grantId ||
    !task.current()
  )
    return false;
  try {
    const result = await windowGeometry(task.source, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(1800)]),
    });
    return (
      !signal.aborted &&
      approachedWindowTask === task &&
      task.current() &&
      sameRectangle(task.bounds, result?.bounds)
    );
  } catch {
    return false;
  }
}

function sameRectangle(a, b) {
  return (
    b &&
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height
  );
}

function executeWindowTask(request, current, finish) {
  const { agentId, roomEpoch, visitId, expiresAt, inputAt, windowTask } =
    request;
  const entry = controllableResident(agentId, roomEpoch, visitId);
  const grant = windowTaskGrant(windowTask.scope, agentId, roomEpoch);
  if (
    !entry ||
    grant?.grantId !== windowTask.grantId ||
    inputAt <= Math.max(entry.bodyInputAfter ?? 0, bodyInputAfter)
  )
    return finish({ status: "cancelled", reason: "target-unavailable" });
  const source = grant.geometrySource ?? grant.source;
  const controller = new AbortController();
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(Math.max(1, expiresAt - Date.now())),
  ]);
  let cancelMove;
  const localCurrent = () =>
    controllableResident(agentId, roomEpoch, visitId) === entry &&
    windowTaskGrant(windowTask.scope, agentId, roomEpoch) === grant &&
    inputAt > Math.max(entry.bodyInputAfter ?? 0, bodyInputAfter);
  const moving = () => !signal.aborted && current() && localCurrent();
  const complete = (result) => {
    if (entry.localComboCancel === cancel) entry.localComboCancel = undefined;
    finish(result);
  };
  const cancel = (reason) => {
    controller.abort();
    cancelMove?.(reason);
  };
  entry.localComboCancel = cancel;
  stopLocalSeat(entry, "stopped");
  void (async () => {
    try {
      const geometry = await windowGeometry(source, { signal });
      if (!geometry || !moving()) {
        complete({ status: "cancelled", reason: "target-unavailable" });
        return;
      }
      const { bounds } = geometry;
      cancelMove = moveResident(
        entry,
        { target: { type: "window", bounds } },
        {
          current: moving,
          expiresAt,
          crossDisplay: request.crossDisplay === true,
          local: true,
          fail: (reason, status) => complete({ status, reason }),
          finish: () => {
            cancelMove = undefined;
            void (async () => {
              const checked = await windowGeometry(source, { signal });
              if (!moving() || !sameRectangle(bounds, checked?.bounds)) {
                complete({ status: "failed", reason: "position-unconfirmed" });
                return;
              }
              const point = entry.win.getBounds();
              approachedWindowTask = {
                id: windowTask.id,
                agentId,
                roomEpoch,
                grant,
                source,
                bounds,
                current: () =>
                  localCurrent() && sameRectangle(point, entry.win.getBounds()),
              };
              complete({ status: "completed", arrivalConfirmed: true });
            })().catch(() =>
              complete({ status: "failed", reason: "target-unavailable" }),
            );
          },
        },
      );
    } catch {
      complete({ status: "failed", reason: "target-unavailable" });
    }
  })();
  return (reason) => {
    if (entry.localComboCancel === cancel) stopLocalWindowTask(reason, agentId);
  };
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
    (observe && (!observationCurrent(grant) || grant.state !== "ready")) ||
    screenCapture ||
    request.roomEpoch !== grant.roomEpoch ||
    request.grantId !== grant.grantId ||
    request.requestId === grant.lastRequest
  )
    return;
  grant.lastRequest = request.requestId;
  const { roomEpoch, grantId, requestId, maxEdge, maxBytes } = request;
  const controller = new AbortController();
  screenCapture = {
    controller,
    requestId,
    observe,
    windowTaskId: request.windowTaskId,
  };
  const isCurrent = () =>
    (observe ? observationCurrent(grant) : screenGrant === grant) &&
    !controller.signal.aborted &&
    !shuttingDown;
  void (async () => {
    let status;
    try {
      if (observe) {
        const claim = await framework.result(
          "screen-claim",
          { roomEpoch, grantId, requestId },
          isCurrent,
        );
        if (!claim?.accepted || !isCurrent()) return;
      }
      const { signal } = controller;
      let data;
      let digest;
      if (observe) {
        ({ data, status } = await readObservationFrame(
          () => probeObservation(grant, signal),
          (source) =>
            captureScreenSource(source, maxEdge, maxBytes, signal, true).catch(
              () => undefined,
            ),
          isCurrent,
        ));
        if (data) {
          digest = createHash("sha256").update(data).digest("hex");
          if (grant.digests.has(digest)) {
            data = undefined;
            status = "duplicate";
          }
        }
      } else if (
        (await verifyApproachedWindow(request, signal)) &&
        isCurrent()
      ) {
        data = await captureScreen(
          grant.source,
          maxEdge,
          maxBytes,
          signal,
        ).catch(() => undefined);
        if (data && !(await verifyApproachedWindow(request, signal)))
          data = undefined;
      }
      if (isCurrent()) {
        await framework.result(
          "screen-result",
          { roomEpoch, grantId, requestId, data, status },
          () => {
            if (!isCurrent()) return false;
            // A lost receipt can follow a delivered frame.
            if (digest && data) grant.digests.add(digest);
            return true;
          },
        );
      }
    } catch {
      // The host owns request expiry and rejects stale results.
    } finally {
      screenCapture = undefined;
      if (observe && status && status !== "duplicate")
        reportObservationState(grant, status);
    }
  })();
}

function savePreferences() {
  mkdirSync(app.getPath("userData"), { recursive: true });
  const next = `${preferencesPath}.next`;
  writeFileSync(
    next,
    JSON.stringify({
      minutes: room.minutes,
      positions,
      doorPosition,
      places: Object.fromEntries(places),
    }),
  );
  renameSync(next, preferencesPath);
}

function baseSnapshot() {
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

function savedPlace(id) {
  const place = places.get(id);
  if (!place) return;
  const display = screen
    .getAllDisplays()
    .find((display) => displayFingerprint(display) === place.display);
  const entry = entries.get(id);
  if (!display) return { state: "unavailable" };
  const { x, y } = display.workArea;
  const point = { x: x + place.x, y: y + place.y };
  const [width, height] = sizes.sprite;
  const size =
    entry && !entry.win.isDestroyed()
      ? entry.win.getBounds()
      : { width, height };
  const clamped = clampPoint(point, size.width, size.height, display.workArea);
  if (point.x !== clamped.x || point.y !== clamped.y)
    return { state: "unavailable" };
  return { state: "saved", point, displayId: display.id };
}

function snapshot(panel = false) {
  const data = baseSnapshot();
  const screen =
    panel &&
    windowTaskGrant("screen", data.screenView?.grantedAgentId, data.roomEpoch);
  const native =
    panel &&
    windowTaskGrant(
      "native",
      data.nativeControl?.grantedAgentId,
      data.roomEpoch,
    );
  return {
    ...data,
    bodyZones: !hidden && !desktopLocked,
    windowTaskStatus:
      panel && data.interactionsAvailable
        ? (localWindowTaskStatus ?? data.windowTaskStatus)
        : undefined,
    ...(panel && {
      observationReviewAvailable: observationProtocol,
      windowFollowAvailable: Boolean(geometryDriver),
      ...(screen && {
        windowTaskScreenAgentId: screen.agentId,
        windowTaskScreenGrantId: screen.grantId,
      }),
      ...(native && {
        windowTaskNativeAgentId: native.agentId,
        windowTaskNativeGrantId: native.grantId,
      }),
    }),
    ...(observationEnded && { observationEnded }),
    roles: data.roles.map((role) => {
      if (panel && places.has(role.id))
        role = { ...role, place: savedPlace(role.id).state };
      const entry = entries.get(role.id);
      if (!entry || !visibleBounds(entry)) return role;
      const status = role.bodyStatus ?? { state: "idle" };
      const stopped = ["paused", "qq"].includes(status.state);
      return {
        ...role,
        ...(panel && activeFollow(entry) && { follow: follow.snapshot(entry) }),
        bodyStatus: {
          ...status,
          ...entry.bodyFeedback,
          ...(status.reason && { stateReason: status.reason }),
          state: stopped
            ? status.state
            : entry.movement
              ? "moving"
              : status.state,
          facing: entry.facing ?? "right",
          pose: entry.pose ?? "sit",
          ...(entry.gesture && { gesture: entry.gesture }),
        },
      };
    }),
  };
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
  const data = snapshot();
  for (const entry of entries.values()) {
    send(entry, "room:update", entry.type === "panel" ? snapshot(true) : data);
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
    },
  });
  const entry = {
    win,
    id,
    type,
    ready: false,
    section: options.section,
    bodyVisit: {},
  };
  entries.set(id, entry);
  if (panel) win.setAlwaysOnTop(true, "floating", 1);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.on("did-finish-load", () => {
    entry.ready = true;
    entry.reportedMotion = undefined;
    entry.reportedSpeed = undefined;
    entry.pageVisible = undefined;
    send(entry, "room:update", snapshot(entry.type === "panel"));
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
  if (!panel)
    for (const event of ["show", "hide", "minimize", "restore"])
      win.on(event, () => windowVisibilityChanged(entry));
  win.on("closed", () => {
    follow.stop("inactive", entry);
    body.stop(id, "inactive");
    stopLocalSeat(entry, "inactive");
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

function windowVisibilityChanged(entry) {
  if (!windowVisible(entry)) {
    follow.stop("hidden", entry);
    stopLocalWindowTask("hidden", entry.id);
    body.stop(entry.id, "hidden");
    stopLocalSeat(entry, "hidden");
    if (entry.departing) entry.win.destroy();
    else stopMovement(entry);
  } else if (entry.type === "sprite") {
    send(entry, "room:update", snapshot());
  }
  updateMotion(entry);
  updatePointerPolling();
}

function updateMotion(entry) {
  if (entry.type !== "sprite" || entry.win.isDestroyed()) return;
  const suspended = hidden || desktopLocked || !windowVisible(entry);
  const state = suspended ? "suspended" : entry.movement ? "moving" : "still";
  if (entry.reportedMotion === state) return;
  if (!entry.ready) return;
  entry.reportedMotion = state;
  send(entry, "room:motion", state);
  if (state !== "moving") reportSpeed(entry, 0, performance.now());
  const panel = entries.get("panel");
  if (panel?.ready) send(panel, "room:update", snapshot(true));
}

function reportSpeed(entry, speed, now) {
  const rounded = speed ? Math.max(25, Math.round(speed / 25) * 25) : 0;
  if (
    entry.reportedSpeed === rounded ||
    (rounded && entry.reportedSpeed && now - entry.speedAt < 125)
  )
    return;
  entry.reportedSpeed = rounded;
  entry.speedAt = now;
  send(entry, "room:motion-speed", rounded);
}

const movements = new Map();
let movementTimer;
function stepMovements() {
  const now = performance.now();
  // Route completion can enqueue the next leg during this tick.
  for (const [entry, motion] of [...movements])
    if (movements.get(entry) === motion) motion.step(now);
}
function stopMovement(entry, notify = true) {
  movements.delete(entry);
  entry.movement = undefined;
  if (!movements.size && movementTimer) {
    clearInterval(movementTimer);
    movementTimer = undefined;
  }
  if (notify) updateMotion(entry);
}

function stopLocalSeat(entry, reason) {
  const cancel = entry.localSeatCancel;
  entry.localSeatCancel = undefined;
  cancel?.(reason);
}

function stopLocalMotion(reason) {
  follow.stop(reason);
  stopLocalWindowTask(reason);
  for (const entry of entries.values()) {
    entry.drag = null;
    stopLocalSeat(entry, reason);
    if (entry.departing) entry.win.destroy();
    else stopMovement(entry);
  }
}

function restoreWindowLayout() {
  spaceEditor.close();
  space.invalidate();
  bodyInputAfter = Date.now();
  body.clear("display-changed");
  stopLocalMotion("display-changed");
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

function confirmedStep(requested, actual, from, canStep) {
  if (requested.x === actual.x && requested.y === actual.y) return true;
  // Native fractional scaling can round a position by one DIP.
  return (
    Math.abs(requested.x - actual.x) <= 1 &&
    Math.abs(requested.y - actual.y) <= 1 &&
    canStep(actual, from)
  );
}

function animateTo(entry, point, complete, options = {}) {
  stopMovement(entry, false);
  const [width, height] = sizes[entry.type];
  const target = options.canStep ? point : clampPoint(point, width, height);
  const [x, y] = entry.win.getPosition();
  const face = (from, to) => {
    if (from === to) return;
    const facing = to < from ? "left" : "right";
    if (entry.facing === facing) return;
    entry.facing = facing;
    send(entry, "room:facing", facing);
  };
  const started = performance.now();
  let previous = { x, y, at: started };
  const validStep = (point) => !options.canStep || options.canStep(point);
  if (options.current && !options.current()) {
    updateMotion(entry);
    return options.interrupted();
  }
  const duration = Math.max(16, options.duration ?? 450);
  if (
    entry.reducedMotion ||
    hidden ||
    desktopLocked ||
    (x === target.x && y === target.y)
  ) {
    if (!validStep(target)) {
      updateMotion(entry);
      return options.blocked?.();
    }
    entry.win.setPosition(target.x, target.y);
    const [actualX, actualY] = entry.win.getPosition();
    if (
      options.canStep &&
      !confirmedStep(
        target,
        { x: actualX, y: actualY },
        previous,
        options.canStep,
      )
    ) {
      updateMotion(entry);
      return options.unconfirmed();
    }
    face(x, actualX);
    complete?.();
    if (!entry.movement) updateMotion(entry);
    return;
  }
  const step = (now) => {
    if (entry.win.isDestroyed()) return stopMovement(entry);
    if (options.current && !options.current()) {
      stopMovement(entry);
      options.interrupted();
      return;
    }
    if (!windowVisible(entry) || hidden || desktopLocked) {
      stopMovement(entry);
      options.interrupted?.();
      return;
    }
    const progress = entry.reducedMotion
      ? 1
      : Math.min(1, (now - started) / duration);
    const eased = options.current
      ? progress * progress * (3 - 2 * progress)
      : 1 - (1 - progress) ** 3;
    const step = {
      x: Math.round(x + (target.x - x) * eased),
      y: Math.round(y + (target.y - y) * eased),
    };
    if (!validStep(step)) {
      stopMovement(entry);
      options.blocked?.();
      return;
    }
    entry.win.setPosition(step.x, step.y);
    const [actualX, actualY] = entry.win.getPosition();
    if (
      options.canStep &&
      !confirmedStep(
        step,
        { x: actualX, y: actualY },
        previous,
        options.canStep,
      )
    ) {
      stopMovement(entry);
      return options.unconfirmed();
    }
    face(previous.x, actualX);
    if (now > previous.at && (actualX !== previous.x || actualY !== previous.y))
      reportSpeed(
        entry,
        (Math.hypot(actualX - previous.x, actualY - previous.y) * 1000) /
          (now - previous.at),
        now,
      );
    previous = { x: actualX, y: actualY, at: now };
    if (progress === 1) {
      stopMovement(entry, false);
      complete?.();
      if (!entry.movement) updateMotion(entry);
    }
  };
  entry.movement = { step };
  movements.set(entry, entry.movement);
  movementTimer ??= setInterval(stepMovements, 16);
  updateMotion(entry);
}

function publicPoint(entry) {
  const bounds = visibleBounds(entry);
  if (!bounds || entry.privatePosition) return;
  return {
    x: bounds.x + Math.round(bounds.width / 2),
    y: bounds.y + Math.round(bounds.height / 2),
    displayId: screen.getDisplayMatching(bounds).id,
  };
}

function publicSpace() {
  if (!publicPerception || hidden || desktopLocked || !remoteState?.roomEpoch)
    return;
  const residents = [...entries.values()]
    .flatMap((entry) => {
      if (entry.type !== "sprite" || !entry.bodyVisitId || entry.departing)
        return [];
      const point = publicPoint(entry);
      return point
        ? [
            {
              ...point,
              agentId: entry.id,
              visitId: entry.bodyVisitId,
              halfWidth: Math.round(entry.win.getBounds().width / 2),
              halfHeight: Math.round(entry.win.getBounds().height / 2),
              pose: entry.pose ?? "sit",
              facing: entry.facing ?? "right",
            },
          ]
        : [];
    })
    .slice(0, 24);
  return {
    roomEpoch: remoteState.roomEpoch,
    residents,
    door: publicPoint(entries.get("door")),
  };
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

function executeVerifiedBodyAction(request, current, finish) {
  if (request.windowTask) return executeWindowTask(request, current, finish);
  if (request.interaction) return executeInteraction(request, current, finish);
  if (request.greeting) {
    const { agentId, visitId } = request.greeting;
    const present = () =>
      current() &&
      remoteState?.publicWaveAvailable &&
      remoteState.roles.some(
        (role) =>
          role.id === agentId &&
          role.bodyVisitId === visitId &&
          role.state === "here",
      );
    if (!present())
      return finish({ status: "cancelled", reason: "target-unavailable" });
    return executeBodyAction(request, present, finish);
  }
  if (!request.observation) return executeBodyAction(request, current, finish);
  const grant = observationGrant;
  const allowed = () =>
    current() &&
    observationGrant === grant &&
    observationCurrent(grant) &&
    grant.state === "ready";
  if (
    !grant ||
    grant.agentId !== request.agentId ||
    grant.roomEpoch !== request.roomEpoch ||
    grant.grantId !== request.observationGrantId ||
    !allowed()
  )
    return finish({ status: "cancelled", reason: "target-unavailable" });
  const controller = new AbortController();
  let cancel;
  void probeObservation(
    grant,
    AbortSignal.any([controller.signal, grant.controller.signal]),
  )
    .then(({ state }) => {
      if (controller.signal.aborted) return;
      if (!allowed()) {
        finish({ status: "cancelled", reason: "target-unavailable" });
        return;
      }
      if (state !== "ready") {
        finish({ status: "cancelled", reason: "target-unavailable" });
        reportObservationState(grant, state);
        return;
      }
      cancel = executeBodyAction(request, allowed, finish);
    })
    .catch(() => finish({ status: "failed", reason: "target-unavailable" }));
  return (reason) => {
    controller.abort();
    cancel?.(reason);
  };
}

function executeInteraction(request, current, finish) {
  const { agentId, interaction } = request;
  const { peerAgentId, peerVisitId, kind, step } = interaction;
  const actor = entries.get(agentId);
  const peer = entries.get(peerAgentId);
  const peerCurrent = () =>
    current() &&
    peer &&
    entries.get(peerAgentId) === peer &&
    peer.bodyVisitId === peerVisitId &&
    !peer.privatePosition &&
    controllableResident(peerAgentId, request.roomEpoch, peerVisitId) === peer;
  if (!actor || !peerCurrent())
    return finish({ status: "cancelled", reason: "target-unavailable" });
  let action;
  if (step === "move") {
    const target = space.residentTarget(agentId, peerAgentId);
    if (target) action = { type: "move", ...target };
  } else {
    const a = visibleBounds(actor);
    const b = visibleBounds(peer);
    const nearby =
      a &&
      b &&
      screen.getDisplayMatching(a).id === screen.getDisplayMatching(b).id &&
      Math.hypot(
        Math.max(0, b.x - a.x - a.width, a.x - b.x - b.width),
        Math.max(0, b.y - a.y - a.height, a.y - b.y - b.height),
      ) <= 64;
    if (kind === "wave" || nearby)
      action =
        step === "wave"
          ? { type: "gesture", gesture: "wave" }
          : { type: "pose", pose: "sit" };
  }
  if (!action)
    return finish({ status: "cancelled", reason: "target-unavailable" });
  return executeBodyAction({ ...request, action }, peerCurrent, (result) => {
    if (
      result.status === "completed" &&
      kind === "together" &&
      step === "move"
    ) {
      actor.pose = "sit";
      update();
    }
    finish(result);
  });
}

function executeBodyAction(
  {
    agentId,
    inputAt,
    expiresAt,
    action,
    greeting,
    interaction,
    crossDisplay = false,
  },
  current,
  finish,
) {
  const entry = entries.get(agentId);
  const fail = (reason, status = "cancelled") => {
    if (entry && reason !== "manual-control") recordBodyFeedback(entry, reason);
    finish({ status, reason });
  };
  if (!entry || entry.departing || entry.win.isDestroyed())
    return fail("inactive");
  if (hidden || desktopLocked || !windowVisible(entry)) return fail("hidden");
  if (
    entry.drag ||
    entries.get("door")?.drag ||
    activeFollow(entry) ||
    inputAt <= Math.max(entry.bodyInputAfter ?? 0, bodyInputAfter)
  )
    return fail("manual-control");
  if (entry.privatePosition && action.type !== "move")
    return fail("manual-control");
  if (action.type !== "state") stopLocalSeat(entry, "stopped");
  if (action.type === "state")
    return finish({
      status: "completed",
      space: space.snapshot(agentId, { crossDisplay }),
    });
  if (action.type === "gesture") {
    if (
      !(greeting
        ? remoteState?.publicWaveAvailable
        : interaction
          ? (remoteState?.socialBodyAvailable ??
            remoteState?.interactionsAvailable)
          : remoteState?.interactionsAvailable) ||
      !["jump", "climb", "land", "wave"].includes(action.gesture)
    )
      return fail("inactive");
    const gesture = { kind: action.gesture, id: randomUUID() };
    entry.gesture = gesture;
    update();
    const clear = () => {
      if (entry.gesture === gesture) {
        entry.gesture = undefined;
        update();
      }
    };
    const timer = setTimeout(() => {
      clear();
      if (current() && windowVisible(entry)) finish({ status: "completed" });
      else fail("inactive");
    }, 420);
    return () => {
      clearTimeout(timer);
      clear();
    };
  }
  if (action.type === "pose") {
    if (entry.movement) stopMovement(entry);
    if (action.facing) {
      entry.facing = action.facing;
      send(entry, "room:facing", entry.facing);
    } else entry.pose = action.pose;
    entry.bodyFeedback = { reason: "completed", at: Date.now() };
    update();
    return finish({ status: "completed" });
  }

  return moveResident(entry, action, {
    current,
    expiresAt,
    crossDisplay,
    finish,
    fail,
  });
}

function moveResident(
  entry,
  action,
  { current, expiresAt, crossDisplay, finish, fail, local = false, duration },
) {
  const { id: agentId } = entry;
  let plan = space.plan(agentId, action, { crossDisplay });
  if (plan.reason) return fail(plan.reason, "failed");
  entry.pose = "stand";
  if (local) entry.privatePosition = true;
  else
    entry.bodyAction = {
      kind: "move",
      state: "executing",
      destination: plan.destination,
    };
  let replanned = false;
  const end = (reason, status) => {
    plan.release();
    entry.bodyAction = undefined;
    if (reason) fail(reason, status);
    else {
      if (action.target === "seat") entry.pose = "sit";
      if (!local) {
        entry.privatePosition = undefined;
        entry.bodyFeedback = { reason: "completed", at: Date.now() };
      }
      update();
      finish({ status: "completed" });
    }
  };
  const next = (index) => {
    const point = plan.path[index];
    if (!point) {
      const { position } = bodyPosition(agentId);
      return position?.x === plan.destination.x &&
        position.y === plan.destination.y &&
        position.displayId === plan.displayId &&
        space.canStep(agentId, position, plan)
        ? end()
        : end("position-unconfirmed", "failed");
    }
    const [x, y] = entry.win.getPosition();
    const distance = Math.hypot(point.x - x, point.y - y);
    animateTo(entry, point, () => next(index + 1), {
      current,
      interrupted: () => end("inactive", "cancelled"),
      unconfirmed: () => end("position-unconfirmed", "failed"),
      canStep: (step, from) => space.canStep(agentId, step, plan, from),
      blocked: () => {
        if (replanned || !current()) return end("target-blocked", "cancelled");
        replanned = true;
        const replacement = space.plan(agentId, action, {
          crossDisplay,
          replan: plan,
        });
        if (replacement.reason) return end(replacement.reason, "cancelled");
        plan.release();
        plan = replacement;
        if (!local) entry.bodyAction.destination = plan.destination;
        next(0);
      },
      duration: Math.min(
        Math.max(0, expiresAt - Date.now() - 300) / (plan.path.length - index),
        duration ??
          (plan.path.length === 1
            ? Math.min(2200, Math.max(900, Math.round(distance * 3)))
            : Math.min(1050, Math.max(250, Math.round(distance * 3)))),
      ),
    });
  };
  next(0);
  return (reason) => {
    plan.release();
    entry.bodyAction = undefined;
    stopMovement(entry);
    if (reason && reason !== "manual-control")
      recordBodyFeedback(entry, reason);
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
    door &&
      screen.getDisplayMatching(door).id ===
        screen.getDisplayNearestPoint(point).id
      ? { x: door.x - 36, y: door.y - 27 }
      : point,
  );
  entry.win.once("ready-to-show", () => animateTo(entry, point));
}

function hideAll() {
  spaceEditor.close();
  hidden = true;
  clearObservation();
  framework?.sync();
  bodyInputAfter = Date.now();
  body.clear("hidden");
  stopLocalMotion("hidden");
  for (const { win } of entries.values()) win.hide();
  updatePointerPolling();
}

function animateHome(role) {
  const entry = entries.get(role.id);
  if (entry && !entry.departing) {
    follow.stop("inactive", entry);
    stopLocalWindowTask("inactive", role.id);
    body.stop;
    stopLocalSeat(entry, "inactive");
    entry.departing = true;
    entry.win.setIgnoreMouseEvents(true);
    const door = entries.get("door")?.win.getBounds();
    if (
      door &&
      windowVisible(entry) &&
      !hidden &&
      !desktopLocked &&
      screen.getDisplayMatching(door).id ===
        screen.getDisplayMatching(entry.win.getBounds()).id
    )
      animateTo(entry, { x: door.x - 36, y: door.y - 27 }, () =>
        entry.win.destroy(),
      );
    else entry.win.destroy();
  }
}

function applyFramework(value, action) {
  if (action === "sync" && !value.room) {
    bodyCrossDisplay = false;
    bodyInteractions = false;
    publicPerception = false;
  }
  if (value.offline && remoteState) {
    stopLocalWindowTask("disconnect");
    localWindowTaskStatus = undefined;
    follow.stop("disconnect");
    body.update(value, action);
    recoveryPositionPending = bodyProtocol;
    screenRequest(value, action);
    nativeControl?.update(value, action);
    remoteState = {
      ...remoteState,
      connected: false,
      connectionLost: true,
      screenView: undefined,
      interactionsAvailable: false,
      windowTaskStatus: undefined,
      observation: undefined,
      nativeControl: undefined,
      browserControl: undefined,
      attachmentInput: undefined,
      thinking: null,
      activityActor: null,
      knock: null,
      bubbles: {},
      notice: "与管理台断开，正在重连。若持续断开，请确认管理台正在运行。",
      roles: remoteState.roles.map((role) => ({
        ...role,
        activity: "idle",
        bodyStatus: { state: "idle", reason: "disconnect" },
      })),
    };
    room.bubbles = {};
    room.turn = null;
    update();
    return;
  }
  if (action === "sync" && value.room) {
    bodyProtocol = value.bodyProtocol === 2;
    bodyCrossDisplay = bodyProtocol && value.bodyCrossDisplay === true;
    bodyInteractions = bodyProtocol && value.bodyInteractions === true;
    publicPerception = bodyProtocol && value.publicPerception === true;
    observationProtocol = value.observationProtocol === 2;
    recoveryPositionPending = false;
  }
  screenRequest(value, action);
  verifyObservationRequest(value, action);
  nativeControl?.update(value, action);
  if (value.closed) {
    follow.stop("inactive");
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
  if (value.room?.roomEpoch !== remoteState?.roomEpoch)
    localWindowTaskStatus = undefined;
  if (value.room && value.room.roomEpoch !== remoteState?.roomEpoch)
    observationEnded = undefined;
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
    connectionLost: Boolean(value.offline),
    screenView: screenCaptureSupported ? value.room?.screenView : undefined,
    observation: observationProtocol &&
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
  follow.recheck();
  const taskStatus = remoteState.windowTaskStatus;
  if (
    approachedWindowTask &&
    (taskStatus?.id !== approachedWindowTask.id ||
      !["approaching", "ready"].includes(taskStatus.stage) ||
      !approachedWindowTask.current())
  )
    stopLocalWindowTask("inactive", approachedWindowTask.agentId);
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
      const resident = entries.get(role.id);
      if (resident && resident.bodyVisitId !== role.bodyVisitId) {
        resident.bodyVisitId = role.bodyVisitId;
        resident.bodyVisit = {};
        resident.bodyFeedback = undefined;
        resident.pose = "sit";
      }
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
      (entry) =>
        entry.type !== "panel" && !entry.departing && windowVisible(entry),
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
  follow.pointer({ x, y });
  for (const entry of entries.values()) {
    const { win, type, id } = entry;
    if (type === "panel" || entry.departing || !windowVisible(entry)) continue;
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
    space.invalidate();
    // Manual movement of any resident can invalidate the local route.
    follow.stop("manual-control");
    stopLocalWindowTask(
      "manual-control",
      entry.type === "door" ? undefined : entry.id,
    );
    const interrupted =
      entry.type === "door"
        ? [...entries.values()].filter((resident) => resident.bodyAction)
        : entry.bodyAction
          ? [entry]
          : [];
    entry.bodyInputAfter = Date.now();
    if (framework && entry.type === "sprite") {
      manuallyMoved.add(entry.id);
      framework.sync();
    }
    if (entry.type === "door") {
      bodyInputAfter = entry.bodyInputAfter;
      body.clear("manual-control");
      for (const resident of entries.values())
        stopLocalSeat(resident, "manual-control");
    } else {
      body.stop(entry.id, "manual-control");
      stopLocalSeat(entry, "manual-control");
    }
    stopMovement(entry);
    if (interrupted.length) {
      const at = Date.now();
      for (const resident of interrupted)
        resident.bodyFeedback = { reason: "manual-control", at };
      const panel = entries.get("panel");
      if (panel?.ready) send(panel, "room:update", snapshot(true));
    }
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
    if (target.x !== from.x || target.y !== from.y)
      entry.privatePosition = undefined;
    if (action === "drag-end") {
      entry.drag = null;
      space.invalidate();
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
  if (entry)
    return { data: snapshot(entry.type === "panel"), section: entry.section };
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

ipcMain.handle("room:follow", async (event, id, mode) => {
  if (!["pointer", "window", "stop"].includes(mode)) return "unavailable";
  const win = entries.get("panel")?.win;
  const entry = entries.get(id);
  const role = remoteState?.roles.find(({ id: agentId }) => id === agentId);
  if (
    !entry ||
    !win ||
    win.isDestroyed() ||
    !win.isFocused() ||
    event.sender !== win.webContents ||
    event.senderFrame !== win.webContents.mainFrame
  )
    return "unavailable";
  if (mode === "stop") {
    follow.stop("stopped", entry);
    return "stopped";
  }
  const identity = {
    entry,
    roomEpoch: remoteState?.roomEpoch,
    visitId: role?.bodyVisitId,
  };
  const layoutVersion = space.layoutVersion;
  const current = () =>
    !followBlocked(identity) && layoutVersion === space.layoutVersion;
  if (!current()) return "unavailable";

  function start(source, bounds) {
    if (!current()) return "unavailable";
    if (entry.localComboCancel || approachedWindowTask?.agentId === id)
      return "busy";
    entry.bodyInputAfter = Date.now();
    body.stop(id, "manual-control");
    stopLocalSeat(entry, "stopped");
    stopMovement(entry);
    return follow.start({ ...identity, mode, source, bounds });
  }

  if (
    choosingDesktopPermission ||
    entry.localComboCancel ||
    approachedWindowTask?.agentId === id
  )
    return "busy";
  if (mode === "pointer")
    return start(undefined, screen.getCursorScreenPoint());
  if (!geometryDriver) return "unavailable";
  choosingDesktopPermission = true;
  try {
    const windows = await geometryDriver.geometryWindows({
      signal: AbortSignal.timeout(4000),
    });
    if (win.isDestroyed() || !win.isFocused() || !current()) return "cancelled";
    const sources = windows.filter(({ pid }) => pid !== process.pid);
    if (!sources.length) return "no-sources";
    const selection = await desktopSourceMenu(
      win,
      [role],
      sources,
      ({ app, title }) => `${app} · ${title}`,
    );
    if (!selection || win.isDestroyed() || !win.isVisible() || !current())
      return "cancelled";
    const { id: windowId, pid, processInstance, app } = selection.source;
    const source = { id: windowId, pid, processInstance, app };
    const result = await windowGeometry(source, {
      signal: AbortSignal.timeout(2500),
    });
    if (win.isDestroyed() || !win.isVisible() || !current()) return "cancelled";
    if (!result) return "target-unavailable";
    return start(source, result.bounds);
  } catch (error) {
    const reason = geometryFailure(error);
    return reason === "follow-permission" ? "permission" : reason;
  } finally {
    choosingDesktopPermission = false;
  }
});

async function chooseScreenGrant(event, observe = false) {
  const entry = entries.get("panel");
  const win = entry?.win;
  const { roomEpoch } = remoteState ?? {};
  const policyKey = observe ? "observation" : "screenView";
  const command = observe ? "observation" : "screen";
  const screenView = remoteState?.[policyKey];
  if (
    !screenCaptureSupported ||
    (observe && !observationProtocol) ||
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
  if (observe && !observationDriver) return "missing-helper";
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
    let sources = await listScreenSources(observe);
    if (!screenCapturePermission()) return "permission";
    if (observe)
      sources = observationSources(
        sources,
        await observationDriver.observationWindows({
          signal: AbortSignal.timeout(2500),
        }),
        ownScreenSources(),
        process.pid,
      );
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
    let geometrySource;
    if (observe) {
      const { state } = await readObservationTarget(
        selection.source,
        AbortSignal.timeout(3000),
      );
      if (state !== "ready")
        return state === "permission" ? state : "no-sources";
      if (win.isDestroyed() || !win.isVisible() || hidden || desktopLocked)
        return "cancelled";
    } else if (geometryDriver && selection.source.id.startsWith("window:")) {
      const windows = await observationDriver
        .observationWindows({
          signal: AbortSignal.timeout(2500),
        })
        .catch(() => []);
      geometrySource = observationSources(
        sources,
        windows,
        ownScreenSources(),
        process.pid,
      ).find(({ id }) => id === selection.source.id)?.identity;
      if (win.isDestroyed() || !win.isVisible() || hidden || desktopLocked)
        return "cancelled";
    }
    if (
      remoteState?.roomEpoch !== roomEpoch ||
      remoteState?.[policyKey]?.grantedAgentId ||
      !remoteState?.[policyKey]?.eligible.includes(selection.agentId)
    )
      return "unavailable";
    const grant = {
      ...selection,
      ...(geometrySource && { geometrySource }),
      ...(observe && {
        expiresAt: Date.now() + 15 * 60_000,
        controller: new AbortController(),
        probe: Promise.resolve(),
        digests: new Set(),
      }),
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
      observationEnded = undefined;
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
      ) {
        if (observe) {
          grant.monitor = setInterval(() => monitorObservation(grant), 1300);
          monitorObservation(grant);
        }
        return "granted";
      }
      if (current()) clearScreenGrant(observe);
      return "unavailable";
    } catch {
      if (current()) clearScreenGrant(observe);
      return "failed";
    }
  } catch (error) {
    return observe && observationError(error) === "permission"
      ? "permission"
      : "failed";
  } finally {
    choosingDesktopPermission = false;
  }
}
ipcMain.handle("room:screen-view", (event) => chooseScreenGrant(event));
ipcMain.handle("room:observation", (event) => chooseScreenGrant(event, true));

ipcMain.handle("room:observation-review", async (event, action, data) => {
  if (
    !["status", "publish", "save", "discard", "list", "delete"].includes(action)
  )
    return;
  const win = entries.get("panel")?.win;
  const roomEpoch = remoteState?.roomEpoch;
  const focused = () =>
    framework &&
    observationProtocol &&
    !hidden &&
    !desktopLocked &&
    remoteState?.connected &&
    remoteState.roomEpoch === roomEpoch &&
    win &&
    !win.isDestroyed() &&
    win.isFocused() &&
    event.sender === win.webContents &&
    event.senderFrame === win.webContents.mainFrame;
  if (!focused()) return;
  const needsWindow = action === "publish" || action === "save";
  const grant = observationGrant;
  if (needsWindow) {
    if (!grant || !observationCurrent(grant) || grant.state !== "ready") return;
    const { state } = await probeObservation(grant);
    reportObservationState(grant, state);
    if (state !== "ready" || !focused()) return;
  }
  const checkedUntil = Date.now() + 2500;
  const current = () =>
    focused() &&
    (!needsWindow ||
      (observationCurrent(grant) &&
        grant.state === "ready" &&
        Date.now() < checkedUntil));
  try {
    const result = await framework.result(
      "observation-review",
      { action, id: data?.id, agentId: data?.agentId },
      current,
    );
    if (!current() || !result) return;
    if (action === "list" || action === "delete") return result;
    if (!grant || !observationCurrent(grant)) return {};
    return grant.state === "ready" && Date.now() < grant.proofUntil
      ? result
      : { published: result.published };
  } catch {
    // The host owns review expiry and rejects stale actions.
  }
});

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

function editPlace(id, action) {
  if (action === "body-clear-place") {
    places.delete(id);
  } else {
    const entry = controllableResident(
      id,
      remoteState?.roomEpoch,
      entries.get(id)?.bodyVisitId,
    );
    if (!entry) return;
    if (action === "body-go-place") return controlResident(id, action);
    if (entry.movement || entry.privatePosition)
      return recordBodyFeedback(entry, "position-unconfirmed");
    const bounds = entry.win.getBounds();
    const display = screen.getDisplayMatching(bounds);
    const fingerprint = displayFingerprint(display);
    if (!fingerprint) return recordBodyFeedback(entry, "target-unavailable");
    const point = clampPoint(
      bounds,
      bounds.width,
      bounds.height,
      display.workArea,
    );
    if (point.x !== bounds.x || point.y !== bounds.y)
      return recordBodyFeedback(entry, "target-unavailable");
    places.set(id, {
      display: fingerprint,
      x: bounds.x - display.workArea.x,
      y: bounds.y - display.workArea.y,
    });
  }
  savePreferences();
  update();
}

function controlResident(id, action) {
  const entry = entries.get(id);
  if (
    room.members[id] !== "here" ||
    entry?.type !== "sprite" ||
    entry.departing ||
    entry.drag ||
    !windowVisible(entry) ||
    hidden ||
    desktopLocked
  )
    return;
  entry.bodyInputAfter = Date.now();
  follow.stop("stopped", entry);
  stopLocalWindowTask("stopped", id);
  body.stop(id, "stopped");
  stopLocalSeat(entry, "stopped");
  stopMovement(entry);
  if (action === "body-stop") recordBodyFeedback(entry, "stopped");
  if (framework) {
    manuallyMoved.add(id);
    framework.sync();
  }
  if (action === "body-seat" || action === "body-go-place") {
    const place = action === "body-go-place" && savedPlace(id);
    const target =
      action === "body-seat"
        ? { target: "seat" }
        : place?.state === "saved" &&
          space.pointTarget(id, place.displayId, place.point);
    if (!target) return recordBodyFeedback(entry, "target-unavailable");
    const expiresAt = Date.now() + 6000;
    let settled = false;
    const settle = () => {
      settled = true;
      entry.localSeatCancel = undefined;
    };
    const cancel = moveResident(entry, target, {
      current: () =>
        entries.get(id) === entry &&
        !entry.departing &&
        !entry.drag &&
        !hidden &&
        !desktopLocked &&
        windowVisible(entry) &&
        Date.now() < expiresAt,
      expiresAt,
      crossDisplay: true,
      finish: settle,
      fail: (reason) => {
        settle();
        recordBodyFeedback(entry, reason);
      },
    });
    if (!settled) entry.localSeatCancel = cancel;
  }
}

ipcMain.on("room:action", (event, action, data) => {
  const entry = [...entries.values()].find(
    ({ win }) => win.webContents === event.sender,
  );
  if (!entry || entry.departing) return;
  if (
    action === "page-visible" &&
    entry.type !== "panel" &&
    event.senderFrame === entry.win.webContents.mainFrame &&
    typeof data === "boolean"
  ) {
    entry.pageVisible = data;
    windowVisibilityChanged(entry);
    return;
  }
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
            delete positions[role.id];
            savePreferences();
            controlResident(role.id, "body-seat");
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
  if (action === "body-zones") {
    if (
      event.senderFrame === entry.win.webContents.mainFrame &&
      entry.win.isFocused() &&
      !hidden &&
      !desktopLocked
    )
      spaceEditor.open(screen.getDisplayMatching(entry.win.getBounds()));
    return;
  }
  const focused =
    event.senderFrame === entry.win.webContents.mainFrame &&
    entry.win.isFocused();
  if (
    ["body-mark-place", "body-go-place", "body-clear-place"].includes(action)
  ) {
    if (
      focused &&
      role &&
      remoteState?.interactionsAvailable &&
      !hidden &&
      !desktopLocked
    )
      editPlace(role.id, action);
    return;
  }
  if (action === "window-task" || action === "window-task-stop") {
    if (
      !focused ||
      !remoteState?.interactionsAvailable ||
      hidden ||
      desktopLocked
    )
      return;
    if (action === "window-task-stop") {
      localWindowTaskStatus = undefined;
      const status = remoteState.windowTaskStatus;
      if (
        status?.id !== data ||
        !["approaching", "ready"].includes(status.stage)
      )
        return;
      stopLocalWindowTask("stopped", status.agentId);
      body.stop(status.agentId, "stopped");
      void framework.command(action, data).catch(() => {});
      return;
    }
    const { roomEpoch } = remoteState;
    const { agentId, scope, grantId, text } = data ?? {};
    if (
      !["screen", "native"].includes(scope) ||
      typeof text !== "string" ||
      !text.trim() ||
      text.length > 1000
    )
      return;
    const grant = windowTaskGrant(scope, agentId, roomEpoch);
    const resident = controllableResident(
      agentId,
      roomEpoch,
      entries.get(agentId)?.bodyVisitId,
    );
    const fail = () => {
      if (
        remoteState?.roomEpoch !== roomEpoch ||
        ["approaching", "ready"].includes(remoteState.windowTaskStatus?.stage)
      )
        return;
      localWindowTaskStatus = {
        agentId,
        scope,
        stage: "failed",
        reason: "target-unavailable",
      };
      update();
    };
    if (!roles.some(({ id }) => id === agentId)) return;
    if (!resident || !grant || grantId !== grant.grantId) return fail();
    localWindowTaskStatus = undefined;
    void framework
      .command(action, { roomEpoch, agentId, scope, grantId, text })
      .catch(fail);
    return;
  }
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
      if (action === "leave" && role) {
        stopLocalWindowTask("inactive", role.id);
        body.stop(role.id, "inactive");
      }
      if ((action === "activity-pause" && data === true) || action === "send")
        stopLocalWindowTask("stopped");
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
    follow.stop("inactive");
    spaceEditor.close();
    clearScreenGrant(true);
    body.clear("inactive");
    clearScreenGrant();
    nativeControl?.clear();
    void Promise.allSettled([
      (framework ?? live).close(),
      nativeDriver?.close(),
      observationDriver?.close(),
      geometryDriver?.close(),
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
      spaceEditor.close();
      desktopLocked = true;
      clearObservation();
      framework?.sync();
      body.clear("hidden");
      stopLocalMotion("hidden");
      updatePointerPolling();
    });
    powerMonitor.on("unlock-screen", () => {
      desktopLocked = false;
      bodyInputAfter = Date.now();
      for (const entry of entries.values()) updateMotion(entry);
      updatePointerPolling();
    });
    powerMonitor.on("suspend", () => {
      spaceEditor.close();
      desktopLocked = true;
      clearObservation();
      framework?.sync();
      body.clear("hidden");
      stopLocalMotion("hidden");
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
          const results = body.recovery();
          const bodyPositions =
            recoveryPositionPending && remoteState?.roomEpoch
              ? [...entries.values()]
                  .flatMap((entry) => {
                    const position =
                      entry.type === "sprite" &&
                      !entry.privatePosition &&
                      visibleBounds(entry)
                        ? bodyPosition(entry.id).position
                        : undefined;
                    return position ? [{ agentId: entry.id, ...position }] : [];
                  })
                  .slice(0, 24)
              : undefined;
          return {
            visible:
              !hidden &&
              !desktopLocked &&
              [...entries.values()].some(
                (entry) =>
                  entry.type === "sprite" &&
                  !entry.departing &&
                  windowVisible(entry),
              ),
            dragged,
            ...(observationProtocol &&
              observationDriver && {
                observationProtocol: 2,
              }),
            ...(bodyProtocol && {
              bodyProtocol: 2,
              ...(bodyCrossDisplay && { bodyCrossDisplay: true }),
              ...(bodyInteractions && { bodyInteractions: true }),
              ...(publicPerception && {
                bodyPublic: true,
                publicSpace: publicSpace(),
              }),
              ...(results.length && { bodyResults: results }),
              ...(bodyPositions && {
                bodyPositions: {
                  roomEpoch: remoteState.roomEpoch,
                  positions: bodyPositions,
                },
              }),
            }),
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
