import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { behaviorSchema } from "../src/core/policy.mjs";
import { MemoryStore } from "../src/memory/store.mjs";
import {
  createDraftTables,
  DRAFT_LIFETIME_MS,
  QQDraftStore,
} from "../src/memory/qq-drafts.mjs";
import { temp } from "./helpers.mjs";

const scope = {
  agentId: "agent-0",
  connectionId: "qq-0",
  accountId: "10000",
  conversation: "group:20000",
};

function setup(t, file = ":memory:") {
  const store = new MemoryStore(file);
  t.after(() => store.close());
  store.transaction(() => createDraftTables(store.db));
  let now = 1000;
  const drafts = new QQDraftStore(store, { clock: () => now });
  return {
    store,
    drafts,
    memory: store.bind(scope.agentId),
    advance: (duration) => (now += duration),
  };
}

function args(requestId = "draft-test") {
  return {
    toolName: "qq_send_burst",
    requestId,
    items: [0, 1, 2].map((position) => ({
      requestId: requestId + ":" + position,
      input: { text: "示例 " + position },
    })),
    value: { basis: { fromSeq: 0, items: [] }, gapMs: 20 },
  };
}

function reserve({ store, memory, drafts }, draft, position, requestId) {
  store.transaction(() => {
    memory.reserveDelivery(requestId, scope.conversation, [{ type: "text" }]);
    drafts.bindDelivery(
      scope,
      { id: draft.id, revision: draft.revision, position },
      requestId,
    );
  });
}

test("stages the whole group and duplicate lookup does not reserve any delivery", (t) => {
  const { memory, drafts } = setup(t);
  const first = drafts.stage(scope, args());
  assert.equal(first.created, true);
  assert.deepEqual(
    first.draft.items.map((item) => item.status),
    Array(3).fill("unsubmitted"),
  );
  assert.deepEqual(
    first.draft.items.map((item) => item.value.text),
    ["示例 0", "示例 1", "示例 2"],
  );
  assert.equal(memory.delivery("draft-test:0"), undefined);
  const next = drafts.stage(scope, args());
  assert.equal(next.created, false);
  assert.equal(next.draft.id, first.draft.id);
  assert.throws(
    () => drafts.stage(scope, { ...args(), items: args().items.slice(0, 2) }),
    /IDEMPOTENCY_CONFLICT/,
  );
  assert.throws(
    () =>
      drafts.stage(scope, { ...args(), value: { ...args().value, gapMs: 50 } }),
    /IDEMPOTENCY_CONFLICT/,
  );
  const collision = args("another");
  collision.items[2].requestId = "draft-test:2";
  const independent = drafts.stage(scope, collision).draft;
  assert.equal(independent.items[2].requestId, `draft:${independent.id}:1:2`);
  assert.equal(drafts.list(scope).items.length, 2);
});

test("versions serialize revision/discard and never overwrite a submitted child", (t) => {
  const f = setup(t);
  const input = args();
  input.value.protectedRepositories = ["owner/private-fixture"];
  const { draft } = f.drafts.stage(scope, input);
  reserve(f, draft, 0, draft.items[0].requestId);
  f.memory.completeDelivery(draft.items[0].requestId, "sent", "30000");
  assert.throws(
    () =>
      f.drafts.revise(
        scope,
        draft.id,
        1,
        [{ position: 0, input: { text: "替换" } }],
        {},
      ),
    /QQ_DRAFT_ITEM_LOCKED/,
  );
  const revised = f.drafts.revise(
    scope,
    draft.id,
    1,
    [{ position: 1, input: { text: "修订" } }],
    {},
  );
  assert.equal(revised.revision, 2);
  assert.equal(revised.items[0].revision, 1);
  assert.equal(revised.items[0].status, "sent");
  assert.equal(revised.items[1].revision, 2);
  assert.equal(revised.items[1].value.text, "修订");
  assert.notEqual(revised.items[1].requestId, draft.items[1].requestId);
  assert.deepEqual(revised.value.protectedRepositories, [
    "owner/private-fixture",
  ]);
  assert.throws(
    () => reserve(f, draft, 2, "old-version"),
    /QQ_DRAFT_REVISION_CONFLICT/,
  );
  assert.equal(
    f.memory.delivery("old-version"),
    undefined,
    "the reservation rolls back too",
  );
  assert.throws(
    () => f.drafts.discard(scope, draft.id, 1),
    /QQ_DRAFT_REVISION_CONFLICT/,
  );
  assert.deepEqual(
    f.drafts.discard(scope, draft.id, 2).items.map((item) => item.status),
    ["sent", "abandoned", "abandoned"],
  );
  assert.equal(f.drafts.list(scope).items.length, 0);
  assert.equal(f.drafts.list(scope, { includeSettled: true }).items.length, 1);
  assert.equal(f.drafts.stage(scope, input).draft.revision, 3);
});

test("a rolled-back reservation cannot leave either a delivery or a draft link", (t) => {
  const f = setup(t);
  const { draft } = f.drafts.stage(scope, args());
  const requestId = draft.items[0].requestId;
  const ref = { id: draft.id, revision: draft.revision, position: 0 };
  assert.throws(
    () => f.drafts.bindDelivery(scope, ref, requestId),
    /QQ_DRAFT_TRANSACTION_REQUIRED/,
  );
  assert.throws(
    () =>
      f.store.transaction(() => {
        f.memory.reserveDelivery(requestId, scope.conversation, [
          { type: "text" },
        ]);
        f.drafts.bindDelivery(scope, ref, requestId);
        assert.equal(f.drafts.read(scope, draft.id).items[0].status, "pending");
        throw Error("fixture transaction failure");
      }),
    /fixture transaction failure/,
  );
  assert.equal(f.memory.delivery(requestId), undefined);
  assert.equal(f.drafts.read(scope, draft.id).items[0].status, "unsubmitted");
  assert.equal(f.drafts.unresolved(scope), undefined);
});

test("unknown lock follows the ledger across process restarts, expiry and other scopes", (t) => {
  const file = path.join(temp(t), "memory.sqlite");
  const f = setup(t, file);
  const { draft } = f.drafts.stage(scope, args());
  const link = draft.items[0].requestId;
  reserve(f, draft, 0, link);
  assert.equal(f.drafts.unresolved(scope).status, "pending");
  f.store.interruptDeliveries();
  const recovered = setup(t, file);
  assert.equal(recovered.drafts.unresolved(scope).status, "unknown");
  const same = recovered.drafts.stage(scope, args());
  assert.equal(same.created, false);
  assert.equal(same.draft.items[0].status, "unknown");
  for (const other of [
    { ...scope, conversation: "group:20001" },
    { ...scope, accountId: "10001" },
    { ...scope, connectionId: "qq-1" },
    { ...scope, agentId: "agent-1" },
  ]) {
    assert.equal(recovered.drafts.unresolved(other), undefined);
    assert.throws(
      () => recovered.drafts.read(other, draft.id),
      /QQ_DRAFT_NOT_FOUND/,
    );
  }
  assert.throws(
    () => recovered.drafts.stage(scope, args("different-id")),
    /QQ_DRAFT_DELIVERY_UNRESOLVED/,
  );
  recovered.advance(DRAFT_LIFETIME_MS);
  assert.deepEqual(
    recovered.drafts.read(scope, draft.id).items.map((item) => item.status),
    ["unknown", "expired", "expired"],
  );
  assert.throws(
    () => recovered.drafts.discard(scope, draft.id, 1),
    /QQ_DRAFT_EXPIRED/,
  );
  assert.equal(recovered.drafts.list(scope).items[0].id, draft.id);
  assert.throws(
    () => recovered.drafts.stage(scope, args("still-unresolved")),
    /QQ_DRAFT_DELIVERY_UNRESOLVED/,
  );
  recovered.memory.reconcileDelivery(link, "failed");
  assert.equal(recovered.drafts.unresolved(scope), undefined);
  assert.equal(recovered.drafts.list(scope).items.length, 0);
  assert.equal(recovered.drafts.stage(scope, args("fresh-id")).created, true);
});

test("a confirmation marker survives before local archiving and never regresses to unknown", (t) => {
  const file = path.join(temp(t), "memory.sqlite");
  const f = setup(t, file);
  const { draft } = f.drafts.stage(scope, args());
  const link = draft.items[0].requestId;
  reserve(f, draft, 0, link);
  const confirmation = { messageNamespace: "onebot", action: false };
  f.store.transaction(() => {
    f.memory.completeDelivery(link, "sent", "30000");
    assert.equal(
      f.drafts.recordConfirmation(scope.agentId, link, confirmation),
      true,
    );
  });
  f.store.interruptDeliveries();
  const recovered = setup(t, file);
  const [archival] = recovered.drafts.unarchived();
  assert.equal(archival.messageId, "30000");
  assert.equal(archival.requestId, link);
  assert.deepEqual(archival.confirmation, confirmation);
  assert.equal(recovered.drafts.read(scope, draft.id).items[0].status, "sent");
  assert.equal(recovered.drafts.unresolved(scope), undefined);
  recovered.store.transaction(() => {
    const record = recovered.memory.append({
      dedupe: "send:" + link + ":sent",
      connectionId: scope.connectionId,
      conversation: scope.conversation,
      kind: "message.sent",
      direction: "out",
      senderId: scope.accountId,
      status: "confirmed",
      messageId: "30000",
      body: "示例",
      payload: { requestId: link, messageNamespace: "onebot" },
    });
    recovered.drafts.recordArchive(scope.agentId, link, record.id);
    assert.equal(
      recovered.drafts.read(scope, draft.id).items[0].recordId,
      record.id,
    );
  });
  assert.deepEqual(recovered.drafts.unarchived(), []);
});

test("creation identity is canonical, immutable and distinct from revised or discarded versions", (t) => {
  const { store, drafts } = setup(t);
  const input = args("creation");
  input.creation = {
    items: [{ text: "初稿", atUserId: "30000" }],
    gapMs: 20,
    readThroughSeq: 8,
  };
  const created = drafts.stage(scope, input);
  assert.equal(created.superseded, false);
  const { draft } = created;
  const initialHash = drafts.find(
    scope,
    input.toolName,
    input.requestId,
  ).request_hash;
  assert.equal(draft.value.creationVersion, 2);
  const equivalent = {
    ...input,
    creation: {
      readThroughSeq: 8,
      gapMs: 20,
      items: [{ atUserId: "30000", text: "初稿" }],
    },
    value: { ...input.value, basis: { fromSeq: 9 } },
  };
  assert.equal(drafts.stage(scope, equivalent).draft.id, draft.id);
  for (const change of [
    { readThroughSeq: 9 },
    { gapMs: 30 },
    { items: [{ text: "异文" }] },
  ])
    assert.throws(
      () =>
        drafts.stage(scope, {
          ...input,
          creation: { ...input.creation, ...change },
        }),
      /IDEMPOTENCY_CONFLICT/,
    );
  assert.throws(
    () => drafts.stage(scope, { ...input, toolName: "qq_send" }),
    /IDEMPOTENCY_CONFLICT/,
  );
  drafts.revise(
    scope,
    draft.id,
    draft.revision,
    [{ position: 0, input: { text: "修订稿" } }],
    {},
  );
  const replay = drafts.stage(scope, equivalent);
  assert.equal(replay.created, false);
  assert.equal(replay.superseded, true);
  assert.equal(replay.draft.items[0].value.text, "修订稿");
  assert.equal(
    drafts.find(scope, input.toolName, input.requestId).request_hash,
    initialHash,
  );

  const discarded = drafts.stage(scope, args("discard-only")).draft;
  drafts.discard(scope, discarded.id, discarded.revision);
  assert.equal(drafts.stage(scope, args("discard-only")).superseded, false);
  assert.equal(
    store.db.prepare("SELECT count(*) AS n FROM deliveries").get().n,
    0,
  );
});

test("a historical creation hash permits only its known comparison without backfilling missing parameters", (t) => {
  const { store, drafts } = setup(t);
  const input = args("legacy-creation");
  const { draft } = drafts.stage(scope, input);
  const oldHash = createHash("sha256")
    .update(
      JSON.stringify([
        input.items.map(({ input }) => input),
        input.value.gapMs,
      ]),
    )
    .digest("hex");
  store.db
    .prepare("UPDATE qq_drafts SET request_hash=?,value=? WHERE id=?")
    .run(oldHash, JSON.stringify(input.value), draft.id);
  const result = drafts.stage(scope, {
    ...input,
    creation: {
      items: input.items.map(({ input }) => input),
      gapMs: 20,
      readThroughSeq: 9,
    },
  });
  assert.equal(result.created, false);
  assert.equal(result.draft.value.creationVersion, undefined);
  assert.equal(
    drafts.find(scope, input.toolName, input.requestId).request_hash,
    oldHash,
  );
  assert.throws(
    () =>
      drafts.stage(scope, { ...input, value: { ...input.value, gapMs: 30 } }),
    /IDEMPOTENCY_CONFLICT/,
  );
});

test("open capacity is shared by one scope, with lookup before the limit and no eviction", (t) => {
  const file = path.join(temp(t), "draft-capacity.sqlite");
  const first = setup(t, file);
  const second = setup(t, file);
  const { drafts } = first;
  const existing = [];
  for (let i = 0; i < 4; i++) {
    const current = i % 2 ? second.drafts : drafts;
    existing.push(current.stage(scope, args("scope-" + i)).draft);
  }
  assert.equal(drafts.list(scope).items.length, 4);
  assert.throws(
    () => second.drafts.stage(scope, args("too-many")),
    /DRAFT_LIMIT_REACHED/,
  );
  assert.equal(
    second.drafts.stage(scope, args("scope-0")).draft.id,
    existing[0].id,
  );
  assert.equal(
    second.drafts.stage(
      { ...scope, conversation: "group:20001" },
      args("other-scope"),
    ).created,
    true,
  );
  drafts.discard(scope, existing[0].id, existing[0].revision);
  assert.equal(second.drafts.stage(scope, args("after-discard")).created, true);
  assert.equal(drafts.list(scope, { includeSettled: true }).items.length, 5);
  second.advance(DRAFT_LIFETIME_MS);
  assert.equal(second.drafts.list(scope).items.length, 0);
  const afterExpiry = second.drafts.stage(scope, {
    ...args("after-expiry"),
    maxOpenDrafts: 1,
  });
  assert.equal(afterExpiry.created, true);
  assert.throws(
    () =>
      second.drafts.stage(scope, {
        ...args("override-limit"),
        maxOpenDrafts: 1,
      }),
    /DRAFT_LIMIT_REACHED/,
  );
  for (const item of afterExpiry.draft.items) {
    reserve(second, afterExpiry.draft, item.position, item.requestId);
    second.memory.completeDelivery(
      item.requestId,
      item.position === 1 ? "failed" : "sent",
    );
  }
  assert.equal(second.drafts.list(scope).items.length, 0);
  assert.equal(
    second.drafts.stage(scope, { ...args("after-terminal"), maxOpenDrafts: 1 })
      .created,
    true,
  );
});

test("configured draft capacity defaults to four and validates integer limits", () => {
  assert.equal(behaviorSchema.parse({}).maxOpenDraftsPerConversation, 4);
  for (const value of [1, 16])
    assert.equal(
      behaviorSchema.parse({ maxOpenDraftsPerConversation: value })
        .maxOpenDraftsPerConversation,
      value,
    );
  for (const value of [0, 17, 1.5, "4"])
    assert.equal(
      behaviorSchema.safeParse({ maxOpenDraftsPerConversation: value }).success,
      false,
    );
});

test("scoped creation reuse never aliases another scope's actual attempt IDs", (t) => {
  const { drafts, memory } = setup(t);
  const input = args("cross-scope");
  const first = drafts.stage(scope, input).draft;
  const other = { ...scope, conversation: "group:20001" };
  const second = drafts.stage(other, input).draft;
  assert.notEqual(first.id, second.id);
  assert.equal(drafts.stage(other, input).draft.id, second.id);
  assert.equal(drafts.stage(scope, input).draft.id, first.id);
  assert.deepEqual(
    second.items.map(({ requestId }) => requestId),
    [0, 1, 2].map((position) => `draft:${second.id}:1:${position}`),
  );

  memory.reserveDelivery("standalone:0", scope.conversation, [
    { type: "text" },
  ]);
  const standalone = drafts.stage(other, args("standalone")).draft;
  assert.equal(standalone.items[0].requestId, `draft:${standalone.id}:1:0`);
  assert.equal(
    memory.delivery("standalone:0").conversation,
    scope.conversation,
  );
});
