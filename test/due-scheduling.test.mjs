import test from "node:test";
import assert from "node:assert/strict";
import { fixture, config, settle } from "./helpers.mjs";
import { MemoryStore } from "../src/memory/store.mjs";
import { Runtime } from "../src/core/runtime.mjs";
import { restoreExport } from "../src/memory/migrate.mjs";

test("inactive conversations do not become candidates on every tick; an updated timer becomes eligible immediately", async (t) => {
  let now = 1800000000000,
    calls = 0;
  const f = fixture(t, { cfg: config(1), run: async () => calls++ });
  f.runtime.clock = () => new Date(now);
  const m = f.store.bind("agent-0");
  for (let i = 0; i < 100; i++)
    m.setState("group:" + (20000 + i), {
      wakeConfig: { sleepUntil: now + 60000 },
    });
  assert.equal(f.runtime.conversations.tick().examined, 0);
  m.setState("group:20000", { wakeConfig: { sleepUntil: now - 1 } });
  assert.equal(f.runtime.conversations.tick().examined, 1);
  await settle(f.runtime);
  assert.equal(calls, 1);
  assert.equal(f.runtime.conversations.tick().examined, 0);
});
test("derived timers roll back with state, rebuild after reopen, and restore from legacy exports", async (t) => {
  const f = fixture(t, { cfg: config(1) });
  const now = 1800000000000,
    m = f.store.bind("agent-0");
  m.setState("group:20000", {
    wakeConfig: { sleepUntil: now + 1000 },
    custom: "keep",
  });
  assert.throws(() =>
    f.store.transaction(() => {
      m.setState("group:20000", { wakeConfig: { sleepUntil: now - 1 } });
      throw Error("rollback");
    }),
  );
  f.runtime.clock = () => new Date(now);
  assert.equal(f.runtime.conversations.tick().examined, 0);
  const exportData = m.export();
  // v0 state is accepted and remains authoritative when rebuilding a lost index.
  const value = JSON.parse(
    exportData.tables.runtime.find((x) => x.conversation === "group:20000")
      .value,
  );
  delete value._conversationSchema;
  exportData.tables.runtime.find(
    (x) => x.conversation === "group:20000",
  ).value = JSON.stringify(value);
  const restored = new MemoryStore(":memory:");
  restoreExport(restored.bind("agent-0"), exportData);
  const reopened = new MemoryStore(f.store.file);
  for (const store of [restored, reopened]) {
    const runtime = new Runtime({
      memory: store,
      configStore: f.configStore,
      backendFactory: () => ({ run: async () => {}, close: async () => {} }),
      clock: () => new Date(now + 1001),
    });
    runtime.transports.set("qq-0", f.runtime.transports.get("qq-0"));
    assert.equal(runtime.conversations.tick().examined, 1);
    await settle(runtime);
    assert.equal(store.bind("agent-0").state("group:20000").custom, "keep");
    await runtime.close();
    store.close();
    f.runtime.transports.get("qq-0").connected = true;
  }
});
test("paused due work is deferred, and resume refreshes eligibility", async (t) => {
  const f = fixture(t, { cfg: config(1) });
  const now = 1800000000000;
  f.runtime.clock = () => new Date(now);
  f.store
    .bind("agent-0")
    .setState("group:20000", { wakeConfig: { sleepUntil: now - 1 } });
  await f.runtime.pause("agent-0", true);
  assert.equal(f.runtime.conversations.tick().examined, 1);
  assert.equal(f.runtime.conversations.tick().examined, 0);
  await f.runtime.pause("agent-0", false);
  assert.equal(f.runtime.conversations.tick().examined, 1);
  await settle(f.runtime);
});

test("disconnected work survives deferral and reconnect makes it due immediately", async (t) => {
  let calls = 0;
  const f = fixture(t, { cfg: config(1), run: async () => calls++ });
  const now = 1800000000000;
  f.runtime.clock = () => new Date(now);
  const m = f.store.bind("agent-0");
  m.setState("group:20000", { wakeConfig: { sleepUntil: now - 1 } });
  await f.runtime.stopConnection("qq-0");
  assert.equal(f.runtime.conversations.tick().examined, 1);
  assert.equal(f.runtime.conversations.tick().examined, 0);
  assert.equal(calls, 0);
  await f.runtime.startConnection("qq-0");
  assert.equal(f.runtime.conversations.tick().examined, 1);
  await settle(f.runtime);
  assert.equal(calls, 1);
});

test("large blocked backlogs are bounded per tick without starving eligible later conversations", async (t) => {
  let calls = 0;
  const f = fixture(t, { cfg: config(1), run: async () => calls++ });
  const now = 1800000000000;
  f.runtime.clock = () => new Date(now);
  const m = f.store.bind("agent-0");
  f.store.transaction(() => {
    for (let i = 0; i < 300; i++)
      m.setState("group:" + (40000 + i), {
        pendingWakes: [{ reason: "mention" }],
        wakeDueAt: now - 2,
      });
    m.setState("group:20000", { wakeConfig: { sleepUntil: now - 1 } });
  });
  assert.equal(f.runtime.conversations.tick().examined, 256);
  assert.equal(calls, 0);
  assert.equal(f.runtime.conversations.tick().examined, 45);
  await settle(f.runtime);
  assert.equal(calls, 1);
});

test("state writes atomically supersede stale deferred candidates and deleting state removes its timer", (t) => {
  const f = fixture(t),
    m = f.store.bind("agent-0");
  m.setState("group:20000", {
    pendingWakes: [{ reason: "mention" }],
    wakeDueAt: 100,
  });
  const old = f.store.due.ready(100)[0];
  m.setState("group:20000", {
    pendingWakes: [{ reason: "mention" }],
    wakeDueAt: 110,
  });
  f.store.due.defer(old, 9000);
  assert.equal(f.store.due.ready(110).length, 1);
  f.store.db
    .prepare("DELETE FROM runtime WHERE agent_id=? AND conversation=?")
    .run("agent-0", "group:20000");
  assert.equal(f.store.due.ready(10000).length, 0);
});

test("legacy chat state upgrades on write, preserves unknown fields and rejects unsupported versions", (t) => {
  const f = fixture(t),
    m = f.store.bind("agent-0");
  const writeRaw = (value) =>
    f.store.db
      .prepare("INSERT OR REPLACE INTO runtime VALUES(?,?,?)")
      .run("agent-0", "group:20000", JSON.stringify(value));
  writeRaw({ readThroughSeq: 7, custom: { keep: true } });
  m.setState("group:20000", { ...m.state("group:20000"), paused: true });
  const raw = f.store.db
    .prepare("SELECT value FROM runtime WHERE agent_id=? AND conversation=?")
    .get("agent-0", "group:20000");
  assert.equal(JSON.parse(raw.value)._conversationSchema, 1);
  assert.deepEqual(m.state("group:20000").custom, { keep: true });
  assert.equal(m.state("group:20000")._conversationSchema, undefined);
  writeRaw({ _conversationSchema: 99 });
  assert.throws(
    () => m.state("group:20000"),
    /CONVERSATION_STATE_VERSION_UNSUPPORTED/,
  );
});

test("a lost derived table is rebuilt from authoritative state without changing export contents", (t) => {
  const f = fixture(t),
    m = f.store.bind("agent-0");
  m.setState("group:20000", { wakeConfig: { sleepUntil: 100 } });
  const before = m.export().tables;
  f.store.db.exec("DROP TABLE conversation_due");
  const reopened = new MemoryStore(f.store.file);
  try {
    assert.equal(reopened.due.ready(100).length, 1);
    assert.deepEqual(reopened.bind("agent-0").export().tables, before);
    assert(!Object.hasOwn(before, "conversation_due"));
  } finally {
    reopened.close();
  }
});
