import test from "node:test";
import assert from "node:assert/strict";
import { fixture, context } from "./helpers.mjs";
import { interactionEvents } from "../src/core/closeness.mjs";
import { elsewhereForTurn } from "../src/core/elsewhere.mjs";

test("elsewhere waits for source processing, suppresses repeats and resets for a fresh session", (t) => {
  const { runtime, store } = fixture(t);
  const memory = store.bind("agent-0");
  runtime.agent("agent-0").behavior.elsewhere = {
    enabled: true,
    windowMs: 21600000,
  };
  const now = Date.parse("2026-11-01T08:00:00Z");
  const row = memory.append({
    dedupe: "elsewhere-source",
    conversation: "private:30000",
    senderId: "30000",
    direction: "in",
    kind: "message.received",
    occurredAt: new Date(now).toISOString(),
    body: "secret original",
    payload: {},
  });
  const ctx = context(runtime);
  ctx.conversation = "group:20000";
  const items = [{ id: row.id, direction: "in", senderId: "30000" }];
  const run = (fresh = false) =>
    elsewhereForTurn(runtime, ctx, items, { fresh, now, accountId: "10000" });
  assert.deepEqual(run().items, []);
  memory.setState("private:30000", {
    ...memory.state("private:30000"),
    readThroughSeq: row.seq,
  });
  const result = run();
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].where, "private");
  assert.equal(result.items[0].fromPrivate, true);
  assert.ok(!JSON.stringify(result).includes("secret original"));
  memory.setState(ctx.conversation, {
    ...memory.state(ctx.conversation),
    elsewhereShown: result.shown,
  });
  assert.equal(run().items.length, 0);
  assert.equal(run(true).items.length, 1);
  runtime.agent("agent-0").behavior.elsewhere.enabled = false;
  assert.equal(run(), null);
});

test("caps, chronology, protection, isolation and time query index", (t) => {
  const { runtime, store } = fixture(t);
  const memory = store.bind("agent-0");
  runtime.agent("agent-0").behavior.elsewhere = {
    enabled: true,
    windowMs: 21600000,
  };
  const now = Date.parse("2026-11-01T08:00:00Z");
  let n = 0;
  function add(person, conversation, extra = {}, bound = memory) {
    const row = bound.append({
      dedupe: `source-${++n}`,
      conversation,
      senderId: person,
      direction: "in",
      kind: "message.received",
      occurredAt: new Date(now).toISOString(),
      payload: { segments: [{ type: "at", data: { qq: "10000" } }], ...extra },
    });
    bound.setState(conversation, {
      ...bound.state(conversation),
      readThroughSeq: row.seq,
    });
    return row;
  }
  const people = ["30000", "30001", "30002", "30003"];
  for (const person of people)
    for (let g = 0; g < 3; g++) add(person, `group:${40000 + g}`);
  add("30000", "group:50000", { protectedOperations: true });
  add("30000", "group:50001", { protectedRepositories: ["private"] });
  add("30000", "group:50002", { segments: [] });
  add("30000", "@work:hidden");
  add("30000", "group:50003", {}, store.bind("other-agent"));
  const ctx = context(runtime);
  ctx.conversation = "private:30000";
  const history = people.map((senderId) => ({
    id: "missing",
    direction: "in",
    senderId,
  }));
  const run = () =>
    elsewhereForTurn(runtime, ctx, history, {
      fresh: false,
      now,
      accountId: "10000",
    });
  const result = run();
  assert.equal(result.items.length, 6);
  assert.deepEqual(
    result.items.map((x) => [x.personId, x.where]),
    [
      ["30003", "group:40002"],
      ["30003", "group:40001"],
      ["30002", "group:40002"],
      ["30002", "group:40001"],
      ["30001", "group:40002"],
      ["30001", "group:40001"],
    ],
  );
  assert.deepEqual(result.more, { 30003: 1, 30002: 1, 30001: 1, 30000: 3 });
  assert.deepEqual(Object.keys(result.shown).sort(), [
    "30001",
    "30002",
    "30003",
  ]);
  for (const person of Object.keys(result.shown))
    assert.equal(
      result.shown[person],
      result.items.find((x) => x.personId === person).continuation.id,
    );

  assert.equal(
    Object.values(result.more).reduce((a, b) => a + b, 0),
    6,
  );
  for (const person of people)
    assert.ok(result.items.filter((x) => x.personId === person).length <= 2);
  assert.ok(result.items.every((x) => /^group:4000[0-2]$/.test(x.where)));
  const latest = result.items[0];
  memory.setState(ctx.conversation, {
    ...memory.state(ctx.conversation),
    elsewhereShown: result.shown,
  });
  memory.db
    .prepare("UPDATE events SET payload=? WHERE agent_id=? AND id=?")
    .run(
      JSON.stringify({ protectedOperations: true }),
      "agent-0",
      latest.continuation.id,
    );
  assert.ok(!run().items.some((x) => x.personId === latest.personId));
  const plan = memory.db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT * FROM events WHERE agent_id=? AND occurred_at>=? AND occurred_at<=? AND kind IN ('message.received','message.sent') AND (sender_id=? OR direction='out') AND (conversation=? OR conversation LIKE 'group:%') ORDER BY occurred_at,seq",
    )
    .all(
      "agent-0",
      new Date(now - 21600000).toISOString(),
      new Date(now).toISOString(),
      "30000",
      "private:30000",
    );
  assert.ok(
    plan.some((x) => /events_time/.test(x.detail)),
    JSON.stringify(plan),
  );
});

test("window and outbound confirmation cannot leak pending sources; new contact re-shows", (t) => {
  const { runtime, store } = fixture(t);
  const memory = store.bind("agent-0");
  runtime.agent("agent-0").behavior.elsewhere = {
    enabled: true,
    windowMs: 21600000,
  };
  const now = Date.parse("2026-11-01T08:00:00Z");
  let n = 0;
  function send(status, at = now) {
    const requestId = `send-${++n}`,
      messageId = String(60000 + n);
    memory.reserveDelivery(requestId, "group:40000", { kind: "fixture" });
    memory.completeDelivery(requestId, status, messageId);
    return memory.append({
      dedupe: requestId,
      conversation: "group:40000",
      direction: "out",
      kind: "message.sent",
      status: "confirmed",
      messageId,
      occurredAt: new Date(at).toISOString(),
      payload: { requestId, atUserId: "30000" },
    });
  }
  send("pending");
  send("unknown");
  send("sent", now - 21600001);
  const ctx = context(runtime);
  ctx.conversation = "private:30000";
  const run = (fresh = false) =>
    elsewhereForTurn(runtime, ctx, [], { fresh, now, accountId: "10000" });
  const before = memory.state(ctx.conversation);
  assert.equal(run().items.length, 0);
  const row = send("sent");
  const first = run();
  assert.equal(first.items[0].messages, 1);
  assert.equal(first.items[0].startedBy, "you");
  assert.equal(first.items[0].lastFrom, "you");
  assert.equal(first.items[0].continuation.id, row.id);
  assert.deepEqual(memory.state(ctx.conversation), before);
  memory.setState(ctx.conversation, { ...before, elsewhereShown: first.shown });
  assert.equal(run().items.length, 0);
  send("sent");
  assert.equal(run().items[0].messages, 2);
  ctx.conversation = "group:40000";
  assert.equal(run(true).items.length, 0);
  ctx.conversation = "@subject";
  assert.equal(run(), null);
});

test("source eligibility precedes identity deduplication", (t) => {
  const { store } = fixture(t);
  const memory = store.bind("agent-0");
  const now = Date.parse("2026-11-01T08:00:00Z");
  const append = (id) =>
    memory.append({
      dedupe: id,
      connectionId: "qq-0",
      conversation: "private:30000",
      direction: "in",
      kind: "message.received",
      senderId: "30000",
      messageId: "70000",
      occurredAt: new Date(now).toISOString(),
      payload: { messageNamespace: "onebot", accountId: "10000" },
    });
  const first = append("first");
  const second = memory.append({
    dedupe: "second",
    connectionId: "qq-0",
    conversation: "private:30000",
    direction: "in",
    kind: "message.received",
    senderId: "30000",
    occurredAt: new Date(now).toISOString(),
    payload: {},
  });
  memory.db
    .prepare(
      "INSERT INTO message_aliases (agent_id,event_id,connection_id,conversation,namespace,message_id,account_id,evidence) SELECT agent_id,?,connection_id,conversation,namespace,message_id,'10000','{}' FROM message_identities WHERE agent_id=? AND event_id=?",
    )
    .run(second.id, "agent-0", first.id);
  const result = interactionEvents(memory, "30000", now, "10000", {
    since: now,
    allowed: (row) => row.id !== first.id,
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].id, second.id);
});

test("recall boundary applies canRead independently to every source", (t) => {
  const { runtime, store } = fixture(t);
  const memory = store.bind("agent-0");
  runtime.agent("agent-0").behavior.elsewhere = {
    enabled: true,
    windowMs: 21600000,
  };
  const now = Date.parse("2026-11-01T08:00:00Z");
  const append = (id, conversation) => {
    const row = memory.append({
      dedupe: id,
      conversation,
      direction: "in",
      kind: "message.received",
      senderId: "30000",
      occurredAt: new Date(now).toISOString(),
      payload: { segments: [{ type: "at", data: { qq: "10000" } }] },
    });
    memory.setState(conversation, {
      ...memory.state(conversation),
      readThroughSeq: row.seq,
    });
    return row;
  };
  const allowed = append("allowed", "group:40000");
  const denied = append("denied", "group:40001");
  const checked = [];
  runtime.protectedWork.context = () => ({});
  runtime.protectedWork.canRead = (_ctx, row) => {
    checked.push(row.id);
    return row.id === allowed.id;
  };
  const ctx = context(runtime);
  ctx.conversation = "private:30000";
  const result = elsewhereForTurn(runtime, ctx, [], {
    fresh: true,
    now,
    accountId: "10000",
  });
  assert.deepEqual(
    result.items.map((x) => x.continuation.id),
    [allowed.id],
  );
  assert.deepEqual(new Set(checked), new Set([allowed.id, denied.id]));
  assert.deepEqual(result.shown, { 30000: allowed.id });
  ctx.conversation = "@work:fixture";
  assert.equal(
    elsewhereForTurn(runtime, ctx, [], {
      fresh: true,
      now,
      accountId: "10000",
    }),
    null,
  );
});
