import assert from "node:assert/strict";
import test from "node:test";
import {
  disabledMessageTimingSnapshot,
  MessageTiming,
  messageTimingSnapshotSchema,
} from "../src/core/message-timing.mjs";
import {
  analyzeMessageTiming,
  partitionMessageTime,
} from "../src/core/message-timing-analysis.mjs";

test("timing snapshots contain fixed fields and relative times only", () => {
  let now = 100000;
  const timing = new MessageTiming({ clock: () => now });
  assert.equal(timing.start("group:20000"), undefined);
  const id = timing.start("group", { windowMs: 4000, maxMs: 12000 }, now - 2);
  timing.mark(id, "firstInbound", now - 2);
  timing.mark(id, "lastInbound", now);
  timing.mark(id, "lastInbound", now + 4);
  timing.mark(id, "batchReady", now + 4000);
  timing.mark(id, "batchReady", now + 4004);
  timing.mark(id, "privateIdentifier", now);
  timing.mark(id, "dispatched", now - 3);
  timing.mark(id, "processingStarted", Number.NaN);
  timing.interval(id, "privateBody", now, now + 10);
  const delivery = timing.startDelivery(id);
  timing.markDelivery(id, delivery, "providerError", now);
  timing.finishDelivery(id, delivery, "SECRET_PROVIDER_DETAIL");
  timing.finishDelivery(id, delivery, "cancelled");
  timing.finishDelivery(id, delivery, "confirmed");
  assert.deepEqual(timing.snapshot().samples, []);
  assert.equal(timing.snapshot().counts.inProgress, 1);
  now += 5000;
  timing.finish(id, "cancelled");
  const snapshot = timing.snapshot();
  assert.deepEqual(messageTimingSnapshotSchema.parse(snapshot), snapshot);
  assert.deepEqual(snapshot.samples[0], {
    number: 1,
    scope: "group",
    policy: { windowMs: 4000, maxMs: 12000 },
    marks: {
      firstInbound: 0,
      lastInbound: 6,
      batchReady: 4006,
      finished: 5002,
    },
    deliveries: [{ marks: { requested: 2 }, outcome: "cancelled" }],
    intervals: [],
    omittedDeliveries: 0,
    omittedIntervals: 0,
    outcome: "cancelled",
  });
  snapshot.samples[0].marks.firstInbound = 500;
  assert.equal(timing.snapshot().samples[0].marks.firstInbound, 0);

  const extra = timing.start("private", {
    windowMs: 4000,
    maxMs: 12000,
    body: "fixture-only",
  });
  timing.finish(extra, "skipped");
  assert.equal(timing.snapshot().samples[1].policy, undefined);
});

test("capacity and expiry are visible and late updates cannot revive discarded samples", () => {
  let now = 0;
  const timing = new MessageTiming({
    clock: () => now,
    maxSamples: 2,
    retentionMs: 10,
  });
  const first = timing.start("group");
  const second = timing.start("private");
  assert.equal(timing.start("group"), undefined);
  timing.finish(first, "skipped");
  const third = timing.start("group");
  timing.finish(first, "confirmed");
  assert.equal(timing.snapshot().counts.inProgress, 2);
  assert.equal(timing.snapshot().counts.evictedCompleted, 1);
  now = 5;
  timing.finish(second, "failed");
  now = 10;
  timing.finish(third, "confirmed");
  assert.deepEqual(
    timing.snapshot().samples.map((sample) => sample.number),
    [second],
  );
  now = 15;
  assert.deepEqual(timing.snapshot().counts, {
    started: 3,
    inProgress: 0,
    completed: 2,
    droppedAtCapacity: 1,
    evictedCompleted: 1,
    expiredCompleted: 1,
    expiredInProgress: 1,
  });
  assert.deepEqual(timing.snapshot().samples, []);
});

test("per-sample event bounds keep omitted attempts visible in analysis", () => {
  let now = 0;
  const timing = new MessageTiming({ clock: () => now });
  const id = timing.start("private");
  timing.mark(id, "firstInbound");
  for (let index = 0; index < 17; index++) {
    const attempt = timing.startDelivery(id);
    timing.markDelivery(id, attempt, "ledgerConfirmed");
    timing.finishDelivery(id, attempt, "confirmed");
  }
  now = 1;
  for (let index = 0; index < 65; index++) timing.interval(id, "busy", 0, now);
  timing.finish(id, "confirmed");
  const report = analyzeMessageTiming(timing.snapshot()).overall;
  assert.equal(report.deliveries.recorded, 16);
  assert.equal(report.deliveries.omitted, 1);
  assert.equal(report.deliveries.timings.requestToLedger.n, 16);
  assert.equal(report.deliveries.timings.requestToLedger.missing, 1);
  assert.equal(report.traceTimings.firstInboundToFirstConfirmed.n, 0);
  assert.equal(report.attribution.omittedIntervals, 1);
});

test("analysis uses nearest-rank percentiles and retains nonresponse reasons", () => {
  let now = 0;
  const timing = new MessageTiming({ clock: () => now });
  for (let index = 1; index <= 10; index++) {
    const id = timing.start("group", { windowMs: 4000, maxMs: 12000 });
    timing.mark(id, "firstInbound");
    const delivery = timing.startDelivery(id);
    now += 10 * index;
    timing.markDelivery(id, delivery, "ledgerConfirmed");
    timing.finishDelivery(id, delivery, "confirmed");
    timing.finish(id, "confirmed");
  }
  const unknown = timing.start("group", { windowMs: 4000, maxMs: 12000 });
  timing.finishDelivery(unknown, timing.startDelivery(unknown), "unknown");
  timing.finish(unknown, "unknown");
  timing.finish(timing.start("private"), "intentional-no-reply");

  const report = analyzeMessageTiming(timing.snapshot());
  assert.deepEqual(report.overall.traceTimings.firstInboundToFirstConfirmed, {
    n: 10,
    missing: 2,
    p50Ms: 50,
    p90Ms: 90,
    p90TailSamples: 2,
  });
  assert.deepEqual(report.overall.outcomes, {
    confirmed: 10,
    unknown: 1,
    "intentional-no-reply": 1,
  });
  assert.equal(report.groups.length, 2);
  assert.deepEqual(report.groups[0].policy, { windowMs: 4000, maxMs: 12000 });
  assert.equal(report.groups[1].policy, null);
  assert.equal(
    report.groups[1].traceTimings.firstInboundToFirstConfirmed.p90Ms,
    null,
  );
  assert.equal(report.overall.deliveries.timings.transport.n, 0);
});

test("response attribution clips spans and counts shared time once", () => {
  let now = 0;
  const timing = new MessageTiming({ clock: () => now });
  const id = timing.start("group");
  timing.mark(id, "firstInbound");
  timing.mark(id, "lastInbound", 6);
  timing.mark(id, "batchReady", 4);
  timing.mark(id, "backendInputSubmitted", 8);
  timing.mark(id, "sendRequested", 10);
  timing.interval(id, "busy", 2, 8);
  timing.interval(id, "busy", 3, 7);
  timing.interval(id, "cooldown", 5, 7);
  timing.interval(id, "simulation", 10, 12);
  timing.interval(id, "rhythm", 18, 20);
  const attempt = timing.startDelivery(id, 10);
  timing.markDelivery(id, attempt, "conversationReady", 10);
  timing.markDelivery(id, attempt, "queueEntered", 12);
  timing.markDelivery(id, attempt, "queueLeft", 13);
  timing.markDelivery(id, attempt, "submitted", 14);
  timing.markDelivery(id, attempt, "gatewayConfirmed", 16);
  timing.markDelivery(id, attempt, "ledgerConfirmed", 17);
  timing.finishDelivery(id, attempt, "confirmed");
  now = 21;
  timing.finish(id, "confirmed");

  const report = analyzeMessageTiming(timing.snapshot()).overall;
  assert.equal(report.traceTimings.lastInboundToReady.n, 0);
  assert.equal(report.traceTimings.lastInboundToFirstConfirmed.p50Ms, 11);
  assert.equal(report.deliveries.timings.transport.p50Ms, 2);
  assert.equal(report.deliveries.timings.receiptToLedger.p50Ms, 1);
  assert.equal(report.attribution.duration.p50Ms, 17);
  assert.equal(report.attribution.overlap.p50Ms, 4);
  assert.equal(report.attribution.unattributed.p50Ms, 2);
  assert.equal(report.attribution.observedByKind.busy.p50Ms, 6);
  assert.equal(report.attribution.observedByKind.cooldown.p50Ms, 2);
  assert.equal(report.attribution.observedByKind.simulation.p50Ms, 2);
  assert.deepEqual(report.attribution.exclusiveMsAcrossSamples, {
    aggregation: 2,
    busy: 2,
    modelToSendRequest: 2,
    simulation: 2,
    connectionQueue: 1,
    transport: 2,
  });

  assert.deepEqual(
    partitionMessageTime(5, 10, [
      { kind: "busy", start: 0, end: 6 },
      { kind: "cooldown", start: 9, end: 20 },
    ]),
    {
      durationMs: 5,
      overlapMs: 0,
      unattributedMs: 3,
      exclusiveMs: { busy: 1, cooldown: 1 },
    },
  );
});

test("offline analysis refuses unknown fields and reports a disabled capture", () => {
  const snapshot = disabledMessageTimingSnapshot();
  const report = analyzeMessageTiming(snapshot);
  assert.equal(report.enabled, false);
  assert.equal(report.overall.samples, 0);
  assert.throws(
    () => analyzeMessageTiming({ ...snapshot, body: "fixture-only" }),
    /^Error: INVALID_MESSAGE_TIMING_SNAPSHOT$/,
  );
});
