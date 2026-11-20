import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desktopBodyBounds } from "../desktop/home/window-placement.mjs";
import {
  createPreferencesStore,
  readDesktopPreferences,
  writeDesktopPreferences,
} from "../desktop/home/preferences.mjs";
import { desktopResourcePath } from "../desktop/home/resource-protocol.mjs";
import { createObservationMonitor } from "../desktop/home/observation-monitor.mjs";

test("preferences recover from missing or invalid data and persist atomically", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "nest-preferences-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createPreferencesStore(directory);
  assert.deepEqual(store.read(), {});
  await writeFile(join(directory, "prototype-preferences.json"), "bad json");
  assert.deepEqual(store.read(), {});
  store.write({ minutes: 20, positions: { cat: { x: 4, y: 8 } } });
  assert.equal(store.read().positions.cat.x, 4);
  for (const spriteSize of [undefined, "100", 0, 305]) {
    store.write({ ...store.read(), spriteSize });
    assert.equal(readDesktopPreferences(store).spriteSize, 100);
  }
  for (const idleFrequency of [undefined, "2", 0.5, 3]) {
    store.write({ ...store.read(), idleFrequency });
    assert.equal(readDesktopPreferences(store).idleFrequency, 0);
  }
  writeDesktopPreferences(store, {
    ...readDesktopPreferences(store),
    minutes: 20,
    spriteSize: 125,
    idleFrequency: -2,
  });
  const restored = readDesktopPreferences(store);
  assert.equal(restored.spriteSize, 125);
  assert.equal(restored.idleFrequency, -2);
  assert.deepEqual(restored.positions.cat, { x: 4, y: 8 });
  const origin = { x: 10, y: 20 };
  const body = desktopBodyBounds("sprite", origin);
  const larger = desktopBodyBounds("sprite", origin, restored.spriteSize);
  assert.equal(larger.x + larger.width / 2, body.x + body.width / 2);
  assert.equal(larger.y + larger.height, body.y + body.height);
  assert.equal(larger.width, body.width * 1.25);
  assert.deepEqual(
    desktopBodyBounds("door", origin, 125),
    desktopBodyBounds("door", origin),
  );
  await assert.rejects(
    readFile(join(directory, "prototype-preferences.json.next")),
  );
});

test("desktop protocol only exposes packaged renderer assets", () => {
  const release = join(tmpdir(), "nest-resource-fixture");
  const source = join(release, "desktop", "home");
  assert.equal(
    desktopResourcePath("nest://app/desktop/home/renderer-panel.js", source),
    join(source, "renderer-panel.js"),
  );
  assert.equal(
    desktopResourcePath(
      "nest://app/public/home-preview/assets/room-board.webp",
      source,
    ),
    join(release, "public", "home-preview", "assets", "room-board.webp"),
  );
  for (const url of [
    "nest://other/desktop/home/index.html",
    "nest://app/desktop/home/preload.cjs",
    "nest://app/desktop/home/%2e%2e/main.mjs",
    "https://app/desktop/home/index.html",
  ])
    assert.equal(desktopResourcePath(url, source), undefined);
});

test("observation monitoring prevents concurrent probes and expires display grants", async () => {
  const calls = [];
  let resolve;
  const grant = { grantId: "g", display: true, expiresAt: 5 };
  let active = true;
  const monitor = createObservationMonitor({
    current: () => active,
    local: () => grant,
    probe: () => {
      calls.push("probe");
      return new Promise((done) => {
        resolve = done;
      });
    },
    report: (_, state) => calls.push(state),
    remove: () => calls.push("remove"),
    clear: () => calls.push("clear"),
    sync: () => calls.push("sync"),
    now: () => 6,
  });
  monitor(grant);
  monitor(grant);
  assert.deepEqual(calls, ["probe"]);
  resolve({ state: "ready" });
  await new Promise((done) => setImmediate(done));
  active = false;
  monitor(grant);
  assert.deepEqual(calls, ["probe", "ready", "remove", "sync"]);
});

test("window manager preserves sandbox and window lifecycle", async () => {
  const { EventEmitter } = await import("node:events");
  const { createWindowManager } =
    await import("../desktop/home/window-manager.mjs");
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = (handler) => {
        this.openHandler = handler;
      };
    }
    loadURL(url) {
      this.url = url;
    }
    showInactive() {
      this.shown = true;
    }
  }
  const entries = new Map();
  const events = [];
  const create = createWindowManager({
    BrowserWindow: FakeWindow,
    source: "/app/desktop/home",
    sizes: { sprite: [100, 100] },
    clampPoint: (point) => point,
    entries,
    send: () => {},
    snapshot: () => ({}),
    updateMotion: () => events.push("motion"),
    updatePointerPolling: () => events.push("pointer"),
    windowVisibilityChanged: () => events.push("visibility"),
    isHidden: () => false,
    onClosed: () => events.push("closed"),
  });
  const entry = create("cat", "sprite", { x: 1, y: 2 });
  assert.equal(entry.win.options.webPreferences.sandbox, true);
  assert.equal(entry.win.options.webPreferences.nodeIntegration, false);
  assert.deepEqual(entry.win.openHandler(), { action: "deny" });
  assert.match(entry.win.url, /^nest:\/\/app\/desktop\/home\/index\.html\?/);
  entry.win.emit("ready-to-show");
  assert.equal(entry.win.shown, true);
  entry.win.emit("hide");
  entry.win.emit("closed");
  assert.equal(entries.has("cat"), false);
  assert.ok(events.includes("visibility"));
  assert.ok(events.includes("closed"));
});

test("IPC router resolves only the sender's registered window", async () => {
  const { createIpcRouter } = await import("../desktop/home/ipc-router.mjs");
  const handlers = new Map();
  const sender = {};
  const entry = { win: { webContents: sender } };
  const router = createIpcRouter(
    {
      handle: (channel, handler) => handlers.set(channel, handler),
      on: (channel, handler) => handlers.set(channel, handler),
    },
    new Map([["cat", entry]]),
  );
  router.handle("room:get", (event) => router.entryFor(event));
  assert.equal(handlers.get("room:get")({ sender }), entry);
  assert.equal(handlers.get("room:get")({ sender: {} }), undefined);
  sender.mainFrame = {};
  assert.equal(
    router.actionEntry({ sender, senderFrame: sender.mainFrame }),
    entry,
  );
  assert.equal(router.actionEntry({ sender, senderFrame: {} }), undefined);
  entry.departing = true;
  assert.equal(
    router.actionEntry({ sender, senderFrame: sender.mainFrame }),
    undefined,
  );
});

test("observation review refuses stale or unfocused renderer requests", async () => {
  const { createObservationReviewHandler } =
    await import("../desktop/home/observation-review-handler.mjs");
  const sender = { mainFrame: {} };
  const win = {
    webContents: sender,
    isDestroyed: () => false,
    isFocused: () => true,
  };
  const state = {
    entries: new Map([["panel", { win }]]),
    remoteState: { roomEpoch: "one", connected: true },
    observationProtocol: true,
    framework: {
      result: async () => {
        state.remoteState.roomEpoch = "two";
        return { replies: [] };
      },
    },
  };
  const handler = createObservationReviewHandler(state);
  assert.equal(
    await handler({ sender: {}, senderFrame: sender.mainFrame }, "status"),
    undefined,
  );
  assert.equal(
    await handler({ sender, senderFrame: sender.mainFrame }, "status"),
    undefined,
  );
});

test("browser grant is refused when room eligibility changes during confirmation", async () => {
  const { createBrowserControlHandler } =
    await import("../desktop/home/browser-control-handler.mjs");
  const sender = { mainFrame: {} };
  const win = {
    webContents: sender,
    isFocused: () => true,
    isDestroyed: () => false,
    isVisible: () => true,
  };
  const state = {
    entries: new Map([["panel", { win }]]),
    remoteState: { roomEpoch: "one", browserControl: { eligible: ["cat"] } },
    roles: [{ id: "cat", name: "猫" }],
    framework: {
      command: () => {
        throw new Error("must not grant");
      },
    },
    parseBrowserOrigin: (value) => value,
    localLabel: (value) => value,
    randomUUID: () => "id",
    dialog: {
      showMessageBox: async () => {
        state.remoteState.roomEpoch = "two";
        return { response: 1 };
      },
    },
  };
  const handler = createBrowserControlHandler(state);
  assert.equal(
    await handler(
      { sender, senderFrame: sender.mainFrame },
      { agentId: "cat", origin: "https://example.com" },
    ),
    "unavailable",
  );
  assert.equal(state.choosingDesktopPermission, false);
});
