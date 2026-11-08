// @ts-check
import { messageTimingSnapshotSchema } from "./message-timing.mjs";

/** @typedef {import("./message-timing.mjs").TimingSample} TimingSample */
/** @typedef {import("./message-timing.mjs").TimingDelivery} TimingDelivery */
/** @typedef {TimingSample["intervals"][number]} TimingInterval */

const tracePairs = /** @type {const} */ ({
  firstInboundToReady: ["firstInbound", "batchReady"],
  lastInboundToReady: ["lastInbound", "batchReady"],
  batchStartedToReady: ["batchStarted", "batchReady"],
  readyToDispatch: ["batchReady", "dispatched"],
  dispatchToProcessing: ["dispatched", "processingStarted"],
  firstInboundToProcessing: ["firstInbound", "processingStarted"],
  lastInboundToProcessing: ["lastInbound", "processingStarted"],
  processingToBackendInput: ["processingStarted", "backendInputSubmitted"],
  backendInputToSendRequest: ["backendInputSubmitted", "sendRequested"],
  processingToSendRequest: ["processingStarted", "sendRequested"],
  sendRequestToDraftStored: ["sendRequested", "draftStored"],
});
const deliveryPairs = /** @type {const} */ ({
  conversationQueue: ["requested", "conversationReady"],
  readyToConnectionQueue: ["conversationReady", "queueEntered"],
  connectionQueue: ["queueEntered", "queueLeft"],
  dequeuedToReserved: ["queueLeft", "reserved"],
  reservedToSubmitted: ["reserved", "submitted"],
  transport: ["submitted", "gatewayConfirmed"],
  receiptToLedger: ["gatewayConfirmed", "ledgerConfirmed"],
  requestToLedger: ["requested", "ledgerConfirmed"],
});

const round = (/** @type {number} */ ms) => Math.round(ms * 100) / 100;

/** @param {number | undefined} from @param {number | undefined} to */
function elapsed(from, to) {
  return from !== undefined && to !== undefined && to >= from
    ? round(to - from)
    : undefined;
}

/** @param {(number | undefined)[]} values @param {number} [omitted] */
function distribution(values, omitted = 0) {
  const sorted = values
    .filter((value) => value !== undefined)
    .sort((a, b) => a - b);
  const n = sorted.length;
  const rank90 = Math.ceil(n * 0.9);
  return {
    n,
    missing: values.length - n + omitted,
    p50Ms: sorted[Math.ceil(n * 0.5) - 1] ?? null,
    p90Ms: sorted[rank90 - 1] ?? null,
    p90TailSamples: n ? n - rank90 + 1 : 0,
  };
}

/** @param {TimingSample} sample */
function firstConfirmation(sample) {
  return sample.deliveries.reduce(
    (/** @type {number | undefined} */ first, item) => {
      const at = item.marks.ledgerConfirmed;
      return item.outcome === "confirmed" && at !== undefined
        ? Math.min(first ?? at, at)
        : first;
    },
    undefined,
  );
}

/**
 * Attribute each part of the observed response once. Separate spans can overlap,
 * including two spans of the same kind when deliveries run concurrently.
 * @param {number} start
 * @param {number} end
 * @param {TimingInterval[]} intervals
 */
export function partitionMessageTime(start, end, intervals) {
  if (elapsed(start, end) === undefined) return;
  const edges = new Set([start, end]);
  for (const interval of intervals) {
    if (interval.end <= start || interval.start >= end) continue;
    edges.add(Math.max(start, interval.start));
    edges.add(Math.min(end, interval.end));
  }
  const points = [...edges].sort((a, b) => a - b);
  /** @type {Partial<Record<TimingInterval["kind"], number>>} */
  const exclusiveMs = {};
  let overlapMs = 0;
  let unattributedMs = 0;
  for (let index = 1; index < points.length; index++) {
    const from = points[index - 1];
    const to = points[index];
    const active = new Set(
      intervals
        .filter((span) => span.start < to && span.end > from)
        .map((span) => span.kind),
    );
    const duration = to - from;
    if (active.size > 1) overlapMs += duration;
    else {
      const kind = active.values().next().value;
      if (kind === undefined) unattributedMs += duration;
      else exclusiveMs[kind] = (exclusiveMs[kind] ?? 0) + duration;
    }
  }
  return {
    durationMs: round(end - start),
    overlapMs: round(overlapMs),
    unattributedMs: round(unattributedMs),
    exclusiveMs: Object.fromEntries(
      Object.entries(exclusiveMs).map(([kind, ms]) => [kind, round(ms)]),
    ),
  };
}

/** @param {TimingSample} sample */
function observedSpans(sample) {
  const { marks } = sample;
  const spans = [...sample.intervals];
  /**
   * @param {TimingInterval["kind"]} kind
   * @param {number | undefined} start
   * @param {number | undefined} end
   */
  const add = (kind, start, end) => {
    if (start !== undefined && end !== undefined && end >= start)
      spans.push({ kind, start, end });
  };
  if (
    marks.batchReady !== undefined &&
    marks.batchReady <= (marks.dispatched ?? marks.finished ?? 0)
  )
    add("aggregation", marks.batchStarted, marks.batchReady);
  add("modelToSendRequest", marks.backendInputSubmitted, marks.sendRequested);
  for (const { marks: delivery } of sample.deliveries) {
    add("conversationQueue", delivery.requested, delivery.conversationReady);
    add("connectionQueue", delivery.queueEntered, delivery.queueLeft);
    add("transport", delivery.submitted, delivery.gatewayConfirmed);
  }
  return spans;
}

// Each reason's duration is its own union. Reasons can still overlap each
// other, so these observations are kept separate from the response partition.
/** @param {TimingInterval[]} spans */
function observedByKind(spans) {
  /** @type {Partial<Record<TimingInterval["kind"], number>>} */
  const totals = {};
  const ends = new Map();
  for (const { kind, start, end } of spans.toSorted(
    (a, b) => a.start - b.start,
  )) {
    const covered = Math.max(ends.get(kind) ?? start, start);
    totals[kind] = (totals[kind] ?? 0) + Math.max(0, end - covered);
    ends.set(kind, Math.max(covered, end));
  }
  return totals;
}

/** @param {TimingSample[] | TimingDelivery[]} items */
function outcomes(items) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const { outcome } of items) counts[outcome] = (counts[outcome] ?? 0) + 1;
  return counts;
}

/** @param {TimingSample[]} samples */
function summarize(samples) {
  const deliveries = samples.flatMap((sample) => sample.deliveries);
  const firstConfirmations = samples.map((sample) =>
    sample.omittedDeliveries ? undefined : firstConfirmation(sample),
  );
  const spans = samples.map((sample) =>
    sample.omittedDeliveries || sample.omittedIntervals
      ? undefined
      : observedSpans(sample),
  );
  const observed = spans.map(
    (sampleSpans) => sampleSpans && observedByKind(sampleSpans),
  );
  const kinds = new Set(
    spans.flatMap((sampleSpans) => (sampleSpans || []).map(({ kind }) => kind)),
  );
  const partitions = samples.map(({ marks }, index) => {
    const first = marks.firstInbound;
    const confirmed = firstConfirmations[index];
    const sampleSpans = spans[index];
    if (first !== undefined && confirmed !== undefined && sampleSpans)
      return partitionMessageTime(first, confirmed, sampleSpans);
  });
  /** @type {Record<string, number>} */
  const exclusiveMs = {};
  for (const part of partitions)
    for (const [kind, ms] of Object.entries(part?.exclusiveMs || {}))
      exclusiveMs[kind] = round((exclusiveMs[kind] ?? 0) + ms);
  const omittedDeliveries = samples.reduce(
    (n, sample) => n + sample.omittedDeliveries,
    0,
  );
  return {
    samples: samples.length,
    outcomes: outcomes(samples),
    firstConfirmationSamples: firstConfirmations.filter(
      (value) => value !== undefined,
    ).length,
    traceTimings: {
      ...Object.fromEntries(
        Object.entries(tracePairs).map(([metric, [from, to]]) => [
          metric,
          distribution(
            samples.map(({ marks }) => elapsed(marks[from], marks[to])),
          ),
        ]),
      ),
      firstInboundToFirstConfirmed: distribution(
        samples.map(({ marks }, index) =>
          elapsed(marks.firstInbound, firstConfirmations[index]),
        ),
      ),
      lastInboundToFirstConfirmed: distribution(
        samples.map(({ marks }, index) =>
          elapsed(marks.lastInbound, firstConfirmations[index]),
        ),
      ),
    },
    deliveries: {
      recorded: deliveries.length,
      omitted: omittedDeliveries,
      outcomes: outcomes(deliveries),
      timings: Object.fromEntries(
        Object.entries(deliveryPairs).map(([metric, [from, to]]) => [
          metric,
          distribution(
            deliveries.map(({ marks }) => elapsed(marks[from], marks[to])),
            omittedDeliveries,
          ),
        ]),
      ),
    },
    attribution: {
      partitionedSamples: partitions.filter(Boolean).length,
      omittedIntervals: samples.reduce(
        (n, sample) => n + sample.omittedIntervals,
        0,
      ),
      duration: distribution(partitions.map((part) => part?.durationMs)),
      overlap: distribution(partitions.map((part) => part?.overlapMs)),
      unattributed: distribution(
        partitions.map((part) => part?.unattributedMs),
      ),
      observedByKind: Object.fromEntries(
        [...kinds]
          .sort()
          .map((kind) => [
            kind,
            distribution(
              observed.map((part) =>
                part?.[kind] === undefined ? undefined : round(part[kind]),
              ),
            ),
          ]),
      ),
      exclusiveMsAcrossSamples: exclusiveMs,
    },
  };
}

/** @param {unknown} input */
export function analyzeMessageTiming(input) {
  const parsed = messageTimingSnapshotSchema.safeParse(input);
  if (!parsed.success) throw Error("INVALID_MESSAGE_TIMING_SNAPSHOT");
  const { enabled, counts, samples } = parsed.data;
  /** @type {Map<string, TimingSample[]>} */
  const groups = new Map();
  for (const sample of samples) {
    const { scope, policy } = sample;
    const key = JSON.stringify([scope, policy?.windowMs, policy?.maxMs]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)?.push(sample);
  }
  return {
    schemaVersion: 1,
    enabled,
    counts,
    overall: summarize(samples),
    groups: [...groups.values()].map((group) => ({
      scope: group[0].scope,
      policy: group[0].policy ?? null,
      ...summarize(group),
    })),
  };
}
