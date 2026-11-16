import test from "node:test";
import assert from "node:assert/strict";
import { registerReadGrantsIpc } from "../desktop/home/read-grants-ipc.mjs";

test("read grants reject a stale permission panel before opening capture sources", async () => {
  const handlers = new Map();
  let enumerations = 0;
  const context = {
    remoteState: { roomEpoch: "r" },
    batchScreenGrants: true,
    displayObservation: true,
  };
  registerReadGrantsIpc({
    ipc: { handle: (name, handler) => handlers.set(name, handler) },
    context,
    displayGrants: new Map(),
    screenGrants: new Map(),
    permissionRevision: () => 1,
    verifiedWindowSurface: true,
    screenCaptureSupported: true,
    permissionPanel: () => false,
    listScreenSources: () => {
      enumerations++;
    },
  });
  assert.deepEqual(await handlers.get("room:screen-view")({}, "grant", {}), {
    status: "unavailable",
  });
  assert.deepEqual(
    await handlers.get("room:display-observation")({}, "grant", {}),
    { status: "unavailable" },
  );
  assert.equal(enumerations, 0);
});
