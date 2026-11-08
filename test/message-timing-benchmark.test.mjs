import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  loadBenchmarkSource,
  runBenchmarkTrial,
  runMessageTimingBenchmark,
} from "../scripts/fixtures/message-timing-benchmark.mjs";
import { disabledMessageTimingSnapshot } from "../src/core/message-timing.mjs";
import { temp } from "./helpers.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const base = {
  policy: { windowMs: 4000, maxMs: 12000 },
  seed: 874137,
  index: 0,
};

test("virtual clock exercises real batch, model and receipt boundaries reproducibly", async (t) => {
  const source = await loadBenchmarkSource(repoRoot);
  const options = { ...base, scenario: "single", timers: t.mock.timers };
  const first = await runBenchmarkTrial(source, options);
  const repeat = await runBenchmarkTrial(source, options);
  assert.deepEqual(first, repeat);

  const [sample] = first.timing.samples;
  assert.equal(sample.marks.firstInbound, 0);
  assert.equal(sample.marks.lastInbound, 0);
  assert.equal(sample.marks.batchReady, 4000);
  assert.equal(sample.marks.dispatched % 1000, first.clockPlan.tickPhaseMs);
  assert.equal(
    sample.marks.sendRequested - sample.marks.backendInputSubmitted,
    first.clockPlan.modelMs,
  );
  const [{ marks, outcome }] = sample.deliveries;
  assert.equal(outcome, "confirmed");
  assert.equal(
    marks.gatewayConfirmed - marks.submitted,
    first.clockPlan.gatewayMs,
  );
  assert.equal(
    marks.ledgerConfirmed,
    first.response.firstInboundToFirstConfirmationMs,
  );
  assert.equal(first.quality.latestUnconfirmed, 0);
  assert.equal(first.quality.confirmed, 1);
  assert.equal(first.quality.staleSubmissions, 0);
  assert.equal(first.quality.missedSupplements, 0);

  const simulation = sample.intervals.find(
    (span) => span.kind === "simulation",
  );
  if (first.legacyFirstReplyProbe)
    assert.equal(simulation.end - simulation.start, 6000);
  else assert.equal(simulation, undefined);
});

test("continuous arrival fixture scores an actual stale legacy send", async (t) => {
  const source = await loadBenchmarkSource(repoRoot);
  const result = await runBenchmarkTrial(source, {
    ...base,
    scenario: "continuous",
    index: 2,
    timers: t.mock.timers,
  });
  assert.equal(result.quality.inbound, 16);
  assert.equal(result.clockPlan.replyChars, 5);
  assert.equal(result.quality.latestUnconfirmed, 0);
  if (result.legacyFirstReplyProbe) {
    assert(result.quality.staleSubmissions > 0);
    assert(result.quality.missedSupplements > 0);
  } else {
    assert.equal(result.quality.staleSubmissions, 0);
    assert.equal(result.quality.missedSupplements, 0);
  }
});

function withFilteredOpening(source, filter) {
  const prefix = "新增消息：";
  return {
    ...source,
    Runtime: class extends source.Runtime {
      constructor(options) {
        let turn = 0;
        super({
          ...options,
          backendFactory: (...args) => {
            const backend = options.backendFactory(...args);
            const run = backend.run;
            backend.run = (parameters) => {
              turn++;
              return run({
                ...parameters,
                prompt: parameters.prompt
                  .split("\n")
                  .map((line) => {
                    if (!line.startsWith(prefix)) return line;
                    return (
                      prefix +
                      JSON.stringify(
                        filter(JSON.parse(line.slice(prefix.length)), turn),
                      )
                    );
                  })
                  .join("\n"),
              });
            };
            return backend;
          },
        });
      }
    },
  };
}

test("latest confirmation does not hide an earlier unacknowledged fixture input", async (t) => {
  const source = withFilteredOpening(
    await loadBenchmarkSource(repoRoot),
    (page) => ({
      ...page,
      items: page.items.filter(({ body }) => body !== "fixture item 1"),
    }),
  );
  const trial = await runBenchmarkTrial(source, {
    ...base,
    scenario: "fragments",
    timers: t.mock.timers,
  });
  assert.equal(trial.quality.latestUnconfirmed, 0);
  assert.equal(trial.quality.staleSubmissions, 0);
  assert.equal(trial.quality.incompleteSubmissions, 1);
  assert.equal(trial.quality.uniqueMissedAtSubmission, 1);
  assert.equal(trial.quality.unacknowledgedInputsAtHorizon, 1);
  assert.equal(trial.quality.fullyCovered, 0);
  assert.notEqual(trial.response.lastInboundToLatestConfirmationMs, null);
  assert.equal(trial.response.lastInboundToFullCoverageMs, null);
});

test("a wake that receives only already acknowledged content is a presentation gap", async (t) => {
  const source = withFilteredOpening(
    await loadBenchmarkSource(repoRoot),
    (page, turn) =>
      turn === 1
        ? page
        : {
            ...page,
            truncated: false,
            items: page.items.filter(({ body }) => body === "fixture item 0"),
          },
  );
  const trial = await runBenchmarkTrial(source, {
    ...base,
    scenario: "continuous",
    index: 2,
    timers: t.mock.timers,
  });
  assert(trial.quality.missingModelInput > 0);
  assert.equal(trial.quality.intentionallySilentTurns, 0);
  assert(trial.quality.unacknowledgedInputsAtHorizon > 0);
  assert.equal(trial.response.lastInboundToFullCoverageMs, null);
});

test("observation cutoff keeps in-flight work out of the confirmation distribution", async (t) => {
  const source = await loadBenchmarkSource(repoRoot);
  const result = await runBenchmarkTrial(source, {
    ...base,
    scenario: "single",
    horizonMs: 4500,
    timers: t.mock.timers,
  });
  assert.equal(result.quality.inbound, 1);
  assert.equal(result.quality.confirmed, 0);
  assert.equal(result.quality.censoredTraces, 1);
  assert.equal(result.quality.latestUnconfirmed, 1);
  assert.equal(result.response.firstInboundToFirstConfirmationMs, null);
  assert.equal(result.timing.samples[0].outcome, "censored");
});

test("benchmark retains each scenario and changes one batch parameter at a time", async () => {
  const report = await runMessageTimingBenchmark({
    repoRoot,
    baselineRoot: repoRoot,
    samples: 1,
    seed: base.seed,
  });
  assert.equal(report.synthetic, true);
  assert.equal(report.cases.length, 12);
  const cases = Object.fromEntries(
    report.cases.map((row) => [row.label + ":" + row.scenario, row]),
  );
  assert.deepEqual(
    cases["baseline:fragments"].trialTimings,
    cases["current:fragments"].trialTimings,
  );
  assert.deepEqual(cases["window-candidate:single"].policy, {
    windowMs: 2000,
    maxMs: 12000,
  });
  assert.deepEqual(cases["cap-candidate:single"].policy, {
    windowMs: 2000,
    maxMs: 15000,
  });
  assert.equal(
    cases["current:single"].timing.traceTimings.firstInboundToReady.p50Ms,
    4000,
  );
  assert.equal(
    cases["window-candidate:single"].timing.traceTimings.firstInboundToReady
      .p50Ms,
    2000,
  );
  assert.equal(cases["cap-candidate:continuous"].quality.inbound, 16);
  assert.equal(
    cases["cap-candidate:continuous"].trialTimings
      .lastInboundToLatestConfirmation.n,
    1,
  );
});

test("offline CLI only analyzes the versioned timing snapshot and never overwrites output", (t) => {
  const directory = temp(t);
  const file = path.join(directory, "capture.json");
  const out = path.join(directory, "summary.json");
  const cli = fileURLToPath(
    new URL("../scripts/message-timing.mjs", import.meta.url),
  );
  const run = (...args) =>
    spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });

  fs.writeFileSync(file, JSON.stringify(disabledMessageTimingSnapshot()));
  const valid = run("--analyze", file, "--out", out);
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(JSON.parse(fs.readFileSync(out, "utf8")).enabled, false);
  assert.notEqual(run("--analyze", file, "--out", out).status, 0);
  assert.equal(JSON.parse(fs.readFileSync(out, "utf8")).enabled, false);
  fs.writeFileSync(file, '{"body":"fixture-only"}');
  const invalid = run("--analyze", file);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /INVALID_MESSAGE_TIMING_SNAPSHOT/);
  assert.doesNotMatch(invalid.stderr, /fixture-only/);
});
