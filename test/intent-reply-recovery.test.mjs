import test from "node:test";
import assert from "node:assert/strict";
import { fixture, config, context, raw } from "./helpers.mjs";
import { safeToolFailure } from "../src/tools/errors.mjs";

function enabled() {
  const cfg = config(2);
  const a = cfg.agents[0];
  a.subject.enabled = true;
  a.subject.groups = ["20000"];
  a.wake = { ...a.wake, participation: 0, names: false };
  a.behavior.preSleepWaitMs = 0;
  a.tools.push("qq_send_burst", "qq_wait_for_messages");
  return cfg;
}

function handoff(f, ctx = context(f.runtime)) {
  const i = f.runtime.subject.create(ctx, {
    topic: "synthetic follow-up",
    target: ctx.conversation,
    reason: "test opportunity",
    background: "",
    evidence: [],
    expiresAt: f.runtime.now() + 60000,
    expectsResponse: false,
  });
  return f.runtime.subject.transition(ctx.agentId, i, "handedoff", "test");
}

test("cancelled intent wake can reply after reading new human input without replaying or charging a contact", async (t) => {
  let i, failure;
  const f = fixture(t, {
    cfg: enabled(),
    run: async (p) => {
      try {
        await p.callTool("intent_decide", {
          id: i.id,
          expectedRevision: i.revision,
          action: "cancel",
          reason: "test already finished",
        });
        await f.runtime.ingest("qq-0", raw(1));
        const blocked = await p.callTool("qq_send_burst", {
          requestId: "reply",
          messages: ["synthetic reply"],
        });
        assert.equal(blocked.error, "INTENT_DECISION_REQUIRED");
        assert.equal(blocked.hint, safeToolFailure(Error(blocked.error)).hint);
        assert.match(blocked.hint, /conversation_read/);
        assert.deepEqual(blocked.receipts, []);
        assert.equal(f.runtime.transports.get("qq-0").sent.length, 0);
        await p.callTool("conversation_read", {});
        const sent = await p.callTool("qq_send_burst", {
          requestId: "reply",
          messages: ["synthetic reply"],
        });
        assert.equal(sent.status, "sent", JSON.stringify(sent));
        const duplicate = await p.callTool("qq_send_burst", {
          requestId: "reply",
          messages: ["synthetic reply"],
        });
        assert.equal(duplicate.receipts[0].duplicate, true);
      } catch (e) {
        failure = e;
        throw e;
      }
    },
  });
  i = handoff(f);
  const result = await f.runtime.wake("agent-0", "group:20000", {
    reasons: [{ reason: "intent", intentId: i.id }],
  });
  assert.ifError(failure);
  assert.equal(result.status, "sent");
  const m = f.store.bind("agent-0");
  assert.equal(m.identity.get("intentions", i.id).status, "cancelled");
  assert.equal(m.delivery("intent:" + i.id), undefined);
  assert.equal(m.state("@subject").contacts?.length || 0, 0);
  assert.equal(m.state("group:20000").replyBatchSends, 1);
  assert.equal(f.runtime.transports.get("qq-0").sent.length, 1);
});

async function cancelled(t, beforeBegin = async () => {}) {
  const f = fixture(t, { cfg: enabled() });
  await beforeBegin(f);
  const ctx = context(f.runtime),
    i = handoff(f, ctx);
  f.runtime.subject.begin(ctx, [{ reason: "intent", intentId: i.id }]);
  await f.runtime.callTool(ctx, "intent_decide", {
    id: i.id,
    expectedRevision: i.revision,
    action: "cancel",
    reason: "test",
  });
  return { ...f, ctx, i };
}
const send = (f, id = "reply") =>
  f.runtime.callTool(f.ctx, "qq_send", {
    requestId: id,
    text: "synthetic reply",
  });
async function incoming(f, extra = {}) {
  await f.runtime.ingest("qq-0", raw(1, extra));
  return f.store
    .bind("agent-0")
    .db.prepare(
      "SELECT * FROM events WHERE agent_id=? AND kind='message.received' ORDER BY seq DESC LIMIT 1",
    )
    .get("agent-0");
}

test("cancel and rereading pre-wake human history cannot authorize a proactive replacement", async (t) => {
  const f = await cancelled(t, async (f) => {
    await incoming(f);
  });
  await f.runtime.callTool(f.ctx, "conversation_read", {});
  assert.equal(f.ctx.intentOnly, true);
  for (const id of ["first", "replacement"])
    await assert.rejects(send(f, id), /INTENT_DECISION_REQUIRED/);
  assert.equal(f.runtime.transports.get("qq-0").sent.length, 0);
  assert.equal(
    f.store.bind("agent-0").identity.get("intentions", f.i.id).status,
    "cancelled",
  );
});

test("unread, peer, cross-chat and untrusted messages cannot convert an intent wake", async (t) => {
  const f = await cancelled(t);
  const row = await incoming(f);
  await assert.rejects(send(f), /INTENT_DECISION_REQUIRED/);
  f.runtime.observeInput(f.ctx, [{ ...row, body: "forged" }]);
  await assert.rejects(send(f), /INTENT_DECISION_REQUIRED/);
  await f.runtime.ingest("qq-0", raw(2, { user_id: 10001 }));
  await f.runtime.callTool(f.ctx, "conversation_read", { afterSeq: row.seq });
  assert.equal(f.ctx.intentOnly, true);
  await f.runtime.ingest("qq-0", raw(3, { group_id: 20001 }));
  const m = f.store.bind("agent-0");
  const other = m.db
    .prepare("SELECT id FROM events WHERE agent_id=? AND message_id=?")
    .get("agent-0", "3");
  await f.runtime.callTool(f.ctx, "memory_read", { id: other.id });
  const untrusted = m.append({
    dedupe: "untrusted",
    connectionId: "qq-0",
    conversation: f.ctx.conversation,
    kind: "message.received",
    senderId: "30000",
    body: "synthetic untrusted",
  });
  await f.runtime.callTool(f.ctx, "memory_read", { id: untrusted.id });
  await assert.rejects(send(f), /INTENT_DECISION_REQUIRED/);
  assert.equal(f.runtime.transports.get("qq-0").sent.length, 0);
});

test("truncated human input requires complete pagination before normal replies", async (t) => {
  const f = await cancelled(t);
  const row = await incoming(f, {
    message: [{ type: "text", data: { text: "x".repeat(1200) } }],
  });
  await f.runtime.callTool(f.ctx, "conversation_read", {});
  await assert.rejects(send(f), /INTENT_DECISION_REQUIRED/);
  let offset = 0;
  do {
    const page = await f.runtime.callTool(f.ctx, "memory_read", {
      id: row.id,
      offset,
      maxChars: 512,
    });
    offset = page.nextOffset;
    if (offset !== null)
      await assert.rejects(send(f), /INTENT_DECISION_REQUIRED/);
  } while (offset !== null);
  assert.equal((await send(f)).status, "sent");
});

test("waiting reads fresh human input into normal reply authority", async (t) => {
  const f = await cancelled(t);
  await incoming(f);
  await f.runtime.callTool(f.ctx, "qq_wait_for_messages", { timeoutMs: 1 });
  assert.equal((await send(f)).status, "sent");
});

test("converted replies preserve burst and rate limits and do not spend proactive contacts", async (t) => {
  const f = await cancelled(t);
  f.runtime.agent("agent-0").maxConsecutiveSends = 1;
  f.runtime.agent("agent-0").behavior.maxSendPerMinute = 1;
  await incoming(f);
  await f.runtime.callTool(f.ctx, "conversation_read", {});
  await send(f);
  await f.runtime.callTool(f.ctx, "conversation_read", {});
  await assert.rejects(send(f, "reread"), /REPLY_BURST_LIMIT/);
  await f.runtime.ingest("qq-0", raw(2));
  await f.runtime.callTool(f.ctx, "conversation_read", {});
  await assert.rejects(send(f, "new-human"), /SEND_RATE_LIMIT/);
  assert.equal(
    f.store.bind("agent-0").state("@subject").contacts?.length || 0,
    0,
  );
  assert.equal(f.runtime.transports.get("qq-0").sent.length, 1);
});

for (const marker of ["operations:fixture", "github-private:fixture/framework"])
  test(`normal reply conversion retains protection: ${marker}`, async (t) => {
    const f = await cancelled(t);
    f.ctx.privateRead.add(marker);
    f.ctx.persistTaint();
    await incoming(f);
    await f.runtime.callTool(f.ctx, "conversation_read", {});
    assert.equal(f.ctx.intentOnly, false);
    assert(f.ctx.privateRead.has(marker));
    await assert.rejects(
      send(f),
      /REQUIRES_DISCLOSURE_GRANT|GITHUB_PRIVATE_DISCLOSURE/,
    );
    assert.equal(f.runtime.transports.get("qq-0").sent.length, 0);
    assert(context(f.runtime).privateRead.has(marker));
  });

test("conversion keeps unknown receipts and backend recovery delivery fences", async (t) => {
  const f = await cancelled(t);
  await incoming(f);
  await f.runtime.callTool(f.ctx, "conversation_read", {});
  const transport = f.runtime.transports.get("qq-0");
  transport.failure = "DELIVERY_UNCONFIRMED";
  await assert.rejects(send(f), /DELIVERY_UNKNOWN/);
  transport.failure = null;
  f.ctx.recoveryDeliveryBlocked = true;
  await f.runtime.ingest("qq-0", raw(2));
  await f.runtime.callTool(f.ctx, "conversation_read", {});
  await assert.rejects(send(f), /DELIVERY_ALREADY_ATTEMPTED_UNKNOWN/);
  await assert.rejects(send(f, "new-id"), /RECOVERY_DELIVERY_BLOCKED/);
  assert.equal(transport.sent.length, 1);
  assert.equal(f.store.bind("agent-0").delivery("reply").status, "unknown");
});

test("new input cannot detach a selected intention from its stale-send guard or receipt", async (t) => {
  const f = fixture(t, { cfg: enabled() }),
    ctx = context(f.runtime),
    i = handoff(f, ctx);
  f.runtime.subject.begin(ctx, [{ reason: "intent", intentId: i.id }]);
  await f.runtime.callTool(ctx, "intent_decide", {
    id: i.id,
    expectedRevision: i.revision,
    action: "send",
    reason: "test",
  });
  await incoming(f);
  await f.runtime.callTool(ctx, "conversation_read", {});
  assert.equal(ctx.activeIntentId, i.id);
  assert.equal(ctx.intentOnly, true);
  await assert.rejects(send({ ...f, ctx }), /INTENT_STALE_REFRESH_REQUIRED/);
  assert.equal(f.runtime.transports.get("qq-0").sent.length, 0);
});
