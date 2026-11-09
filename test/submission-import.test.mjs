import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../src/memory/store.mjs";
import { QQDraftStore } from "../src/memory/qq-drafts.mjs";
import { restoreExport } from "../src/memory/migrate.mjs";

for (const status of ["pending", "sent"]) {
  test(`logical import retains ${status} delivery identity without checkpoint authority`, (t) => {
    const source = new MemoryStore(":memory:");
    const target = new MemoryStore(":memory:");
    t.after(() => {
      source.close();
      target.close();
    });
    const scope = {
      agentId: "agent-0",
      connectionId: "qq-0",
      accountId: "10000",
      conversation: "group:20000",
    };
    const memory = source.bind(scope.agentId);
    const requestId = `portable-${status}`;
    const checkpoint = {
      scope: "original-scope",
      throughSeq: 7,
      refs: [{ id: "original-input", seq: 7, version: "original-version" }],
    };
    const review = { scope: checkpoint.scope, refs: checkpoint.refs };
    const drafts = new QQDraftStore(source);
    const draft = drafts.stage(scope, {
      toolName: "qq_send",
      requestId,
      items: [{ requestId, input: { text: "synthetic reply" } }],
      value: {
        checkpointIntent: { ...checkpoint, epoch: "old-epoch" },
        origin: "old-origin",
        baseline: { revision: 1 },
        basis: { items: [{ ...checkpoint.refs[0], kind: "message.received" }] },
      },
    }).draft;
    memory.reserveDelivery(requestId, scope.conversation, {
      text: "synthetic reply",
    });
    source.transaction(() =>
      drafts.bindDelivery(
        scope,
        { id: draft.id, revision: 1, position: 0 },
        requestId,
      ),
    );
    memory.append({
      dedupe: `send:${requestId}:pending`,
      connectionId: scope.connectionId,
      conversation: scope.conversation,
      senderId: scope.accountId,
      kind: "message.send-attempt",
      direction: "out",
      status: "pending",
      payload: {
        requestId,
        submission: {
          version: 1,
          draftId: draft.id,
          draftVersion: 1,
          position: 0,
          executionId: "original-execution",
          review,
          checkpoint,
        },
      },
    });
    if (status === "sent") memory.completeDelivery(requestId, "sent", "30000");
    memory.setState(scope.conversation, {
      ...memory.state(scope.conversation),
      readCheckpointReceipts: {
        [requestId]: { sentReceipt: true, checkpoint },
      },
    });
    const archive = memory.export();
    const originalHash = archive.tables.qq_drafts[0].request_hash;
    const originalDelivery = memory.delivery(requestId);
    const originalArchive = JSON.stringify(archive);
    target.bind("other-agent").append({
      dedupe: "other-fixture",
      kind: "fixture",
      conversation: "group:20000",
    });
    const restored = target.bind(scope.agentId);
    restoreExport(restored, archive);
    const imported = new QQDraftStore(target).read(scope, draft.id);
    const restoredRow = restored.export().tables.qq_drafts[0];
    assert.equal(restoredRow.request_hash, originalHash);
    assert.equal(imported.value.creationVersion, draft.value.creationVersion);
    assert.equal(imported.imported, true);
    assert.equal(imported.value.checkpointIntent, undefined);
    assert.equal(imported.value.origin, undefined);
    assert.equal(imported.value.baseline, undefined);
    assert.equal(imported.value.basis, undefined);
    assert.deepEqual(imported.value.historicalBasis, [
      { id: "original-input", kind: "message.received" },
    ]);
    const delivery = restored.delivery(requestId);
    assert.equal(delivery.status, status === "pending" ? "unknown" : "sent");
    assert.equal(delivery.payload_hash, originalDelivery.payload_hash);
    assert.equal(delivery.message_id, originalDelivery.message_id);
    const attempt = restored
      .export()
      .tables.events.find((row) => row.kind === "message.send-attempt");
    const submission = JSON.parse(attempt.payload).submission;
    assert.equal(submission.checkpoint, undefined);
    assert.deepEqual(submission.review, review);
    assert.equal(submission.executionId, "original-execution");
    assert.equal(
      restored.state(scope.conversation).readCheckpointReceipts,
      undefined,
    );
    assert.throws(
      () => new QQDraftStore(target).assertEditable(scope, draft.id, 1),
      /QQ_DRAFT_IMPORTED/,
    );
    assert.equal(JSON.stringify(archive), originalArchive);
  });
}
