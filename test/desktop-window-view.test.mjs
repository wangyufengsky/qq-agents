import test from "node:test";
import assert from "node:assert/strict";
import { createWindowView } from "../desktop/home/window-view.mjs";

test("hide revokes permission and clears motion before hiding windows", () => {
  const calls = [];
  const context = {
    hidden: false,
    framework: { sync: () => calls.push("sync") },
  };
  const view = createWindowView({
    context,
    entries: new Map([["door", { win: { hide: () => calls.push("hide") } }]]),
    spaceEditor: { close: () => calls.push("editor") },
    invalidatePermissions: () => calls.push("revoke"),
    body: { clear: () => calls.push("body") },
    follow: { stop: () => calls.push("follow") },
    stopLocalWindowTask: () => calls.push("task"),
    stopLocalSeat: () => calls.push("seat"),
    stopMovement: () => calls.push("movement"),
    updatePointerPolling: () => calls.push("pointer"),
  });
  view.hideAll();
  assert.equal(context.hidden, true);
  assert.deepEqual(calls, [
    "editor",
    "revoke",
    "sync",
    "body",
    "follow",
    "task",
    "seat",
    "movement",
    "hide",
    "pointer",
  ]);
});
