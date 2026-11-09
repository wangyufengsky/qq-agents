import test from "node:test";
import assert from "node:assert/strict";
import { config, context, fixture, raw } from "./helpers.mjs";
import { safeToolFailure } from "../src/tools/errors.mjs";

function setup(t) {
  const cfg = config(1);
  const [role] = cfg.agents;
  Object.assign(role.wake, {
    names: false,
    mentions: false,
    private: false,
    participation: 0,
  });
  role.tools.push("qq_send_voice");
  const f = fixture(t, { cfg });
  return {
    ...f,
    ctx: context(f.runtime),
    mem: f.store.bind("agent-0"),
    gateway: f.runtime.transports.get("qq-0"),
  };
}

const call = (f, name, args) => f.runtime.callTool(f.ctx, name, args);

async function result(promise) {
  try {
    return await promise;
  } catch (error) {
    return safeToolFailure(error);
  }
}

async function incoming(f, messageId, text) {
  await f.runtime.ingest(
    "qq-0",
    raw(messageId, { message: [{ type: "text", data: { text } }] }),
  );
  return f.mem.db
    .prepare("SELECT id,seq FROM events WHERE agent_id=? AND message_id=?")
    .get(f.mem.agentId, String(messageId));
}

async function readOpening(f) {
  await call(f, "conversation_read", {});
  f.ctx.openingReviewInput = new Map(f.ctx.presentedInput);
}

function holdAck(f, t) {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const send = f.gateway.send.bind(f.gateway);
  f.gateway.send = async (...args) => {
    const receipt = await send(...args);
    entered.resolve();
    await release.promise;
    return receipt;
  };
  t.after(() => release.resolve());
  return { entered, release };
}

function attemptBodies(mem) {
  return mem.db
    .prepare(
      "SELECT body FROM events WHERE agent_id=? AND kind='message.send-attempt' ORDER BY seq",
    )
    .all(mem.agentId)
    .map(({ body }) => body);
}

test(
  "exact ACK checkpoint rejects a changed frozen version despite a full reread",
  { timeout: 10000 },
  async (t) => {
    const f = setup(t);
    const a = await incoming(f, 11, "合成原版本");
    await readOpening(f);
    const args = {
      requestId: "exact-changed-version",
      text: "合成回复",
      readThroughSeq: a.seq,
    };
    const gate = holdAck(f, t);
    const pending = call(f, "qq_send", args);
    try {
      await Promise.race([
        gate.entered.promise,
        pending.then(() => assert.fail("send never reached gateway")),
      ]);
      assert.deepEqual(
        f.mem.db
          .prepare("SELECT status FROM deliveries")
          .all()
          .map(({ status }) => status),
        ["pending"],
      );
      f.mem.db
        .prepare("UPDATE events SET body=? WHERE id=?")
        .run("合成修订版本", a.id);
      const reread = await call(f, "conversation_read", {});
      assert.equal(reread.readThroughSeq, a.seq);
    } finally {
      gate.release.resolve();
    }
    const sent = await pending;
    assert.equal(sent.status, "sent");
    assert.equal(sent.readCheckpoint?.applied, false);
    assert(sent.readCheckpoint?.reason);
    const duplicate = await call(f, "qq_send", args);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.messageId, sent.messageId);
    assert.equal(duplicate.readCheckpoint?.applied, false);
    assert.equal(f.mem.state(f.ctx.conversation).readThroughSeq ?? 0, 0);
    assert.deepEqual(attemptBodies(f.mem), [args.text]);
  },
);

test(
  "a newly eligible low gap cannot join an older delivery's checkpoint",
  { timeout: 10000 },
  async (t) => {
    const f = setup(t);
    const gap = f.mem.append({
      dedupe: "synthetic-derived",
      connectionId: "qq-0",
      conversation: f.ctx.conversation,
      kind: "forward.archive",
      direction: "internal",
      senderId: "30000",
      body: "合成低位材料",
    });
    const a = await incoming(f, 12, "合成发送所回应输入");
    await readOpening(f);
    const args = {
      requestId: "exact-low-gap",
      text: "合成回复",
      readThroughSeq: a.seq,
    };
    const gate = holdAck(f, t);
    const pending = call(f, "qq_send", args);
    try {
      await Promise.race([
        gate.entered.promise,
        pending.then(() => assert.fail("send never reached gateway")),
      ]);
      f.mem.db
        .prepare(
          "UPDATE events SET kind='message.received',direction='in',payload=? WHERE id=?",
        )
        .run(
          JSON.stringify({ trustedInput: true, raw: { self_id: 10000 } }),
          gap.id,
        );
      assert.equal(
        (await call(f, "conversation_read", {})).readThroughSeq,
        a.seq,
      );
    } finally {
      gate.release.resolve();
    }
    const sent = await pending;
    assert.equal(sent.status, "sent");
    assert.equal(sent.readCheckpoint?.applied, false);
    assert(sent.readCheckpoint?.reason);
    const before = await call(f, "qq_send", args);
    assert.equal(before.duplicate, true);
    assert.equal(before.readCheckpoint?.applied, false);
    await call(f, "qq_mark_read", { throughSeq: gap.seq });
    const after = await call(f, "qq_send", args);
    assert.equal(after.duplicate, true);
    assert.equal(after.readCheckpoint?.throughSeq, a.seq);
    assert.equal(after.readCheckpoint?.applied, true);
    assert.equal(f.gateway.sent.length, 1);
  },
);

test(
  "the whole voice draft is held before conversion and a new input still blocks reservation",
  { timeout: 10000 },
  async (t) => {
    const f = setup(t);
    const entered = Promise.withResolvers();
    const converted = Promise.withResolvers();
    const segment = { type: "record", data: { file: "synthetic-voice" } };
    t.after(() => converted.resolve(segment));
    f.runtime.voices = {
      metadata: () => ({
        id: "synthetic-audio",
        title: "合成语音",
        sources: [],
      }),
      segment: () => {
        entered.resolve();
        return converted.promise;
      },
    };
    const requestId = "locked-before-convert";
    const sending = result(
      call(f, "qq_send_voice", { requestId, audioId: "synthetic-audio" }),
    );
    let mutation, abandonment, fresh;
    try {
      await Promise.race([
        entered.promise,
        sending.then(() => assert.fail("voice never reached converter")),
      ]);
      const draft = f.mem.db
        .prepare("SELECT id,revision FROM qq_drafts WHERE request_id=?")
        .get(requestId);
      assert(draft);
      const identity = { draftId: draft.id, expectedVersion: draft.revision };
      assert.deepEqual(attemptBodies(f.mem), []);
      mutation = await result(
        call(f, "qq_draft", {
          ...identity,
          action: "revise",
          position: 0,
          input: { audioId: "synthetic-revision" },
        }),
      );
      abandonment = await result(
        call(f, "qq_draft", { ...identity, action: "discard" }),
      );
      fresh = await incoming(f, 31, "合成转码中新增");
    } finally {
      converted.resolve(segment);
    }
    const output = await sending;
    assert.equal(mutation.code, "DRAFT_EXECUTING");
    assert.equal(abandonment.code, "DRAFT_EXECUTING");
    assert.equal(output.code, "INPUT_REVIEW_REQUIRED");
    assert(output.inputReview.items.some(({ id }) => id === fresh.id));
    assert.equal(output.draft.items[0].status, "unsubmitted");
    assert.deepEqual(attemptBodies(f.mem), []);
    assert.equal(f.gateway.sent.length, 0);
  },
);

test(
  "a delayed ACK archives its original namespace and settles only the original input scope",
  { timeout: 10000 },
  async (t) => {
    const f = setup(t);
    const a = await incoming(f, 91, "合成原命名空间输入");
    await readOpening(f);
    const originalNamespace =
      f.runtime.config.connections[0].messageIdNamespace || "onebot";
    const args = {
      requestId: "ack-old-namespace",
      text: "合成原命名空间回复",
      readThroughSeq: a.seq,
    };
    const gate = holdAck(f, t);
    const pending = call(f, "qq_send", args);
    try {
      await Promise.race([
        gate.entered.promise,
        pending.then(() => assert.fail("send never reached gateway")),
      ]);
      f.runtime.config.connections[0].messageIdNamespace =
        "synthetic-new-namespace";
    } finally {
      gate.release.resolve();
    }
    const sent = await pending;
    assert.equal(sent.status, "sent");
    assert.equal(sent.readCheckpoint?.applied, false);
    const archived = JSON.parse(
      f.mem.db
        .prepare("SELECT payload FROM events WHERE id=?")
        .get(sent.recordId).payload,
    );
    assert.equal(archived.messageNamespace, originalNamespace);
    const dispositions = f.mem.db
      .prepare(
        "SELECT scope,reviewed_deliveries FROM input_versions WHERE id=?",
      )
      .all(a.id);
    const old = dispositions.find(
      ({ scope }) => JSON.parse(scope)[4] === originalNamespace,
    );
    assert.deepEqual(JSON.parse(old.reviewed_deliveries), [
      f.mem.db.prepare("SELECT request_id FROM deliveries").get().request_id,
    ]);
    assert(
      dispositions.every(
        ({ scope, reviewed_deliveries }) =>
          JSON.parse(scope)[4] === originalNamespace ||
          reviewed_deliveries === "[]",
      ),
    );
    assert.equal(f.gateway.sent.length, 1);
  },
);

test(
  "ordinary post-ACK conversation bookkeeping cannot hide the confirmed receipt",
  { timeout: 10000 },
  async (t) => {
    const f = setup(t);
    const args = { requestId: "after-ack-state-fault", text: "合成已发送" };
    const write = t.mock.method(f.runtime.conversations, "sent", () => {
      throw Error("SYNTHETIC_CONVERSATION_STATE_FAILURE");
    });
    const receipt = await result(call(f, "qq_send", args));
    write.mock.restore();
    const id = f.mem.db
      .prepare("SELECT request_id FROM deliveries")
      .get().request_id;
    const exact = f.mem.delivery(id);
    assert.equal(exact.status, "sent");
    assert.equal(receipt.status, "sent");
    assert.equal(receipt.messageId, exact.message_id);
    assert(receipt.recordId);
    const reused = await call(f, "qq_send", args);
    assert.equal(reused.duplicate, true);
    assert.equal(reused.messageId, receipt.messageId);
    assert.equal(f.gateway.sent.length, 1);
  },
);

test("attaching a legacy prefix keeps its old request an exact receipt query", async (t) => {
  const f = setup(t);
  f.runtime.agent("agent-0").tools.push("qq_send_burst");
  const original = { requestId: "legacy-prefix:0", text: "合成已发前缀" };
  const sent = await f.runtime.send(f.ctx, original);
  const burst = await call(f, "qq_send_burst", {
    requestId: "legacy-prefix",
    messages: [original.text, "合成未发尾部"],
    gapMs: 0,
  });
  assert.deepEqual(
    burst.draft.items.map(({ status }) => status),
    ["sent", "unsubmitted"],
  );
  assert.equal(burst.receipts[0].messageId, sent.messageId);
  const exact = await call(f, "qq_send", original);
  assert.equal(exact.status, "sent");
  assert.equal(exact.duplicate, true);
  assert.equal(exact.messageId, sent.messageId);
  await assert.rejects(
    call(f, "qq_send", { ...original, text: "合成不同载荷" }),
    /IDEMPOTENCY_CONFLICT/,
  );
  assert.deepEqual(attemptBodies(f.mem), [original.text]);
  assert.equal(f.gateway.sent.length, 1);
});

test("legacy receipt lookup and prefix attachment recheck historical source protection", async (t) => {
  const f = setup(t);
  f.runtime.agent("agent-0").tools.push("qq_send_burst");
  const original = { requestId: "protected-prefix:0", text: "合成保护前缀" };
  await f.runtime.send(f.ctx, original);
  const { id } = f.mem.db
    .prepare("SELECT id FROM events WHERE dedupe=?")
    .get("send:protected-prefix:0:pending");
  f.mem.db
    .prepare(
      "UPDATE events SET payload=json_set(payload,'$.protectedRepositories',json(?)) WHERE id=?",
    )
    .run(JSON.stringify(["synthetic/private-repo"]), id);

  await assert.rejects(
    call(f, "memory_read", { id }),
    /RECALL_SOURCE_NOT_ALLOWED/,
  );
  await assert.rejects(
    call(f, "qq_send", original),
    /RECALL_SOURCE_NOT_ALLOWED/,
  );
  const burst = await result(
    call(f, "qq_send_burst", {
      requestId: "protected-prefix",
      messages: [original.text, "合成未发尾部"],
    }),
  );
  assert.equal(burst.code ?? burst.error, "RECALL_SOURCE_NOT_ALLOWED");
  assert.equal(burst.receipts?.length ?? 0, 0);
  assert.equal(
    f.mem.db.prepare("SELECT count(*) AS n FROM qq_drafts").get().n,
    0,
  );
  assert.equal(f.gateway.sent.length, 1);
});
