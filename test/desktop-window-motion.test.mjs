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
