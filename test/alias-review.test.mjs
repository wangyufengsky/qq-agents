import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { MemoryStore } from "../src/memory/store.mjs";
import { restoreExport } from "../src/memory/migrate.mjs";
import { fixture, config, raw, FakeTransport } from "./helpers.mjs";
const hash = (s) => createHash("sha256").update(s).digest("hex");
const event = {
  dedupe: "observed-1",
  connectionId: "qq-0",
  conversation: "group:20000",
  kind: "message.received",
  messageId: "101",
  senderId: "30000",
  direction: "in",
  body: "synthetic observation",
  payload: { messageNamespace: "onebot", raw: { self_id: "10000" } },
};
function exported(t) {
  const store = new MemoryStore(":memory:");
  t.after(() => store.close());
  const m = store.bind("agent-0");
  m.setState("@migration-binding", {
    connectionId: "qq-0",
    accountId: "10000",
  });
  m.append(event);
  m.append({ ...event, dedupe: "second-observation" });
  const data = m.export();
  assert.equal(data.tables.message_observations.length, 1);
  return data;
}
test("Independent valid observed identity export restores exactly", (t) => {
  const data = exported(t),
    target = new MemoryStore(":memory:");
  t.after(() => target.close());
  restoreExport(target.bind("agent-0"), data);
  assert.deepEqual(target.bind("agent-0").export().tables, data.tables);
});
for (const change of [
  "connection",
  "conversation",
  "account",
  "messageId",
  "sender",
  "direction",
  "digest",
  "invalid-json",
]) {
  test(`Independent restore must reject contradictory observation ${change} atomically`, (t) => {
    const data = exported(t),
      target = new MemoryStore(":memory:");
    t.after(() => target.close());
    const row = data.tables.message_observations[0],
      o = JSON.parse(row.observation);
    if (change === "connection") o.connectionId = "qq-other";
    if (change === "conversation") o.conversation = "group:20001";
    if (change === "account") o.payload.raw.self_id = "10001";
    if (change === "messageId") o.messageId = "other-id";
    if (change === "sender") o.senderId = "30001";
    if (change === "direction") o.direction = "out";
    row.observation =
      change === "invalid-json" ? "not JSON" : JSON.stringify(o);
    row.digest = change === "digest" ? "0".repeat(64) : hash(row.observation);
    assert.throws(
      () => restoreExport(target.bind("agent-0"), data),
      undefined,
      "restore must reject invalid source evidence",
    );
    assert.equal(target.db.prepare("SELECT COUNT(*) n FROM events").get().n, 0);
  });
}
test("Independent pre-schema6 confirmed receipt plus echo does not break duplicate ingest", async (t) => {
  const cfg = config(1);
  cfg.agents[0].paused = true;
  const f = fixture(t, { cfg }),
    m = f.store.bind("agent-0");
  m.reserveDelivery("old-send", "group:20000", { text: "synthetic" });
  m.completeDelivery("old-send", "sent", "legacy-id");
  for (const kind of ["message.sent", "message.received"])
    m.append({
      dedupe: "pre6:" + kind,
      connectionId: "qq-0",
      conversation: "group:20000",
      kind,
      messageId: "legacy-id",
      senderId: "10000",
      direction: "out",
      status: kind === "message.sent" ? "confirmed" : "observed",
      body: "synthetic",
      payload: { requestId: "old-send" },
    });
  const result = await f.runtime.ingest(
    "qq-0",
    raw("legacy-id", { post_type: "message_sent", user_id: 10000 }),
  );
  assert.equal(result[0].duplicate, true);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM events").get().n, 2);
});
test("Independent gateway namespace rejects reserved archive namespace", async (t) => {
  const { validateConfig } = await import("../src/core/config.mjs");
  const cfg = config(1);
  cfg.connections[0].messageIdNamespace = "archive";
  assert.throws(
    () => validateConfig(cfg),
    undefined,
    "archive namespace is reserved for archival identities",
  );
});

test("N4 account binding must also stop raw message-id forwarding after connection account change", async (t) => {
  const cfg = config(1);
  cfg.agents[0].tools.push("qq_forward_send");
  const f = fixture(t, { cfg });
  const m = f.store.bind("agent-0");
  m.setState("@migration-binding", {
    accountId: "10000",
    connectionId: "qq-0",
  });
  const original = m.append({
    dedupe: "spec-original",
    connectionId: "qq-0",
    conversation: "group:20000",
    kind: "message.received",
    direction: "in",
    senderId: "30000",
    messageId: "7",
    body: "synthetic original",
    payload: {
      messageNamespace: "onebot",
      raw: { self_id: 10000 },
      segments: [{ type: "text", data: { text: "synthetic original" } }],
    },
  });
  const next = structuredClone(f.runtime.config);
  next.connections[0].accountId = "10099";
  await f.runtime.changeConfig(next, f.configStore.revision);
  const transport = new FakeTransport();
  transport.sendForward = async (conversation, nodes) => {
    transport.sent.push({ conversation, nodes });
    return { messageId: "900" };
  };
  f.runtime.transports.set("qq-0", transport);
  const ctx = f.runtime.makeContext("agent-0", "group:20000");
  await assert.rejects(
    f.runtime.send(ctx, {
      requestId: "direct",
      text: "synthetic",
      replyTo: "7",
    }),
    /ALIAS_ACCOUNT_MISMATCH/,
  );
  await assert.rejects(
    f.runtime.callTool(ctx, "qq_forward_send", {
      requestId: "forward",
      eventIds: [original.id],
    }),
    /ALIAS_ACCOUNT_MISMATCH/,
  );
  assert.equal(transport.sent.length, 0);
});
for (const binding of [false, true])
  test(`restored observations reject inconsistent accounts, binding=${binding}`, (t) => {
    const source = new MemoryStore(":memory:"),
      target = new MemoryStore(":memory:");
    t.after(() => {
      source.close();
      target.close();
    });
    const m = source.bind("agent-0");
    if (binding)
      m.setState("@migration-binding", {
        connectionId: "qq-0",
        accountId: "10000",
      });
    m.append(event);
    m.append({ ...event, dedupe: "observed-again" });
    const data = m.export(),
      r = data.tables.message_observations[0],
      o = JSON.parse(r.observation);
    o.payload.raw.self_id = "10001";
    if (binding) o.payload.accountId = "10000";
    r.observation = JSON.stringify(o);
    r.digest = hash(r.observation);
    assert.throws(() => restoreExport(target.bind("agent-0"), data), /ACCOUNT/);
    assert.equal(target.db.prepare("SELECT COUNT(*) n FROM events").get().n, 0);
  });
