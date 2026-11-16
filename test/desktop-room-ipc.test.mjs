import test from "node:test";
import assert from "node:assert/strict";
import { registerRoomIpc } from "../desktop/home/room-ipc.mjs";

test("room IPC limits replies to the target and panel snapshots to the panel", async () => {
  const handlers = new Map();
  const calls = [];
  const entry = {
    type: "sprite",
    id: "a",
    win: { isFocused: () => true, setFocusable() {}, focus() {} },
  };
  const context = {
    remoteState: {
      connected: true,
      roomEpoch: "r",
      recentBubbles: [{ bubbleId: "b", actor: "a", canReply: true }],
    },
    framework: {
      command: (...args) => {
        calls.push(args);
        return true;
      },
    },
  };
  registerRoomIpc({
    ipc: {
      handle: (name, handler) => handlers.set(name, handler),
      actionEntry: () => entry,
      entryFor: () => entry,
    },
    context,
    updatePointerRegions() {},
    windowVisible: () => true,
    snapshot: (panel) => ({ panel }),
  });
  const reply = handlers.get("room:bubble-reply");
  assert.equal(
    await reply({}, "open", { roomEpoch: "r", bubbleId: "b" }),
    true,
  );
  assert.equal(
    await reply({}, "send", { roomEpoch: "r", bubbleId: "b", text: "hello" }),
    true,
  );
  context.remoteState.roomEpoch = "next";
  assert.equal(
    await reply({}, "send", { roomEpoch: "r", bubbleId: "b", text: "late" }),
    false,
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(handlers.get("room:get")({}).data, { panel: false });
  entry.type = "panel";
  assert.deepEqual(handlers.get("room:get")({}).data, { panel: true });
});
