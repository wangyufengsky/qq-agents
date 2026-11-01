import test from "node:test";
import assert from "node:assert/strict";
import { config, fixture, context, raw } from "./helpers.mjs";
import { freezeEvidence, evidenceView } from "../src/memory/evidence.mjs";

async function unknownAction(t, kind) {
  const cfg = config(1),
    a = cfg.agents[0];
  a.tools.push("qq_react", "qq_recall", "qq_send_poke");
  a.behavior.actions = { react: true, recall: true };
  const f = fixture(t, { cfg }),
    ctx = context(f.runtime, a.id, "private:30000"),
    mem = f.store.bind(a.id);
  const source = await f.runtime.send(ctx, {
    requestId: "source",
    text: "用于核对的一条普通消息",
  });
  const transport = f.runtime.transports.get("qq-0");
  let attempts = 0;
  const timeout = async () => {
    attempts++;
    throw Object.assign(Error("ONEBOT_REJECTED"), {
      reason: "GATEWAY_TIMEOUT",
    });
  };
  transport.react = timeout;
  transport.recall = timeout;
  transport.call = timeout;
  const send = () =>
    f.runtime.callTool(
      ctx,
      kind === "react"
        ? "qq_react"
        : kind === "recall"
          ? "qq_recall"
          : "qq_send_poke",
      {
        requestId: "unknown-action",
        ...(kind === "poke" ? {} : { messageRef: source.recordId }),
        ...(kind === "react" ? { faceId: "28" } : {}),
      },
    );
  await assert.rejects(send(), /DELIVERY_UNKNOWN/);
  const row = () =>
    mem.db
      .prepare("SELECT * FROM events WHERE agent_id=? AND dedupe=?")
      .get(a.id, "send:unknown-action:pending");
  const pending = row();
  assert.equal(JSON.parse(pending.payload).deliveryType, "action");
  assert.equal(JSON.parse(pending.payload).actionKind, kind);
  return {
    ...f,
    ctx,
    mem,
    source,
    transport,
    send,
    pending,
    attempts: () => attempts,
  };
}

for (const kind of ["react", "recall", "poke"]) {
  test(`a literal text echo cannot settle an unknown ${kind}, while real text with identical wording still can`, async (t) => {
    const f = await unknownAction(t, kind);
    await f.runtime.ingest(
      "qq-0",
      raw(90000, {
        post_type: "message_sent",
        message_type: "private",
        group_id: undefined,
        user_id: 30000,
        message: [{ type: "text", data: { text: f.pending.body } }],
      }),
    );
    assert.equal(f.mem.delivery("unknown-action").status, "unknown");
    assert.equal(f.mem.recallAnnotation(f.source.recordId).recalled, undefined);
    f.transport.failure = "TIMEOUT";
    await assert.rejects(
      f.runtime.send(context(f.runtime, "agent-0", f.ctx.conversation), {
        requestId: "literal-text",
        text: f.pending.body,
      }),
      /DELIVERY_UNKNOWN/,
    );
    assert.deepEqual(
      f.mem.reconcileFromEcho({
        conversation: f.ctx.conversation,
        text: f.pending.body,
        messageId: "90001",
      }),
      { requestId: "literal-text", status: "sent" },
    );
    assert.equal(f.mem.delivery("unknown-action").status, "unknown");
    assert.equal(f.mem.delivery("literal-text").message_id, "90001");
    assert.equal(f.attempts(), 1);
  });

  for (const resolution of ["sent", "failed"])
    test(`administrator ${resolution} verdict on unknown ${kind} preserves metadata and never creates a text identity`, async (t) => {
      const f = await unknownAction(t, kind);
      const original = JSON.parse(f.pending.payload);
      const metadata = {
        ...original,
        referenceNamespace: "onebot",
        protectedRepositories: ["owner/private-repo"],
        protectedOperations: true,
        atUserId: "30000",
        referenceProof: { source: f.source.recordId },
      };
      f.mem.db
        .prepare("UPDATE events SET payload=? WHERE id=?")
        .run(JSON.stringify(metadata), f.pending.id);
      const snapshot = freezeEvidence(f.mem, [f.source.recordId], Date.now());
      f.mem.identity.savePersonCard(
        { personId: "30000", body: "一次谈话", evidence: [f.source.recordId] },
        { author: "admin", now: Date.now() },
      );
      assert.deepEqual(
        f.mem.reconcileDelivery("unknown-action", resolution, {
          messageId: "not-an-action-message",
        }),
        { requestId: "unknown-action", status: resolution },
      );
      const row = f.mem.db
        .prepare("SELECT * FROM events WHERE agent_id=? AND dedupe=?")
        .get("agent-0", "send:unknown-action:reconciled");
      assert.equal(
        row.kind,
        resolution === "sent" ? "action.confirmed" : "message.send-result",
      );
      assert.equal(row.status, resolution === "sent" ? "confirmed" : "failed");
      assert.equal(row.message_id, null);
      assert.equal(f.mem.delivery("unknown-action").message_id, null);
      const payload = JSON.parse(row.payload);
      for (const [key, value] of Object.entries(metadata))
        assert.deepEqual(payload[key], value, key);
      assert.equal(payload.reconciledBy, "administrator");
      assert.equal(payload.resolution, resolution);
      assert.equal(payload.messageId, undefined);
      const identities = f.mem.db
        .prepare(
          "SELECT * FROM message_identities WHERE agent_id=? AND event_id=?",
        )
        .all("agent-0", row.id);
      assert.deepEqual(identities, []);
      const recalled = kind === "recall" && resolution === "sent";
      assert.equal(
        !!f.mem.recallAnnotation(f.source.recordId).recalled,
        recalled,
      );
      assert.equal(!!f.mem.view({ id: f.source.recordId }).recalled, recalled);
      assert.equal(
        !!evidenceView(f.mem, { evidenceSnapshot: snapshot }).references[0]
          .recalled,
        recalled,
      );
      assert.equal(
        !!f.mem.identity.personCard("30000").recalledEvidence?.length,
        recalled,
      );
      assert.throws(
        () => f.mem.reconcileDelivery("unknown-action", resolution),
        /DELIVERY_ALREADY_SETTLED/,
      );
      assert.equal(
        f.mem.db
          .prepare(
            "SELECT count(*) AS n FROM events WHERE agent_id=? AND dedupe=?",
          )
          .get("agent-0", "send:unknown-action:reconciled").n,
        1,
      );
      if (resolution === "sent") assert.equal((await f.send()).duplicate, true);
      else await assert.rejects(f.send(), /DELIVERY_ALREADY_ATTEMPTED_FAILED/);
      assert.equal(f.attempts(), 1);
    });
}

for (const kind of ["react", "recall"])
  test(`legacy ${kind} actionKind is enough for echo exclusion and action confirmation`, async (t) => {
    const f = await unknownAction(t, kind),
      payload = JSON.parse(f.pending.payload);
    delete payload.deliveryType;
    f.mem.db
      .prepare("UPDATE events SET payload=? WHERE id=?")
      .run(JSON.stringify(payload), f.pending.id);
    assert.equal(
      f.mem.reconcileFromEcho({
        conversation: f.ctx.conversation,
        text: f.pending.body,
        messageId: "90000",
      }),
      null,
    );
    assert.equal(f.mem.delivery("unknown-action").status, "unknown");
    f.mem.reconcileDelivery("unknown-action", "sent");
    const confirmed = f.mem.db
      .prepare("SELECT kind,payload FROM events WHERE agent_id=? AND dedupe=?")
      .get("agent-0", "send:unknown-action:reconciled");
    assert.equal(confirmed.kind, "action.confirmed");
    assert.equal(JSON.parse(confirmed.payload).actionKind, kind);
    assert.equal(
      !!f.mem.recallAnnotation(f.source.recordId).recalled,
      kind === "recall",
    );
  });
