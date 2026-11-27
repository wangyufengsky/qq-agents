import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { DREAM_TABLES } from "../src/dream/schema.mjs";
import {
  startDream,
  commitDream,
  recoverDreamRuns,
  rollbackCognition,
  deleteCognition,
  planDreamPatch,
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

test("schema 8 opens as schema 10 and all eight tables are role-exportable", (t) => {
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
    10,
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
    ["correction-following", following.id, entry.id],
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

test("merge, link, archive, score changes and rollback share the transaction and rebuild verified summaries", (t) => {
  const {
    runtime,
    store: { db },
  } = fixture(t);
  const memory = runtime.memory.bind(role);
  const read = (id) =>
    db.prepare("SELECT * FROM cognitions WHERE id=?").get(id);
  const first = append(memory, "extended-first");
  const privateRecord = append(memory, "extended-private", {
    conversation: "private:30000",
  });
  const { snapshot } = startDream(runtime, role, options);
  commitDream(
    runtime,
    snapshot,
    patch(add([first.id]), {
      ...add([privateRecord.id]),
      scopeId: "global",
      subjectKey: "user:30000:private-tea",
    }),
    access(snapshot),
  );
  const target = db
    .prepare("SELECT id FROM cognitions WHERE scope_id=?")
    .get(group).id;
  const source = db
    .prepare("SELECT id FROM cognitions WHERE scope_id='global'")
    .get().id;
  let revision = 0;
  const run = (...operations) => {
    const event = append(
      memory,
      "extended-" + operations[0].op + "-" + ++revision,
    );
    const { snapshot } = startDream(runtime, role, options);
    commitDream(
      runtime,
      snapshot,
      patch(
        ...operations.map((operation) =>
          "evidenceIds" in operation
            ? { ...operation, evidenceIds: [event.id] }
            : operation,
        ),
      ),
      access(snapshot),
    );
  };
  run({
    op: "LINK",
    fromId: target,
    toId: source,
    relation: "related_to",
    reason: "相同主题",
  });
  assert.equal(
    db.prepare("SELECT relation FROM cognition_links").get().relation,
    "related_to",
  );
  run({
    op: "MERGE",
    targetId: target,
    sourceIds: [source],
    expectedVersion: 1,
    evidenceIds: [],
    content: "从两处经历归纳出的偏好。",
    reason: "内容重叠",
  });
  assert.equal(read(source).status, "archived");
  assert.equal(read(source).merged_into, target);
  assert.equal(read(target).from_private, 1);
  assert.equal(
    db
      .prepare("SELECT summary FROM awakening_contexts WHERE scope_id=?")
      .get(group).summary,
    "从两处经历归纳出的偏好。",
  );
  run({
    op: "REINFORCE",
    targetId: target,
    expectedVersion: 2,
    evidenceIds: [],
    reason: "又一次明确提及",
  });
  assert.ok(read(target).confidence > 0.8);
  const reinforced = read(target).confidence;
  run({
    op: "REINFORCE",
    targetId: target,
    expectedVersion: 3,
    evidenceIds: [],
    confidence: 0,
    reason: "方向相反的建议",
  });
  assert.equal(read(target).confidence, reinforced);
  run({
    op: "WEAKEN",
    targetId: target,
    expectedVersion: 4,
    evidenceIds: [],
    reason: "出现新的反例",
  });
  assert.equal(read(target).status, "disputed");
  assert.ok(read(target).confidence < reinforced);
  assert.equal(
    db
      .prepare("SELECT summary FROM awakening_contexts WHERE scope_id=?")
      .get(group),
    undefined,
  );
  assert.equal(
    db
      .prepare(
        "SELECT relation FROM cognition_evidence WHERE cognition_id=? AND cognition_version=5 AND relation='contradicts'",
      )
      .get(target).relation,
    "contradicts",
  );
  const restored = rollbackCognition(runtime, role, target, {
    version: 2,
    expectedVersion: 5,
  });
  assert.equal(restored.version, 6);
  assert.equal(restored.status, "active");
  assert.equal(
    db
      .prepare(
        "SELECT op FROM cognition_revisions WHERE cognition_id=? AND version=6",
      )
      .get(target).op,
    "ROLLBACK",
  );
  run({
    op: "ARCHIVE",
    targetId: target,
    expectedVersion: 6,
    reason: "已过时",
  });
  assert.equal(read(target).status, "archived");
  assert.ok(read(target).valid_to);
  assert.throws(
    () => deleteCognition(runtime, role, target, 6),
    /DREAM_VERSION_CONFLICT/,
  );
  assert.equal(deleteCognition(runtime, role, target, 7).deleted, true);
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM cognition_links").get().n,
    0,
  );
  assert.equal(
    db
      .prepare(
        "SELECT count(*) AS n FROM cognition_revisions WHERE cognition_id=?",
      )
      .get(target).n,
    0,
  );
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM events WHERE id=?").get(first.id).n,
    1,
  );
});

test("a merge or reinforcement cannot carry forward evidence whose protection changed after planning", (t) => {
  const {
    runtime,
    store: { db },
  } = fixture(t);
  const memory = runtime.memory.bind(role);
  const old = append(memory, "will-revoke");
  const other = append(memory, "will-remain");
  const { snapshot } = startDream(runtime, role, options);
  commitDream(
    runtime,
    snapshot,
    patch(add([old.id]), { ...add([other.id]), subjectKey: "other:tea" }),
    access(snapshot),
  );
  const target = db
    .prepare("SELECT id FROM cognitions WHERE subject_key='user:30000:tea'")
    .get().id;
  const source = db
    .prepare("SELECT id FROM cognitions WHERE subject_key='other:tea'")
    .get().id;
  const next = append(memory, "new-safe");
  const { snapshot: followup } = startDream(runtime, role, options);
  const proposals = [
    {
      op: "MERGE",
      targetId: target,
      sourceIds: [source],
      expectedVersion: 1,
      content: "合并",
      evidenceIds: [next.id],
      reason: "合并",
    },
    {
      op: "REINFORCE",
      targetId: target,
      expectedVersion: 1,
      evidenceIds: [next.id],
      reason: "再次确认",
    },
  ];
  for (const op of proposals)
    assert.doesNotThrow(() =>
      planDreamPatch(runtime, followup, patch(op), access(followup)),
    );
  db.prepare("UPDATE events SET payload=? WHERE id=?").run(
    JSON.stringify({ protectedOperations: true }),
    old.id,
  );
  for (const op of proposals)
    assert.throws(
      () => commitDream(runtime, followup, patch(op), access(followup)),
      /RECALL_SOURCE_NOT_ALLOWED/,
    );
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM cognitions WHERE version=1").get().n,
    2,
  );
});

test("deleting the last consumed diary and correction does not reuse their cursors", (t) => {
  const { runtime, store } = fixture(t);
  const memory = store.bind(role);
  const event = append(memory, "source");
  const correction = (id) =>
    memory.corrections.put({
      id,
      sourceId: event.id,
      oldBelief: "先前",
      current: "现在",
      createdAt: new Date().toISOString(),
    });
  const old = memory.diaryWrite({ title: "第一篇", body: "已消费" });
  correction("old");
  const { snapshot } = startDream(runtime, role, options);
  commitDream(runtime, snapshot, noChanges, access(snapshot));
  store.db.prepare("DELETE FROM diaries WHERE id=?").run(old.id);
  store.db.prepare("DELETE FROM memory_corrections WHERE id=?").run("old");
  const next = memory.diaryWrite({ title: "第二篇", body: "新日记" });
  correction("next");
  const batch = startDream(runtime, role, options).snapshot;
  assert.deepEqual(
    new Set(batch.items.map((item) => item.id)),
    new Set([next.id, "next"]),
  );
});

test("schema 9 source tables preserve evidence and resume above a deleted high watermark", (t) => {
  const file = path.join(temp(t), "legacy.sqlite");
  const current = new MemoryStore(file),
    memory = current.bind(role);
  const entry = memory.diaryWrite({ title: "旧日记", body: "第一版" });
  for (const { name } of current.db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type='trigger' AND name LIKE 'dream_privacy_%'",
    )
    .all())
    current.db.exec("DROP TRIGGER " + name);
  current.db
    .exec(`DROP VIEW dream_privacy_purge; DROP VIEW dream_source_dependencies; DROP VIEW dream_event_parents;
    ALTER TABLE diary_revisions RENAME TO modern_diary;
    CREATE TABLE diary_revisions(id TEXT NOT NULL,revision INTEGER NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,metadata TEXT NOT NULL,written_at TEXT NOT NULL,PRIMARY KEY(id,revision),FOREIGN KEY(id) REFERENCES diaries(id));
    INSERT INTO diary_revisions SELECT id,revision,title,body,metadata,written_at FROM modern_diary; DROP TABLE modern_diary;
    DROP TABLE memory_corrections;
    CREATE TABLE memory_corrections(agent_id TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(agent_id,id));
    DROP TABLE cognition_evidence;
    CREATE TABLE cognition_evidence(agent_id TEXT NOT NULL,cognition_id TEXT NOT NULL,cognition_version INTEGER NOT NULL,source_id TEXT NOT NULL,source_type TEXT NOT NULL,scope_id TEXT NOT NULL,relation TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(agent_id,cognition_id,cognition_version,source_id));
    PRAGMA user_version=9;`);
  current.db
    .prepare("INSERT INTO cognition_evidence VALUES(?,?,?,?,?,?,?,?)")
    .run(
      role,
      "history",
      1,
      entry.id,
      "diary",
      group,
      "supports",
      "2026-01-01",
    );
  for (const partition of ["diaries", "corrections"])
    current.db
      .prepare("INSERT INTO dream_checkpoints VALUES(?,?,90,NULL,1,?)")
      .run(role, partition, "2026-01-01");
  current.close();
  const upgraded = new MemoryStore(file);
  t.after(() => upgraded.close());
  const restored = upgraded.bind(role);
  assert.equal(
    upgraded.db.prepare("SELECT source_revision FROM cognition_evidence").get()
      .source_revision,
    1,
  );
  const diary = restored.diaryWrite({ title: "新日记", body: "新的序号" });
  restored.corrections.put({ id: "new" });
  assert.ok(
    upgraded.db
      .prepare("SELECT seq FROM diary_revisions WHERE id=?")
      .get(diary.id).seq > 90,
  );
  assert.ok(
    upgraded.db
      .prepare("SELECT seq FROM memory_corrections WHERE id='new'")
      .get().seq > 90,
  );
});
