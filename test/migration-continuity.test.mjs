import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { temp, fixture } from "./helpers.mjs";
import { MemoryStore } from "../src/memory/store.mjs";
import {
  inspectLegacy,
  importLegacy,
  restoreExport,
} from "../src/memory/migrate.mjs";
const base = Date.parse("2026-10-25T04:00:00Z"),
  chat = "group:20000";
const map = {
  10001: { agentId: "fish", connectionId: "qq-fish" },
  10002: { agentId: "dragon", connectionId: "qq-dragon" },
};
const exported = (id, seconds = 0, extra = {}) => ({
  schema_version: 1,
  robot: "Fixture fish",
  robot_qq: "10001",
  conversation: chat,
  timestamp: new Date(base + seconds * 1000).toISOString(),
  unix_time: (base + seconds * 1000) / 1000,
  message_id: id,
  sender_qq: "30000",
  sender_name: "Member",
  is_self: false,
  text: "message " + id,
  segments: [],
  source: "qq_message_database",
  possible_text_truncation: false,
  ...extra,
});
function setup(t, rows = []) {
  const root = temp(t),
    source = path.join(root, "old"),
    archive = path.join(root, "export.jsonl");
  fs.mkdirSync(source);
  const write = (rows) =>
    fs.writeFileSync(archive, rows.map(JSON.stringify).join("\n"));
  write(rows);
  const store = new MemoryStore(":memory:");
  t.after(() => store.close());
  const opts = {
    agentId: "fish",
    accountId: "10001",
    subjectMap: { 10001: { agentId: "fish" }, 10002: { agentId: "dragon" } },
    connectionMap: map,
    exportFiles: [archive],
  };
  return {
    root,
    source,
    archive,
    write,
    store,
    m: store.bind("fish"),
    opts,
    plan: () => inspectLegacy(source, opts),
  };
}
const live = (m, id, extra = {}) =>
  m.append({
    dedupe: "live:" + id,
    connectionId: "qq-fish",
    conversation: chat,
    kind: "message.received",
    messageId: id,
    senderId: "30000",
    body: "live " + id,
    occurredAt: new Date(base).toISOString(),
    ...extra,
  });
const edges = (m, id) =>
  m.related({ id, maxChars: 16000 }).items.flatMap((x) => x.links || []);

test("N1 an empty current window still repairs known-account legacy connections", (t) => {
  const f = setup(t, [exported("11")]),
    event = f.plan().events[0];
  const old = f.m.append({
    ...event,
    connectionId: "",
    dedupe: event.legacyDedupe,
  });
  f.write([]);
  const result = importLegacy(f.m, f.plan());
  assert.equal(result.rebound, 1);
  assert.equal(result.inserted, 0);
  assert.equal(
    f.store.db
      .prepare("SELECT connection_id FROM events WHERE id=?")
      .get(old.id).connection_id,
    "qq-fish",
  );
  assert.equal(importLegacy(f.m, f.plan()).rebound, 0);
});

test("N3 multi-agent restoration remaps the read watermark, keeps old learner state and preserves unprocessed input", (t) => {
  const f = setup(t),
    other = f.store.bind("dragon");
  for (let i = 0; i < 100; i++) live(other, "filler-" + i);
  const records = [live(f.m, "1"), live(f.m, "2"), live(f.m, "3")];
  f.m.setState(chat, {
    readThroughSeq: records[1].seq,
    slang: { entries: [], throughSeq: records[1].seq },
  });
  const target = new MemoryStore(":memory:");
  try {
    live(target.bind("dragon"), "first");
    restoreExport(target.bind("fish"), f.m.export());
    const rows = target.db
      .prepare("SELECT id,seq FROM events WHERE agent_id='fish' ORDER BY seq")
      .all();
    const state = target.bind("fish").state(chat);
    assert.equal(state.readThroughSeq, rows[1].seq);
    assert.equal(
      target.db
        .prepare(
          "SELECT COUNT(*) n FROM events WHERE agent_id='fish' AND seq>?",
        )
        .get(state.readThroughSeq).n,
      1,
    );
    // Slang learning was removed in 0.5.3; its old state is carried over as is.
    assert.deepEqual(state.slang, {
      entries: [],
      throughSeq: records[1].seq,
    });
  } finally {
    target.close();
  }
});

test("N1 CLI requires an explicit account/connection map and checks an available destination config", (t) => {
  const f = setup(t, [exported("11")]),
    target = path.join(f.root, "new"),
    mapping = path.join(f.root, "map.json");
  fs.mkdirSync(target);
  fs.writeFileSync(mapping, JSON.stringify(map));
  const cli = fileURLToPath(new URL("../scripts/migrate.mjs", import.meta.url));
  const args = [
    cli,
    "--source",
    f.source,
    "--agent",
    "fish",
    "--account",
    "10001",
    "--data",
    target,
    "--apply",
  ];
  fs.mkdirSync(path.join(f.source, "history"));
  fs.writeFileSync(
    path.join(f.source, "history/one.jsonl"),
    JSON.stringify({
      conversation: chat,
      messageId: "11",
      senderId: "30000",
      direction: "in",
      body: "CLI evidence",
      time: base,
    }),
  );
  const without = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(without.status, 1);
  assert.match(without.stdout, /EXPLICIT_ACCOUNT_CONNECTION_REQUIRED/);
  assert.equal(fs.existsSync(path.join(target, "memory.sqlite")), false);
  fs.writeFileSync(
    path.join(target, "config.json"),
    JSON.stringify({
      agents: [{ id: "fish", connectionId: "wrong" }],
      connections: [{ id: "qq-fish", accountId: "10001" }],
    }),
  );
  const bad = spawnSync(
    process.execPath,
    [...args, "--connection-map", mapping],
    { encoding: "utf8" },
  );
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /TARGET_CONFIG_CONNECTION_MISMATCH/);
  fs.writeFileSync(
    path.join(target, "config.json"),
    JSON.stringify({
      agents: [{ id: "fish", connectionId: "qq-fish" }],
      connections: [{ id: "qq-fish", accountId: "10001" }],
    }),
  );
  const ok = spawnSync(
    process.execPath,
    [...args, "--connection-map", mapping],
    { encoding: "utf8" },
  );
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).targetConfigChecked, true);
  const db = new MemoryStore(path.join(target, "memory.sqlite"));
  try {
    assert.equal(
      db.db.prepare("SELECT connection_id FROM events").get().connection_id,
      "qq-fish",
    );
  } finally {
    db.close();
  }
});

test("N1 empty-connection upgrade preserves UUIDs, source observations and watermarks; links work in both directions and survive restore", (t) => {
  const f = setup(t, [
      exported("11", 0, { segments: [{ type: "reply", message_id: "12" }] }),
    ]),
    p = f.plan(),
    e = p.events[0];
  const old = f.m.append({ ...e, connectionId: "", dedupe: e.legacyDedupe });
  f.m.setState(chat, {
    readThroughSeq: old.seq,
    seenThroughSeq: old.seq,
    feedThroughSeq: old.seq,
    session: { id: "working" },
    custom: "keep",
  });
  const diary = f.m.diaryWrite({
    title: "subjective",
    body: "interpretation",
    evidence: [old.id],
  });
  f.m.reserveDelivery("uncertain", chat, { text: "synthetic" });
  f.m.completeDelivery("uncertain", "unknown");
  const reply = live(f.m, "12", {
    payload: { segments: [{ type: "reply", data: { id: "11" } }] },
  });
  const recall = live(f.m, "13", {
    kind: "notice.received",
    payload: { raw: { notice_type: "group_recall", message_id: "11" } },
  });
  assert.equal(edges(f.m, reply.id)[0].status, "unavailable");
  const r = importLegacy(f.m, p);
  assert.equal(r.rebound, 1);
  assert.equal(r.inserted, 0);
  assert.equal(
    f.store.db.prepare("SELECT id FROM events WHERE message_id='11'").get().id,
    old.id,
  );
  assert.deepEqual(
    JSON.parse(
      f.store.db.prepare("SELECT payload FROM events WHERE id=?").get(old.id)
        .payload,
    ).migration.sources,
    e.payload.migration.sources,
  );
  assert.equal(f.m.state(chat).readThroughSeq, old.seq);
  assert.equal(f.m.state(chat).seenThroughSeq, old.seq);
  assert.equal(f.m.state(chat).feedThroughSeq, old.seq);
  assert.equal(f.m.state(chat).session.id, "working");
  assert.equal(f.m.state(chat).custom, "keep");
  assert.equal(f.m.state(chat).paused, true);
  assert(edges(f.m, reply.id).some((x) => x.toId === old.id));
  assert(edges(f.m, old.id).some((x) => x.toId === reply.id));
  assert(edges(f.m, recall.id).some((x) => x.toId === old.id));
  assert.equal(importLegacy(f.m, p).rebound, 0);
  assert.equal(importLegacy(f.m, p).enriched, 0);
  const restored = new MemoryStore(":memory:");
  try {
    restoreExport(restored.bind("fish"), f.m.export());
    const m = restored.bind("fish");
    assert(edges(m, recall.id).some((x) => x.toId === old.id));
    assert.equal(m.delivery("uncertain").status, "unknown");
    assert(
      JSON.parse(m.read({ id: diary.id }).chunk).metadata.evidence.includes(
        old.id,
      ),
    );
    assert.deepEqual(m.export().tables, f.m.export().tables);
  } finally {
    restored.close();
  }
});

test("N1 relations retain agent, connection and conversation isolation for new and incremental imports", (t) => {
  const f = setup(t, [exported("11")]);
  importLegacy(f.m, f.plan());
  for (const [m, extra] of [
    [f.m, { connectionId: "other" }],
    [f.m, { conversation: "group:20001" }],
    [f.store.bind("dragon"), {}],
  ]) {
    const r = live(m, "12", {
      ...extra,
      payload: { segments: [{ type: "reply", data: { id: "11" } }] },
    });
    assert(edges(m, r.id).every((x) => x.status === "unavailable"));
  }
  const old = f.store.db
    .prepare("SELECT id FROM events WHERE message_id='11'")
    .get();
  f.write([
    exported("11", 0, { text: "richer original preserved" }),
    exported("14", 60, { segments: [{ type: "reply", message_id: "11" }] }),
  ]);
  assert.equal(importLegacy(f.m, f.plan()).inserted, 1);
  assert.equal(
    f.store.db.prepare("SELECT id FROM events WHERE message_id='11'").get().id,
    old.id,
  );
  assert.equal(f.m.related({ id: old.id }).items.length, 1);
});

test("N1 ambiguous or conflicting bindings refuse atomically instead of guessing an old connection", (t) => {
  const f = setup(t, [exported("11")]);
  assert.throws(
    () =>
      inspectLegacy(f.source, {
        ...f.opts,
        connectionMap: {
          10001: { agentId: "fish", connectionId: "same" },
          10002: { agentId: "dragon", connectionId: "same" },
        },
      }),
    /AMBIGUOUS_CONNECTION_MAP/,
  );
  assert.throws(
    () =>
      inspectLegacy(f.source, {
        ...f.opts,
        connectionMap: { 10001: { agentId: "dragon", connectionId: "other" } },
      }),
    /CONTRADICTORY_CONNECTION_MAP/,
  );
  const orphan = f.m.append({
    dedupe: "unbound",
    conversation: chat,
    kind: "legacy.message-observation",
    messageId: "99",
    body: "no account evidence",
    origin: "legacy-chat-window",
  });
  assert.throws(() => importLegacy(f.m, f.plan()), /SOURCE_EVIDENCE/);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM events").get().n, 1);
  assert.equal(
    f.store.db
      .prepare("SELECT connection_id FROM events WHERE id=?")
      .get(orphan.id).connection_id,
    "",
  );
  assert.equal(f.m.state("@migration-binding").accountId, undefined);
});

test("N2 mixed cache/history order, late history and time enrichment use message time without changing ledger seq", (t) => {
  const f = setup(t, [
    exported("1", -86400),
    exported("11", 0, { text: "question rendezvous" }),
    exported("12", 60, { text: "answer Friday" }),
  ]);
  fs.mkdirSync(path.join(f.source, "state"));
  fs.writeFileSync(
    path.join(f.source, "state/social-v2.json"),
    JSON.stringify({
      conversations: {
        [chat]: {
          recentMessages: [
            {
              messageId: "12",
              userId: "30000",
              isSelf: false,
              text: "answer",
              time: base + 60000,
            },
          ],
          unread: [],
        },
      },
    }),
  );
  importLegacy(f.m, f.plan());
  const rows = f.store.db
    .prepare("SELECT id,seq,message_id FROM events ORDER BY seq")
    .all();
  assert.deepEqual(
    rows.map((x) => x.message_id),
    ["12", "1", "11"],
  );
  const anchor = rows.find((x) => x.message_id === "11");
  const scene = () =>
    f.m.search({ query: "rendezvous", maxChars: 16000 }).items[0].scene;
  assert.deepEqual(
    scene().messages.map((x) => x.messageId),
    ["11", "12"],
  );
  f.write([
    exported("10", -60, { text: "late history before question" }),
    exported("13", 120, { text: "late history after answer" }),
  ]);
  importLegacy(f.m, f.plan());
  assert.deepEqual(
    scene().messages.map((x) => x.messageId),
    ["10", "11", "12", "13"],
  );
  for (const r of rows)
    assert.equal(
      f.store.db.prepare("SELECT seq FROM events WHERE id=?").get(r.id).seq,
      r.seq,
    );
  f.write([exported("12", -120, { text: "answer Friday" })]);
  importLegacy(f.m, f.plan());
  assert.deepEqual(
    scene().messages.map((x) => x.messageId),
    ["12", "10", "11", "13"],
  );
  const reply = f.store.db
    .prepare("SELECT * FROM events WHERE message_id='12'")
    .get();
  const p = JSON.parse(reply.payload);
  p.timeKnown = false;
  f.store.db
    .prepare("UPDATE events SET payload=? WHERE id=?")
    .run(JSON.stringify(p), reply.id);
  assert(!scene().messages.some((x) => x.messageId === "12"));
  p.timeKnown = true;
  f.store.db
    .prepare("UPDATE events SET occurred_at=?,payload=? WHERE id=?")
    .run(new Date(base - 120000).toISOString(), JSON.stringify(p), reply.id);
  assert.deepEqual(
    scene().messages.map((x) => x.messageId),
    ["12", "10", "11", "13"],
  );
  const page = f.m.conversation({ aroundId: anchor.id, limit: 10 }, chat);
  assert.equal(page.markReadEligible, false);
  assert.equal(page.readThroughSeq, null);
  const restored = new MemoryStore(":memory:");
  try {
    restoreExport(restored.bind("fish"), f.m.export());
    assert.deepEqual(
      restored
        .bind("fish")
        .search({ query: "rendezvous", maxChars: 16000 })
        .items[0].scene.messages.map((x) => x.id),
      scene().messages.map((x) => x.id),
    );
  } finally {
    restored.close();
  }
});

test("N2 observed/unknown timestamps do not claim temporal neighbors, while explicit reply edges remain available", (t) => {
  const f = setup(t, []);
  fs.mkdirSync(path.join(f.source, "state"));
  fs.writeFileSync(
    path.join(f.source, "state/social-v2.json"),
    JSON.stringify({
      conversations: {
        [chat]: {
          recentMessages: [
            {
              messageId: "11",
              userId: "30000",
              isSelf: false,
              text: "cache anchor",
              time: base,
              segments: [{ type: "reply", data: { id: "12" } }],
            },
          ],
          unread: [],
        },
      },
    }),
  );
  importLegacy(f.m, f.plan());
  const target = live(f.m, "12");
  const hit = f.m.search({ query: "cache anchor" }).items[0];
  assert.equal(hit.timeBasis, "observation");
  assert.equal(hit.scene.timeKnown, false);
  assert.equal(hit.scene.messages.length, 1);
  assert(hit.scene.quoted.some((x) => x.id === target.id));
  assert(edges(f.m, hit.id).some((x) => x.toId === target.id));
  const around = f.m.conversation({ aroundId: hit.id });
  assert.equal(around.items.length, 1);
  assert.equal(around.timeBasis, "observation");
  const unknown = live(f.m, "unknown", { occurredAt: "unknown" });
  assert.equal(f.m.conversation({ aroundId: unknown.id }).timeBasis, "unknown");
});

test("N2 bounded time cursors cover equal-time neighbors deterministically, preserve scope and use the index", (t) => {
  const f = setup(t);
  const ids = [];
  for (let i = 0; i < 55; i++) ids.push(live(f.m, "tie-" + i).id);
  const sorted = [...ids].sort(),
    anchorId = ids[27];
  for (const maxChars of [512, 2500, 16000]) {
    const first = f.m.conversation({ aroundId: anchorId, limit: 7, maxChars });
    assert(first.items.some((x) => x.id === anchorId));
    const seen = new Set(first.items.map((x) => x.id));
    for (const direction of ["Before", "After"]) {
      let c = first["nextAround" + direction],
        pages = 0;
      while (c) {
        const page = f.m.conversation({
          aroundId: anchorId,
          aroundCursor: c,
          limit: 7,
          maxChars,
        });
        assert(JSON.stringify(page.items).length <= maxChars);
        for (const item of page.items) {
          assert(!seen.has(item.id));
          seen.add(item.id);
        }
        c = page["nextAround" + direction];
        assert(++pages < 60);
      }
    }
    assert.deepEqual([...seen].sort(), sorted);
  }
  // Equal message times keep archive (arrival) order rather than UUID order.
  const window = f.m.conversation({ aroundId: anchorId, limit: 9 });
  assert.deepEqual(
    window.items.map((x) => x.id),
    ids.slice(23, 32),
  );
  const plan = f.store.db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT * FROM event_timeline WHERE agent_id=? AND connection_id=? AND conversation=? AND (time_ms,seq)>(?,?) ORDER BY time_ms,seq LIMIT 10",
    )
    .all("fish", "qq-fish", chat, base, 0);
  assert(plan.some((x) => x.detail.includes("event_timeline_order")));
  const first = f.m.conversation({ aroundId: anchorId, limit: 5 });
  f.store.db
    .prepare("UPDATE events SET occurred_at=? WHERE id=?")
    .run(new Date(base + 1000).toISOString(), anchorId);
  assert.throws(
    () =>
      f.m.conversation({
        aroundId: anchorId,
        aroundCursor: first.nextAroundAfter,
        limit: 5,
      }),
    /STALE_TIMELINE_CURSOR/,
  );
});

test("N2 conversation_read tool accepts temporal expansion and never offers a chronological seq as a read watermark", async (t) => {
  const f = fixture(t),
    m = f.store.bind("agent-0");
  const old = live(m, "1"),
    anchor = live(m, "2");
  const ctx = f.runtime.makeContext("agent-0", chat);
  const page = await f.runtime.callTool(ctx, "conversation_read", {
    aroundId: anchor.id,
    limit: 1,
  });
  assert.equal(page.markReadEligible, false);
  assert.equal(page.readThroughSeq, null);
  const c = page.nextAroundBefore || page.nextAroundAfter;
  assert(c);
  const more = await f.runtime.callTool(ctx, "conversation_read", {
    aroundId: anchor.id,
    aroundCursor: c,
    limit: 1,
  });
  assert.equal(more.items[0].id, old.id);
  assert.equal(m.state(chat).readThroughSeq, 0);
});
