import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture, config } from "./helpers.mjs";
import { validateConfig } from "../src/core/config.mjs";
import { HOME_SOCIAL_DEFAULTS } from "../src/home/social-policy.mjs";

function setup(t) {
  const cfg = config();
  cfg.homeSocial = { ...HOME_SOCIAL_DEFAULTS, enabled: true };
  for (const a of cfg.agents) {
    a.home = {
      ...a.home,
      enabled: true,
      publishing: true,
      social: { enabled: true },
    };
    a.subject.enabled = true;
  }
  const f = fixture(t, { cfg }),
    s = f.runtime.home.social;
  f.runtime.homeSocial = s;
  let now = 1800000000000;
  f.runtime.now = () => now;
  s.sources = {
    assertSend: (_r, c) => {
      if (c.restricted) {
        c.socialSendingClosed = true;
        throw Error("SOCIAL_SOURCE_DENIED");
      }
    },
    trackSource: (c, { protectedSocialSources }) => {
      for (const id of protectedSocialSources) c.privateRead.add(id);
    },
    sources: (_r, c) =>
      [...c.privateRead].filter((id) => id.startsWith("social")),
    assertRoomItem: () => {},
  };
  function ctx(agentId, target) {
    const identity = s.identity(agentId),
      base = s.targetBinding(identity, target);
    s.db
      .prepare(
        "UPDATE home_social_turns SET status='finished' WHERE actor_generation=? AND status='running'",
      )
      .run(identity.generation);
    const c = f.runtime.makeContext(agentId, "@subject"),
      turnId = randomUUID();
    c.runtimeKind = "subject-social";
    c.socialBinding = {
      ...base,
      runId: randomUUID(),
      turnId,
      epoch: 0,
      fence: 0,
      runMode: "async",
      windowId: null,
    };
    s.db
      .prepare(
        "INSERT INTO home_social_turns(id,visit_id,target_kind,target_id,target_host_generation,target_guest_generation,actor_generation,mode,status,epoch,fence,policy_revision,config_revision,created_at) VALUES(?,?,?,?,?,?,?,'async','running',0,0,?,?,?)",
      )
      .run(
        turnId,
        base.target.kind === "visit" ? base.target.id : null,
        base.target.kind,
        base.target.id,
        base.targetHostGeneration,
        base.targetGuestGeneration,
        identity.generation,
        base.policyRevision,
        base.configRevision,
        now,
      );
    return c;
  }
  function invite(requestId = "invite-0001", options = {}) {
    const c = ctx("agent-0", { kind: "compose", id: "agent-1" });
    return s.invite(c, {
      requestId,
      targetAgentId: "agent-1",
      roomOwnerAgentId: "agent-0",
      purpose: "合成邀请",
      ...options,
    });
  }
  function accept(invitationId) {
    const c = ctx("agent-1", { kind: "invitation", id: invitationId });
    s.invitationRead(c, { invitationId });
    return s.decide(c, {
      requestId: randomUUID(),
      invitationId,
      expectedInvitationRevision: 1,
      decision: "accept",
    });
  }
  function visit() {
    return accept(invite().result.invitationId).result.visitId;
  }
  return {
    ...f,
    s,
    ctx,
    invite,
    accept,
    visit,
    setNow: (v) => {
      now = v;
    },
    now: () => now,
  };
}

test("strict config defaults disable old roles and reject missing or invalid resource budgets", () => {
  const cfg = config();
  assert.equal(cfg.homeSocial.enabled, false);
  assert.equal(cfg.homeSocial.resourceBudget, null);
  assert.equal(cfg.agents[0].home.social.enabled, false);
  assert.throws(() =>
    validateConfig({
      ...cfg,
      homeSocial: { ...cfg.homeSocial, enabled: true, exchangeEnabled: true },
    }),
  );
  assert.throws(() =>
    validateConfig({
      ...cfg,
      homeSocial: { ...cfg.homeSocial, durationMinutes: 1.5 },
    }),
  );
  assert.throws(() =>
    validateConfig({
      ...cfg,
      homeSocial: { ...cfg.homeSocial, unknown: true },
    }),
  );
});

test("invitation acceptance creates exactly one visit and preserves accepted scope", (t) => {
  const f = setup(t),
    inv = f.invite(),
    id = inv.result.invitationId;
  const c = f.ctx("agent-1", { kind: "invitation", id }),
    before = f.s.db
      .prepare("SELECT count(*) n FROM home_social_events")
      .get().n;
  const view = f.s.invitationRead(c, { invitationId: id });
  assert.equal(view.purpose, "合成邀请");
  assert.equal(
    f.s.db.prepare("SELECT count(*) n FROM home_social_events").get().n,
    before,
  );
  const args = {
    requestId: "accept-0001",
    invitationId: id,
    expectedInvitationRevision: 1,
    decision: "accept",
  };
  const result = f.s.decide(c, args),
    replay = f.s.decide(c, args);
  assert.equal(result.result.state, "active");
  assert.equal(replay.operationId, result.operationId);
  assert.deepEqual(result.result.effectiveScope, ["layout"]);
  assert.equal(
    f.s.db.prepare("SELECT count(*) n FROM home_social_visits").get().n,
    1,
  );
  assert.equal(
    f.s.db.prepare("SELECT count(*) n FROM home_social_grants").get().n,
    1,
  );
  assert.equal(
    f.s.db.prepare("SELECT count(*) n FROM home_social_messages").get().n,
    0,
  );
});

test("only bound registered social actors can read and decide; no pending room grant", (t) => {
  const f = setup(t),
    id = f.invite().result.invitationId,
    c = f.ctx("agent-1", { kind: "invitation", id });
  assert.throws(
    () => f.s.invitationRead({ ...c }, { invitationId: id }),
    /IDENTITY_DENIED/,
  );
  const ordinary = f.runtime.makeContext("agent-1", "@subject");
  assert.throws(
    () =>
      f.s.decide(ordinary, {
        requestId: "accept-0001",
        invitationId: id,
        expectedInvitationRevision: 1,
        decision: "accept",
      }),
    /IDENTITY_DENIED/,
  );
  assert.throws(
    () => f.s.roomRead(c, { visitId: randomUUID() }),
    /AUDIENCE_DENIED/,
  );
  const third = f.ctx("agent-2", { kind: "compose", id: "agent-0" });
  assert.throws(
    () => f.s.invitationRead(third, { invitationId: id }),
    /AUDIENCE_DENIED/,
  );
  assert.throws(
    () => f.s.adminRead("other", { kind: "invitation", id }),
    /IDENTITY_DENIED/,
  );
});

test("cancel, defer, decline cooldown and equal-time expiry have honest effects", (t) => {
  const f = setup(t),
    id = f.invite().result.invitationId,
    c = f.ctx("agent-1", { kind: "invitation", id });
  const expires = f.s.assertInvitation(f.s.identity("agent-1"), id).expires_at;
  f.s.decide(c, {
    requestId: "defer-0001",
    invitationId: id,
    expectedInvitationRevision: 1,
    decision: "defer",
  });
  assert.equal(
    f.s.assertInvitation(f.s.identity("agent-1"), id).expires_at,
    expires,
  );
  f.s.decide(c, {
    requestId: "decline-0001",
    invitationId: id,
    expectedInvitationRevision: 1,
    decision: "decline",
  });
  assert.throws(() => f.invite("invite-0002"), /RATE_LIMITED/);
  const g = setup(t),
    id2 = g.invite().result.invitationId,
    d = g.ctx("agent-1", { kind: "invitation", id: id2 });
  g.setNow(g.s.assertInvitation(g.s.identity("agent-1"), id2).expires_at);
  assert.throws(() =>
    g.s.decide(d, {
      requestId: "accept-0002",
      invitationId: id2,
      expectedInvitationRevision: 1,
      decision: "accept",
    }),
  );
  assert.equal(
    g.s.db.prepare("SELECT count(*) n FROM home_social_visits").get().n,
    0,
  );
});

test("per-message receipts distinguish committed, not_sent and unknown without fake read", (t) => {
  const f = setup(t),
    visitId = f.visit(),
    a = f.ctx("agent-0", { kind: "visit", id: visitId });
  const first = f.s.send(a, {
    requestId: "message-0001",
    visitId,
    expectedVisitRevision: 1,
    body: "第一条合成消息",
  });
  assert.equal(first.status, "committed");
  a.restricted = true;
  const refused = f.s.send(a, {
    requestId: "message-0002",
    visitId,
    expectedVisitRevision: 2,
    body: "拒绝的合成草稿",
  });
  assert.equal(refused.status, "not_sent");
  assert.match(refused.notice, /尚未提交/);
  assert.equal(
    f.s.operationRead(a, { requestId: "message-0002" }).status,
    "not_sent",
  );
  assert.equal(
    f.s.operationRead(a, { requestId: "missing-0001" }).status,
    "unknown",
  );
  assert.equal(
    f.s.db.prepare("SELECT count(*) n FROM home_social_messages").get().n,
    1,
  );
  assert.equal(
    f.s.db.prepare("SELECT count(*) n FROM home_social_read_cursors").get().n,
    0,
  );
  const b = f.ctx("agent-1", { kind: "visit", id: visitId }),
    view = f.s.visitRead(b, { visitId });
  assert.equal(view.messages[0].body, "第一条合成消息");
  assert.equal(
    f.s.db.prepare("SELECT count(*) n FROM home_social_read_cursors").get().n,
    0,
  );
  f.s.markRead(b, {
    requestId: "markread-0001",
    visitId,
    lastDisplayedSequence: 1,
    expectedVisitRevision: 2,
  });
  assert.equal(
    f.s.db
      .prepare("SELECT last_read_sequence FROM home_social_read_cursors")
      .get().last_read_sequence,
    1,
  );
  const ledger = f.s.db
    .prepare("SELECT group_concat(result) value FROM home_social_operations")
    .get().value;
  assert.equal(ledger.includes("拒绝的合成草稿"), false);
});

test("end converges with stale revisions, blocks later sends and permits author tombstones", (t) => {
  const f = setup(t),
    visitId = f.visit(),
    a = f.ctx("agent-0", { kind: "visit", id: visitId });
  const sent = f.s.send(a, {
    requestId: "message-0001",
    visitId,
    expectedVisitRevision: 1,
    body: "合成历史",
  });
  const end = f.s.end(a, {
    requestId: "ending-0001",
    visitId,
    expectedVisitRevision: 2,
  });
  assert.equal(end.result.changed, true);
  const b = f.ctx("agent-1", { kind: "visit", id: visitId });
  assert.equal(
    f.s.end(b, { requestId: "ending-0002", visitId, expectedVisitRevision: 1 })
      .result.changed,
    false,
  );
  const c = f.ctx("agent-0", { kind: "visit", id: visitId });
  assert.equal(
    f.s.send(c, {
      requestId: "message-0002",
      visitId,
      expectedVisitRevision: 3,
      body: "未发",
    }).status,
    "not_sent",
  );
  f.s.retract(c, {
    requestId: "retract-0001",
    messageId: sent.result.messageId,
    expectedMessageRevision: 1,
  });
  assert.equal(
    f.s.db.prepare("SELECT body FROM home_social_messages").get().body,
    "",
  );
  assert.equal(
    f.s.db
      .prepare("SELECT count(*) n FROM home_social_events WHERE type='ended'")
      .get().n,
    1,
  );
});

test("grant reduce invalidates cursors and cannot expand or extend", (t) => {
  const f = setup(t),
    visitId = f.visit(),
    a = f.ctx("agent-0", { kind: "visit", id: visitId });
  const room = f.s.roomRead(a, { visitId });
  assert.equal(room.items.length, 0);
  assert.ok(room.layout);
  const grant = f.s.db.prepare("SELECT * FROM home_social_grants").get();
  assert.throws(
    () =>
      f.s.grantReduce(a, {
        requestId: "reduce-0001",
        visitId,
        expectedGrantRevision: 1,
        scope: ["layout"],
        expiresAt: grant.expires_at + 1,
      }),
    /AUDIENCE_DENIED/,
  );
  f.s.grantReduce(a, {
    requestId: "reduce-0002",
    visitId,
    expectedGrantRevision: 1,
    scope: [],
    expiresAt: grant.expires_at,
  });
  assert.throws(() => f.s.roomRead(a, { visitId }), /AUDIENCE_DENIED/);
  assert.equal(
    f.s.assertVisit(f.s.identity("agent-0"), visitId).status,
    "active",
  );
});

test("administrator reads audit every outcome and audit failure prevents returned bodies", (t) => {
  const f = setup(t),
    id = f.invite().result.invitationId,
    p = "instance-administrator";
  const body = f.s.adminRead(p, { kind: "invitation", id });
  assert.equal(body.purpose, "合成邀请");
  assert.ok(body.auditId);
  assert.throws(() =>
    f.s.adminRead(p, { kind: "invitation", id, actingAgentId: "agent-0" }),
  );
  assert.equal(
    f.s.db
      .prepare("SELECT count(*) n FROM home_social_admin_access_audit")
      .get().n,
    2,
  );
  assert.equal(
    f.s.db.prepare("SELECT count(*) n FROM home_social_read_cursors").get().n,
    0,
  );
  f.s.db.exec(
    "CREATE TRIGGER audit_fail BEFORE INSERT ON home_social_admin_access_audit BEGIN SELECT RAISE(ABORT,'audit test failure'); END",
  );
  assert.throws(
    () => f.s.adminRead(p, { kind: "invitation", id }),
    /audit test failure/,
  );
});

test("same-ID identity recreation does not inherit visits, grants or prior operation results", async (t) => {
  const f = setup(t),
    visitId = f.visit(),
    old = f.s.identity("agent-1");
  const cfg = structuredClone(f.runtime.config);
  cfg.agents = cfg.agents.filter((a) => a.id !== "agent-1");
  await f.runtime.changeConfig(cfg, f.configStore.revision);
  assert.equal(
    f.s.db
      .prepare("SELECT status FROM home_social_visits WHERE id=?")
      .get(visitId).status,
    "invalidated",
  );
  const next = structuredClone(f.runtime.config),
    original = config().agents[1];
  original.home = {
    ...original.home,
    enabled: true,
    publishing: true,
    social: { enabled: true },
  };
  original.subject.enabled = true;
  next.agents.push(original);
  await f.runtime.changeConfig(next, f.configStore.revision);
  assert.notEqual(f.s.identity("agent-1").generation, old.generation);
  assert.throws(
    () => f.s.assertVisit(f.s.identity("agent-1"), visitId),
    /AUDIENCE_DENIED/,
  );
});

test("budget changes preserve authority and never extend accepted window terms; permission changes fence", async (t) => {
  const f = setup(t),
    visitId = f.visit(),
    ctx = f.ctx("agent-0", { kind: "visit", id: visitId }),
    policy = f.s.policy().revision,
    deadline = f.now() + 600000;
  f.s.db
    .prepare(
      "INSERT INTO home_social_windows(id,visit_id,proposer_generation,status,terms_revision,terms,effective_limits,policy_revision,created_at,expires_at,started_at,deadline) VALUES(?,?,?,'active','terms-a','{}',?,?,?, ?,?,?)",
    )
    .run(
      randomUUID(),
      visitId,
      f.s.identity("agent-0").generation,
      JSON.stringify({
        durationMinutes: 10,
        maxTurns: 12,
        maxMessagesPerTurn: 3,
        resourceBudget: null,
      }),
      policy,
      f.now(),
      deadline,
      f.now(),
      deadline,
    );
  let next = structuredClone(f.runtime.config);
  next.homeSocial.durationMinutes = 20;
  next.homeSocial.maxTurns = 24;
  await f.runtime.changeConfig(next, f.configStore.revision);
  assert.equal(f.s.policy().revision, policy);
  assert.equal(f.s.assertBinding(ctx).agentId, "agent-0");
  let window = f.s.db.prepare("SELECT * FROM home_social_windows").get();
  assert.equal(window.deadline, deadline);
  assert.equal(JSON.parse(window.effective_limits).maxTurns, 12);
  next = structuredClone(f.runtime.config);
  next.homeSocial.durationMinutes = 5;
  next.homeSocial.maxTurns = 6;
  await f.runtime.changeConfig(next, f.configStore.revision);
  window = f.s.db.prepare("SELECT * FROM home_social_windows").get();
  assert.equal(window.deadline, f.now() + 300000);
  assert.equal(JSON.parse(window.effective_limits).maxTurns, 6);
  assert.equal(f.s.policy().revision, policy);
  next = structuredClone(f.runtime.config);
  next.agents[0].home.publishing = false;
  await f.runtime.changeConfig(next, f.configStore.revision);
  assert.ok(f.s.policy().revision > policy);
  assert.throws(() => f.s.assertBinding(ctx));
  assert.equal(
    f.s.db.prepare("SELECT status FROM home_social_windows").get().status,
    "closed",
  );
});

test("blocking cancels both directions without preventing later voluntary unblock", (t) => {
  const f = setup(t),
    visitId = f.visit(),
    c = f.ctx("agent-0", { kind: "compose", id: "agent-1" });
  f.s.block(c, {
    requestId: "block-0001",
    targetAgentId: "agent-1",
    blocked: true,
    expectedPolicyRevision: f.s.policy().revision,
  });
  assert.equal(
    f.s.db
      .prepare("SELECT status FROM home_social_visits WHERE id=?")
      .get(visitId).status,
    "invalidated",
  );
  assert.throws(() => f.invite("invite-0002"), /AUDIENCE_DENIED/);
  const d = f.ctx("agent-0", { kind: "compose", id: "agent-1" });
  f.s.block(d, {
    requestId: "unblock-0001",
    targetAgentId: "agent-1",
    blocked: false,
    expectedPolicyRevision: f.s.policy().revision,
  });
  assert.equal(
    f.s.db
      .prepare("SELECT status FROM home_social_visits WHERE id=?")
      .get(visitId).status,
    "invalidated",
  );
  assert.equal(f.invite("invite-0003").result.state, "pending");
});

test("before-input leases reject a reduced room grant and a withdrawn message", (t) => {
  const f = setup(t),
    visitId = f.visit(),
    owner = f.ctx("agent-0", { kind: "visit", id: visitId });
  const sent = f.s.send(owner, {
    requestId: "message-0001",
    visitId,
    expectedVisitRevision: 1,
    body: "合成租约测试",
  });
  const reader = f.ctx("agent-1", { kind: "visit", id: visitId });
  f.s.visitRead(reader, { visitId });
  f.s.roomRead(reader, { visitId });
  for (const guard of reader.socialInputLeases) assert.equal(guard(), true);
  f.s.retract(owner, {
    requestId: "retract-0001",
    messageId: sent.result.messageId,
    expectedMessageRevision: 1,
  });
  assert.throws(() => {
    for (const guard of reader.socialInputLeases) guard();
  }, /AUDIENCE_DENIED/);
  const fresh = f.ctx("agent-1", { kind: "visit", id: visitId });
  f.s.roomRead(fresh, { visitId });
  const grant = f.s.db.prepare("SELECT * FROM home_social_grants").get();
  f.s.grantReduce(owner, {
    requestId: "reduce-0001",
    visitId,
    expectedGrantRevision: grant.revision,
    scope: [],
    expiresAt: grant.expires_at,
  });
  assert.throws(() => {
    for (const guard of fresh.socialInputLeases) guard();
  }, /AUDIENCE_DENIED/);
});
