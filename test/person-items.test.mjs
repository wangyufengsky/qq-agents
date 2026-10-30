import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { fixture, context, config } from "./helpers.mjs";
import { createServer } from "../src/server.mjs";
import { MemoryStore } from "../src/memory/store.mjs";
import { restoreExport } from "../src/memory/migrate.mjs";
import {
  EXPORT_TABLES,
  exportDigest,
  validateExport,
} from "../src/memory/export-format.mjs";

const scope = "group:20000";
let n = 0;
const said = (m, body, senderId = "30000", conversation = scope) =>
  m.append({
    dedupe: "i" + ++n,
    conversation,
    connectionId: "qq-0",
    kind: "message.received",
    body,
    senderId,
    occurredAt: new Date(Date.parse("2026-10-29T00:00:00Z") + n).toISOString(),
  });
const count = (text, part) => text.split(part).length - 1;
// The items a prompt carries, or none.
const itemsIn = (prompt) => {
  const part = prompt
    .split("\n\n")
    .find((p) => p.startsWith("你和这些人之间还没了结的事"));
  return part ? JSON.parse(part.slice(part.indexOf("{"))) : null;
};
const turnsOf = (m) =>
  m.db
    .prepare(
      "SELECT value FROM model_turns WHERE agent_id=? ORDER BY json_extract(value,'$.startedAt'), rowid",
    )
    .all(m.agentId)
    .map((row) => JSON.parse(row.value));

test("the agent keeps promises, shared moments and boundaries per person, never from restricted context", async (t) => {
  const f = fixture(t),
    m = f.store.bind("agent-0"),
    ctx = context(f.runtime),
    call = (args) => f.runtime.callTool(ctx, "person_item", args);
  const ask = said(m, "那个结局到底是谁写的？");
  await assert.rejects(
    call({ personId: "30000", kind: "promise", body: "回头查", evidence: [] }),
  );
  await assert.rejects(
    call({ personId: "30000", body: "没有 kind", evidence: [ask.id] }),
    /INVALID_PERSON_ITEM/,
  );
  await assert.rejects(
    call({
      personId: "30000",
      kind: "promise",
      body: "一记下就关掉",
      evidence: [ask.id],
      status: "done",
      outcome: "x",
    }),
    /INVALID_PERSON_ITEM/,
  );
  const promise = await call({
    personId: "30000",
    kind: "promise",
    body: "答应帮他查结局是谁写的",
    evidence: [ask.id],
  });
  assert.equal(promise.status, "open");
  assert.equal(promise.revision, 1);
  assert.equal(promise.createdIn, scope);
  const joke = said(m, "以后别叫我胖子了");
  await call({
    personId: "30000",
    kind: "boundary",
    body: "他不喜欢被叫胖子",
    evidence: [joke.id],
  });
  // Updating needs the current revision; the kind stays what it was.
  await assert.rejects(
    call({ id: promise.id, personId: "30000", body: "改", evidence: [ask.id] }),
    /REVISION_CONFLICT/,
  );
  await assert.rejects(
    call({
      id: promise.id,
      personId: "30000",
      kind: "shared",
      body: "改",
      evidence: [ask.id],
      expectedRevision: 1,
    }),
    /INVALID_PERSON_ITEM/,
  );
  const edited = await call({
    id: promise.id,
    personId: "30000",
    body: "答应帮他查结局是谁写的，还有当年的访谈",
    evidence: [ask.id],
    expectedRevision: 1,
  });
  assert.equal(edited.revision, 2);
  assert.equal(edited.kind, "promise");
  assert.deepEqual(
    edited.history.map((h) => h.revision),
    [1],
  );
  const read = await f.runtime.callTool(ctx, "person_items", {
    personIds: ["30000", "30001"],
  });
  assert.deepEqual(read.people[0].open.map((x) => x.kind).sort(), [
    "boundary",
    "promise",
  ]);
  assert.deepEqual(read.people[1], {
    personId: "30001",
    open: [],
    recentlyClosed: [],
  });
  const owed = await f.runtime.callTool(ctx, "person_items", {
    kind: "promise",
  });
  assert.deepEqual(
    owed.items.map((x) => x.id),
    [promise.id],
  );

  const tainted = context(f.runtime);
  tainted.privateRead.add("operations:fixture");
  await assert.rejects(
    f.runtime.callTool(tainted, "person_item", {
      personId: "30000",
      kind: "shared",
      body: "不该进共享记录",
      evidence: [ask.id],
    }),
    /RESTRICTED_CONTEXT_MIND_WRITE_BLOCKED/,
  );
});

test("a promise closes only with a chat message after it: the report back or a never mind", async (t) => {
  const cfg = config(1);
  Object.assign(cfg.agents[0].subject, { enabled: true, groups: ["20000"] });
  const f = fixture(t, { cfg }),
    m = f.store.bind("agent-0"),
    ctx = context(f.runtime),
    call = (args) => f.runtime.callTool(ctx, "person_item", args);
  const ask = said(m, "帮我查查那本书出续集没");
  const promise = await call({
    personId: "30000",
    kind: "promise",
    body: "答应查那本书有没有续集",
    evidence: [ask.id],
  });
  const close = (evidence, extra = {}) =>
    call({
      id: promise.id,
      personId: "30000",
      status: "done",
      outcome: "查到了，告诉他明年出",
      evidence,
      expectedRevision: promise.revision,
      ...extra,
    });
  // What led to the promise is not a later message.
  await assert.rejects(close([ask.id]), /PERSON_ITEM_CLOSE_NEEDS_MESSAGE/);
  // Thinking it over in free time is not telling them.
  const log = await f.runtime.callTool(
    context(f.runtime, "agent-0", "@subject"),
    "subject_log",
    { did: "searched", summary: "查到续集明年出" },
  );
  await assert.rejects(close([log.id]), /PERSON_ITEM_CLOSE_NEEDS_MESSAGE/);
  await assert.rejects(close([ask.id], { outcome: "" }), /INVALID_PERSON_ITEM/);
  // A message with someone else is not telling this person.
  const elsewhere = said(m, "我也想知道", "30009", "group:20009");
  await assert.rejects(
    close([elsewhere.id]),
    /PERSON_ITEM_CLOSE_NEEDS_MESSAGE/,
  );
  // The agent's own report, cited by the recordId its send returns.
  const sent = await f.runtime.send(ctx, {
    requestId: "report",
    text: "查到了，续集明年出",
  });
  assert.equal(sent.status, "sent");
  assert.match(sent.recordId, /^[0-9a-f-]{36}$/);
  const done = await close([sent.recordId]);
  assert.equal(done.status, "done");
  assert.equal(done.outcome, "查到了，告诉他明年出");
  await assert.rejects(
    call({
      id: promise.id,
      personId: "30000",
      body: "关掉之后再改",
      evidence: [sent.recordId],
      expectedRevision: done.revision,
    }),
    /PERSON_ITEM_CLOSED/,
  );
  // The person saying it is no longer needed also closes one.
  const other = await call({
    personId: "30000",
    kind: "promise",
    body: "答应下次接着讲故事",
    evidence: [ask.id],
  });
  const never = said(m, "故事不用讲了，我看完原著了");
  const dropped = await call({
    id: other.id,
    personId: "30000",
    status: "dropped",
    outcome: "他自己看完了，不用再讲",
    evidence: [never.id],
    expectedRevision: 1,
  });
  assert.equal(dropped.status, "dropped");
  const read = await f.runtime.callTool(ctx, "person_items", {
    personIds: ["30000"],
  });
  assert.deepEqual(read.people[0].open, []);
  assert.deepEqual(read.people[0].recentlyClosed.map((x) => x.status).sort(), [
    "done",
    "dropped",
  ]);
});

test("open items reach a chat when the person comes up, once per revision, boundaries first", async (t) => {
  const prompts = [];
  let write = null;
  // Room for every turn in one session, so none is handed off for space.
  const cfg = config(1);
  cfg.agents[0].contextPolicy.capacityTokens = 1000000;
  const f = fixture(t, {
      cfg,
      run: async (p) => {
        prompts.push(p.prompt);
        p.saveSession({ id: "s", backend: "fixture" });
        if (write) await p.callTool("person_item", write);
        write = null;
      },
    }),
    m = f.store.bind("agent-0"),
    now = () => f.runtime.now();
  const e = said(m, "证据");
  const promise = m.identity.savePersonItem(
    {
      personId: "30000",
      kind: "promise",
      body: "答应帮他查结局",
      evidence: [e.id],
    },
    { writtenIn: scope, now: now() },
  );
  m.identity.savePersonItem(
    {
      personId: "30000",
      kind: "boundary",
      body: "私聊里说过不喜欢被叫胖子",
      evidence: [e.id],
    },
    { writtenIn: "private:30000", now: now() },
  );
  m.identity.savePersonItem(
    {
      personId: "30001",
      kind: "shared",
      body: "一起给反派起了外号",
      evidence: [e.id],
    },
    { writtenIn: scope, now: now() },
  );
  said(m, "我来了");
  await f.runtime.wake("agent-0", scope);
  const first = itemsIn(prompts[0]);
  assert.deepEqual(
    first.items.map((x) => x.kind),
    ["boundary", "promise"],
    "only who spoke, boundaries first",
  );
  assert.equal(first.items[0].fromPrivate, true);
  assert.equal("fromPrivate" in first.items[1], false);
  // After the cards, closest to the reply.
  assert(
    prompts[0].lastIndexOf("还没了结的事") > prompts[0].indexOf("新增消息"),
  );
  assert.deepEqual(
    turnsOf(m)[0].personItems.map((x) => x.revision),
    [1, 1],
  );

  said(m, "在吗");
  await f.runtime.wake("agent-0", scope);
  assert.equal(itemsIn(prompts[1]), null, "already seen this session");

  // A change is shown again; a closed item is not.
  m.identity.savePersonItem(
    {
      id: promise.id,
      personId: "30000",
      body: "答应帮他查结局和访谈",
      evidence: [e.id],
      expectedRevision: 1,
    },
    { writtenIn: scope, now: now() },
  );
  said(m, "又是我");
  await f.runtime.wake("agent-0", scope);
  assert.deepEqual(
    itemsIn(prompts[2]).items.map((x) => x.body),
    ["答应帮他查结局和访谈"],
  );

  // One the agent writes in this session is not echoed back.
  write = {
    personId: "30001",
    kind: "promise",
    body: "答应他明天再聊",
    evidence: [said(m, "明天再聊", "30001").id],
  };
  await f.runtime.wake("agent-0", scope);
  assert.deepEqual(
    itemsIn(prompts[3]).items.map((x) => x.body),
    ["一起给反派起了外号"],
  );
  said(m, "我也在", "30001");
  await f.runtime.wake("agent-0", scope);
  assert.equal(itemsIn(prompts[4]), null);
  assert.equal(count(prompts[4], "答应他明天再聊"), 0);

  // A new session starts with none seen, for everyone its messages show.
  f.runtime.contexts.retire("agent-0", scope, "test");
  said(m, "新的一天");
  await f.runtime.wake("agent-0", scope);
  assert.deepEqual(
    itemsIn(prompts[5]).items.map((x) => x.body),
    [
      "私聊里说过不喜欢被叫胖子",
      "答应帮他查结局和访谈",
      "答应他明天再聊",
      "一起给反派起了外号",
    ],
  );
});

test("free time lists promises still owed, the longest waiting first", async (t) => {
  const c = config(1);
  Object.assign(c.agents[0].subject, {
    enabled: true,
    groups: ["20000"],
    intervalMs: 60000,
  });
  const prompts = [];
  const f = fixture(t, {
      cfg: c,
      run: async (p) => {
        prompts.push(p.prompt);
      },
    }),
    m = f.store.bind("agent-0");
  const e = said(m, "证据");
  let clock = Date.parse("2026-10-29T08:00:00Z");
  f.runtime.clock = () => new Date(clock);
  m.identity.savePersonCard(
    { personId: "30001", call: "小新", body: "刚认识", evidence: [e.id] },
    { writtenIn: scope, now: clock },
  );
  for (const [personId, kind, body] of [
    ["30001", "promise", "最早答应的：帮小新找攻略"],
    ["30000", "boundary", "不喜欢被叫胖子"],
    ["30000", "promise", "后来答应的：查结局"],
  ]) {
    m.identity.savePersonItem(
      { personId, kind, body, evidence: [e.id] },
      { writtenIn: scope, now: clock },
    );
    clock += 60000;
  }
  await f.runtime.wake("agent-0", "@subject");
  const materials = JSON.parse(
    prompts[0].split("空闲时间素材：")[1].split("\n\n")[0],
  );
  assert.match(materials.owed.notice, /intent_create/);
  assert.deepEqual(
    materials.owed.items.map((x) => [x.body, x.call ?? null]),
    [
      ["最早答应的：帮小新找攻略", "小新"],
      ["后来答应的：查结局", null],
    ],
  );
  assert.deepEqual(materials.owed.items[0].evidence, [e.id]);
});

test("items travel with an export, keep their closing boundary, and older exports still restore", (t) => {
  const source = new MemoryStore(":memory:"),
    memory = source.bind("agent-a");
  t.after(() => source.close());
  const append = (dedupe, conversation) =>
    memory.append({
      dedupe,
      conversation,
      kind: "message.received",
      body: dedupe,
      senderId: "30000",
    });
  // Another identity's events push this one's seqs apart from the target's.
  for (let i = 0; i < 5; i++)
    source.bind("agent-b").append({
      dedupe: "b" + i,
      conversation: scope,
      kind: "message.received",
      body: "x",
      senderId: "1",
    });
  const before = append("before", scope);
  const item = memory.identity.savePersonItem(
    {
      personId: "30000",
      kind: "promise",
      body: "答应查",
      evidence: [before.id],
    },
    { writtenIn: scope, now: 1 },
  );
  const sign = (tables) => {
    const data = {
      version: 2,
      agentId: "agent-a",
      exportedAt: new Date(0).toISOString(),
      tables,
    };
    const digest = exportDigest(data),
      counts = {};
    for (const name of EXPORT_TABLES.filter((x) => x in tables)) {
      digest.update(name + "\n");
      for (const row of tables[name]) digest.update(JSON.stringify(row) + "\n");
      counts[name] = tables[name].length;
    }
    return {
      ...data,
      manifest: { algorithm: "sha256", counts, sha256: digest.digest("hex") },
    };
  };
  const tables = memory.export().tables;
  const target = new MemoryStore(":memory:");
  t.after(() => target.close());
  const restored = target.bind("agent-a");
  restoreExport(restored, sign(tables));
  assert.equal(restored.identity.personItem(item.id).body, "答应查");
  // The message that led to it still cannot close it after the restore.
  const [old] = restored.db
    .prepare("SELECT id FROM events WHERE agent_id=? AND dedupe='before'")
    .all("agent-a");
  assert.throws(
    () =>
      restored.identity.savePersonItem(
        {
          id: item.id,
          personId: "30000",
          status: "done",
          outcome: "x",
          evidence: [old.id],
          expectedRevision: 1,
        },
        { writtenIn: scope, now: 2 },
      ),
    /PERSON_ITEM_CLOSE_NEEDS_MESSAGE/,
  );
  const later = restored.append({
    dedupe: "after",
    conversation: scope,
    kind: "message.received",
    body: "不用查了",
    senderId: "30000",
  });
  assert.equal(
    restored.identity.savePersonItem(
      {
        id: item.id,
        personId: "30000",
        status: "dropped",
        outcome: "他说不用了",
        evidence: [later.id],
        expectedRevision: 1,
      },
      { writtenIn: scope, now: 3 },
    ).status,
    "dropped",
  );

  const { person_items: _dropped, ...earlier } = tables;
  validateExport(sign(earlier));
  const tampered = sign(earlier);
  tampered.tables.person_items = [];
  assert.throws(() => validateExport(tampered), /EXPORT_INTEGRITY_FAILED/);
});

test("the console shows a card's items read-only, open ones first", async (t) => {
  const f = fixture(t),
    m = f.store.bind("agent-0");
  const token = randomBytes(32).toString("hex"),
    app = createServer({ runtime: f.runtime, token });
  const port = await app.listen();
  t.after(() => app.close());
  const e = said(m, "证据");
  m.identity.savePersonCard(
    { personId: "30000", call: "阿明", body: "老朋友", evidence: [e.id] },
    { writtenIn: scope, now: f.runtime.now() },
  );
  const done = m.identity.savePersonItem(
    { personId: "30000", kind: "promise", body: "查结局", evidence: [e.id] },
    { writtenIn: scope, now: f.runtime.now() },
  );
  m.identity.savePersonItem(
    {
      id: done.id,
      personId: "30000",
      status: "done",
      outcome: "查到了",
      evidence: [said(m, "谢啦").id],
      expectedRevision: 1,
    },
    { writtenIn: scope, now: f.runtime.now() + 1 },
  );
  m.identity.savePersonItem(
    { personId: "30000", kind: "boundary", body: "别叫胖子", evidence: [e.id] },
    { writtenIn: "private:30000", now: f.runtime.now() + 2 },
  );
  const res = await fetch(`http://127.0.0.1:${port}/api/mind?agentId=agent-0`, {
    headers: { "x-admin-token": token },
  });
  const data = await res.json();
  const [card] = data.personCards;
  assert.deepEqual(
    card.items.map((x) => [x.kind, x.status, x.outcome ?? null]),
    [
      ["boundary", "open", null],
      ["promise", "done", "查到了"],
    ],
  );
  assert.equal(card.items[0].createdIn, "private:30000");
  assert.equal("evidence" in card.items[0], false);
  // The administrator removes a wrong one, with its revision.
  const remove = (expectedRevision) =>
    fetch(`http://127.0.0.1:${port}/api/person-item`, {
      method: "POST",
      headers: { "x-admin-token": token },
      body: JSON.stringify({
        agentId: "agent-0",
        action: "delete",
        id: card.items[0].id,
        expectedRevision,
      }),
    });
  assert.equal((await remove(9)).ok, false);
  assert.equal((await remove(card.items[0].revision)).ok, true);
  assert.equal(m.identity.personItem(card.items[0].id), null);
});
