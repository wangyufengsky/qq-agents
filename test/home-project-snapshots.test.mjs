import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { MemoryStore } from "../src/memory/store.mjs";
import { restoreExport } from "../src/memory/migrate.mjs";
import { randomUUID } from "node:crypto";
import { fixture, context, config } from "./helpers.mjs";
import { participateInProject } from "../src/core/project-participation.mjs";
import { activityVersion } from "../src/tools/activities.mjs";
function setup(t) {
  const cfg = config();
  cfg.agents[0].subject.enabled = true;
  cfg.agents[0].home = {
    enabled: true,
    publishing: true,
    projectSnapshots: { enabled: true },
  };
  const f = fixture(t, { cfg }),
    ctx = context(f.runtime, "agent-0", "@subject");
  return {
    ...f,
    ctx,
    call: (name, args = {}, c = ctx) => f.runtime.executeTool(c, name, args),
  };
}
async function draft(f) {
  const p = await f.call("project", { title: "个人文字", why: "独立创作" });
  assert.equal(p.homeSnapshotProvenance.version, 1);
  const joined = participateInProject(f.runtime, "agent-0", {
    id: p.id,
    expectedRevision: 1,
    submissionId: randomUUID(),
    action: "join",
  }).project;
  await f.call("projects", { id: p.id });
  return f.call("project", {
    id: p.id,
    expectedRevision: joined.revision,
    draft: { title: "纸上的小故事", text: "这是固定版本的一段原创文字。" },
  });
}
async function args(f, p, requestId = "snapshot-0001") {
  const view = await f.call("room_read");
  return {
    identityGeneration: view.identityGeneration,
    expectedItemRevision: view.items.find((i) => i.slot === "work-1")
      .itemRevision,
    slot: "work-1",
    requestId,
    source: { type: "project-draft", id: p.id, revision: p.revision },
  };
}
test("snapshot uses exact saved draft bytes, independent copies, atomic receipts and explicit capability", async (t) => {
  const f = setup(t),
    p = await draft(f),
    a = await args(f, p);
  const entry = activityVersion(f.store.bind("agent-0"), p.id, p.revision);
  assert.equal(entry.homeSnapshotProvenance.version, 1);
  f.store.db.exec(
    "CREATE TRIGGER snapshot_failure BEFORE INSERT ON home_item_sources BEGIN SELECT RAISE(ABORT,'synthetic'); END",
  );
  await assert.rejects(f.call("room_publish_snapshot", a), /synthetic/);
  assert.equal(
    f.store.db.prepare("SELECT count(*) n FROM home_items").get().n,
    0,
  );
  assert.equal(
    f.store.db.prepare("SELECT count(*) n FROM home_operations").get().n,
    0,
  );
  f.store.db.exec("DROP TRIGGER snapshot_failure");
  const published = await f.call("room_publish_snapshot", a);
  assert.equal(
    published.current.items.find((i) => i.slot === "work-1").body,
    entry.draft.text,
  );
  assert.equal((await f.call("room_publish_snapshot", a)).replayed, true);
  await f.call("projects", { id: p.id });
  await f.call("project", {
    id: p.id,
    expectedRevision: p.revision,
    draft: { title: "后稿", text: "后续变化不更新已展示正文" },
  });
  assert.equal(
    f.runtime.home.rooms
      .display("agent-0")
      .items.find((i) => i.slot === "work-1").body,
    entry.draft.text,
  );
  f.runtime.agent("agent-0").home.projectSnapshots.enabled = false;
  assert.equal(
    f.runtime.home.rooms
      .display("agent-0")
      .items.find((i) => i.slot === "work-1").body,
    undefined,
  );
  await assert.rejects(f.call("room_publish_snapshot", a), /TOOL_DISABLED/);
  f.runtime.agent("agent-0").home.projectSnapshots.enabled = true;
  await f.call("room_retract", {
    identityGeneration: a.identityGeneration,
    expectedItemRevision: 1,
    slot: a.slot,
    requestId: "snapshot-retract",
  });
  assert.equal(
    f.store.db.prepare("SELECT count(*) n FROM home_item_sources").get().n,
    0,
  );
  assert.equal(
    JSON.stringify(
      f.store.db.prepare("SELECT * FROM home_operations").all(),
    ).includes(entry.draft.text),
    false,
  );
});
test("source validation rejects legacy, contributed, forged, oversized and credential drafts without changing ordinary writes", async (t) => {
  const f = setup(t),
    p = await draft(f),
    a = await args(f, p);
  await assert.rejects(
    f.call("room_publish_snapshot", {
      ...a,
      source: { ...a.source, revision: 999 },
    }),
    /HOME_SNAPSHOT_INVALID/,
  );
  await assert.rejects(
    f.call("room_publish_snapshot", {
      ...a,
      source: { type: "file", id: "/arbitrary", revision: 1 },
    }),
  );
  const update = (fn) => {
    const e = activityVersion(f.store.bind("agent-0"), p.id, p.revision);
    fn(e);
    f.store.db
      .prepare(
        "UPDATE activity_history SET value=? WHERE agent_id=? AND project_id=? AND revision=?",
      )
      .run(JSON.stringify(e), "agent-0", p.id, p.revision);
  };
  update((e) => {
    delete e.homeSnapshotProvenance;
  });
  await assert.rejects(
    f.call("room_publish_snapshot", a),
    /HOME_SOURCE_DENIED/,
  );
  await f.call("projects", { id: p.id });
  const rewritten = await f.call("project", {
    id: p.id,
    expectedRevision: p.revision,
    draft: { title: "改写", text: "不能洗掉旧版不明来源" },
  });
  assert.equal(
    activityVersion(f.store.bind("agent-0"), p.id, rewritten.revision)
      .homeSnapshotProvenance,
    null,
  );
  await assert.rejects(
    f.call("room_publish_snapshot", await args(f, rewritten)),
    /HOME_SOURCE_DENIED/,
  );
  const clean = setup(t),
    original = await draft(clean);
  const sourceArgs = await args(clean, original);
  const edit = (fn) => {
    const e = activityVersion(
      clean.store.bind("agent-0"),
      original.id,
      original.revision,
    );
    fn(e);
    clean.store.db
      .prepare(
        "UPDATE activity_history SET value=? WHERE agent_id=? AND project_id=? AND revision=?",
      )
      .run(JSON.stringify(e), "agent-0", original.id, original.revision);
  };
  edit((e) => {
    e.draft.text = "字".repeat(6001);
  });
  await assert.rejects(
    clean.call("room_publish_snapshot", sourceArgs),
    /HOME_SNAPSHOT_INVALID/,
  );
  edit((e) => {
    e.draft.text = clean.ctx.token;
  });
  await assert.rejects(
    clean.call("room_publish_snapshot", sourceArgs),
    /CAPABILITY_EXFILTRATION_BLOCKED|SENSITIVE_OUTPUT_BLOCKED/,
  );
  edit((e) => {
    e.draftAuthor = "administrator";
  });
  await assert.rejects(
    clean.call("room_publish_snapshot", sourceArgs),
    /HOME_SOURCE_DENIED/,
  );
});
test("concurrent snapshot writes cannot overwrite a newer slot or replay changed source parameters", async (t) => {
  const f = setup(t),
    p = await draft(f),
    a = await args(f, p);
  const other = context(f.runtime, "agent-0", "@subject");
  await f.call("room_read", {}, other);
  await f.call("room_publish_snapshot", a);
  await assert.rejects(
    f.call(
      "room_publish_snapshot",
      { ...a, requestId: "snapshot-stale" },
      other,
    ),
    /HOME_ITEM_CONFLICT/,
  );
  await assert.rejects(
    f.call("room_publish_snapshot", {
      ...a,
      source: { ...a.source, revision: 1 },
    }),
    /HOME_REQUEST_CONFLICT/,
  );
});

test("role export restoration keeps draft bytes but cannot import or forge display authority", async (t) => {
  const f = setup(t),
    p = await draft(f),
    memory = f.store.bind("agent-0");
  const exported = memory.export();
  const restored = new MemoryStore(path.join(f.root, "restored.sqlite"));
  t.after(() => restored.close());
  restoreExport(restored.bind("agent-0"), exported);
  const entry = activityVersion(restored.bind("agent-0"), p.id, p.revision);
  assert.equal(
    entry.draft.text,
    activityVersion(memory, p.id, p.revision).draft.text,
  );
  assert.equal(entry.homeSnapshotProvenance, null);
  const joined = restored.db
    .prepare(
      "SELECT value FROM activity_history WHERE project_id=? AND revision=2",
    )
    .get(p.id);
  assert.equal(
    JSON.parse(joined.value).previousProject.homeSnapshotProvenance,
    null,
  );
});

test("current project protection and later administrator contributions revoke new historical references", async (t) => {
  const f = setup(t),
    p = await draft(f),
    a = await args(f, p);
  const project = f.store.bind("agent-0").identity.project(p.id);
  f.store.db
    .prepare("UPDATE projects SET value=? WHERE agent_id=? AND id=?")
    .run(
      JSON.stringify({ ...project, protectedOperations: true }),
      "agent-0",
      p.id,
    );
  await assert.rejects(
    f.call("room_publish_snapshot", a),
    /HOME_SOURCE_DENIED/,
  );
  f.store.db
    .prepare("UPDATE projects SET value=? WHERE agent_id=? AND id=?")
    .run(JSON.stringify(project), "agent-0", p.id);
  participateInProject(f.runtime, "agent-0", {
    id: p.id,
    expectedRevision: p.revision,
    submissionId: randomUUID(),
    action: "comment",
    text: "后续管理员实质贡献",
  });
  await assert.rejects(
    f.call("room_publish_snapshot", a),
    /HOME_SOURCE_DENIED/,
  );
});

test("initial personal project evidence survives derivation and is checked for later protection", async (t) => {
  const f = setup(t),
    memory = f.store.bind("agent-0");
  const diary = memory.diaryWrite({
    title: "原创构思",
    body: "合成的个人想法",
  });
  f.ctx.privateRead.add(diary.id);
  const p = await draft(f),
    a = await args(f, p);
  const entry = activityVersion(memory, p.id, p.revision);
  assert.ok(entry.homeSnapshotProvenance.evidence.includes(diary.id));
  f.ctx.privateRead.clear();
  const row = memory.db
    .prepare("SELECT metadata FROM diaries WHERE id=?")
    .get(diary.id);
  memory.db.prepare("UPDATE diaries SET metadata=? WHERE id=?").run(
    JSON.stringify({
      ...JSON.parse(row.metadata),
      protectedOperations: true,
    }),
    diary.id,
  );
  await assert.rejects(
    f.call("room_publish_snapshot", a),
    /HOME_SOURCE_DENIED/,
  );
});
