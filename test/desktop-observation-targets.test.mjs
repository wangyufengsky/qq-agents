import test from "node:test";
import assert from "node:assert/strict";
import { createObservationTargets } from "../desktop/home/observation-targets.mjs";

test("observation targets reject blocked windows and aborted display reads before enumeration", async () => {
  let enumerations = 0;
  let nativeReads = 0;
  const targets = createObservationTargets({
    screen: { getAllDisplays: () => [] },
    BrowserWindow: { getAllWindows: () => [] },
    observationDriver: {
      observationWindows: () => {
        nativeReads++;
      },
    },
    deniedWindow: () => true,
    listScreenSources: () => {
      enumerations++;
    },
    screenCapturePermission: () => true,
  });
  const controller = new AbortController();
  assert.deepEqual(
    await targets.readObservationTarget(
      { identity: { app: "blocked" } },
      controller.signal,
    ),
    { state: "unavailable" },
  );
  controller.abort();
  assert.deepEqual(await targets.readDisplayTarget({}, controller.signal), {
    state: "unavailable",
  });
  assert.equal(nativeReads, 0);
  assert.equal(enumerations, 0);
});
