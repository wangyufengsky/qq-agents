import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  interactionFacts,
  interactionEvents,
  personInteraction,
  withInteraction,
  INTERACTION_DAY as DAY,
  INTERACTION_CACHE_MS,
} from "../src/core/closeness.mjs";
import { fixture, context, temp } from "./helpers.mjs";
import { personCardsForTurn } from "../src/core/person-cards.mjs";
import { subjectMaterials } from "../src/core/subject-materials.mjs";
import { createServer } from "../src/server.mjs";
import { MemoryStore } from "../src/memory/store.mjs";
import { restoreExport } from "../src/memory/migrate.mjs";
import { withExport } from "../src/memory/export.mjs";
const NOW = Date.parse("2026-11-01T08:00:00Z");
const TIERS = /陌生|认识|很熟|"熟"|tier|score/;
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

test("facts are plain counts with no tier, score or decay", () => {
  const rows = [interaction("in", NOW - 1000), interaction("out", NOW)];
  const fresh = interactionFacts(rows, "30000", NOW);
  assert.deepEqual(fresh, {
    windowDays: 30,
    exchanges: 1,
    theyStarted: 1,
    youStarted: 0,
    youStartedAnswered: 0,
    lastDirectAt: new Date(NOW).toISOString(),
  });
  // Two weeks later the same contact counts the same: silence is not distance.
  const later = interactionFacts(rows, "30000", NOW + 14 * DAY);
  assert.equal(later.exchanges, fresh.exchanges);
  const many = interactionFacts(
    Array.from({ length: 60 }, (_, i) =>
      interaction(i % 2 ? "out" : "in", NOW - 60000 + i * 1000),
    ),
    "30000",
    NOW,
  );
  assert.equal(many.exchanges, 59);
  assert.doesNotMatch(JSON.stringify(many), TIERS);
  const opened = interactionFacts(
    [interaction("out", NOW - 2000), interaction("in", NOW - 1000)],
    "30000",
    NOW,
  );
  assert.equal(opened.youStarted, 1);
  assert.equal(opened.youStartedAnswered, 1);
});

test("30-day and six-hour boundaries are exact; duplicate messages and unconfirmed output cannot inflate exchanges", () => {
  const at = NOW - 30 * DAY;
  assert.equal(
    interactionFacts(
      [interaction("in", at), interaction("out", at)],
      "30000",
      NOW,
    ).exchanges > 0,
    true,
  );
  const outside = interactionFacts(
    [interaction("in", at - 1), interaction("out", at - 1)],
    "30000",
    NOW,
  );
  assert.equal(outside.exchanges, 0);
  assert.equal(outside.lastDirectAt, null);
  const split = interactionFacts(
    [interaction("in", NOW - 6 * 3600000), interaction("out", NOW)],
    "30000",
    NOW,
  );
  assert.equal(split.exchanges, 0);
  assert.equal(split.theyStarted, 1);
  assert.equal(split.youStarted, 1);
  const rows = [
    interaction("out", NOW - 1000, { messageKey: "one" }),
    interaction("in", NOW, { messageKey: "two" }),
    interaction("out", NOW, { messageKey: "one" }),
  ];
  assert.equal(interactionFacts(rows, "30000", NOW).exchanges, 1);
  assert.equal(interactionFacts(rows, "30000", NOW).youStartedAnswered, 1);
  assert.equal(
    interactionFacts(
      [interaction("in", NOW - 1), interaction("out", NOW, { sent: false })],
      "30000",
      NOW,
    ).exchanges,
    0,
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
  assert.equal(interactionEvents(memory, "30000", NOW, "10000").length, 0);
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
  const events = interactionEvents(memory, "30000", NOW, "10000");
  assert.equal(events.length, 4);
  assert.equal(interactionFacts(events, "30000", NOW).exchanges, 2);
  assert.equal(interactionEvents(memory, "30001", NOW, "10000").length, 0);
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
  assert.equal(interactionEvents(memory, "30000", NOW, "10000").length, 4);
});

test("platform aliases and the sent ledger deduplicate repeated archive entries", (t) => {
  const { store } = fixture(t),
    memory = store.bind("agent-0");
  record(memory, { messageId: "50000", at: NOW - 2000 });
  record(memory, { messageId: "50000", at: NOW - 1000 });
  record(memory, { messageId: "50001", requestId: "own", direction: "out" });
  record(memory, { messageId: "50001", requestId: "own", direction: "out" });
  const events = interactionEvents(memory, "30000", NOW, "10000");
  assert.equal(events.length, 2);
  assert.equal(interactionFacts(events, "30000", NOW).exchanges, 1);
});

test("facts are cached in memory only, per role, and changing counts never re-show a seen card", (t) => {
  const { store } = fixture(t),
    memory = store.bind("agent-0"),
    other = store.bind("agent-1");
  card(memory);
  card(other);
  const stored = () =>
    memory.db
      .prepare(
        "SELECT value FROM person_notes WHERE agent_id=? AND person_id=?",
      )
      .get(memory.agentId, "30000").value;
  const before = stored();
  assert.equal(personInteraction(memory, "30000", NOW, "10000").exchanges, 0);
  contacts(memory);
  assert.equal(
    personInteraction(memory, "30000", NOW + INTERACTION_CACHE_MS - 1, "10000")
      .exchanges,
    0,
  );
  assert.equal(
    personInteraction(memory, "30000", NOW + INTERACTION_CACHE_MS, "10000")
      .exchanges,
    59,
  );
  assert.equal(stored(), before, "reading never writes the card");
  assert.equal(personInteraction(other, "30000", NOW, "10001").exchanges, 0);
  const first = personCardsForTurn(memory, "private:30000", [], {
    fresh: false,
    accountId: "10000",
    now: NOW,
  });
  assert.equal(first.cards[0].interaction.windowDays, 30);
  assert.equal(first.cards[0].adminCloseness, undefined);
  assert.doesNotMatch(JSON.stringify(first.cards), TIERS);
  memory.setState("private:30000", { personCardsShown: first.shown });
  contacts(memory, 20, NOW + DAY);
  assert.equal(
    personCardsForTurn(memory, "private:30000", [], {
      fresh: false,
      accountId: "10000",
      now: NOW + DAY,
    }).cards.length,
    0,
  );
  // A legacy session key that carried a derived tier shows the card once more.
  memory.setState("private:30000", {
    personCardsShown: { 30000: first.shown["30000"] + ":closeness:熟:auto" },
  });
  assert.equal(
    personCardsForTurn(memory, "private:30000", [], {
      fresh: false,
      accountId: "10000",
      now: NOW + DAY,
    }).cards.length,
    1,
  );
});

test("an administrator statement is shown as the administrator's, survives model revisions and re-shows the card once", (t) => {
  const { store } = fixture(t),
    memory = store.bind("agent-0");
  card(memory);
  const options = { fresh: false, accountId: "10000", now: NOW };
  const plain = personCardsForTurn(memory, "private:30000", [], options);
  memory.setState("private:30000", { personCardsShown: plain.shown });
  memory.identity.savePersonCard(
    {
      personId: "30000",
      body: "相处印象",
      expectedRevision: 1,
      closenessOverride: "熟",
    },
    { author: "admin", now: NOW },
  );
  const fixed = personCardsForTurn(memory, "private:30000", [], options);
  assert.equal(fixed.cards[0].adminCloseness, "熟");
  assert.equal(fixed.cards[0].closeness, undefined);
  const event = record(memory);
  memory.identity.savePersonCard(
    {
      personId: "30000",
      body: "新印象",
      evidence: [event.id],
      expectedRevision: 2,
    },
    { author: "agent", now: NOW },
  );
  assert.equal(
    withInteraction(memory, memory.identity.personCard("30000"), NOW, "10000")
      .adminCloseness,
    "熟",
  );
  assert.throws(
    () =>
      memory.identity.savePersonCard(
        {
          personId: "30000",
          body: "越权",
          evidence: [event.id],
          expectedRevision: 3,
          closenessOverride: "很熟",
        },
        { author: "agent", now: NOW },
      ),
    /INVALID_CLOSENESS/,
  );
  memory.identity.savePersonCard(
    {
      personId: "30000",
      body: "不再说明",
      expectedRevision: 3,
      closenessOverride: null,
    },
    { author: "admin", now: NOW },
  );
  assert.equal(
    withInteraction(memory, memory.identity.personCard("30000"), NOW, "10000")
      .adminCloseness,
    undefined,
  );
});

test("both export paths discard legacy derived tiers and keep the administrator statement", async (t) => {
  const { store } = fixture(t),
    memory = store.bind("agent-0");
  card(memory);
  contacts(memory);
  const raw = memory.identity.personCard("30000");
  raw.closeness = { tier: "很熟", at: NOW, accountId: "10000" };
  memory.db
    .prepare("UPDATE person_notes SET value=? WHERE agent_id=? AND person_id=?")
    .run(JSON.stringify(raw), memory.agentId, "30000");
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
    withInteraction(
      restored.bind("agent-0"),
      restored.bind("agent-0").identity.personCard("30000"),
      NOW,
      "10000",
    ).adminCloseness,
    "认识",
  );
});

test("reach targets keep configuration order and carry facts without changing permissions or budgets", (t) => {
  const { runtime, store } = fixture(t),
    agent = runtime.agent("agent-0"),
    memory = store.bind(agent.id);
  runtime.now = () => NOW;
  agent.subject.enabled = true;
  agent.subject.users = ["30000", "30001"];
  agent.allow.users.push("30001");
  // Lots of contact with the second target and an administrator statement on
  // the first must not reorder the list: whom to think of is the agent's call.
  card(memory, "陌生");
  for (let i = 0; i < 20; i++)
    record(memory, {
      conversation: "private:30001",
      senderId: i % 2 ? "10000" : "30001",
      direction: i % 2 ? "out" : "in",
      at: NOW - (20 - i) * 1000,
    });
  memory.setState("private:30000", { proactiveCooldownUntil: NOW + DAY });
  const before = structuredClone(agent),
    ctx = context(runtime, agent.id, "@subject");
  const configured = runtime.subject
    .reachableTargets(agent)
    .map((x) => x.target);
  const reach = subjectMaterials(runtime, ctx).reach;
  assert.deepEqual(
    reach.targets.map((x) => x.target),
    configured,
  );
  const first = reach.targets.find((x) => x.target === "private:30000"),
    second = reach.targets.find((x) => x.target === "private:30001");
  assert.equal(first.adminCloseness, "陌生");
  assert.equal(first.cooldownUntil, new Date(NOW + DAY).toISOString());
  assert.equal(second.interaction.exchanges, 19);
  assert.equal(second.adminCloseness, undefined);
  assert.doesNotMatch(JSON.stringify(second), TIERS);
  assert.deepEqual(agent, before);
  assert.deepEqual(memory.state("@subject").contacts, []);
});

test("console edits statements with CAS and shows facts; QQ output and Self never gain scores", async (t) => {
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
  assert.equal(mind.personCards[0].adminCloseness, "很熟");
  assert.equal(mind.personCards[0].interaction.windowDays, 30);
  assert.equal(mind.personCards[0].closeness, undefined);
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
  const events = interactionEvents(memory, "30000", NOW, "10000");
  assert.equal(events.length, 2);
  assert.equal(reads, 1);
});

for (const selected of [true, false])
  test(`person_notes ${selected ? "selected IDs" : "pagination"} hides legacy tiers and shows facts without marking speech or participation`, async (t) => {
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
    assert.equal((await read()).interaction.windowDays, 30);
    let raw = memory.identity.personCard("30000");
    raw.closeness = { tier: "很熟", at: NOW - 2 * DAY, accountId: "10000" };
    memory.db
      .prepare(
        "UPDATE person_notes SET value=? WHERE agent_id=? AND person_id=?",
      )
      .run(JSON.stringify(raw), memory.agentId, "30000");
    const legacy = await read();
    assert.equal(legacy.closeness, undefined);
    assert.equal(legacy.adminCloseness, undefined);
    assert.doesNotMatch(JSON.stringify(legacy), /很熟/);
    memory.identity.savePersonCard(
      {
        personId: "30000",
        body: "固定印象",
        expectedRevision: 1,
        closenessOverride: "熟",
      },
      { author: "admin", now: NOW },
    );
    assert.equal((await read()).adminCloseness, "熟");
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

test("withdrawn evidence and administrator statements share one card key across read/write projections", async (t) => {
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
  memory.setState(conversation, { personCardsShown: second.shown });
  // A derived tier left by an earlier version is neither shown nor a reason
  // to show the card again.
  let raw = memory.identity.personCard("30000");
  raw.closeness = { tier: "熟", at: Date.now(), accountId: "10000" };
  memory.db
    .prepare("UPDATE person_notes SET value=? WHERE agent_id=? AND person_id=?")
    .run(JSON.stringify(raw), memory.agentId, "30000");
  assert.equal(
    personCardsForTurn(memory, conversation, [], options).cards.length,
    0,
  );
  const read = (
    await runtime.callTool(ctx, "person_notes", { personIds: ["30000"] })
  ).items[0];
  assert.equal(read.closeness, undefined);
  assert.equal(read.recalledEvidence[0].id, original.recordId);
  const written = await runtime.callTool(ctx, "person_note", {
    personId: "30000",
    body: "更新印象",
    evidence: [original.recordId],
    expectedRevision: 1,
  });
  assert.equal(written.closeness, undefined);
  assert.equal(written.interaction.windowDays, 30);
  assert.equal(written.recalledEvidence[0].id, original.recordId);
  const receipt = await runtime.callTool(ctx, "qq_send", {
    requestId: "follow-up",
    text: "说明",
    atUserId: "30000",
  });
  assert.equal(receipt.personCard, undefined);
});
