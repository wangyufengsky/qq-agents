import test from "node:test";
import assert from "node:assert/strict";
import { fixture, config, context } from "./helpers.mjs";
import { TOOL_NAMES } from "../src/tools/index.mjs";

function setup(t, restricted = true) {
  const cfg = config(1);
  cfg.agents[0].tools = TOOL_NAMES;
  const f = fixture(t, { cfg }),
    mem = f.store.bind("agent-0"),
    ctx = context(f.runtime, "agent-0", "private:30000");
  const root = mem.append({
    dedupe: "forward-root",
    conversation: ctx.conversation,
    connectionId: "qq-0",
    kind: "message.received",
    body: "[forward]",
    payload: {
      segments: [{ type: "forward", data: { id: "fixture-resource" } }],
      ...(restricted ? { protectedPeerQzoneTargets: ["30000"] } : {}),
    },
  });
  let calls = 0;
  f.runtime.transports.get("qq-0").call = async () => {
    calls++;
    return {
      messages: [
        {
          sender: { user_id: "30000", nickname: "fixture" },
          message: [{ type: "text", data: { text: "fixture-secret-forward" } }],
        },
      ],
    };
  };
  return { ...f, mem, ctx, root, calls: () => calls };
}
async function deniedInGroup(f, ids) {
  const group = context(f.runtime, "agent-0", "group:20000");
  for (const id of ids)
    await assert.rejects(
      f.runtime.callTool(group, "memory_read", { id }),
      /RECALL_SOURCE_NOT_ALLOWED/,
    );
  const found = await f.runtime.callTool(group, "memory_search", {
    query: "fixture-secret-forward",
  });
  assert(!JSON.stringify(found).includes("fixture-secret-forward"));
  assert(!JSON.stringify(found).includes(ids[0]));
}

test("forward archives and nodes retain root protection after original source deletion", async (t) => {
  const f = setup(t);
  const result = await f.runtime.callTool(f.ctx, "qq_forward_read", {
    eventId: f.root.id,
  });
  assert.equal(result.items.length, 1);
  const rows = f.mem.db
    .prepare(
      "SELECT id,payload FROM events WHERE agent_id=? AND kind IN ('forward.archive','forward.node')",
    )
    .all("agent-0");
  for (const row of rows)
    assert.deepEqual(JSON.parse(row.payload).protectedPeerQzoneTargets, [
      "30000",
    ]);
  const ids = rows.map((row) => row.id);
  await deniedInGroup(f, ids);
  f.mem.db.prepare("DELETE FROM events WHERE id=?").run(f.root.id);
  await deniedInGroup(f, ids);
});

test("previously unprotected cached forward nodes monotonically gain newly discovered source protection", async (t) => {
  const f = setup(t, false);
  await f.runtime.callTool(f.ctx, "qq_forward_read", { eventId: f.root.id });
  const before = f.mem.db
    .prepare(
      "SELECT id,body,payload FROM events WHERE kind IN ('forward.archive','forward.node')",
    )
    .all();
  assert(
    before.every((row) => !JSON.parse(row.payload).protectedPeerQzoneTargets),
  );
  const row = f.mem.db
    .prepare("SELECT payload FROM events WHERE id=?")
    .get(f.root.id);
  f.mem.db.prepare("UPDATE events SET payload=? WHERE id=?").run(
    JSON.stringify({
      ...JSON.parse(row.payload),
      protectedPeerQzoneTargets: ["30000"],
    }),
    f.root.id,
  );
  await f.runtime.callTool(f.ctx, "qq_forward_read", { eventId: f.root.id });
  assert.equal(f.calls(), 1);
  for (const old of before) {
    const current = f.mem.db
      .prepare("SELECT body,payload FROM events WHERE id=?")
      .get(old.id);
    assert.equal(current.body, old.body);
    const upgraded = JSON.parse(current.payload),
      original = JSON.parse(old.payload);
    assert.deepEqual(upgraded.protectedPeerQzoneTargets, ["30000"]);
    delete upgraded.protectedPeerQzoneTargets;
    assert.deepEqual(upgraded, original);
  }
  f.mem.db.prepare("DELETE FROM events WHERE id=?").run(f.root.id);
  await deniedInGroup(
    f,
    before.map((row) => row.id),
  );
});

test("forward archive inherits protected context even when gateway root itself is ordinary", async (t) => {
  const f = setup(t, false);
  f.ctx.privateRead.add("peer-qzone:30000");
  f.ctx.persistTaint();
  await f.runtime.callTool(f.ctx, "qq_forward_read", { eventId: f.root.id });
  const rows = f.mem.db
    .prepare(
      "SELECT id,payload FROM events WHERE kind IN ('forward.archive','forward.node')",
    )
    .all();
  for (const row of rows)
    assert.deepEqual(JSON.parse(row.payload).protectedPeerQzoneTargets, [
      "30000",
    ]);
  await deniedInGroup(
    f,
    rows.map((row) => row.id),
  );
  const group = context(f.runtime, "agent-0", "group:20000");
  await assert.rejects(
    f.runtime.callTool(group, "qq_forward_read", { eventId: f.root.id }),
    /RECALL_SOURCE_NOT_ALLOWED/,
  );
  assert.equal(f.calls(), 1);
});

test("confirmed-send source protection survives an unmarked root and a fresh reader context", async (t) => {
  const f = setup(t, false);
  const source = f.mem.append({
    dedupe: "confirmed-source",
    conversation: "private:30000",
    connectionId: "qq-0",
    kind: "message.received",
    messageId: "fixture-source-message",
    senderId: "30000",
    body: "fixture-secret-forward",
    payload: {
      segments: [{ type: "text", data: { text: "fixture-secret-forward" } }],
      protectedPeerQzoneTargets: ["30000"],
    },
  });
  f.runtime.transports.get("qq-0").sendForward = async () => ({
    messageId: "fixture-confirmed-forward",
  });
  await f.runtime.callTool(f.ctx, "qq_forward_send", {
    requestId: "fixture-forward-send",
    eventIds: [source.id],
  });
  const sent = f.mem.db
    .prepare("SELECT * FROM events WHERE kind='message.sent' AND message_id=?")
    .get("fixture-confirmed-forward");
  const payload = JSON.parse(sent.payload);
  delete payload.protectedPeerQzoneTargets;
  f.mem.db
    .prepare("UPDATE events SET payload=? WHERE id=?")
    .run(JSON.stringify(payload), sent.id);
  const fresh = context(f.runtime, "agent-0", "private:30000");
  fresh.privateRead.clear();
  fresh.persistTaint();
  const result = await f.runtime.callTool(fresh, "qq_forward_read", {
    eventId: sent.id,
  });
  assert.equal(result.items.length, 1);
  assert(fresh.privateRead.has("peer-qzone:30000"));
  const group = context(f.runtime, "agent-0", "group:20000");
  await assert.rejects(
    f.runtime.callTool(group, "qq_forward_read", { eventId: sent.id }),
    /RECALL_SOURCE_NOT_ALLOWED/,
  );
  const rows = f.mem.db
    .prepare(
      "SELECT id,payload FROM events WHERE kind IN ('forward.archive','forward.node') AND json_extract(payload,'$.rootEventId')=?",
    )
    .all(sent.id);
  for (const row of rows)
    assert.deepEqual(JSON.parse(row.payload).protectedPeerQzoneTargets, [
      "30000",
    ]);
  f.mem.db
    .prepare("DELETE FROM events WHERE id IN (?,?)")
    .run(source.id, sent.id);
  await deniedInGroup(
    f,
    rows.map((row) => row.id),
  );
});
