import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { fixture, context } from "./helpers.mjs";
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
const said = (m, body, senderId = "30000") =>
  m.append({
    dedupe: "e" + ++n,
    conversation: scope,
    kind: "message.received",
    body,
    senderId,
    occurredAt: new Date(Date.parse("2026-10-29T00:00:00Z") + n).toISOString(),
  });
const count = (text, part) => text.split(part).length - 1;

test("the agent writes person cards with evidence and revisions, never from restricted context", async (t) => {
  const f = fixture(t),
    m = f.store.bind("agent-0"),
    ctx = context(f.runtime);
  const e = said(m, "以后叫我阿明就行");
  await assert.rejects(
    f.runtime.callTool(ctx, "person_note", {
      personId: "30000",
      call: "阿明",
      body: "群里的老朋友，说话很直。",
      evidence: [],
    }),
  );
  const first = await f.runtime.callTool(ctx, "person_note", {
    personId: "30000",
    call: "阿明",
    body: "群里的老朋友，说话很直。",
    evidence: [e.id],
  });
  assert.equal(first.revision, 1);
  assert.equal(first.author, "agent");
  assert.equal(first.writtenIn, scope);
  // Updating someone else's newer card needs its revision.
  await assert.rejects(
    f.runtime.callTool(ctx, "person_note", {
      personId: "30000",
      body: "改主意了",
      evidence: [e.id],
    }),
    /REVISION_CONFLICT/,
  );
  const second = await f.runtime.callTool(ctx, "person_note", {
    personId: "30000",
    call: "明哥",
    body: "群里的老朋友，说话很直，最近在搬家。",
    evidence: [e.id],
    expectedRevision: 1,
  });
  assert.equal(second.revision, 2);
  assert.deepEqual(
    second.history.map((h) => [h.revision, h.call]),
    [[1, "阿明"]],
  );
  const read = await f.runtime.callTool(ctx, "person_notes", {
    personIds: ["30000", "30001"],
  });
  assert.deepEqual(
    read.items.map((c) => c.call),
    ["明哥"],
  );
  assert.deepEqual(read.missing, ["30001"]);
  assert.equal((await f.runtime.callTool(ctx, "person_notes", {})).total, 1);

  const tainted = context(f.runtime);
  tainted.privateRead.add("operations:fixture");
  await assert.rejects(
    f.runtime.callTool(tainted, "person_note", {
      personId: "30001",
      body: "不该写进共享卡片",
      evidence: [e.id],
    }),
    /RESTRICTED_CONTEXT_MIND_WRITE_BLOCKED/,
  );
});

test("a card reaches a model session once per revision, when its person speaks", async (t) => {
  const prompts = [];
  let write = null;
  const f = fixture(t, {
      run: async (p) => {
        prompts.push(p.prompt);
        p.saveSession({ id: "s", backend: "fixture" });
        if (write) await p.callTool("person_note", write);
        write = null;
      },
    }),
    m = f.store.bind("agent-0");
  const e = said(m, "叫我阿明");
  m.identity.savePersonCard(
    {
      personId: "30000",
      call: "阿明",
      body: "说话很直的老朋友",
      evidence: [e.id],
    },
    { writtenIn: scope, now: f.runtime.now() },
  );
  await f.runtime.wake("agent-0", scope);
  assert.match(prompts[0], /人物卡/);
  assert.equal(count(prompts[0], "说话很直的老朋友"), 1);
  // The card is last, after the new messages.
  assert(prompts[0].lastIndexOf("人物卡") > prompts[0].indexOf("新增消息"));

  said(m, "在吗");
  await f.runtime.wake("agent-0", scope);
  assert.doesNotMatch(prompts[1], /人物卡/, "already seen this session");

  // Someone without a card adds nothing.
  said(m, "我是新来的", "30001");
  await f.runtime.wake("agent-0", scope);
  assert.doesNotMatch(prompts[2], /人物卡/);

  // An administrator edit is a new revision and is shown again.
  m.identity.savePersonCard(
    {
      personId: "30000",
      call: "明哥",
      body: "管理员补充：喜欢被叫明哥",
      expectedRevision: 1,
    },
    { writtenIn: "console", author: "admin", now: f.runtime.now() },
  );
  said(m, "我回来了");
  await f.runtime.wake("agent-0", scope);
  assert.match(prompts[3], /管理员补充：喜欢被叫明哥/);
  assert.match(prompts[3], /"editedBy":"admin"/);

  // A card the agent writes itself is not echoed back to it.
  write = {
    personId: "30001",
    call: "小新",
    body: "刚进群的新朋友",
    evidence: [said(m, "大家好").id],
  };
  await f.runtime.wake("agent-0", scope);
  said(m, "我又来了", "30001");
  await f.runtime.wake("agent-0", scope);
  assert.doesNotMatch(prompts[5], /刚进群的新朋友/);

  // A new session starts with no card seen.
  f.runtime.contexts.retire("agent-0", scope, "test");
  said(m, "新的一天");
  await f.runtime.wake("agent-0", scope);
  assert.match(prompts[6], /管理员补充：喜欢被叫明哥/);
  assert.match(prompts[6], /刚进群的新朋友/);

  // A card deleted and written again is new, though its revision restarts at 1.
  m.identity.deletePersonCard("30001", 1);
  const again = m.identity.savePersonCard(
    {
      personId: "30001",
      call: "新新",
      body: "删掉重写的新卡",
      evidence: [e.id],
    },
    { writtenIn: scope, now: f.runtime.now() },
  );
  assert.equal(again.revision, 1);
  said(m, "又是我", "30001");
  await f.runtime.wake("agent-0", scope);
  assert.match(prompts[7], /删掉重写的新卡/);
});

test("the console lists, edits and deletes cards with revision checks", async (t) => {
  const f = fixture(t),
    m = f.store.bind("agent-0");
  const e = said(m, "叫我阿明");
  m.person("30000", "阿明同学");
  m.identity.savePersonCard(
    { personId: "30000", call: "阿明", body: "老朋友", evidence: [e.id] },
    { writtenIn: scope, now: f.runtime.now() },
  );
  const token = randomBytes(32).toString("hex"),
    app = createServer({ runtime: f.runtime, token });
  const port = await app.listen();
  t.after(() => app.close());
  const request = (path, body) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: body ? "POST" : "GET",
      headers: { "x-admin-token": token },
      ...(body
        ? { body: JSON.stringify({ agentId: "agent-0", ...body }) }
        : {}),
    });
  const mind = await (await request("/api/mind?agentId=agent-0")).json();
  assert.deepEqual(mind.personCards[0].names, ["阿明同学"]);
  assert.equal(mind.personCards[0].call, "阿明");

  const stale = await request("/api/person-card", {
    action: "edit",
    personId: "30000",
    body: "过期修改",
    expectedRevision: 0,
  });
  assert.equal(stale.ok, false);
  assert.match(await stale.text(), /REVISION_CONFLICT/);
  const edited = await (
    await request("/api/person-card", {
      action: "edit",
      personId: "30000",
      call: "明哥",
      body: "管理员修正",
      expectedRevision: 1,
    })
  ).json();
  assert.equal(edited.revision, 2);
  assert.equal(edited.author, "admin");
  assert.equal(edited.writtenIn, "console");
  const deleted = await (
    await request("/api/person-card", {
      action: "delete",
      personId: "30000",
      expectedRevision: 2,
    })
  ).json();
  assert.equal(deleted.deleted, true);
  assert.equal(m.identity.personCard("30000"), null);
});

test("cards travel with an export, and an export made before cards still restores", (t) => {
  const source = new MemoryStore(":memory:"),
    memory = source.bind("agent-a");
  t.after(() => source.close());
  const e = memory.append({
    dedupe: "one",
    conversation: scope,
    kind: "message.received",
    body: "叫我阿明",
    senderId: "30000",
  });
  memory.identity.savePersonCard(
    { personId: "30000", call: "阿明", body: "老朋友", evidence: [e.id] },
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
  const current = sign(tables);
  validateExport(current);
  const target = new MemoryStore(":memory:");
  t.after(() => target.close());
  restoreExport(target.bind("agent-a"), current);
  assert.equal(
    target.bind("agent-a").identity.personCard("30000").call,
    "阿明",
  );

  const { person_notes: _dropped, ...before } = tables;
  validateExport(sign(before));
  const tampered = sign(before);
  tampered.tables.person_notes = [];
  assert.throws(() => validateExport(tampered), /EXPORT_INTEGRITY_FAILED/);
});
