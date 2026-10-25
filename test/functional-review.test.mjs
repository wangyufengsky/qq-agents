import test from "node:test";
import assert from "node:assert/strict";
import { config, fixture, raw, context, settle } from "./helpers.mjs";

const poke = (target) => ({
  post_type: "notice",
  notice_type: "notify",
  sub_type: "poke",
  self_id: 10000,
  group_id: 20000,
  user_id: 30000,
  target_id: target,
  time: 1800000000,
});
const quiet = () => {
  const cfg = config(1);
  cfg.agents[0].wake.participation = 0;
  return cfg;
};

test("a dropped transport is replaced on connect instead of blocking reconnection", async (t) => {
  const f = fixture(t, { cfg: config(1) }),
    stale = f.runtime.transports.get("qq-0");
  stale.connected = false;
  assert.deepEqual(await f.runtime.startConnection("qq-0"), {
    connected: true,
  });
  assert.notEqual(f.runtime.transports.get("qq-0"), stale);
  assert.equal(f.runtime.transports.get("qq-0").connected, true);
  await assert.rejects(
    f.runtime.startConnection("qq-0"),
    /CONNECTION_ALREADY_STARTED/,
  );
});

test("a second connect while one is in progress is rejected without discarding it", async (t) => {
  const f = fixture(t, { cfg: config(1) });
  f.runtime.transports.delete("qq-0");
  let release;
  f.runtime.transportFactory = () => {
    const t = { connected: false, on() {}, close() {} };
    t.connect = () =>
      new Promise((r) => {
        release = () => {
          t.connected = true;
          r();
        };
      });
    return t;
  };
  const first = f.runtime.startConnection("qq-0");
  await assert.rejects(
    f.runtime.startConnection("qq-0"),
    /CONNECTION_IN_PROGRESS/,
  );
  release();
  await first;
  assert.equal(f.runtime.transports.get("qq-0").connected, true);
});

test("a poke between other members is archived but does not wake the agent", async (t) => {
  let runs = 0;
  const f = fixture(t, { cfg: quiet(), run: async () => void runs++ });
  await f.runtime.ingest("qq-0", poke(30001));
  await settle(f.runtime);
  assert.equal(runs, 0);
  assert.equal(
    f.store.bind("agent-0").search({ kind: "notice.poke" }).items.length,
    1,
  );
  await f.runtime.ingest("qq-0", { ...poke(10000), time: 1800000001 });
  await settle(f.runtime);
  assert.equal(runs, 1);
});

test("the gateway echo of a confirmed send is not archived as a second message", async (t) => {
  const f = fixture(t, { cfg: config(1) }),
    r = await f.runtime.send(context(f.runtime), {
      requestId: "echo-after",
      text: "你好",
    });
  const before = f.store.bind("agent-0").state("group:20000").lastReceivedSeq;
  const result = await f.runtime.ingest(
    "qq-0",
    raw(Number(r.messageId), { post_type: "message_sent", user_id: 10000 }),
  );
  assert.equal(result[0].ownEcho, true);
  const rows = f.store.db
    .prepare("SELECT kind FROM events WHERE message_id=?")
    .all(r.messageId);
  assert.deepEqual(
    rows.map((x) => x.kind),
    ["message.sent"],
  );
  assert.equal(
    f.store.bind("agent-0").state("group:20000").lastReceivedSeq,
    before,
  );
});

test("an echo that arrives before the send receipt waits and is still deduplicated", async (t) => {
  const f = fixture(t, { cfg: config(1) }),
    transport = f.runtime.transports.get("qq-0");
  let echo;
  transport.send = async () => {
    // The websocket echo lands on a later tick, while the HTTP receipt is still pending.
    echo = new Promise((r) => setTimeout(r, 5)).then(() =>
      f.runtime.ingest(
        "qq-0",
        raw(50001, { post_type: "message_sent", user_id: 10000 }),
      ),
    );
    await new Promise((r) => setTimeout(r, 20));
    return { messageId: "50001" };
  };
  await f.runtime.send(context(f.runtime), {
    requestId: "echo-before",
    text: "抢先回显",
  });
  await echo;
  assert.equal(
    f.store.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE message_id='50001'")
      .get().n,
    1,
  );
});

test("a recall of the agent's own confirmed message is still archived", async (t) => {
  const f = fixture(t, { cfg: config(1) }),
    r = await f.runtime.send(context(f.runtime), {
      requestId: "recalled",
      text: "说错了",
    });
  const result = await f.runtime.ingest("qq-0", {
    post_type: "notice",
    notice_type: "group_recall",
    self_id: 10000,
    group_id: 20000,
    user_id: 10000,
    operator_id: 30000,
    message_id: Number(r.messageId),
    time: 1800000000,
  });
  assert.ok(!result.some((x) => x.ownEcho));
  assert.deepEqual(
    f.store.db
      .prepare("SELECT kind FROM events WHERE message_id=? ORDER BY seq")
      .all(r.messageId)
      .map((x) => x.kind),
    ["message.sent", "message.recalled"],
  );
});

test("a message typed manually on the bot account is still archived", async (t) => {
  const f = fixture(t, { cfg: config(1) });
  const result = await f.runtime.ingest(
    "qq-0",
    raw(60001, { post_type: "message_sent", user_id: 10000 }),
  );
  assert.equal(result.length, 0);
  assert.equal(
    f.store.db
      .prepare("SELECT direction FROM events WHERE message_id='60001'")
      .get().direction,
    "out",
  );
});

test("the turn that sets silence can finish bookkeeping but cannot send", async (t) => {
  const f = fixture(t, { cfg: config(1) }),
    ctx = context(f.runtime);
  await f.runtime.callTool(ctx, "qq_set_silence", { minutes: 30 });
  assert.deepEqual(
    await f.runtime.callTool(ctx, "qq_mark_read", { throughSeq: 0 }),
    { readThroughSeq: 0 },
  );
  await f.runtime.callTool(ctx, "diary_write", {
    title: "潜水",
    body: "先歇会",
  });
  await assert.rejects(
    f.runtime.callTool(ctx, "qq_send", { requestId: "quiet", text: "在吗" }),
    /CONVERSATION_SILENCED/,
  );
  assert.equal(f.store.bind("agent-0").delivery("quiet"), undefined);
  // Every other turn in the conversation still sees it as silenced.
  await assert.rejects(
    f.runtime.callTool(context(f.runtime), "qq_mark_read", { throughSeq: 0 }),
    /AGENT_PAUSED_OR_EXPIRED/,
  );
});
