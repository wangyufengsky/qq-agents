import test from "node:test";
import assert from "node:assert/strict";
import { registerPersonalIpc } from "../desktop/home/personal-ipc.mjs";

test("door drop rechecks the selected resident after the choice dialog", async () => {
  const handlers = new Map();
  const entry = { type: "door", win: {} };
  const commands = [];
  const context = {
    remoteState: {
      connected: true,
      roomEpoch: "r",
      roles: [{ id: "a", name: "A", state: "here", bodyVisitId: "v" }],
    },
    framework: { personal: (...args) => commands.push(args) },
  };
  registerPersonalIpc({
    ipc: {
      on: (name, handler) => handlers.set(name, handler),
      handle: (name, handler) => handlers.set(name, handler),
      actionEntry: () => entry,
    },
    context,
    dialog: {
      showMessageBox: async () => {
        context.remoteState.roomEpoch = "next";
        return { response: 0 };
      },
    },
    showPanel() {},
    entries: new Map(),
    send() {},
  });
  await handlers.get("room:personal-drop")(
    {},
    { fileCount: 0, text: "private" },
  );
  assert.deepEqual(commands, []);
});
