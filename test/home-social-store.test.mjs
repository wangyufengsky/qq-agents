import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SocialStore } from "../src/home/social-store.mjs";
import { migrateHomeSocial } from "../src/home/social-schema.mjs";
import { MemoryStore } from "../src/memory/store.mjs";

const actor = { agentId: "agent-a", generation: "generation-a" };
function setup(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(
    "CREATE TABLE home_identities(agent_id TEXT PRIMARY KEY,generation TEXT,active INTEGER); INSERT INTO home_identities VALUES('agent-a','generation-a',1),('agent-b','generation-b',1)",
  );
  let now = 1000;
  const store = new SocialStore(db, {
    clock: () => {
      assert.equal(db.isTransaction, true);
      return now;
    },
  });
  return {
    db,
    store,
    setNow: (v) => {
      now = v;
    },
  };
}
function seed(db) {
  db.prepare(
    "INSERT INTO home_social_invitations(id,host_agent_id,host_generation,guest_agent_id,guest_generation,initiator_generation,recipient_generation,room_id,audience,requested_scope,status,policy_revision,created_at,expires_at) VALUES('invitation-a','agent-a','generation-a','agent-b','generation-b','generation-a','generation-b','room-a','[]','[\"layout\"]','accepted',0,100,5000)",
  ).run();
  db.prepare(
    "INSERT INTO home_social_visits(id,invitation_id,host_agent_id,host_generation,guest_agent_id,guest_generation,room_id,pair_key,status,policy_revision,started_at,expires_at) VALUES('visit-a','invitation-a','agent-a','generation-a','agent-b','generation-b','room-a','generation-a:generation-b','active',0,100,5000)",
  ).run();
  db.prepare(
    "INSERT INTO home_social_grants(visit_id,invitation_id,room_id,host_generation,guest_generation,scope,policy_revision,expires_at) VALUES('visit-a','invitation-a','room-a','generation-a','generation-b','[\"layout\"]',0,5000)",
  ).run();
}
const op = (apply, rest = {}) => ({
  actorIdentity: actor,
  requestId: "request-0001",
  kind: "send",
  payload: { visitId: "visit-a", body: "synthetic draft" },
  apply,
  ...rest,
});

test("additive migration preserves schema six and original home revisions", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "home-social-test-"));
  const file = path.join(dir, "memory.sqlite");
  let memory = new MemoryStore(file);
  memory.db.prepare("INSERT INTO home_rooms VALUES('old-generation',7)").run();
  memory.db.exec("DROP TABLE home_social_operations");
  memory.close();
  memory = new MemoryStore(file);
  t.after(() => {
    memory.close();
    rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(memory.db.prepare("PRAGMA user_version").get().user_version, 7);
  assert.equal(
    memory.db.prepare("SELECT content_revision FROM home_rooms").get()
      .content_revision,
    7,
  );
  migrateHomeSocial(memory.db);
  assert.equal(
    memory.db.prepare("SELECT count(*) n FROM home_social_operations").get().n,
    0,
  );
  assert.deepEqual(memory.bind("agent-a").export().tables.events, []);
});

test("all actions share one identity request key and preserve exact historical receipt", (t) => {
  const { store, db, setNow } = setup(t);
  let writes = 0;
  const input = op(() => ({ messageId: "message-a", sequence: ++writes }));
  const first = store.execute(input);
  setNow(2000);
  const replay = store.execute(input);
  assert.equal(writes, 1);
  assert.equal(replay.operationId, first.operationId);
  assert.equal(replay.committedAt, first.committedAt);
  assert.equal(replay.historicalReplay, true);
  assert.throws(
    () => store.execute({ ...input, kind: "end" }),
    /IDEMPOTENCY_MISMATCH/,
  );
  assert.throws(
    () => store.execute({ ...input, payload: { body: "changed" } }),
    /IDEMPOTENCY_MISMATCH/,
  );
  assert.equal(
    db.prepare("SELECT count(*) n FROM home_social_operations").get().n,
    1,
  );
  assert.equal(
    db
      .prepare("SELECT result FROM home_social_operations")
      .get()
      .result.includes("synthetic draft"),
    false,
  );
});

test("revoked identity and current authorization also gate historical replay", (t) => {
  const { store, db } = setup(t);
  const input = op(() => ({ changed: true }));
  store.execute(input);
  assert.throws(
    () =>
      store.execute({
        ...input,
        authorize: () => {
          throw Error("AUDIENCE_DENIED");
        },
      }),
    /AUDIENCE_DENIED/,
  );
  db.prepare(
    "UPDATE home_identities SET generation='generation-new' WHERE agent_id='agent-a'",
  ).run();
  assert.throws(
    () => store.operationRead(actor, "request-0001"),
    /IDENTITY_DENIED/,
  );
  const rebuilt = { agentId: "agent-a", generation: "generation-new" };
  assert.equal(store.operationRead(rebuilt, "request-0001").status, "unknown");
  assert.equal(
    store.execute({ ...input, actorIdentity: rebuilt }).historicalReplay,
    false,
  );
});

test("sequence and writes roll back together when safe receipt validation fails", (t) => {
  const { store, db } = setup(t);
  seed(db);
  assert.throws(
    () =>
      store.execute(
        op(({ nextSequence }) => ({
          sequence: nextSequence("visit-a"),
          body: "forbidden body",
        })),
      ),
    /SOCIAL_RECEIPT_INVALID/,
  );
  assert.equal(
    db.prepare("SELECT next_sequence FROM home_social_visits").get()
      .next_sequence,
    1,
  );
  assert.equal(store.operationRead(actor, "request-0001").status, "unknown");
  const first = store.execute(
    op(({ nextSequence }) => ({ sequence: nextSequence("visit-a") })),
  );
  assert.equal(first.result.sequence, 1);
  assert.equal(
    store.execute(
      op(() => {
        throw Error("must not run");
      }),
    ).result.sequence,
    1,
  );
});

test("transaction gate uses refreshed clock and rejects async work atomically", (t) => {
  const { store, db, setNow } = setup(t);
  seed(db);
  setNow(5000);
  assert.throws(
    () =>
      store.execute(
        op(({ now, nextSequence }) => {
          if (now >= 5000) throw Error("VISIT_CLOSED");
          return { sequence: nextSequence("visit-a") };
        }),
      ),
    /VISIT_CLOSED/,
  );
  assert.throws(
    () => store.transaction(() => Promise.resolve({})),
    /SOCIAL_ASYNC_TRANSACTION_DENIED/,
  );
  assert.equal(db.isTransaction, false);
  assert.equal(
    db.prepare("SELECT next_sequence FROM home_social_visits").get()
      .next_sequence,
    1,
  );
});

test("ordinary restart preserves visits; explicit recovery closes authority without erasing receipts", (t) => {
  const { store, db } = setup(t);
  seed(db);
  const receipt = store.execute(
    op(() => ({ messageId: "message-a", sequence: 1 })),
  );
  db.prepare(
    "UPDATE home_social_policy SET enabled=1,exchange_enabled=1",
  ).run();
  store.interruptRuntime("runtime-new");
  assert.equal(
    db.prepare("SELECT status FROM home_social_visits").get().status,
    "active",
  );
  store.invalidateRestoredAuthority({ recoveryEpoch: "recovery-new" });
  assert.equal(
    db.prepare("SELECT status FROM home_social_visits").get().status,
    "invalidated",
  );
  assert.equal(
    db.prepare("SELECT revoked_at FROM home_social_grants").get().revoked_at,
    1000,
  );
  assert.equal(
    db.prepare("SELECT enabled FROM home_social_policy").get().enabled,
    0,
  );
  assert.equal(
    store.operationRead(actor, "request-0001").operationId,
    receipt.operationId,
  );
});

test("identity invalidation fences both participants and retention clears bodies only", (t) => {
  const { store, db } = setup(t);
  seed(db);
  db.prepare(
    "INSERT INTO home_social_messages(id,visit_id,author_agent_id,author_generation,sequence,body,source_labels,audience,created_at) VALUES('message-a','visit-a','agent-a','generation-a',1,'synthetic body','[\"social:visit-a:generation-a\"]','[]',100)",
  ).run();
  const receipt = store.execute(
    op(() => ({ messageId: "message-a", sequence: 1 })),
  );
  store.invalidateIdentity({ agentId: "agent-b", generation: "generation-b" });
  assert.equal(
    db.prepare("SELECT fence FROM home_social_visits").get().fence,
    1,
  );
  store.pruneBodies({ before: 1000 });
  const row = db.prepare("SELECT * FROM home_social_messages").get();
  assert.equal(row.body, "");
  assert.equal(row.revision, 1);
  assert.equal(row.source_labels, '["social:visit-a:generation-a"]');
  assert.equal(
    store.operationRead(actor, "request-0001").operationId,
    receipt.operationId,
  );
});

test("turn binding cannot be relabelled and unknown inference reservations survive interruption", (t) => {
  const { store, db } = setup(t);
  seed(db);
  db.prepare(
    "INSERT INTO home_social_turns(id,visit_id,target_kind,target_id,target_host_generation,target_guest_generation,actor_generation,mode,status,epoch,fence,policy_revision,config_revision,resources_reserved,created_at) VALUES('turn-a','visit-a','visit','visit-a','generation-a','generation-b','generation-a','async','running',0,0,0,'config-a','{\"tokens\":100}',100)",
  ).run();
  db.prepare(
    "INSERT INTO home_social_inference_reservations(id,run_id,request_id,turn_id,actor_generation,mode,status,reserved,created_at) VALUES('reserve-a','run-a','infer-a','turn-a','generation-a','async','unknown','{\"tokens\":100}',100)",
  ).run();
  assert.throws(
    () =>
      db
        .prepare(
          "UPDATE home_social_turns SET mode='window',window_id='window-a' WHERE id='turn-a'",
        )
        .run(),
    /SOCIAL_BINDING_IMMUTABLE/,
  );
  store.interruptRuntime("runtime-new");
  assert.equal(
    db.prepare("SELECT status FROM home_social_inference_reservations").get()
      .status,
    "unknown",
  );
  assert.equal(
    db.prepare("SELECT resources_reserved FROM home_social_turns").get()
      .resources_reserved,
    '{"tokens":100}',
  );
  store.invalidateRestoredAuthority({ recoveryEpoch: "recovery-a" });
  const fence = db.prepare("SELECT fence FROM home_social_visits").get().fence;
  store.invalidateRestoredAuthority({ recoveryEpoch: "recovery-a" });
  assert.equal(
    db.prepare("SELECT fence FROM home_social_visits").get().fence,
    fence,
  );
  assert.throws(
    () => store.execute(op(() => Promise.resolve({ changed: true }))),
    /SOCIAL_RECEIPT_INVALID/,
  );
  assert.equal(store.operationRead(actor, "request-0001").status, "unknown");
});

test("compose and pending invitation async work fence both parties even without a visit", (t) => {
  const { store, db } = setup(t);
  for (const kind of ["compose", "invitation"]) {
    const id = kind === "compose" ? "generation-a" : "pending-a";
    db.prepare(
      "INSERT INTO home_social_contexts(id,actor_generation,target_kind,target_id,target_host_generation,target_guest_generation,invitation_id,status,policy_revision,config_revision,audience,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      "ctx-" + kind,
      "generation-a",
      kind,
      id,
      "generation-a",
      "generation-b",
      kind === "invitation" ? id : null,
      "active",
      0,
      "config-a",
      "[]",
      100,
    );
    db.prepare(
      "INSERT INTO home_social_turns(id,target_kind,target_id,target_host_generation,target_guest_generation,actor_generation,mode,status,epoch,fence,policy_revision,config_revision,created_at) VALUES(?,?,?,?,?,?,'async','queued',0,0,0,'config-a',100)",
    ).run(
      "turn-" + kind,
      kind,
      id,
      "generation-a",
      "generation-b",
      "generation-a",
    );
    db.prepare(
      "INSERT INTO home_social_dispatches(id,dedupe_key,turn_id,target_kind,target_id,target_host_generation,target_guest_generation,actor_generation,mode,status,epoch,fence,not_before,deadline,created_at) VALUES(?,?,?,?,?,?,?,?,'async','queued',0,0,100,5000,100)",
    ).run(
      "dispatch-" + kind,
      "dedupe-" + kind,
      "turn-" + kind,
      kind,
      id,
      "generation-a",
      "generation-b",
      "generation-a",
    );
  }
  assert.throws(
    () =>
      db
        .prepare("UPDATE home_social_turns SET epoch=1 WHERE id='turn-compose'")
        .run(),
    /SOCIAL_BINDING_IMMUTABLE/,
  );
  assert.throws(
    () =>
      db
        .prepare(
          "UPDATE home_social_dispatches SET target_id='another' WHERE id='dispatch-invitation'",
        )
        .run(),
    /SOCIAL_BINDING_IMMUTABLE/,
  );
  assert.throws(
    () =>
      db
        .prepare(
          "UPDATE home_social_contexts SET target_guest_generation='third-party' WHERE id='ctx-compose'",
        )
        .run(),
    /SOCIAL_BINDING_IMMUTABLE/,
  );
  store.invalidateIdentity({ agentId: "agent-b", generation: "generation-b" });
  assert.deepEqual(
    db
      .prepare("SELECT status FROM home_social_turns ORDER BY id")
      .all()
      .map((r) => r.status),
    ["cancelled", "cancelled"],
  );
  assert.deepEqual(
    db
      .prepare("SELECT status FROM home_social_dispatches ORDER BY id")
      .all()
      .map((r) => r.status),
    ["cancelled", "cancelled"],
  );
  assert.deepEqual(
    db
      .prepare("SELECT status FROM home_social_contexts ORDER BY id")
      .all()
      .map((r) => r.status),
    ["invalidated", "invalidated"],
  );
});

test("a proposed window excludes a second proposed or active window for the visit", (t) => {
  const { db } = setup(t);
  seed(db);
  const insert = db.prepare(
    "INSERT INTO home_social_windows(id,visit_id,proposer_generation,status,terms_revision,terms,effective_limits,policy_revision,created_at,expires_at) VALUES(?,'visit-a','generation-a',?,'terms-a','{}','{}',0,100,5000)",
  );
  insert.run("window-a", "proposed");
  assert.throws(
    () => insert.run("window-b", "proposed"),
    /UNIQUE constraint failed/,
  );
  assert.throws(
    () => insert.run("window-b", "active"),
    /UNIQUE constraint failed/,
  );
  db.prepare(
    "UPDATE home_social_windows SET status='closed' WHERE id='window-a'",
  ).run();
  insert.run("window-b", "active");
  assert.equal(
    db.prepare("SELECT count(*) n FROM home_social_windows").get().n,
    2,
  );
});

test("nullable SQL checks cannot admit a visit binding without its target row key", (t) => {
  const { db } = setup(t);
  assert.throws(
    () =>
      db
        .prepare(
          "INSERT INTO home_social_turns(id,target_kind,target_id,target_host_generation,target_guest_generation,actor_generation,mode,status,epoch,fence,policy_revision,config_revision,created_at) VALUES('turn-invalid','visit','missing-visit','generation-a','generation-b','generation-a','async','queued',0,0,0,'config-a',100)",
        )
        .run(),
    /CHECK constraint failed/,
  );
  assert.throws(
    () =>
      db
        .prepare(
          "INSERT INTO home_social_contexts(id,actor_generation,target_kind,target_id,target_host_generation,target_guest_generation,status,policy_revision,config_revision,audience,updated_at) VALUES('ctx-invalid','generation-a','invitation','missing-invitation','generation-a','generation-b','active',0,'config-a','[]',100)",
        )
        .run(),
    /CHECK constraint failed/,
  );
});
