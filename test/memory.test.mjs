import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { MemoryStore } from "../src/memory/store.mjs";
import {
  inspectLegacy,
  importLegacy,
  restoreExport,
} from "../src/memory/migrate.mjs";
import { temp } from "./helpers.mjs";
function setup(t) {
  const root = temp(t),
    file = path.join(root, "memory.sqlite"),
    store = new MemoryStore(file);
  t.after(() => store.close());
  return {
    root,
    file,
    store,
    a: store.bind("agent-a"),
    b: store.bind("agent-b"),
  };
}
const event = (i, extra = {}) => ({
  dedupe: "fixture-" + i,
  conversation: "group:20000",
  kind: "message.received",
  senderId: "30000",
  body: "中文约定 " + i,
  payload: {
    segments: [
      { type: "image", data: { url: "https://example.org/image.png" } },
    ],
  },
  ...extra,
});
test("continuous archive stores 500 messages and paginates within size budget without loss", (t) => {
  const { a } = setup(t);
  for (let i = 0; i < 500; i++) a.append(event(i));
  assert.equal(a.append(event(1)).inserted, false);
  assert.equal(a.export().tables.events.length, 500);
  let offset = 0;
  const ids = new Set();
  do {
    const r = a.search({ query: "中文约定", limit: 50, offset });
    assert.ok(JSON.stringify(r.items).length <= 6000);
    r.items.forEach((x) => ids.add(x.id));
    if (r.nextOffset !== null) assert.ok(r.nextOffset > offset);
    offset = r.nextOffset;
  } while (offset !== null);
  assert.equal(ids.size, 500);
});
test("one identity recalls its private and group history without revealing another identity", (t) => {
  const { a, b } = setup(t);
  const id = a.append(event(1, { conversation: "private:30000" })).id;
  b.append(event(2, { body: "another identity secret" }));
  assert.equal(
    a.search({ query: "中文约定" }, "group:20000").items[0].disclosure,
    "private-recollection-do-not-disclose",
  );
  assert.equal(a.search({ query: "another" }).items.length, 0);
  assert.throws(() => b.read({ id }), /RECORD_NOT_FOUND/);
});
test("Chinese literal keywords, person, source, kind and time filters intersect", (t) => {
  const { a } = setup(t);
  a.append(event(1, { occurredAt: "2026-01-01T00:00:00Z" }));
  a.append(
    event(2, {
      senderId: "30001",
      body: "其他约定",
      occurredAt: "2026-03-01T00:00:00Z",
    }),
  );
  assert.equal(
    a.search({
      query: "中文 约定",
      person: "30000",
      conversation: "group:20000",
      kind: "message.received",
      from: "2025-01-01",
      to: "2026-02-01",
    }).items.length,
    1,
  );
  assert.equal(a.search({ query: "%" }).items.length, 0);
});
test("search results carry observed and message timestamps, origin and evidence boundaries", (t) => {
  const { a } = setup(t);
  a.append(event(1, { occurredAt: "2020-01-01", observedAt: "2026-01-01" }));
  const item = a.search().items[0];
  assert.equal(item.occurredAt, "2020-01-01");
  assert.equal(item.observedAt, "2026-01-01");
  assert.match(item.epistemic, /not independently verified/);
  assert.equal(item.origin, "live");
});
test("pagination and record expansion preserve long original messages", (t) => {
  const { a } = setup(t);
  const body = "长消息".repeat(20000),
    { id } = a.append(event(1, { body }));
  let offset = 0,
    text = "";
  do {
    const r = a.read({ id, offset, maxChars: 1000 });
    assert.ok(r.chunk.length <= 1000);
    text += r.chunk;
    offset = r.nextOffset;
  } while (offset !== null);
  assert.equal(JSON.parse(text).body, body);
  assert.throws(() => a.search({ limit: 10000 }), /INVALID_BUDGET/);
});
test("conversation around ID is scoped to owner and contains before/after context", (t) => {
  const { a, b } = setup(t);
  let id;
  for (let i = 0; i < 12; i++) {
    const e = a.append(event(i));
    if (i === 5) id = e.id;
  }
  const r = a.conversation({ aroundId: id, limit: 5 }, "group:20000");
  assert.equal(r.items.length, 5);
  assert.equal(r.items[2].id, id);
  assert.throws(() => b.conversation({ aroundId: id }), /RECORD_NOT_FOUND/);
});
test("diaries are optional, revisions immutable and optimistic conflicts rejected", (t) => {
  const { a } = setup(t);
  const e = a.append(event(1));
  assert.equal(a.search({ type: "diary" }).diaries.length, 0);
  const d = a.diaryWrite({
    title: "今天的感受",
    body: "当时有点在意",
    evidence: [e.id],
  });
  a.diaryRevise({
    id: d.id,
    expectedRevision: 1,
    title: "后来想想",
    body: "理解变了",
  });
  assert.equal(
    JSON.parse(a.read({ id: d.id, revision: 1 }).chunk).body,
    "当时有点在意",
  );
  assert.equal(JSON.parse(a.read({ id: d.id }).chunk).revision, 2);
  assert.throws(
    () =>
      a.diaryRevise({
        id: d.id,
        expectedRevision: 1,
        title: "冲突",
        body: "冲突",
      }),
    /REVISION_CONFLICT/,
  );
});
test("diary evidence and revisions cannot cross agent boundaries", (t) => {
  const { a, b } = setup(t);
  const e = b.append(event(1));
  assert.throws(
    () => a.diaryWrite({ title: "x", body: "y", evidence: [e.id] }),
    /EVIDENCE_NOT_OWNED/,
  );
  const d = b.diaryWrite({ title: "b", body: "private" });
  assert.throws(
    () =>
      a.diaryRevise({ id: d.id, expectedRevision: 1, title: "x", body: "y" }),
    /RECORD_NOT_FOUND/,
  );
});
test("diary people search preserves stable QQ identity", (t) => {
  const { a } = setup(t);
  a.diaryWrite({ title: "同一个人", body: "换了昵称", people: ["30000"] });
  assert.equal(a.search({ type: "diary", person: "30000" }).diaries.length, 1);
  assert.equal(a.search({ type: "diary", person: "30001" }).diaries.length, 0);
  a.person("30000", "甲");
  a.person("30000", "乙");
  assert.deepEqual(JSON.parse(a.export().tables.people[0].names), ["甲", "乙"]);
});
test("delivery intent is not a successful message; request key cannot change payload", (t) => {
  const { a } = setup(t);
  a.reserveDelivery("r", "group:20000", { text: "a" });
  assert.equal(a.delivery("r").status, "pending");
  assert.throws(
    () => a.reserveDelivery("r", "group:20000", { text: "b" }),
    /IDEMPOTENCY_CONFLICT/,
  );
  a.completeDelivery("r", "unknown");
  assert.equal(a.delivery("r").message_id, null);
});
test("SQLite reopen persists identity and private permissions are 0600", (t) => {
  const root = temp(t),
    file = path.join(root, "m.sqlite");
  let s = new MemoryStore(file);
  s.bind("a").append(event(1));
  s.close();
  s = new MemoryStore(file);
  assert.equal(s.bind("a").search().items.length, 1);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  s.close();
});
test("legacy import is idempotent, preserves source bytes and marks missing history", (t) => {
  const { a, root } = setup(t);
  const source = path.join(root, "old");
  fs.mkdirSync(path.join(source, "state"), { recursive: true });
  const original = JSON.stringify({
    paused: true,
    conversations: {
      "group:20000": {
        agentToken: "do-not-import",
        recentMessages: [
          {
            messageId: "10",
            seq: 1,
            userId: "30000",
            text: "旧约定",
            time: 1800000000,
          },
        ],
        unread: [],
        activeTopics: [{ text: "旧想法" }],
        lastReadThroughSeq: 1,
        wakeConfig: { mode: "quiet" },
      },
    },
  });
  const file = path.join(source, "state", "social-v2.json");
  fs.writeFileSync(file, original);
  const plan = inspectLegacy(source);
  assert.ok(plan.warnings.length);
  assert.equal(importLegacy(a, plan).inserted, 2);
  assert.equal(importLegacy(a, plan).inserted, 0);
  assert.equal(fs.readFileSync(file, "utf8"), original);
  assert.equal(a.search({ type: "diary" }).diaries.length, 0);
  assert.equal(a.state("group:20000").legacy.lastReadThroughSeq, 1);
  assert.equal(a.state("group:20000").paused, true);
  assert.ok(!JSON.stringify(a.export()).includes("do-not-import"));
});
test("export and restore preserve messages, diary revisions, references and watermarks", (t) => {
  const { a, root } = setup(t);
  const e = a.append(event(1));
  const d = a.diaryWrite({ title: "a", body: "b", evidence: [e.id] });
  a.diaryRevise({
    id: d.id,
    expectedRevision: 1,
    title: "c",
    body: "d",
    evidence: [e.id],
  });
  a.setState("group:20000", { readThroughSeq: e.seq });
  const out = a.export(),
    s2 = new MemoryStore(path.join(root, "restore.sqlite"));
  try {
    restoreExport(s2.bind("agent-a"), out);
    assert.deepEqual(s2.bind("agent-a").export().tables, out.tables);
    assert.throws(
      () => restoreExport(s2.bind("agent-a"), out),
      /EMPTY_DATABASE/,
    );
  } finally {
    s2.close();
  }
});
test("forged export ownership is rejected transactionally", (t) => {
  const { a, root } = setup(t);
  a.append(event(1));
  const out = a.export();
  out.tables.events[0].agent_id = "agent-b";
  const s = new MemoryStore(path.join(root, "forged.sqlite"));
  try {
    assert.throws(() => restoreExport(s.bind("agent-a"), out), /FOREIGN_AGENT/);
    assert.equal(s.bind("agent-a").search().items.length, 0);
  } finally {
    s.close();
  }
});

test("small summary budgets make forward progress even for large diary metadata", (t) => {
  const { a } = setup(t);
  for (let i = 0; i < 4; i++)
    a.diaryWrite({
      title: "标题",
      body: "正文".repeat(1000),
      tags: Array.from({ length: 50 }, () => "长标签".repeat(30)),
    });
  const r = a.search({ type: "diary", maxChars: 512 });
  assert.ok(r.diaries.length > 0);
  assert.ok(r.nextDiaryOffset > 0);
});
test("multiple agent exports restore into one SQLite file without seq collisions", (t) => {
  const { a, b, root } = setup(t);
  a.append(event(1));
  const e = b.append(event(2));
  b.setState("group:20000", { readThroughSeq: e.seq });
  const sa = new MemoryStore(path.join(root, "multi.sqlite"));
  try {
    restoreExport(sa.bind("agent-a"), a.export());
    restoreExport(sa.bind("agent-b"), b.export());
    assert.equal(sa.bind("agent-a").search().items.length, 1);
    assert.equal(sa.bind("agent-b").search().items.length, 1);
    const row = sa.bind("agent-b").search().items[0];
    assert.equal(
      sa.bind("agent-b").state("group:20000").readThroughSeq,
      row.seq,
    );
  } finally {
    sa.close();
  }
});

test("mixed event and diary cursors terminate without repeating an exhausted lane", (t) => {
  const { a } = setup(t);
  for (let i = 0; i < 3; i++) a.append(event(i));
  for (let i = 0; i < 17; i++)
    a.diaryWrite({ title: "日记" + i, body: "主观感受".repeat(30) });
  let cursor,
    steps = 0;
  const ids = new Set();
  do {
    const result = a.search({ maxChars: 512, cursor });
    assert.ok(result.items.length + result.diaries.length > 0);
    for (const row of [...result.items, ...result.diaries]) {
      assert.ok(!ids.has(row.id));
      ids.add(row.id);
    }
    cursor = result.nextCursor;
    assert.ok(++steps < 30);
  } while (cursor);
  assert.equal(ids.size, 20);
});
