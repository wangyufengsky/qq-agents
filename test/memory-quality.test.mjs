import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MemoryStore } from "../src/memory/store.mjs";
import { backupDatabase } from "../src/memory/backup.mjs";
import { restoreExport } from "../src/memory/migrate.mjs";
import { temp, fixture } from "./helpers.mjs";
function setup(t) {
  const root = temp(t),
    file = path.join(root, "memory.sqlite"),
    s = new MemoryStore(file);
  t.after(() => s.close());
  return { root, file, s, a: s.bind("agent-a") };
}
function event(i, body = "计划讨论", extra = {}) {
  return {
    dedupe: "case" + i,
    connectionId: "one",
    conversation: "group:20000",
    kind: "message.received",
    messageId: String(i),
    senderId: "30000",
    occurredAt: new Date(1800000000000 + i * 1000).toISOString(),
    body,
    payload: { raw: { sender: { nickname: "小明" } }, segments: [] },
    ...extra,
  };
}
test("FTS literal intersection matches LIKE, short words and punctuation keep exact semantics", (t) => {
  const { a } = setup(t);
  for (const [i, b] of [
    "中文检索和计划",
    "小明约定",
    "100%_测试 ABC 中文检索",
    "不同主体",
    'A"B中文',
    "🦊蓝鲸计划",
  ].entries())
    a.append(event(i, b));
  for (const query of [
    "中文检索",
    "中文 检索",
    "小明",
    "明",
    "%_",
    "ABC 中文",
    'A"B',
    "🦊蓝鲸",
  ]) {
    const patterns = query
      .split(/\s+/)
      .map((s) => "%" + s.replace(/[\\%_]/g, (c) => "\\" + c) + "%");
    const expected = a.db
      .prepare(
        `SELECT id FROM events WHERE agent_id=? AND ${patterns.map(() => "body LIKE ? ESCAPE '\\'").join(" AND ")} ORDER BY seq DESC`,
      )
      .all(a.agentId, ...patterns)
      .map((r) => r.id);
    const actual = a
      .search({
        query,
        type: "event",
        maxChars: 16000,
        contextBefore: 0,
        contextAfter: 0,
      })
      .items.map((r) => r.id);
    assert.deepEqual(actual, expected, query);
  }
});
test("keyset cursor excludes newly appended events and does not repeat earlier pages", (t) => {
  const { a } = setup(t);
  const ids = [];
  for (let i = 0; i < 12; i++) ids.push(a.append(event(i)).id);
  let r = a.search({ type: "event", limit: 2, maxChars: 16000 }),
    seen = r.items.map((x) => x.id);
  a.append(event(30));
  while (r.nextCursor) {
    r = a.search({
      type: "event",
      limit: 2,
      maxChars: 16000,
      cursor: r.nextCursor,
    });
    seen.push(...r.items.map((x) => x.id));
  }
  assert.deepEqual(seen, ids.reverse());
});
test("relations cross long gaps, distinguish same names, retain recall and missing quote without inventing correction", (t) => {
  const { a, s } = setup(t),
    first = a.append(event(1, "计划周五"));
  const later = a.append(
    event(86400, "更正：改周六", {
      senderId: "30001",
      payload: {
        raw: { sender: { nickname: "小明" } },
        segments: [
          { type: "reply", data: { id: "1" } },
          { type: "reply", data: { id: "missing" } },
        ],
      },
    }),
  );
  a.append(
    event(86401, "通知", {
      kind: "notice.group_recall",
      payload: { raw: { notice_type: "group_recall", message_id: "86400" } },
    }),
  );
  a.append(
    event(86402, "另一连接", {
      connectionId: "two",
      payload: { segments: [{ type: "reply", data: { id: "1" } }] },
    }),
  );
  s.bind("agent-b").append(
    event(86403, "另一主体", {
      payload: { segments: [{ type: "reply", data: { id: "1" } }] },
    }),
  );
  const r = a.related({ id: first.id });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].record.senderId, "30001");
  assert.equal(r.items[0].links[0].relation, "explicit-reply");
  assert.ok(r.items[0].links.some((l) => l.status === "unavailable"));
  const l = a.related({ id: later.id });
  assert.ok(
    l.items.some((x) => x.links.some((e) => e.relation === "recall-notice")),
  );
  assert.equal(
    a.search({ query: "计划周五" }).items[0].scene.messages.length,
    1,
  );
  assert.throws(
    () => s.bind("agent-b").related({ id: first.id }),
    /RECORD_NOT_FOUND/,
  );
});
test("overlapping scenes use references only to records actually returned within budget", (t) => {
  const { a } = setup(t);
  for (let i = 0; i < 7; i++) a.append(event(i));
  for (const maxChars of [512, 1500, 6000, 16000]) {
    const r = a.search({ query: "计划", maxChars }),
      seen = new Set();
    for (const item of r.items) {
      for (const ref of item.scene?.sharedRecords || [])
        assert.ok(seen.has(ref.id));
      for (const m of [
        ...(item.scene?.messages || []),
        ...(item.scene?.quoted || []),
      ])
        seen.add(m.id);
    }
    assert.ok(JSON.stringify(r.items).length <= maxChars);
  }
});
test("consistent WAL backup, restart, JSON restore preserve diary revisions evidence and derived search", async (t) => {
  const { a, s, root, file } = setup(t),
    e = a.append(event(1, "蓝鲸测试"));
  const d = a.diaryWrite({ title: "看法", body: "期待", evidence: [e.id] });
  a.diaryRevise({
    id: d.id,
    expectedRevision: 1,
    title: "看法",
    body: "当前推断",
  });
  const backup = path.join(root, "backup.sqlite");
  assert.equal((await backupDatabase(file, backup)).integrity, "ok");
  assert.throws(() =>
    new DatabaseSync(file, { readOnly: true }).exec(
      "INSERT INTO events(seq) VALUES(99)",
    ),
  );
  const reopened = new MemoryStore(backup);
  t.after(() => reopened.close());
  const b = reopened.bind("agent-a");
  assert.equal(b.search({ query: "蓝鲸测试" }).items[0].id, e.id);
  assert.equal(
    JSON.parse(b.read({ id: d.id, revision: 1 }).chunk).body,
    "期待",
  );
  await assert.rejects(backupDatabase(file, backup));
  const restored = new MemoryStore(path.join(root, "restore.sqlite"));
  t.after(() => restored.close());
  restoreExport(restored.bind("agent-a"), a.export());
  assert.equal(
    restored.bind("agent-a").search({ query: "蓝鲸测试" }).items.length,
    1,
  );
  assert.equal(restored.bind("agent-b").search().items.length, 0);
  assert.equal(
    s.db.prepare("PRAGMA integrity_check").get().integrity_check,
    "ok",
  );
});
test("schema v1 upgrade backfills indexes atomically and is idempotent", (t) => {
  const root = temp(t),
    file = path.join(root, "old.sqlite"),
    s = new MemoryStore(file);
  const a = s.bind("agent-a"),
    e = a.append(event(1, "旧档蓝鲸"));
  a.append(
    event(2, "答复", {
      payload: { segments: [{ type: "reply", data: { id: "1" } }] },
    }),
  );
  a.append(
    event(3, "机器人答复", {
      kind: "message.sent",
      payload: { requestId: "old-reply", replyTo: "1" },
    }),
  );
  s.db.exec(
    "DROP TRIGGER events_fts_insert; DROP TRIGGER events_fts_update; DROP TRIGGER events_fts_delete; DROP TABLE events_fts; DROP TRIGGER event_links_insert; DROP TRIGGER event_links_sent_insert; DROP TABLE event_links; PRAGMA user_version=1",
  );
  s.close();
  for (let i = 0; i < 2; i++) {
    const n = new MemoryStore(file);
    assert.equal(
      n.bind("agent-a").search({ query: "旧档蓝鲸" }).items[0].id,
      e.id,
    );
    assert.equal(n.bind("agent-a").related({ id: e.id }).items.length, 2);
    assert.equal(n.db.prepare("SELECT COUNT(*) n FROM events").get().n, 3);
    assert.equal(n.db.prepare("PRAGMA user_version").get().user_version, 3);
    n.close();
  }
});

test("confirmed runtime replies are indexed without an echo and failed attempts do not create links", async (t) => {
  const { runtime, store } = fixture(t),
    memory = store.bind("agent-0"),
    anchor = memory.append(event(1, "原提议", { connectionId: "qq-0" })),
    ctx = runtime.makeContext("agent-0", "group:20000");
  await runtime.send(ctx, {
    requestId: "reply-ok",
    text: "明确答复",
    replyTo: "1",
  });
  runtime.transports.get("qq-0").failure = "ONEBOT_REJECTED";
  await assert.rejects(
    runtime.send(ctx, {
      requestId: "reply-failed",
      text: "失败答复",
      replyTo: "1",
    }),
  );
  const related = memory.related({ id: anchor.id });
  assert.equal(related.items.length, 1);
  assert.equal(related.items[0].record.type, "message.sent");
  assert.deepEqual(
    related.items[0].links.map((x) => x.toId),
    [anchor.id],
  );
  const result = memory.search({ query: "明确答复", kind: "message.sent" })
    .items[0];
  assert.ok(
    result.scene.messages
      .find((m) => m.id === result.id)
      .replyTo.some((r) => r.eventId === anchor.id),
  );
});

test("schema v2 upgrade backfills outgoing reply metadata once and preserves the FTS index", (t) => {
  const file = path.join(temp(t), "schema2.sqlite"),
    initial = new MemoryStore(file),
    memory = initial.bind("agent-a"),
    anchor = memory.append(event(1, "迁移原文"));
  const reply = memory.append(
    event(2, "历史答复", {
      kind: "message.sent",
      payload: { requestId: "historical", replyTo: "1" },
    }),
  );
  memory.append(
    event(3, "未确认", {
      kind: "message.send-attempt",
      payload: { replyTo: "1" },
    }),
  );
  initial.db.exec(
    "DROP TRIGGER event_links_sent_insert; DELETE FROM event_links; PRAGMA user_version=2",
  );
  initial.close();
  for (let i = 0; i < 2; i++) {
    const reopened = new MemoryStore(file);
    try {
      assert.equal(
        reopened.db.prepare("PRAGMA user_version").get().user_version,
        3,
      );
      const a = reopened.bind("agent-a");
      assert.deepEqual(
        a.related({ id: anchor.id }).items.map((x) => x.record.id),
        [reply.id],
      );
      assert.equal(a.search({ query: "迁移原文" }).items[0].id, anchor.id);
      assert.equal(
        reopened.db.prepare("SELECT COUNT(*) n FROM event_links").get().n,
        1,
      );
      assert.equal(
        reopened.db.prepare("PRAGMA integrity_check").get().integrity_check,
        "ok",
      );
    } finally {
      reopened.close();
    }
  }
});

test("relationship paging preserves all sources with bounded bodies and no cross-source references", (t) => {
  const { a } = setup(t),
    anchor = a.append(event(1, "计划"));
  const ids = [];
  for (let i = 2; i < 15; i++)
    ids.push(
      a.append(
        event(i, "回复".repeat(200), {
          payload: { segments: [{ type: "reply", data: { id: "1" } }] },
        }),
      ).id,
    );
  const got = [];
  let afterSeq = 0;
  do {
    const r = a.related({ id: anchor.id, afterSeq, maxChars: 512, limit: 2 });
    assert.ok(JSON.stringify(r.items).length <= 512);
    got.push(...r.items.map((x) => x.record.id));
    afterSeq = r.nextAfterSeq;
  } while (afterSeq !== null);
  assert.deepEqual(got, ids);
});
