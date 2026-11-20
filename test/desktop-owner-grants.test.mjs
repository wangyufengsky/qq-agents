import test from "node:test";
import assert from "node:assert/strict";
import { createBrowserControlHandler } from "../desktop/home/browser-control-handler.mjs";
import { registerNativeControlIpc } from "../desktop/home/native-control-ipc.mjs";

function panel() {
  const webContents = { mainFrame: {} };
  const win = { webContents, isFocused: () => true, isDestroyed: () => false };
  return {
    entries: new Map([["panel", { win }]]),
    event: { sender: webContents, senderFrame: webContents.mainFrame },
  };
}

test("unified browser authorization issues one target and revokes individual grants", async () => {
  const { entries, event } = panel();
  const roomEpoch = "room";
  const first = { agentId: "cat", grantId: "first", targetId: "old-tab" };
  const room = {
    desktopUnified: true,
    roomEpoch,
    browserControl: { targetEligible: ["cat"], grants: [first] },
  };
  const commands = [];
  const ids = ["second", "new-tab"];
  const execute = createBrowserControlHandler({
    entries,
    remoteState: room,
    randomUUID: () => ids.shift(),
    permissionRevision: () =>
      assert.fail("unified grants must not depend on a mode"),
    framework: {
      command: async (name, data) => {
        commands.push({ name, data });
        if (name === "browser-grant") room.browserControl.grants.push(data);
        else
          room.browserControl.grants = room.browserControl.grants.filter(
            ({ grantId }) => grantId !== data.grantId,
          );
        return room;
      },
    },
  });
  assert.equal(
    await execute(event, { type: "grant", agentId: "other" }),
    "unavailable",
  );
  assert.equal(
    await execute(event, { type: "grant", agentId: "cat" }),
    "granted",
  );
  assert.equal(
    await execute(event, { type: "revoke", grantId: "unknown" }),
    "unavailable",
  );
  assert.equal(
    await execute(event, { type: "revoke", grantId: "first" }),
    "revoked",
  );
  assert.deepEqual(commands, [
    {
      name: "browser-grant",
      data: {
        roomEpoch,
        grantId: "second",
        agentId: "cat",
        targetId: "new-tab",
      },
    },
    { name: "browser-revoke", data: { roomEpoch, grantId: "first" } },
  ]);
  assert.deepEqual(
    room.browserControl.grants.map(({ grantId }) => grantId),
    ["second"],
  );
});

test("unified native selection sends a stable window target and rejects a replaced visit", async () => {
  const { entries, event } = panel();
  const source = { pid: process.pid + 1, app: "Editor", title: "Notes" };
  const context = {
    framework: {},
    roles: [{ id: "cat", name: "小猫" }],
    remoteState: {
      desktopUnified: true,
      roomEpoch: "room",
      nativeControl: {
        targetEligible: ["cat"],
        grants: [{ agentId: "cat", grantId: "old-grant" }],
      },
    },
  };
  let execute;
  const sent = [];
  let visit = "visit";
  let replace = true;
  registerNativeControlIpc({
    entries,
    context,
    ipc: { handle: (_, handler) => (execute = handler) },
    permissionRevision: () =>
      assert.fail("unified grants must not depend on a mode"),
    verifiedWindowSurface: false,
    nativeControl: {
      grant: async (grant) => {
        sent.push(grant);
        return "granted";
      },
      revoke: async (...args) => {
        sent.push(args);
        return "revoked";
      },
    },
    screenPickerVisits: () => new Map([["cat", visit]]),
    nativeDriver: {
      listWindows: async ({ unified }) => {
        assert.equal(unified, true);
        return [source];
      },
    },
    desktopSourceMenu: async () => ({ agentId: "cat", source }),
    deniedWindow: () => false,
    dialog: {
      showMessageBox: async () => {
        if (replace) visit = "replacement";
        return { response: 1 };
      },
    },
    localLabel: String,
    identifyTarget: (selected) => {
      assert.equal(selected, source);
      return "stable-window";
    },
  });
  assert.equal(await execute(event, { type: "grant" }), "unavailable");
  replace = false;
  assert.equal(await execute(event, { type: "grant" }), "granted");
  assert.equal(
    await execute(event, { type: "revoke", grantId: "old-grant" }),
    "revoked",
  );
  assert.deepEqual(sent, [
    {
      agentId: "cat",
      source,
      targetId: "stable-window",
      roomEpoch: "room",
      visitId: "replacement",
    },
    ["room", "cat", "old-grant"],
  ]);
});

test("browser request selects a running browser before querying windows and allows rejection", async () => {
  const { entries, event } = panel();
  const request = { target: "browser", requestId: "request", agentId: "cat" };
  const browser = { app: "Google Chrome", pid: process.pid + 1 };
  const window = { ...browser, title: "Fixture" };
  const visits = new Map([["cat", "visit"]]);
  const commands = [];
  let run;
  registerNativeControlIpc({
    ipc: { handle: (_, handler) => (run = handler) },
    entries,
    context: {
      framework: { command: (...args) => commands.push(args) },
      roles: [{ id: "cat", name: "Cat" }],
      remoteState: {
        desktopUnified: true,
        roomEpoch: "room",
        nativeControl: { targetEligible: ["cat"], requests: [request] },
      },
    },
    nativeControl: {
      grant: (input) => {
        assert.equal(input.requestId, request.requestId);
        assert.equal(input.source, window);
        return "granted";
      },
    },
    screenPickerVisits: () => visits,
    nativeDriver: {
      listApplications: async () => [
        { app: "Editor", pid: process.pid + 2 },
        browser,
      ],
      listWindows: async ({ application }) => {
        assert.equal(application, browser);
        return [window];
      },
    },
    desktopSourceMenu: async (_, roles, sources) => {
      assert.equal(sources.length, 1);
      return { agentId: roles[0].id, source: sources[0] };
    },
    deniedWindow: () => false,
    dialog: { showMessageBox: async () => ({ response: 1 }) },
    localLabel: String,
  });
  assert.equal(await run(event, { type: "grant", ...request }), "granted");
  assert.equal(await run(event, { type: "deny", ...request }), "denied");
  assert.deepEqual(commands, [
    ["native-request-deny", { roomEpoch: "room", requestId: "request" }],
  ]);
});
