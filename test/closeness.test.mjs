import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  closeness,
  closenessEvents,
  personCloseness,
  rankReachTargets,
  CLOSENESS_DAY as DAY,
  CLOSENESS_THRESHOLDS,
} from "../src/core/closeness.mjs";
import { fixture, context, temp } from "./helpers.mjs";
import { personCardsForTurn } from "../src/core/person-cards.mjs";
import { subjectMaterials } from "../src/core/subject-materials.mjs";
import { createServer } from "../src/server.mjs";
import { MemoryStore } from "../src/memory/store.mjs";
import { restoreExport } from "../src/memory/migrate.mjs";
import { withExport } from "../src/memory/export.mjs";
const NOW = Date.parse("2026-11-01T08:00:00Z");
let number = 0;
function record(
  memory,
  {
    at = NOW,
    direction = "in",
    conversation = "private:30000",
    senderId = direction === "in" ? "30000" : "10000",
    payload = {},
    kind = direction === "in" ? "message.received" : "message.sent",
    ledger = "sent",
    messageId = String(++number + 40000),
    requestId = "fixture-" + number,
    connectionId = "qq-0",
  } = {},
) {
  if (direction === "out" && !memory.delivery(requestId)) {
    memory.reserveDelivery(requestId, conversation, { kind: "fixture" });
    memory.completeDelivery(requestId, ledger, messageId);
  }
  return memory.append({
    dedupe: "event-" + ++number,
    connectionId,
    conversation,
    senderId,
    direction,
    kind,
    status: direction === "out" ? "confirmed" : "observed",
    messageId,
    occurredAt: new Date(at).toISOString(),
    body: "测试消息",
    payload: {
      accountId: "10000",
      messageNamespace: "onebot",
      ...(direction === "out" ? { requestId } : {}),
      ...payload,
    },
  });
}
function card(memory, override) {
  return memory.identity.savePersonCard(
    {
      personId: "30000",
      body: "相处印象",
      ...(override ? { closenessOverride: override } : {}),
    },
    { author: "admin", now: NOW },
  );
}
function contacts(memory, count = 60, at = NOW) {
  for (let i = 0; i < count; i++)
    record(memory, {
      at: at - (count - i) * 1000,
      direction: i % 2 ? "out" : "in",
    });
}
const interaction = (direction, at, extra = {}) => ({
  personId: "30000",
  conversation: "private:30000",
  direction,
  at,
  kind: direction === "in" ? "message.received" : "message.sent",
  status: "confirmed",
  sent: true,
  ...extra,
});

test("fixed thresholds, directed rounds and half-life give deterministic tiers", () => {
  assert.deepEqual(CLOSENESS_THRESHOLDS, [0, 4, 16, 48]);
  const rows = [interaction("in", NOW - 1000), interaction("out", NOW)];
  const fresh = closeness(rows, "30000", NOW);
  assert.equal(fresh.rounds, 1);
  assert.equal(fresh.tier, "陌生");
  const older = closeness(rows, "30000", NOW + 14 * DAY);
  assert.equal(older.score, fresh.score / 2);
  assert.equal(
    closeness(
      Array.from({ length: 60 }, (_, i) =>
        interaction(i % 2 ? "out" : "in", NOW - 60000 + i * 1000),
      ),
      "30000",
      NOW,
    ).tier,
    "很熟",
  );
  assert.equal(
    closeness(
      Array.from({ length: 20 }, (_, i) =>
        interaction(i % 2 ? "out" : "in", NOW - 20000 + i * 1000),
      ),
      "30000",
      NOW,
    ).tier,
    "熟",
  );
  assert.equal(
    closeness(
      Array.from({ length: 6 }, (_, i) =>
        interaction(i % 2 ? "out" : "in", NOW - 6000 + i * 1000),
      ),
      "30000",
      NOW,
    ).tier,
    "认识",
  );
});

test("30-day and six-hour boundaries are exact; duplicate messages and unconfirmed output cannot inflate rounds", () => {
  const at = NOW - 30 * DAY;
  assert.equal(
    closeness([interaction("in", at), interaction("out", at)], "30000", NOW)
      .rounds > 0,
    true,
  );
  assert.equal(
    closeness(
      [interaction("in", at - 1), interaction("out", at - 1)],
      "30000",
      NOW,
    ).score,
    0,
  );
  assert.equal(
    closeness(
      [interaction("in", NOW - 6 * 3600000), interaction("out", NOW)],
      "30000",
      NOW,
    ).rounds,
    0,
  );
  const rows = [
    interaction("out", NOW - 1000, { messageKey: "one" }),
    interaction("in", NOW, { messageKey: "two" }),
    interaction("out", NOW, { messageKey: "one" }),
  ];
  assert.equal(closeness(rows, "30000", NOW).rounds, 1);
  assert.equal(closeness(rows, "30000", NOW).respondedOpenings, 1);
  assert.equal(
    closeness(
      [interaction("in", NOW - 1), interaction("out", NOW, { sent: false })],
      "30000",
      NOW,
    ).rounds,
    0,
  );
  assert.equal(
    closeness(
      Array.from({ length: 1000 }, (_, i) =>
        interaction("in", NOW - i * 6 * 3600000),
      ),
      "30000",
      NOW,
    ).tier,
    "陌生",
  );
});

test("private contacts count, unrelated groups/notices/unknown output do not; explicit at and quote pairs do", (t) => {
  const { store } = fixture(t),
    memory = store.bind("agent-0");
  for (let i = 0; i < 10; i++) {
    record(memory, {
      conversation: "group:20000",
      at: NOW - 10000 + i * 10,
      direction: i % 2 ? "out" : "in",
    });
    record(memory, { conversation: "group:20000", kind: "notice.reaction" });
    record(memory, { direction: "out", ledger: "unknown" });
  }
  assert.equal(closenessEvents(memory, "30000", NOW, "10000").length, 0);
  const one = record(memory, {
    conversation: "group:20000",
    at: NOW - 3000,
    payload: { segments: [{ type: "at", data: { qq: "10000" } }] },
  });
  const row = memory.db
    .prepare("SELECT message_id FROM events WHERE id=?")
    .get(one.id);
  record(memory, {
    conversation: "group:20000",
    direction: "out",
    at: NOW - 2000,
    payload: { replyTo: row.message_id },
  });
  const own = record(memory, {
    conversation: "group:20001",
    direction: "out",
    at: NOW - 1000,
    payload: { atUserId: "30000" },
  });
  const ownRow = memory.db
    .prepare("SELECT message_id FROM events WHERE id=?")
    .get(own.id);
  record(memory, {
    conversation: "group:20001",
    payload: { segments: [{ type: "reply", data: { id: ownRow.message_id } }] },
  });
  const events = closenessEvents(memory, "30000", NOW, "10000");
  assert.equal(events.length, 4);
  const computed = closeness(events, "30000", NOW);
  assert.ok(computed.rounds > 1.9);
  assert.equal(closenessEvents(memory, "30001", NOW, "10000").length, 0);
  record(memory, { payload: { protectedOperations: true } });
  const protectedMessage = record(memory, {
    direction: "out",
    conversation: "group:20000",
    payload: { protectedOperations: true },
    at: NOW - 1000,
  });
  const protectedId = memory.db
    .prepare("SELECT message_id FROM events WHERE id=?")
    .get(protectedMessage.id).message_id;
  record(memory, {
    conversation: "group:20000",
    payload: { segments: [{ type: "reply", data: { id: protectedId } }] },
  });
  assert.equal(closenessEvents(memory, "30000", NOW, "10000").length, 4);
});

test("platform aliases and the sent ledger deduplicate repeated archive entries", (t) => {
  const { store } = fixture(t),
    memory = store.bind("agent-0");
  record(memory, { messageId: "50000", at: NOW - 2000 });
  record(memory, { messageId: "50000", at: NOW - 1000 });
  record(memory, { messageId: "50001", requestId: "own", direction: "out" });
  record(memory, { messageId: "50001", requestId: "own", direction: "out" });
  assert.equal(closenessEvents(memory, "30000", NOW, "10000").length, 2);
  assert.equal(
    closeness(closenessEvents(memory, "30000", NOW, "10000"), "30000", NOW)
      .rounds,
    1,
  );
});

test("cache lasts 24 hours, belongs to agentId, survives connection changes, and refreshes cards once when tier changes", (t) => {
  const { store } = fixture(t),
    memory = store.bind("agent-0"),
    other = store.bind("agent-1");
  card(memory);
  card(other);
  assert.equal(personCloseness(memory, "30000", NOW, "10000").tier, "陌生");
  contacts(memory);
  assert.equal(
    personCloseness(memory, "30000", NOW + DAY - 1, "10000").tier,
    "陌生",
  );
  const first = personCardsForTurn(memory, "private:30000", [], {
    fresh: false,
    accountId: "10000",
    now: NOW,
  });
  memory.setState("private:30000", { personCardsShown: first.shown });
  const after = personCardsForTurn(memory, "private:30000", [], {
    fresh: false,
    accountId: "10000",
    now: NOW + DAY,
  });
  assert.equal(after.cards[0].closeness.tier, "很熟");
  memory.setState("private:30000", { personCardsShown: after.shown });
  assert.equal(
    personCardsForTurn(memory, "private:30000", [], {
      fresh: false,
      accountId: "10000",
      now: NOW + DAY + 1,
    }).cards.length,
    0,
  );
  assert.equal(
    personCloseness(other, "30000", NOW + DAY, "10001").tier,
    "陌生",
  );
  memory.db
    .prepare("UPDATE events SET connection_id='qq-renamed' WHERE agent_id=?")
    .run(memory.agentId);
  assert.equal(
    personCloseness(memory, "30000", NOW + 2 * DAY, "10000").tier,
    "很熟",
  );
  assert.equal(
    personCloseness(memory, "30000", NOW + 3 * DAY, "10009").tier,
    "很熟",
  );
});

test("administrator override wins and ordinary model card revisions preserve it", (t) => {
  const { store } = fixture(t),
    memory = store.bind("agent-0");
  card(memory, "熟");
  assert.equal(personCloseness(memory, "30000", NOW, "10000").tier, "熟");
  const event = record(memory);
  memory.identity.savePersonCard(
    {
      personId: "30000",
      body: "新印象",
      evidence: [event.id],
      expectedRevision: 1,
    },
    { author: "agent", now: NOW },
  );
  assert.equal(
    personCloseness(memory, "30000", NOW + 40 * DAY, "10000").tier,
    "熟",
  );
  assert.throws(
    () =>
      memory.identity.savePersonCard(
        {
          personId: "30000",
          body: "越权",
          evidence: [event.id],
          expectedRevision: 2,
          closenessOverride: "很熟",
        },
        { author: "agent", now: NOW },
      ),
    /INVALID_CLOSENESS/,
  );
  memory.identity.savePersonCard(
    {
      personId: "30000",
      body: "恢复自动",
      expectedRevision: 2,
      closenessOverride: null,
    },
    { author: "admin", now: NOW },
  );
  assert.equal(personCloseness(memory, "30000", NOW, "10000").tier, "陌生");
});

test("both export paths discard cache and restore recomputes it while preserving override", async (t) => {
  const { store } = fixture(t),
    memory = store.bind("agent-0");
  card(memory);
  contacts(memory);
  personCloseness(memory, "30000", NOW, "10000");
  const data = memory.export();
  assert.equal(
    JSON.parse(data.tables.person_notes[0].value).closeness,
    undefined,
  );
  const streamed = await withExport(store, "agent-0", (file) =>
    JSON.parse(fs.readFileSync(file.path, "utf8")),
  );
  assert.equal(
    JSON.parse(streamed.tables.person_notes[0].value).closeness,
    undefined,
  );
  const automatic = new MemoryStore(path.join(temp(t), "automatic.sqlite"));
  t.after(() => automatic.close());
  restoreExport(automatic.bind("agent-0"), streamed);
  assert.equal(
    personCloseness(automatic.bind("agent-0"), "30000", NOW, "10000").tier,
    "很熟",
  );
  // Even old exports carrying derived caches must recompute after restore.
  const source = JSON.parse(data.tables.person_notes[0].value);
  source.closeness = {
    tier: "陌生",
    at: NOW,
    accountId: "10000",
    override: "认识",
  };
  data.tables.person_notes[0].value = JSON.stringify(source);
  const restored = new MemoryStore(path.join(temp(t), "restored.sqlite"));
  t.after(() => restored.close());
  restoreExport(restored.bind("agent-0"), data);
  assert.deepEqual(
    restored.bind("agent-0").identity.personCard("30000").closeness,
    { override: "认识" },
  );
  assert.equal(
    personCloseness(restored.bind("agent-0"), "30000", NOW, "10000").tier,
    "认识",
  );
});

test("reach order prefers familiar and less recently contacted targets without changing target permissions or budgets", (t) => {
  const ordered = rankReachTargets([
    { target: "private:30000", closeness: { tier: "陌生" } },
    {
      target: "private:30001",
      closeness: { tier: "熟" },
      lastSaidAt: "2026-10-31",
    },
    {
      target: "private:30002",
      closeness: { tier: "熟" },
      lastSaidAt: "2026-10-30",
    },
  ]);
  assert.deepEqual(
    ordered.map((x) => x.target),
    ["private:30002", "private:30001", "private:30000"],
  );
  const { runtime, store } = fixture(t),
    agent = runtime.agent("agent-0"),
    memory = store.bind(agent.id);
  runtime.now = () => NOW;
  agent.subject.enabled = true;
  agent.subject.users = ["30000", "30001"];
  agent.allow.users.push("30001");
  card(memory, "很熟");
  memory.setState("private:30000", { proactiveCooldownUntil: NOW + DAY });
  const before = structuredClone(agent),
    ctx = context(runtime, agent.id, "@subject");
  const reach = subjectMaterials(runtime, ctx).reach;
  assert.equal(reach.targets[0].target, "private:30000");
  assert.equal(
    reach.targets[0].cooldownUntil,
    new Date(NOW + DAY).toISOString(),
  );
  assert.deepEqual(agent, before);
  assert.deepEqual(memory.state("@subject").contacts, []);
});

test("console edits overrides with CAS and displays tier; QQ output and Self never gain automatic scores", async (t) => {
  const { runtime, store } = fixture(t),
    memory = store.bind("agent-0");
  card(memory);
  const token = randomBytes(32).toString("hex"),
    app = createServer({ runtime, token }),
    port = await app.listen();
  t.after(() => app.close());
  const request = (body) =>
    fetch(`http://127.0.0.1:${port}/api/person-card`, {
      method: "POST",
      headers: { "x-admin-token": token },
      body: JSON.stringify({
        agentId: "agent-0",
        action: "edit",
        personId: "30000",
        body: "印象",
        expectedRevision: 1,
        ...body,
      }),
    });
  assert.equal((await request({ closenessOverride: "很熟" })).ok, true);
  assert.equal((await request({ closenessOverride: "陌生" })).status, 409);
  const mind = await (
    await fetch(`http://127.0.0.1:${port}/api/mind?agentId=agent-0`, {
      headers: { "x-admin-token": token },
    })
  ).json();
  assert.equal(mind.personCards[0].closeness.tier, "很熟");
  const invalid = await request({
    expectedRevision: 2,
    closenessOverride: "unknown",
  });
  assert.equal(invalid.ok, false);
  assert.match(await invalid.text(), /INVALID_CLOSENESS/);
  const before = memory.identity.current();
  await runtime.send(context(runtime), { requestId: "plain", text: "你好" });
  assert.equal(
    runtime.transports.get("qq-0").sent[0].segments[0].data.text,
    "你好",
  );
  assert.deepEqual(memory.identity.current(), before);
});

test("a cold card does not inspect ledgers for other people's private output", (t) => {
  const { store } = fixture(t),
    memory = store.bind("agent-0");
  for (let i = 0; i < 20; i++)
    record(memory, { conversation: "private:30001", direction: "out" });
  record(memory, { at: NOW - 1000 });
  record(memory, { direction: "out" });
  let reads = 0;
  const delivery = memory.delivery.bind(memory);
  memory.delivery = (id) => {
    reads++;
    return delivery(id);
  };
  const events = closenessEvents(memory, "30000", NOW, "10000");
  assert.equal(events.length, 2);
  assert.equal(reads, 1);
});

for (const selected of [true, false])
  test(`person_notes ${selected ? "selected IDs" : "pagination"} refreshes old and expired cards without marking speech or participation`, async (t) => {
    const { runtime, store } = fixture(t),
      memory = store.bind("agent-0");
    runtime.clock = () => new Date(NOW);
    runtime.agent("agent-0").tools.push("person_notes");
    card(memory);
    const ctx = context(runtime),
      args = selected ? { personIds: ["30000"] } : {};
    const before = memory.state(ctx.conversation);
    const count = memory.db
      .prepare("SELECT count(*) AS n FROM events WHERE agent_id=?")
      .get(memory.agentId).n;
    const read = async () =>
      (await runtime.callTool(ctx, "person_notes", args)).items[0];
    assert.equal((await read()).closeness.tier, "陌生");
    let raw = memory.identity.personCard("30000");
    raw.closeness = { tier: "很熟", at: NOW - 2 * DAY, accountId: "10000" };
    memory.db
      .prepare(
        "UPDATE person_notes SET value=? WHERE agent_id=? AND person_id=?",
      )
      .run(JSON.stringify(raw), memory.agentId, "30000");
    assert.equal((await read()).closeness.tier, "陌生");
    assert.equal(memory.identity.personCard("30000").closeness.at, NOW);
    memory.identity.savePersonCard(
      {
        personId: "30000",
        body: "固定印象",
        expectedRevision: 1,
        closenessOverride: "熟",
      },
      { author: "admin", now: NOW },
    );
    const fixed = await read();
    assert.equal(fixed.closeness.tier, "熟");
    assert.equal(fixed.closeness.override, "熟");
    assert.equal(fixed.closeness.overridden, true);
    const after = memory.state(ctx.conversation);
    for (const key of [
      "personCardsShown",
      "readThroughSeq",
      "replyBatchSends",
      "lastReceivedSeq",
    ])
      assert.deepEqual(after[key], before[key]);
    assert.equal(
      memory.db
        .prepare("SELECT count(*) AS n FROM events WHERE agent_id=?")
        .get(memory.agentId).n,
      count,
    );
    assert.equal(ctx.sendCount, 0);
  });

test("withdrawn evidence and cached familiarity share one card key and survive all read/write projections", async (t) => {
  const { runtime, store } = fixture(t),
    memory = store.bind("agent-0"),
    agent = runtime.agent("agent-0");
  agent.behavior.actions.recall = true;
  agent.tools.push("qq_recall", "person_notes", "person_note");
  runtime.transports.get("qq-0").recall = async () => ({ confirmed: true });
  const ctx = context(runtime),
    original = await runtime.send(ctx, {
      requestId: "source",
      text: "原始话语",
    });
  memory.identity.savePersonCard(
    { personId: "30000", body: "原始印象", evidence: [original.recordId] },
    { author: "admin", now: runtime.now() },
  );
  const conversation = "private:30000",
    options = { fresh: false, accountId: "10000" };
  const first = personCardsForTurn(memory, conversation, [], options);
  memory.setState(conversation, { personCardsShown: first.shown });
  assert.equal(
    personCardsForTurn(memory, conversation, [], options).cards.length,
    0,
  );
  const withdrawn = await runtime.callTool(ctx, "qq_recall", {
    requestId: "withdraw",
    messageRef: original.recordId,
  });
  const second = personCardsForTurn(memory, conversation, [], options);
  assert.equal(
    second.cards[0].recalledEvidence[0].recalled.eventId,
    withdrawn.recordId,
  );
  assert.equal(second.cards[0].closeness.tier, "陌生");
  memory.setState(conversation, { personCardsShown: second.shown });
  let raw = memory.identity.personCard("30000");
  raw.closeness = { tier: "熟", at: Date.now(), accountId: "10000" };
  memory.db
    .prepare("UPDATE person_notes SET value=? WHERE agent_id=? AND person_id=?")
    .run(JSON.stringify(raw), memory.agentId, "30000");
  const third = personCardsForTurn(memory, conversation, [], options);
  assert.equal(third.cards[0].closeness.tier, "熟");
  assert.equal(third.cards[0].recalledEvidence[0].id, original.recordId);
  memory.setState(conversation, { personCardsShown: third.shown });
  assert.equal(
    personCardsForTurn(memory, conversation, [], options).cards.length,
    0,
  );
  const read = (
    await runtime.callTool(ctx, "person_notes", { personIds: ["30000"] })
  ).items[0];
  assert.equal(read.closeness.tier, "熟");
  assert.equal(read.recalledEvidence[0].id, original.recordId);
  const written = await runtime.callTool(ctx, "person_note", {
    personId: "30000",
    body: "更新印象",
    evidence: [original.recordId],
    expectedRevision: 1,
  });
  assert.equal(written.closeness.tier, "熟");
  assert.equal(written.recalledEvidence[0].id, original.recordId);
  const receipt = await runtime.callTool(ctx, "qq_send", {
    requestId: "follow-up",
    text: "说明",
    atUserId: "30000",
  });
  assert.equal(receipt.personCard, undefined);
});
