import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DesktopExclusionStore,
  DesktopSpace,
  displayFingerprint,
} from "../desktop/home/space.mjs";

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
    displayAt: ({ x, y, width, height }) =>
      state.displays.reduce(
        (best, display) => {
          const area = display.workArea;
          const overlap =
            Math.max(
              0,
              Math.min(x + width, area.x + area.width) - Math.max(x, area.x),
            ) *
            Math.max(
              0,
              Math.min(y + height, area.y + area.height) - Math.max(y, area.y),
            );
          return overlap > best.overlap ? { display, overlap } : best;
        },
        { display: state.displays[0], overlap: 0 },
      ).display,
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
  const options = { crossDisplay: false };
  const snapshot = space.snapshot("self", options);
  const ref = snapshot.residents[0].ref;
  assert.equal(snapshot.displays.length, 1);
  assert.deepEqual(snapshot.displays[0].workArea, secondary.workArea);
  assert.equal(snapshot.self.displayRef, snapshot.displays[0].ref);
  assert.equal(snapshot.self.facing, "left");
  assert.equal(snapshot.self.pose, "sit");
  assert.equal(snapshot.door, undefined);
  assert.equal(snapshot.residents.length, 1);
  assert.deepEqual(space.plan("self", { target: "door" }, options), {
    reason: "target-unavailable",
  });
  assert.equal(snapshot.residents[0].name, "邻居");
  assert.equal(Object.hasOwn(snapshot.residents[0], "id"), false);
  assert.equal(space.snapshot("self", options).residents[0].ref, ref);

  const near = {
    target: { type: "near-resident", residentRef: ref },
    layoutVersion: snapshot.layoutVersion,
  };
  state.residents[1] = role("neighbor", -400, 90);
  assert.deepEqual(space.plan("self", near, options), {
    reason: "stale-layout",
  });
  const next = space.snapshot("self", options);
  assert.notEqual(next.residents[0].ref, ref);
  assert.deepEqual(
    space.plan("self", { ...near, layoutVersion: next.layoutVersion }, options),
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

function walk(space, state, plan, id = "self") {
  assert.ok(plan.path?.length, JSON.stringify(plan));
  const resident = state.residents.find((resident) => resident.id === id);
  for (const next of plan.path) {
    const { x, y } = resident.bounds;
    const steps = Math.ceil(
      Math.max(Math.abs(next.x - x), Math.abs(next.y - y)) / 9,
    );
    for (let i = 1; i <= steps; i++) {
      const step = {
        x: Math.round(x + (next.x - x) * (i / steps)),
        y: Math.round(y + (next.y - y) * (i / steps)),
      };
      assert.equal(space.canStep(id, step, plan), true, JSON.stringify(step));
      resident.bounds = box(step.x, step.y);
    }
  }
}

function onDisplay(space, display, target) {
  const { layoutVersion, displays } = space.snapshot("self");
  const { ref } = displays.find(
    ({ workArea }) => workArea === display.workArea,
  );
  return { layoutVersion, target: { displayRef: ref, ...target } };
}

test("crossing uses negative DIP coordinates and preserves layout revision and references", () => {
  const { space, state } = desktop({
    residents: [role("self", 40, 200), role("neighbor", 500, 200)],
  });
  const snapshot = space.snapshot("self");
  assert.equal(snapshot.displays.length, 2);
  assert.deepEqual(
    snapshot.displays.map(({ scaleFactor }) => scaleFactor),
    [2, 1],
  );
  assert.deepEqual(snapshot.door.bounds, state.door);
  assert.equal(snapshot.door.displayRef, snapshot.self.displayRef);
  assert.equal(Object.hasOwn(snapshot.displays[0], "id"), false);
  const action = onDisplay(space, secondary, {
    type: "point",
    x: -420,
    y: 200,
  });
  const plan = space.plan("self", action);
  assert.equal(plan.displayId, secondary.id);
  assert.deepEqual(plan.path, [{ x: -420, y: 200 }]);
  walk(space, state, plan);
  const moved = space.snapshot("self");
  assert.equal(moved.layoutVersion, snapshot.layoutVersion);
  assert.equal(moved.self.displayRef, action.target.displayRef);
  assert.equal(moved.door.displayRef, snapshot.door.displayRef);
  assert.equal(moved.residents[0].ref, snapshot.residents[0].ref);
  assert.equal(moved.residents[0].displayRef, snapshot.residents[0].displayRef);
  plan.release();

  const door = space.plan("self", { target: "door" });
  assert.equal(door.displayId, primary.id);
  walk(space, state, door);
  door.release();
  state.seat = { x: -700, y: 300 };
  const seat = space.plan("self", { target: "seat" });
  assert.equal(seat.displayId, secondary.id);
  assert.deepEqual(seat.destination, {
    displayRef: action.target.displayRef,
    ...state.seat,
  });
  walk(space, state, seat);
});

test("touching corners, gaps and narrow shared edges are unreachable", () => {
  for (const workArea of [
    { x: -801, y: 0, width: 800, height: 600 },
    { x: -800, y: 624, width: 800, height: 600 },
    { x: -800, y: 521, width: 800, height: 600 },
  ]) {
    const display = { ...secondary, workArea };
    const { space } = desktop({ displays: [primary, display] });
    const action = onDisplay(space, display, { type: "corner", corner: "nw" });
    assert.deepEqual(space.plan("self", action), {
      reason: "target-unreachable",
    });
  }
});

test("route can turn through a third display without crossing an uncovered gap", () => {
  const lower = {
    ...secondary,
    id: 103,
    scaleFactor: 1.5,
    workArea: { x: -800, y: 600, width: 800, height: 480 },
  };
  const { space, state } = desktop({ displays: [lower, primary, secondary] });
  const action = onDisplay(space, lower, { type: "point", x: -20, y: 700 });
  assert.deepEqual(space.plan("self", action), {
    reason: "target-unavailable",
  });
  action.target.x = -125;
  const plan = space.plan("self", action);
  assert.equal(plan.displayId, lower.id);
  assert.ok(plan.path.length > 1);
  assert.equal(space.canStep("self", plan.destination, plan), false);
  walk(space, state, plan);
  assert.deepEqual(state.residents[0].bounds, box(-125, 700));
});

test("avoidance can select a different crossing and detects blocks on the remote work area", () => {
  const zones = [
    {
      fingerprint: displayFingerprint(secondary),
      zones: [{ x: 0.75, y: 0, width: 0.25, height: 0.56 }],
    },
  ];
  const { space, state } = desktop({ zones });
  const action = onDisplay(space, secondary, {
    type: "point",
    x: -380,
    y: 120,
  });
  const plan = space.plan("self", action);
  assert.ok(plan.path.length > 1);
  assert.equal(space.canStep("self", plan.destination, plan), false);
  walk(space, state, plan);
  assert.deepEqual(state.residents[0].bounds, box(-380, 120));
  plan.release();
  state.residents[0].bounds = box(40, 120);
  state.zones = [
    { ...zones[0], zones: [{ x: 0.75, y: 0, width: 0.25, height: 1 }] },
  ];
  assert.deepEqual(space.plan("self", action), { reason: "stale-layout" });
  const next = onDisplay(space, secondary, action.target);
  assert.deepEqual(space.plan("self", next), { reason: "target-blocked" });
});

test("a cross-display replan follows a live resident while the source window straddles the seam", () => {
  const { space, state } = desktop({
    residents: [role("self", 40, 120), role("neighbor", -430, 120)],
  });
  const {
    layoutVersion,
    residents: [neighbor],
  } = space.snapshot("self");
  const action = {
    layoutVersion,
    target: { type: "near-resident", residentRef: neighbor.ref },
  };
  const plan = space.plan("self", action);
  assert.equal(plan.displayId, secondary.id);
  assert.deepEqual(plan.path, [{ x: -318, y: 120 }]);
  assert.equal(space.canStep("self", { x: -55, y: 120 }, plan), true);
  state.residents[0].bounds = box(-55, 120);
  state.residents[1].bounds = box(400, 120);
  assert.equal(space.canStep("self", plan.destination, plan), false);
  assert.equal(space.snapshot("self").layoutVersion, layoutVersion);
  const replacement = space.plan("self", action, { replan: plan });
  assert.equal(replacement.displayId, primary.id);
  assert.deepEqual(replacement.destination, {
    displayRef: space.snapshot("self").displays[1].ref,
    x: 288,
    y: 120,
  });
  assert.deepEqual(space.plan("self", action, { replan: plan }), {
    reason: "stale-layout",
  });
  walk(space, state, replacement);
  state.displays[0] = { ...primary, scaleFactor: 1.75 };
  assert.equal(
    space.canStep("self", replacement.destination, replacement),
    false,
  );
  assert.deepEqual(space.plan("self", action, { replan: replacement }), {
    reason: "stale-layout",
  });
});

test("a reserved landing across the seam blocks another role's route", () => {
  const { space, state } = desktop({
    residents: [role("self", 40, 120), role("neighbor", -400, 300)],
  });
  const { layoutVersion, displays } = space.snapshot("neighbor");
  const reserve = space.plan("neighbor", {
    layoutVersion,
    target: { type: "point", displayRef: displays[0].ref, x: -100, y: 120 },
  });
  assert.equal(reserve.displayId, secondary.id);
  const action = onDisplay(space, secondary, {
    type: "point",
    x: -330,
    y: 120,
  });
  const plan = space.plan("self", action);
  assert.ok(plan.path.length > 1);
  assert.equal(space.canStep("self", plan.destination, plan), false);
  walk(space, state, plan);
  reserve.release();
  plan.release();
  state.residents[0].bounds = box(40, 120);
  assert.deepEqual(space.plan("self", action).path, [{ x: -330, y: 120 }]);
});

test("mixed-DPI work areas with an overlapping join cover the full window", () => {
  for (const width of [825, 975]) {
    const overlapping = {
      ...secondary,
      scaleFactor: 1.25,
      workArea: { ...secondary.workArea, width },
    };
    const { space, state } = desktop({
      displays: [primary, overlapping],
      residents: [role("self", 250, 200)],
    });
    const action = onDisplay(space, overlapping, {
      type: "point",
      x: -420,
      y: 200,
    });
    const plan = space.plan("self", action);
    assert.equal(plan.displayId, overlapping.id);
    assert.deepEqual(plan.path, [{ x: -420, y: 200 }]);
    walk(space, state, plan);
  }
});

test("a same-display target can detour through a connected neighbor", () => {
  const { space, state } = desktop({
    residents: [role("self", 200, 100)],
    zones: [
      {
        fingerprint: displayFingerprint(primary),
        zones: [{ x: 0, y: 0.5, width: 1, height: 0.04 }],
      },
    ],
  });
  const move = position(space, 200, 480);
  assert.deepEqual(space.plan("self", move, { crossDisplay: false }), {
    reason: "target-blocked",
  });
  const plan = space.plan("self", move);
  assert(plan.path.some(({ x }) => x < 0));
  assert.equal(plan.displayId, primary.id);
  for (const point of plan.path) {
    assert.equal(space.canStep("self", point, plan), true);
    state.residents[0].bounds = box(point.x, point.y);
  }
});
