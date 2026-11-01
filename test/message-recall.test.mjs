import test from "node:test";
import assert from "node:assert/strict";
import { fixture, config, context } from "./helpers.mjs";
import { OneBot } from "../src/transport/onebot.mjs";
import { toolAvailable } from "../src/tools/catalog.mjs";
import { chatHistory } from "../src/core/chat-context.mjs";
import { chatRecall } from "../src/core/chat-recall.mjs";
import { personCardsForTurn } from "../src/core/person-cards.mjs";
import { freezeEvidence, evidenceView } from "../src/memory/evidence.mjs";
import { classifyError } from "../src/core/diagnostics.mjs";

function setup(t, actions = {}) {
  const cfg = config(2);
  for (const agent of cfg.agents) {
    agent.tools.push("qq_recall");
    agent.behavior.actions = {
      recall: true,
      recallWindowMs: 110000,
      recallMaxPerHour: 3,
      ...actions,
    };
    agent.behavior.maxSendPerMinute = 60;
  }
  const f = fixture(t, { cfg });
  const transport = f.runtime.transports.get("qq-0");
  const calls = [];
  transport.recall = async (messageId) => {
    calls.push(messageId);
    return { confirmed: true };
  };
  return {
    ...f,
    mem: f.store.bind("agent-0"),
    ctx: context(f.runtime),
    transport,
    calls,
  };
}
const sent = (f, requestId = "original", ctx = f.ctx, extra = {}) =>
  f.runtime.send(ctx, { requestId, text: "原始文字", ...extra });
const recall = (f, messageRef, requestId = "recall", ctx = f.ctx) =>
  f.runtime.callTool(ctx, "qq_recall", { requestId, messageRef });

test("recall confirms an owned sent message by record ID; keeps original and projects markers everywhere", async (t) => {
  const f = setup(t);
  f.mem.identity.savePersonCard(
    { personId: "30000", body: "已有印象" },
    { author: "admin", now: Date.now() },
  );
  const original = await sent(f, "original", f.ctx, { atUserId: "30000" });
  const snapshot = freezeEvidence(f.mem, [original.recordId], Date.now());
  f.mem.identity.savePersonCard(
    {
      personId: "30000",
      body: "一次谈话",
      evidence: [original.recordId],
      expectedRevision: 1,
    },
    { author: "agent", now: Date.now() },
  );
  const before = {
    sendCount: f.ctx.sendCount,
    confirmedSends: f.ctx.confirmedSends,
    replyBatchSends: f.mem.state(f.ctx.conversation).replyBatchSends,
  };
  // A recall must remain possible after the ordinary text batch is exhausted.
  f.runtime.agent("agent-0").maxConsecutiveSends = 1;
  f.ctx.confirmedSends = 0;
  const receipt = await recall(f, original.recordId);
  assert.equal(receipt.actionConfirmed, true);
  assert.deepEqual(f.calls, [original.messageId]);
  assert.equal(f.ctx.sendCount, before.sendCount);
  assert.equal(f.ctx.confirmedSends, 0);
  assert.equal(
    f.mem.state(f.ctx.conversation).replyBatchSends,
    before.replyBatchSends,
  );
  const row = f.mem.db
    .prepare("SELECT * FROM events WHERE id=?")
    .get(original.recordId);
  assert.equal(row.body, "原始文字");
  assert.equal(f.mem.delivery("original").status, "sent");
  const event = f.mem.event(row, f.ctx.conversation);
  assert.equal(event.recallNotice, "（你已撤回）");
  assert.equal(event.recalled.eventId, receipt.recordId);
  assert.equal(
    chatHistory({ items: [event] }).items[0].recalled.eventId,
    receipt.recordId,
  );
  const replay = chatRecall(
    f.runtime,
    f.ctx,
    { items: [] },
    { notes: [] },
    row.seq,
  );
  assert.equal(
    replay.items.find((x) => x.id === original.recordId).recallNotice,
    "（你已撤回）",
  );
  assert.equal(
    f.mem.view({ id: original.recordId }).recallNotice,
    "（你已撤回）",
  );
  const search = f.mem.search({
    query: "原始文字",
    contextBefore: 0,
    contextAfter: 0,
  });
  assert.equal(
    search.items.find((x) => x.id === original.recordId).scene.messages[0]
      .recallNotice,
    "（你已撤回）",
  );
  assert.match(
    f.mem.sentUnderCard(f.mem.identity.personCard("30000").id)[0].recent[0]
      .text,
    /^（你已撤回）/,
  );
  assert.equal(
    f.mem.identity.personCard("30000").recalledEvidence[0].id,
    original.recordId,
  );
  const proof = evidenceView(f.mem, { evidenceSnapshot: snapshot });
  assert.equal(proof.references[0].recallNotice, "（你已撤回）");
  assert.equal(snapshot.references[0].recalled, undefined);
  f.runtime.conversations.finish(f.ctx);
  assert.equal(f.mem.state(f.ctx.conversation).replyCheckAt, undefined);
  await assert.rejects(sent(f, "replacement"), /REPLY_BURST_LIMIT/);
});

test("same request reads a confirmed recall even outside window; new request cannot recall target twice", async (t) => {
  const f = setup(t),
    original = await sent(f);
  await recall(f, original.messageId);
  f.runtime.now = () => Date.now() + 120000;
  assert.equal((await recall(f, original.recordId)).duplicate, true);
  await assert.rejects(
    recall(f, original.recordId, "new-id"),
    /RECALL_TOO_LATE|RECALL_ALREADY_ATTEMPTED/,
  );
  assert.equal(f.calls.length, 1);
});

test("rejects inbound, other role, other chat and unarchived wire IDs", async (t) => {
  const f = setup(t),
    original = await sent(f);
  const incoming = f.mem.append({
    dedupe: "incoming",
    connectionId: "qq-0",
    conversation: f.ctx.conversation,
    senderId: "30000",
    direction: "in",
    kind: "message.received",
    messageId: "90000",
    body: "来信",
  });
  for (const [ref, ctx] of [
    [incoming.id, f.ctx],
    [original.recordId, context(f.runtime, "agent-1")],
    [original.recordId, context(f.runtime, "agent-0", "group:20001")],
    ["99999", f.ctx],
  ]) {
    await assert.rejects(recall(f, ref, "denied", ctx), /RECALL_NOT_OWN/);
  }
  assert.equal(f.calls.length, 0);
});

test("requires confirmed message event and matching sent ledger, including pending/unknown/failed rejection", async (t) => {
  const f = setup(t),
    original = await sent(f);
  for (const status of ["pending", "unknown", "failed"]) {
    f.mem.db
      .prepare("UPDATE deliveries SET status=? WHERE request_id='original'")
      .run(status);
    await assert.rejects(recall(f, original.recordId), /RECALL_NOT_SENT/);
  }
  const attempt = f.mem.db
    .prepare("SELECT id FROM events WHERE kind='message.send-attempt'")
    .get();
  await assert.rejects(recall(f, attempt.id), /RECALL_NOT_SENT/);
  assert.equal(f.calls.length, 0);
});

test("window is measured from confirmation and rechecked after queueing", async (t) => {
  const f = setup(t),
    original = await sent(f);
  const at = Date.parse(f.mem.delivery("original").updated_at);
  f.runtime.now = () => at + 110001;
  await assert.rejects(recall(f, original.recordId), /RECALL_TOO_LATE/);
  assert.equal(f.mem.delivery("recall"), undefined);
  f.runtime.now = () => at + 110000;
  await recall(f, original.recordId);
  assert.equal(f.calls.length, 1);
});

test("queued recall expires while another serialized delivery is in flight", async (t) => {
  const f = setup(t);
  const original = await sent(f, "first");
  let release;
  f.transport.recall = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const first = recall(f, original.recordId, "first-recall");
  await new Promise((resolve) => setImmediate(resolve));
  const secondOriginal = f.mem.append({
    dedupe: "second-original",
    connectionId: "qq-0",
    conversation: f.ctx.conversation,
    direction: "out",
    senderId: "10000",
    kind: "message.sent",
    status: "confirmed",
    messageId: "40002",
    body: "第二条",
    payload: { requestId: "second", messageNamespace: "onebot" },
  });
  f.mem.reserveDelivery("second", f.ctx.conversation, { kind: "test" });
  f.mem.completeDelivery("second", "sent", "40002");
  const second = recall(f, secondOriginal.id, "second-recall");
  f.runtime.now = () => Date.now() + 120000;
  release({ confirmed: true });
  await first;
  await assert.rejects(second, /RECALL_TOO_LATE/);
  assert.equal(f.mem.delivery("second-recall"), undefined);
});

test("concurrent hourly quota is shared across chats and persists across contexts", async (t) => {
  const f = setup(t, { recallMaxPerHour: 1 });
  const one = await sent(f, "one");
  const other = context(f.runtime, "agent-0", "group:20001");
  const two = await sent(f, "two", other);
  const results = await Promise.allSettled([
    recall(f, one.recordId, "recall-one"),
    recall(f, two.recordId, "recall-two", other),
  ]);
  assert.deepEqual(
    results.map((r) => r.status),
    ["fulfilled", "rejected"],
  );
  assert.match(results[1].reason.message, /RECALL_RATE_LIMITED/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.mem.delivery("recall-two"), undefined);
});

test("simultaneous different IDs for one target cannot bypass recall fencing", async (t) => {
  const f = setup(t),
    original = await sent(f);
  const results = await Promise.allSettled([
    recall(f, original.recordId, "a"),
    recall(f, original.messageId, "b"),
  ]);
  assert.deepEqual(
    results.map((r) => r.status),
    ["fulfilled", "rejected"],
  );
  assert.match(results[1].reason.message, /RECALL_ALREADY_ATTEMPTED/);
  assert.equal(f.calls.length, 1);
});

for (const [label, error, expected] of [
  ["timeout", Error("TimeoutError"), "unknown"],
  [
    "gateway timeout",
    Object.assign(Error("ONEBOT_REJECTED"), { reason: "GATEWAY_TIMEOUT" }),
    "unknown",
  ],
  ["refusal", Error("ONEBOT_REJECTED"), "failed"],
  [
    "unsupported",
    Object.assign(Error("ONEBOT_REJECTED"), { reason: "ACTION_UNSUPPORTED" }),
    "failed",
  ],
])
  test(`${label} consumes action budget and never permits replay or marks the original recalled`, async (t) => {
    const f = setup(t),
      original = await sent(f);
    let calls = 0;
    f.transport.recall = async () => {
      calls++;
      throw error;
    };
    await assert.rejects(
      recall(f, original.recordId),
      label === "unsupported"
        ? /RECALL_UNSUPPORTED/
        : new RegExp("DELIVERY_" + expected.toUpperCase()),
    );
    assert.equal(f.mem.delivery("recall").status, expected);
    assert.deepEqual(f.mem.recallAnnotation(original.recordId), {});
    await assert.rejects(
      recall(f, original.recordId),
      new RegExp("DELIVERY_ALREADY_ATTEMPTED_" + expected.toUpperCase()),
    );
    await assert.rejects(
      recall(f, original.recordId, "retry"),
      /RECALL_ALREADY_ATTEMPTED/,
    );
    assert.equal(calls, 1);
  });

test("disabled discovery/execution, pause, silence, isolation and removed allowlist refuse without an action attempt", async (t) => {
  const f = setup(t),
    original = await sent(f),
    agent = f.runtime.agent("agent-0");
  agent.behavior.actions.recall = false;
  assert.equal(toolAvailable(agent, "qq_recall", f.ctx.conversation), false);
  await assert.rejects(recall(f, original.recordId), /TOOL_DISABLED/);
  agent.behavior.actions.recall = true;
  agent.paused = true;
  await assert.rejects(recall(f, original.recordId), /PAUSED|NOT_ALLOWED/);
  agent.paused = false;
  f.mem.setState(f.ctx.conversation, {
    ...f.mem.state(f.ctx.conversation),
    silenceUntil: Date.now() + 60000,
  });
  await assert.rejects(
    recall(f, original.recordId),
    /CONVERSATION_SILENCED|PAUSED/,
  );
  f.mem.setState(f.ctx.conversation, {
    ...f.mem.state(f.ctx.conversation),
    silenceUntil: 0,
  });
  f.runtime.config.mode = "isolated";
  await assert.rejects(
    recall(f, original.recordId),
    /PAUSED|NOT_ALLOWED|ISOLATED/,
  );
  f.runtime.config.mode = "live";
  agent.allow.groups = [];
  await assert.rejects(recall(f, original.recordId), /PAUSED|NOT_ALLOWED/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.mem.delivery("recall"), undefined);
});

test("recall consumes ordinary send rate limits but does not release text batch", async (t) => {
  const f = setup(t),
    original = await sent(f);
  f.runtime.agent("agent-0").behavior.maxSendPerMinute = 1;
  await assert.rejects(recall(f, original.recordId), /SEND_RATE_LIMIT/);
  assert.equal(f.mem.delivery("recall"), undefined);
});

test("transport sends delete_msg once and never interprets timeout as refusal", async () => {
  const calls = [];
  const transport = new OneBot({
    httpUrl: "http://127.0.0.1:9",
    accountId: "10000",
  });
  transport.call = async (action, args) => {
    calls.push([action, args]);
  };
  assert.deepEqual(await transport.recall("40000"), { confirmed: true });
  assert.deepEqual(calls, [["delete_msg", { message_id: "40000" }]]);
});

test("all recall failure codes leave the process unchanged", () => {
  for (const code of [
    "RECALL_NOT_OWN",
    "RECALL_TOO_LATE",
    "RECALL_NOT_SENT",
    "RECALL_RATE_LIMITED",
    "RECALL_UNSUPPORTED",
    "RECALL_ALREADY_ATTEMPTED",
  ])
    assert.equal(classifyError(Error(code)).code, code);
});

test("delete_msg unsupported responses are sanitized while gateway timeouts keep ambiguity", async () => {
  for (const [response, reason] of [
    [
      { status: "failed", retcode: 1404, message: "unsupported" },
      "ACTION_UNSUPPORTED",
    ],
    [
      { status: "failed", retcode: 1200, wording: "Timeout: NTEvent" },
      "GATEWAY_TIMEOUT",
    ],
    [{ status: "failed", retcode: 1200, wording: "refused" }, undefined],
  ]) {
    const transport = new OneBot(
      { httpUrl: "http://127.0.0.1:9" },
      { fetchImpl: async () => new Response(JSON.stringify(response)) },
    );
    await assert.rejects(
      transport.recall("40000"),
      (error) => error.message === "ONEBOT_REJECTED" && error.reason === reason,
    );
  }
});

test("an already shown person card is presented once again when its source is recalled", async (t) => {
  const f = setup(t),
    original = await sent(f);
  f.mem.identity.savePersonCard(
    { personId: "30000", body: "谈话印象", evidence: [original.recordId] },
    { author: "agent", now: Date.now() },
  );
  const conversation = "private:30000";
  const first = personCardsForTurn(f.mem, conversation, [], {
    fresh: false,
    accountId: "10000",
  });
  assert.equal(first.cards.length, 1);
  f.mem.setState(conversation, { personCardsShown: first.shown });
  assert.equal(
    personCardsForTurn(f.mem, conversation, [], {
      fresh: false,
      accountId: "10000",
    }).cards.length,
    0,
  );
  await recall(f, original.recordId);
  const next = personCardsForTurn(f.mem, conversation, [], {
    fresh: false,
    accountId: "10000",
  });
  assert.equal(next.cards.length, 1);
  assert.equal(next.cards[0].recalledEvidence[0].id, original.recordId);
  const receipt = await f.runtime.callTool(f.ctx, "qq_send", {
    requestId: "after-recall",
    text: "说明",
    atUserId: "30000",
  });
  assert.equal(receipt.personCard.recalledEvidence[0].id, original.recordId);
  f.mem.setState(conversation, { personCardsShown: next.shown });
  assert.equal(
    personCardsForTurn(f.mem, conversation, [], {
      fresh: false,
      accountId: "10000",
    }).cards.length,
    0,
  );
});

test("queued action uses a newly lowered hourly recall policy", async (t) => {
  const f = setup(t, { recallMaxPerHour: 2 });
  const one = await sent(f, "one"),
    two = await sent(f, "two");
  let release;
  f.transport.recall = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const first = recall(f, one.recordId, "first");
  await new Promise((resolve) => setImmediate(resolve));
  const second = recall(f, two.recordId, "second");
  f.runtime.agent("agent-0").behavior.actions.recallMaxPerHour = 1;
  release({ confirmed: true });
  await first;
  await assert.rejects(second, /RECALL_RATE_LIMITED/);
  assert.equal(f.mem.delivery("second"), undefined);
});
