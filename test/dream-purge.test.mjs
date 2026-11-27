import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  checkpoint,
  commitDream,
  deleteCognition,
  rollbackCognition,
  startDream,
} from "../src/dream/store.mjs";
import { dreamSources } from "../src/dream/source-filter.mjs";
import {
  cognitionContext,
  commitCognitionContext,
} from "../src/dream/context-builder.mjs";
import { storyWatermarks } from "../src/dream/story.mjs";
import { restoreExport } from "../src/memory/migrate.mjs";
import { MemoryStore } from "../src/memory/store.mjs";
import { config, fixture } from "./helpers.mjs";

const role = "agent-0";
const scope = "group:20000";
const secret = "待删除的故事原文";
const safe = "未受影响的独立记忆";

const append = (memory, dedupe, body = safe, payload = {}) =>
  memory.append({
    dedupe,
    body,
    conversation: scope,
    kind: "message.received",
    senderId: "30000",
    payload,
  });

const add = (subjectKey, evidenceIds, content = safe) => ({
  op: "ADD",
  category: "preference",
  scopeId: scope,
  subjectKey,
  content,
  epistemicStatus: "reported",
  importance: 0.7,
  confidence: 0.8,
  evidenceIds,
  reason: content,
});

function commit(runtime, agentId, ...operations) {
  const { snapshot } = startDream(runtime, agentId, {
    backendId: "fixture",
    model: "fixture",
    batchSize: 120,
  });
  commitDream(
    runtime,
    snapshot,
    {
      schemaVersion: 1,
      operations,
      awakeningSummary: "",
      noChangesReason: null,
    },
    {
      privateRead: new Set(snapshot.items.map(({ id }) => id)),
      fingerprints: new Map(
        snapshot.items.map(({ id, fingerprint }) => [id, fingerprint]),
      ),
      maxOps: 20,
    },
  );
}

test("raw event erasure scrubs current and historical cognition text while retaining safe evidence", (t) => {
  const { runtime, store } = fixture(t);
  const m = store.bind(role);
  const other = store.bind("agent-1");
  const { db } = store;
  const first = append(m, "independent");
  const unrelated = append(m, "unrelated");
  const otherSource = append(other, "other");
  commit(
    runtime,
    role,
    add("target", [first.id]),
    add("unrelated", [unrelated.id], "独立认知"),
  );
  commit(runtime, other.agentId, add("target", [otherSource.id]));
  const before = db
    .prepare(
      "SELECT * FROM cognitions WHERE agent_id=? AND subject_key='target'",
    )
    .get(role);
  const privateEvent = append(m, "erased", secret);
  const diary = m.diaryWrite(
    {
      title: "日记",
      body: secret,
      evidence: [privateEvent.id],
    },
    "ai-diary",
    { conversation: scope },
  );
  commit(runtime, role, {
    op: "UPDATE",
    targetId: before.id,
    expectedVersion: 1,
    evidenceIds: [privateEvent.id, diary.id],
    content: secret,
    epistemicStatus: "reported",
    reason: secret,
  });
  const later = append(m, "later");
  commit(runtime, role, {
    op: "UPDATE",
    targetId: before.id,
    expectedVersion: 2,
    evidenceIds: [later.id],
    content: secret + "的再描述",
    epistemicStatus: "reported",
    reason: secret,
  });

  db.exec("BEGIN");
  db.prepare("DELETE FROM events WHERE agent_id=? AND id=?").run(
    role,
    privateEvent.id,
  );
  db.exec("ROLLBACK");
  assert.equal(
    db.prepare("SELECT version FROM cognitions WHERE id=?").get(before.id)
      .version,
    3,
  );
  db.prepare("DELETE FROM events WHERE agent_id=? AND id=?").run(
    role,
    privateEvent.id,
  );
  const current = db
    .prepare("SELECT * FROM cognitions WHERE id=?")
    .get(before.id);
  assert.equal(current.status, "disputed");
  assert.equal(current.version, 4);
  assert.equal(current.content, "");
  assert.equal(
    db
      .prepare("SELECT status FROM cognitions WHERE agent_id=?")
      .get(other.agentId).status,
    "active",
  );
  assert.equal(
    db.prepare("SELECT body FROM diaries WHERE id=?").get(diary.id).body,
    secret,
  );
  assert.equal(
    dreamSources(
      runtime,
      { agentId: role, conversation: "@dream" },
      storyWatermarks,
    ).read(diary.id),
    null,
  );
  const exported = m.export().tables;
  for (const table of [
    "cognitions",
    "cognition_revisions",
    "awakening_contexts",
  ])
    assert.doesNotMatch(JSON.stringify(exported[table]), new RegExp(secret));
  assert.equal(exported.awakening_contexts[0].summary, "独立认知");
  assert.ok(
    exported.cognition_evidence.some(
      (row) => row.cognition_version === 4 && row.source_id === later.id,
    ),
  );

  for (const version of [2, 3, 4])
    assert.throws(
      () =>
        rollbackCognition(runtime, role, before.id, {
          version,
          expectedVersion: 4,
        }),
      /DREAM_ROLLBACK_FAILED/,
    );
  const recovered = rollbackCognition(runtime, role, before.id, {
    version: 1,
    expectedVersion: 4,
  });
  assert.equal(recovered.subject_key, "target");
  assert.equal(recovered.content, safe);
  assert.equal(recovered.version, 5);
  const restored = new MemoryStore(":memory:");
  t.after(() => restored.close());
  restoreExport(restored.bind(role), m.export());
  assert.equal(
    restored.db
      .prepare("SELECT content FROM cognitions WHERE id=?")
      .get(before.id).content,
    safe,
  );
  assert.deepEqual(
    restored.bind(role).export().tables.cognition_revisions,
    m.export().tables.cognition_revisions,
  );
});

test("admin deletion reaches a previously merged destination and its audit history", (t) => {
  const { runtime, store } = fixture(t);
  const { db } = store;
  const m = store.bind(role);
  const first = append(m, "safe");
  const privateEvent = append(m, "sensitive", secret);
  commit(
    runtime,
    role,
    add("destination", [first.id]),
    add("source", [privateEvent.id], secret),
  );
  const { id: target } = db
    .prepare("SELECT id FROM cognitions WHERE subject_key='destination'")
    .get();
  const { id: source } = db
    .prepare("SELECT id FROM cognitions WHERE subject_key='source'")
    .get();
  commit(runtime, role, {
    op: "LINK",
    fromId: target,
    toId: source,
    relation: "related_to",
    reason: secret,
  });
  const mergeProof = append(m, "merge-proof");
  commit(runtime, role, {
    op: "MERGE",
    targetId: target,
    sourceIds: [source],
    expectedVersion: 1,
    evidenceIds: [mergeProof.id],
    content: secret,
    reason: secret,
  });
  const baseline = checkpoint(db, role);
  assert.equal(deleteCognition(runtime, role, source, 2).deleted, true);
  assert.deepEqual(checkpoint(db, role), {
    ...baseline,
    version: baseline.version + 1,
  });
  const exported = m.export().tables;
  assert.deepEqual(exported.cognition_links, []);
  assert.equal(exported.cognitions[0].status, "disputed");
  assert.equal(exported.cognitions[0].version, 3);
  for (const table of [
    "cognitions",
    "cognition_revisions",
    "awakening_contexts",
  ])
    assert.doesNotMatch(JSON.stringify(exported[table]), new RegExp(secret));
  assert.equal(
    db.prepare("SELECT body FROM events WHERE id=?").get(privateEvent.id).body,
    secret,
  );
  assert.throws(
    () =>
      rollbackCognition(runtime, role, target, {
        version: 2,
        expectedVersion: 3,
      }),
    /DREAM_ROLLBACK_FAILED/,
  );
});

test("reopening an existing schema 9 installs diary deletion and sanitizes old dangling evidence", (t) => {
  const { runtime, store } = fixture(t);
  const m = store.bind(role);
  const { db } = store;
  const older = append(m, "legacy-deleted", secret);
  const diary = m.diaryWrite(
    { title: "后续删除的日记", body: "第二处" },
    "ai-diary",
    { conversation: scope },
  );
  commit(
    runtime,
    role,
    add("legacy", [older.id], secret),
    add("diary", [diary.id], diary.body),
  );
  // Reproduce the old schema 9 layout and an old manual event erasure.
  for (const { name } of db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type='trigger' AND name LIKE 'dream_privacy_%'",
    )
    .all())
    db.exec(`DROP TRIGGER ${name}`);
  db.exec("DROP VIEW dream_privacy_purge; DROP VIEW dream_source_dependencies");
  db.prepare("DELETE FROM events WHERE id=?").run(older.id);
  const restored = new MemoryStore(":memory:");
  t.after(() => restored.close());
  restoreExport(restored.bind(role), m.export());
  assert.doesNotMatch(
    JSON.stringify(restored.bind(role).export().tables.cognition_revisions),
    new RegExp(secret),
  );

  const reopened = new MemoryStore(store.file);
  t.after(() => reopened.close());
  assert.equal(
    reopened.db.prepare("PRAGMA user_version").get().user_version,
    9,
  );
  assert.doesNotMatch(
    JSON.stringify(reopened.bind(role).export().tables.cognition_revisions),
    new RegExp(secret),
  );

  const external = new DatabaseSync(store.file);
  try {
    external.prepare("DELETE FROM diaries WHERE id=?").run(diary.id);
  } finally {
    external.close();
  }
  assert.equal(
    reopened.db
      .prepare("SELECT count(*) AS n FROM diary_revisions WHERE id=?")
      .get(diary.id).n,
    0,
  );
  assert.deepEqual(
    reopened.db
      .prepare("SELECT DISTINCT status FROM cognitions")
      .all()
      .map(({ status }) => status),
    ["disputed"],
  );
});

test("diary provenance erasure reaches older dependent revisions and preserves independent revisions", (t) => {
  const { runtime, store } = fixture(t);
  const memory = store.bind(role);
  const { db } = store;
  const earlier = append(memory, "earlier", secret);
  const diary = memory.diaryWrite(
    { title: "日记", body: secret, evidence: [earlier.id] },
    "ai-diary",
    { conversation: scope },
  );
  commit(runtime, role, add("early", [diary.id], secret));

  const derived = memory.diaryWrite(
    { title: "派生笔记", body: secret, evidence: [diary.id] },
    "ai-diary",
    { conversation: scope },
  );
  const newer = append(memory, "newer");
  memory.diaryRevise({
    id: diary.id,
    expectedRevision: 1,
    title: "日记",
    body: safe,
    evidence: [newer.id],
  });
  const revisedAt = db
    .prepare("SELECT updated_at FROM diaries WHERE id=?")
    .get(diary.id).updated_at;
  runtime.clock = () => new Date(Date.parse(revisedAt) + 1000);
  commit(
    runtime,
    role,
    add("later", [diary.id], safe),
    add("derived", [derived.id], secret),
  );

  // An older database could export live cognition after its parent was
  // manually removed. Use the ordinary export/restore path for that state.
  db.exec("SAVEPOINT legacy_erasure");
  db.exec("DROP TRIGGER dream_privacy_event_delete");
  db.prepare("DELETE FROM events WHERE id=?").run(earlier.id);
  const legacy = memory.export();
  db.exec("ROLLBACK TO legacy_erasure; RELEASE legacy_erasure");
  assert.match(
    JSON.stringify(legacy.tables.cognition_revisions),
    new RegExp(secret),
  );

  db.prepare("DELETE FROM events WHERE id=?").run(earlier.id);
  const rows = db
    .prepare("SELECT status,content FROM cognitions ORDER BY status")
    .all();
  assert.deepEqual(
    rows.map((row) => [row.status, row.content]),
    [
      ["active", safe],
      ["disputed", ""],
      ["disputed", ""],
    ],
  );
  assert.ok(
    dreamSources(
      runtime,
      { agentId: role, conversation: "@dream" },
      storyWatermarks,
    ).read(diary.id),
  );
  assert.equal(
    dreamSources(
      runtime,
      { agentId: role, conversation: "@dream" },
      storyWatermarks,
    ).read(derived.id),
    null,
  );
  const restored = new MemoryStore(":memory:");
  t.after(() => restored.close());
  restoreExport(restored.bind(role), memory.export());
  assert.deepEqual(
    restored.db
      .prepare("SELECT status,content FROM cognitions ORDER BY status")
      .all(),
    rows,
  );
  const restoredLegacy = new MemoryStore(":memory:");
  t.after(() => restoredLegacy.close());
  const legacyMemory = restoredLegacy.bind(role);
  restoreExport(legacyMemory, legacy);
  assert.deepEqual(
    restoredLegacy.db
      .prepare("SELECT status,content FROM cognitions ORDER BY status")
      .all(),
    rows,
  );
  const recoveredTables = legacyMemory.export().tables;
  for (const table of [
    "cognitions",
    "cognition_revisions",
    "awakening_contexts",
  ])
    assert.doesNotMatch(
      JSON.stringify(recoveredTables[table]),
      new RegExp(secret),
    );
});

test("retained sessions get one content-free invalidation even if all evidence or the cognition is erased", (t) => {
  const cfg = config();
  cfg.agents[0].dream.enabled = true;
  const { runtime, store } = fixture(t, { cfg });
  const m = store.bind(role);
  const sourceA = append(m, "source-a", secret);
  const sourceB = append(m, "source-b");
  commit(
    runtime,
    role,
    add("first", [sourceA.id], secret),
    add("second", [sourceB.id]),
  );
  const get = (key) =>
    store.db.prepare("SELECT id FROM cognitions WHERE subject_key=?").get(key)
      .id;
  const erased = get("first"),
    deleted = get("second");
  m.setState(scope, {
    lastTurnId: "current",
    cognitionsShown: { [erased]: 1, [deleted]: 1 },
  });
  store.db.prepare("DELETE FROM events WHERE id=?").run(sourceA.id);
  deleteCognition(runtime, role, deleted, 1);
  const ctx = {
    agentId: role,
    conversation: scope,
    turnId: "current",
    privateRead: new Set(),
  };
  const actual = cognitionContext(runtime, ctx, { fresh: false }).refresh();
  assert.ok(
    actual.line.includes(
      JSON.stringify({ id: deleted, version: 1, status: "deleted" }),
    ),
  );
  assert.match(actual.line, /"status":"disputed"/);
  assert.doesNotMatch(actual.line, new RegExp(secret));
  assert.equal(m.state(scope).cognitionsShown[deleted], 1);
  commitCognitionContext(m, ctx, actual);
  assert.deepEqual(m.state(scope).cognitionsShown, { [erased]: 2 });
  assert.equal(
    cognitionContext(runtime, ctx, { fresh: false }).refresh().line,
    "",
  );
});

test("physical deletion uses the existing core or scene budget on retained QQ sessions", async (t) => {
  for (const { name, scopeId, core, scene, clear } of [
    { name: "core only", scopeId: "global", core: 400, scene: 0 },
    { name: "scene only", scopeId: scope, core: 0, scene: 400 },
    {
      name: "both disabled after initial input",
      scopeId: "global",
      core: 400,
      scene: 0,
      clear: true,
    },
  ]) {
    await t.test(name, async (t) => {
      const cfg = config();
      cfg.agents[0].dream.enabled = true;
      cfg.agents[0].dream.budget = {
        contextCoreChars: core,
        contextSceneChars: scene,
      };
      cfg.agents[0].contextPolicy.capacityTokens = 1000000;
      const seen = [];
      const session = { backend: "fixture", id: "synthetic-retained" };
      const f = fixture(t, {
        cfg,
        run(p) {
          seen.push(p);
          p.saveSession(session);
        },
      });
      const { runtime, store } = f;
      const memory = store.bind(role);
      const source = append(memory, "deletion-budget-evidence");
      commit(runtime, role, { ...add("budget", [source.id], secret), scopeId });
      const { id } = store.db
        .prepare("SELECT id FROM cognitions WHERE subject_key='budget'")
        .get();

      const wake = (name) => {
        append(memory, name, "来聊天", {
          trustedInput: true,
          segments: [{ type: "at", data: { qq: "10000" } }],
        });
        return runtime.wake(role, scope);
      };
      await wake("first");
      assert.match(seen[0].prompt, new RegExp(secret));
      assert.equal(memory.state(scope).cognitionsShown[id], 1);
      if (clear) {
        const next = structuredClone(runtime.config);
        next.agents[0].dream.budget.contextCoreChars = 0;
        await runtime.changeConfig(next, f.configStore.revision);
      }
      deleteCognition(runtime, role, id, 1);
      const notice = JSON.stringify({ id, version: 1, status: "deleted" });
      await wake("after-delete");
      assert.equal(seen[1].session.id, session.id);
      assert.equal(seen[1].instructions, seen[0].instructions);
      assert.equal(seen[1].prompt.includes(notice), !clear);
      assert.equal(
        memory.state(scope).cognitionsShown[id],
        clear ? 1 : undefined,
      );
      await wake("after-receipt");
      assert.ok(!seen[2].prompt.includes(notice));
    });
  }
});
