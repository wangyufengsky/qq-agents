import assert from "node:assert/strict";
import test from "node:test";
import { DesktopFollow } from "../desktop/home/follow.mjs";

function fixture(t, readWindow) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const events = [];
  let blocked;
  const follow = new DesktopFollow({
    blocked: () => blocked,
    display: ({ x }) => x >= 0,
    readWindow,
    now: () => Date.now(),
    changed: ({ id }, reason) => events.push(["changed", id, reason]),
    move: ({ entry }, bounds, current) => {
      events.push(["move", entry.id, bounds, current()]);
      return () => events.push(["cancel", entry.id]);
    },
  });
  t.after(() => follow.stop("inactive"));
  return {
    follow,
    events,
    block(reason) {
      blocked = reason;
    },
    advance(ms) {
      t.mock.timers.tick(ms);
    },
  };
}

test("pointer following coalesces changes and is stopped by resident state", (t) => {
  const { follow, events, block, advance } = fixture(t);
  const entry = { id: "fish" };
  const bounds = { x: 300, y: -150 };
  assert.equal(follow.start({ entry, mode: "pointer", bounds }), "started");
  assert.deepEqual(follow.snapshot(entry), { mode: "pointer", until: 120_000 });
  assert.equal(follow.snapshot({ id: "fish" }), undefined);
  follow.pointer({ x: 390, y: -140 });
  advance(180);
  follow.pointer({ x: 307, y: -145 });
  advance(180);
  follow.pointer({ x: 320, y: -140 });
  assert.deepEqual(events, [
    ["changed", "fish", undefined],
    ["move", "fish", { ...bounds, width: 1, height: 1 }, true],
    ["cancel", "fish"],
    ["move", "fish", { x: 320, y: -140, width: 1, height: 1 }, true],
  ]);
  block("follow-qq");
  follow.recheck();
  assert.deepEqual(events.slice(-2), [
    ["cancel", "fish"],
    ["changed", "fish", "follow-qq"],
  ]);
  assert.equal(follow.snapshot(entry), undefined);
});

test("a revoked window mode aborts an outstanding read and never moves on its late result", async (t) => {
  const entry = { id: "fish" };
  const bounds = { x: 300, y: 100, width: 190, height: 80 };
  const target = {
    id: "w-18",
    pid: 35,
    processInstance: "stable",
    app: "Test",
  };
  let controllerSignal;
  let resolveBounds;
  const { follow, events, advance } = fixture(t, (source, signal) => {
    assert.equal(source, target);
    controllerSignal = signal;
    return new Promise((resolve) => {
      resolveBounds = resolve;
    });
  });
  follow.start({ entry, mode: "window", source: target, bounds });
  advance(1300);
  assert.equal(controllerSignal.aborted, false);
  follow.stop("stopped", entry);
  assert.equal(controllerSignal.aborted, true);
  resolveBounds({ ...bounds, width: 400 });
  await Promise.resolve();
  assert.equal(events.filter(([kind]) => kind === "move").length, 1);
  assert.equal(follow.snapshot(entry), undefined);
});

test("window follow replans after resize and exits when the window is minimized", async (t) => {
  const entry = { id: "fish" };
  const bounds = { x: 300, y: 100, width: 190, height: 80 };
  const resized = { ...bounds, width: 220, height: 165 };
  let reads = 0;
  const { follow, events, advance } = fixture(t, async () => {
    if (++reads === 1) return resized;
    throw Error("DESKTOP_NATIVE_TARGET_MINIMIZED");
  });
  follow.start({ entry, mode: "window", source: {}, bounds });
  advance(650);
  await Promise.resolve();
  assert.deepEqual(events.slice(-2), [
    ["cancel", "fish"],
    ["move", "fish", resized, true],
  ]);
  advance(650);
  await Promise.resolve();
  assert.equal(follow.active(entry), false);
  assert.deepEqual(events.slice(-2), [
    ["cancel", "fish"],
    ["changed", "fish", "follow-target-minimized"],
  ]);
});

test("modes stop after two minutes and replace the selected resident", (t) => {
  const { follow, events, advance } = fixture(t);
  const first = { id: "fish" };
  const second = { id: "cat" };
  const bounds = { x: 300, y: 160 };
  follow.start({ entry: first, mode: "pointer", bounds });
  advance(2000);
  follow.start({ entry: second, mode: "pointer", bounds });
  assert.equal(follow.snapshot(first), undefined);
  assert.equal(follow.snapshot(second)?.until, 122_000);
  advance(118_000);
  assert.ok(follow.active(second));
  advance(2000);
  assert.equal(follow.active(second), false);
  assert.deepEqual(events.at(-1), ["changed", "cat", "follow-expired"]);
});

test("a display crossing stops following inside the pointer dead zone", (t) => {
  const { follow, events, advance } = fixture(t);
  const entry = { id: "fish" };
  follow.start({ entry, mode: "pointer", bounds: { x: 2, y: 160 } });
  advance(180);
  follow.pointer({ x: -1, y: 160 });
  assert.equal(follow.active(entry), false);
  assert.deepEqual(events.at(-1), ["changed", "fish", "target-unreachable"]);
});
