import test from "node:test";
import assert from "node:assert/strict";
import { config, fixture, raw, context, settle } from "./helpers.mjs";
import path from "node:path";
import { ExternalTools } from "../src/backends/external.mjs";
import { MemoryStore } from "../src/memory/store.mjs";
import { restoreExport } from "../src/memory/migrate.mjs";
import { temp } from "./helpers.mjs";

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

test("an external MCP server that exits is rediscovered on the next call", async (t) => {
  const external = new ExternalTools([
    {
      id: "crash",
      transport: "stdio",
      command: process.execPath,
      args: ["test/crash-mcp-fixture.mjs"],
      env: {},
      headers: {},
      allowedTools: ["echo_pid"],
    },
  ]);
  t.after(() => external.close());
  const first = (await external.call("crash", "echo_pid", {})).content[0].text;
  const deadline = Date.now() + 3000;
  while (external.clients.size && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 20));
  assert.equal(external.clients.size, 0, "dead client must be evicted");
  const second = (await external.call("crash", "echo_pid", {})).content[0].text;
  assert.notEqual(second, first);
});

const ownerPrivate = (id, text) =>
  raw(id, {
    message_type: "private",
    group_id: undefined,
    user_id: 30000,
    message: [{ type: "text", data: { text } }],
  });
const owned = () => {
  const cfg = config(1);
  cfg.agents[0].ownerIds = ["30000"];
  cfg.agents[0].operations.enabled = true;
  cfg.agents[0].scheduler.enabled = true;
  cfg.agents[0].paused = true;
  return cfg;
};

test("owner commands received while paused leave a record and wake on resume without replay", async (t) => {
  let runs = 0;
  const f = fixture(t, { cfg: owned(), run: async () => void runs++ });
  await f.runtime.ingest("qq-0", ownerPrivate(1, "/ops L1"));
  await f.runtime.ingest("qq-0", ownerPrivate(2, "/remind list"));
  const skipped = f.store.db
    .prepare(
      "SELECT json_extract(payload,'$.source') AS source FROM events WHERE kind='owner-command.skipped' ORDER BY seq",
    )
    .all()
    .map((x) => x.source);
  assert.deepEqual(skipped, ["operations", "scheduler"]);
  assert.equal(f.runtime.operations.pending.size, 0);
  assert.equal(f.runtime.transports.get("qq-0").sent.length, 0);
  await f.runtime.pause("agent-0", false);
  f.runtime.tick();
  await settle(f.runtime);
  assert.equal(runs, 1);
  // Resuming wakes the AI to explain; it never re-runs the elevation request.
  assert.equal(f.runtime.operations.pending.size, 0);
});

test("a paused owner message does not overwrite state changed while commands were checked", async (t) => {
  const f = fixture(t, { cfg: owned() }),
    mem = f.store.bind("agent-0");
  f.runtime.operations.command = async () => {
    mem.setState("private:30000", {
      ...mem.state("private:30000"),
      marker: "concurrent",
    });
    return false;
  };
  await f.runtime.ingest("qq-0", ownerPrivate(3, "随便聊聊"));
  const state = mem.state("private:30000");
  assert.equal(state.marker, "concurrent");
  assert.equal(state.pendingWake, true);
});

test("the narrowed tick still fires due reply checks and sleep timers", async (t) => {
  let runs = 0;
  const f = fixture(t, { cfg: quiet(), run: async () => void runs++ }),
    mem = f.store.bind("agent-0"),
    now = f.runtime.now();
  mem.setState("group:20000", { replyCheckAt: now - 1 });
  mem.setState("group:20001", {
    wakeConfig: { mode: "diving", sleepUntil: now - 1 },
  });
  mem.setState("private:30000", { lastReceivedSeq: 5 });
  f.runtime.tick();
  await settle(f.runtime);
  assert.equal(runs, 2);
  assert.equal(mem.state("group:20000").lastWakeReason, "replyCheck");
  assert.equal(mem.state("group:20001").lastWakeReason, "sleep");
});

test("equal-time messages keep arrival order, also after restore beside another identity", (t) => {
  const root = temp(t),
    source = new MemoryStore(path.join(root, "source.sqlite")),
    target = new MemoryStore(path.join(root, "target.sqlite"));
  t.after(() => {
    source.close();
    target.close();
  });
  const at = new Date(1800000000000).toISOString(),
    burst = (m, agent, bodies) =>
      bodies.map((body, i) =>
        m.bind(agent).append({
          dedupe: agent + ":" + body,
          connectionId: "qq-0",
          conversation: "group:20000",
          kind: "message.received",
          messageId: agent + "-" + i,
          senderId: "30000",
          body,
          occurredAt: at,
          payload: { timeKnown: true },
        }),
      );
  const bodies = ["一", "二", "三", "四", "五", "六"],
    ids = burst(source, "agent-0", bodies).map((x) => x.id);
  const order = (m) =>
    m
      .bind("agent-0")
      .conversation({ aroundId: ids[2], limit: 10 })
      .items.map((x) => x.body);
  assert.deepEqual(order(source), bodies);
  // Another identity already owns the low seq values, so every restored seq is remapped.
  burst(target, "agent-1", ["x", "y", "z"]);
  restoreExport(target.bind("agent-0"), source.bind("agent-0").export());
  assert.deepEqual(order(target), bodies);
});
