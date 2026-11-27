import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { DREAM_TABLES } from "../src/dream/schema.mjs";
import {
  startDream,
  commitDream,
  recoverDreamRuns,
} from "../src/dream/store.mjs";
import {
  EXPORT_TABLES,
  exportDigest,
  validateExport,
} from "../src/memory/export-format.mjs";
import { restoreExport } from "../src/memory/migrate.mjs";
import { MemoryStore } from "../src/memory/store.mjs";
import { fixture, temp } from "./helpers.mjs";

const role = "agent-0";
const group = "group:20000";
const options = { backendId: "fixture", model: "fixture", batchSize: 120 };
const noChanges = {
  schemaVersion: 1,
  operations: [],
  awakeningSummary: "",
  noChangesReason: "无长期变更。",
};
const add = (evidenceIds) => ({
  op: "ADD",
  category: "preference",
  scopeId: group,
  subjectKey: "user:30000:tea",
  content: "用户说自己喜欢茶。",
  epistemicStatus: "reported",
  importance: 0.7,
  confidence: 0.8,
  evidenceIds,
  reason: "用户明确自述。",
});
const patch = (...operations) => ({
  schemaVersion: 1,
  operations,
  awakeningSummary: "",
  noChangesReason: null,
});
const access = (snapshot) => ({
  privateRead: new Set(snapshot.items.map((item) => item.id)),
  fingerprints: new Map(
    snapshot.items.map((item) => [item.id, item.fingerprint]),
  ),
  maxOps: 20,
});
const append = (memory, dedupe, other = {}) =>
  memory.append({
    dedupe,
    conversation: group,
    kind: "message.received",
    body: "我喜欢茶。",
    senderId: "30000",
    connectionId: "qq-0",
    payload: { trustedInput: true },
    ...other,
  });

test("schema 8 opens as schema 9 and all eight tables are role-exportable", (t) => {
  const file = path.join(temp(t), "memory.sqlite");
  const old = new MemoryStore(file);
  const source = append(old.bind(role), "history");
  old.db.exec(
    DREAM_TABLES.map((table) => `DROP TABLE ${table}`).join(";") +
      "; PRAGMA user_version=8",
  );
  old.close();
  const upgraded = new MemoryStore(file);
  t.after(() => upgraded.close());
  assert.equal(
    upgraded.db.prepare("PRAGMA user_version").get().user_version,
    9,
  );
  assert.equal(
    upgraded.db.prepare("SELECT id FROM events").get().id,
    source.id,
  );
  const exported = upgraded.bind(role).export();
  for (const table of DREAM_TABLES)
    assert.deepEqual(exported.tables[table], []);
  validateExport(exported);
});

test("nonempty targets remap only the exported role's consumed event, diary and correction positions", (t) => {
  const { runtime, store } = fixture(t);
  const memory = store.bind(role);
  const first = append(memory, "first");
  append(store.bind("agent-1"), "other event");
  const entry = memory.diaryWrite({ title: "日记", body: "初稿" });
  memory.corrections.put({
    id: "correction-first",
    sourceId: first.id,
    oldBelief: "之前",
    current: "现在",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const { snapshot } = startDream(runtime, role, options);
  commitDream(runtime, snapshot, noChanges, access(snapshot));
  const following = append(memory, "following");
  memory.diaryRevise({
    ...entry,
    expectedRevision: 1,
    title: "日记",
    body: "修订内容",
  });
  memory.corrections.put({
    id: "correction-following",
    sourceId: following.id,
    oldBelief: "以前",
    current: "已更正",
    createdAt: "2026-01-02T00:00:00.000Z",
  });

  const exported = memory.export();
  const target = new MemoryStore(":memory:");
  t.after(() => target.close());
  for (let i = 0; i < 4; i++) {
    const other = target.bind("agent-2");
    append(other, "other-" + i);
    other.diaryWrite({ title: "其他角色", body: "其他角色日记" });
    other.corrections.put({ id: "other-correction-" + i });
  }
  restoreExport(target.bind(role), exported);
  const { snapshot: restored } = startDream(
    { ...runtime, memory: target, now: () => runtime.now() },
    role,
    options,
  );
  assert.deepEqual(
    restored.items.map((item) => item.id),
    [following.id, entry.id, "correction-following"],
  );
  assert.equal(restored.cursorStart.events, 5);
  assert.equal(restored.cursorEnd.events, 6);

  for (const version of [2, 3]) {
    const legacy = structuredClone(exported);
    legacy.version = version;
    for (const table of Object.keys(legacy.tables))
      if (
        DREAM_TABLES.includes(table) ||
        (version === 2 && table.startsWith("input_"))
      )
        delete legacy.tables[table];
    const digest = exportDigest(legacy);
    for (const name of EXPORT_TABLES.filter((name) =>
      Object.hasOwn(legacy.tables, name),
    )) {
      const rows = legacy.tables[name];
      digest.update(name + "\n");
      for (const row of rows) digest.update(JSON.stringify(row) + "\n");
    }
    legacy.manifest.counts = Object.fromEntries(
      Object.entries(legacy.tables).map(([name, rows]) => [name, rows.length]),
    );
    legacy.manifest.sha256 = digest.digest("hex");
    const target = new MemoryStore(":memory:");
    try {
      restoreExport(target.bind(role), legacy);
      assert.equal(
        target.db.prepare("SELECT count(*) AS n FROM cognitions").get().n,
        0,
      );
    } finally {
      target.close();
    }
  }
});

test("ADD and UPDATE append stable revisions, reject stale edits and roll back the whole batch", (t) => {
  const {
    runtime,
    store: { db },
  } = fixture(t);
  const memory = runtime.memory.bind(role);
  const event = append(memory, "first");
  const { snapshot } = startDream(runtime, role, options);
  const payload = patch(add([event.id]), add([event.id]));
  assert.throws(
    () => commitDream(runtime, snapshot, payload, access(snapshot)),
    /DREAM_DUPLICATE_SUBJECT_KEY/,
  );
  for (const table of [
    "cognitions",
    "cognition_evidence",
    "cognition_revisions",
    "dream_checkpoints",
  ])
    assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);

  commitDream(runtime, snapshot, patch(add([event.id])), access(snapshot));
  const { id, version } = db.prepare("SELECT id,version FROM cognitions").get();
  assert.equal(version, 1);
  const next = append(memory, "next", { body: "我最近改喝咖啡。" });
  const { snapshot: followup } = startDream(runtime, role, options);
  const update = {
    op: "UPDATE",
    targetId: id,
    expectedVersion: 1,
    content: "用户近期改喝咖啡。",
    epistemicStatus: "reported",
    evidenceIds: [next.id],
    reason: "用户明确更正。",
  };
  assert.throws(
    () =>
      commitDream(
        runtime,
        followup,
        patch({ ...update, expectedVersion: 2 }),
        access(followup),
      ),
    /DREAM_VERSION_CONFLICT/,
  );
  commitDream(runtime, followup, patch(update), access(followup));
  assert.equal(
    db.prepare("SELECT version FROM cognitions WHERE id=?").get(id).version,
    2,
  );
  assert.deepEqual(
    db
      .prepare(
        "SELECT op FROM cognition_revisions WHERE cognition_id=? ORDER BY version",
      )
      .all(id)
      .map(({ op }) => op),
    ["ADD", "UPDATE"],
  );

  const { snapshot: pending } = startDream(runtime, role, options);
  recoverDreamRuns(db, runtime.now());
  assert.deepEqual(
    {
      ...db
        .prepare("SELECT status,error_code FROM dream_runs WHERE run_id=?")
        .get(pending.runId),
    },
    { status: "FAILED", error_code: "DREAM_INTERRUPTED" },
  );
  assert.equal(
    db
      .prepare(
        "SELECT last_event_seq FROM dream_checkpoints WHERE source_partition='events'",
      )
      .get().last_event_seq,
    next.seq,
  );
});

test("a correction whose supporting message is outside a batch remains pending", (t) => {
  const { runtime, store } = fixture(t);
  const memory = store.bind(role);
  append(memory, "first");
  const later = append(memory, "later");
  memory.corrections.put({
    id: "later-correction",
    sourceId: later.id,
    oldBelief: "以前",
    current: "已更正",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const { snapshot } = startDream(runtime, role, { ...options, batchSize: 1 });
  assert.equal(snapshot.cursorEnd.corrections, 0);
  assert.equal(
    snapshot.items.some(({ type }) => type === "correction"),
    false,
  );
  commitDream(runtime, snapshot, noChanges, access(snapshot));
  const { snapshot: next } = startDream(runtime, role, {
    ...options,
    batchSize: 1,
  });
  assert.ok(next.items.some(({ id }) => id === "later-correction"));
});
