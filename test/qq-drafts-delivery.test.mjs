import { safeToolFailure } from "../src/tools/errors.mjs";
import { draftScope } from "../src/core/draft-delivery.mjs";
import { MemoryStore } from "../src/memory/store.mjs";
import { QQDraftStore } from "../src/memory/qq-drafts.mjs";
import { restoreExport } from "../src/memory/migrate.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { fixture, config, context, raw } from "./helpers.mjs";
import { recoverDraftArchives } from "../src/core/draft-delivery.mjs";

test("entire burst exists before the first gateway submission", async (t) => {
  const cfg = config(1);
  cfg.agents[0].tools.push("qq_send_burst");
  const f = fixture(t, { cfg }),
    ctx = context(f.runtime),
    transport = f.runtime.transports.get("qq-0");
  const original = transport.send.bind(transport);
  transport.send = async (...args) => {
    const rows = f.store.db
      .prepare("SELECT value FROM qq_draft_items ORDER BY position")
      .all();
    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map((r) => JSON.parse(r.value).text),
      ["one", "two", "three"],
    );
    return original(...args);
  };
  const result = await f.runtime.callTool(ctx, "qq_send_burst", {
    requestId: "draft-whole",
    messages: ["one", "two", "three"],
    gapMs: 0,
  });
  assert.equal(result.status, "sent");
  assert.equal(transport.sent.length, 3);
});

test("failed local archive after ACK never downgrades or resends", async (t) => {
  const f = fixture(t, { cfg: config(1) }),
    ctx = context(f.runtime),
    mem = f.store.bind("agent-0");
  const prototype = Object.getPrototypeOf(mem),
    append = prototype.append;
  const mocked = t.mock.method(prototype, "append", function (event) {
    if (event.dedupe === "send:draft-ack:sent")
      throw Error("fixture archive fault");
    return append.call(this, event);
  });
  const result = await f.runtime.callTool(ctx, "qq_send", {
    requestId: "draft-ack",
    text: "confirmed fixture",
  });
  assert.equal(result.status, "sent");
  assert.equal(result.archivePending, true);
  assert.equal(mem.delivery("draft-ack").status, "sent");
  assert.equal(f.runtime.drafts.unarchived().length, 1);
  mocked.mock.restore();
  recoverDraftArchives(f.store, f.runtime.drafts);
  recoverDraftArchives(f.store, f.runtime.drafts);
  assert.equal(f.runtime.drafts.unarchived().length, 0);
  assert.equal(
    f.store.db
      .prepare(
        "SELECT count(*) n FROM events WHERE dedupe='send:draft-ack:sent'",
      )
      .get().n,
    1,
  );
  assert.equal(f.runtime.transports.get("qq-0").sent.length, 1);
});

test("concurrent normal sends wait for tracked pending delivery", async (t) => {
  const f = fixture(t, { cfg: config(1) }),
    ctx = context(f.runtime),
    transport = f.runtime.transports.get("qq-0");
  const original = transport.send.bind(transport);
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  transport.send = async (...args) => {
    if (!transport.sent.length) await gate;
    return original(...args);
  };
  const first = f.runtime.callTool(ctx, "qq_send", {
    requestId: "draft-concurrent-a",
    text: "first fixture",
  });
  const second = f.runtime.callTool(ctx, "qq_send", {
    requestId: "draft-concurrent-b",
    text: "second fixture",
  });
  release();
  const results = await Promise.all([first, second]);
  assert(results.every((x) => x.status === "sent"));
  assert.equal(transport.sent.length, 2);
});

test("an old unlinked unknown receipt blocks new copies only in its scope", async (t) => {
  const f = fixture(t, { cfg: config(1) }),
    ctx = context(f.runtime),
    transport = f.runtime.transports.get("qq-0");
  transport.failure = "fixture timeout";
  await assert.rejects(
    f.runtime.send(ctx, {
      requestId: "legacy-unknown",
      text: "uncertain fixture",
    }),
    /DELIVERY_UNKNOWN/,
  );
  assert.equal(
    f.store.db.prepare("SELECT count(*) n FROM qq_drafts").get().n,
    0,
  );
  transport.failure = null;
  await assert.rejects(
    f.runtime.callTool(ctx, "qq_send", {
      requestId: "copy-new-id",
      text: "different fixture",
    }),
    /QQ_DRAFT_DELIVERY_UNRESOLVED/,
  );
  assert.equal(transport.sent.length, 1);
  const other = context(f.runtime, "agent-0", "group:20001");
  assert.equal(
    (
      await f.runtime.callTool(other, "qq_send", {
        requestId: "other-scope",
        text: "other fixture",
      })
    ).status,
    "sent",
  );
  assert.equal(transport.sent.length, 2);
});

test("a new context must explicitly review the saved draft even after seeing its complete opening", async (t) => {
  const cfg = config(1);
  cfg.agents[0].wake.participation = 0;
  const f = fixture(t, { cfg });
  const ctx = context(f.runtime);
  await f.runtime.ingest("qq-0", raw(1, { message: "条件已修改" }));
  let first;
  await assert.rejects(
    f.runtime.callTool(ctx, "qq_send", {
      requestId: "draft-cross-turn",
      text: "等待核对的稿件",
    }),
    (error) => {
      first = safeToolFailure(error);
      return first.code === "INPUT_REVIEW_REQUIRED";
    },
  );
  assert(first.inputReview.token);
  f.runtime.abortContext(ctx, "test-ended");
  const next = context(f.runtime);
  await f.runtime.callTool(next, "conversation_read", {});
  next.openingReviewInput = new Map(next.presentedReviewInput);
  const input = {
    action: "continue",
    draftId: first.draft.draftId,
    expectedVersion: first.draft.version,
  };
  let challenge;
  await assert.rejects(f.runtime.callTool(next, "qq_draft", input), (error) => {
    challenge = safeToolFailure(error);
    return challenge.code === "INPUT_REVIEW_REQUIRED";
  });
  assert.notEqual(challenge.inputReview.token, first.inputReview.token);
  assert.equal(f.runtime.transports.get("qq-0").sent.length, 0);
  const sent = await f.runtime.callTool(next, "qq_draft", {
    ...input,
    inputReview: { token: challenge.inputReview.token, decision: "continue" },
  });
  assert.equal(sent.status, "sent");
  assert.equal(f.runtime.transports.get("qq-0").sent.length, 1);
});

test("cancelling a burst during its gap leaves the remainder available without another attempt", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const cfg = config(1);
  cfg.agents[0].tools.push("qq_send_burst");
  const f = fixture(t, { cfg });
  const ctx = context(f.runtime);
  const p = f.runtime.callTool(ctx, "qq_send_burst", {
    requestId: "draft-cancel",
    messages: ["示例一", "示例二"],
    gapMs: 20000,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.runtime.transports.get("qq-0").sent.length, 1);
  f.runtime.abortContext(ctx, "test-cancelled");
  const stopped = await p;
  assert.deepEqual(
    stopped.draft.items.map(({ status }) => status),
    ["sent", "unsubmitted"],
  );
  const fresh = context(f.runtime);
  const listed = await f.runtime.callTool(fresh, "qq_draft", {
    action: "list",
  });
  assert.equal(listed.items[0].draftId, stopped.draft.draftId);
  const continued = await f.runtime.callTool(fresh, "qq_draft", {
    action: "continue",
    draftId: stopped.draft.draftId,
    expectedVersion: stopped.draft.version,
  });
  assert.equal(continued.status, "sent");
  assert.equal(f.runtime.transports.get("qq-0").sent.length, 2);
});

test("an unknown draft is locked across tool calls and reconciliation reuses its archive", async (t) => {
  const cfg = config(1);
  cfg.agents[0].tools.push("qq_send_poke");
  const f = fixture(t, { cfg });
  const ctx = context(f.runtime);
  const transport = f.runtime.transports.get("qq-0");
  transport.failure = "TIMEOUT";
  let failed;
  await assert.rejects(
    f.runtime.callTool(ctx, "qq_send", {
      requestId: "draft-unknown",
      text: "不确定是否送达",
    }),
    (error) => {
      failed = safeToolFailure(error);
      return failed.code === "DELIVERY_UNKNOWN";
    },
  );
  transport.failure = null;
  assert.equal(failed.draft.items[0].status, "unknown");
  await assert.rejects(
    f.runtime.callTool(ctx, "qq_send_poke", {
      requestId: "different-tool",
      userId: "30000",
    }),
    /QQ_DRAFT_DELIVERY_UNRESOLVED/,
  );
  const lookup = await f.runtime.callTool(ctx, "qq_delivery_status", {});
  assert.equal(lookup.items[0].status, "unknown");
  const mem = f.store.bind("agent-0");
  mem.reconcileDelivery("draft-unknown", "sent");
  const read = await f.runtime.callTool(ctx, "qq_draft", {
    action: "read",
    draftId: failed.draft.draftId,
  });
  assert.equal(read.items[0].status, "sent");
  assert(read.items[0].recordId);
  assert.equal(f.runtime.drafts.unarchived().length, 0);
  assert.equal(transport.sent.length, 1);
  assert.equal(
    (
      await f.runtime.callTool(ctx, "qq_send", {
        requestId: "resolved-chat",
        text: "新的回复",
      })
    ).status,
    "sent",
  );
});

test("a role archive restores pending draft receipts conservatively and rejects broken associations", async (t) => {
  const f = fixture(t, { cfg: config(1) });
  const ctx = context(f.runtime);
  const scope = draftScope(f.runtime, ctx);
  const mem = f.store.bind(scope.agentId);
  const sent = await f.runtime.callTool(ctx, "qq_send", {
    requestId: "draft-import-sent",
    text: "归档成功",
  });
  const pending = f.runtime.drafts.stage(scope, {
    toolName: "qq_send",
    requestId: "draft-import-pending",
    items: [{ requestId: "draft-import-pending", input: { text: "保留未知" } }],
    value: {
      basis: {
        items: [
          {
            id: "fixture-event",
            seq: 1,
            kind: "message.received",
            version: "fixture-version",
          },
        ],
      },
    },
  }).draft;
  f.store.transaction(() => {
    mem.reserveDelivery("draft-import-pending", scope.conversation, {});
    f.runtime.drafts.bindDelivery(
      scope,
      { id: pending.id, revision: 1, position: 0 },
      "draft-import-pending",
    );
    mem.append({
      dedupe: "send:draft-import-pending:pending",
      connectionId: scope.connectionId,
      conversation: scope.conversation,
      senderId: scope.accountId,
      kind: "message.send-attempt",
      direction: "out",
      status: "pending",
      payload: { requestId: "draft-import-pending" },
    });
  });
  const source = mem.export();
  const target = new MemoryStore(":memory:");
  t.after(() => target.close());
  target.bind("different-agent").append({
    dedupe: "other-event",
    conversation: scope.conversation,
    kind: "message.received",
  });
  restoreExport(target.bind(scope.agentId), source);
  const restored = new QQDraftStore(target);
  assert.deepEqual(restored.read(scope, pending.id).value.historicalBasis, [
    { id: "fixture-event", kind: "message.received" },
  ]);
  assert.equal(
    restored.read(scope, sent.draft.draftId).items[0].status,
    "sent",
  );
  assert.equal(restored.unresolved(scope).status, "unknown");
  assert.throws(
    () => restored.assertEditable(scope, pending.id, 1),
    /QQ_DRAFT_IMPORTED/,
  );

  const broken = structuredClone(source);
  delete broken.tables.qq_draft_items;
  const invalid = new MemoryStore(":memory:");
  t.after(() => invalid.close());
  assert.throws(
    () => restoreExport(invalid.bind(scope.agentId), broken),
    /EXPORT_INTEGRITY_FAILED/,
  );
  broken.tables.qq_draft_items = [];
  assert.throws(
    () => restoreExport(invalid.bind(scope.agentId), broken),
    /QQ_DRAFT_INVALID/,
  );
  broken.tables.qq_draft_items = structuredClone(source.tables.qq_draft_items);
  const falseRecord = broken.tables.events.find(
    (row) => row.id === sent.recordId,
  );
  falseRecord.direction = "in";
  falseRecord.kind = "notice";
  falseRecord.message_id = "45678";
  assert.throws(
    () => restoreExport(invalid.bind(scope.agentId), broken),
    /QQ_DRAFT_ARCHIVE_MISMATCH/,
  );
});
