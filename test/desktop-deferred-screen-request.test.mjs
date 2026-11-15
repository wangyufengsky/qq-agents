import test from "node:test";
import assert from "node:assert/strict";
import { createDeferredScreenRequest } from "../desktop/home/deferred-screen-request.mjs";

const snapshot = (id, roomEpoch = "room") => ({
  room: { roomEpoch },
  screenRequest: id ? { requestId: id, roomEpoch } : undefined,
});

test("newest capture snapshot waits for aborted capture to finish", () => {
  const queue = createDeferredScreenRequest();
  const controller = new AbortController();
  const active = { requestId: "a", controller };
  queue.update(snapshot("b"), "sync", active);
  assert.equal(controller.signal.aborted, true);
  queue.update(snapshot("c"), "sync", active);
  assert.equal(queue.take().screenRequest.requestId, "c");
  assert.equal(queue.take(), undefined);
});

test("withdrawal and offline prevent replay of an older pending request", () => {
  const queue = createDeferredScreenRequest();
  const active = { requestId: "a", controller: new AbortController() };
  queue.update(snapshot("b"), "sync", active);
  queue.update(snapshot(undefined), "sync", active);
  assert.equal(queue.take().screenRequest, undefined);
  queue.update(snapshot("c"), "sync", active);
  queue.update({ offline: true }, "sync", active);
  assert.equal(queue.take(), undefined);
});

test("non-authoritative replies do not replace the latest snapshot", () => {
  const queue = createDeferredScreenRequest();
  const active = { requestId: "a", controller: new AbortController() };
  queue.update(snapshot("b"), "sync", active);
  queue.update(snapshot("old"), "screen-result", active);
  assert.equal(queue.take().screenRequest.requestId, "b");
  queue.update(snapshot("c"), "sync", undefined);
  assert.equal(queue.take(), undefined);
});

test("request IDs remain deduplicated for each grant", () => {
  const queue = createDeferredScreenRequest();
  const grant = {};
  queue.markStarted(grant, "a");
  queue.markStarted(grant, "b");
  assert.equal(queue.hasStarted(grant, "a"), true);
  assert.equal(queue.hasStarted({}, "a"), false);
});
