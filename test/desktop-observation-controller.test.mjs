import test from "node:test";
import assert from "node:assert/strict";
import { createObservationController } from "../desktop/home/observation-controller.mjs";

test("revocation aborts capture and rejects a late observation verification", async () => {
  let resolveProbe;
  const results = [];
  const stopped = [];
  const grant = {
    agentId: "a",
    grantId: "g",
    roomEpoch: "r",
    state: "ready",
    expiresAt: Date.now() + 10000,
    controller: new AbortController(),
    probe: Promise.resolve(),
    source: {},
  };
  const windowGrants = new Map([["a", grant]]);
  const capture = new AbortController();
  const context = {
    screenCapture: { grant, controller: capture },
    framework: { act() {}, result: (...args) => results.push(args) },
  };
  const controller = createObservationController({
    context,
    screenGrants: new Map(),
    windowGrants,
    displayGrants: new Map(),
    body: { stopObservation: (...args) => stopped.push(args) },
    permissionRevision: () => 1,
    readDisplayTarget: () => {},
    readObservationTarget: () =>
      new Promise((resolve) => {
        resolveProbe = resolve;
      }),
    update() {},
  });
  controller.verifyObservationRequest(grant, {
    roomEpoch: "r",
    grantId: "g",
    requestId: "q",
  });
  await Promise.resolve();
  controller.clearObservation(grant);
  resolveProbe({ state: "ready" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(capture.signal.aborted, true);
  assert.equal(grant.controller.signal.aborted, true);
  assert.deepEqual(stopped, [["a", "g"]]);
  assert.deepEqual(results, []);
  assert.equal(windowGrants.size, 0);
});
