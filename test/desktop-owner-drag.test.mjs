import assert from "node:assert/strict";
import test from "node:test";
import { createPointerController } from "../desktop/home/pointer-controller.mjs";

function fixture() {
  let position = [15, 20];
  let closed = false;
  let movementsStopped = 0;
  const entry = {
    id: "cat",
    type: "sprite",
    bodyVisitId: "visit",
    bodyInputAfter: 1,
    win: {
      getPosition: () => position,
      setPosition: (x, y) => {
        position = [x, y];
      },
      isDestroyed: () => closed,
    },
  };
  const noop = () => {};
  const ownerEvents = [];
  const visuals = [];
  const positions = {};
  const context = {
    remoteState: { connected: true, desktopUnified: true, roomEpoch: "room" },
    framework: { sync: noop },
    bodyInputAfter: 1,
  };
  const controller = createPointerController({
    context,
    send: (_, channel, value) => visuals.push([channel, value]),
    entries: new Map([[entry.id, entry]]),
    windowVisible: () => true,
    follow: { stop: noop },
    space: { invalidate: noop },
    stopLocalSeat: noop,
    stopMovement: () => movementsStopped++,
    clampPoint: ({ x, y }) => ({ x: Math.max(-100, x), y }),
    sizes: { sprite: [] },
    ownerInput: { record: (_, event) => ownerEvents.push(event) },
    positions,
    savePreferences: noop,
  });
  const drag = (action, x, y) =>
    controller.handleDrag(entry, `drag-${action}`, { x, y });
  const request = (execute, finish, current = () => true) =>
    controller.executeBody({ agentId: entry.id }, current, finish, execute);
  return {
    controller,
    visuals,
    entry,
    context,
    ownerEvents,
    positions,
    drag,
    request,
    close: () => {
      closed = true;
    },
    position: () => position,
    movementsStopped: () => movementsStopped,
  };
}

test("drag waits for underway motion and reports actual geometry before a queued later action", () => {
  const {
    entry,
    ownerEvents,
    positions,
    drag,
    request,
    position,
    movementsStopped,
    visuals,
  } = fixture();
  let finishFirst;
  const settled = [];
  request(
    (finish) => {
      finishFirst = finish;
      return () => assert.fail("the owner drag must not cancel the movement");
    },
    () => settled.push(position()),
  );
  drag("start", 40, 40);
  drag("move", 0, 45);
  assert.deepEqual(position(), [15, 20]);
  assert.deepEqual(visuals, []);
  assert.equal(movementsStopped(), 0);
  drag("end", -10, 55);
  request(
    (finish) => {
      settled.push(position());
      finish({ status: "completed" });
    },
    () => {},
  );
  assert.deepEqual(settled, []);

  entry.win.setPosition(-70, 80);
  finishFirst({ status: "completed" });
  assert.deepEqual(settled, [
    [-70, 80],
    [-100, 95],
  ]);
  assert.deepEqual(ownerEvents, [
    { kind: "drag", from: { x: -70, y: 80 }, to: { x: -100, y: 95 } },
  ]);
  assert.deepEqual(visuals, [
    ["room:owner-drag", true],
    ["room:owner-drag", false],
  ]);
  assert.deepEqual(positions.cat, { x: -100, y: 95 });
  assert.equal(entry.bodyInputAfter, 1);
});

test("idle drag updates directly and a body action waits for pointer release", () => {
  const { drag, request, position, ownerEvents } = fixture();
  let started = false;
  drag("start", 40, 40);
  drag("move", 60, 80);
  assert.deepEqual(position(), [35, 60]);
  request(
    (finish) => {
      assert.deepEqual(position(), [45, 70]);
      started = true;
      finish({ status: "completed" });
    },
    () => {},
  );
  assert.equal(started, false);
  drag("end", 70, 90);
  assert.equal(started, true);
  assert.deepEqual(ownerEvents, [
    { kind: "drag", from: { x: 15, y: 20 }, to: { x: 45, y: 70 } },
  ]);
});

for (const [name, invalidate] of [
  [
    "explicit stop",
    ({ entry }) => {
      entry.bodyInputAfter++;
    },
  ],
  [
    "system layout change",
    ({ context }) => {
      context.bodyInputAfter++;
    },
  ],
  ["closed window", ({ close }) => close()],
  [
    "replaced visit",
    ({ entry }) => {
      entry.bodyVisitId = "new-visit";
    },
  ],
]) {
  test(`a queued drag is discarded after ${name}`, () => {
    const desktop = fixture();
    const { drag, request, ownerEvents, position } = desktop;
    let finish;
    request(
      (settle) => {
        finish = settle;
      },
      () => {},
    );
    drag("start", 40, 40);
    drag("end", 60, 90);
    invalidate(desktop);
    finish({ status: "cancelled", reason: "inactive" });
    assert.deepEqual(position(), [15, 20]);
    assert.deepEqual(ownerEvents, []);
  });
}

test("an explicit stop removes a waiting body request without interrupting current owner drag", () => {
  const { drag, request, position } = fixture();
  drag("start", 40, 40);
  let terminal;
  const cancel = request(
    () => assert.fail("cancelled request was executed"),
    (result) => {
      terminal = result;
    },
  );
  cancel("stopped");
  drag("end", 65, 80);
  assert.deepEqual(terminal, { status: "cancelled", reason: "stopped" });
  assert.deepEqual(position(), [40, 60]);
});
