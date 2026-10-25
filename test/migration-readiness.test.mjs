import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { temp } from "./helpers.mjs";
import { MemoryStore } from "../src/memory/store.mjs";
import {
  inspectLegacy,
  importLegacy,
  restoreExport,
} from "../src/memory/migrate.mjs";
import { applyMigration } from "../src/memory/migration-apply.mjs";
import { backupDatabase } from "../src/memory/backup.mjs";
const map = {
  10001: { agentId: "fish", robot: "Fixture fish" },
  10002: { agentId: "dragon", robot: "Fixture dragon" },
};
const row = (extra = {}) => ({
  schema_version: 1,
  robot: "Fixture fish",
  robot_qq: "10001",
  conversation: "group:20000",
  timestamp: "2026-10-19T12:00:00+08:00",
  unix_time: 1792382400,
  message_id: "11",
  sender_qq: "10001",
  sender_name: "Fixture fish",
  is_self: true,
  text: "source message",
  segments: [
    { type: "reply", message_id: "10" },
    { type: "at", qq: "30000" },
    { type: "image", summary: "placeholder", attachment_exported: false },
  ],
  source: "qq_message_database",
  possible_text_truncation: false,
  ...extra,
});
const write = (p, data) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data));
};
function setup(t, rows = []) {
  const root = temp(t),
    source = path.join(root, "old"),
    archive = path.join(root, "export.jsonl");
  fs.mkdirSync(source);
  fs.writeFileSync(archive, rows.map((r) => JSON.stringify(r)).join("\n"));
  const store = new MemoryStore(":memory:");
  t.after(() => store.close());
  const opts = {
    agentId: "fish",
    accountId: "10001",
    subjectMap: map,
    connectionMap: {
      10001: { agentId: "fish", connectionId: "qq-fish" },
      10002: { agentId: "dragon", connectionId: "qq-dragon" },
    },
    exportFiles: [archive],
  };
  return {
    root,
    source,
    archive,
    store,
    opts,
    plan: () => inspectLegacy(source, opts),
  };
}
test("explicit mixed export maps both identities, preserves fields and refuses foreign import", (t) => {
  const { source, store, opts, plan } = setup(t, [
    row(),
    row({
      robot: "Fixture dragon",
      robot_qq: "10002",
      sender_qq: "30000",
      sender_name: "Member",
      is_self: false,
    }),
  ]);
  const p = plan();
  assert.equal(p.coverage.otherSubjects, 1);
  assert.equal(p.rejected.length, 0);
  importLegacy(store.bind("fish"), p);
  importLegacy(
    store.bind("dragon"),
    inspectLegacy(source, { ...opts, agentId: "dragon", accountId: "10002" }),
  );
  const fish = JSON.parse(
    store.bind("fish").read({
      id: store.db.prepare("SELECT id FROM events WHERE agent_id='fish'").get()
        .id,
    }).chunk,
  );
  assert.equal(fish.senderId, "10001");
  assert.equal(fish.senderName, "Fixture fish");
  assert.equal(fish.direction, "out");
  assert.equal(fish.messageId, "11");
  assert.equal(fish.occurredAt, "2026-10-19T04:00:00.000Z");
  assert.equal(fish.status, "legacy-unverified");
  assert.deepEqual(fish.replyToMessageIds, ["10"]);
  assert.deepEqual(fish.mentions, ["30000"]);
  assert.equal(fish.payload.segments[2].type, "image");
  assert.equal(fish.payload.source, "qq_message_database");
  assert.equal(
    store.db.prepare("SELECT COUNT(*) n FROM deliveries").get().n,
    0,
  );
  assert.throws(
    () => importLegacy(store.bind("dragon"), p),
    /IDENTITY_MISMATCH/,
  );
  assert.equal(store.bind("fish").state("group:20000").paused, true);
});
test("malformed, ambiguous or unsupported exports are reported and application is all-or-nothing", (t) => {
  const rows = [
    row({ schema_version: 2 }),
    row({ robot_qq: "90000" }),
    row({ is_self: false }),
    row({ unix_time: 1792382401 }),
    row({ source: "model_reasoning" }),
    row({ observed_by: ["fish", "dragon"] }),
    row({ robot: "wrong" }),
  ];
  const { plan, store } = setup(t, rows);
  const p = plan();
  assert.equal(p.rejected.length, rows.length);
  assert.throws(() => importLegacy(store.bind("fish"), p), /REJECTED_RECORDS/);
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM events").get().n, 0);
});
test("cache/history/archive share message ID; richer source and all provenance survive incremental reruns", (t) => {
  const { source, archive, store, opts, plan } = setup(t, []);
  write(path.join(source, "state/social-v2.json"), {
    paused: true,
    conversations: {
      "group:20000": {
        recentMessages: [
          {
            messageId: "11",
            userId: "10001",
            isSelf: true,
            text: "source",
            time: 1792382400,
          },
        ],
        unread: [],
      },
    },
  });
  write(path.join(source, "history/one.jsonl"), {
    conversation: "group:20000",
    messageId: "11",
    senderId: "10001",
    direction: "out",
    text: "source message",
    time: 1792382400,
  });
  const m = store.bind("fish");
  assert.equal(importLegacy(m, plan()).inserted, 1);
  fs.writeFileSync(archive, JSON.stringify(row()));
  const result = importLegacy(m, plan());
  assert.equal(result.inserted, 0);
  assert(result.enriched > 0);
  const original = store.db.prepare("SELECT * FROM events").get(),
    p = JSON.parse(original.payload);
  assert.equal(original.body, "source message");
  assert.equal(p.migration.sources.length, 3);
  assert.equal(p.segments[0].type, "reply");
  assert.equal(
    store.db.prepare("SELECT COUNT(*) n FROM event_links").get().n,
    1,
  );
  const repeat = importLegacy(m, plan());
  assert.equal(repeat.inserted, 0);
  assert.equal(repeat.enriched, 0);
  assert.equal(store.db.prepare("SELECT * FROM events").get().id, original.id);
  // Another conversation/subject with the same QQ ID is not the same observation.
  fs.appendFileSync(
    archive,
    "\n" + JSON.stringify(row({ conversation: "private:30000" })),
  );
  assert.equal(importLegacy(m, plan()).inserted, 1);
  assert.equal(
    inspectLegacy(source, { ...opts, agentId: "dragon", accountId: "10002" })
      .rejected.length,
    2,
  ); // incompatible outgoing sender refuses an incorrect cache binding
});
test("ID-less messages on different dates and unknown-time rows retain conservative identities", (t) => {
  const { source, store, plan } = setup(t, []);
  write(path.join(source, "state/social-v2.json"), {
    conversations: {
      "private:30000": {
        recentMessages: [
          { isSelf: true, text: "晚安", time: 1792300000000 },
          { isSelf: true, text: "晚安", time: 1792386400000 },
          { text: "unknown" },
          { text: "unknown" },
        ],
        unread: [],
      },
    },
  });
  const p = plan();
  assert.equal(p.coverage.unknownTime, 2);
  assert.equal(p.coverage.unknownDirection, 2);
  assert.equal(importLegacy(store.bind("fish"), p).inserted, 4);
  assert.equal(importLegacy(store.bind("fish"), p).inserted, 0);
  const unknown = store.db
    .prepare("SELECT * FROM events WHERE body='unknown'")
    .all();
  assert.equal(unknown.length, 2);
  assert(
    unknown.every(
      (r) =>
        r.occurred_at === "unknown" &&
        r.direction === "unknown" &&
        r.sender_id === null &&
        r.message_id === null,
    ),
  );
});
test("same-ID contradictory identities roll back, while different bodies remain source alternatives", (t) => {
  const { archive, store, plan } = setup(t, [
    row(),
    row({ text: "a retained alternative" }),
  ]);
  const m = store.bind("fish");
  importLegacy(m, plan());
  assert.equal(
    JSON.parse(store.db.prepare("SELECT payload FROM events").get().payload)
      .migration.sources.length,
    2,
  );
  fs.writeFileSync(
    archive,
    [row({ message_id: "99" }), row({ sender_qq: "30000", is_self: false })]
      .map(JSON.stringify)
      .join("\n"),
  );
  assert.throws(() => importLegacy(m, plan()), /CONFLICTING_MESSAGE_IDENTITY/);
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM events").get().n, 1);
});
function legacyDb(file) {
  const db = new DatabaseSync(file);
  db.exec(
    `CREATE TABLE memories(id TEXT,agent_id TEXT,conversation TEXT,kind TEXT,text TEXT,subject_qq TEXT,source_type TEXT,source_ref TEXT,certainty TEXT,visibility TEXT,pinned INTEGER,superseded_by TEXT,created_at INTEGER,updated_at INTEGER);CREATE TABLE people(agent_id TEXT,qq TEXT,nickname TEXT,updated_at INTEGER);CREATE TABLE sightings(agent_id TEXT,qq TEXT,conversation TEXT,display_name TEXT,updated_at INTEGER);CREATE TABLE events(seq INTEGER,agent_id TEXT,action TEXT,memory_id TEXT,at INTEGER);PRAGMA user_version=1;`,
  );
  for (const a of ["old-fish", "old-dragon"]) {
    db.prepare("INSERT INTO memories VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      a + "-note",
      a,
      "group:20000",
      "handover",
      "subjective note",
      "30000",
      "handover",
      "observed-ref",
      "uncertain",
      "conversation",
      1,
      "replacement",
      1792382400000,
      1792382500000,
    );
    db.prepare("INSERT INTO people VALUES(?,?,?,?)").run(
      a,
      "30000",
      "Name",
      1792382400000,
    );
    db.prepare("INSERT INTO sightings VALUES(?,?,?,?,?)").run(
      a,
      "30000",
      "group:20000",
      "Group name",
      1792382400000,
    );
    db.prepare("INSERT INTO events VALUES(?,?,?,?,?)").run(
      1,
      a,
      "supersede",
      a + "-note",
      1792382500000,
    );
  }
  db.close();
}
test("empty aliases do not hide valid IDs, senders or original times", (t) => {
  const { source, plan, store } = setup(t, []);
  write(path.join(source, "history/one.jsonl"), {
    conversation: "",
    key: "group:20000",
    messageId: "",
    message_id: "11",
    senderId: "",
    userId: "30000",
    time: "",
    timestamp: "2026-10-19T12:00:00+08:00",
    text: "retained",
  });
  const p = plan();
  assert.equal(p.rejected.length, 0);
  assert.equal(p.events[0].messageId, "11");
  assert.equal(p.events[0].senderId, "30000");
  assert.equal(p.events[0].occurredAt, "2026-10-19T04:00:00.000Z");
  importLegacy(store.bind("fish"), p);
});
test("incremental imports reapply pause while preserving existing progress and same-source copied ID-less exports", (t) => {
  const { source, archive, opts, root, plan, store } = setup(t, [
      row({ message_id: "" }),
    ]),
    m = store.bind("fish");
  opts.exportSourceId = "fixture-export-series";
  const p = plan();
  importLegacy(m, p);
  m.setState("group:20000", {
    ...m.state("group:20000"),
    paused: false,
    readThroughSeq: 55,
    session: { id: "keep" },
  });
  const copied = path.join(root, "next-export.jsonl");
  fs.copyFileSync(archive, copied);
  const again = inspectLegacy(source, { ...opts, exportFiles: [copied] });
  assert.equal(importLegacy(m, again).inserted, 0);
  assert.equal(m.state("group:20000").paused, true);
  assert.equal(m.state("group:20000").readThroughSeq, 55);
  assert.deepEqual(m.state("group:20000").session, { id: "keep" });
});
test("contradictory aliases reject, but distinct cache text/quote/tail representations survive", (t) => {
  const { source, store, plan } = setup(t, []),
    state = path.join(source, "state/social-v2.json");
  const messages = [
    { messageId: "1", message_id: "2", text: "x" },
    { senderId: "30000", userId: "40000", text: "x" },
    { time: 1792382400, timestamp: 1792382401, text: "x" },
    { conversation: "private:30000", text: "x" },
  ];
  write(state, {
    conversations: { "group:20000": { recentMessages: messages, unread: [] } },
  });
  assert.equal(plan().rejected.length, 4);
  const quote = {
    messageId: "3",
    userId: "30000",
    time: 1792382400,
    text: "[引用 Alice：旧约定周五见] 当前回复",
    plain: "当前回复",
    tail: "被截断的后半段",
    quoteTargetIsSelf: true,
  };
  write(state, {
    conversations: { "group:20000": { recentMessages: [quote], unread: [] } },
  });
  const p = plan();
  assert.equal(p.rejected.length, 0);
  importLegacy(store.bind("fish"), p);
  const r = store.db.prepare("SELECT body,payload FROM events").get(),
    payload = JSON.parse(r.payload);
  assert.equal(r.body, quote.plain);
  assert.equal(payload.originalText, quote.text);
  assert.equal(payload.tail, quote.tail);
  assert.equal(payload.quoteTargetIsSelf, true);
});
test("prior importer message keys are adopted without duplicate IDs or losing original provenance", (t) => {
  const { store, plan } = setup(t, [row()]),
    m = store.bind("fish");
  const old = m.append({
    dedupe: "legacy-message:previous-version-key",
    conversation: "group:20000",
    kind: "legacy.message-observation",
    messageId: "11",
    senderId: "10001",
    direction: "out",
    body: "old truncated",
    occurredAt: "2026-10-19T04:00:00.000Z",
    origin: "legacy-chat-window",
    payload: { timeKnown: true, source: "social-v2", legacySeq: 7 },
    status: "legacy-unverified",
  });
  assert.equal(importLegacy(m, plan()).inserted, 0);
  assert.equal(importLegacy(m, plan()).enriched, 0);
  const rows = store.db.prepare("SELECT * FROM events").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, old.id);
  assert.equal(rows[0].body, "source message");
  const sources = JSON.parse(rows[0].payload).migration.sources;
  assert.equal(sources.length, 2);
  assert.equal(
    sources.find((s) => s.format === "previous-import").observation
      .previousPayload.legacySeq,
    7,
  );
  m.append({
    dedupe: "legacy-history:duplicate",
    conversation: "group:20000",
    kind: "legacy.message-observation",
    messageId: "11",
    body: "duplicate",
  });
  assert.throws(() => importLegacy(m, plan()), /EXISTING_DUPLICATE_MESSAGE_ID/);
});
test("existing runtime progress and session survive first migration, with imports paused", (t) => {
  const { source, store, plan } = setup(t, [
      row({ conversation: "private:30000" }),
    ]),
    m = store.bind("fish");
  write(path.join(source, "state/social-v2.json"), {
    conversations: {
      "group:20000": { recentMessages: [], unread: [], lastReadThroughSeq: 9 },
    },
  });
  for (const c of ["group:20000", "private:30000"])
    m.setState(c, {
      readThroughSeq: 88,
      seenThroughSeq: 99,
      session: { id: "preserved" },
      custom: "preserved",
      paused: false,
    });
  importLegacy(m, plan());
  for (const c of ["group:20000", "private:30000"]) {
    const s = m.state(c);
    assert.equal(s.readThroughSeq, 88);
    assert.equal(s.seenThroughSeq, 99);
    assert.deepEqual(s.session, { id: "preserved" });
    assert.equal(s.custom, "preserved");
    assert.equal(s.paused, true);
  }
  assert.equal(m.state("group:20000").legacy.lastReadThroughSeq, 9);
});
test("target SQLite aliases and sidecar links never upgrade or modify an old source", async (t) => {
  const { root, plan } = setup(t, []),
    source = path.join(root, "source.sqlite"),
    old = schema3(source);
  old.close();
  const before = fs.readFileSync(source);
  const symbolic = path.join(root, "symlink.sqlite");
  fs.symlinkSync(source, symbolic);
  await assert.rejects(applyMigration(symbolic, plan()), /TARGET_LINK_REFUSED/);
  const hard = path.join(root, "hardlink.sqlite");
  fs.linkSync(source, hard);
  await assert.rejects(applyMigration(hard, plan()), /TARGET_LINK_REFUSED/);
  const sidecar = path.join(root, "target.sqlite");
  fs.symlinkSync(source, sidecar + "-wal");
  await assert.rejects(applyMigration(sidecar, plan()), /TARGET_LINK_REFUSED/);
  assert.deepEqual(fs.readFileSync(source), before);
  assert.equal(fs.existsSync(sidecar), false);
});
test("SQLite notes, people, sightings and revision audit preserve owner and evidence through export/restore", (t) => {
  const { source, root, store, opts } = setup(t, []),
    dbfile = path.join(root, "legacy.sqlite");
  legacyDb(dbfile);
  const bytes = fs.readFileSync(dbfile);
  const p = inspectLegacy(source, {
    ...opts,
    legacyDb: dbfile,
    legacyAgentId: "old-fish",
  });
  assert.equal(p.coverage.sqlite.memories.total, 2);
  assert.equal(p.notes.length, 1);
  importLegacy(store.bind("fish"), p);
  assert.equal(importLegacy(store.bind("fish"), p).inserted, 0);
  assert.deepEqual(fs.readFileSync(dbfile), bytes);
  const note = store.db
      .prepare("SELECT payload FROM events WHERE kind='legacy.note'")
      .get(),
    metadata = JSON.parse(note.payload);
  assert.equal(metadata.source_ref, "observed-ref");
  assert.equal(metadata.certainty, "uncertain");
  assert.equal(metadata.superseded_by, "replacement");
  assert.equal(metadata.subject_qq, "30000");
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM people").get().n, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM diaries").get().n, 0);
  const restored = new MemoryStore(":memory:");
  try {
    restoreExport(restored.bind("fish"), store.bind("fish").export());
    assert.deepEqual(
      restored.bind("fish").export().tables,
      store.bind("fish").export().tables,
    );
  } finally {
    restored.close();
  }
});
function schema3(file) {
  const store = new MemoryStore(file);
  store.bind("existing").append({
    dedupe: "before",
    conversation: "private:30000",
    kind: "message.received",
    body: "committed WAL data",
  });
  store.db.exec(
    "DROP TABLE self_versions;DROP TABLE self_candidates;DROP TABLE intentions;DROP TABLE work_notes;DROP TABLE model_turns;DROP TABLE session_history;DROP TABLE message_progress;PRAGMA user_version=3;",
  );
  return store;
}
test("backup precedes schema3 upgrade, includes WAL, restores to a separate old-schema path", async (t) => {
  const { root, plan } = setup(t, [row()]),
    file = path.join(root, "target.sqlite"),
    old = schema3(file),
    backup = path.join(root, "before.sqlite");
  t.after(() => old.close());
  const result = await applyMigration(file, plan(), {
    backupDestination: backup,
  });
  assert.equal(result.before.schemaVersion, 3);
  assert.equal(result.before.integrity, "ok");
  assert.equal(result.inserted, 1);
  const restore = path.join(root, "rollback.sqlite");
  await backupDatabase(backup, restore);
  for (const p of [backup, restore]) {
    const d = new DatabaseSync(p, { readOnly: true });
    assert.equal(d.prepare("PRAGMA user_version").get().user_version, 3);
    assert.equal(
      d.prepare("PRAGMA integrity_check").get().integrity_check,
      "ok",
    );
    assert.equal(d.prepare("SELECT COUNT(*) n FROM events").get().n, 1);
    assert.equal(
      d
        .prepare("SELECT name FROM sqlite_master WHERE name='self_versions'")
        .get(),
      undefined,
    );
    d.close();
  }
  const upgraded = new DatabaseSync(file, { readOnly: true });
  assert.equal(upgraded.prepare("PRAGMA user_version").get().user_version, 5);
  upgraded.close();
});
test("backup failure leaves schema3 and source data unchanged; failed import is transactional and recoverable", async (t) => {
  const { root, plan } = setup(t, [row()]),
    file = path.join(root, "target.sqlite"),
    old = schema3(file);
  old.close();
  const before = fs.readFileSync(file),
    occupied = path.join(root, "occupied.sqlite");
  fs.writeFileSync(occupied, "do not overwrite");
  await assert.rejects(
    applyMigration(file, plan(), { backupDestination: occupied }),
    /EEXIST/,
  );
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.readFileSync(occupied, "utf8"), "do not overwrite");
  const p = plan();
  p.events.push({
    ...p.events[0],
    dedupe: "invalid",
    messageId: "99",
    body: "x".repeat(2 * 1024 * 1024 + 1),
  });
  let saved;
  try {
    await applyMigration(file, p);
  } catch (e) {
    saved = e.backup;
    assert.match(e.message, /INVALID_TEXT/);
  }
  assert.equal(saved.schemaVersion, 3);
  const d = new DatabaseSync(file, { readOnly: true });
  assert.equal(d.prepare("SELECT COUNT(*) n FROM events").get().n, 1);
  d.close();
  await backupDatabase(saved.destination, path.join(root, "recover.sqlite"));
});
