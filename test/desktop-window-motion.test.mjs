import test from "node:test";
import assert from "node:assert/strict";
import { createWindowMotion } from "../desktop/home/window-motion.mjs";

test("window motion reports an unconfirmed native step and never completes it", () => {
  let position = [0, 0];
  let completed = 0;
  let unconfirmed = 0;
  const motion = createWindowMotion({
    context: { hidden: true },
    sizes: { sprite: [10, 10] },
    clampPoint: (point) => point,
    send() {},
    schedulePositionReport() {},
    updateMotion() {},
    windowVisible: () => true,
  });
  const entry = {
    type: "sprite",
    win: {
      getPosition: () => position,
      setPosition: () => {
        position = [20, 20];
      },
    },
  };
  motion.animateTo(entry, { x: 10, y: 10 }, () => completed++, {
    canStep: () => true,
    unconfirmed: () => unconfirmed++,
  });
  assert.equal(unconfirmed, 1);
  assert.equal(completed, 0);
});

test("each route keeps its departure gait through short legs", () => {
  const gaits = [];
  const motion = createWindowMotion({
    context: {},
    sizes: { sprite: [100, 100] },
    clampPoint: (p) => p,
    send: (_, name, value) => {
      if (name === "room:gait") gaits.push(value);
    },
    schedulePositionReport() {},
    updateMotion() {},
    windowVisible: () => true,
  });
  const entry = { type: "sprite", win: { getPosition: () => [0, 0] } };
  for (const [x, travelDistance] of [
    [299, undefined],
    [300, undefined],
    [20, 350],
    [25, 350],
    [25, 200],
  ]) {
    motion.animateTo(entry, { x, y: 0 }, () => {}, { travelDistance });
    motion.stopMovement(entry);
  }
  assert.deepEqual(gaits, ["walk", "run", "run", "run", "walk"]);
});
