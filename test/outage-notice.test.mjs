import test from "node:test";
import assert from "node:assert/strict";
import { ConnectionRecovery } from "../src/core/connection-recovery.mjs";
import { validateConfig } from "../src/core/config.mjs";
import { config, fixture, settle, FakeTransport } from "./helpers.mjs";

// A notice can start inside another job (a reconnect), so wait for those too.
async function drain(runtime) {
  for (let i = 0; i < 10 && runtime.jobs.size; i++) await settle(runtime);
}

const owner = "30000",
  dm = "private:" + owner;
const TEXT = "{agent} 掉线了：{reason}";
const MINUTE = 60000;

function setup(t, { agents = 2, notice = {}, edit = () => {} } = {}) {
  const cfg = config(agents);
  cfg.agents[0].ownerIds = [owner];
  cfg.agents[0].behavior.outageNotice = {
    enabled: true,
    text: TEXT,
    recoveredText: "{agent} 回来了",
    notifyRecovered: false,
    cooldownMs: 30 * MINUTE,
    ...notice,
  };
  edit(cfg);
  const f = fixture(t, { cfg });
  let now = Date.parse("2026-10-29T12:00:00Z");
  f.runtime.clock = () => new Date(now);
  f.runtime.random = () => 0.5; // no jitter
  f.runtime.transports.delete("qq-0");
  const advance = async (ms) => {
    now += ms;
    f.runtime.connectionRecovery.tick();
    await drain(f.runtime);
  };
  const failWith = (code) => {
    f.runtime.transportFactory = () => {
      const transport = new FakeTransport();
      transport.connected = false;
      transport.connect = async () => {
        throw Error(code);
      };
      return transport;
    };
  };
  const online = f.runtime.transportFactory;
  const goOnline = () => {
    f.runtime.transportFactory = online;
  };
  const drop = async (code = "QQ_OFFLINE") => {
    const transport = f.runtime.transports.get("qq-0");
    transport.connected = false;
    transport.emit("fault", code);
    await drain(f.runtime);
  };
  // Lines each connection sent, as [conversation, text].
  const sent = (id) =>
    (f.runtime.transports.get(id)?.sent || []).map((x) => [
      x.conversation,
      x.segments.map((s) => s.data?.text).join(""),
    ]);
  const codes = () => f.runtime.diagnostics.snapshot().map((d) => d.code);
  return { ...f, advance, failWith, goOnline, drop, sent, codes };
}

test("another online agent tells the owner when an agent's QQ goes offline", async (t) => {
  const f = setup(t, { agents: 3 });
  await f.runtime.startConnection("qq-0");
  await f.drop("QQ_OFFLINE");
  // The first eligible agent in configuration order speaks, nobody else.
  assert.deepEqual(f.sent("qq-1"), [[dm, "角色0 掉线了：QQ 已离线"]]);
  assert.deepEqual(f.sent("qq-2"), []);
  assert.deepEqual(f.sent("qq-0"), []);
  const m = f.store.bind("agent-1");
  const [delivery] = m.db
    .prepare("SELECT request_id, status FROM deliveries WHERE agent_id=?")
    .all("agent-1");
  assert.match(delivery.request_id, /^outage:qq-0:offline:/);
  assert.equal(delivery.status, "sent");
  // Archived as the sender's own message, so its later turns see it.
  assert(
    m
      .conversation({ conversation: dm })
      .items.some(
        (x) =>
          x.type === "message.sent" && x.body === "角色0 掉线了：QQ 已离线",
      ),
  );
  // Further failed retries in the same outage add nothing.
  f.failWith("QQ_OFFLINE");
  await f.advance(2000);
  await f.advance(4000);
  assert.equal(f.sent("qq-1").length, 1);

  // With the first agent paused, the next one in order speaks instead.
  const g = setup(t, {
    agents: 3,
    edit: (cfg) => (cfg.agents[1].paused = true),
  });
  await g.runtime.startConnection("qq-0");
  await g.drop("QQ_OFFLINE");
  assert.deepEqual(g.sent("qq-1"), []);
  assert.deepEqual(g.sent("qq-2"), [[dm, "角色0 掉线了：QQ 已离线"]]);
});

test("a retry that finds QQ logged out counts as offline, and giving up is its own line", async (t) => {
  const f = setup(t, {
    edit: (cfg) => (cfg.connections[0].recovery.maxAttempts = 3),
  });
  await f.runtime.startConnection("qq-0");
  // A plain socket drop says nothing by itself.
  await f.drop("CONNECTION_LOST");
  assert.deepEqual(f.sent("qq-1"), []);
  f.failWith("QQ_OFFLINE");
  await f.advance(2000);
  assert.deepEqual(f.sent("qq-1"), [[dm, "角色0 掉线了：QQ 已离线"]]);
  // Unreviewed failure text never reaches QQ.
  f.failWith("connect ECONNREFUSED 127.0.0.1:3000");
  await f.advance(4000);
  await f.advance(8000);
  assert.equal(
    f.runtime.connectionRecovery.snapshot("qq-0").state,
    "exhausted",
  );
  assert.deepEqual(f.sent("qq-1"), [
    [dm, "角色0 掉线了：QQ 已离线"],
    [dm, "角色0 掉线了：自动重连失败"],
  ]);
  assert.doesNotMatch(JSON.stringify(f.sent("qq-1")), /ECONNREFUSED|127\./);
});

test("the same event on the same connection is not repeated within the cooldown, even after a restart", async (t) => {
  const f = setup(t);
  await f.runtime.startConnection("qq-0");
  await f.drop("QQ_OFFLINE");
  await f.advance(2000); // reconnects
  assert.equal(
    f.runtime.connectionRecovery.snapshot("qq-0").state,
    "connected",
  );
  await f.drop("QQ_OFFLINE");
  assert.equal(f.sent("qq-1").length, 1, "still cooling down");

  // A restart loses recovery state but not the cooldown.
  await f.runtime.stopConnection("qq-0");
  f.runtime.connectionRecovery = new ConnectionRecovery(f.runtime);
  await f.advance(10 * MINUTE);
  await f.runtime.startConnection("qq-0");
  await f.drop("QQ_OFFLINE");
  assert.equal(f.sent("qq-1").length, 1, "no repeat after restart");

  await f.advance(2000);
  await f.advance(30 * MINUTE);
  await f.drop("QQ_OFFLINE");
  assert.equal(f.sent("qq-1").length, 2, "cooldown over");
});

test("nothing is sent and only a diagnostic is kept when no other agent can speak", async (t) => {
  // A single-agent instance has nobody to send the line.
  const alone = setup(t, { agents: 1 });
  await alone.runtime.startConnection("qq-0");
  await alone.drop("QQ_OFFLINE");
  assert.deepEqual(alone.sent("qq-0"), []);
  assert.equal(alone.runtime.faults.get("qq-0"), "QQ_OFFLINE");
  // One diagnostic per outage, however many retries still find QQ offline.
  alone.failWith("QQ_OFFLINE");
  await alone.advance(2000);
  await alone.advance(4000);
  const noSender = alone.runtime.diagnostics
    .snapshot()
    .filter((d) => d.code === "OUTAGE_NOTICE_NO_SENDER");
  assert.deepEqual(
    noSender.map((d) => d.count),
    [1],
  );

  // The other agent's QQ is down too.
  const both = setup(t);
  both.runtime.transports.get("qq-1").connected = false;
  await both.runtime.startConnection("qq-0");
  await both.drop("QQ_OFFLINE");
  assert.deepEqual(both.sent("qq-1"), []);
  assert(both.codes().includes("OUTAGE_NOTICE_NO_SENDER"));

  // No owner to tell.
  const nobody = setup(t, { edit: (cfg) => (cfg.agents[0].ownerIds = []) });
  await nobody.runtime.startConnection("qq-0");
  await nobody.drop("QQ_OFFLINE");
  assert.deepEqual(nobody.sent("qq-1"), []);
  assert(nobody.codes().includes("OUTAGE_NOTICE_NO_OWNER"));
});

test("a paused sender, an owner outside its allow list or a blocked outbox sends nothing and raises nothing", async (t) => {
  const paused = setup(t, { edit: (cfg) => (cfg.agents[1].paused = true) });
  await paused.runtime.startConnection("qq-0");
  await paused.drop("QQ_OFFLINE");
  assert.deepEqual(paused.sent("qq-1"), []);
  assert.equal(paused.runtime.faults.has("connection:qq-0"), false);

  const outside = setup(t, {
    edit: (cfg) => (cfg.agents[1].allow.users = ["30001"]),
  });
  await outside.runtime.startConnection("qq-0");
  await outside.drop("QQ_OFFLINE");
  assert.deepEqual(outside.sent("qq-1"), []);
  assert(outside.codes().includes("OUTAGE_NOTICE_NO_SENDER"));

  // Gates of the outbox still apply; a blocked line is not retried later.
  const quiet = setup(t);
  quiet.store.bind("agent-1").setState(dm, {
    ...quiet.store.bind("agent-1").state(dm),
    silenceUntil: quiet.runtime.now() + 10 * MINUTE,
  });
  await quiet.runtime.startConnection("qq-0");
  await quiet.drop("QQ_OFFLINE");
  assert.deepEqual(quiet.sent("qq-1"), []);
  assert(quiet.codes().includes("AGENT_PAUSED_OR_EXPIRED"));
  assert.equal(quiet.runtime.faults.has("connection:qq-0"), false);
  quiet.failWith("QQ_OFFLINE");
  await quiet.advance(20 * MINUTE);
  assert.deepEqual(quiet.sent("qq-1"), []);
});

test("nothing is sent when the notice is off", async (t) => {
  const f = setup(t, { notice: { enabled: false } });
  await f.runtime.startConnection("qq-0");
  await f.drop("QQ_OFFLINE");
  assert.deepEqual(f.sent("qq-1"), []);
  assert.equal(f.codes().includes("OUTAGE_NOTICE_NO_SENDER"), false);
});

test("the recovered line is off by default and only follows an outage line", async (t) => {
  const f = setup(t);
  await f.runtime.startConnection("qq-0");
  await f.drop("QQ_OFFLINE");
  await f.advance(2000);
  assert.equal(
    f.runtime.connectionRecovery.snapshot("qq-0").state,
    "connected",
  );
  assert.equal(f.sent("qq-1").length, 1);

  const on = setup(t, { notice: { notifyRecovered: true } });
  await on.runtime.startConnection("qq-0");
  // A short socket blip told nobody, so its recovery says nothing either.
  await on.drop("CONNECTION_LOST");
  await on.advance(2000);
  assert.deepEqual(on.sent("qq-1"), []);
  await on.drop("QQ_OFFLINE");
  await on.advance(2000);
  assert.deepEqual(on.sent("qq-1"), [
    [dm, "角色0 掉线了：QQ 已离线"],
    [dm, "角色0 回来了"],
  ]);
});

test("the recovered line only reaches owners whose outage line was delivered", async (t) => {
  const other = "private:30001";
  const f = setup(t, {
    notice: { notifyRecovered: true },
    edit: (cfg) => {
      cfg.agents[0].ownerIds = [owner, "30001"];
      cfg.agents[1].allow.users = [owner, "30001"];
    },
  });
  // The second owner's chat is silenced only while QQ is down.
  const m = f.store.bind("agent-1");
  m.setState(other, {
    ...m.state(other),
    silenceUntil: f.runtime.now() + 10 * MINUTE,
  });
  await f.runtime.startConnection("qq-0");
  await f.drop("QQ_OFFLINE");
  assert.deepEqual(f.sent("qq-1"), [[dm, "角色0 掉线了：QQ 已离线"]]);
  f.failWith("QQ_OFFLINE");
  await f.advance(2000);
  await f.advance(11 * MINUTE); // the silence is over before QQ comes back
  f.goOnline();
  await f.advance(8000);
  assert.equal(
    f.runtime.connectionRecovery.snapshot("qq-0").state,
    "connected",
  );
  assert.deepEqual(f.sent("qq-1"), [
    [dm, "角色0 掉线了：QQ 已离线"],
    [dm, "角色0 回来了"],
  ]);

  // Nobody heard of the outage, so nobody hears of the recovery.
  const g = setup(t, { notice: { notifyRecovered: true } });
  const n = g.store.bind("agent-1");
  n.setState(dm, {
    ...n.state(dm),
    silenceUntil: g.runtime.now() + 10 * MINUTE,
  });
  await g.runtime.startConnection("qq-0");
  await g.drop("QQ_OFFLINE");
  g.failWith("QQ_OFFLINE");
  await g.advance(2000);
  await g.advance(11 * MINUTE);
  g.goOnline();
  await g.advance(8000);
  assert.equal(
    g.runtime.connectionRecovery.snapshot("qq-0").state,
    "connected",
  );
  assert.deepEqual(g.sent("qq-1"), []);
});

test("the outage notice defaults off and older configurations still load", () => {
  const cfg = config(1);
  assert.deepEqual(cfg.agents[0].behavior.outageNotice, {
    enabled: false,
    text: "{agent} 的 QQ 掉线了：{reason}。请到 NapCat 看一下。",
    recoveredText: "{agent} 的 QQ 已经恢复连接。",
    notifyRecovered: false,
    cooldownMs: 1800000,
  });
  const old = structuredClone(cfg);
  delete old.agents[0].behavior.outageNotice;
  assert.deepEqual(
    validateConfig(old).agents[0].behavior.outageNotice,
    cfg.agents[0].behavior.outageNotice,
  );
  for (const bad of [
    { text: "x".repeat(201) },
    { recoveredText: "" },
    { cooldownMs: 1000 },
    { unknown: true },
  ]) {
    const next = structuredClone(cfg);
    Object.assign(next.agents[0].behavior.outageNotice, bad);
    assert.throws(() => validateConfig(next));
  }
});

test("a recovery that beats the outage line still follows it once that line lands", async (t) => {
  const f = setup(t, { notice: { notifyRecovered: true } });
  const recovery = f.runtime.connectionRecovery,
    calls = [],
    pending = [];
  // The other agent's outage line takes longer than QQ takes to come back.
  recovery.outage = {
    send: (id, event, code, owners) => {
      calls.push([event, owners]);
      if (event !== "offline") return Promise.resolve(owners || []);
      return new Promise((resolve) => pending.push(resolve));
    },
  };
  recovery.armed("qq-0");
  recovery.lost("qq-0", "QQ_OFFLINE");
  recovery.armed("qq-0"); // back before the outage line was confirmed
  // Not drain(): that would wait for the line still on its way.
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, [["offline", null]]);
  pending.shift()([owner]);
  await drain(f.runtime);
  assert.deepEqual(calls, [
    ["offline", null],
    ["recovered", [owner]],
  ]);

  // Dropped again before the line landed: that recovery is stale.
  calls.length = 0;
  recovery.lost("qq-0", "QQ_OFFLINE");
  recovery.armed("qq-0");
  recovery.lost("qq-0", "QQ_OFFLINE");
  // Both outage lines land; the recovery between them is never sent.
  while (pending.length) pending.shift()([owner]);
  await drain(f.runtime);
  assert.deepEqual(
    calls.map(([event]) => event),
    ["offline", "offline"],
  );
});
