import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture, config } from "./helpers.mjs";
import {
  saveSocialHandoff,
  readSocialHandoff,
  socialHandoffSchema,
} from "../src/home/social-handoff.mjs";
import {
  socialMarker,
  createSocialWindowHistory,
  captureSocialWindowHistory,
  socialInputLeaseAllowed,
} from "../src/core/social-protection.mjs";
import { migrateHomeSocial } from "../src/home/social-schema.mjs";

function setup(t) {
  const cfg = config(3);
  cfg.homeSocial.enabled = true;
  cfg.homeSocial.exchangeEnabled = true;
  for (const agent of cfg.agents) {
    agent.subject.enabled = true;
    agent.home = {
      ...agent.home,
      enabled: true,
      publishing: true,
      social: { enabled: true },
    };
  }
  const f = fixture(t, { cfg }),
    r = f.runtime,
    s = r.homeSocial,
    db = f.store.db;
  let now = 1800000000000;
  r.now = () => now;
  function ctx(agentId, target) {
    const b = s.targetBinding(s.identity(agentId), target),
      turnId = randomUUID();
    db.prepare(
      "UPDATE home_social_turns SET status='completed' WHERE actor_generation=? AND status='running'",
    ).run(b.actorIdentity.generation);
    const c = r.makeContext(agentId, `@social:${turnId}`);
    c.runtimeKind = "subject-social";
    c.privateRead = new Set();
    c.socialBinding = {
      ...b,
      runId: turnId,
      turnId,
      runMode: "async",
      windowId: null,
      epoch: 0,
      fence: 0,
    };
    db.prepare(
      "INSERT INTO home_social_turns(id,visit_id,target_kind,target_id,target_host_generation,target_guest_generation,actor_generation,mode,status,epoch,fence,policy_revision,config_revision,created_at,started_at) VALUES(?,?,?,?,?,?,?,'async','running',0,0,?,?,?,?)",
    ).run(
      turnId,
      b.target.kind === "visit" ? b.target.id : null,
      b.target.kind,
      b.target.id,
      b.targetHostGeneration,
      b.targetGuestGeneration,
      b.actorIdentity.generation,
      b.policyRevision,
      b.configRevision,
      now,
      now,
    );
    return c;
  }
  function visit(guest = "agent-1") {
    const owner = ctx("agent-0", { kind: "compose", id: guest });
    const invitationId = s.invite(owner, {
      requestId: randomUUID(),
      targetAgentId: guest,
      roomOwnerAgentId: "agent-0",
      purpose: "Synthetic private social visit",
      scope: ["layout"],
      selectedItems: [],
    }).result.invitationId;
    const recipient = ctx(guest, { kind: "invitation", id: invitationId });
    s.invitationRead(recipient, { invitationId });
    return s.decide(recipient, {
      requestId: randomUUID(),
      invitationId,
      expectedInvitationRevision: 1,
      decision: "accept",
    }).result.visitId;
  }
  function send(c, visitId, body = "Synthetic source message") {
    return s.send(c, {
      requestId: randomUUID(),
      visitId,
      expectedVisitRevision: db
        .prepare("SELECT revision FROM home_social_visits WHERE id=?")
        .get(visitId).revision,
      body,
    }).result.messageId;
  }
  function save(c, handoff) {
    return s.store.transaction((clock) => {
      const result = saveSocialHandoff(r, c, handoff, clock);
      db.prepare("UPDATE home_social_turns SET batch_sealed=1 WHERE id=?").run(
        c.socialBinding.turnId,
      );
      return result;
    });
  }
  function windowContext(agentId, visitId) {
    const windowId = randomUUID(),
      current = db
        .prepare("SELECT * FROM home_social_visits WHERE id=?")
        .get(visitId);
    db.prepare(
      "INSERT INTO home_social_windows(id,visit_id,proposer_generation,status,terms_revision,terms,effective_limits,policy_revision,created_at,expires_at,started_at,deadline) VALUES(?,?,?,'active','fixture','{}',?,?,?,?,?,?)",
    ).run(
      windowId,
      visitId,
      current.host_generation,
      JSON.stringify(r.config.homeSocial),
      s.policy().revision,
      now,
      now + 60000,
      now,
      now + 60000,
    );
    const c = ctx(agentId, { kind: "visit", id: visitId }),
      b = c.socialBinding;
    db.prepare("DELETE FROM home_social_turns WHERE id=?").run(b.turnId);
    Object.assign(b, { runMode: "window", windowId, windowFence: 0 });
    db.prepare(
      "INSERT INTO home_social_turns(id,visit_id,window_id,target_kind,target_id,target_host_generation,target_guest_generation,actor_generation,mode,status,epoch,fence,policy_revision,config_revision,created_at,started_at) VALUES(?,?,?,'visit',?,?,?,?,'window','running',0,0,?,?,?,?)",
    ).run(
      b.turnId,
      visitId,
      windowId,
      visitId,
      b.targetHostGeneration,
      b.targetGuestGeneration,
      b.actorIdentity.generation,
      b.policyRevision,
      b.configRevision,
      now,
      now,
    );
    c.socialHistory = createSocialWindowHistory(b);
    return c;
  }
  const note = (id, text = "Synthetic unfinished discussion") => ({
    pendingTopics: [{ text, sourceMessageIds: [id] }],
    agreements: [],
  });
  return {
    ...f,
    r,
    s,
    db,
    ctx,
    visit,
    send,
    save,
    note,
    windowContext,
    now: () => now,
    setNow: (v) => {
      now = v;
    },
  };
}

test("handoff schema is bounded, structured and rejects unknown or empty evidence", () => {
  assert.throws(() =>
    socialHandoffSchema.parse({
      pendingTopics: [{ text: "topic", sourceMessageIds: [] }],
      agreements: [],
    }),
  );
  assert.throws(() =>
    socialHandoffSchema.parse({
      pendingTopics: [],
      agreements: [],
      claimedAudience: [],
    }),
  );
  assert.throws(() =>
    socialHandoffSchema.parse({
      pendingTopics: Array.from({ length: 7 }, () => ({
        text: "topic",
        sourceMessageIds: [randomUUID()],
      })),
      agreements: [],
    }),
  );
  assert.deepEqual(
    socialHandoffSchema.parse({ pendingTopics: [], agreements: [] }),
    { pendingTopics: [], agreements: [] },
  );
});

test("completed actor-specific handoff restores semantic notes with exact references and no read watermark", (t) => {
  const f = setup(t),
    visitId = f.visit(),
    writer = f.ctx("agent-0", { kind: "visit", id: visitId });
  const id = f.send(writer, visitId);
  f.save(writer, f.note(id));
  assert.equal(readSocialHandoff(f.r, writer), null);
  const fresh = f.ctx("agent-0", { kind: "visit", id: visitId });
  const restored = readSocialHandoff(f.r, fresh);
  assert.equal(
    restored.pendingTopics[0].text,
    "Synthetic unfinished discussion",
  );
  assert.equal(restored.references[0].messageId, id);
  assert.equal(restored.references[0].body, "Synthetic source message");
  assert.equal(restored.references[0].messageRevision, 1);
  assert.equal(fresh.socialDisplayed, undefined);
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM home_social_read_cursors").get().n,
    0,
  );
  assert.ok(fresh.privateRead.has(socialMarker(visitId, id)));
  const partner = f.ctx("agent-1", { kind: "visit", id: visitId });
  assert.equal(readSocialHandoff(f.r, partner), null);
});

test("save requires an actually displayed or previously delivered incoming source, never arbitrary IDs or another visit", (t) => {
  const f = setup(t),
    visitId = f.visit(),
    otherVisit = f.visit("agent-2");
  const author = f.ctx("agent-1", { kind: "visit", id: visitId }),
    incoming = f.send(author, visitId);
  const actor = f.ctx("agent-0", { kind: "visit", id: visitId });
  assert.throws(() => f.save(actor, f.note(incoming)), /AUDIENCE_DENIED/);
  assert.throws(() => f.save(actor, f.note(randomUUID())), /AUDIENCE_DENIED/);
  const other = f.ctx("agent-2", { kind: "visit", id: otherVisit }),
    foreign = f.send(other, otherVisit);
  assert.throws(() => f.save(actor, f.note(foreign)), /AUDIENCE_DENIED/);
  f.s.visitRead(actor, { visitId });
  assert.doesNotThrow(() => f.save(actor, f.note(incoming)));
  const followup = f.ctx("agent-0", { kind: "visit", id: visitId });
  followup.socialHistory = {
    sources: new Set([socialMarker(visitId, incoming)]),
  };
  assert.doesNotThrow(() => f.save(followup, f.note(incoming)));
});

for (const change of ["retracted", "hidden", "cleared", "transitive"])
  test(`fresh restore filters unavailable source without poisoning the new context: ${change}`, (t) => {
    const f = setup(t),
      visitId = f.visit(),
      writer = f.ctx("agent-0", { kind: "visit", id: visitId });
    const id = f.send(writer, visitId),
      extra = f.send(
        writer,
        visitId,
        "Synthetic independent full-context source",
      );
    writer.privateRead.add(socialMarker(visitId, extra));
    f.save(writer, f.note(id));
    const fresh = f.ctx("agent-0", { kind: "visit", id: visitId });
    const target = change === "transitive" ? extra : id;
    const column =
      change === "retracted" || change === "transitive"
        ? "retracted_at"
        : change === "hidden"
          ? "hidden_at"
          : "body_cleared_at";
    f.db
      .prepare(
        `UPDATE home_social_messages SET ${column}=?,revision=revision+1 WHERE id=?`,
      )
      .run(f.now(), target);
    assert.equal(readSocialHandoff(f.r, fresh), null);
    assert.equal(fresh.privateRead.size, 0);
    assert.equal(fresh.socialInputLeases, undefined);
    assert.throws(
      () => f.save(fresh, f.note(target)),
      /AUDIENCE_DENIED|SOCIAL_SOURCE_DENIED/,
    );
  });

test("later failed snapshots cannot overwrite completed handoff and explicit empty snapshots clear it", (t) => {
  const f = setup(t),
    visitId = f.visit();
  const first = f.ctx("agent-0", { kind: "visit", id: visitId }),
    id = f.send(first, visitId);
  f.save(first, f.note(id, "Original completed note"));
  f.setNow(f.now() + 1);
  const failed = f.ctx("agent-0", { kind: "visit", id: visitId });
  f.save(failed, f.note(id, "Failed later note"));
  f.db
    .prepare("UPDATE home_social_turns SET status='failed' WHERE id=?")
    .run(failed.socialBinding.turnId);
  const fresh = f.ctx("agent-0", { kind: "visit", id: visitId });
  assert.equal(
    readSocialHandoff(f.r, fresh).pendingTopics[0].text,
    "Original completed note",
  );
  f.save(fresh, { pendingTopics: [], agreements: [] });
  const last = f.ctx("agent-0", { kind: "visit", id: visitId });
  const empty = readSocialHandoff(f.r, last);
  assert.deepEqual(empty.pendingTopics, []);
  assert.deepEqual(empty.agreements, []);
});

test("restored references have a strict delivery lease that rejects later source withdrawal", (t) => {
  const f = setup(t),
    visitId = f.visit(),
    writer = f.ctx("agent-0", { kind: "visit", id: visitId });
  const id = f.send(writer, visitId);
  f.save(writer, f.note(id));
  const fresh = f.ctx("agent-0", { kind: "visit", id: visitId });
  readSocialHandoff(f.r, fresh);
  f.db
    .prepare("UPDATE home_social_messages SET hidden_at=? WHERE id=?")
    .run(f.now(), id);
  assert.throws(
    () => [...fresh.socialInputLeases][0](),
    /AUDIENCE_DENIED|SOCIAL_SOURCE_DENIED|RECALL_SOURCE_NOT_ALLOWED/,
  );
});

for (const mode of ["generation", "recovery", "retention"])
  test(`handoff lifecycle removes private prose on ${mode}`, (t) => {
    const f = setup(t),
      visitId = f.visit(),
      writer = f.ctx("agent-0", { kind: "visit", id: visitId });
    const id = f.send(writer, visitId);
    f.save(writer, f.note(id));
    if (mode === "generation")
      f.s.store.invalidateIdentity(writer.socialBinding.actorIdentity);
    if (mode === "recovery")
      f.s.store.invalidateRestoredAuthority({ recoveryEpoch: randomUUID() });
    if (mode === "retention") {
      f.db
        .prepare(
          "UPDATE home_social_visits SET status='ended',ended_at=? WHERE id=?",
        )
        .run(f.now() - 10000, visitId);
      f.s.store.pruneBodies({ before: f.now() - 1000 });
    }
    assert.equal(
      f.db.prepare("SELECT count(*) n FROM home_social_handoffs").get().n,
      0,
    );
  });

test("normal restart preserves completed notes but stale pair generations and internal SQL errors never silently pass", (t) => {
  const f = setup(t),
    visitId = f.visit(),
    writer = f.ctx("agent-0", { kind: "visit", id: visitId });
  const id = f.send(writer, visitId);
  f.save(writer, f.note(id));
  f.db
    .prepare("UPDATE home_social_turns SET status='completed' WHERE id=?")
    .run(writer.socialBinding.turnId);
  f.s.store.interruptRuntime(randomUUID());
  const fresh = f.ctx("agent-0", { kind: "visit", id: visitId });
  assert.equal(readSocialHandoff(f.r, fresh).pendingTopics.length, 1);
  f.db
    .prepare("UPDATE home_social_handoffs SET guest_generation=?")
    .run(randomUUID());
  assert.equal(readSocialHandoff(f.r, fresh), null);
  f.db.exec("DROP TABLE home_social_handoffs");
  assert.throws(() => readSocialHandoff(f.r, fresh), /no such table/);
  migrateHomeSocial(f.db);
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM home_social_handoffs").get().n,
    0,
  );
});

for (const delivered of [false, true])
  test(`handoff input withdrawal uses the actual window delivery boundary: delivered=${delivered}`, (t) => {
    const f = setup(t),
      visitId = f.visit(),
      writer = f.ctx("agent-0", { kind: "visit", id: visitId });
    const id = f.send(writer, visitId);
    f.save(writer, f.note(id));
    const fresh = f.windowContext("agent-0", visitId);
    assert.equal(readSocialHandoff(f.r, fresh).references[0].messageId, id);
    if (delivered) captureSocialWindowHistory(f.r, fresh);
    f.db
      .prepare(
        "UPDATE home_social_messages SET hidden_at=?,revision=revision+1 WHERE id=?",
      )
      .run(f.now(), id);
    const lease = [...fresh.socialInputLeases][0];
    assert.equal(socialInputLeaseAllowed(f.r, fresh, lease), delivered);
    if (delivered)
      assert.doesNotThrow(() =>
        f.s.share(
          fresh,
          fresh.socialBinding.target,
          "Synthetic ordinary continuing reply",
        ),
      );
    else
      assert.throws(
        () => captureSocialWindowHistory(f.r, fresh),
        /SOCIAL_SOURCE_DENIED|AUDIENCE_DENIED|RECALL_SOURCE_NOT_ALLOWED/,
      );
  });

test("an unsealed completed turn is not recovery evidence", (t) => {
  const f = setup(t),
    visitId = f.visit(),
    writer = f.ctx("agent-0", { kind: "visit", id: visitId });
  const id = f.send(writer, visitId);
  f.save(writer, f.note(id));
  f.db
    .prepare("UPDATE home_social_turns SET batch_sealed=0 WHERE id=?")
    .run(writer.socialBinding.turnId);
  const fresh = f.ctx("agent-0", { kind: "visit", id: visitId });
  assert.equal(readSocialHandoff(f.r, fresh), null);
});

test("restored reference excerpts stay within the shared limit and their bound read cursor returns the full source", (t) => {
  const f = setup(t),
    visitId = f.visit(),
    ids = [];
  let writer;
  for (let n = 0; n < 12; n++) {
    if (n % 3 === 0) writer = f.ctx("agent-0", { kind: "visit", id: visitId });
    ids.push(
      f.send(writer, visitId, `Synthetic source ${n}: ` + "合".repeat(1800)),
    );
  }
  f.save(writer, {
    pendingTopics: [
      {
        text: "Synthetic unfinished first section",
        sourceMessageIds: ids.slice(0, 6),
      },
      {
        text: "Synthetic unfinished second section",
        sourceMessageIds: ids.slice(6),
      },
    ],
    agreements: [],
  });
  const fresh = f.ctx("agent-0", { kind: "visit", id: visitId });
  const restored = readSocialHandoff(f.r, fresh);
  assert.equal(restored.references.length, 12);
  assert.equal(
    restored.references.reduce((total, ref) => total + [...ref.body].length, 0),
    12000,
  );
  assert.ok(
    restored.references.every(
      (ref) => ref.bodyTruncated && [...ref.body].length === 1000,
    ),
  );
  assert.equal(fresh.socialDisplayed, undefined);
  const reference = restored.references[0];
  assert.equal(reference.read.tool, "home_visit_read");
  const full = f.s.visitRead(fresh, reference.read.args);
  assert.equal(full.messages[0].messageId, reference.messageId);
  assert.ok(full.messages[0].body.length > reference.body.length);
  assert.equal(
    full.messages[0].body,
    "Synthetic source 0: " + "合".repeat(1800),
  );
});
