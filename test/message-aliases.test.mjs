import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { temp, fixture, config, raw } from "./helpers.mjs";
import { MemoryStore } from "../src/memory/store.mjs";
import {
  inspectLegacy,
  importLegacy,
  restoreExport,
} from "../src/memory/migrate.mjs";
import { resolveMessage, importAliases } from "../src/memory/message-ids.mjs";
import { digest } from "../src/memory/legacy-adapters.mjs";
import { freezeEvidence } from "../src/memory/evidence.mjs";
import { backupDatabase } from "../src/memory/backup.mjs";
import { createServer } from "../src/server.mjs";
const chat = "group:20000",
  namespace = "napcat-native",
  account = "10000",
  agent = "agent-0",
  connection = "qq-0";
const map = { [account]: { agentId: agent, connectionId: connection } };
function setup(t, store) {
  const root = temp(t),
    source = path.join(root, "source"),
    archive = path.join(root, "archive.jsonl"),
    aliasFile = path.join(root, "aliases.json"),
    aliasSource = path.join(root, "source-proof.json");
  fs.mkdirSync(source);
  fs.writeFileSync(
    aliasSource,
    JSON.stringify({ provenance: "synthetic verified observation" }),
  );
  const write = (rows) =>
    fs.writeFileSync(
      archive,
      rows
        .map((id) =>
          JSON.stringify({
            schema_version: 1,
            robot: "Fixture",
            robot_qq: account,
            conversation: chat,
            timestamp: "2026-10-25T04:00:00Z",
            unix_time: 1792900800,
            message_id: id,
            sender_qq: "30000",
            sender_name: "Member",
            is_self: false,
            text: "source " + id,
            segments: [],
            source: "qq_message_database",
            possible_text_truncation: false,
          }),
        )
        .join("\n"),
    );
  write(["old-1", "old-2"]);
  store ||= new MemoryStore(":memory:");
  if (store.file === ":memory:")
    t.after(() => {
      try {
        store.close();
      } catch {}
    });
  const m = store.bind(agent),
    opts = {
      agentId: agent,
      accountId: account,
      subjectMap: { [account]: { agentId: agent } },
      connectionMap: map,
      exportFiles: [archive],
    },
    plan = () => inspectLegacy(source, opts);
  const base = plan();
  assert.equal(base.rejected.length, 0);
  fs.writeFileSync(
    aliasSource,
    JSON.stringify(
      base.events.map((e, i) => ({
        robot_qq: account,
        conversation: chat,
        native_message_id: "native-" + (i + 1),
        message_id: e.messageId,
        record_digest: e.payload.migration.sources[0].digest,
        match_basis: "text",
      })),
    ),
  );
  const aliases = base.events.map((e, i) => ({
    accountId: account,
    conversation: chat,
    archiveMessageId: e.messageId,
    namespace,
    messageId: "native-" + (i + 1),
    evidence: {
      sourceId: "synthetic-source",
      sourceDigest: digest(fs.readFileSync(aliasSource)),
      targetDigest: e.payload.migration.sources[0].digest,
      basis: "verified-observation",
    },
  }));
  const manifest = (a = aliases) => {
    fs.writeFileSync(aliasFile, JSON.stringify({ version: 1, aliases: a }));
    opts.aliasFile = aliasFile;
    opts.aliasSourceFiles = [aliasSource];
  };
  return {
    root,
    source,
    archive,
    aliasFile,
    aliasSource,
    store,
    m,
    opts,
    plan,
    aliases,
    manifest,
    write,
  };
}
const row = (m, id) =>
  m.db
    .prepare("SELECT * FROM events WHERE agent_id=? AND message_id=?")
    .get(m.agentId, id);
const refs = (m, id) =>
  m.related({ id, maxChars: 16000 }).items.flatMap((x) => x.links || []);
const append = (m, id, payload = {}, extra = {}) =>
  m.append({
    dedupe: "synthetic:" + id,
    connectionId: connection,
    conversation: chat,
    kind: "message.received",
    messageId: id,
    senderId: "30000",
    direction: "in",
    body: "synthetic " + id,
    occurredAt: "2026-10-25T04:00:01Z",
    payload: {
      messageNamespace: namespace,
      timeKnown: true,
      raw: { self_id: account },
      ...payload,
    },
    ...extra,
  });

test("v2 HTTP snapshots retain alias and observation identity across restore", async (t) => {
  const runtimeFixture = fixture(t),
    f = setup(t, runtimeFixture.store);
  f.manifest();
  importLegacy(f.m, f.plan());
  const original = row(f.m, "old-1");
  const observation = append(f.m, "native-1");
  assert.equal(observation.id, original.id);
  const server = createServer({
    runtime: runtimeFixture.runtime,
    token: "synthetic-export-admin",
  });
  const port = await server.listen();
  t.after(() => server.close());
  const response = await fetch(
    `http://127.0.0.1:${port}/api/export?agentId=agent-0`,
    { headers: { "x-admin-token": "synthetic-export-admin" } },
  );
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.manifest.counts.message_aliases, 2);
  assert.equal(data.manifest.counts.message_observations, 1);
  const restored = new MemoryStore(":memory:");
  try {
    restoreExport(restored.bind(agent), data);
    assert.deepEqual(restored.bind(agent).export().tables, f.m.export().tables);
    assert.equal(append(restored.bind(agent), "native-1").id, original.id);
  } finally {
    restored.close();
  }
});

test("N4 exact aliases supplement imported DB, preserve every old field, and resolve bidirectional replies, recalls, scenes and evidence", (t) => {
  const f = setup(t);
  importLegacy(f.m, f.plan());
  const old = f.store.db.prepare("SELECT * FROM events ORDER BY seq").all();
  f.m.setState(chat, {
    readThroughSeq: old[0].seq,
    slang: { throughSeq: old[0].seq },
    paused: true,
  });
  const state = f.m.state(chat);
  f.manifest();
  assert.equal(importLegacy(f.m, f.plan()).aliasesInserted, 2);
  assert.deepEqual(
    f.store.db.prepare("SELECT * FROM events ORDER BY seq").all(),
    old,
  );
  assert.deepEqual(f.m.state(chat), { ...state, migrationImported: true });
  assert.equal(importLegacy(f.m, f.plan()).aliasesInserted, 0);
  for (const [id, ns] of [
    ["native-1", namespace],
    ["old-1", "archive"],
  ]) {
    const reply = append(f.m, "reply-" + ns, {
      referenceNamespace: ns,
      segments: [{ type: "reply", data: { id } }],
    });
    const recall = append(
      f.m,
      "recall-" + ns,
      {
        referenceNamespace: ns,
        raw: { self_id: account, notice_type: "group_recall", message_id: id },
      },
      { kind: "message.recalled", messageId: null },
    );
    for (const e of [reply, recall]) {
      assert(refs(f.m, e.id).some((x) => x.toId === old[0].id));
      assert(refs(f.m, old[0].id).some((x) => x.fromId === e.id));
    }
    const hit = f.m.search({
      query: "synthetic reply-" + ns,
      contextBefore: 0,
      contextAfter: 0,
      maxChars: 16000,
    }).items[0];
    assert(hit.scene.quoted.some((x) => x.id === old[0].id));
    assert(
      JSON.stringify(freezeEvidence(f.m, [reply.id], Date.now())).includes(
        old[0].id,
      ),
    );
  }
  const duplicate = append(f.m, "native-1");
  assert.equal(duplicate.inserted, false);
  assert.equal(duplicate.id, old[0].id);
  append(f.m, "native-1");
  assert.equal(
    f.store.db.prepare("SELECT COUNT(*) n FROM message_observations").get().n,
    1,
  );
  assert.deepEqual(row(f.m, "old-1"), old[0]);
  assert.equal(f.m.state(chat).readThroughSeq, state.readThroughSeq);
});

test("N4 namespace collisions are separated and unqualified references fail closed; full source isolates subjects/connections/chats", (t) => {
  const f = setup(t);
  f.manifest();
  importLegacy(f.m, f.plan());
  const first = row(f.m, "old-1");
  const different = append(f.m, "old-1");
  assert.notEqual(different.id, first.id);
  const scope = {
    agentId: agent,
    connectionId: connection,
    conversation: chat,
  };
  assert.throws(() => resolveMessage(f.store.db, scope, "old-1"), /AMBIGUOUS/);
  assert.equal(
    resolveMessage(f.store.db, { ...scope, namespace: "archive" }, "old-1").id,
    first.id,
  );
  assert.equal(
    resolveMessage(f.store.db, { ...scope, namespace }, "old-1").id,
    different.id,
  );
  for (const changes of [
    { agentId: "agent-1" },
    { connectionId: "qq-other" },
    { conversation: "group:20001" },
  ])
    assert.equal(
      resolveMessage(
        f.store.db,
        { ...scope, ...changes, namespace },
        "native-1",
      ),
      undefined,
    );
  const p = append(
    f.m,
    "cross",
    { segments: [{ type: "reply", data: { id: "native-1" } }] },
    { conversation: "group:20001" },
  );
  assert.equal(refs(f.m, p.id)[0].toId, null);
  assert.throws(
    () => append(f.m, "native-1", { raw: { self_id: "10001" } }),
    /ACCOUNT/,
  );
  assert.throws(
    () => append(f.m, "native-1", {}, { senderId: "30001" }),
    /CONFLICTING/,
  );
});

test("N4 conflicts, missing source and incomplete target evidence reject atomically; incremental aliases are idempotent", (t) => {
  const f = setup(t);
  f.manifest([f.aliases[0]]);
  importLegacy(f.m, f.plan());
  f.manifest();
  assert.equal(importLegacy(f.m, f.plan()).aliasesInserted, 1);
  const before = f.m.export().tables;
  for (const a of [
    { ...f.aliases[1], messageId: "native-1" },
    { ...f.aliases[0], messageId: "new-number" },
    { ...f.aliases[0], archiveMessageId: "absent" },
    {
      ...f.aliases[0],
      evidence: { ...f.aliases[0].evidence, targetDigest: "0".repeat(64) },
    },
  ]) {
    f.manifest([a]);
    assert.throws(() => importLegacy(f.m, f.plan()));
    assert.deepEqual(f.m.export().tables, before);
  }
  f.manifest([{ ...f.aliases[0], evidence: {} }]);
  assert.throws(() => f.plan(), /EVIDENCE/);
  f.manifest();
  f.opts.aliasSourceFiles = [];
  assert.throws(() => f.plan(), /SOURCE_DIGEST/);
  assert.throws(
    () =>
      importAliases(f.m, [f.aliases[0]], {
        accountId: "10001",
        connectionId: connection,
      }),
    /ACCOUNT/,
  );
});

test("N4 alias import and observation-free restore reject conflicting target account evidence atomically", (t) => {
  const f = setup(t);
  f.manifest();
  const originalPlan = f.plan();
  const mutations = [
    (p) => (p.accountId = "10001"),
    (p) => (p.robotQQ = "10001"),
    (p) => (p.raw = { self_id: "10001" }),
    (p) => (p.robotQQ = false),
    (p) => (p.raw = { self_id: Number.MAX_SAFE_INTEGER + 1 }),
    (p) => (p.migration.sources[0].observation.robotQQ = "10001"),
    (p) =>
      p.migration.sources.push({
        digest: "c".repeat(64),
        observation: { accountId: "10001" },
      }),
  ];
  const before = f.m.export().tables;
  for (const mutate of mutations) {
    const plan = structuredClone(originalPlan);
    mutate(plan.events[1].payload);
    assert.throws(() => importLegacy(f.m, plan), /ALIAS_ACCOUNT_MISMATCH/);
    assert.deepEqual(f.m.export().tables, before);
  }
  importLegacy(f.m, originalPlan);
  const data = f.m.export();
  assert.equal(data.tables.message_observations.length, 0);
  const target = new MemoryStore(":memory:");
  t.after(() => target.close());
  const other = target.bind("unrelated");
  other.append({
    dedupe: "sentinel",
    conversation: chat,
    kind: "message.received",
    body: "synthetic",
  });
  const otherBefore = other.export().tables;
  for (const mutate of mutations) {
    const forged = structuredClone(data);
    const p = JSON.parse(forged.tables.events[1].payload);
    mutate(p);
    forged.tables.events[1].payload = JSON.stringify(p);
    assert.throws(
      () => restoreExport(target.bind(agent), forged),
      /ALIAS_ACCOUNT_MISMATCH/,
    );
    assert.deepEqual(target.bind(agent).export().tables, before);
    assert.deepEqual(other.export().tables, otherBefore);
  }
});

test("N4 matching target account fields permit alias import and observation-free JSON restore", (t) => {
  const f = setup(t);
  f.manifest();
  const plan = f.plan();
  for (const e of plan.events) {
    e.payload.accountId = account;
    e.payload.robotQQ = Number(account);
    e.payload.raw = { self_id: Number(account) };
    e.payload.migration.sources[0].observation.robotQQ = account;
  }
  assert.equal(importLegacy(f.m, plan).aliasesInserted, 2);
  const data = f.m.export(),
    target = new MemoryStore(":memory:");
  t.after(() => target.close());
  assert.equal(data.tables.message_observations.length, 0);
  restoreExport(target.bind(agent), data);
  assert.deepEqual(target.bind(agent).export().tables, data.tables);
});

test("N4 JSON reverse subject restore and consistent SQLite backup preserve aliases and observed UUIDs", async (t) => {
  const f = setup(t);
  f.manifest();
  importLegacy(f.m, f.plan());
  append(f.m, "native-1");
  f.store.bind("agent-1").append({
    dedupe: "other",
    conversation: chat,
    kind: "message.received",
    body: "other",
  });
  const restored = new MemoryStore(path.join(f.root, "restore.sqlite"));
  t.after(() => restored.close());
  restoreExport(restored.bind("agent-1"), f.store.bind("agent-1").export());
  restoreExport(restored.bind(agent), f.m.export());
  for (const table of ["message_aliases", "message_observations"])
    assert.deepEqual(
      restored.bind(agent).export().tables[table],
      f.m.export().tables[table],
    );
  assert.equal(
    resolveMessage(
      restored.db,
      {
        agentId: agent,
        connectionId: connection,
        conversation: chat,
        namespace,
      },
      "native-1",
    ).id,
    row(f.m, "old-1").id,
  );
  await backupDatabase(
    path.join(f.root, "restore.sqlite"),
    path.join(f.root, "backup.sqlite"),
  );
  const backup = new MemoryStore(path.join(f.root, "backup.sqlite"));
  t.after(() => backup.close());
  assert.deepEqual(
    backup.bind(agent).export().tables,
    restored.bind(agent).export().tables,
  );
  const forged = structuredClone(f.m.export());
  forged.tables.message_aliases[0].connection_id = "other";
  const empty = new MemoryStore(":memory:");
  t.after(() => empty.close());
  assert.throws(() => restoreExport(empty.bind(agent), forged), /SCOPE/);
  assert.equal(empty.db.prepare("SELECT COUNT(*) n FROM events").get().n, 0);
});

test("N4 real CLI validates manifest/config and runtime sends current gateway reply ID without replaying observation", async (t) => {
  const cfg = config(1);
  cfg.connections[0].messageIdNamespace = namespace;
  cfg.agents[0].paused = true;
  const runtimeFixture = fixture(t, { cfg }),
    f = setup(t, runtimeFixture.store);
  f.manifest();
  const mapping = path.join(f.root, "mapping.json"),
    subjects = path.join(f.root, "subjects.json"),
    target = path.join(f.root, "target"),
    targetConfig = path.join(f.root, "config.json");
  fs.writeFileSync(mapping, JSON.stringify(map));
  fs.writeFileSync(subjects, JSON.stringify(f.opts.subjectMap));
  fs.writeFileSync(targetConfig, JSON.stringify(cfg));
  const cli = fileURLToPath(new URL("../scripts/migrate.mjs", import.meta.url));
  const args = [
    cli,
    "--source",
    f.source,
    "--agent",
    agent,
    "--account",
    account,
    "--connection-map",
    mapping,
    "--subject-map",
    subjects,
    "--export",
    f.archive,
    "--message-aliases",
    f.aliasFile,
    "--alias-source",
    f.aliasSource,
    "--target-config",
    targetConfig,
    "--data",
    target,
    "--apply",
  ];
  const child = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr + child.stdout);
  assert.equal(JSON.parse(child.stdout).result.aliasesInserted, 2);
  cfg.connections[0].messageIdNamespace = "wrong";
  fs.writeFileSync(targetConfig, JSON.stringify(cfg));
  const mismatch = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stdout, /NAMESPACE_MISMATCH/);
  importLegacy(f.m, f.plan());
  const old = row(f.m, "old-1"),
    prior = f.m.state(chat);
  const result = await runtimeFixture.runtime.ingest(
    connection,
    raw("native-1"),
  );
  assert.equal(result[0].duplicate, true);
  assert.deepEqual(f.m.state(chat), prior);
  assert.equal(row(f.m, "old-1").id, old.id);
  await runtimeFixture.runtime.pause(agent, false);
  f.m.setState(chat, { ...f.m.state(chat), paused: false });
  const ctx = runtimeFixture.runtime.makeContext(agent, chat);
  await runtimeFixture.runtime.send(ctx, {
    requestId: "reply",
    text: "synthetic",
    replyTo: "old-1",
  });
  const transport = runtimeFixture.runtime.transports.get(connection);
  assert.equal(transport.sent[0].segments[0].data.id, "native-1");
  const sent = f.store.db
    .prepare("SELECT id FROM events WHERE kind='message.sent'")
    .get();
  assert(refs(f.m, sent.id).some((x) => x.toId === old.id));
  await runtimeFixture.runtime.send(ctx, {
    requestId: "reply",
    text: "synthetic",
    replyTo: "native-1",
  });
  assert.equal(transport.sent.length, 1);
});
