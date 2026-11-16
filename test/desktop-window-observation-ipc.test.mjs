import test from "node:test";
import assert from "node:assert/strict";
import { registerWindowObservationIpc } from "../desktop/home/window-observation-ipc.mjs";

test("window observation does not enumerate targets without the current view permission", async () => {
  const handlers = new Map();
  let enumerations = 0;
  registerWindowObservationIpc({
    ipc: { handle: (name, handler) => handlers.set(name, handler) },
    context: {},
    entries: new Map(),
    permissionRevision: () => undefined,
    listScreenSources: () => {
      enumerations++;
    },
  });
  assert.equal(await handlers.get("room:observation")({}), "unavailable");
  assert.equal(enumerations, 0);
});
