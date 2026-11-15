import assert from "node:assert/strict";
import test from "node:test";
import {
  macosCaptureSnapshot,
  macosCoverageSnapshot,
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
  const overlay = { ...entry, id: "w-2", pid: 11, layer: 1 };
  assert.equal(
    verifyCaptureCoverage(
      macosCoverageSnapshot({ ...raw, windows: [overlay, entry] }, () => false),
      { targetId: "w-1" },
    ),
    false,
  );
  assert.equal(
    verifyCaptureCoverage(
      macosCoverageSnapshot(raw, () => true),
      { targetId: "w-1" },
    ),
    false,
  );
});
