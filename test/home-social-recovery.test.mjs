import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { MemoryStore } from "../src/memory/store.mjs";
import { SocialStore } from "../src/home/social-store.mjs";
import { backupDatabase } from "../src/memory/backup.mjs";
import { acquireProcessLock } from "../src/core/process-lifecycle.mjs";
import { prepareSocialRecovery } from "../src/home/social-recovery.mjs";

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "social-recovery-"));
  const connections = [];
  t.after(() => {
    for (const db of connections) db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const config = {
    agents: [{ id: "synthetic-a", paused: true }],
    globalPaused: false,
    homeSocial: { enabled: true, exchangeEnabled: true, retentionDays: 30 },
    unrelated: "preserved",
  };
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify(config));
  const memory = new MemoryStore(path.join(root, "memory.sqlite"));
  memory.db.exec(`
    INSERT INTO home_identities(agent_id,generation,active) VALUES('synthetic-a','generation-a',1),('synthetic-b','generation-b',1);
    INSERT INTO home_social_invitations(id,host_agent_id,host_generation,guest_agent_id,guest_generation,initiator_generation,recipient_generation,room_id,audience,requested_scope,status,policy_revision,created_at,expires_at)
      VALUES('invite','synthetic-a','generation-a','synthetic-b','generation-b','generation-a','generation-b','room-a','[]','[]','accepted',1,1,9999999999999);
    INSERT INTO home_social_visits(id,invitation_id,host_agent_id,host_generation,guest_agent_id,guest_generation,room_id,pair_key,status,policy_revision,started_at,expires_at)
      VALUES('visit','invite','synthetic-a','generation-a','synthetic-b','generation-b','room-a','pair','active',1,1,9999999999999);
    INSERT INTO home_social_grants(visit_id,invitation_id,room_id,host_generation,guest_generation,scope,policy_revision,expires_at)
      VALUES('visit','invite','room-a','generation-a','generation-b','[]',1,9999999999999);
    INSERT INTO home_social_messages(id,visit_id,author_agent_id,author_generation,sequence,body,source_labels,audience,created_at)
      VALUES('message','visit','synthetic-a','generation-a',1,'synthetic body','[]','[]',2);
    INSERT INTO home_social_usage VALUES('generation-a','2026-01-01','visit','messages',1,0);
  `);
  const receipt = new SocialStore(memory.db, { clock: () => 100 }).execute({
    actorIdentity: { agentId: "synthetic-a", generation: "generation-a" },
    requestId: "synthetic-request",
    kind: "send",
    payload: { visitId: "visit" },
    apply: () => ({ messageId: "message", sequence: 1 }),
  });
  memory.close();
  return { root, config, receipt, keep: (db) => connections.push(db) };
}

test("offline restoration closes authority while retaining original identities, receipts and usage", async (t) => {
  const f = setup(t),
    destination = path.join(f.root, "restored");
  fs.mkdirSync(destination);
  fs.copyFileSync(
    path.join(f.root, "config.json"),
    path.join(destination, "config.json"),
  );
  await backupDatabase(
    path.join(f.root, "memory.sqlite"),
    path.join(destination, "memory.sqlite"),
  );
  const epoch = randomUUID(),
    options = { retentionDays: 30, recoveryEpoch: epoch, clock: () => 5000 };
  assert.equal(
    prepareSocialRecovery(destination, options).socialEnabled,
    false,
  );
  const config = JSON.parse(
    fs.readFileSync(path.join(destination, "config.json")),
  );
  assert.equal(config.globalPaused, true);
  assert.equal(config.homeSocial.enabled, false);
  assert.equal(config.homeSocial.exchangeEnabled, false);
  assert.deepEqual(config.agents, f.config.agents);
  assert.equal(config.unrelated, "preserved");
  const db = new DatabaseSync(path.join(destination, "memory.sqlite"));
  f.keep(db);
  assert.equal(
    db.prepare("SELECT status FROM home_social_visits").get().status,
    "invalidated",
  );
  assert.equal(
    db.prepare("SELECT revoked_at FROM home_social_grants").get().revoked_at,
    5000,
  );
  assert.equal(
    db
      .prepare("SELECT generation FROM home_identities WHERE agent_id=?")
      .get("synthetic-a").generation,
    "generation-a",
  );
  const operations = db.prepare("SELECT * FROM home_social_operations").all();
  assert.equal(operations.length, 1);
  assert.equal(operations[0].operation_id, f.receipt.operationId);
  assert.equal(operations[0].created_at, Date.parse(f.receipt.committedAt));
  const before = db.prepare("SELECT * FROM home_social_usage").all();
  assert.equal(
    prepareSocialRecovery(destination, options).historicalReplay,
    true,
  );
  assert.deepEqual(
    db.prepare("SELECT * FROM home_social_operations").all(),
    operations,
  );
  assert.deepEqual(db.prepare("SELECT * FROM home_social_usage").all(), before);
  const source = new DatabaseSync(path.join(f.root, "memory.sqlite"), {
    readOnly: true,
  });
  assert.equal(
    source.prepare("SELECT status FROM home_social_visits").get().status,
    "active",
  );
  source.close();
});

test("restore refuses active or incomplete destinations without inventing config or a database", (t) => {
  const f = setup(t);
  fs.writeFileSync(path.join(f.root, "process.lock"), "synthetic lock");
  assert.throws(
    () => prepareSocialRecovery(f.root, { retentionDays: 30 }),
    /STOP_DESTINATION/,
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(f.root, "config.json"))).homeSocial
      .enabled,
    true,
  );
  fs.rmSync(path.join(f.root, "process.lock"));
  fs.rmSync(path.join(f.root, "config.json"));
  assert.throws(
    () => prepareSocialRecovery(f.root, { retentionDays: 30 }),
    (error) =>
      error.message === "SOCIAL_RECOVERY_INPUT_INVALID" &&
      !Object.hasOwn(error, "cause"),
  );
  assert.equal(fs.existsSync(path.join(f.root, "config.json")), false);
});

test("database barrier failure leaves the restored configuration paused and social disabled", (t) => {
  const f = setup(t),
    db = new DatabaseSync(path.join(f.root, "memory.sqlite"));
  db.exec(
    "CREATE TRIGGER refuse_barrier BEFORE UPDATE ON home_social_policy BEGIN SELECT RAISE(ABORT,'synthetic failure'); END",
  );
  db.close();
  assert.throws(
    () => prepareSocialRecovery(f.root, { retentionDays: 30 }),
    /synthetic failure/,
  );
  const config = JSON.parse(fs.readFileSync(path.join(f.root, "config.json")));
  assert.equal(config.globalPaused, true);
  assert.equal(config.homeSocial.enabled, false);
});

test("current shorter retention clears terminal bodies without deleting idempotency receipts", (t) => {
  const f = setup(t),
    db = new DatabaseSync(path.join(f.root, "memory.sqlite"));
  db.exec("UPDATE home_social_visits SET status='ended',ended_at=1");
  db.close();
  const result = prepareSocialRecovery(f.root, {
    retentionDays: 1,
    clock: () => 2 * 86400000,
  });
  assert.equal(result.cleared.messages, 1);
  const check = new DatabaseSync(path.join(f.root, "memory.sqlite"));
  f.keep(check);
  assert.equal(
    check.prepare("SELECT body FROM home_social_messages").get().body,
    "",
  );
  assert.equal(
    check.prepare("SELECT count(*) AS n FROM home_social_operations").get().n,
    1,
  );
});

test("recovery holds the real process lock through validation and always releases it", (t) => {
  const f = setup(t);
  let checked = false;
  prepareSocialRecovery(f.root, {
    retentionDays: 30,
    clock: () => {
      assert.throws(() => acquireProcessLock(f.root), /DATA_DIRECTORY_LOCKED/);
      checked = true;
      return 5000;
    },
  });
  assert.equal(checked, true);
  const after = acquireProcessLock(f.root);
  after.release();
  assert.throws(
    () =>
      prepareSocialRecovery(f.root, {
        retentionDays: 30,
        clock: () => {
          throw Error("synthetic clock failure");
        },
      }),
    /synthetic clock failure/,
  );
  const afterFailure = acquireProcessLock(f.root);
  afterFailure.release();
});

test("recovery CLI contains malformed and missing inputs without leaking private bytes", (t) => {
  for (const scenario of ["malformed", "missing", "database", "usage"]) {
    const f = setup(t);
    const configFile = path.join(f.root, "config.json");
    const databaseFile = path.join(f.root, "memory.sqlite");
    const marker = "SYNTHETIC_RECOVERY_SECRET_MARKER";
    if (scenario === "malformed")
      fs.writeFileSync(configFile, '{"agents":[],"secret":' + marker + "}");
    if (scenario === "missing") fs.rmSync(configFile);
    if (scenario === "database") fs.writeFileSync(databaseFile, marker);
    const beforeConfig = fs.existsSync(configFile)
      ? fs.readFileSync(configFile)
      : null;
    const beforeDatabase = fs.readFileSync(databaseFile);
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL("../scripts/home-social-recover.mjs", import.meta.url),
        ),
        ...(scenario === "usage"
          ? []
          : ["--data", f.root, "--retention-days", "30"]),
      ],
      { encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" } },
    );
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    const expected = {
      malformed: "SOCIAL_RECOVERY_CONFIG_INVALID",
      missing: "SOCIAL_RECOVERY_INPUT_INVALID",
      database: "SOCIAL_RECOVERY_FAILED",
      usage: "SOCIAL_RECOVERY_USAGE",
    }[scenario];
    assert.equal(result.stderr, JSON.stringify({ error: expected }) + "\n");
    assert.equal(result.stderr.includes(marker), false);
    assert.equal(result.stderr.includes(f.root), false);
    assert.equal(result.stderr.includes(" at "), false);
    if (beforeConfig)
      assert.deepEqual(fs.readFileSync(configFile), beforeConfig);
    else assert.equal(fs.existsSync(configFile), false);
    assert.deepEqual(fs.readFileSync(databaseFile), beforeDatabase);
    const lock = acquireProcessLock(f.root);
    lock.release();
    if (scenario === "malformed") {
      assert.throws(
        () => prepareSocialRecovery(f.root, { retentionDays: 30 }),
        (error) => error.message === expected && !Object.hasOwn(error, "cause"),
      );
      const afterFailure = acquireProcessLock(f.root);
      afterFailure.release();
    }
  }
});
