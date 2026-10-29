import test from "node:test";
import assert from "node:assert/strict";
import { configImpact } from "../src/core/config-impact.mjs";
import { validateConfig } from "../src/core/config.mjs";
import { config, fixture, settle, FakeTransport } from "./helpers.mjs";

function setup(t, edit = () => {}) {
  const cfg = config();
  edit(cfg);
  const f = fixture(t, { cfg });
  let now = Date.parse("2026-10-27T12:00:00Z");
  f.runtime.clock = () => new Date(now);
  f.runtime.random = () => 0.5; // no jitter
  f.runtime.transports.delete("qq-0");
  const advance = async (ms) => {
    now += ms;
    f.runtime.connectionRecovery.tick();
    await settle(f.runtime);
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
  const drop = (code = "CONNECTION_LOST") => {
    const transport = f.runtime.transports.get("qq-0");
    transport.connected = false;
    transport.emit("fault", code);
  };
  return { ...f, advance, failWith, goOnline, drop, now: () => now };
}
const recovery = (runtime, id = "qq-0") =>
  runtime.connectionRecovery.snapshot(id);

test("a dropped connection reconnects after backoff and records the gap", async (t) => {
  const { runtime, advance, drop } = setup(t);
  await runtime.startConnection("qq-0");
  assert.equal(recovery(runtime).state, "connected");
  const first = runtime.transports.get("qq-0");
  drop();
  assert.equal(recovery(runtime).state, "retrying");
  assert.equal(runtime.faults.get("qq-0"), "CONNECTION_LOST");
  await advance(1999);
  assert.equal(runtime.transports.get("qq-0"), first, "no attempt before due");
  await advance(1);
  const next = runtime.transports.get("qq-0");
  assert.notEqual(next, first);
  assert.equal(next.connected, true);
  const r = recovery(runtime);
  assert.equal(r.state, "connected");
  assert.equal(r.attempts, 0);
  assert.equal(r.lastGap.recoveredAt - r.lastGap.lostAt, 2000);
  assert.equal(runtime.faults.has("qq-0"), false);
  // Recovery is repeatable after a later drop.
  drop("ONEBOT_WS_ERROR");
  assert.equal(recovery(runtime).state, "retrying");
});

test("failed attempts back off exponentially and stop at the attempt limit", async (t) => {
  const { runtime, advance, drop, failWith, now } = setup(t, (cfg) => {
    cfg.connections[0].recovery.maxAttempts = 3;
  });
  await runtime.startConnection("qq-0");
  drop();
  failWith("QQ_OFFLINE");
  await advance(2000);
  assert.equal(recovery(runtime).attempts, 1);
  assert.equal(recovery(runtime).nextRetryAt, now() + 4000);
  await advance(4000);
  assert.equal(recovery(runtime).attempts, 2);
  assert.equal(recovery(runtime).nextRetryAt, now() + 8000);
  await advance(8000);
  const r = recovery(runtime);
  assert.equal(r.state, "exhausted");
  assert.equal(r.attempts, 3);
  assert.equal(runtime.faults.get("qq-0"), "QQ_AUTO_RECONNECT_EXHAUSTED");
  await advance(600000);
  assert.equal(recovery(runtime).attempts, 3, "no attempts after exhaustion");
});

test("an account mismatch stops recovery immediately", async (t) => {
  const { runtime, advance, drop, failWith } = setup(t);
  await runtime.startConnection("qq-0");
  drop();
  failWith("QQ_ACCOUNT_MISMATCH");
  await advance(2000);
  const r = recovery(runtime);
  assert.equal(r.state, "exhausted");
  assert.equal(r.error, "QQ_ACCOUNT_MISMATCH");
  assert.equal(r.attempts, 1);
});

test("only admin-connected sockets that drop are recovered", async (t) => {
  const { runtime, advance, drop } = setup(t);
  runtime.connectionRecovery.lost("qq-1", "CONNECTION_LOST");
  assert.equal(recovery(runtime, "qq-1").state, "idle");
  await runtime.startConnection("qq-0");
  drop("INVALID_ONEBOT_EVENT");
  assert.equal(recovery(runtime).state, "connected", "not a lost socket");
  await runtime.stopConnection("qq-0");
  assert.equal(recovery(runtime).state, "idle");
  await advance(10000);
  assert.equal(runtime.transports.has("qq-0"), false);
});

test("an admin disconnect during backoff cancels recovery", async (t) => {
  const { runtime, advance, drop } = setup(t);
  await runtime.startConnection("qq-0");
  drop();
  await runtime.stopConnection("qq-0");
  await advance(2000);
  assert.equal(runtime.transports.has("qq-0"), false);
  assert.equal(recovery(runtime).state, "idle");
});

test("disabling auto-reconnect stops a pending retry without dropping config", async (t) => {
  const { runtime, advance, drop } = setup(t);
  await runtime.startConnection("qq-0");
  drop();
  const next = structuredClone(runtime.config);
  next.connections[0].recovery.autoReconnect = false;
  assert.equal(configImpact(runtime.config, next).connectionIds.size, 0);
  await runtime.changeConfig(next, runtime.configStore.revision);
  assert.equal(recovery(runtime).state, "retrying", "policy edit keeps state");
  await advance(2000);
  assert.equal(recovery(runtime).state, "stopped");
  assert.equal(runtime.transports.get("qq-0").connected, false);
});

test("recovery policy is validated", () => {
  const cfg = config(1);
  assert.deepEqual(cfg.connections[0].recovery, {
    autoReconnect: true,
    maxAttempts: 8,
    initialDelayMs: 2000,
    maxDelayMs: 300000,
  });
  cfg.connections[0].recovery = { initialDelayMs: 60000, maxDelayMs: 5000 };
  assert.throws(() => validateConfig(cfg), /maxDelayMs/);
});

test("editing a connection's endpoint disarms recovery until a manual connect", async (t) => {
  const { runtime, advance, drop } = setup(t);
  await runtime.startConnection("qq-0");
  drop();
  const next = structuredClone(runtime.config);
  next.connections[0].httpUrl = "http://127.0.0.1:10";
  const result = await runtime.changeConfig(next, runtime.configStore.revision);
  assert.deepEqual(result.reconnectConnections, ["qq-0"]);
  assert.equal(recovery(runtime).state, "idle");
  await advance(2000);
  assert.equal(runtime.transports.has("qq-0"), false);
});

test("a heartbeat timeout is recovered like a dropped socket", async (t) => {
  const { runtime, advance, drop } = setup(t);
  await runtime.startConnection("qq-0");
  drop("ONEBOT_HEARTBEAT_TIMEOUT");
  assert.equal(recovery(runtime).state, "retrying");
  await advance(2000);
  assert.equal(recovery(runtime).state, "connected");
});

test("an account mismatch on the socket is not retried", async (t) => {
  const { runtime, drop } = setup(t);
  await runtime.startConnection("qq-0");
  drop("QQ_ACCOUNT_MISMATCH");
  assert.equal(recovery(runtime).state, "connected", "not a lost socket");
  assert.equal(runtime.faults.get("qq-0"), "QQ_ACCOUNT_MISMATCH");
});

test("the heartbeat timeout is optional and bounded", () => {
  const cfg = config(1);
  assert.equal(cfg.connections[0].recovery.heartbeatTimeoutMs, undefined);
  for (const value of [0, 15000, 600000]) {
    cfg.connections[0].recovery.heartbeatTimeoutMs = value;
    assert.equal(
      validateConfig(cfg).connections[0].recovery.heartbeatTimeoutMs,
      value,
    );
  }
  for (const value of [1, 14999, 600001]) {
    cfg.connections[0].recovery.heartbeatTimeoutMs = value;
    assert.throws(() => validateConfig(cfg));
  }
});

test("a QQ that logged out is reconnected once it is online again", async (t) => {
  const { runtime, advance, drop, failWith, goOnline } = setup(t);
  await runtime.startConnection("qq-0");
  drop("QQ_OFFLINE");
  assert.equal(recovery(runtime).state, "retrying");
  assert.equal(recovery(runtime).error, "QQ_OFFLINE");
  assert.equal(runtime.faults.get("qq-0"), "QQ_OFFLINE");
  failWith("QQ_OFFLINE");
  await advance(2000);
  assert.equal(recovery(runtime).state, "retrying");
  assert.equal(recovery(runtime).attemptError, "QQ_OFFLINE");
  // Unreviewed failure text never reaches the console.
  failWith("connect ECONNREFUSED 127.0.0.1:3000");
  await advance(4000);
  assert.equal(recovery(runtime).attemptError, "CONNECTION_FAILED");
  goOnline();
  await advance(8000);
  const r = recovery(runtime);
  assert.equal(r.state, "connected");
  assert.equal(r.attemptError, null);
  assert.equal(r.lastGap.recoveredAt - r.lastGap.lostAt, 14000);
  assert.equal(runtime.transports.get("qq-0").connected, true);
});
