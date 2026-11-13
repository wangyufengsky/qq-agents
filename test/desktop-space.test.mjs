import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopExclusionStore, DesktopSpace } from "../desktop/home/space.mjs";

const area = { x: 0, y: 24, width: 900, height: 600 };
const primary = {
  id: 101,
  label: "Primary",
  internal: true,
  workArea: area,
  scaleFactor: 2,
};
const secondary = {
  id: 102,
  label: "Secondary",
  internal: false,
  workArea: { x: -800, y: 0, width: 800, height: 600 },
  scaleFactor: 1,
};
const box = (x, y) => ({ x, y, width: 100, height: 80 });
const role = (id, x, y, options) => ({
  id,
  visit: {},
  bounds: box(x, y),
  ...options,
});

function desktop(overrides = {}) {
  const state = {
    displays: [primary, secondary],
    residents: [role("self", 40, 120)],
    door: box(780, 500),
    seat: { x: 580, y: 455 },
    zones: [],
    ...overrides,
  };
  const space = new DesktopSpace({
    displays: () => state.displays,
    displayAt: ({ x, width }) =>
      state.displays[x + width / 2 < 0 && state.displays.length > 1 ? 1 : 0],
    door: () => state.door,
    residents: () => state.residents,
    seat: () => state.seat,
    zones: () => state.zones,
  });
  return { space, state };
}

const position = (space, x, y) => {
  const { layoutVersion, self } = space.snapshot("self");
  return {
    layoutVersion,
    target: { type: "point", displayRef: self.displayRef, x, y },
  };
};

test("snapshots expose only the current display, same-screen door and residents", () => {
  const { space, state } = desktop({
    residents: [
      role("self", -720, 80, { facing: "left", pose: "sit" }),
      role("neighbor", -400, 90, { name: "邻居" }),
      role("elsewhere", 200, 80),
    ],
  });
  const snapshot = space.snapshot("self");
  const ref = snapshot.residents[0].ref;
  assert.equal(snapshot.displays.length, 1);
  assert.deepEqual(snapshot.displays[0].workArea, secondary.workArea);
  assert.equal(snapshot.self.displayRef, snapshot.displays[0].ref);
  assert.equal(snapshot.self.facing, "left");
  assert.equal(snapshot.self.pose, "sit");
  assert.equal(snapshot.door, undefined);
  assert.equal(snapshot.residents.length, 1);
  assert.equal(snapshot.residents[0].name, "邻居");
  assert.equal(Object.hasOwn(snapshot.residents[0], "id"), false);
  assert.equal(space.snapshot("self").residents[0].ref, ref);

  const near = {
    target: { type: "near-resident", residentRef: ref },
    layoutVersion: snapshot.layoutVersion,
  };
  state.residents[1] = role("neighbor", -400, 90);
  assert.deepEqual(space.plan("self", near), { reason: "stale-layout" });
  const next = space.snapshot("self");
  assert.notEqual(next.residents[0].ref, ref);
  assert.deepEqual(
    space.plan("self", { ...near, layoutVersion: next.layoutVersion }),
    {
      reason: "target-unavailable",
    },
  );
});

test("point validation honors whole-window work area and invalidates stale layouts", () => {
  const { space, state } = desktop();
  const move = position(space, 660, 500);
  const plan = space.plan("self", move);
  assert.deepEqual(plan.path, [{ x: 660, y: 500 }]);
  plan.release();
  for (const point of [
    [-100, 300],
    [800, 23],
    [801, 300],
    [710, 545],
  ]) {
    assert.deepEqual(space.plan("self", position(space, ...point)), {
      reason: "target-unavailable",
    });
  }
  assert.deepEqual(
    space.plan("self", {
      ...move,
      target: { ...move.target, displayRef: "other-display" },
    }),
    { reason: "target-unavailable" },
  );
  state.displays[0] = { ...primary, workArea: { ...area, y: 44, height: 580 } };
  assert.deepEqual(space.plan("self", move), { reason: "stale-layout" });
  const { layoutVersion, self } = space.snapshot("self");
  const corner = space.plan("self", {
    layoutVersion,
    target: { type: "corner", displayRef: self.displayRef, corner: "nw" },
  });
  assert.deepEqual(corner.path, [{ x: 0, y: 44 }]);
  space.invalidate();
  assert.equal(space.canStep("self", corner.path[0], corner), false);
  assert.deepEqual(space.plan("self", { target: "seat" }, { replan: corner }), {
    reason: "stale-layout",
  });
});

test("legacy clear-space targets preserve their destinations and near targets use live geometry", () => {
  const { space, state } = desktop();
  const seat = space.plan("self", { target: "seat" });
  assert.deepEqual(seat.path, [state.seat]);
  seat.release();
  const door = space.plan("self", { target: "door" });
  assert.deepEqual(door.path, [{ x: 668, y: 500 }]);
  door.release();

  state.residents.push(role("neighbor", 400, 140));
  const {
    layoutVersion,
    residents: [{ ref }],
  } = space.snapshot("self");
  const action = {
    target: { type: "near-resident", residentRef: ref },
    layoutVersion,
  };
  const near = space.plan("self", action);
  assert.deepEqual(near.path, [{ x: 288, y: 140 }]);
  state.residents[1].bounds = box(430, 145);
  assert.equal(space.canStep("self", near.path[0], near), false);
  const replacement = space.plan("self", action, { replan: near });
  assert.deepEqual(replacement.path, [{ x: 318, y: 145 }]);
  near.release();
  assert.equal(space.canStep("self", replacement.path[0], replacement), true);
});

test("legacy seat moves to the nearest clear point when the saved seat overlaps the door", () => {
  const { space, state } = desktop({ seat: { x: 720, y: 510 } });
  const seat = space.plan("self", { target: "seat" });
  assert.deepEqual(seat.path, [{ x: 668, y: 510 }]);
  assert.deepEqual(state.seat, { x: 720, y: 510 });
  seat.release();
  state.door = undefined;
  assert.deepEqual(space.plan("self", { target: "seat" }).path, [state.seat]);
});

test("routing detours around swept occupancy and fails when a new obstacle blocks the destination", () => {
  const { space, state } = desktop({
    residents: [role("self", 40, 250), role("neighbor", 350, 240)],
  });
  const action = position(space, 660, 250);
  const plan = space.plan("self", action);
  assert.ok(plan.path.length > 1 && plan.path.length <= 4);
  assert.equal(space.canStep("self", plan.path.at(-1), plan), false);
  for (const next of plan.path) {
    assert.equal(space.canStep("self", next, plan), true);
    state.residents[0].bounds = box(next.x, next.y);
  }
  state.residents[1].bounds = box(650, 255);
  assert.equal(space.canStep("self", plan.path.at(-1), plan), false);
  assert.deepEqual(space.plan("self", action, { replan: plan }), {
    reason: "target-blocked",
  });
});

test("concurrent moves reserve the full destination until it is released", () => {
  const { space } = desktop({
    residents: [role("self", 40, 70), role("neighbor", 40, 420)],
  });
  const first = space.plan("self", position(space, 400, 250));
  const other = {
    layoutVersion: first.layoutVersion,
    target: { type: "point", ...first.destination, x: 500 },
  };
  assert.deepEqual(space.plan("neighbor", other), { reason: "target-blocked" });
  first.release();
  const second = space.plan("neighbor", other);
  assert.ok(second.path.length);
  first.release();
  assert.equal(space.canStep("neighbor", second.path[0], second), true);
});

test("a manual overlap can exit on a reachable edge without traversing the obstacle", () => {
  const { space } = desktop({
    residents: [role("self", 0, 520), role("neighbor", 10, 520)],
  });
  const plan = space.plan("self", position(space, 0, 250));
  assert.deepEqual(plan.path, [{ x: 0, y: 250 }]);
  assert.equal(space.canStep("self", { x: 55, y: 520 }, plan), false);
  assert.equal(space.canStep("self", { x: 0, y: 500 }, plan), true);
});

test("exclusions are persisted relative to their display and never follow another display", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qq-desktop-exclusions-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "exclusions.json");
  writeFileSync(path, '[null,{"fingerprint":"invalid","zones":[]}]');
  const store = new DesktopExclusionStore(path);
  const zones = [{ x: 0.38, y: 0, width: 0.24, height: 1 }];
  assert.equal(
    store.save(primary, [{ x: 0, y: 0, width: 2, height: 1 }]),
    false,
  );
  assert.equal(store.save({ ...primary, id: -10 }, zones), false);
  assert.equal(store.save(primary, zones), true);
  const saved = new DesktopExclusionStore(path);
  assert.deepEqual(saved.list(), store.list());
  assert.equal(readFileSync(path, "utf8").includes(primary.label), false);
  const { space, state } = desktop({ zones: saved.list() });
  const move = position(space, 660, 250);
  assert.deepEqual(space.plan("self", move), { reason: "target-blocked" });

  state.displays = [{ ...primary, id: 103 }];
  const clear = space.plan("self", position(space, 660, 250));
  assert.deepEqual(clear.path, [{ x: 660, y: 250 }]);
  clear.release();

  state.displays = [{ ...primary, workArea: { ...area, width: 700 } }];
  const restored = space.plan("self", position(space, 290, 250));
  assert.deepEqual(restored, { reason: "target-blocked" });
  assert.equal(saved.save(primary, []), true);
  assert.deepEqual(new DesktopExclusionStore(path).list(), []);
});
