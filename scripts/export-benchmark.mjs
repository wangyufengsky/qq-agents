// Synthetic, isolated acceptance run: no QQ connection or model invocation.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { MemoryStore } from "../src/memory/store.mjs";
import { Runtime } from "../src/core/runtime.mjs";
import { ConfigStore, validateConfig } from "../src/core/config.mjs";
import { createServer } from "../src/server.mjs";
import { spawn } from "node:child_process";

if (!process.argv.includes("--synthetic"))
  throw Error("Use --synthetic [--count 100000]");
const at = process.argv.indexOf("--count"),
  count = at < 0 ? 100000 : Number(process.argv[at + 1]);
if (!Number.isSafeInteger(count) || count < 1000 || count > 1000000)
  throw Error("INVALID_COUNT");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "qq-export-benchmark-"));
const store = new MemoryStore(path.join(root, "memory.sqlite"));
let runtime, server, sampling;
try {
  const insert = store.db.prepare(
    "INSERT INTO events(id,agent_id,dedupe,connection_id,conversation,kind,direction,status,message_id,sender_id,occurred_at,observed_at,body,payload,origin) VALUES(?,'bench-a',?,'qq-test','group:20000','message.received','in','observed',?,'30000',?,?,?,'{}','synthetic')",
  );
  for (let start = 0; start < count; start += 1000)
    store.transaction(() => {
      for (let i = start; i < Math.min(count, start + 1000); i++) {
        const id = "synthetic-" + i,
          stamp = new Date(1700000000000 + i * 1000).toISOString();
        insert.run(
          id,
          id,
          String(i),
          stamp,
          stamp,
          "合成记录用于导出测试；这不是实际聊天。".repeat(8),
        );
      }
    });
  store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const cfg = validateConfig({
    version: 1,
    mode: "isolated",
    globalPaused: true,
    connections: [
      {
        id: "qq-test",
        label: "Synthetic",
        accountId: "10000",
        httpUrl: "http://127.0.0.1:9",
        wsUrl: "ws://127.0.0.1:9",
        enabled: false,
      },
    ],
    backends: [{ id: "fixture", type: "codex", label: "Synthetic" }],
    agents: [
      {
        id: "bench-a",
        name: "Synthetic",
        connectionId: "qq-test",
        backendId: "fixture",
        paused: true,
        allow: { groups: ["20000"], users: [] },
      },
    ],
  });
  runtime = new Runtime({
    memory: store,
    configStore: new ConfigStore(path.join(root, "config.json"), cfg),
    backendFactory: () => {
      throw Error("NO_MODEL_IN_BENCHMARK");
    },
  });
  server = createServer({
    runtime,
    token: "synthetic-export-benchmark",
    exportOptions: { tempRoot: root },
  });
  const port = await server.listen(),
    base = `http://127.0.0.1:${port}`;
  const request = (url) =>
    fetch(base + url, {
      headers: { "x-admin-token": "synthetic-export-benchmark" },
    });
  // Warm up status and release ingestion garbage before establishing the RSS baseline.
  await (await request("/api/status")).arrayBuffer();
  global.gc?.();
  const baseline = process.memoryUsage.rss();
  let peak = baseline,
    finished = false,
    bytes = 0;
  const statusMs = [],
    inputMs = [],
    delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  sampling = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage.rss());
  }, 5);
  const poll = (async () => {
    while (!finished) {
      const start = performance.now();
      const response = await request("/api/status");
      if (!response.ok) throw Error("BENCHMARK_STATUS_FAILED");
      await response.arrayBuffer();
      statusMs.push(performance.now() - start);
      const before = performance.now();
      // A representative local arrival write while the snapshot is being prepared.
      store.bind("bench-a").append({
        dedupe: "concurrent-" + inputMs.length,
        conversation: "group:20000",
        kind: "message.received",
        body: "synthetic concurrent arrival",
      });
      inputMs.push(performance.now() - before);
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  })();
  const started = performance.now();
  try {
    // Keep client download allocations out of the server RSS measurement.
    bytes = await new Promise((resolve, reject) => {
      const client = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
        import http from 'node:http';
        http.get(process.argv[1], {headers:{'x-admin-token':'synthetic-export-benchmark'}}, res => {
          if (res.statusCode !== 200) { res.resume(); process.exitCode = 1; return; }
          let bytes = 0; res.on('data', chunk => bytes += chunk.length);
          res.on('end', () => console.log(bytes)); res.on('error', () => process.exitCode = 1);
        }).on('error', () => process.exitCode = 1);
      `,
          base + "/api/export?agentId=bench-a",
        ],
        { env: {}, stdio: ["ignore", "pipe", "inherit"] },
      );
      let result = "";
      client.stdout.on("data", (chunk) => {
        result += chunk;
      });
      client.on("error", reject);
      client.on("exit", (code) =>
        code === 0
          ? resolve(Number(result.trim()))
          : reject(Error("BENCHMARK_EXPORT_FAILED")),
      );
    });
  } finally {
    finished = true;
    await poll;
  }
  const durationMs = performance.now() - started;
  delay.disable();
  const percentile = (values, p) =>
    [...values].sort((a, b) => a - b)[
      Math.min(values.length - 1, Math.floor(values.length * p))
    ];
  const result = {
    synthetic: true,
    events: count,
    node: process.version,
    cpu: os.cpus()[0]?.model,
    exportBytes: bytes,
    durationMs: Math.round(durationMs),
    rssBaselineMiB: +(baseline / 1048576).toFixed(2),
    extraRssMiB: +((peak - baseline) / 1048576).toFixed(2),
    statusSamples: statusMs.length,
    statusP95Ms: +percentile(statusMs, 0.95).toFixed(2),
    arrivalWriteP95Ms: +percentile(inputMs, 0.95).toFixed(2),
    eventLoopP99Ms: +(delay.percentile(99) / 1e6).toFixed(2),
  };
  result.targetsPassed =
    result.extraRssMiB <= 64 &&
    result.statusP95Ms < 100 &&
    result.eventLoopP99Ms < 50;
  console.log(JSON.stringify(result, null, 2));
  if (!result.targetsPassed) process.exitCode = 1;
} finally {
  clearInterval(sampling);
  await server?.close();
  await runtime?.close();
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
}
