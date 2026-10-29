import test from "node:test";
import assert from "node:assert/strict";
import { fixture, config, context, raw } from "./helpers.mjs";
import { humanInput } from "../src/core/input-progress.mjs";

function setup(t) {
  const cfg = config(2);
  const a = cfg.agents[0];
  a.allow.users.push("10001");
  a.wake = {
    ...a.wake,
    private: false,
    participation: 0,
    names: false,
    questions: false,
  };
  a.maxConsecutiveSends = 2;
  cfg.peerLimit = { maxMessages: 2, cooldownMs: 1000 };
  const f = fixture(t, { cfg });
  let now = Date.parse("2026-10-28T00:00:00Z"),
    serial = 0;
  f.runtime.clock = () => new Date(now);
  const ctx = context(f.runtime, "agent-0", "private:10001");
  const incoming = async (
    target = ctx,
    { read = true, body = "synthetic peer message" } = {},
  ) => {
    const id = ++serial;
    const message = raw(id, {
      message_type: "private",
      user_id: 10001,
      time: Math.floor(now / 1000),
      message: [{ type: "text", data: { text: body } }],
    });
    delete message.group_id;
    await f.runtime.ingest("qq-0", message);
    const row = f.store.db
      .prepare("SELECT * FROM events WHERE agent_id=? AND message_id=?")
      .get("agent-0", String(id));
    assert.equal(row.conversation, target.conversation);
    // The transport uses wall time; pin its local arrival timestamp to our test clock.
    f.store.db
      .prepare("UPDATE events SET observed_at=? WHERE id=?")
      .run(new Date(now).toISOString(), row.id);
    if (read)
      await f.runtime.callTool(target, "conversation_read", {
        afterSeq: row.seq - 1,
      });
    return row;
  };
  return {
    ...f,
    ctx,
    incoming,
    advance: (ms) => {
      now += ms;
    },
    send: (id, target = ctx) =>
      f.runtime.send(target, { requestId: id, text: "synthetic reply" }),
  };
}

test("private peers can resume a spent reply batch after cooldown and genuinely new fully read input", async (t) => {
  const f = setup(t);
  await f.incoming();
  await f.send("first");
  await f.send("second");
  await f.incoming();
  await assert.rejects(f.send("too-soon"), /REPLY_BURST_LIMIT/);
  f.advance(2000);
  await assert.rejects(f.send("time-alone"), /REPLY_BURST_LIMIT/);
  await f.runtime.callTool(f.ctx, "conversation_read", {});
  await assert.rejects(f.send("reread"), /REPLY_BURST_LIMIT/);
  const fresh = await f.incoming();
  await f.send("after-cooldown");
  await f.send("bounded-second");
  await assert.rejects(f.send("bounded-third"), /REPLY_BURST_LIMIT/);
  assert.equal(humanInput(f.runtime, f.ctx, fresh.id), null);
  assert.equal(f.ctx.requestEvents.size, 0);
});

test("replacing a context does not reset a peer batch, while later new input does", async (t) => {
  const f = setup(t);
  await f.incoming();
  await f.send("first");
  await f.send("second");
  f.advance(2000);
  const next = context(f.runtime, "agent-0", f.ctx.conversation);
  await f.runtime.callTool(next, "conversation_read", {});
  await assert.rejects(f.send("new-context", next), /REPLY_BURST_LIMIT/);
  await f.incoming(next);
  await f.send("fresh-context-input", next);
});

test("a real friend recall cannot renew a spent peer reply batch", async (t) => {
  const f = setup(t);
  await f.incoming();
  await f.send("first");
  await f.send("second");
  f.advance(2000);
  const row = await f.incoming(f.ctx, { read: false });
  const notice = raw(Number(row.message_id), {
    post_type: "notice",
    notice_type: "friend_recall",
    message_type: "private",
    user_id: 10001,
  });
  delete notice.group_id;
  await f.runtime.ingest("qq-0", notice);
  assert.equal(
    f.store.db.prepare("SELECT status FROM events WHERE id=?").get(row.id)
      .status,
    "observed",
  );
  await f.runtime.callTool(f.ctx, "conversation_read", {
    afterSeq: row.seq - 1,
  });
  await assert.rejects(f.send("withdrawn-peer-input"), {
    message: "REPLY_BURST_LIMIT",
  });
});

test("real group and friend recalls remove human input authority only in the same connection and conversation", async (t) => {
  for (const privateChat of [false, true]) {
    const cfg = config(2);
    cfg.agents[0].wake.participation = 0;
    cfg.agents[0].wake.private = false;
    const f = fixture(t, { cfg });
    const message = raw(42, {
      message_type: privateChat ? "private" : "group",
    });
    if (privateChat) delete message.group_id;
    const conversation = privateChat ? "private:30000" : "group:20000";
    await f.runtime.ingest("qq-0", message);
    const row = f.store.db
      .prepare(
        "SELECT * FROM events WHERE agent_id='agent-0' AND message_id='42'",
      )
      .get();
    const ctx = context(f.runtime, "agent-0", conversation);
    assert.equal(humanInput(f.runtime, ctx, row.id)?.id, row.id);
    const notice = {
      ...message,
      post_type: "notice",
      notice_type: privateChat ? "friend_recall" : "group_recall",
    };
    await f.runtime.ingest("qq-1", { ...notice, self_id: 10001 });
    assert.equal(humanInput(f.runtime, ctx, row.id)?.id, row.id);
    await f.runtime.ingest("qq-0", notice);
    assert.equal(humanInput(f.runtime, ctx, row.id), null);
    await f.runtime.callTool(ctx, "conversation_read", {});
    assert.equal(ctx.requestEvents.has(row.id), false);
  }
});

async function opening(f, kind) {
  const send = (ctx) =>
    f.runtime.send(ctx, { requestId: "opening", text: "synthetic opening" });
  if (kind === "control")
    return f.runtime.withContext("agent-0", f.ctx.conversation, send);
  const ctx = context(f.runtime, "agent-0", f.ctx.conversation);
  if (kind === "scheduled") ctx.scheduleRunId = "synthetic-schedule";
  else {
    f.runtime.agent("agent-0").subject.enabled = true;
    f.runtime.agent("agent-0").subject.peers = true;
    const created = f.runtime.subject.create(ctx, {
      topic: "synthetic opening",
      target: ctx.conversation,
      reason: "test opportunity",
      background: "",
      evidence: [],
      expiresAt: f.runtime.now() + 60000,
      expectsResponse: true,
    });
    const handed = f.runtime.subject.transition(
      "agent-0",
      created,
      "handedoff",
      "test",
    );
    f.runtime.subject.begin(ctx, [{ reason: "intent", intentId: handed.id }]);
    f.runtime.subject.decide(ctx, {
      id: handed.id,
      expectedRevision: handed.revision,
      action: "send",
      reason: "test",
    });
  }
  return send(ctx);
}

for (const kind of ["control", "scheduled", "proactive"])
  test(`a ${kind} opening after cooldown lets a prompt peer reply renew a spent ordinary batch`, async (t) => {
    const f = setup(t);
    await f.incoming();
    await f.send("first");
    await f.send("second");
    f.advance(2000);
    await opening(f, kind);
    await assert.rejects(f.send("opening-alone"), /REPLY_BURST_LIMIT/);
    f.advance(100);
    const reply = await f.incoming(f.ctx, { read: false });
    await assert.rejects(f.send("unread-peer-answer"), /REPLY_BURST_LIMIT/);
    await f.runtime.callTool(f.ctx, "conversation_read", {
      afterSeq: reply.seq - 1,
    });
    await f.send("answer-prompt-peer-reply");
    await f.send("bounded-second-answer");
    await assert.rejects(f.send("bounded-third-answer"), /REPLY_BURST_LIMIT/);
    assert.equal(f.ctx.requestEvents.size, 0);
  });

for (const quiet of [false, true])
  test(`legacy peer timing survives a control opening ${quiet ? "after" : "during"} cooldown`, async (t) => {
    const f = setup(t),
      mem = f.store.bind("agent-0");
    await f.incoming();
    await f.send("first");
    await f.send("second");
    const state = mem.state(f.ctx.conversation);
    const previousAttempt = state.replyBatchLastAttemptAt;
    delete state.replyBatchLastAttemptAt;
    mem.setState(f.ctx.conversation, state);
    f.advance(quiet ? 2000 : 100);
    await opening(f, "control");
    assert.equal(
      mem.state(f.ctx.conversation).replyBatchLastAttemptAt,
      previousAttempt,
    );
    f.advance(100);
    await f.incoming();
    if (!quiet) {
      await assert.rejects(f.send("too-soon"), /REPLY_BURST_LIMIT/);
      f.advance(2000);
      await f.runtime.callTool(f.ctx, "conversation_read", {});
      await assert.rejects(
        f.send("reread-too-soon-input"),
        /REPLY_BURST_LIMIT/,
      );
      await f.incoming();
    }
    await f.send("new-peer-reply");
  });

test("messages received during cooldown cannot replenish the batch by being read later", async (t) => {
  const f = setup(t);
  await f.incoming();
  await f.send("first");
  await f.send("second");
  const early = await f.incoming(f.ctx, { read: false });
  f.advance(2000);
  await f.runtime.callTool(f.ctx, "conversation_read", {
    afterSeq: early.seq - 1,
  });
  await assert.rejects(f.send("late-read"), /REPLY_BURST_LIMIT/);
  const fresh = await f.incoming(f.ctx, { read: false });
  await assert.rejects(f.send("unread"), /REPLY_BURST_LIMIT/);
  await f.runtime.callTool(f.ctx, "conversation_read", {
    afterSeq: fresh.seq - 1,
  });
  await f.send("read-fresh");
});

test("truncated peer messages replenish only after all pages are actually read", async (t) => {
  const f = setup(t);
  await f.incoming();
  await f.send("first");
  await f.send("second");
  f.advance(2000);
  const long = await f.incoming(f.ctx, { body: "x".repeat(1200) });
  await assert.rejects(f.send("summary"), /REPLY_BURST_LIMIT/);
  let offset = 0,
    page;
  do {
    page = await f.runtime.callTool(f.ctx, "memory_read", {
      id: long.id,
      offset,
      maxChars: 512,
    });
    offset = page.nextOffset;
  } while (offset !== null);
  await f.send("fully-read");
});

test("imported, forged, recalled, wrong-sender and wrong-connection peer inputs cannot replenish", async (t) => {
  const f = setup(t);
  await f.incoming();
  await f.send("first");
  await f.send("second");
  f.advance(2000);
  const invalid = [
    ["origin", "imported"],
    ["payload", "{}"],
    ["status", "recalled"],
    ["sender_id", "10000"],
    ["connection_id", "qq-1"],
  ];
  for (const [i, [column, value]] of invalid.entries()) {
    const row = await f.incoming(f.ctx, { read: false });
    f.store.db
      .prepare(`UPDATE events SET ${column}=? WHERE id=?`)
      .run(value, row.id);
    await f.runtime.callTool(f.ctx, "conversation_read", {
      afterSeq: row.seq - 1,
    });
    await assert.rejects(f.send("invalid-" + i), /REPLY_BURST_LIMIT/);
  }
  const row = await f.incoming(f.ctx, { read: false });
  f.runtime.observeInput(f.ctx, [
    {
      id: row.id,
      seq: row.seq,
      conversation: f.ctx.conversation,
      body: "forged body",
    },
  ]);
  await assert.rejects(f.send("forged"), /REPLY_BURST_LIMIT/);
});

test("peer reads preserve intent and schedule authority and never become human requests", async (t) => {
  const f = setup(t);
  await f.incoming();
  await f.send("first");
  await f.send("second");
  f.advance(2000);
  f.ctx.intentOnly = true;
  f.ctx.intentSnapshotSeq = 0;
  await f.incoming();
  assert.equal(f.ctx.intentOnly, true);
  assert.equal(f.ctx.requestEvents.size, 0);
  assert.equal(
    f.store.bind("agent-0").state(f.ctx.conversation).replyBatchSends,
    2,
  );
  f.ctx.intentOnly = false;
  f.ctx.scheduleRunId = "synthetic-schedule";
  await f.incoming();
  assert.equal(f.ctx.scheduleRunId, "synthetic-schedule");
  assert.equal(
    f.store.bind("agent-0").state(f.ctx.conversation).replyBatchSends,
    2,
  );
});

test("peer batches obey the smaller peer limit and do not reset role send rate limits", async (t) => {
  const f = setup(t);
  f.runtime.agent("agent-0").maxConsecutiveSends = 5;
  f.runtime.agent("agent-0").behavior.maxSendPerMinute = 2;
  await f.incoming();
  await f.send("first");
  await f.send("second");
  await assert.rejects(f.send("peer-limit"), /REPLY_BURST_LIMIT/);
  f.advance(2000);
  await f.incoming();
  await assert.rejects(f.send("rate-limit"), /SEND_RATE_LIMIT/);
});

test("failed peer attempts consume budget and cooldown; confirmed retries stay idempotent", async (t) => {
  const f = setup(t);
  await f.incoming();
  await f.send("first");
  assert.equal((await f.send("first")).duplicate, true);
  f.runtime.transports.get("qq-0").failure = "TIMEOUT";
  await assert.rejects(f.send("unknown"), /DELIVERY_UNKNOWN/);
  await f.incoming();
  await assert.rejects(f.send("replacement"), /REPLY_BURST_LIMIT/);
  f.advance(2000);
  await f.incoming();
  await assert.rejects(f.send("unknown"), /ALREADY_ATTEMPTED/);
  f.runtime.transports.get("qq-0").failure = null;
  await f.send("fresh-reply");
});
