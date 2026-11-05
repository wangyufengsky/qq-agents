import fs from "node:fs/promises";
import path from "node:path";
import { exportToFile } from "../src/memory/export.mjs";
import { participateInProject } from "../src/core/project-participation.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture, context, config } from "./helpers.mjs";
import {
  mergeProtection,
  socialSafeExportRow,
} from "../src/memory/protection.mjs";
import {
  socialMarker,
  socialGrantMarker,
  socialInvitationMarker,
  parseSocialMarker,
  assertSocialSend,
  assertRoomItemShareable,
  socialSources,
  socialContextAllowed,
  trackSocial,
} from "../src/core/social-protection.mjs";
import {
  contextProtection,
  trackMindRecords,
} from "../src/core/protected-mind.mjs";
import { recallBoundary } from "../src/core/recall-boundary.mjs";
import { sourceClass } from "../src/core/outbound-policy.mjs";
import { restoreExport } from "../src/memory/migrate.mjs";

function setup(t) {
  const cfg = config(2);
  cfg.agents[0].subject.enabled = true;
  const f = fixture(t, { cfg }),
    db = f.store.db;
  f.runtime.config.homeSocial = { enabled: true, retentionDays: 30 };
  for (const a of f.runtime.config.agents) a.home.social = { enabled: true };
  const visitId = randomUUID(),
    messageId = randomUUID();
  const host = f.runtime.home.generation("agent-0"),
    guest = f.runtime.home.generation("agent-1");
  db.prepare("UPDATE home_social_policy SET enabled=1 WHERE singleton=1").run();
  const invitationId = randomUUID();
  db.prepare(
    "INSERT INTO home_social_invitations(id,host_agent_id,host_generation,guest_agent_id,guest_generation,initiator_generation,recipient_generation,room_id,audience,requested_scope,status,policy_revision,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,'accepted',0,?,?)",
  ).run(
    invitationId,
    "agent-0",
    host,
    "agent-1",
    guest,
    host,
    guest,
    "room:" + host,
    JSON.stringify([host, guest]),
    JSON.stringify({ scope: ["layout"], selectedItems: [] }),
    Date.now(),
    Date.now() + 60000,
  );
  db.prepare(
    "INSERT INTO home_social_visits(id,invitation_id,host_agent_id,host_generation,guest_agent_id,guest_generation,room_id,pair_key,status,policy_revision,started_at,expires_at) VALUES(?,?,?,?,?,?,?,?,'active',0,?,?)",
  ).run(
    visitId,
    invitationId,
    "agent-0",
    host,
    "agent-1",
    guest,
    "room:" + host,
    [host, guest].sort().join(":"),
    Date.now(),
    Date.now() + 60000,
  );
  db.prepare(
    "INSERT INTO home_social_messages(id,visit_id,author_agent_id,author_generation,sequence,source_labels,audience,created_at) VALUES(?,?,?,?,1,'[]',?,?)",
  ).run(
    messageId,
    visitId,
    "agent-0",
    host,
    JSON.stringify([host, guest]),
    Date.now(),
  );
  const marker = socialMarker(visitId, messageId),
    ctx = context(f.runtime, "agent-0", "@subject");
  ctx.runtimeKind = "subject-social";
  ctx.socialBinding = {
    target: { kind: "visit", id: visitId },
    actorIdentity: { agentId: "agent-0", generation: host },
  };
  return {
    ...f,
    db,
    ctx,
    marker,
    visitId,
    messageId,
    invitationId,
    host,
    guest,
  };
}

test("social labels merge monotonically and reject malformed values", () => {
  const marker = socialMarker(randomUUID(), randomUUID());
  assert.deepEqual(
    mergeProtection(
      { protectedSocialSources: [marker] },
      { protectedSocialSources: [] },
    ),
    { protectedSocialSources: [marker] },
  );
  for (const value of [marker, ["social:claimed:audience"], [1]])
    assert.throws(
      () => mergeProtection({ protectedSocialSources: value }),
      /INVALID_PROTECTION_METADATA/,
    );
});

test("social derived records require current same-visit authority, including terminal history", (t) => {
  const f = setup(t),
    row = {
      id: "derived-note",
      body: "private",
      protectedSocialSources: [f.marker],
    };
  assert.equal(recallBoundary(f.runtime, f.ctx).allowed(row), true);
  for (const kind of ["subject", "chat", "work"])
    assert.equal(
      recallBoundary(f.runtime, { ...f.ctx, runtimeKind: kind }).allowed(row),
      false,
    );
  assert.equal(
    recallBoundary(f.runtime, f.ctx, { publicOnly: true }).allowed(row),
    false,
  );
  assert.equal(
    recallBoundary(f.runtime, {
      ...f.ctx,
      socialBinding: {
        ...f.ctx.socialBinding,
        target: { kind: "invitation", id: f.visitId },
      },
    }).allowed(row),
    false,
  );
  assert.equal(
    socialContextAllowed(
      f.runtime,
      {
        ...f.ctx,
        socialBinding: {
          ...f.ctx.socialBinding,
          actorIdentity: { agentId: "agent-0", generation: randomUUID() },
        },
      },
      [f.marker],
    ),
    false,
  );
  assert.equal(
    socialContextAllowed(f.runtime, f.ctx, [
      socialMarker(randomUUID(), f.messageId),
    ]),
    false,
  );
  for (const status of ["ended", "expired"]) {
    f.db.prepare("UPDATE home_social_visits SET status=?").run(status);
    assert.equal(socialContextAllowed(f.runtime, f.ctx, [f.marker]), true);
  }
  f.db.prepare("UPDATE home_social_visits SET status='invalidated'").run();
  assert.equal(socialContextAllowed(f.runtime, f.ctx, [f.marker]), false);
});

test("revocation, block, generation replacement and tombstones close derived reads", (t) => {
  const f = setup(t);
  for (const column of ["retracted_at", "hidden_at", "body_cleared_at"]) {
    f.db.exec(`UPDATE home_social_messages SET ${column}=1`);
    assert.equal(socialContextAllowed(f.runtime, f.ctx, [f.marker]), false);
    f.db.exec(`UPDATE home_social_messages SET ${column}=NULL`);
  }
  const { host_generation: host, guest_generation: guest } = f.db
    .prepare("SELECT * FROM home_social_visits")
    .get();
  f.db
    .prepare(
      "INSERT INTO home_social_blocks(actor_generation,target_generation,revision,active,created_at) VALUES(?,?,1,1,0)",
    )
    .run(host, guest);
  assert.equal(socialContextAllowed(f.runtime, f.ctx, [f.marker]), false);
  f.db.exec("DELETE FROM home_social_blocks");
  f.db
    .prepare("UPDATE home_identities SET generation=? WHERE agent_id='agent-1'")
    .run(randomUUID());
  assert.equal(socialContextAllowed(f.runtime, f.ctx, [f.marker]), false);
});

test("persisted social taint survives deleted sources and defeats ordinary grants", async (t) => {
  const f = setup(t),
    m = f.store.bind("agent-0");
  const event = m.append({
    dedupe: "social-derivative",
    conversation: "@subject",
    kind: "subject.log",
    direction: "internal",
    body: "private derivative",
    payload: { protectedSocialSources: [f.marker] },
  });
  f.ctx.privateRead.add(event.id);
  assert.deepEqual(socialSources(f.runtime, f.ctx), [f.marker]);
  assert.equal(sourceClass(f.runtime, f.ctx, event.id), "social-private");
  trackMindRecords(f.runtime, f.ctx, [
    { id: "frozen-note", protectedSocialSources: [f.marker] },
  ]);
  f.db.prepare("DELETE FROM events WHERE id=?").run(event.id);
  assert.deepEqual(contextProtection(f.runtime, f.ctx).protectedSocialSources, [
    f.marker,
  ]);
  f.ctx.grants.add(f.marker);
  assert.throws(
    () => f.runtime.assertDisclosure(f.ctx),
    /SOCIAL_SOURCE_DENIED/,
  );
  assert.throws(
    () =>
      f.runtime.authorizeExternal(
        f.ctx,
        { tool: "web_fetch", args: { url: "https://example.com/" } },
        { fixed: true },
      ),
    /SOCIAL_SOURCE_DENIED/,
  );
  assert.throws(
    () => f.runtime.home.rooms.shareable(f.ctx),
    /HOME_SOURCE_DENIED/,
  );
  await assert.rejects(
    f.runtime.executeTool(f.ctx, "self_propose", {
      body: "private",
      reason: "private",
      evidence: [],
      counterEvidence: [],
      scope: "interest",
      expectedVersion: 1,
    }),
    /RESTRICTED_CONTEXT_MIND_WRITE_BLOCKED/,
  );
});

test("personal exports and imported snapshots strip text but retain durable social labels", (t) => {
  const f = setup(t),
    m = f.store.bind("agent-0");
  m.append({
    dedupe: "export-private",
    conversation: "@subject",
    kind: "subject.log",
    direction: "internal",
    body: "OTHER_ROLE_PRIVATE",
    payload: {
      summary: "OTHER_ROLE_PRIVATE",
      protectedSocialSources: [f.marker],
      evidenceSnapshot: { references: [{ body: "OTHER_ROLE_PRIVATE" }] },
    },
  });
  const exported = m.export();
  assert.equal(JSON.stringify(exported).includes("OTHER_ROLE_PRIVATE"), false);
  assert.equal(JSON.stringify(exported).includes(f.marker), true);
  const direct = socialSafeExportRow("diaries", {
    title: "OTHER_ROLE_PRIVATE",
    body: "OTHER_ROLE_PRIVATE",
    metadata: JSON.stringify({ protectedSocialSources: [f.marker] }),
  });
  assert.equal(direct.body, "");
  assert.equal(direct.title, "");
  const target = fixture(t, { cfg: config(2) });
  for (const table of Object.keys(exported.tables)) {
    if (
      target.store.db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .some((column) => column.name === "agent_id")
    )
      target.store.db
        .prepare(`DELETE FROM ${table} WHERE agent_id=?`)
        .run("agent-0");
  }
  restoreExport(target.store.bind("agent-0"), exported);
  const imported = target.store.bind("agent-0").export();
  assert.equal(JSON.stringify(imported).includes("OTHER_ROLE_PRIVATE"), false);
  assert.equal(JSON.stringify(imported).includes(f.marker), true);
});

test("unavailable social authority tables fail closed", (t) => {
  const f = fixture(t),
    ctx = context(f.runtime, "agent-0", "@subject");
  f.runtime.config.homeSocial = { enabled: true, retentionDays: 30 };
  f.store.db.exec("DROP TABLE home_social_policy");
  ctx.runtimeKind = "subject-social";
  ctx.socialBinding = {
    target: { kind: "visit", id: randomUUID() },
    actorIdentity: { agentId: ctx.agentId, generation: randomUUID() },
  };
  assert.equal(
    socialContextAllowed(f.runtime, ctx, [
      socialMarker(randomUUID(), randomUUID()),
    ]),
    false,
  );
  trackSocial(ctx, {
    protectedSocialSources: [socialMarker(randomUUID(), randomUUID())],
  });
  assert.equal(ctx.privateRead.size > 0, true);
});

test("diary creation and revision inherit social context even without selected evidence", async (t) => {
  const f = setup(t);
  f.ctx.privateRead.add(f.marker);
  const diary = await f.runtime.executeTool(f.ctx, "diary_write", {
    title: "private diary",
    body: "private details",
    people: [],
    tags: [],
    evidence: [],
  });
  const m = f.store.bind("agent-0");
  assert.deepEqual(
    JSON.parse(
      m.db.prepare("SELECT metadata FROM diaries WHERE id=?").get(diary.id)
        .metadata,
    ).protectedSocialSources,
    [f.marker],
  );
  await f.runtime.executeTool(f.ctx, "diary_revise", {
    id: diary.id,
    expectedRevision: 1,
    title: "edited",
    body: "edited",
    evidence: [],
  });
  const ordinary = context(f.runtime, "agent-0", "group:20000");
  assert.equal(
    recallBoundary(f.runtime, ordinary).allowed({ id: diary.id }),
    false,
  );
  assert.equal(
    m.export().tables.diaries.find((row) => row.id === diary.id).body,
    "",
  );
});

test("streamed worker export omits social private text and preserves protection", async (t) => {
  const f = setup(t),
    m = f.store.bind("agent-0");
  m.append({
    dedupe: "worker-private",
    conversation: "@subject",
    kind: "subject.log",
    direction: "internal",
    body: "OTHER_ROLE_PRIVATE_WORKER",
    payload: {
      protectedSocialSources: [f.marker],
      summary: "OTHER_ROLE_PRIVATE_WORKER",
    },
  });
  const output = path.join(f.root, "social-export.json");
  await exportToFile(f.store, "agent-0", output);
  const raw = await fs.readFile(output, "utf8");
  assert.equal(raw.includes("OTHER_ROLE_PRIVATE_WORKER"), false);
  assert.equal(raw.includes(f.marker), true);
});

test("invitation purpose derives protected diary and cannot cross visits or revisions", async (t) => {
  const f = setup(t),
    marker = socialInvitationMarker(f.invitationId, 1);
  const invitationContext = {
    ...f.ctx,
    socialBinding: {
      ...f.ctx.socialBinding,
      target: { kind: "invitation", id: f.invitationId },
    },
  };
  assert.equal(
    socialContextAllowed(f.runtime, invitationContext, [marker]),
    true,
  );
  assert.equal(socialContextAllowed(f.runtime, f.ctx, [marker]), true);
  trackSocial(f.ctx, { protectedSocialSources: [marker] });
  const diary = await f.runtime.executeTool(f.ctx, "diary_write", {
    title: "PURPOSE_SECRET",
    body: "PURPOSE_SECRET",
    evidence: [],
  });
  const row = { id: diary.id };
  assert.equal(recallBoundary(f.runtime, f.ctx).allowed(row), true);
  const other = {
    ...f.ctx,
    socialBinding: {
      ...f.ctx.socialBinding,
      target: { kind: "visit", id: randomUUID() },
    },
  };
  assert.equal(recallBoundary(f.runtime, other).allowed(row), false);
  f.db.prepare("UPDATE home_social_invitations SET revision=2").run();
  assert.equal(recallBoundary(f.runtime, f.ctx).allowed(row), false);
  f.db
    .prepare("UPDATE home_social_invitations SET revision=1,body_cleared_at=1")
    .run();
  assert.equal(
    socialContextAllowed(f.runtime, invitationContext, [marker]),
    false,
  );
  const exported = f.store.bind("agent-0").export();
  assert.equal(JSON.stringify(exported).includes("PURPOSE_SECRET"), false);
  assert.equal(JSON.stringify(exported).includes(marker), true);
});

function installGrant(f, selected = []) {
  f.runtime.config.agents[0].home.enabled = true;
  f.runtime.config.agents[0].home.publishing = true;
  const scope = ["layout", ...selected.map((item) => item.slot)];
  f.db
    .prepare(
      "INSERT INTO home_social_grants(visit_id,invitation_id,room_id,host_generation,guest_generation,scope,selected_item_revisions,revision,policy_revision,expires_at,revoked_at) VALUES(?,?,?,?,?,?,?,1,0,?,NULL)",
    )
    .run(
      f.visitId,
      f.invitationId,
      "room:" + f.host,
      f.host,
      f.guest,
      JSON.stringify(scope),
      JSON.stringify(selected),
      Date.now() + 60000,
    );
  return socialGrantMarker(f.visitId, 1);
}

test("grant derives protected note and revocation, limits or terminal visit invalidate it", async (t) => {
  const f = setup(t),
    marker = installGrant(f);
  assert.equal(socialContextAllowed(f.runtime, f.ctx, [marker]), true);
  trackSocial(f.ctx, { protectedSocialSources: [marker] });
  const { mindTool } = await import("../src/tools/mind.mjs");
  const source = f.store.bind("agent-0").append({
    dedupe: "grant-note",
    conversation: "@subject",
    kind: "subject.log",
    direction: "internal",
    body: "GRANT_SECRET",
    payload: { protectedSocialSources: [marker] },
  });
  const note = mindTool(f.runtime, f.ctx, "work_note", {
    body: "GRANT_SECRET",
    evidence: [source.id],
    uncertainty: "test",
    status: "open",
  });
  assert.equal(recallBoundary(f.runtime, f.ctx).allowed(note), true);
  f.db.prepare("UPDATE home_social_grants SET revision=2").run();
  assert.equal(recallBoundary(f.runtime, f.ctx).allowed(note), false);
  f.db.prepare("UPDATE home_social_grants SET revision=1,revoked_at=1").run();
  assert.equal(socialContextAllowed(f.runtime, f.ctx, [marker]), false);
  f.db
    .prepare("UPDATE home_social_grants SET revoked_at=NULL,expires_at=0")
    .run();
  assert.equal(socialContextAllowed(f.runtime, f.ctx, [marker]), false);
  f.db
    .prepare("UPDATE home_social_grants SET expires_at=?")
    .run(Date.now() + 60000);
  f.db.prepare("UPDATE home_social_visits SET status='ended'").run();
  assert.equal(socialContextAllowed(f.runtime, f.ctx, [marker]), false);
  const raw = JSON.stringify(f.store.bind("agent-0").export());
  assert.equal(raw.includes("GRANT_SECRET"), false);
  assert.equal(raw.includes(marker), true);
});

test("grant exact fixed-draft proof rejects unknown originals, replacement and upstream protection", async (t) => {
  const f = setup(t),
    m = f.store.bind("agent-0");
  f.runtime.config.agents[0].home.enabled = true;
  f.runtime.config.agents[0].home.publishing = true;
  f.runtime.config.agents[0].home.projectSnapshots = { enabled: true };
  const author = context(f.runtime, "agent-0", "@subject");
  let project = await f.runtime.executeTool(author, "project", {
    title: "own draft",
    why: "original",
  });
  project = participateInProject(f.runtime, "agent-0", {
    id: project.id,
    expectedRevision: 1,
    submissionId: randomUUID(),
    action: "join",
  }).project;
  await f.runtime.executeTool(author, "projects", { id: project.id });
  project = await f.runtime.executeTool(author, "project", {
    id: project.id,
    expectedRevision: project.revision,
    draft: { title: "fixed", text: "original fixed bytes" },
  });
  const room = await f.runtime.executeTool(author, "room_read", {});
  const published = await f.runtime.executeTool(
    author,
    "room_publish_snapshot",
    {
      identityGeneration: room.identityGeneration,
      slot: "work-1",
      expectedItemRevision: 0,
      requestId: "grant-snapshot-test",
      source: {
        type: "project-draft",
        id: project.id,
        revision: project.revision,
      },
    },
  );
  const item = published.current.items.find((row) => row.slot === "work-1");
  const marker = installGrant(f, [
    { slot: item.slot, itemId: item.itemId, itemRevision: item.itemRevision },
  ]);
  const selected = {
    hostGeneration: f.host,
    slot: item.slot,
    itemId: item.itemId,
    itemRevision: item.itemRevision,
  };
  assert.doesNotThrow(() =>
    assertRoomItemShareable(f.runtime, f.ctx, selected),
  );
  assert.equal(socialContextAllowed(f.runtime, f.ctx, [marker]), true);
  for (const sql of [
    "UPDATE home_items SET state='retracted'",
    "UPDATE home_items SET revision=2",
    "UPDATE home_items SET item_id='replacement'",
    "UPDATE home_items SET body='forged bytes'",
  ]) {
    f.db.exec(sql);
    assert.equal(socialContextAllowed(f.runtime, f.ctx, [marker]), false);
    f.db
      .prepare(
        "UPDATE home_items SET item_id=?,revision=1,state='published',body='original fixed bytes'",
      )
      .run(item.itemId);
  }
  f.runtime.config.agents[0].home.projectSnapshots.enabled = false;
  assert.equal(socialContextAllowed(f.runtime, f.ctx, [marker]), false);
  f.runtime.config.agents[0].home.projectSnapshots.enabled = true;
  f.runtime.config.agents[0].home.publishing = false;
  assert.equal(socialContextAllowed(f.runtime, f.ctx, [marker]), false);
  f.runtime.config.agents[0].home.publishing = true;
  const storedSource = f.db
    .prepare(
      "SELECT value FROM home_item_sources WHERE generation=? AND slot='work-1'",
    )
    .get(f.host).value;
  f.db.prepare("DELETE FROM home_item_sources WHERE generation=?").run(f.host);
  assert.throws(
    () => assertRoomItemShareable(f.runtime, f.ctx, selected),
    /SOCIAL_SOURCE_DENIED/,
  );
  f.db
    .prepare("INSERT INTO home_item_sources VALUES(?,'work-1',?)")
    .run(f.host, storedSource);
  const original = m.identity.project(project.id);
  m.db
    .prepare("UPDATE projects SET value=? WHERE agent_id=? AND id=?")
    .run(
      JSON.stringify({ ...original, protectedOperations: true }),
      "agent-0",
      project.id,
    );
  assert.equal(socialContextAllowed(f.runtime, f.ctx, [marker]), false);
});

test("all social source families share validation, merge and export recognition", () => {
  const markers = [
    socialMarker(randomUUID(), randomUUID()),
    socialGrantMarker(randomUUID(), 3),
    socialInvitationMarker(randomUUID(), 2),
  ];
  assert.deepEqual(
    mergeProtection(
      ...markers.map((marker) => ({ protectedSocialSources: [marker] })),
    ).protectedSocialSources,
    [...markers].sort(),
  );
  for (const marker of markers) {
    assert.ok(parseSocialMarker(marker));
    const row = socialSafeExportRow("events", {
      body: "SECRET",
      payload: JSON.stringify({ protectedSocialSources: [marker] }),
    });
    assert.equal(row.body, "");
    assert.ok(row.payload.includes(marker));
  }
  assert.equal(
    parseSocialMarker(`social-grant:${randomUUID()}:9007199254740992`),
    null,
  );
});

test("social send checks its exact binding and closes sending on restricted recollection", (t) => {
  const f = setup(t);
  trackSocial(f.ctx, { protectedSocialSources: [f.marker] });
  assert.doesNotThrow(() =>
    assertSocialSend(f.runtime, f.ctx, { kind: "visit", id: f.visitId }),
  );
  f.ctx.privateRead.add("peer-qzone:30000");
  f.ctx.grants.add("peer-qzone:30000");
  assert.throws(
    () => assertSocialSend(f.runtime, f.ctx, { kind: "visit", id: f.visitId }),
    /SOCIAL_SOURCE_DENIED/,
  );
  assert.equal(f.ctx.socialSendingClosed, true);
  f.ctx.privateRead.delete("peer-qzone:30000");
  assert.throws(
    () => assertSocialSend(f.runtime, f.ctx, { kind: "visit", id: f.visitId }),
    /SOCIAL_SOURCE_DENIED/,
  );
});

test("new original attestation is exact, transactional and never inherited by legacy or retracted versions", async (t) => {
  const f = setup(t),
    author = context(f.runtime, "agent-0", "@subject");
  f.runtime.config.agents[0].home.enabled = true;
  f.runtime.config.agents[0].home.publishing = true;
  const call = (name, args = {}) => f.runtime.executeTool(author, name, args);
  let room = await call("room_read");
  const publish = (revision, requestId) =>
    call("room_publish", {
      identityGeneration: room.identityGeneration,
      slot: "intro",
      expectedItemRevision: revision,
      requestId,
      title: "original",
      body: "safe original",
      source: "original-text",
    });
  const first = await publish(0, "original-proof-first");
  const item = first.current.items.find((row) => row.slot === "intro");
  const selected = {
    hostGeneration: f.host,
    slot: item.slot,
    itemId: item.itemId,
    itemRevision: item.itemRevision,
  };
  assert.doesNotThrow(() =>
    assertRoomItemShareable(f.runtime, f.ctx, selected),
  );
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM home_social_item_proofs").get().n,
    1,
  );
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM home_item_sources").get().n,
    0,
  );
  const marker = installGrant(f, [
    { slot: item.slot, itemId: item.itemId, itemRevision: item.itemRevision },
  ]);
  assert.equal(socialContextAllowed(f.runtime, f.ctx, [marker]), true);
  const saved = f.db.prepare("SELECT * FROM home_social_item_proofs").get();
  f.db.exec("DELETE FROM home_social_item_proofs");
  assert.throws(
    () => assertRoomItemShareable(f.runtime, f.ctx, selected),
    /SOCIAL_SOURCE_DENIED/,
  );
  f.db
    .prepare("INSERT INTO home_social_item_proofs VALUES(?,?,?,?,?,?,?,?)")
    .run(
      saved.generation,
      saved.slot,
      saved.item_id,
      saved.item_revision,
      saved.proof_version,
      saved.content_hash,
      saved.source_ids,
      saved.created_at,
    );
  await call("room_retract", {
    identityGeneration: room.identityGeneration,
    slot: "intro",
    expectedItemRevision: 1,
    requestId: "original-proof-retract",
  });
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM home_social_item_proofs").get().n,
    0,
  );
  await publish(2, "original-proof-republish");
  assert.equal(socialContextAllowed(f.runtime, f.ctx, [marker]), false);
  assert.doesNotThrow(() =>
    assertRoomItemShareable(f.runtime, f.ctx, { ...selected, itemRevision: 3 }),
  );
  f.db.exec(
    "CREATE TRIGGER original_proof_failure BEFORE INSERT ON home_social_item_proofs BEGIN SELECT RAISE(ABORT,'synthetic-proof'); END",
  );
  await assert.rejects(publish(3, "original-proof-failure"), /synthetic-proof/);
  assert.equal(
    f.db.prepare("SELECT revision FROM home_items WHERE slot='intro'").get()
      .revision,
    3,
  );
  assert.equal(
    f.db.prepare("SELECT item_revision FROM home_social_item_proofs").get()
      .item_revision,
    3,
  );
  f.db.exec("DROP TRIGGER original_proof_failure");
  author.privateRead.add("peer-qzone:30000");
  await assert.rejects(
    publish(3, "original-proof-restricted"),
    /HOME_SOURCE_DENIED/,
  );
  assert.equal(
    f.db.prepare("SELECT item_revision FROM home_social_item_proofs").get()
      .item_revision,
    3,
  );
});

test("QQ forward readers remain unavailable in a subject-social capability scope", async (t) => {
  const f = setup(t),
    m = f.store.bind("agent-0");
  f.runtime.agent("agent-0").tools.push("qq_forward_read");
  trackSocial(f.ctx, { protectedSocialSources: [f.marker] });
  const root = m.append({
    dedupe: "mixed-forward-root",
    conversation: "private:30000",
    kind: "message.received",
    body: "private merged forward",
    senderId: "30000",
    payload: {
      segments: [{ type: "forward", data: { id: "private-resource" } }],
    },
  });
  let calls = 0;
  f.runtime.transports.get("qq-0").call = async () => {
    calls++;
    return { messages: [] };
  };
  await assert.rejects(
    f.runtime.executeTool(f.ctx, "qq_forward_read", {
      eventId: root.id,
      limit: 1,
      maxChars: 1000,
    }),
    /TOOL_DISABLED/,
  );
  assert.equal(calls, 0);
  assert.equal(
    m.db
      .prepare("SELECT count(*) n FROM events WHERE kind='forward.node'")
      .get().n,
    0,
  );
});

test("legacy mixed source metadata cannot hide QQ origin behind a social marker", (t) => {
  const f = setup(t),
    m = f.store.bind("agent-0");
  for (const conversation of ["private:30000", "group:20000"]) {
    const record = m.append({
      dedupe: "mixed-compat:" + conversation,
      conversation,
      kind: "forward.node",
      body: "PRIVATE_COMPAT_TEXT",
      payload: { protectedSocialSources: [f.marker] },
    });
    const bound = {
      ...f.ctx,
      privateRead: new Set([record.id]),
      socialSendingClosed: false,
    };
    assert.throws(
      () =>
        assertSocialSend(f.runtime, bound, { kind: "visit", id: f.visitId }),
      /SOCIAL_SOURCE_DENIED/,
    );
  }
  for (const scope of ["private:30000", "group:20000"]) {
    const record = m.append({
      dedupe: "derived-compat:" + scope,
      conversation: "@social:synthetic-run",
      kind: "external.read",
      body: "PRIVATE_COMPAT_TEXT",
      payload: {
        protectedSocialSources: [f.marker],
        app: { source: { conversation: scope } },
      },
    });
    const bound = {
      ...f.ctx,
      privateRead: new Set([record.id]),
      socialSendingClosed: false,
    };
    assert.throws(
      () =>
        assertSocialSend(f.runtime, bound, { kind: "visit", id: f.visitId }),
      /SOCIAL_SOURCE_DENIED/,
    );
  }
  const social = m.append({
    dedupe: "valid-social-origin",
    conversation: "@social:synthetic-run",
    kind: "subject.log",
    body: "same visit",
    payload: { protectedSocialSources: [f.marker] },
  });
  assert.doesNotThrow(() =>
    assertSocialSend(
      f.runtime,
      { ...f.ctx, privateRead: new Set([social.id]) },
      { kind: "visit", id: f.visitId },
    ),
  );
});

test("source reads enforce retention deadlines before delayed cleanup materializes tombstones", (t) => {
  const f = setup(t),
    day = 86400000,
    now = f.runtime.now();
  f.runtime.now = () => now;
  const invitation = socialInvitationMarker(f.invitationId, 1);
  f.db
    .prepare(
      "UPDATE home_social_visits SET status='ended',ended_at=?,expires_at=?",
    )
    .run(now - 30 * day + 1, now + day);
  assert.equal(socialContextAllowed(f.runtime, f.ctx, [f.marker]), true);
  f.db.prepare("UPDATE home_social_visits SET ended_at=?").run(now - 30 * day);
  assert.equal(socialContextAllowed(f.runtime, f.ctx, [f.marker]), false);
  assert.equal(socialContextAllowed(f.runtime, f.ctx, [invitation]), false);
  f.db
    .prepare(
      "UPDATE home_social_visits SET status='active',ended_at=NULL,expires_at=?",
    )
    .run(now - 30 * day);
  assert.equal(socialContextAllowed(f.runtime, f.ctx, [f.marker]), false);
  f.db
    .prepare("UPDATE home_social_visits SET status='active',expires_at=?")
    .run(now + day);
  f.db
    .prepare(
      "UPDATE home_social_invitations SET status='declined',decided_at=?",
    )
    .run(now - 30 * day);
  const invitationContext = {
    ...f.ctx,
    socialBinding: {
      ...f.ctx.socialBinding,
      target: { kind: "invitation", id: f.invitationId },
    },
  };
  assert.equal(
    socialContextAllowed(f.runtime, invitationContext, [invitation]),
    false,
  );
  assert.equal(
    f.db.prepare("SELECT body_cleared_at FROM home_social_messages").get()
      .body_cleared_at,
    null,
  );
});

test("accepted invitation retention follows its associated visit termination", (t) => {
  const f = setup(t),
    day = 86400000;
  let now = f.runtime.now();
  f.runtime.now = () => now;
  const marker = socialInvitationMarker(f.invitationId, 1);
  f.db
    .prepare(
      "UPDATE home_social_invitations SET created_at=?,decided_at=?,expires_at=?",
    )
    .run(now - 60 * day, now - 59 * day, now - 57 * day);
  f.db
    .prepare(
      "UPDATE home_social_visits SET status='ended',started_at=?,ended_at=?,expires_at=?",
    )
    .run(now - 59 * day, now - 29 * day, now - 29 * day);
  const invitationContext = {
    ...f.ctx,
    socialBinding: {
      ...f.ctx.socialBinding,
      target: { kind: "invitation", id: f.invitationId },
    },
  };
  assert.equal(
    socialContextAllowed(f.runtime, invitationContext, [marker]),
    true,
  );
  assert.equal(socialContextAllowed(f.runtime, f.ctx, [marker]), true);
  now += day;
  assert.equal(
    socialContextAllowed(f.runtime, invitationContext, [marker]),
    false,
  );
  assert.equal(socialContextAllowed(f.runtime, f.ctx, [marker]), false);
  assert.equal(
    f.db.prepare("SELECT body_cleared_at FROM home_social_invitations").get()
      .body_cleared_at,
    null,
  );
});

test("ordinary persisted taint above 1000 sources still executes tools and sends", async (t) => {
  const f = fixture(t),
    m = f.store.bind("agent-0"),
    ids = [];
  assert.equal(f.runtime.config.homeSocial?.enabled === true, false);
  for (let i = 0; i < 1002; i++)
    ids.push(
      m.append({
        dedupe: `ordinary-many-${i}`,
        conversation: "group:20000",
        kind: "message.received",
        body: "ordinary same-chat material",
      }).id,
    );
  m.setState("group:20000", {
    ...m.state("group:20000"),
    disclosureTaint: ids,
  });
  const ctx = context(f.runtime);
  assert.equal(ctx.privateRead.size, 1002);
  await f.runtime.executeTool(ctx, "diary_write", {
    title: "ordinary diary",
    body: "ordinary material",
    evidence: [],
    people: [],
    tags: [],
  });
  const receipt = await f.runtime.executeTool(ctx, "qq_send", {
    requestId: "ordinary-many-send",
    text: "ordinary reply",
  });
  assert.equal(receipt.status, "sent");
  assert.equal(f.runtime.transports.get("qq-0").sent.length, 1);
  assert.ok(m.state("group:20000").disclosureTaint.length >= 1002);
});

test("complete cyclic evidence traversal finds social sources beyond 1000 records", async (t) => {
  const f = fixture(t),
    m = f.store.bind("agent-0"),
    marker = socialMarker(randomUUID(), randomUUID());
  let previous;
  for (let i = 0; i < 1002; i++)
    previous = m.append({
      dedupe: `deep-social-${i}`,
      conversation: "group:20000",
      kind: "message.received",
      body: "derived material",
      payload: previous
        ? { evidence: [previous.id] }
        : { protectedSocialSources: [marker] },
    });
  // A cycle must terminate without truncating the rest of the finite graph.
  const leaf = m.db
    .prepare("SELECT id FROM events WHERE dedupe='deep-social-0'")
    .get();
  m.db.prepare("UPDATE events SET payload=? WHERE id=?").run(
    JSON.stringify({
      protectedSocialSources: [marker],
      evidence: [previous.id],
    }),
    leaf.id,
  );
  const ctx = context(f.runtime);
  ctx.privateRead.add(previous.id);
  assert.deepEqual(socialSources(f.runtime, ctx), [marker]);
  ctx.persistTaint();
  assert.ok(ctx.privateRead.has(marker));
  await assert.rejects(
    f.runtime.executeTool(ctx, "qq_send", {
      requestId: "deep-social-denied",
      text: "must remain private",
    }),
    /SOCIAL_SOURCE_DENIED/,
  );
  assert.equal(f.runtime.transports.get("qq-0").sent.length, 0);
});

test("social export and restore preserve other protection identifiers for later revision", async (t) => {
  const f = setup(t),
    m = f.store.bind("agent-0");
  f.ctx.privateRead.add(f.marker);
  const diary = await f.runtime.executeTool(f.ctx, "diary_write", {
    title: "MIXED_PRIVATE_TEXT",
    body: "MIXED_PRIVATE_TEXT",
    evidence: [],
    people: [],
    tags: [],
  });
  const labels = {
    protectedSocialSources: [f.marker],
    protectedPeerQzoneTargets: ["30000"],
    protectedRepositories: ["example/private-project"],
    protectedOperations: true,
  };
  const metadata = JSON.parse(
    m.db.prepare("SELECT metadata FROM diaries WHERE id=?").get(diary.id)
      .metadata,
  );
  m.db.prepare("UPDATE diaries SET metadata=? WHERE id=?").run(
    JSON.stringify({
      ...metadata,
      ...labels,
      frozen: { ...labels, body: "MIXED_PRIVATE_TEXT" },
    }),
    diary.id,
  );
  const exported = m.export();
  const assertRedaction = (data) => {
    assert.equal(JSON.stringify(data).includes("MIXED_PRIVATE_TEXT"), false);
    const row = data.tables.diaries.find((item) => item.id === diary.id);
    const saved = JSON.parse(row.metadata);
    assert.deepEqual(mergeProtection(saved), labels);
    assert.deepEqual(mergeProtection(saved.frozen), labels);
    assert.equal(saved.frozen.body, "");
  };
  assertRedaction(exported);
  const output = path.join(f.root, "mixed-social-export.json");
  await exportToFile(f.store, "agent-0", output);
  assertRedaction(JSON.parse(await fs.readFile(output, "utf8")));
  const target = fixture(t, { cfg: config(2) });
  for (const table of Object.keys(exported.tables)) {
    if (
      target.store.db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .some((column) => column.name === "agent_id")
    )
      target.store.db
        .prepare(`DELETE FROM ${table} WHERE agent_id=?`)
        .run("agent-0");
  }
  const restored = target.store.bind("agent-0");
  restoreExport(restored, exported);
  assertRedaction(restored.export());
  assert.deepEqual(
    restored.diaryRevise({
      id: diary.id,
      expectedRevision: 1,
      title: "updated",
      body: "updated",
      evidence: [],
      people: [],
      tags: [],
    }),
    { id: diary.id, revision: 2 },
  );
  const revised = JSON.parse(
    restored.db.prepare("SELECT metadata FROM diaries WHERE id=?").get(diary.id)
      .metadata,
  );
  assert.deepEqual(mergeProtection(revised), labels);
  assert.equal(
    restored.export().tables.diaries.find((item) => item.id === diary.id).body,
    "",
  );
});

test("social export prefilter still checks escaped keys and marker text", () => {
  const marker = socialMarker(randomUUID(), randomUUID());
  for (const payload of [
    JSON.stringify({ protectedSocialSources: [marker] }),
    JSON.stringify({ protectedSocialSources: [marker] }).replaceAll(
      "s",
      "\\u0073",
    ),
    JSON.stringify({ evidence: [marker] }).replaceAll("s", "\\u0073"),
    JSON.stringify({ evidence: [marker.toUpperCase()] }),
  ]) {
    const result = socialSafeExportRow("events", { body: "private", payload });
    assert.equal(result.body, "");
    assert.ok(
      JSON.stringify(JSON.parse(result.payload))
        .toLowerCase()
        .includes("social:"),
    );
  }
  const mixed = {
    protectedSocialSources: [marker],
    protectedRepositories: ["owner/private"],
    protectedPeerQzoneTargets: ["30000"],
    protectedOperations: true,
  };
  const nested = socialSafeExportRow("events", {
    body: "private",
    payload: JSON.stringify({ frozen: { ...mixed, body: "nested private" } })
      .replaceAll("S", "\\u0053")
      .replaceAll("s", "\\u0073"),
  });
  assert.equal(nested.body, "");
  const frozen = JSON.parse(nested.payload).frozen;
  assert.equal(frozen.body, "");
  assert.deepEqual(mergeProtection(frozen), mixed);
  const ordinary = {
    body: "ordinary",
    payload: JSON.stringify({ text: "plain" }),
  };
  assert.deepEqual(socialSafeExportRow("events", ordinary), ordinary);
});

test("social export labels in one field redact all sibling JSON fields", () => {
  const marker = socialMarker(randomUUID(), randomUUID());
  for (const protectedField of ["metadata", "payload", "value"]) {
    const original = {
      body: "private body",
      payload: JSON.stringify({ text: "private payload" }),
      metadata: JSON.stringify({ text: "private metadata" }),
      value: JSON.stringify({ text: "private value" }),
      [protectedField]: JSON.stringify({ protectedSocialSources: [marker] }),
    };
    const row = socialSafeExportRow("events", original);
    assert.equal(row.body, "");
    for (const field of ["metadata", "payload", "value"])
      if (field === protectedField)
        assert.deepEqual(JSON.parse(row[field]).protectedSocialSources, [
          marker,
        ]);
      else assert.equal(JSON.parse(row[field]).text, "");
  }
});
