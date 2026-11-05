import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { config, FakeTransport } from "./helpers.mjs";
import { backupDatabase } from "../src/memory/backup.mjs";
import { SocialStore } from "../src/home/social-store.mjs";
import { prepareSocialRecovery } from "../src/home/social-recovery.mjs";
import { FrameworkKnowledge } from "../src/core/framework-knowledge.mjs";

// Run only against an independently checked out old release and synthetic data.
// Production rollback must preserve a current checkpoint before restoring the old one.
const baseline = process.env.HOME_BASELINE_ROOT;
if (!baseline) throw Error("HOME_BASELINE_ROOT_REQUIRED");
const current = path.resolve(import.meta.dirname, "..");
// A repeated run of current code cannot prove migration or old-code rollback.
const baselineVersion = new FrameworkKnowledge({ root: baseline }).version;
const currentVersion = new FrameworkKnowledge({ root: current }).version;
assert.notEqual(fs.realpathSync(baseline), fs.realpathSync(current));
assert.ok(baselineVersion.commit && currentVersion.commit);
assert.equal(baselineVersion.modified, false);
assert.notEqual(baselineVersion.commit, currentVersion.commit);
assert.notEqual(baselineVersion.buildDigest, currentVersion.buildDigest);
const identity = ({ commit, buildDigest, modified, provenance }) => ({
  commit,
  buildDigest,
  modified,
  provenance,
});
const root = fs.mkdtempSync(path.join(os.tmpdir(), "home-upgrade-"));
const cfg = config(2);
// The baseline fixture must use only fields its historical schema understands.
delete cfg.homeSocial;
for (const agent of cfg.agents) delete agent.home.social;
cfg.board.enabled = true;
cfg.agents[0].subject.enabled = true;
cfg.agents[0].home = { enabled: true, publishing: true, maxWritesPerDay: 13 };
const report = {
    synthetic: true,
    baseline: identity(baselineVersion),
    current: identity(currentVersion),
    checks: [],
  },
  openFixtures = new Set();
async function open(codeRoot, directory, initialize = false) {
  fs.mkdirSync(directory, { recursive: true });
  const module = (file) =>
    import(pathToFileURL(path.join(codeRoot, file)).href);
  const [{ ConfigStore }, { MemoryStore }, { Runtime }] = await Promise.all([
    module("src/core/config.mjs"),
    module("src/memory/store.mjs"),
    module("src/core/runtime.mjs"),
  ]);
  const configFile = path.join(directory, "config.json");
  if (!initialize) assert.ok(fs.statSync(configFile).isFile());
  const configStore = initialize
    ? new ConfigStore(configFile, cfg)
    : new ConfigStore(configFile);
  const memory = new MemoryStore(path.join(directory, "memory.sqlite"));
  let runtime;
  try {
    runtime = new Runtime({
      memory,
      configStore,
      backendFactory: () => ({
        run: async () => {},
        cancel: async () => {},
        close: async () => {},
      }),
      transportFactory: () => new FakeTransport(),
    });
  } catch (error) {
    memory.close();
    throw error;
  }
  // A date boundary must not look like lost board usage during a restore.
  runtime.clock = () => Date.UTC(2026, 10, 5, 4);
  for (const c of runtime.config.connections)
    runtime.transports.set(c.id, new FakeTransport());
  assert.equal(runtime.config.agents[0].home.maxWritesPerDay, 13);
  const ctx = runtime.makeContext("agent-0", "@subject");
  const fixture = {
    memory,
    runtime,
    configStore,
    call: (name, args = {}) => runtime.executeTool(ctx, name, args),
    close: async () => {
      await runtime.close();
      memory.close();
      openFixtures.delete(fixture);
    },
  };
  openFixtures.add(fixture);
  return fixture;
}
async function checkpoint(source, directory) {
  fs.mkdirSync(directory);
  fs.copyFileSync(source.configStore.file, path.join(directory, "config.json"));
  assert.equal(
    (
      await backupDatabase(
        source.memory.file,
        path.join(directory, "memory.sqlite"),
      )
    ).integrity,
    "ok",
  );
}
const hash = (file) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");
try {
  const active = path.join(root, "active"),
    before = path.join(root, "before"),
    after = path.join(root, "after"),
    rollback = path.join(root, "rollback"),
    restored = path.join(root, "restored");
  let f = await open(baseline, active, true);
  let read = await f.call("room_read");
  await f.call("room_publish", {
    identityGeneration: read.identityGeneration,
    expectedItemRevision: 0,
    slot: "intro",
    title: "升级前",
    body: "合成的升级前介绍",
    source: "original-text",
    requestId: "upgrade-old-intro",
  });
  await f.call("room_scene_read");
  await f.call("room_scene_patch", {
    identityGeneration: read.identityGeneration,
    expectedLayoutRevision: 0,
    requestId: "upgrade-old-layout",
    operations: [{ action: "palette", palette: "blue" }],
  });
  await f.call("board_post", {
    title: "升级前便签",
    body: "仅用于隔离恢复演练",
  });
  const oldContent = f.runtime.home.rooms.display("agent-0"),
    oldBoard = await f.call("board_read", { mode: "posts" });
  assert.equal(oldBoard.posts.length, 1);
  assert.equal(oldBoard.posts[0].body, "仅用于隔离恢复演练");
  await checkpoint(f, before);
  await f.close();
  f = await open(current, active);
  read = await f.call("room_read");
  assert.equal(
    read.items.find((i) => i.slot === "intro").body,
    "合成的升级前介绍",
  );
  assert.equal(f.runtime.home.read("room", "agent-0").layout.palette, "blue");
  assert.equal(f.runtime.config.agents[0].home.intents.enabled, false);
  assert.equal(f.runtime.config.agents[0].home.sceneView.enabled, false);
  assert.equal(f.runtime.config.agents[0].home.projectSnapshots.enabled, false);
  assert.deepEqual(await f.call("board_read", { mode: "posts" }), oldBoard);
  await f.call("room_publish", {
    identityGeneration: read.identityGeneration,
    expectedItemRevision: 0,
    slot: "tagline",
    title: "升级后",
    body: "新版本产生的合成门牌",
    source: "original-text",
    requestId: "upgrade-new-tagline",
  });
  const newContent = f.runtime.home.rooms.display("agent-0");
  const socialStore = new SocialStore(f.memory.db, {
    clock: () => f.runtime.now(),
  });
  const host = f.runtime.home.generation("agent-0"),
    guest = f.runtime.home.generation("agent-1");
  // Seed a committed domain transaction; model/tool behavior has its own integration suite.
  f.memory.db
    .prepare(
      "INSERT INTO home_social_invitations(id,host_agent_id,host_generation,guest_agent_id,guest_generation,initiator_generation,recipient_generation,room_id,audience,requested_scope,status,policy_revision,created_at,expires_at) VALUES('upgrade-invite','agent-0',?,'agent-1',?,?,?,'room-upgrade','[]','[]','accepted',1,?,?)",
    )
    .run(host, guest, host, guest, f.runtime.now(), f.runtime.now() + 86400000);
  f.memory.db
    .prepare(
      "INSERT INTO home_social_visits(id,invitation_id,host_agent_id,host_generation,guest_agent_id,guest_generation,room_id,pair_key,status,policy_revision,started_at,expires_at) VALUES('upgrade-visit','upgrade-invite','agent-0',?,'agent-1',?,'room-upgrade','upgrade-pair','active',1,?,?)",
    )
    .run(host, guest, f.runtime.now(), f.runtime.now() + 86400000);
  const socialReceipt = socialStore.execute({
    actorIdentity: { agentId: "agent-0", generation: host },
    requestId: "upgrade-social-message",
    kind: "send",
    payload: { visitId: "upgrade-visit", body: "synthetic private message" },
    apply: ({ now }) => {
      f.memory.db
        .prepare(
          "INSERT INTO home_social_messages(id,visit_id,author_agent_id,author_generation,sequence,body,source_labels,audience,created_at) VALUES('upgrade-message','upgrade-visit','agent-0',?,1,'synthetic private message','[]','[]',?)",
        )
        .run(host, now);
      f.memory.db
        .prepare(
          "INSERT INTO home_social_usage VALUES(?,?,'upgrade-visit','messages',1,0)",
        )
        .run(host, new Date(now).toISOString().slice(0, 10));
      return { messageId: "upgrade-message", sequence: 1 };
    },
  });
  await checkpoint(f, after);
  await f.close();
  report.checks.push(
    "old database upgrades with content, layout, board and disabled new capabilities intact",
  );
  const currentHash = hash(path.join(after, "memory.sqlite"));
  fs.cpSync(before, rollback, { recursive: true });
  assert.equal(
    hash(path.join(rollback, "config.json")),
    hash(path.join(before, "config.json")),
  );
  f = await open(baseline, rollback);
  assert.deepEqual(f.runtime.home.rooms.display("agent-0"), oldContent);
  assert.deepEqual(await f.call("board_read", { mode: "posts" }), oldBoard);
  assert.equal(f.runtime.home.read("room", "agent-0").layout.palette, "blue");
  await f.close();
  assert.equal(hash(path.join(after, "memory.sqlite")), currentHash);
  report.checks.push(
    "old release reads the restored pre-upgrade checkpoint while the newer checkpoint is retained unchanged",
  );
  fs.cpSync(after, restored, { recursive: true });
  assert.equal(
    hash(path.join(restored, "config.json")),
    hash(path.join(after, "config.json")),
  );
  prepareSocialRecovery(restored, {
    retentionDays: 30,
    clock: () => Date.UTC(2026, 10, 5, 4),
  });
  const recoveredConfigFile = path.join(restored, "config.json");
  const recoveredConfig = JSON.parse(
    fs.readFileSync(recoveredConfigFile, "utf8"),
  );
  assert.equal(recoveredConfig.globalPaused, true);
  assert.equal(recoveredConfig.homeSocial.enabled, false);
  assert.equal(recoveredConfig.homeSocial.exchangeEnabled, false);
  // This isolated fixture explicitly resumes ordinary reads; social remains off.
  recoveredConfig.globalPaused = false;
  fs.writeFileSync(recoveredConfigFile, JSON.stringify(recoveredConfig));
  f = await open(current, restored);
  assert.equal(f.runtime.config.homeSocial.enabled, false);
  assert.equal(
    f.memory.db
      .prepare("SELECT status FROM home_social_visits WHERE id='upgrade-visit'")
      .get().status,
    "invalidated",
  );
  const restoredReceipt = f.memory.db
    .prepare(
      "SELECT * FROM home_social_operations WHERE request_id='upgrade-social-message'",
    )
    .get();
  assert.equal(restoredReceipt.operation_id, socialReceipt.operationId);
  assert.equal(
    restoredReceipt.created_at,
    Date.parse(socialReceipt.committedAt),
  );
  assert.equal(
    f.memory.db.prepare("SELECT count(*) AS n FROM home_social_messages").get()
      .n,
    1,
  );
  assert.equal(
    f.memory.db
      .prepare("SELECT used FROM home_social_usage WHERE scope='upgrade-visit'")
      .get().used,
    1,
  );
  assert.equal(f.runtime.home.generation("agent-0"), host);
  assert.equal(f.runtime.home.generation("agent-1"), guest);
  assert.deepEqual(f.runtime.home.rooms.display("agent-0"), newContent);
  assert.equal(
    f.runtime.home.rooms
      .display("agent-0")
      .items.find((i) => i.slot === "tagline").body,
    "新版本产生的合成门牌",
  );
  assert.deepEqual(await f.call("board_read", { mode: "posts" }), oldBoard);
  assert.equal(f.runtime.jobs.size, 0);
  assert.ok(
    [...f.runtime.transports.values()].every((tr) => tr.sent.length === 0),
  );
  await f.close();
  // Reopening the already upgraded store must not duplicate or reset the new row.
  f = await open(current, restored);
  assert.deepEqual(f.runtime.home.rooms.display("agent-0"), newContent);
  await f.close();
  report.checks.push(
    "new checkpoint restores original social receipt, identities and usage while invalidating old authority without replay",
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const fixture of openFixtures) await fixture.close();
  fs.rmSync(root, { recursive: true, force: true });
}
