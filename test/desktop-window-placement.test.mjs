import test from "node:test";
import assert from "node:assert/strict";
import {
  clampToWorkArea,
  restoreWindowPoint,
} from "../desktop/home/window-placement.mjs";

const primary = { workArea: { x: 0, y: 24, width: 1200, height: 776 } };
const left = { workArea: { x: -900, y: 0, width: 900, height: 600 } };
const windowAt = (x, y) => ({ x, y, width: 194, height: 156 });
const defaultSeat = () => ({ x: 890, y: 560 });

test("display recovery preserves windows fully visible on a negative-coordinate display", () => {
  const point = restoreWindowPoint(
    windowAt(-880, 20),
    [primary, left],
    defaultSeat,
  );
  assert.deepEqual(point, { x: -880, y: 20 });
});

test("display recovery clamps to the work area with the largest overlap", () => {
  const displays = [primary, left];
  assert.deepEqual(
    restoreWindowPoint(windowAt(-145, 520), displays, defaultSeat),
    { x: -194, y: 444 },
  );
  assert.deepEqual(
    restoreWindowPoint(windowAt(-20, 250), displays, defaultSeat),
    { x: 0, y: 250 },
  );
});

test("display removal uses the visible saved seat or the default and preserves the original seat", () => {
  const seat = windowAt(-800, 60);
  const removed = windowAt(-1150, 150);
  const recover = (displays) =>
    restoreWindowPoint(removed, displays, () =>
      restoreWindowPoint(seat, displays, defaultSeat),
    );
  assert.deepEqual(recover([primary]), defaultSeat());
  assert.deepEqual(recover([primary, left]), { x: -800, y: 60 });
});

test("shrinking a work area keeps the window at a reachable point", () => {
  const workArea = { x: 0, y: 36, width: 960, height: 610 };
  assert.deepEqual(
    restoreWindowPoint(windowAt(850, 550), [{ workArea }], defaultSeat),
    { x: 766, y: 490 },
  );
  assert.deepEqual(
    clampToWorkArea({ x: 400, y: 300 }, 194, 156, {
      x: -20,
      y: 24,
      width: 100,
      height: 100,
    }),
    { x: -20, y: 24 },
  );
});
