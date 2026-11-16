import test from "node:test";
import assert from "node:assert/strict";
import { startDesktopLifecycle } from "../desktop/home/lifecycle.mjs";

test("quit waits for clients after revoking permissions and stopping activity", async () => {
  const listeners = new Map();
  const calls = [];
  let finishClose;
  const context = {
    framework: {
      close: () =>
        new Promise((resolve) => {
          finishClose = resolve;
        }),
    },
  };
  const app = {
    requestSingleInstanceLock: () => true,
    on: (name, handler) => listeners.set(name, handler),
    whenReady: () => new Promise(() => {}),
    quit: () => calls.push("quit"),
  };
  startDesktopLifecycle({
    context,
    app,
    showDoor() {},
    follow: { stop: () => calls.push("follow") },
    spaceEditor: { close: () => calls.push("editor") },
    clearVisualPermissions: () => calls.push("permissions"),
    body: { clear: () => calls.push("body") },
    nativeControl: { clear: () => calls.push("native") },
  });
  listeners.get("before-quit")({ preventDefault: () => calls.push("prevent") });
  assert.equal(context.shuttingDown, true);
  assert.deepEqual(calls, [
    "prevent",
    "follow",
    "editor",
    "permissions",
    "body",
    "native",
  ]);
  finishClose();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.at(-1), "quit");
});
