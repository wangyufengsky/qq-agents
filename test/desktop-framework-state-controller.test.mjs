import test from "node:test";
import assert from "node:assert/strict";
import { createFrameworkStateController } from "../desktop/home/framework-state-controller.mjs";

test("disconnect clears visual permissions and marks the room unavailable", () => {
  const calls = [];
  const context = {
    remoteState: { roles: [{ id: "a" }], roomEpoch: "r" },
    bodyProtocol: true,
  };
  const controller = createFrameworkStateController({
    context,
    body: { update: () => calls.push("body") },
    clearVisualPermissions: () => calls.push("visual"),
    nativeControl: { clear: () => calls.push("native"), update() {} },
    stopLocalWindowTask: () => calls.push("task"),
    follow: { stop: () => calls.push("follow") },
    screenRequest: () => calls.push("capture"),
    room: {},
    update: () => calls.push("render"),
  });
  controller.applyFramework({ offline: true }, "sync");
  assert.equal(context.remoteState.connected, false);
  assert.equal(context.remoteState.observation, undefined);
  assert.equal(context.recoveryPositionPending, true);
  assert.deepEqual(calls, [
    "visual",
    "native",
    "task",
    "follow",
    "body",
    "capture",
    "render",
  ]);
});
