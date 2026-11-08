import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mock } from "node:test";
import promisedTimers, {
  setImmediate as yieldLoop,
} from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { MessageTiming } from "../../src/core/message-timing.mjs";
import { analyzeMessageTiming } from "../../src/core/message-timing-analysis.mjs";

const agentId = "fixture-role";
const connectionId = "fixture-qq";
const conversation = "group:20000";
const epoch = Date.UTC(2030, 0, 1);
const tickIntervalMs = 1000;
const clockStepMs = 10;
const firstReplyMaxMs = 6000;
const observationHorizonMs = 45000;
const baselinePolicy = { windowMs: 4000, maxMs: 12000 };
const scenarios = {
  single: [0],
  fragments: [0, 900, 3300, 6400],
  continuous: Array.from({ length: 16 }, (_, index) => index * 1200),
};

export async function loadBenchmarkSource(repoRoot) {
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
  const revision = git("rev-parse", "HEAD");
  if (!/^[a-f0-9]{40}$/.test(revision)) throw Error("INVALID_BENCHMARK_SOURCE");
  const load = (file) =>
    import(pathToFileURL(path.resolve(repoRoot, file)).href);
  const [{ Runtime }, { ConfigStore, validateConfig }, { MemoryStore }] =
    await Promise.all([
      load("src/core/runtime.mjs"),
      load("src/core/config.mjs"),
      load("src/memory/store.mjs"),
    ]);
  return {
    revision,
    modified: !!git(
      "status",
      "--porcelain",
      "--untracked-files=all",
      "--",
      "src",
      "vendor",
      "package-lock.json",
    ),
    Runtime,
    ConfigStore,
    validateConfig,
    MemoryStore,
  };
}

function trialPlan(seed, index) {
  let state = (seed + Math.imul(index + 1, 0x9e3779b9)) >>> 0 || 1;
  const next = (max) => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % max;
  };
  return {
    tickPhaseMs: next(100) * clockStepMs,
    modelMs: 750 + next(106) * clockStepMs,
    gatewayMs: 80 + next(13) * clockStepMs,
    replyChars: [5, 17, 40][next(3)],
  };
}

function fixtureConfig(source, { windowMs, maxMs }) {
  return source.validateConfig({
    version: 1,
    mode: "live",
    globalPaused: false,
    connections: [
      {
        id: connectionId,
        label: "Synthetic connection",
        accountId: "10000",
        httpUrl: "http://127.0.0.1:9",
        wsUrl: "ws://127.0.0.1:9",
      },
    ],
    backends: [{ id: "fixture", type: "codex", label: "Synthetic backend" }],
    agents: [
      {
        id: agentId,
        name: "计时样例",
        connectionId,
        backendId: "fixture",
        paused: false,
        allow: { groups: ["20000"] },
        tools: ["conversation_read", "memory_read", "qq_send"],
        wake: { participation: 1, cooldownMs: 0 },
        behavior: {
          batchWindowMs: windowMs,
          batchMaxMs: maxMs,
          maxWakePerMinute: 60,
          maxWakePerHour: 360,
          replyCheckMs: 120000,
          rhythm: { enabled: false },
          toneCheck: { mode: "off" },
          typing: {
            enabled: true,
            indicator: false,
            firstReply: true,
            firstReplyMaxMs,
            jitter: 0,
          },
        },
        subject: { enabled: false },
        scheduler: { enabled: false },
        network: { autonomous: false },
        apps: { enabled: false, sharing: false, platforms: [] },
        files: { enabled: false },
        github: { enabled: false },
        voice: { tts: { enabled: false }, asr: { enabled: false } },
        crossGroup: { enabled: false },
        operations: { enabled: false },
      },
    ],
  });
}

function message(index, at) {
  return {
    post_type: "message",
    message_type: "group",
    self_id: 10000,
    user_id: 30000,
    group_id: 20000,
    message_id: 40000 + index,
    time: Math.floor(at / 1000),
    sender: { nickname: "Synthetic participant" },
    message: [{ type: "text", data: { text: "fixture item " + index } }],
  };
}

function shownItems(items) {
  let mask = 0;
  for (const item of items || []) {
    const index = /^fixture item (\d{1,2})$/.exec(item.body)?.[1];
    if (index !== undefined && !item.bodyTruncated && !item.summaryOmitted)
      mask |= 1 << Number(index);
  }
  return mask;
}

const lastItem = (mask) => 31 - Math.clz32(mask);

function openingHistory(prompt) {
  const prefix = "新增消息：";
  const line = prompt.split("\n").find((value) => value.startsWith(prefix));
  return line ? JSON.parse(line.slice(prefix.length)) : { items: [] };
}

async function readAvailable(callTool, afterSeq) {
  let mask = 0;
  for (let pageIndex = 0; pageIndex < 32; pageIndex++) {
    const page = await callTool("conversation_read", {
      afterSeq,
      limit: 50,
      maxChars: 16000,
    });
    mask |= shownItems(page.items);
    if (!page.truncated) return mask;
    if (page.nextAfterSeq <= afterSeq) break;
    afterSeq = page.nextAfterSeq;
  }
  throw Error("BENCHMARK_PAGINATION_STALLED");
}

function attemptOutcome(error) {
  const code = error?.message;
  if (
    code === "INPUT_REVIEW_REQUIRED" ||
    code === "TYPING_NEW_INPUT_REVIEW_REQUIRED"
  )
    return "review-required";
  if (
    code === "DELIVERY_UNKNOWN" ||
    code === "DELIVERY_ALREADY_ATTEMPTED_UNKNOWN"
  )
    return "unknown";
  if (typeof code === "string" && /(?:^|_)RATE_LIMIT(?:ED)?$/.test(code))
    return "rate-limited";
  return "failed";
}

// Probe the same real scheduling and outbound methods on both source trees.
// The synthetic fixture disables rhythm and wake gates, so its persisted due
// time is the scheduler's own aggregation deadline. In a live capture these
// times must be recorded independently, before additional gates alter them.
function attachProbe(runtime, timing, policy) {
  let receivingAt, pending, dispatching, active;
  const open = new Set();
  const contexts = new WeakMap();
  const operations = new WeakMap();
  const write = runtime.conversations.write.bind(runtime.conversations);
  runtime.conversations.write = (id, scope, state) => {
    const result = write(id, scope, state);
    if (
      scope === conversation &&
      receivingAt !== undefined &&
      state.pendingWakes?.length &&
      state.wakeBatchAt !== undefined
    ) {
      if (!pending) {
        pending = { id: timing.start("group", policy, receivingAt) };
        timing.mark(pending.id, "firstInbound", receivingAt);
        if (runtime.running.has(agentId + "|" + conversation))
          pending.busySince = receivingAt;
        open.add(pending);
      }
      timing.mark(pending.id, "lastInbound", receivingAt);
      timing.mark(pending.id, "batchReady", state.wakeDueAt);
    }
    return result;
  };

  const removeRunning = runtime.running.delete.bind(runtime.running);
  runtime.running.delete = (key) => {
    const result = removeRunning(key);
    if (
      result &&
      key === agentId + "|" + conversation &&
      pending?.busySince !== undefined
    ) {
      timing.interval(pending.id, "busy", pending.busySince, Date.now());
      delete pending.busySince;
    }
    return result;
  };

  const wake = runtime.wake.bind(runtime);
  runtime.wake = (id, scope, options) => {
    const trace = scope === conversation ? pending : undefined;
    if (scope === conversation) pending = undefined;
    timing.mark(trace?.id, "dispatched");
    dispatching = trace;
    let job;
    try {
      job = wake(id, scope, options);
    } finally {
      dispatching = undefined;
    }
    return job.then(
      (result) => {
        timing.finish(
          trace?.id,
          trace?.confirmed
            ? "confirmed"
            : trace?.intentional
              ? "intentional-no-reply"
              : result?.status === "cancelled"
                ? "cancelled"
                : result?.status === "failed"
                  ? "failed"
                  : trace?.lastOutcome || "completed-no-send",
        );
        open.delete(trace);
        return result;
      },
      (error) => {
        timing.finish(trace?.id, "failed");
        open.delete(trace);
        throw error;
      },
    );
  };

  const makeContext = runtime.makeContext.bind(runtime);
  runtime.makeContext = (...args) => {
    const ctx = makeContext(...args);
    if (dispatching) {
      active = dispatching;
      contexts.set(ctx, active);
      timing.mark(active.id, "processingStarted");
    }
    return ctx;
  };

  const callTool = runtime.callTool.bind(runtime);
  runtime.callTool = (ctx, name, args) => {
    if (name === "qq_send") timing.mark(contexts.get(ctx)?.id, "sendRequested");
    return callTool(ctx, name, args);
  };

  const service = runtime.delivery;
  const deliver = service.deliver.bind(service);
  service.deliver = async (ctx, operation) => {
    const trace = contexts.get(ctx);
    if (!trace) return deliver(ctx, operation);
    const index = timing.startDelivery(trace.id);
    const mark = (phase) => timing.markDelivery(trace.id, index, phase);
    const finish = (outcome) => timing.finishDelivery(trace.id, index, outcome);
    const send = async (...args) => {
      mark("submitted");
      const result = await operation.send(...args);
      if (result?.messageId != null) mark("gatewayConfirmed");
      return result;
    };
    operations.set(send, { trace, mark });
    try {
      const receipt = await deliver(ctx, { ...operation, send });
      if (receipt?.duplicate) finish("duplicate");
      else if (
        receipt?.status === "sent" &&
        runtime.memory.bind(agentId).delivery(operation.requestId)?.status ===
          "sent"
      ) {
        mark("ledgerConfirmed");
        finish("confirmed");
        trace.confirmed = true;
      }
      return receipt;
    } catch (error) {
      const result = attemptOutcome(error);
      finish(result);
      trace.lastOutcome = result;
      throw error;
    }
  };

  const legacy = typeof service.deliverAfterTyping === "function";
  const readyMethod = legacy ? "deliverAfterTyping" : "enqueue";
  const ready = service[readyMethod].bind(service);
  service[readyMethod] = async (ctx, operation) => {
    const attempt = operations.get(operation.send);
    attempt?.mark("conversationReady");
    if (attempt && legacy) attempt.beforeTypingAt = Date.now();
    try {
      return await ready(ctx, operation);
    } finally {
      if (
        attempt?.beforeTypingAt !== undefined &&
        Date.now() > attempt.beforeTypingAt
      )
        timing.interval(
          attempt.trace.id,
          "simulation",
          attempt.beforeTypingAt,
          Date.now(),
        );
    }
  };

  const deliverNow = service.deliverNow.bind(service);
  service.deliverNow = (ctx, operation) => {
    const attempt = operations.get(operation.send);
    if (attempt) {
      // The fixture sends serially in a single chat. If a queue predecessor
      // exists, do not infer queue entry from the eventual queue exit.
      if (!service.queues.has(connectionId)) attempt.mark("queueEntered");
      attempt.mark("queueLeft");
      if (attempt.beforeTypingAt !== undefined) {
        timing.interval(
          attempt.trace.id,
          "simulation",
          attempt.beforeTypingAt,
          Date.now(),
        );
        delete attempt.beforeTypingAt;
      }
    }
    return deliverNow(ctx, operation);
  };

  return {
    legacy,
    hasPending: () => !!pending,
    currentTurn: () => active,
    receive(at) {
      receivingAt = at;
    },
    censor() {
      for (const trace of open) timing.finish(trace.id, "censored");
      return open.size;
    },
  };
}

export async function runBenchmarkTrial(
  source,
  {
    scenario,
    policy,
    seed,
    index,
    horizonMs = observationHorizonMs,
    timers = mock.timers,
  },
) {
  const arrivals = Object.hasOwn(scenarios, scenario)
    ? scenarios[scenario]
    : null;
  if (
    !arrivals ||
    !Number.isSafeInteger(horizonMs) ||
    horizonMs < clockStepMs ||
    horizonMs % clockStepMs !== 0
  )
    throw Error("INVALID_BENCHMARK_TRIAL");
  const plan = trialPlan(seed, index);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qq-timing-benchmark-"));
  const timing = new MessageTiming({ clock: () => Date.now() });
  let memory, runtime, probe, captured;
  let firstConfirmedAt, latestConfirmedAt;
  let arrived = 0,
    acknowledged = 0,
    nextTurn = 0,
    sent = 0;
  const responded = new Set();
  const quality = {
    gatewayCalls: 0,
    confirmed: 0,
    staleSubmissions: 0,
    missedSupplements: 0,
    duplicateResponses: 0,
    intentionallySilentTurns: 0,
    reviewChallenges: 0,
    otherToolFailures: 0,
    missingModelInput: 0,
    openingContinuations: 0,
  };

  const transport = {
    connected: true,
    close() {
      this.connected = false;
    },
    async send(scope, segments) {
      if (scope !== conversation) throw Error("UNEXPECTED_BENCHMARK_TARGET");
      const response = segments.find(({ type }) => type === "text")?.data?.text;
      const marker = /^B([a-z0-9]+):/.exec(response)?.[1];
      if (!marker) throw Error("INVALID_BENCHMARK_REPLY");
      const read = Number.parseInt(marker, 36);
      const expected = (1 << arrived) - 1;
      const latest = lastItem(read);
      if (latest < arrived - 1) quality.staleSubmissions++;
      const missing = expected & ~(read | acknowledged);
      quality.missedSupplements += missing
        .toString(2)
        .replaceAll("0", "").length;
      if (responded.has(read)) quality.duplicateResponses++;
      responded.add(read);
      quality.gatewayCalls++;
      const messageId = String(50000 + ++sent);
      await promisedTimers.setTimeout(plan.gatewayMs);
      return { messageId };
    },
  };

  const model = async (p) => {
    const trace = probe.currentTurn();
    const turn = ++nextTurn;
    p.onInputSubmitted?.();
    timing.mark(trace?.id, "backendInputSubmitted");
    const opening = openingHistory(p.prompt);
    let read = shownItems(opening.items);
    if (opening.truncated) {
      quality.openingContinuations++;
      read |= await readAvailable(p.callTool, opening.nextAfterSeq);
    }
    await promisedTimers.setTimeout(plan.modelMs, undefined, {
      signal: p.signal,
    });
    if (!read) {
      quality.missingModelInput++;
      return;
    }
    let inputReview;
    for (let attempt = 0; attempt < 12; attempt++) {
      if ((read & ~acknowledged) === 0) {
        quality.intentionallySilentTurns++;
        if (trace) trace.intentional = true;
        return;
      }
      const text = "B" + read.toString(36) + ":" + "答".repeat(plan.replyChars);
      try {
        const receipt = await p.callTool("qq_send", {
          requestId: "fixture-turn-" + turn,
          text,
          ...(inputReview ? { inputReview } : {}),
        });
        if (receipt?.status === "sent" && !receipt.duplicate) {
          acknowledged |= read;
          firstConfirmedAt ??= Date.now();
          if (lastItem(acknowledged) === arrivals.length - 1)
            latestConfirmedAt ??= Date.now();
          quality.confirmed++;
          return;
        }
        quality.otherToolFailures++;
        return;
      } catch (error) {
        if (attemptOutcome(error) !== "review-required") {
          quality.otherToolFailures++;
          return;
        }
        quality.reviewChallenges++;
        if (error.inputReview?.token) {
          inputReview = {
            token: error.inputReview.token,
            decision: "continue",
          };
        } else {
          read |= await readAvailable(p.callTool, 0);
          inputReview = undefined;
        }
      }
    }
    quality.otherToolFailures++;
  };

  timers.enable({ apis: ["Date", "setTimeout"], now: epoch });
  try {
    memory = new source.MemoryStore(":memory:");
    runtime = new source.Runtime({
      configStore: new source.ConfigStore(
        path.join(root, "config.json"),
        fixtureConfig(source, policy),
      ),
      memory,
      backendFactory: () => ({
        run: model,
        cancel: async () => {},
        close: async () => {},
      }),
      transportFactory: () => transport,
      clock: () => new Date(),
      random: () => 0.5,
      diagnostics: { report() {} },
    });
    runtime.transports.set(connectionId, transport);
    probe = attachProbe(runtime, timing, policy);

    for (let elapsed = 0; elapsed <= horizonMs; elapsed += clockStepMs) {
      if (elapsed) {
        timers.tick(clockStepMs);
        await yieldLoop();
      }
      if (arrivals[arrived] === elapsed) {
        const at = Date.now();
        const index = arrived++;
        probe.receive(at);
        try {
          await runtime.ingest(connectionId, message(index, at));
        } finally {
          probe.receive(undefined);
        }
      }
      if (
        elapsed >= plan.tickPhaseMs &&
        (elapsed - plan.tickPhaseMs) % tickIntervalMs === 0
      ) {
        runtime.tick();
        await yieldLoop();
      }
      if (
        arrived === arrivals.length &&
        !probe.hasPending() &&
        !runtime.jobs.size &&
        !runtime.work.size
      )
        break;
    }
    const censoredTraces = probe.censor();
    captured = {
      clockPlan: plan,
      legacyFirstReplyProbe: probe.legacy,
      timing: timing.snapshot(),
      response: {
        firstInboundToFirstConfirmationMs:
          firstConfirmedAt === undefined
            ? null
            : firstConfirmedAt - epoch - arrivals[0],
        lastInboundToLatestConfirmationMs:
          latestConfirmedAt === undefined
            ? null
            : latestConfirmedAt - epoch - arrivals.at(-1),
      },
      quality: {
        ...quality,
        inbound: arrived,
        latestUnconfirmed: lastItem(acknowledged) < arrivals.length - 1 ? 1 : 0,
        arrivalsBeyondHorizon: arrivals.length - arrived,
        censoredTraces,
      },
    };
  } finally {
    try {
      if (runtime) {
        const closing = runtime.close();
        // The observation already ended. Settle any mocked transport still in flight.
        timers.tick(1000);
        await closing;
      }
    } finally {
      memory?.close();
      timers.reset();
      fs.rmSync(root, { force: true, recursive: true });
    }
  }
  return captured;
}

function trialDistribution(values) {
  const sorted = values.filter((value) => value !== null).sort((a, b) => a - b);
  const n = sorted.length;
  return {
    n,
    missing: values.length - n,
    p50Ms: sorted[Math.ceil(n * 0.5) - 1] ?? null,
    p90Ms: sorted[Math.ceil(n * 0.9) - 1] ?? null,
  };
}

function addCounters(target, source) {
  for (const [key, value] of Object.entries(source))
    target[key] = (target[key] || 0) + value;
}

export async function runMessageTimingBenchmark({
  repoRoot,
  baselineRoot,
  samples = 100,
  seed = 874137,
}) {
  if (
    !Number.isSafeInteger(samples) ||
    samples < 1 ||
    samples > 100 ||
    !Number.isSafeInteger(seed) ||
    seed < 0 ||
    seed > 0xffffffff
  )
    throw Error("INVALID_BENCHMARK_OPTIONS");
  const source = await loadBenchmarkSource(repoRoot);
  const baseline = baselineRoot
    ? await loadBenchmarkSource(baselineRoot)
    : null;
  const matrix = [
    ...(baseline
      ? [{ label: "baseline", source: baseline, policy: baselinePolicy }]
      : []),
    { label: "current", source, policy: baselinePolicy },
    {
      label: "window-candidate",
      source,
      policy: { windowMs: 2000, maxMs: 12000 },
    },
    {
      label: "cap-candidate",
      source,
      policy: { windowMs: 2000, maxMs: 15000 },
    },
  ];
  const cases = [];
  for (const entry of matrix) {
    for (const scenario of Object.keys(scenarios)) {
      const quality = {};
      const firstResponses = [];
      const latestResponses = [];
      const combined = new MessageTiming().snapshot();
      let legacyFirstReplyProbe = false;
      for (let index = 0; index < samples; index++) {
        const result = await runBenchmarkTrial(entry.source, {
          scenario,
          policy: entry.policy,
          seed,
          index,
        });
        legacyFirstReplyProbe = result.legacyFirstReplyProbe;
        firstResponses.push(result.response.firstInboundToFirstConfirmationMs);
        latestResponses.push(result.response.lastInboundToLatestConfirmationMs);
        addCounters(quality, result.quality);
        addCounters(combined.counts, result.timing.counts);
        for (const sample of result.timing.samples)
          combined.samples.push({
            ...sample,
            number: combined.samples.length + 1,
          });
      }
      cases.push({
        label: entry.label,
        revision: entry.source.revision,
        modified: entry.source.modified,
        scenario,
        policy: entry.policy,
        trials: samples,
        legacyFirstReplyProbe,
        quality,
        captureCounts: combined.counts,
        trialTimings: {
          firstInboundToFirstConfirmation: trialDistribution(firstResponses),
          lastInboundToLatestConfirmation: trialDistribution(latestResponses),
        },
        timing: analyzeMessageTiming(combined).overall,
      });
    }
  }
  return {
    schemaVersion: 1,
    synthetic: true,
    seed,
    trialsPerCell: samples,
    clockStepMs,
    tickIntervalMs,
    observationHorizonMs,
    firstReplyMaxMs,
    arrivalsMs: scenarios,
    cases,
  };
}
