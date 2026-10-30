import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MemoryStore } from "../src/memory/store.mjs";
import { temp } from "./helpers.mjs";

const schemaNames = (db) =>
  db
    .prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'")
    .all()
    .map((row) => row.name);

for (const inMemory of [false, true]) {
  test(`fresh ${inMemory ? "in-memory" : "file"} initialization preserves durability and schema`, (t) => {
    const file = inMemory ? ":memory:" : path.join(temp(t), "memory.sqlite");
    const store = new MemoryStore(file);
    try {
      assert.equal(store.db.prepare("PRAGMA synchronous").get().synchronous, 2);
      assert.equal(store.db.prepare("PRAGMA busy_timeout").get().timeout, 5000);
      assert.equal(
        store.db.prepare("PRAGMA foreign_keys").get().foreign_keys,
        1,
      );
      assert.equal(
        store.db.prepare("PRAGMA user_version").get().user_version,
        6,
      );
      assert.equal(
        store.db.prepare("PRAGMA journal_mode").get().journal_mode,
        inMemory ? "memory" : "wal",
      );
      assert.equal(
        store.db.prepare("PRAGMA integrity_check").get().integrity_check,
        "ok",
      );
      for (const name of [
        "events",
        "events_fts",
        "self_versions",
        "event_timeline",
        "message_aliases",
        "conversation_due",
        "conversation_due_update",
      ]) {
        assert.ok(schemaNames(store.db).includes(name), name);
      }
      assert.equal(store.db.isTransaction, false);
    } finally {
      store.close();
    }
  });
}

test("reopening preserves events and runtime while rebuilding derived due rows", (t) => {
  const file = path.join(temp(t), "memory.sqlite");
  const first = new MemoryStore(file);
  let id;
  try {
    id = first.bind("fixture").append({
      dedupe: "fixture-message",
      conversation: "group:20000",
      kind: "message.received",
      body: "fixture searchable message",
    }).id;
    first.db
      .prepare("INSERT INTO runtime VALUES(?,?,?)")
      .run("fixture", "group:20000", JSON.stringify({ replyCheckAt: 1000 }));
    assert.equal(first.due.current("fixture", "group:20000").next_due_at, 1000);
    first.db.prepare("UPDATE conversation_due SET next_due_at=2000").run();
    for (const status of ["pending", "unknown", "sent"]) {
      first.db
        .prepare("INSERT INTO deliveries VALUES(?,?,?,?,?,?,?,?)")
        .run(
          "fixture",
          status,
          "group:20000",
          "fixture-hash",
          status,
          status === "sent" ? "10000" : null,
          "2026-01-01",
          "2026-01-01",
        );
    }
  } finally {
    first.close();
  }
  const second = new MemoryStore(file);
  try {
    assert.equal(second.db.prepare("SELECT id,body FROM events").get().id, id);
    assert.equal(
      second.db
        .prepare(
          "SELECT count(*) AS count FROM events_fts WHERE events_fts MATCH 'searchable'",
        )
        .get().count,
      1,
    );
    assert.deepEqual(
      JSON.parse(second.db.prepare("SELECT value FROM runtime").get().value),
      { replyCheckAt: 1000 },
    );
    assert.equal(
      second.due.current("fixture", "group:20000").next_due_at,
      1000,
    );
    assert.deepEqual(
      second.db
        .prepare(
          "SELECT request_id,status,message_id FROM deliveries ORDER BY request_id",
        )
        .all()
        .map((row) => ({ ...row })),
      [
        { request_id: "pending", status: "pending", message_id: null },
        { request_id: "sent", status: "sent", message_id: "10000" },
        { request_id: "unknown", status: "unknown", message_id: null },
      ],
    );
    assert.equal(second.db.isTransaction, false);
  } finally {
    second.close();
  }
  const readonly = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(
      readonly.prepare("SELECT count(*) AS count FROM events").get().count,
      1,
    );
    assert.equal(readonly.prepare("PRAGMA user_version").get().user_version, 6);
  } finally {
    readonly.close();
  }
});

for (const stage of [
  {
    name: "base schema",
    marker: "CREATE TABLE IF NOT EXISTS events(",
    absent: "events",
    version: 0,
  },
  {
    name: "identity migration",
    marker: "CREATE TABLE IF NOT EXISTS self_versions(",
    absent: "self_versions",
    version: 3,
  },
  {
    name: "due schema",
    marker: "CREATE TABLE IF NOT EXISTS conversation_due(",
    absent: "conversation_due",
    version: 6,
  },
]) {
  test(`${stage.name} failure rolls back its batch, closes the connection and permits recovery`, (t) => {
    const file = path.join(temp(t), "memory.sqlite");
    const originalExec = DatabaseSync.prototype.exec;
    const failure = new Error("FIXTURE_INITIALIZATION_FAILURE");
    let failedDb;
    const stub = t.mock.method(DatabaseSync.prototype, "exec", function (sql) {
      const result = originalExec.call(this, sql);
      if (sql.includes(stage.marker)) {
        failedDb = this;
        // Fail after the statements ran, so partial DDL and user_version writes
        // must be undone rather than merely never having been attempted.
        throw failure;
      }
      return result;
    });
    try {
      assert.throws(
        () => new MemoryStore(file),
        (error) => error === failure,
      );
    } finally {
      stub.mock.restore();
    }
    assert.ok(failedDb);
    assert.throws(() => failedDb.prepare("SELECT 1"), /not open/i);
    const inspection = new DatabaseSync(file);
    try {
      assert.equal(
        inspection.prepare("PRAGMA user_version").get().user_version,
        stage.version,
      );
      assert.equal(schemaNames(inspection).includes(stage.absent), false);
      assert.equal(
        inspection.prepare("PRAGMA integrity_check").get().integrity_check,
        "ok",
      );
    } finally {
      inspection.close();
    }
    // In the identity case this reopens an actual schema-3 database, proving
    // the migration can retry without falsely claiming schema 4 is complete.
    const recovered = new MemoryStore(file);
    try {
      assert.equal(
        recovered.db.prepare("PRAGMA user_version").get().user_version,
        6,
      );
      assert.ok(schemaNames(recovered.db).includes(stage.absent));
      assert.equal(recovered.db.isTransaction, false);
      recovered.bind("fixture").append({
        dedupe: "after-recovery",
        conversation: "group:20000",
        kind: "message.received",
        body: "fixture recovered",
      });
    } finally {
      recovered.close();
    }
  });
}

test("due rebuild failure preserves existing derived rows and authoritative state", (t) => {
  const file = path.join(temp(t), "memory.sqlite");
  const initial = new MemoryStore(file);
  try {
    initial.db
      .prepare("INSERT INTO runtime VALUES(?,?,?)")
      .run("fixture", "group:20000", JSON.stringify({ replyCheckAt: 1000 }));
    initial.db.exec("UPDATE conversation_due SET next_due_at=2000");
  } finally {
    initial.close();
  }
  const originalPrepare = DatabaseSync.prototype.prepare;
  const failure = new Error("FIXTURE_REBUILD_FAILURE");
  let failedDb;
  const stub = t.mock.method(DatabaseSync.prototype, "prepare", function (sql) {
    if (sql.includes("INSERT INTO conversation_due SELECT")) {
      failedDb = this;
      // The rebuild has already deleted the old rows inside its savepoint.
      throw failure;
    }
    return originalPrepare.call(this, sql);
  });
  try {
    assert.throws(
      () => new MemoryStore(file),
      (error) => error === failure,
    );
  } finally {
    stub.mock.restore();
  }
  assert.throws(() => failedDb.prepare("SELECT 1"), /not open/i);
  const inspection = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(
      inspection.prepare("SELECT next_due_at FROM conversation_due").get()
        .next_due_at,
      2000,
    );
    assert.deepEqual(
      JSON.parse(inspection.prepare("SELECT value FROM runtime").get().value),
      { replyCheckAt: 1000 },
    );
  } finally {
    inspection.close();
  }
  const recovered = new MemoryStore(file);
  try {
    assert.equal(
      recovered.due.current("fixture", "group:20000").next_due_at,
      1000,
    );
  } finally {
    recovered.close();
  }
});

test("future schema is rejected without changing journal mode, schema or data", (t) => {
  const file = path.join(temp(t), "memory.sqlite");
  const initial = new DatabaseSync(file);
  try {
    initial.exec(
      "CREATE TABLE future_data(value TEXT); INSERT INTO future_data VALUES('fixture'); PRAGMA user_version=7;",
    );
  } finally {
    initial.close();
  }
  assert.throws(() => new MemoryStore(file), /MEMORY_SCHEMA_NEWER_THAN_CODE/);
  const inspection = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(
      inspection.prepare("PRAGMA journal_mode").get().journal_mode,
      "delete",
    );
    assert.equal(
      inspection.prepare("PRAGMA user_version").get().user_version,
      7,
    );
    assert.deepEqual(schemaNames(inspection), ["future_data"]);
    assert.equal(
      inspection.prepare("SELECT value FROM future_data").get().value,
      "fixture",
    );
  } finally {
    inspection.close();
  }
});
