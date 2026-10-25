// Synthetic data only. Opt-in because this creates a sizeable private database.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { MemoryStore } from "../src/memory/store.mjs";
const args = process.argv.slice(2),
  get = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
if (!args.includes("--synthetic"))
  throw Error("Use --synthetic [--count 200000] [--out work/memory-benchmark]");
const count = Number(get("--count", "200000")),
  root = path.resolve(get("--out", "work/memory-benchmark"));
if (!Number.isSafeInteger(count) || count < 1000 || count > 2000000)
  throw Error("INVALID_COUNT");
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
const file = path.join(root, "benchmark.sqlite");
if (fs.existsSync(file)) throw Error("BENCHMARK_REQUIRES_NEW_DATABASE");
const store = new MemoryStore(file),
  a = store.bind("bench-a"),
  start = performance.now();
const insert = store.db.prepare(
  `INSERT INTO events(id,agent_id,dedupe,connection_id,conversation,kind,direction,status,message_id,sender_id,occurred_at,observed_at,body,payload,origin) VALUES(?,?,?,?,?,'message.received','in','observed',?,?,?,? ,?,'{}','synthetic')`,
);
for (let base = 0; base < count; base += 1000)
  store.transaction(() => {
    for (let i = base; i < Math.min(count, base + 1000); i++) {
      const stamp = new Date(1700000000000 + i * 1000).toISOString();
      insert.run(
        "synthetic-" + i,
        i % 10 === 0 ? "bench-b" : "bench-a",
        "event-" + i,
        "connection-" + (i % 2),
        "group:" + String(20000 + (i % 20)),
        String(i),
        String(30000 + (i % 100)),
        stamp,
        stamp,
        `第${i}条 今日计划讨论 工作生活天气与多人交流 ${i % 10007 === 1 ? "稀有蓝鲸实验 小明 更正" : "普通消息"} ${i % 511 === 1 ? "百分号%_与ABC" : ""}。` +
          "合成记录只用于性能测试。".repeat(5),
      );
    }
  });
const ingestMs = performance.now() - start;
store.db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA optimize;");
function timing(fn) {
  const times = [];
  let n;
  for (let i = 0; i < 9; i++) {
    const t = performance.now();
    n = fn();
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  return {
    medianMs: +times[4].toFixed(3),
    p95Ms: +times[8].toFixed(3),
    count: n,
  };
}
const cases = [];
for (const query of [
  "稀有蓝鲸实验",
  "蓝鲸",
  "明",
  "%_",
  "ABC",
  "不存在的长词",
]) {
  const pattern = "%" + query.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
  const baseline = timing(
    () =>
      store.db
        .prepare(
          "SELECT id FROM events WHERE agent_id=? AND body LIKE ? ESCAPE '\\' ORDER BY seq DESC LIMIT 11",
        )
        .all("bench-a", pattern).length,
  );
  const indexed = timing(
    () =>
      a.search({
        query,
        type: "event",
        contextBefore: 0,
        contextAfter: 0,
        maxChars: 16000,
      }).items.length,
  );
  cases.push({ query, baselineSql: baseline, fullSearch: indexed });
}
const filtered = timing(
  () =>
    a.search({
      person: "30001",
      conversation: "group:20001",
      from: "2023-01-01",
      to: "2027-01-01",
      maxChars: 16000,
    }).items.length,
);
const result = {
  synthetic: true,
  count,
  environment: {
    node: process.version,
    sqlite: store.db.prepare("SELECT sqlite_version() version").get().version,
    platform: process.platform,
    arch: process.arch,
    cpu: os.cpus()[0]?.model,
  },
  ingestMs: +ingestMs.toFixed(1),
  databaseBytes: fs.statSync(file).size,
  cases,
  personSourceTime: filtered,
  integrity: store.db.prepare("PRAGMA integrity_check").get().integrity_check,
  fts: store.db
    .prepare("SELECT name FROM sqlite_master WHERE name='events_fts'")
    .get()?.name,
};
fs.writeFileSync(
  path.join(root, "results.json"),
  JSON.stringify(result, null, 2),
);
console.log(JSON.stringify(result, null, 2));
store.close();
