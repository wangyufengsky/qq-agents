import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture, config } from "./helpers.mjs";
import { validateConfig } from "../src/core/config.mjs";
import { HOME_SOCIAL_DEFAULTS } from "../src/home/social-policy.mjs";
import { HomeSocialService } from "../src/home/social-service.mjs";
import {
  createSocialWindowHistory,
  captureSocialWindowHistory,
  socialWindowHistoryAllowed,
  socialContextAllowed,
  socialSources,
  socialInputLeaseAllowed,
  assertNoSocialDisclosure,
} from "../src/core/social-protection.mjs";

function setup(t, n = 3) {
  const cfg = config(n);
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
  const realSources = s.sources;
  s.sources = {
    allowed: () => true,
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
    c.privateRead = new Set();
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
    realSources,
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

test("strict config defaults disable old roles and allow turn-only exchange with valid limits", () => {
  const cfg = config();
  assert.equal(cfg.homeSocial.enabled, false);
  assert.equal(cfg.homeSocial.resourceBudget, null);
  assert.equal(cfg.agents[0].home.social.enabled, false);
  const enabled = validateConfig({
    ...cfg,
    homeSocial: { ...cfg.homeSocial, enabled: true, exchangeEnabled: true },
  });
  assert.equal(enabled.homeSocial.resourceBudget, null);
  assert.equal(enabled.homeSocial.maxTurns, 12);
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

test("real source gates preserve invitation/message audiences and close sends after restricted recall", (t) => {
  const f = setup(t);
  f.s.sources = f.realSources;
  const visitId = f.visit(),
    a = f.ctx("agent-0", { kind: "visit", id: visitId });
  const sent = f.s.send(a, {
    requestId: "message-0001",
    visitId,
    expectedVisitRevision: 1,
    body: "合成私密交流",
  });
  assert.equal(sent.status, "committed");
  const b = f.ctx("agent-1", { kind: "visit", id: visitId }),
    view = f.s.visitRead(b, { visitId });
  assert.equal(view.messages[0].body, "合成私密交流");
  assert.ok(
    [...b.privateRead].includes(`social:${visitId}:${sent.result.messageId}`),
  );
  const reply = f.s.send(b, {
    requestId: "message-0002",
    visitId,
    expectedVisitRevision: 2,
    body: "同一拜访的合成回复",
  });
  assert.equal(reply.status, "committed");
  const row = f.s.db
    .prepare("SELECT source_labels FROM home_social_messages WHERE id=?")
    .get(reply.result.messageId);
  assert.ok(
    JSON.parse(row.source_labels).includes(
      `social:${visitId}:${sent.result.messageId}`,
    ),
  );
  b.privateRead.add("operations:synthetic-proof");
  const denied = f.s.send(b, {
    requestId: "message-0003",
    visitId,
    expectedVisitRevision: 3,
    body: "不应离开的草稿",
  });
  assert.equal(denied.status, "not_sent");
  assert.equal(b.socialSendingClosed, true);
  assert.equal(
    f.s.db.prepare("SELECT count(*) n FROM home_social_messages").get().n,
    2,
  );
});

test("new attested originals can be shared by exact item version, legacy unknown originals cannot", async (t) => {
  const f = setup(t);
  f.s.sources = f.realSources;
  const owner = f.runtime.makeContext("agent-0", "@subject"),
    room = await f.runtime.executeTool(owner, "room_read", {});
  await f.runtime.executeTool(owner, "room_publish", {
    requestId: "publish-0001",
    identityGeneration: room.identityGeneration,
    slot: "intro",
    expectedItemRevision: 0,
    title: "合成原作",
    body: "房主明确提供的合成正文",
    source: "original-text",
  });
  const item = f.runtime.home.rooms.store.item(
      room.identityGeneration,
      "intro",
    ),
    selection = {
      slot: "intro",
      itemId: item.item_id,
      itemRevision: item.revision,
    };
  const invitation = f.invite("invite-0001", {
    scope: ["layout", "intro"],
    selectedItems: [selection],
  });
  const visitId = f.accept(invitation.result.invitationId).result.visitId;
  const guest = f.ctx("agent-1", { kind: "visit", id: visitId }),
    view = f.s.roomRead(guest, { visitId });
  assert.equal(view.items[0].body, "房主明确提供的合成正文");
  f.s.db
    .prepare(
      "DELETE FROM home_social_item_proofs WHERE generation=? AND slot='intro'",
    )
    .run(room.identityGeneration);
  assert.throws(() => {
    for (const guard of guest.socialInputLeases) guard();
  }, /SOCIAL_SOURCE_DENIED/);
  assert.throws(() => f.s.roomRead(guest, { visitId }), /SOCIAL_SOURCE_DENIED/);
});

test("lock-time expiry gives exact not_sent and end convergence without quota mutation", (t) => {
  const f = setup(t),
    visitId = f.visit(),
    a = f.ctx("agent-0", { kind: "visit", id: visitId }),
    expires = f.s.assertVisit(f.s.identity("agent-0"), visitId).expires_at;
  f.runtime.now = () => (f.s.db.isTransaction ? expires : expires - 1);
  const result = f.s.send(a, {
    requestId: "message-0001",
    visitId,
    expectedVisitRevision: 1,
    body: "锁等待到期后不提交",
  });
  assert.equal(result.status, "not_sent");
  assert.equal(result.result.safeError, "VISIT_CLOSED");
  assert.equal(
    f.s.db.prepare("SELECT count(*) n FROM home_social_messages").get().n,
    0,
  );
  assert.equal(
    f.s.usage(f.s.identity("agent-0").generation, visitId, "message", expires),
    0,
  );
  const ended = f.s.end(a, {
    requestId: "ending-0001",
    visitId,
    expectedVisitRevision: 0,
  });
  assert.equal(ended.result.alreadyClosed, true);
  assert.equal(ended.result.state, "expired");
  assert.equal(
    f.s.db.prepare("SELECT ended_at FROM home_social_visits").get().ended_at,
    expires,
  );
});

test("expired invitations cool down from their original deadline, not each retry", (t) => {
  const f = setup(t),
    id = f.invite().result.invitationId,
    expires = f.s.assertInvitation(f.s.identity("agent-0"), id).expires_at;
  f.setNow(expires + 24 * 3600000);
  assert.equal(f.invite("invite-0002").result.state, "pending");
  assert.equal(
    f.s.db
      .prepare("SELECT decided_at FROM home_social_invitations WHERE id=?")
      .get(id).decided_at,
    expires,
  );
});

test("maintenance and delayed reads apply retention without reviving expired bodies", (t) => {
  const f = setup(t),
    visitId = f.visit(),
    a = f.ctx("agent-0", { kind: "visit", id: visitId });
  f.s.send(a, {
    requestId: "message-0001",
    visitId,
    expectedVisitRevision: 1,
    body: "到期应清理的合成正文",
  });
  const expires = f.s.db
    .prepare("SELECT expires_at FROM home_social_visits")
    .get().expires_at;
  f.setNow(expires + 31 * 86400000);
  const before = f.s.adminRead("instance-administrator", {
    kind: "visit",
    id: visitId,
  });
  assert.equal("body" in before.messages[0], false);
  const first = f.s.maintain(),
    events = f.s.db
      .prepare("SELECT count(*) n FROM home_social_events")
      .get().n;
  assert.equal(first.visits, 1);
  assert.equal(
    f.s.db.prepare("SELECT ended_at FROM home_social_visits").get().ended_at,
    expires,
  );
  assert.equal(
    f.s.db.prepare("SELECT body FROM home_social_messages").get().body,
    "",
  );
  f.s.maintain();
  assert.equal(
    f.s.db.prepare("SELECT count(*) n FROM home_social_events").get().n,
    events,
  );
});

test("recovery stays disabled across restart and deliberate re-enable never revives old passes", async (t) => {
  const f = setup(t),
    visitId = f.visit();
  f.s.store.invalidateRestoredAuthority({ recoveryEpoch: randomUUID() });
  f.runtime.home.syncAgents();
  assert.equal(f.s.policy().enabled, 0);
  let next = structuredClone(f.runtime.config);
  next.homeSocial.enabled = false;
  await f.runtime.changeConfig(next, f.configStore.revision);
  next = structuredClone(f.runtime.config);
  next.homeSocial.enabled = true;
  await f.runtime.changeConfig(next, f.configStore.revision);
  assert.equal(f.s.policy().enabled, 1);
  assert.throws(
    () => f.ctx("agent-0", { kind: "visit", id: visitId }),
    /AUDIENCE_DENIED/,
  );
  assert.equal(
    f.s.db
      .prepare("SELECT status FROM home_social_visits WHERE id=?")
      .get(visitId).status,
    "invalidated",
  );
});

test("administrator overview paginates metadata only and moderation never impersonates a role", (t) => {
  const f = setup(t),
    visitId = f.visit(),
    a = f.ctx("agent-0", { kind: "visit", id: visitId }),
    sent = f.s.send(a, {
      requestId: "message-0001",
      visitId,
      expectedVisitRevision: 1,
      body: "管理读取前不可见正文",
    }),
    p = "instance-administrator";
  const first = f.s.adminOverview(p, { limit: 1 });
  assert.equal(first.items.length, 1);
  assert.ok(first.nextCursor);
  assert.equal(JSON.stringify(first).includes("合成邀请"), false);
  assert.equal(JSON.stringify(first).includes("管理读取前不可见正文"), false);
  const second = f.s.adminOverview(p, { limit: 1, cursor: first.nextCursor });
  assert.equal(second.items.length, 1);
  assert.notEqual(first.items[0].kind, second.items[0].kind);
  const args = {
    requestId: "moderate-0001",
    action: "hide-message",
    targetId: sent.result.messageId,
    expectedRevision: 1,
    policyRevision: f.s.policy().revision,
  };
  const result = f.s.moderate(p, args);
  assert.equal(result.result.changed, true);
  assert.equal(f.s.moderate(p, args).historicalReplay, true);
  const audit = f.s.db
    .prepare(
      "SELECT * FROM home_social_admin_access_audit WHERE action='hide-message'",
    )
    .all();
  assert.equal(audit.length, 2);
  assert.ok(audit.every((row) => row.principal === p));
  assert.throws(() => f.s.moderate(p, { ...args, body: "管理员不能代说话" }));
});

test("operation lookup checks original entity ACL and cannot cross a bound visit", (t) => {
  const f = setup(t),
    visitA = f.visit(),
    actor = f.ctx("agent-0", { kind: "visit", id: visitA });
  f.s.send(actor, {
    requestId: "message-original",
    visitId: visitA,
    expectedVisitRevision: 1,
    body: "拜访A合成消息",
  });
  f.s.store.execute({
    actorIdentity: f.s.identity("agent-0"),
    requestId: "process-original",
    kind: "social-process",
    payload: { target: { kind: "visit", id: visitA } },
    apply: () => ({ turnId: actor.socialBinding.turnId, queued: true }),
  });
  assert.equal(
    f.s.operationRead(actor, { requestId: "process-original" }).result.turnId,
    actor.socialBinding.turnId,
  );
  const compose = f.ctx("agent-0", { kind: "compose", id: "agent-2" }),
    inv = f.s.invite(compose, {
      requestId: "invite-third",
      targetAgentId: "agent-2",
      roomOwnerAgentId: "agent-0",
      purpose: "另一个合成拜访",
    }),
    recipient = f.ctx("agent-2", {
      kind: "invitation",
      id: inv.result.invitationId,
    });
  const accepted = f.s.decide(recipient, {
      requestId: "accept-third",
      invitationId: inv.result.invitationId,
      expectedInvitationRevision: 1,
      decision: "accept",
    }),
    visitB = accepted.result.visitId;
  let other = f.ctx("agent-0", { kind: "visit", id: visitB });
  assert.throws(
    () => f.s.operationRead(other, { requestId: "message-original" }),
    /AUDIENCE_DENIED/,
  );
  assert.throws(
    () => f.s.operationRead(other, { requestId: "process-original" }),
    /AUDIENCE_DENIED/,
  );
  assert.equal(
    f.s.operationRead(other, { requestId: "unknown-original" }).status,
    "unknown",
  );
  const own = f.ctx("agent-0", { kind: "visit", id: visitA });
  assert.equal(
    f.s.operationRead(own, { requestId: "message-original" }).status,
    "committed",
  );
  const block = f.ctx("agent-0", { kind: "compose", id: "agent-1" });
  f.s.block(block, {
    requestId: "block-original",
    targetAgentId: "agent-1",
    blocked: true,
    expectedPolicyRevision: f.s.policy().revision,
  });
  other = f.ctx("agent-0", { kind: "visit", id: visitB });
  assert.throws(
    () => f.s.operationRead(other, { requestId: "message-original" }),
    /AUDIENCE_DENIED/,
  );
  assert.equal(
    f.s.operationRead(other, { requestId: "unknown-original" }).status,
    "unknown",
  );
});

test("inbox pagination does not lose visible invitations after blocked, deleted or disabled candidates", async (t) => {
  for (const mode of ["blocked", "deleted", "disabled"]) {
    const f = setup(t, 8),
      ids = [];
    for (let i = 1; i <= 6; i++) {
      const ctx = f.ctx(`agent-${i}`, { kind: "compose", id: "agent-0" });
      ids.push(
        f.s.invite(ctx, {
          requestId: `inbox-${mode}-${i}`,
          targetAgentId: "agent-0",
          roomOwnerAgentId: "agent-0",
          purpose: `Synthetic inbox purpose ${i}`,
        }).result.invitationId,
      );
    }
    if (mode === "blocked")
      for (const i of [1, 3]) {
        const ctx = f.ctx("agent-0", { kind: "compose", id: `agent-${i}` });
        f.s.block(ctx, {
          requestId: `block-inbox-${i}`,
          targetAgentId: `agent-${i}`,
          blocked: true,
          expectedPolicyRevision: f.s.policy().revision,
        });
      }
    else {
      const next = structuredClone(f.runtime.config);
      if (mode === "deleted")
        next.agents = next.agents.filter(
          (a) => !["agent-1", "agent-3"].includes(a.id),
        );
      else
        for (const a of next.agents)
          if (["agent-1", "agent-3"].includes(a.id))
            a.home.social.enabled = false;
      await f.runtime.changeConfig(next, f.configStore.revision);
    }
    const ctx = f.ctx("agent-0", { kind: "compose", id: "agent-7" }),
      seen = [];
    let cursor;
    for (let pages = 0; pages < 10; pages++) {
      const page = f.s.inbox(ctx, { limit: 1, ...(cursor ? { cursor } : {}) });
      assert.equal(JSON.stringify(page.items).includes(ids[0]), false);
      assert.equal(JSON.stringify(page.items).includes(ids[2]), false);
      assert.equal(
        JSON.stringify(page.items).includes("Synthetic inbox purpose"),
        false,
      );
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    assert.equal(cursor, null);
    assert.deepEqual(seen, [ids[1], ids[3], ids[4], ids[5]]);
    assert.equal(new Set(seen).size, seen.length);
  }
});

test("inbox scans at most 200 denied tombstones and returns a private continuation to a visible tail", (t) => {
  const f = setup(t, 4),
    host = f.s.identity("agent-0"),
    guest = f.s.identity("agent-1");
  // Old terminal metadata can outlive body retention and current invitation quotas.
  f.s.store.transaction((now) => {
    const insert = f.s.db.prepare(
      "INSERT INTO home_social_invitations(id,host_agent_id,host_generation,guest_agent_id,guest_generation,initiator_generation,recipient_generation,room_id,audience,requested_scope,status,policy_revision,created_at,expires_at,decided_at) VALUES(?,?,?,?,?,?,?,?,?,?,'declined',0,?,?,?)",
    );
    for (let i = 0; i < 201; i++)
      insert.run(
        randomUUID(),
        host.agentId,
        host.generation,
        guest.agentId,
        guest.generation,
        guest.generation,
        host.generation,
        "room:" + host.generation,
        JSON.stringify([host.generation, guest.generation]),
        JSON.stringify({ scope: ["layout"], selectedItems: [] }),
        now - 86400000 * 90 + i,
        now - 86400000 * 89 + i,
        now - 86400000 * 90 + i + 1,
      );
  });
  const block = f.ctx("agent-0", { kind: "compose", id: "agent-1" });
  f.s.block(block, {
    requestId: "block-inbox-tombstones",
    targetAgentId: "agent-1",
    blocked: true,
    expectedPolicyRevision: f.s.policy().revision,
  });
  const sender = f.ctx("agent-2", { kind: "compose", id: "agent-0" }),
    expected = f.s.invite(sender, {
      requestId: "inbox-visible-tail",
      targetAgentId: "agent-0",
      roomOwnerAgentId: "agent-0",
      purpose: "Synthetic visible tail",
    }).result.invitationId;
  const ctx = f.ctx("agent-0", { kind: "compose", id: "agent-3" }),
    limits = [],
    prepare = f.s.db.prepare.bind(f.s.db);
  f.s.db.prepare = (sql) => {
    const statement = prepare(sql);
    return sql.includes("FROM home_social_invitations WHERE (host_generation=")
      ? {
          all: (...args) => {
            limits.push(args.at(-1));
            return statement.all(...args);
          },
        }
      : statement;
  };
  try {
    const first = f.s.inbox(ctx, { limit: 1 });
    assert.deepEqual(first.items, []);
    assert.ok(first.nextCursor);
    const next = f.s.inbox(ctx, { limit: 1, cursor: first.nextCursor });
    assert.deepEqual(
      next.items.map((item) => item.id),
      [expected],
    );
    assert.equal(next.nextCursor, null);
    assert.ok(limits.length === 2 && limits.every((limit) => limit <= 201));
    assert.equal(
      Buffer.from(first.nextCursor.slice(4), "base64url")
        .toString("utf8")
        .includes(host.generation),
      false,
    );
  } finally {
    f.s.db.prepare = prepare;
  }
});

test("inbox cursors reject changed readers, tampering, oversized tokens and new service-instance keys", (t) => {
  const f = setup(t, 4);
  for (const i of [1, 2]) {
    const c = f.ctx(`agent-${i}`, { kind: "compose", id: "agent-0" });
    f.s.invite(c, {
      requestId: `cursor-inbox-${i}`,
      targetAgentId: "agent-0",
      roomOwnerAgentId: "agent-0",
      purpose: "Synthetic cursor fixture",
    });
  }
  let owner = f.ctx("agent-0", { kind: "compose", id: "agent-3" });
  const first = f.s.inbox(owner, { limit: 1 }),
    token = first.nextCursor;
  assert.ok(token);
  owner = f.ctx("agent-0", { kind: "compose", id: "agent-3" });
  assert.equal(f.s.inbox(owner, { limit: 1, cursor: token }).items.length, 1);
  const other = f.ctx("agent-2", { kind: "compose", id: "agent-3" });
  assert.throws(
    () => f.s.inbox(other, { limit: 1, cursor: token }),
    /INVALID_CURSOR/,
  );
  for (const bad of [
    "",
    "in1.bad",
    "in1." + "a".repeat(600),
    token.slice(0, -4) + (token.at(-4) === "a" ? "b" : "a") + token.slice(-3),
  ])
    assert.throws(
      () => f.s.inbox(owner, { limit: 1, cursor: bad }),
      /INVALID_CURSOR/,
    );
  const restarted = new HomeSocialService(
    f.runtime,
    f.runtime.home,
    f.s.sources,
  );
  assert.throws(
    () => restarted.inbox(owner, { limit: 1, cursor: token }),
    /INVALID_CURSOR/,
  );
  assert.equal(f.s.inbox(owner, { limit: 1, cursor: token }).items.length, 1);
});

test("model input guards revalidate unchanged invitation, messages and room after page leases expire", (t) => {
  const f = setup(t);
  const invitationId = f.invite().result.invitationId;
  const recipient = f.ctx("agent-1", { kind: "invitation", id: invitationId });
  const invitation = f.s.invitationRead(recipient, { invitationId });
  const ticket = f.s.captureInputConsumption(recipient);
  f.setNow(f.now() + 16000);
  assert.ok(f.now() > invitation.lease.expiresAt);
  for (const guard of recipient.socialInputLeases) assert.equal(guard(), true);
  assert.equal(f.s.confirmInputConsumed(recipient, ticket).confirmed, 1);
  const visitId = f.accept(invitationId).result.visitId;
  const owner = f.ctx("agent-0", { kind: "visit", id: visitId });
  f.s.send(owner, {
    requestId: randomUUID(),
    visitId,
    expectedVisitRevision: 1,
    body: "Synthetic retained input",
  });
  const reader = f.ctx("agent-1", { kind: "visit", id: visitId });
  const messages = f.s.visitRead(reader, { visitId });
  const room = f.s.roomRead(reader, { visitId });
  f.setNow(f.now() + 16000);
  assert.ok(f.now() > messages.lease.expiresAt);
  assert.ok(f.now() > room.lease.expiresAt);
  for (const guard of reader.socialInputLeases) assert.equal(guard(), true);
  // The same captured room input must still fail at the actual grant deadline.
  f.s.db
    .prepare("UPDATE home_social_grants SET expires_at=? WHERE visit_id=?")
    .run(f.now(), visitId);
  assert.throws(() => {
    for (const guard of reader.socialInputLeases) guard();
  });
});

test("model input guards reject actual invitation expiry and message retention cutoff", (t) => {
  const f = setup(t);
  const invitationId = f.invite().result.invitationId;
  const recipient = f.ctx("agent-1", { kind: "invitation", id: invitationId });
  f.s.invitationRead(recipient, { invitationId });
  const ticket = f.s.captureInputConsumption(recipient);
  f.s.db
    .prepare("UPDATE home_social_invitations SET expires_at=? WHERE id=?")
    .run(f.now() + 16000, invitationId);
  f.setNow(f.now() + 16000);
  assert.throws(() => f.s.confirmInputConsumed(recipient, ticket));
  assert.equal(
    f.s.db
      .prepare(
        "SELECT recipient_viewed_at FROM home_social_invitations WHERE id=?",
      )
      .get(invitationId).recipient_viewed_at,
    null,
  );
  const second = setup(t);
  const visitId = second.visit();
  const owner = second.ctx("agent-0", { kind: "visit", id: visitId });
  second.s.send(owner, {
    requestId: randomUUID(),
    visitId,
    expectedVisitRevision: 1,
    body: "Synthetic retained history",
  });
  const reader = second.ctx("agent-1", { kind: "visit", id: visitId });
  second.s.visitRead(reader, { visitId });
  second.s.db
    .prepare(
      "UPDATE home_social_visits SET status='ended',ended_at=? WHERE id=?",
    )
    .run(second.now() - 30 * 86400000, visitId);
  assert.throws(() => {
    for (const guard of reader.socialInputLeases) guard();
  }, /AUDIENCE_DENIED/);
});

function windowFixture(t) {
  const f = setup(t, 2),
    r = f.runtime,
    visitId = f.visit(),
    windowId = randomUUID();
  f.s.sources = f.realSources;
  r.config.homeSocial.exchangeEnabled = true;
  const visit = f.s.db
    .prepare("SELECT * FROM home_social_visits WHERE id=?")
    .get(visitId);
  f.s.db
    .prepare(
      "INSERT INTO home_social_windows(id,visit_id,proposer_generation,status,terms_revision,terms,effective_limits,policy_revision,created_at,expires_at,started_at,deadline) VALUES(?,?,?,'active','fixture','{}',?,?, ?,?,?,?)",
    )
    .run(
      windowId,
      visitId,
      visit.host_generation,
      JSON.stringify(r.config.homeSocial),
      f.s.policy().revision,
      f.now(),
      f.now() + 60000,
      f.now(),
      f.now() + 60000,
    );
  const histories = new Map();
  r.socialRuntime.historyForWindow = (id, generation) =>
    id === windowId ? histories.get(generation) : null;
  function actor(agentId) {
    const ctx = f.ctx(agentId, { kind: "visit", id: visitId });
    Object.assign(ctx.socialBinding, {
      runMode: "window",
      windowId,
      windowFence: 0,
    });
    f.s.db
      .prepare("DELETE FROM home_social_turns WHERE id=?")
      .run(ctx.socialBinding.turnId);
    f.s.db
      .prepare(
        "INSERT INTO home_social_turns(id,visit_id,window_id,target_kind,target_id,target_host_generation,target_guest_generation,actor_generation,mode,status,epoch,fence,policy_revision,config_revision,created_at,started_at) VALUES(?,?,?,'visit',?,?,?,?,'window','running',0,0,?,?,?,?)",
      )
      .run(
        ctx.socialBinding.turnId,
        visitId,
        windowId,
        visitId,
        ctx.socialBinding.targetHostGeneration,
        ctx.socialBinding.targetGuestGeneration,
        ctx.socialBinding.actorIdentity.generation,
        ctx.socialBinding.policyRevision,
        ctx.socialBinding.configRevision,
        f.now(),
        f.now(),
      );
    ctx.socialHistory = createSocialWindowHistory(ctx.socialBinding);
    histories.set(
      ctx.socialBinding.actorIdentity.generation,
      ctx.socialHistory,
    );
    return ctx;
  }
  return { ...f, visitId, windowId, actor, histories };
}

test("same-window history permits ordinary replies after room changes without granting a fresh room read or public disclosure", (t) => {
  const f = windowFixture(t),
    a = f.actor("agent-0"),
    b = f.actor("agent-1");
  f.s.roomRead(a, { visitId: f.visitId });
  captureSocialWindowHistory(f.runtime, a);
  const sources = socialSources(f.runtime, a);
  assert.equal(sources.length, 1);
  f.s.db
    .prepare(
      "UPDATE home_social_grants SET revision=revision+1,scope='[]',selected_item_revisions='[]' WHERE visit_id=?",
    )
    .run(f.visitId);
  assert.equal(socialContextAllowed(f.runtime, a, sources), false);
  assert.equal(socialWindowHistoryAllowed(f.runtime, a, sources), true);
  assert.ok(
    [...a.socialInputLeases].every((guard) =>
      socialInputLeaseAllowed(f.runtime, a, guard),
    ),
  );
  assert.throws(
    () => f.s.roomRead(a, { visitId: f.visitId }),
    /AUDIENCE_DENIED/,
  );
  assert.throws(
    () => assertNoSocialDisclosure(f.runtime, a),
    /SOCIAL_SOURCE_DENIED/,
  );
  const sent = f.s.send(a, {
    requestId: randomUUID(),
    visitId: f.visitId,
    expectedVisitRevision: 1,
    body: "Synthetic continued ordinary conversation",
  });
  assert.equal(sent.status, "committed");
  const view = f.s.visitRead(b, { visitId: f.visitId });
  captureSocialWindowHistory(f.runtime, b);
  assert.equal(
    view.messages[0].body,
    "Synthetic continued ordinary conversation",
  );
  assert.equal(
    socialWindowHistoryAllowed(f.runtime, b, socialSources(f.runtime, b)),
    true,
  );
  assert.equal(
    socialContextAllowed(f.runtime, b, socialSources(f.runtime, b)),
    false,
  );
  assert.deepEqual(
    JSON.parse(
      f.s.db
        .prepare("SELECT source_labels FROM home_social_messages WHERE id=?")
        .get(sent.result.messageId).source_labels,
    ),
    sources,
  );
  f.s.retract(a, {
    requestId: randomUUID(),
    messageId: sent.result.messageId,
    expectedMessageRevision: 1,
  });
  const later = f.s.visitRead(b, { visitId: f.visitId });
  assert.equal(later.messages[0].state, "retracted");
  assert.equal("body" in later.messages[0], false);
  assert.equal(
    socialWindowHistoryAllowed(f.runtime, b, socialSources(f.runtime, b)),
    true,
  );
});

for (const changed of ["window", "fence", "pair", "actor", "private", "closed"])
  test(`window history cannot authorize unrelated or revoked scope: ${changed}`, (t) => {
    const f = windowFixture(t),
      a = f.actor("agent-0");
    f.s.roomRead(a, { visitId: f.visitId });
    captureSocialWindowHistory(f.runtime, a);
    f.s.db
      .prepare(
        "UPDATE home_social_grants SET revision=revision+1,scope='[]' WHERE visit_id=?",
      )
      .run(f.visitId);
    if (changed === "window") a.socialHistory.windowId = randomUUID();
    if (changed === "fence") a.socialHistory.fence++;
    if (changed === "pair") a.socialHistory.guestGeneration = randomUUID();
    if (changed === "actor") a.socialHistory.actorGeneration = randomUUID();
    if (changed === "closed")
      f.s.db
        .prepare(
          "UPDATE home_social_windows SET status='closed',fence=fence+1 WHERE id=?",
        )
        .run(f.windowId);
    if (changed === "private") a.privateRead.add("operations");
    if (changed !== "private")
      assert.equal(
        socialWindowHistoryAllowed(f.runtime, a, socialSources(f.runtime, a)),
        false,
      );
    const sent = f.s.send(a, {
      requestId: randomUUID(),
      visitId: f.visitId,
      expectedVisitRevision: 1,
      body: "Synthetic denied scope",
    });
    assert.equal(sent.status, "not_sent");
    assert.equal(
      f.s.db.prepare("SELECT count(*) n FROM home_social_messages").get().n,
      0,
    );
  });

for (const change of ["arrival", "retracted", "hidden", "identity", "unseen"])
  test(`read acknowledgement ignores unrelated visit revisions but checks the actual displayed message: ${change}`, (t) => {
    const f = setup(t),
      visitId = f.visit(),
      a = f.ctx("agent-0", { kind: "visit", id: visitId });
    const first = f.s.send(a, {
      requestId: randomUUID(),
      visitId,
      expectedVisitRevision: 1,
      body: "Synthetic displayed message",
    });
    const b = f.ctx("agent-1", { kind: "visit", id: visitId });
    f.s.visitRead(b, { visitId });
    if (change === "arrival" || change === "unseen")
      f.s.send(a, {
        requestId: randomUUID(),
        visitId,
        expectedVisitRevision: 2,
        body: "Synthetic concurrent arrival",
      });
    if (change === "retracted")
      f.s.retract(a, {
        requestId: randomUUID(),
        messageId: first.result.messageId,
        expectedMessageRevision: 1,
      });
    if (change === "hidden")
      f.s.db
        .prepare(
          "UPDATE home_social_messages SET hidden_at=?,revision=revision+1 WHERE id=?",
        )
        .run(f.now(), first.result.messageId);
    if (change === "identity")
      f.s.db
        .prepare("UPDATE home_social_messages SET id=? WHERE id=?")
        .run(randomUUID(), first.result.messageId);
    const args = {
      requestId: randomUUID(),
      visitId,
      lastDisplayedSequence: change === "unseen" ? 2 : 1,
      expectedVisitRevision: 2,
    };
    if (change === "arrival") {
      const result = f.s.markRead(b, args);
      assert.equal(result.result.lastReadSequence, 1);
      assert.equal(
        f.s.db
          .prepare("SELECT revision FROM home_social_visits WHERE id=?")
          .get(visitId).revision,
        3,
      );
    } else assert.throws(() => f.s.markRead(b, args), /AUDIENCE_DENIED/);
  });

test("unsubmitted ordinary input cannot borrow window history to survive revoked visibility", (t) => {
  const f = windowFixture(t),
    a = f.actor("agent-0");
  f.s.db
    .prepare("UPDATE home_social_turns SET started_at=NULL WHERE id=?")
    .run(a.socialBinding.turnId);
  f.s.roomRead(a, { visitId: f.visitId });
  assert.equal(a.socialHistory.sources.size, 0);
  f.s.db
    .prepare(
      "UPDATE home_social_grants SET revision=revision+1,scope='[]' WHERE visit_id=?",
    )
    .run(f.visitId);
  assert.equal(
    [...a.socialInputLeases].every((guard) =>
      socialInputLeaseAllowed(f.runtime, a, guard),
    ),
    false,
  );
  assert.throws(
    () => captureSocialWindowHistory(f.runtime, a),
    /SOCIAL_SOURCE_DENIED/,
  );
});

for (const change of ["retracted", "hidden"])
  test(`prepared new message is not historical input before delivery: ${change}`, (t) => {
    const f = windowFixture(t),
      a = f.actor("agent-0"),
      b = f.actor("agent-1");
    f.s.roomRead(a, { visitId: f.visitId });
    captureSocialWindowHistory(f.runtime, a);
    f.s.db
      .prepare(
        "UPDATE home_social_grants SET revision=revision+1,scope='[]' WHERE visit_id=?",
      )
      .run(f.visitId);
    const sent = f.s.send(a, {
      requestId: randomUUID(),
      visitId: f.visitId,
      expectedVisitRevision: 1,
      body: "Synthetic prepared new body",
    });
    assert.equal(sent.status, "committed");
    const prepared = f.s.visitRead(b, { visitId: f.visitId });
    assert.equal(prepared.messages[0].body, "Synthetic prepared new body");
    assert.equal(b.socialHistory.sources.size, 0);
    const id = sent.result.messageId;
    const column = change === "retracted" ? "retracted_at" : "hidden_at";
    f.s.db
      .prepare(
        `UPDATE home_social_messages SET ${column}=?,revision=revision+1 WHERE id=?`,
      )
      .run(f.now(), id);
    assert.equal(
      socialWindowHistoryAllowed(f.runtime, b, socialSources(f.runtime, b)),
      false,
    );
    assert.equal(
      [...b.socialInputLeases].every((guard) =>
        socialInputLeaseAllowed(f.runtime, b, guard),
      ),
      false,
    );
    let delivered = 0;
    assert.throws(() => {
      captureSocialWindowHistory(f.runtime, b);
      delivered++;
    }, /SOCIAL_SOURCE_DENIED|AUDIENCE_DENIED/);
    assert.equal(delivered, 0);
    assert.equal(b.socialHistory.sources.size, 0);
  });

test("a fresh room read must revalidate its delivery even when an older copy is already historical", (t) => {
  const f = windowFixture(t),
    a = f.actor("agent-0");
  f.s.roomRead(a, { visitId: f.visitId });
  captureSocialWindowHistory(f.runtime, a);
  f.s.roomRead(a, { visitId: f.visitId });
  const guards = [...a.socialInputLeases];
  assert.equal(guards[0].socialHistoryDelivered, true);
  assert.equal(guards[1].socialHistoryDelivered, false);
  f.s.db
    .prepare(
      "UPDATE home_social_grants SET revision=revision+1,scope='[]' WHERE visit_id=?",
    )
    .run(f.visitId);
  assert.equal(socialInputLeaseAllowed(f.runtime, a, guards[0]), true);
  assert.equal(socialInputLeaseAllowed(f.runtime, a, guards[1]), false);
  assert.throws(
    () => captureSocialWindowHistory(f.runtime, a),
    /AUDIENCE_DENIED/,
  );
});
