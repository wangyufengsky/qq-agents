// @ts-check
import { performance } from "node:perf_hooks";
import { z } from "zod";

const limits = {
  samples: 512,
  retentionMs: 30 * 60 * 1000,
  deliveries: 16,
  intervals: 64,
};
const maxOffsetMs = 24 * 60 * 60 * 1000;
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const offset = z.number().min(0).max(maxOffsetMs);
const scope = z.enum(["group", "private"]);
const outcome = z.enum([
  "confirmed",
  "completed-no-send",
  "intentional-no-reply",
  "review-required",
  "unresolved-delivery",
  "policy-blocked",
  "rate-limited",
  "failed",
  "unknown",
  "cancelled",
  "skipped",
  "censored",
]);
const deliveryOutcome = z.enum([
  "confirmed",
  "duplicate",
  "review-required",
  "unresolved-delivery",
  "policy-blocked",
  "rate-limited",
  "failed",
  "unknown",
  "cancelled",
  "unfinished",
]);
const phases = z.enum([
  "firstInbound",
  "lastInbound",
  "batchStarted",
  "batchReady",
  "dispatched",
  "processingStarted",
  "backendInputSubmitted",
  "sendRequested",
  "draftStored",
  "turnFinished",
  "finished",
]);
const deliveryPhases = z.enum([
  "requested",
  "conversationReady",
  "queueEntered",
  "queueLeft",
  "reserved",
  "submitted",
  "gatewayConfirmed",
  "ledgerConfirmed",
]);
const intervalKind = z.enum([
  "aggregation",
  "busy",
  "cooldown",
  "wakeRateLimit",
  "rhythm",
  "modelToSendRequest",
  "simulation",
  "preparation",
  "conversationQueue",
  "connectionQueue",
  "transport",
]);
const policy = z.strictObject({
  windowMs: count.max(60000),
  maxMs: count.max(60000),
});
const interval = z
  .strictObject({ kind: intervalKind, start: offset, end: offset })
  .refine(({ start, end }) => end >= start);
const delivery = z.strictObject({
  marks: z.partialRecord(deliveryPhases, offset),
  outcome: deliveryOutcome,
});
const sample = z.strictObject({
  number: count.min(1),
  scope,
  policy: policy.optional(),
  marks: z.partialRecord(phases, offset),
  deliveries: z.array(delivery).max(limits.deliveries),
  intervals: z.array(interval).max(limits.intervals),
  omittedDeliveries: count,
  omittedIntervals: count,
  stoppedBy: deliveryOutcome.optional(),
  outcome,
});

export const messageTimingSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  enabled: z.boolean(),
  counts: z.strictObject({
    started: count,
    inProgress: count,
    completed: count,
    droppedAtCapacity: count,
    evictedCompleted: count,
    expiredCompleted: count,
    expiredInProgress: count,
  }),
  samples: z.array(sample).max(limits.samples),
});

/** @typedef {z.infer<typeof messageTimingSnapshotSchema>} TimingSnapshot */
/** @typedef {z.infer<typeof sample>} TimingSample */
/** @typedef {z.infer<typeof delivery>} TimingDelivery */
/** @typedef {{origin: number, startedAt: number, value: TimingSample}} OpenSample */

export function disabledMessageTimingSnapshot() {
  /** @type {TimingSnapshot} */
  const value = {
    schemaVersion: 1,
    enabled: false,
    counts: {
      started: 0,
      inProgress: 0,
      completed: 0,
      droppedAtCapacity: 0,
      evictedCompleted: 0,
      expiredCompleted: 0,
      expiredInProgress: 0,
    },
    samples: [],
  };
  return value;
}

// One process owns the clock and short numeric handles. No caller-provided IDs,
// request metadata, or absolute timestamps are kept in the exported samples.
export class MessageTiming {
  /** @type {Map<number, OpenSample>} */
  #open = new Map();
  /** @type {Map<number, {completedAt: number, value: TimingSample}>} */
  #complete = new Map();
  #counts = disabledMessageTimingSnapshot().counts;

  /**
   * @param {{clock?: () => number, maxSamples?: number, retentionMs?: number}} [options]
   */
  constructor({
    clock = () => performance.now(),
    maxSamples = limits.samples,
    retentionMs = limits.retentionMs,
  } = {}) {
    if (
      !Number.isSafeInteger(maxSamples) ||
      maxSamples < 1 ||
      maxSamples > limits.samples ||
      !Number.isSafeInteger(retentionMs) ||
      retentionMs < 1 ||
      retentionMs > limits.retentionMs
    )
      throw Error("INVALID_MESSAGE_TIMING_LIMITS");
    this.clock = clock;
    this.maxSamples = maxSamples;
    this.retentionMs = retentionMs;
  }

  /** @param {number} now */
  #prune(now) {
    for (const [number, { startedAt }] of this.#open) {
      if (now - startedAt < this.retentionMs) break;
      this.#open.delete(number);
      this.#counts.expiredInProgress++;
    }
    for (const [number, { completedAt }] of this.#complete) {
      if (now - completedAt < this.retentionMs) break;
      this.#complete.delete(number);
      this.#counts.expiredCompleted++;
    }
  }

  /** @param {OpenSample} entry @param {number} at */
  #relative(entry, at) {
    const elapsed = at - entry.origin;
    return Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= maxOffsetMs
      ? Math.round(elapsed * 100) / 100
      : undefined;
  }

  /**
   * @param {TimingSample["scope"]} chatScope
   * @param {{windowMs: number, maxMs: number}} [batchPolicy]
   * @param {number} [at]
   */
  start(chatScope, batchPolicy, at) {
    if (chatScope !== "group" && chatScope !== "private") return;
    const now = this.clock();
    const origin = at ?? now;
    if (!Number.isFinite(origin) || !Number.isFinite(now) || origin > now)
      return;
    this.#prune(now);
    if (this.#open.size + this.#complete.size >= this.maxSamples) {
      const oldest = this.#complete.keys().next().value;
      if (oldest === undefined) {
        this.#counts.droppedAtCapacity++;
        return;
      }
      this.#complete.delete(oldest);
      this.#counts.evictedCompleted++;
    }
    const number = ++this.#counts.started;
    const selected = policy.safeParse(batchPolicy);
    this.#open.set(number, {
      origin,
      startedAt: now,
      value: {
        number,
        scope: chatScope,
        ...(selected.success ? { policy: selected.data } : {}),
        marks: {},
        deliveries: [],
        intervals: [],
        omittedDeliveries: 0,
        omittedIntervals: 0,
        outcome: "censored",
      },
    });
    return number;
  }

  /** @param {number} number */
  hasOpen(number) {
    const entry = this.#open.get(number);
    return !!entry && this.clock() - entry.startedAt < this.retentionMs;
  }

  /** @param {number} number */
  clearFirstInbound(number) {
    const entry = this.#open.get(number);
    if (entry) delete entry.value.marks.firstInbound;
  }

  /** @param {number} number */
  clearPolicy(number) {
    const entry = this.#open.get(number);
    if (entry) delete entry.value.policy;
  }

  /**
   * @param {number | undefined} number
   * @param {keyof TimingSample["marks"]} phase
   * @param {number} [at]
   */
  mark(number, phase, at = this.clock()) {
    const entry = this.#open.get(number ?? 0);
    if (!entry || !phases.options.includes(phase)) return;
    const elapsed = this.#relative(entry, at);
    if (elapsed === undefined) return;
    if (phase === "lastInbound")
      entry.value.marks.lastInbound = Math.max(
        entry.value.marks.lastInbound ?? elapsed,
        elapsed,
      );
    else if (phase === "batchReady") entry.value.marks.batchReady = elapsed;
    else entry.value.marks[phase] ??= elapsed;
  }

  /**
   * @param {number | undefined} number
   * @param {z.infer<typeof intervalKind>} kind
   * @param {number} from
   * @param {number} to
   */
  interval(number, kind, from, to) {
    const entry = this.#open.get(number ?? 0);
    if (!entry || !intervalKind.options.includes(kind)) return;
    if (to < entry.origin && to >= from) return;
    const start = this.#relative(entry, Math.max(entry.origin, from));
    const end = this.#relative(entry, to);
    if (
      start === undefined ||
      end === undefined ||
      to < from ||
      entry.value.intervals.length >= limits.intervals
    ) {
      entry.value.omittedIntervals++;
      return;
    }
    entry.value.intervals.push({ kind, start, end });
  }

  /** @param {number | undefined} number @param {number} [at] */
  startDelivery(number, at = this.clock()) {
    const entry = this.#open.get(number ?? 0);
    if (!entry) return;
    if (entry.value.deliveries.length >= limits.deliveries) {
      entry.value.omittedDeliveries++;
      return;
    }
    const index = entry.value.deliveries.length;
    entry.value.deliveries.push({ marks: {}, outcome: "unfinished" });
    this.markDelivery(number, index, "requested", at);
    return index;
  }

  /**
   * @param {number | undefined} number
   * @param {number | undefined} index
   * @param {keyof TimingDelivery["marks"]} phase
   * @param {number} [at]
   */
  markDelivery(number, index, phase, at = this.clock()) {
    const entry = this.#open.get(number ?? 0);
    const delivery = entry?.value.deliveries[index ?? -1];
    if (!entry || !delivery || !deliveryPhases.options.includes(phase)) return;
    const elapsed = this.#relative(entry, at);
    if (elapsed !== undefined) delivery.marks[phase] ??= elapsed;
  }

  /**
   * @param {number | undefined} number
   * @param {number | undefined} index
   * @param {TimingDelivery["outcome"]} result
   */
  finishDelivery(number, index, result) {
    const delivery = this.#open.get(number ?? 0)?.value.deliveries[index ?? -1];
    if (
      delivery?.outcome === "unfinished" &&
      deliveryOutcome.options.includes(result)
    )
      delivery.outcome = result;
  }

  /**
   * @param {number | undefined} number
   * @param {TimingSample["outcome"]} result
   */
  finish(number, result) {
    const now = this.clock();
    this.#prune(now);
    const entry = this.#open.get(number ?? 0);
    if (!entry || !outcome.options.includes(result)) return;
    this.mark(number, "finished", now);
    entry.value.outcome = result;
    this.#open.delete(entry.value.number);
    this.#complete.set(entry.value.number, {
      completedAt: now,
      value: entry.value,
    });
    this.#counts.completed++;
  }

  /** @param {number} number @param {TimingDelivery["outcome"]} reason */
  stop(number, reason) {
    const sample = this.#open.get(number)?.value;
    if (sample && deliveryOutcome.options.includes(reason))
      sample.stoppedBy = reason;
  }

  /**
   * @param {number | undefined} number
   * @param {string | undefined} status
   * @param {TimingDelivery["outcome"]} [toolOutcome]
   */
  finishTurn(number, status, toolOutcome) {
    const sample = this.#open.get(number ?? 0)?.value;
    if (!sample) return;
    const results = sample.deliveries.map(({ outcome }) => outcome);
    const confirmed = results.includes("confirmed");
    const last = toolOutcome ?? results.at(-1);
    this.finish(
      number,
      confirmed
        ? "confirmed"
        : results.includes("unknown")
          ? "unknown"
          : sample.omittedDeliveries
            ? "censored"
            : status === "cancelled" || status === "failed"
              ? status
              : last && last !== "duplicate" && last !== "unfinished"
                ? last
                : "completed-no-send",
    );
  }

  sweep() {
    this.#prune(this.clock());
  }

  snapshot() {
    this.sweep();
    /** @type {TimingSnapshot} */
    const value = {
      schemaVersion: 1,
      enabled: true,
      counts: { ...this.#counts, inProgress: this.#open.size },
      samples: [...this.#complete.values()].map(({ value }) => value),
    };
    return structuredClone(value);
  }
}
