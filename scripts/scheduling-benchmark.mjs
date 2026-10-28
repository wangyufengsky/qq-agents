// @ts-check
// Synthetic inactive conversations; no external services or production data.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import {
  setImmediate as yieldLoop,
  setTimeout as delay,
} from "node:timers/promises";
import { MemoryStore } from "../src/memory/store.mjs";
import { ConfigStore } from "../src/core/config.mjs";
import { defaultConfig } from "../src/core/default-config.mjs";
import { Runtime } from "../src/core/runtime.mjs";
if (!process.argv.includes("--synthetic"))
  throw Error("Use --synthetic; optional --out results.json");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "qq-scheduling-bench-"));
const cases = [];
try {
  for (const count of [10, 100, 1000, 10000]) {
    const store = new MemoryStore(path.join(root, `case-${count}.sqlite`));
    const initial = defaultConfig();
    initial.mode = "live";
    initial.globalPaused = false;
    initial.agents[0].paused = false;
    initial.agents = initial.agents.slice(0, 1);
    const configStore = new ConfigStore(
      path.join(root, `config-${count}.json`),
      initial,
    );
    const runtime = new Runtime({
      configStore,
      memory: store,
      backendFactory: () => {
        throw Error("UNEXPECTED_BACKEND_CALL");
      },
    });
    try {
      const m = store.bind(initial.agents[0].id);
      store.transaction(() => {
        for (let i = 0; i < count; i++)
          m.setState("group:" + (20000 + i), {
            readThroughSeq: 0,
            syntheticPadding: "x".repeat(1024),
          });
      });
      const oldScan = store.db
        .prepare(`SELECT conversation FROM runtime WHERE agent_id=? AND conversation GLOB '[gp]*:*' AND (
        json_extract(value,'$.pendingWakes[0]') IS NOT NULL OR
        json_extract(value,'$.wakeConfig.sleepUntil') IS NOT NULL OR
        json_extract(value,'$.replyCheckAt') IS NOT NULL)`);
      /** @param {number[]} samples @param {number} q */
      const percentile = (samples, q) => {
        samples.sort((a, b) => a - b);
        const index = Math.min(
          samples.length - 1,
          Math.floor(samples.length * q),
        );
        return +samples[index].toFixed(3);
      };
      /** @param {() => unknown} fn */
      const measure = async (fn) => {
        const samples = [],
          histogram = monitorEventLoopDelay({ resolution: 1 });
        histogram.enable();
        for (let i = 0; i < 110; i++) {
          const start = performance.now();
          fn();
          if (i >= 10) samples.push(performance.now() - start);
          await yieldLoop();
        }
        await delay(5);
        histogram.disable();
        return {
          medianMs: percentile(samples, 0.5),
          p95Ms: percentile(samples, 0.95),
          eventLoopP99Ms: +(histogram.percentile(99) / 1e6).toFixed(3),
        };
      };
      cases.push({
        count,
        legacyCandidateQuery: await measure(() => oldScan.all(m.agentId)),
        indexedCandidates: await measure(() => store.due.ready(runtime.now())),
        fullCurrentTick: await measure(() => runtime.tick()),
        queryPlan: store.db
          .prepare(
            "EXPLAIN QUERY PLAN SELECT * FROM conversation_due WHERE next_due_at<=? ORDER BY next_due_at,agent_id,conversation LIMIT 256",
          )
          .all(runtime.now())
          .map((r) => r.detail),
      });
    } finally {
      await runtime.close();
      store.close();
    }
  }
  const report = {
    synthetic: true,
    node: process.version,
    sqlite: process.versions.sqlite,
    platform: process.platform,
    cpu: os.cpus()[0]?.model,
    paddingBytesPerConversation: 1024,
    samples: 100,
    note: "Legacy comparison measures the old candidate SQL only; fullCurrentTick measures the current whole tick. No due tasks, models, QQ or optional slang research.",
    cases,
  };
  const text = JSON.stringify(report, null, 2) + "\n";
  const out = process.argv.indexOf("--out");
  if (out !== -1) fs.writeFileSync(process.argv[out + 1], text);
  console.log(text);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
