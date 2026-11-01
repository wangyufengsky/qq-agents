import { withoutClosenessCache } from "../core/closeness.mjs";
import fs from "node:fs";
import { DatabaseSync, backup } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { EXPORT_TABLES, exportDigest } from "./export-format.mjs";

const { source, snapshot, output, agentId, limits } = workerData;
const cancelled = new Int32Array(workerData.cancelled);
const checkCancelled = () => {
  if (Atomics.load(cancelled, 0)) throw Error("EXPORT_CANCELLED");
};
let db, fd;
try {
  db = new DatabaseSync(source, { readOnly: true });
  db.exec("PRAGMA busy_timeout=1000; PRAGMA cache_size=-2048");
  const pageSize = db.prepare("PRAGMA page_size").get().page_size;
  const checkSize = (pages) => {
    if (pages * pageSize > limits.snapshotBytes)
      throw Error("EXPORT_SNAPSHOT_BUDGET");
  };
  checkSize(db.prepare("PRAGMA page_count").get().page_count);
  fs.closeSync(fs.openSync(snapshot, "wx", 0o600));
  // Pin one WAL snapshot only during the backup. Otherwise steady writes from
  // the live connection restart each incremental backup and can starve exports.
  // No live transaction remains open while rows are encoded or downloaded.
  db.exec("BEGIN");
  db.prepare("SELECT count(*) FROM sqlite_schema").get();
  const snapshotDeadline = Date.now() + limits.snapshotMs;
  const checkSnapshot = () => {
    checkCancelled();
    if (Date.now() >= snapshotDeadline) throw Error("EXPORT_TIMEOUT");
  };
  checkSnapshot();
  await backup(db, snapshot, {
    rate: 128,
    progress: ({ totalPages }) => {
      checkSnapshot();
      checkSize(totalPages);
    },
  });
  checkSnapshot();
  db.close();
  db = new DatabaseSync(snapshot, { readOnly: true });
  db.exec("PRAGMA cache_size=-2048; PRAGMA mmap_size=0");
  if (db.prepare("PRAGMA user_version").get().user_version !== 6)
    throw Error("UNSUPPORTED_EXPORT_SCHEMA");
  fd = fs.openSync(output, "wx", 0o600);
  let bytes = 0;
  const write = (value) => {
    checkCancelled();
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
    bytes += buffer.length;
    if (bytes > limits.outputBytes) throw Error("EXPORT_OUTPUT_BUDGET");
    let offset = 0;
    while (offset < buffer.length) offset += fs.writeSync(fd, buffer, offset);
  };
  const header = { version: 2, agentId, exportedAt: new Date().toISOString() };
  const digest = exportDigest(header),
    counts = {};
  write(JSON.stringify(header).slice(0, -1) + ',"tables":{');
  for (const [i, name] of EXPORT_TABLES.entries()) {
    const from =
      name === "diary_revisions"
        ? "diary_revisions r JOIN diaries d ON d.id=r.id WHERE d.agent_id=?"
        : `${name} r WHERE r.agent_id=?`;
    // Check encoded column sizes in SQLite before materializing a large row in JS.
    const columns = db
      .prepare(`PRAGMA table_info(${name})`)
      .all()
      .map((x) => x.name);
    const size = columns
      .map((c) => `coalesce(octet_length(r.${c}),0)`)
      .join("+");
    if (
      db
        .prepare(`SELECT 1 FROM ${from} AND (${size})>? LIMIT 1`)
        .get(agentId, limits.rowBytes)
    )
      throw Error("EXPORT_ROW_BUDGET");
    write((i ? "," : "") + JSON.stringify(name) + ":[");
    digest.update(name + "\n");
    let count = 0;
    for (const row of db
      .prepare(
        // Restore assigns new rowids in file order; moods find the latest by rowid.
        `SELECT r.* FROM ${from}${name === "events" ? " ORDER BY r.seq" : name === "moods" ? " ORDER BY r.rowid" : ""}`,
      )
      .iterate(agentId)) {
      if (name === "person_notes")
        row.value = JSON.stringify(
          withoutClosenessCache(JSON.parse(row.value)),
        );
      const json = Buffer.from(JSON.stringify(row));
      if (json.length > limits.rowBytes) throw Error("EXPORT_ROW_BUDGET");
      if (count++) write(",");
      write(json);
      digest.update(json).update("\n");
    }
    counts[name] = count;
    write("]");
  }
  write(
    '},"manifest":' +
      JSON.stringify({
        algorithm: "sha256",
        counts,
        sha256: digest.digest("hex"),
      }) +
      "}",
  );
  fs.fsyncSync(fd);
  parentPort.postMessage({ bytes });
} catch (error) {
  // Never send SQLite messages, private paths, or row data across this boundary.
  parentPort.postMessage({
    error: /^(EXPORT_[A-Z_]+|UNSUPPORTED_EXPORT_SCHEMA)$/.test(error.message)
      ? error.message
      : "EXPORT_FAILED",
  });
} finally {
  if (fd !== undefined) fs.closeSync(fd);
  db?.close();
}
