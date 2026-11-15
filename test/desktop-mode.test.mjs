import test from "node:test";
import assert from "node:assert/strict";
import { DesktopHost } from "../src/home/desktop-host.mjs";

function fixture() {
  const cleared = [];
  const host = { mode: null, stopWindowTask: () => cleared.push("task") };
  for (const name of ["observation", "screen", "native", "browser"])
    host[name] = { clear: () => cleared.push(name) };
  host.invalidateMode = DesktopHost.prototype.invalidateMode;
  host.setMode = DesktopHost.prototype.setMode;
  return { host, cleared };
}

test("mode transitions revoke controls before retaining read grants", () => {
  const { host, cleared } = fixture();
  host.setMode("work");
  assert.deepEqual(cleared, [
    "task",
    "observation",
    "screen",
    "native",
    "browser",
  ]);
  cleared.length = 0;
  host.setMode("presence");
  assert.deepEqual(cleared, ["task", "native", "browser"]);
  cleared.length = 0;
  host.setMode("privacy");
  assert.deepEqual(cleared, [
    "task",
    "observation",
    "screen",
    "native",
    "browser",
  ]);
  assert.equal(host.mode, "privacy");
});

test("invalidation clears grants without forgetting selected mode", () => {
  const { host, cleared } = fixture();
  host.mode = "work";
  host.invalidateMode();
  assert.equal(host.mode, "work");
  assert.deepEqual(cleared, [
    "task",
    "observation",
    "screen",
    "native",
    "browser",
  ]);
});
