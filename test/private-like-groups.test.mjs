import test from "node:test";
import assert from "node:assert/strict";
import { fixture, config, context, raw } from "./helpers.mjs";
import { allowed, allowedGroups, validateConfig } from "../src/core/config.mjs";
import { readiness } from "../src/core/readiness.mjs";
import { humanInput, observeInput } from "../src/core/input-progress.mjs";
import { turnEnvironment } from "../src/core/prompts.mjs";

function setup(t, privateLike = true) {
  const cfg = config(3);
  cfg.privateLikeGroups = privateLike ? ["20002"] : [];
  cfg.peerLimit = { maxMessages: 2, cooldownMs: 1000 };
  for (const a of cfg.agents) {
    if (!privateLike) a.allow.groups.push("20002");
    a.wake = {
      ...a.wake,
      private: false,
      names: false,
      mentions: false,
      participation: 0,
    };
    a.maxConsecutiveSends = 3;
  }
  const f = fixture(t, { cfg });
  let now = Date.parse("2026-10-30T00:00:00Z"),
    serial = 0;
  f.runtime.clock = () => new Date(now);
  const ctx = context(f.runtime, "agent-0", "group:20002");
  const incoming = async (
    sender = 10001,
    { read = true, group = 20002 } = {},
  ) => {
    const id = ++serial;
    await f.runtime.ingest(
      "qq-0",
      raw(id, { group_id: group, user_id: sender }),
    );
    const row = f.store.db
      .prepare("SELECT * FROM events WHERE agent_id=? AND message_id=?")
      .get("agent-0", String(id));
    f.store.db
      .prepare("UPDATE events SET observed_at=? WHERE id=?")
      .run(new Date(now).toISOString(), row.id);
    if (read)
      await f.runtime.callTool(ctx, "conversation_read", {
        afterSeq: row.seq - 1,
      });
    return row;
  };
  return {
    ...f,
    ctx,
    incoming,
    advance: (ms = 2000) => {
      now += ms;
    },
    send: (id, target = ctx) =>
      f.runtime.send(target, { requestId: id, text: "synthetic reply" }),
  };
}

test("private-like groups default off and grant only group admission to all roles", () => {
  const cfg = config(2);
  delete cfg.privateLikeGroups;
  assert.deepEqual(validateConfig(cfg).privateLikeGroups, []);
  cfg.privateLikeGroups = ["20002", "20000"];
  for (const a of cfg.agents) {
    assert.equal(allowed(a, "group:20002", cfg), true);
    assert.equal(allowed(a, "private:20002", cfg), false);
    assert.equal(allowed(a, "group:20003", cfg), false);
    assert.deepEqual(allowedGroups(a, cfg), ["20000", "20001", "20002"]);
    a.allow = { groups: [], users: [] };
  }
  const ready = readiness(cfg, {});
  for (const a of ready.agents)
    assert.equal(a.steps.find((s) => s.id === "whitelist").done, true);
  cfg.privateLikeGroups = ["not-a-group"];
  assert.throws(() => validateConfig(cfg));
});

test("listed groups use private wakes and bypass ordinary peer throttling without treating group input as directly addressed", async (t) => {
  const f = setup(t),
    a = f.runtime.agent("agent-0");
  a.wake.private = true;
  a.wake.peers = false;
  f.runtime.config.peerLimit.maxMessages = 1;
  const wakes = [];
  t.mock.method(f.runtime.conversations, "request", (...args) =>
    wakes.push(args),
  );
  for (let i = 0; i < 8; i++)
    await f.incoming(i % 2 ? 10001 : 10002, { read: false });
  assert.equal(wakes.length, 8);
  assert(wakes.every((w) => w[2] === "private" && w[3].addressed === false));
  await f.incoming(30000, { read: false });
  assert.equal(wakes.length, 9);
  await f.incoming(10001, { read: false, group: 20000 });
  assert.equal(wakes.length, 9);
  a.wake.private = false;
  await f.incoming(30000, { read: false });
  assert.equal(wakes.length, 9);
  a.wake.mentions = true;
  await f.runtime.ingest(
    "qq-0",
    raw(50, {
      group_id: 20002,
      message: [{ type: "at", data: { qq: "10000" } }],
    }),
  );
  assert.equal(wakes.at(-1)[2], "mention");
});

test("all group peers share a bounded batch and cannot turn old input, waiting or a replacement context into new credit", async (t) => {
  const f = setup(t);
  const first = await f.incoming();
  await f.send("one");
  await f.send("two");
  await assert.rejects(f.send("three"), /REPLY_BURST_LIMIT/);
  await f.incoming(10002);
  await assert.rejects(f.send("other-peer"), /REPLY_BURST_LIMIT/);
  f.advance();
  await f.runtime.callTool(f.ctx, "conversation_read", {});
  await assert.rejects(f.send("reread"), /REPLY_BURST_LIMIT/);
  const next = context(f.runtime, "agent-0", f.ctx.conversation);
  await assert.rejects(f.send("context", next), /REPLY_BURST_LIMIT/);
  const fresh = await f.incoming(10002, { read: false });
  await assert.rejects(f.send("unread"), /REPLY_BURST_LIMIT/);
  await f.runtime.callTool(f.ctx, "conversation_read", {
    afterSeq: fresh.seq - 1,
  });
  await f.send("renewed");
  await f.send("renewed-two");
  await assert.rejects(f.send("renewed-three"), /REPLY_BURST_LIMIT/);
  assert.equal(humanInput(f.runtime, f.ctx, first.id), null);
  assert.equal(humanInput(f.runtime, f.ctx, fresh.id), null);
  assert.equal(f.ctx.requestEvents.size, 0);
});

test("human input keeps ordinary reply limits and older peers cannot replace human reply authority", async (t) => {
  const f = setup(t);
  await f.incoming();
  await f.send("peer-one");
  await f.send("peer-two");
  const human = await f.incoming(30000);
  assert.equal(f.ctx.requestEvents.has(human.id), true);
  await f.send("human-one");
  await f.send("human-two");
  await f.send("human-three");
  await assert.rejects(f.send("human-four"), /REPLY_BURST_LIMIT/);
  f.advance();
  await f.runtime.callTool(f.ctx, "conversation_read", {});
  await assert.rejects(f.send("old-peer"), /REPLY_BURST_LIMIT/);
});

test("truncated, recalled and cross-group peer input does not refill a listed group's batch", async (t) => {
  const f = setup(t);
  await f.incoming();
  await f.send("one");
  await f.send("two");
  f.advance();
  const peer = await f.incoming(10001, { read: false });
  observeInput(f.runtime, f.ctx, [
    {
      id: peer.id,
      seq: peer.seq,
      conversation: peer.conversation,
      body: peer.body,
      bodyTruncated: true,
    },
  ]);
  await assert.rejects(f.send("truncated"), /REPLY_BURST_LIMIT/);
  await f.runtime.ingest(
    "qq-0",
    raw(Number(peer.message_id), {
      group_id: 20002,
      user_id: 10001,
      post_type: "notice",
      notice_type: "group_recall",
    }),
  );
  await f.runtime.callTool(f.ctx, "conversation_read", {});
  await assert.rejects(f.send("recalled"), /REPLY_BURST_LIMIT/);
  const other = await f.incoming(10002, { read: false, group: 20000 });
  observeInput(f.runtime, f.ctx, [
    {
      id: other.id,
      seq: other.seq,
      conversation: other.conversation,
      body: other.body,
    },
  ]);
  await assert.rejects(f.send("other-group"), /REPLY_BURST_LIMIT/);
});

test("private-like groups keep send rate limits, silence and pause controls", async (t) => {
  const f = setup(t),
    a = f.runtime.agent("agent-0");
  a.behavior.maxSendPerMinute = 1;
  await f.incoming();
  await f.send("first");
  await assert.rejects(f.send("rate"), /SEND_RATE_LIMIT/);
  const mem = f.store.bind(a.id);
  mem.setState(f.ctx.conversation, {
    ...mem.state(f.ctx.conversation),
    paused: true,
  });
  await assert.rejects(f.send("paused"), /AGENT_PAUSED_OR_EXPIRED/);
  mem.setState(f.ctx.conversation, {
    ...mem.state(f.ctx.conversation),
    paused: false,
    silenceUntil: f.runtime.now() + 10000,
  });
  await assert.rejects(f.send("silent"), /AGENT_PAUSED_OR_EXPIRED/);
});

test("group mode does not grant owner commands, scheduling authority or proactive contact permission", async (t) => {
  const f = setup(t),
    a = f.runtime.agent("agent-0");
  a.ownerIds = ["30000"];
  const calls = t.mock.method(f.runtime.operations, "command", () => {
    throw Error("OWNER_COMMAND_MUST_NOT_RUN");
  });
  await f.incoming(30000);
  assert.equal(calls.mock.callCount(), 0);
  assert.equal(f.runtime.subject.targetAllowed(a, f.ctx.conversation), false);
  a.subject.groups = ["20002"];
  assert.equal(f.runtime.subject.targetAllowed(a, f.ctx.conversation), true);
  assert(
    f.runtime.subject
      .reachableTargets(a)
      .some((x) => x.target === f.ctx.conversation),
  );
  const next = structuredClone(f.runtime.config);
  next.privateLikeGroups = [];
  await f.runtime.changeConfig(next, f.configStore.revision);
  assert.equal(
    f.runtime.subject.targetAllowed(f.runtime.agent(a.id), f.ctx.conversation),
    false,
  );
  await assert.rejects(f.send("removed"), /AGENT_PAUSED_OR_EXPIRED/);
});

test("hot changes preserve active contexts, sessions and budgets, and discard only changed groups' ordinary queued wakes", async (t) => {
  const f = setup(t),
    mem = f.store.bind("agent-0");
  const session = { id: "synthetic-preserved-session", backend: "codex" };
  mem.setState(f.ctx.conversation, {
    ...mem.state(f.ctx.conversation),
    session,
    replyBatchSends: 2,
    pendingWakes: [
      { reason: "private", seq: 1 },
      { reason: "scheduled", taskRunId: "task" },
    ],
    wakeDueAt: f.runtime.now() + 10000,
  });
  const transport = f.runtime.transports.get("qq-0");
  const hash = f.runtime.contexts.instructionContract(
    f.runtime.agent("agent-0"),
    f.ctx.conversation,
    mem.identity.current(),
    f.ctx.allowedTools,
  ).instructionsHash;
  const next = structuredClone(f.runtime.config);
  next.privateLikeGroups = ["20000"];
  const result = await f.runtime.changeConfig(next, f.configStore.revision);
  assert.deepEqual(result.affectedAgents, []);
  assert.equal(result.reconnectRequired, false);
  assert.equal(f.ctx.controller.signal.aborted, false);
  assert.equal(f.runtime.transports.get("qq-0"), transport);
  const state = mem.state(f.ctx.conversation);
  assert.deepEqual(state.session, session);
  assert.equal(state.replyBatchSends, 2);
  assert.deepEqual(state.pendingWakes, [
    { reason: "scheduled", taskRunId: "task" },
  ]);
  assert.equal(
    f.runtime.contexts.instructionContract(
      f.runtime.agent("agent-0"),
      f.ctx.conversation,
      mem.identity.current(),
      f.ctx.allowedTools,
    ).instructionsHash,
    hash,
  );
  assert.match(
    turnEnvironment(f.runtime, f.runtime.agent("agent-0"), f.ctx, "codex"),
    /普通群聊/,
  );
  next.privateLikeGroups.push("20002");
  await f.runtime.changeConfig(next, f.configStore.revision);
  assert.match(
    turnEnvironment(f.runtime, f.runtime.agent("agent-0"), f.ctx, "codex"),
    /私聊模式群/,
  );
  assert.equal(mem.state(f.ctx.conversation).replyBatchSends, 2);
});

test("enabling private-like mode cannot recycle peer messages already received under ordinary group policy", async (t) => {
  const f = setup(t, false);
  await f.incoming();
  for (const id of ["one", "two", "three"]) await f.send(id);
  f.advance();
  await f.incoming();
  // Also leave a newer message unread: changing policy must not turn old arrivals into new credit.
  await f.incoming(10002, { read: false });
  await assert.rejects(f.send("ordinary"), /REPLY_BURST_LIMIT/);
  const next = structuredClone(f.runtime.config);
  next.privateLikeGroups = ["20002"];
  await f.runtime.changeConfig(next, f.configStore.revision);
  await f.runtime.callTool(f.ctx, "conversation_read", {});
  await assert.rejects(f.send("recycled"), /REPLY_BURST_LIMIT/);
  await f.incoming(10002);
  await f.send("new-after-switch");
});
