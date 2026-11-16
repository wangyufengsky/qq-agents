import assert from "node:assert/strict";
import test from "node:test";
import {
  macosCaptureSnapshot,
  macosCoverageSnapshot,
  macosWindowFrame,
} from "../desktop/home/macos-capture-snapshot.mjs";
import { verifyCaptureCoverage } from "../desktop/home/screen-source.mjs";

test("macOS snapshot fails closed on process failure, invalid output and cancellation", async () => {
  const execute = (error, output) => (_path, _args, _options, callback) =>
    callback(error, output);
  assert.deepEqual(
    await macosCaptureSnapshot({
      execute: execute(Error(), ""),
      executable: "/fixture",
    }),
    { complete: false },
  );
  assert.deepEqual(
    await macosCaptureSnapshot({
      execute: execute(null, "bad"),
      executable: "/fixture",
    }),
    { complete: false },
  );
  assert.deepEqual(
    await macosCaptureSnapshot({ signal: AbortSignal.abort() }),
    { complete: false },
  );
});

test("macOS frame helper binds exactly one window and PID to a bounded, cancellable request", async () => {
  const identity = { id: "w-57", pid: 21 };
  const signal = new AbortController().signal;
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const executable = "/fixture";
  const execute = (program, args, options, callback) => {
    assert.equal(program, executable);
    assert.deepEqual(args, ["57", "21", "640", "4096"]);
    assert.equal(options.signal, signal);
    assert.equal(options.maxBuffer, 4096);
    assert.equal(options.encoding, "buffer");
    callback(null, jpeg);
  };
  assert.deepEqual(
    await macosWindowFrame(identity, 640, 4096, signal, {
      executable,
      execute,
    }),
    { data: jpeg.toString("base64") },
  );
  for (const [selected, requestSignal] of [
    [{ ...identity, id: "screen:1" }, signal],
    [{ ...identity, pid: 0 }, signal],
    [identity, AbortSignal.abort()],
  ]) {
    assert.equal(
      await macosWindowFrame(selected, 640, 4096, requestSignal, {
        executable,
        execute: () => assert.fail("No native capture should be started"),
      }),
      undefined,
    );
  }
});

test("macOS snapshot classifies all owners and preserves front-to-back geometry", () => {
  const entry = {
    id: "w-1",
    pid: 10,
    owner: "Fixture",
    name: "Fixture",
    bundle: "example.fixture",
    layer: 0,
    bounds: { x: 0, y: 0, width: 100, height: 100 },
  };
  const raw = { complete: true, foregroundPid: 10, windows: [entry] };
  const floating = macosCoverageSnapshot(
    { ...raw, windows: [{ ...entry, layer: 1000 }] },
    () => false,
  );
  assert.equal(verifyCaptureCoverage(floating, { targetId: "w-1" }), true);
  const proof = macosCoverageSnapshot(raw, () => false);
  assert.equal(verifyCaptureCoverage(proof, { targetId: "w-1" }), true);
  assert.equal(macosCoverageSnapshot(raw, () => undefined).complete, false);
  assert.equal(
    macosCoverageSnapshot({ ...raw, foregroundPid: 11 }, () => false).complete,
    false,
  );
  for (const pid of [10, 11]) {
    const overlay = { ...entry, id: "w-2", pid, layer: 0 };
    assert.equal(
      verifyCaptureCoverage(
        macosCoverageSnapshot(
          { ...raw, windows: [overlay, entry] },
          () => false,
        ),
        { targetId: "w-1" },
      ),
      false,
    );
  }
  assert.equal(
    verifyCaptureCoverage(
      macosCoverageSnapshot(raw, () => true),
      { targetId: "w-1" },
    ),
    false,
  );
});

test("verified Dock backing excludes only targets entirely inside its safe area", () => {
  const display = { x: 0, y: 0, width: 1000, height: 800 };
  const safe = { x: 0, y: 20, width: 1000, height: 700 };
  const dock = {
    id: "w-2",
    pid: 11,
    owner: "Dock",
    name: "Dock",
    bundle: "com.apple.dock",
    layer: 20,
    bounds: display,
    dockSafeBounds: safe,
  };
  const target = {
    id: "w-1",
    pid: 10,
    owner: "Fixture",
    name: "Fixture",
    bundle: "example.fixture",
    layer: 0,
    bounds: { x: 20, y: 30, width: 100, height: 100 },
  };
  const proof = (rows, sensitive = false) =>
    macosCoverageSnapshot(
      { complete: true, foregroundPid: 10, windows: rows },
      ({ pid }) => sensitive && pid === 11,
    );
  assert.equal(
    verifyCaptureCoverage(proof([dock, target]), { targetId: "w-1" }),
    true,
  );
  assert.equal(
    verifyCaptureCoverage(proof([dock, target], true), { targetId: "w-1" }),
    false,
  );
  assert.equal(
    verifyCaptureCoverage(proof([dock, target], true), {
      displayBounds: display,
    }),
    false,
  );
  assert.equal(
    verifyCaptureCoverage(
      proof([{ ...dock, dockSafeBounds: undefined }, target]),
      { targetId: "w-1" },
    ),
    false,
  );
  assert.equal(
    verifyCaptureCoverage(
      proof([{ ...dock, dockSafeBounds: { ...safe, width: 2000 } }, target]),
      { targetId: "w-1" },
    ),
    false,
  );
  assert.equal(
    verifyCaptureCoverage(
      proof([dock, { ...target, bounds: { ...target.bounds, y: 0 } }]),
      { targetId: "w-1" },
    ),
    false,
  );
  assert.equal(
    verifyCaptureCoverage(
      proof([dock, { ...target, bounds: { ...target.bounds, y: 650 } }]),
      { targetId: "w-1" },
    ),
    false,
  );
  assert.equal(
    verifyCaptureCoverage(
      proof([dock, { ...target, bounds: { ...target.bounds, x: 950 } }]),
      { targetId: "w-1" },
    ),
    false,
  );
  assert.equal(
    verifyCaptureCoverage(
      proof([dock, { ...target, id: "w-3", pid: 12 }, target]),
      { targetId: "w-1" },
    ),
    false,
  );
});
