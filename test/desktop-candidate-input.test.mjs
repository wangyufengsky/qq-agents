import assert from "node:assert/strict";
import test from "node:test";
import { registerActionIpc } from "../desktop/home/action-ipc.mjs";
import {
  createDesktopCaptureHandler,
  createFullDesktopCapture,
} from "../desktop/home/full-desktop-capture.mjs";
import { createOwnerInput } from "../desktop/home/owner-input.mjs";
import { createPointerController } from "../desktop/home/pointer-controller.mjs";

const laptop = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1200, height: 900 },
  scaleFactor: 2,
  rotation: 0,
};
const external = {
  id: 2,
  bounds: { x: -1920, y: -108, width: 1920, height: 1080 },
  scaleFactor: 1,
  rotation: 0,
};
const limits = { maxEdge: 1024, maxBytes: 1024 };

function image(width, height, jpeg) {
  return {
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    resize: (size) => image(size.width, size.height, jpeg),
    toJPEG: () => Buffer.from(jpeg),
  };
}

test("full desktop capture matches every source to its display in one batch", async () => {
  const capture = createFullDesktopCapture({
    permission: () => "granted",
    getDisplays: () => [external, laptop],
    getSources: (options) => {
      assert.deepEqual(options, {
        types: ["screen"],
        thumbnailSize: { width: 1024, height: 1024 },
      });
      return [
        { display_id: "2", thumbnail: image(1920, 1080, "external") },
        { display_id: "1", thumbnail: image(1200, 900, "laptop") },
      ];
    },
  });
  const { frames } = await capture(limits, new AbortController().signal);
  assert.deepEqual(frames, [
    {
      displayId: "1",
      bounds: laptop.bounds,
      width: 1024,
      height: 768,
      data: Buffer.from("laptop").toString("base64"),
    },
    {
      displayId: "2",
      bounds: external.bounds,
      width: 1024,
      height: 576,
      data: Buffer.from("external").toString("base64"),
    },
  ]);
});

test("full desktop capture distinguishes denied permission, missing frames, and changed topology", async () => {
  const signal = new AbortController().signal;
  let permission = "denied";
  let displays = [external, laptop];
  let unplug = false;
  let calls = 0;
  const capture = createFullDesktopCapture({
    permission: () => permission,
    getDisplays: () => displays,
    getSources: () => {
      calls++;
      if (unplug) displays = [laptop];
      return [{ display_id: "1", thumbnail: image(100, 100, "laptop") }];
    },
  });
  assert.deepEqual(await capture(limits, signal), { status: "permission" });
  assert.equal(calls, 0);
  permission = "granted";
  assert.deepEqual(await capture(limits, signal), { status: "unavailable" });
  unplug = true;
  assert.deepEqual(await capture(limits, signal), { status: "unavailable" });
  assert.equal(calls, 2);
});

const roomEpoch = "room";
const role = { id: "cat", state: "here", bodyVisitId: "visit" };
const state = {
  room: { roomEpoch, roles: [role] },
  desktopOwnerInput: { roomEpoch, acknowledged: [] },
};

test("capture handler suppresses stale results and retries transport failures without recapture", async () => {
  const first = Promise.withResolvers();
  let captures = 0;
  let activeSignal;
  const uploads = [];
  const handler = createDesktopCaptureHandler({
    available: () => true,
    blocked: () => false,
    capture: ({ requestId }, signal) => {
      captures++;
      if (requestId === "first") {
        activeSignal = signal;
        return first.promise;
      }
      return { frames: ["frame"] };
    },
    send: async (result, isCurrent) => {
      assert.ok(isCurrent());
      uploads.push(result);
      if (uploads.length === 1) throw Error("transport disconnected");
      return { accepted: true };
    },
  });
  const request = {
    roomEpoch,
    agentId: role.id,
    visitId: role.bodyVisitId,
    requestId: "first",
    observationRevision: 2,
    ...limits,
  };
  const underway = handler.update({ ...state, desktopCaptureRequest: request });
  const next = {
    ...state,
    desktopCaptureRequest: { ...request, requestId: "next" },
  };
  await handler.update(next);
  assert.equal(activeSignal.aborted, true);
  first.resolve({ frames: ["stale frame"] });
  await underway;
  await handler.update(next);
  await handler.update(next);
  assert.equal(captures, 2);
  assert.equal(uploads.length, 2);
  assert.deepEqual(uploads[0], uploads[1]);
  assert.equal(uploads[1].requestId, "next");
});

test("owner input preserves separate events until acknowledgement and drops departed visits", () => {
  let id = 0;
  const input = createOwnerInput({ newId: () => String(++id) });
  assert.equal(input.record(role, { kind: "pet" }), false);
  input.update(state);
  input.record(role, { kind: "pet" });
  input.record(role, { kind: "pet" });
  assert.deepEqual(
    input.batch().map(({ eventId }) => eventId),
    ["1", "2"],
  );
  input.update({ offline: true });
  assert.equal(input.batch().length, 2);
  input.update(
    { desktopOwnerInput: { roomEpoch: "old-room", acknowledged: ["1"] } },
    { heartbeat: true },
  );
  assert.equal(input.batch().length, 2);
  input.update(
    { desktopOwnerInput: { roomEpoch, acknowledged: ["1"] } },
    { heartbeat: true },
  );
  assert.deepEqual(
    input.batch().map(({ eventId }) => eventId),
    ["2"],
  );
  input.update({ ...state, room: { roomEpoch, roles: [] } });
  assert.deepEqual(input.batch(), []);
});

test("pet clicks are individually queued while the animation is still active", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 10_000 });
  const entry = { ...role, type: "sprite" };
  const input = createOwnerInput();
  input.update(state);
  let listener;
  let syncs = 0;
  let updates = 0;
  registerActionIpc({
    ipc: {
      on(name, handler) {
        assert.equal(name, "room:action");
        listener = handler;
      },
      actionEntry: () => entry,
    },
    context: { framework: { sync: () => syncs++ }, roles: [role] },
    refreshIfDue: () => false,
    windowVisible: () => true,
    update: () => updates++,
    randomUUID: () => "animation",
    ownerInput: input,
  });
  listener({}, "pet");
  listener({}, "pet");
  assert.equal(syncs, 2);
  assert.equal(updates, 1);
  assert.equal(input.batch().length, 2);
  assert.notEqual(input.batch()[0].eventId, input.batch()[1].eventId);
  t.mock.timers.tick(1100);
  assert.equal(entry.gesture, undefined);
});

test("pointer drag reports actual start and OS-adjusted end on the current visit", () => {
  const input = createOwnerInput({ newId: () => "drag" });
  input.update(state);
  let position = [14, 20];
  let syncs = 0;
  const noop = () => {};
  const entry = {
    ...role,
    type: "sprite",
    win: {
      getPosition: () => position,
      setPosition: (x, y) => {
        position = [x - 2, y];
      },
    },
  };
  const pointer = createPointerController({
    context: { framework: { sync: () => syncs++ } },
    entries: new Map([[role.id, entry]]),
    space: { invalidate: noop },
    follow: { stop: noop },
    body: { stop: noop },
    stopLocalWindowTask: noop,
    stopCompanionControl: noop,
    stopLocalSeat: noop,
    stopMovement: noop,
    clampPoint: (point) => point,
    sizes: { sprite: [] },
    ownerInput: input,
    positions: {},
    savePreferences: noop,
  });
  pointer.handleDrag(entry, "drag-start", { x: 80, y: 100 });
  pointer.handleDrag(entry, "drag-end", { x: -120, y: 130 });
  assert.equal(syncs, 1);
  assert.deepEqual(input.batch(), [
    {
      eventId: "drag",
      roomEpoch,
      agentId: role.id,
      visitId: role.bodyVisitId,
      kind: "drag",
      from: { x: 14, y: 20 },
      to: { x: -188, y: 50 },
    },
  ]);
});
