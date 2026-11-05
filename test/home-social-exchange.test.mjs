import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { SubjectExecution } from "../src/core/subject-execution.mjs";
import { SocialStore } from "../src/home/social-store.mjs";
import { SocialExchange } from "../src/home/social-exchange.mjs";
import { SocialResources } from "../src/home/social-resources.mjs";

function setup(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(
    "CREATE TABLE home_identities(agent_id TEXT PRIMARY KEY,generation TEXT,active INTEGER);INSERT INTO home_identities VALUES('a','ga',1),('b','gb',1)",
  );
  let now = 1000;
  const store = new SocialStore(db, { clock: () => now });
  db.exec(
    "INSERT INTO home_social_invitations(id,host_agent_id,host_generation,guest_agent_id,guest_generation,initiator_generation,recipient_generation,room_id,audience,requested_scope,status,policy_revision,created_at,expires_at) VALUES('invite','a','ga','b','gb','ga','gb','room','[]','[]','accepted',0,0,999999);INSERT INTO home_social_visits(id,invitation_id,host_agent_id,host_generation,guest_agent_id,guest_generation,room_id,pair_key,status,policy_revision,started_at,expires_at) VALUES('visit','invite','a','ga','b','gb','room','ga:gb','active',0,0,999999)",
  );
  const config = {
    homeSocial: {
      enabled: true,
      exchangeEnabled: true,
      durationMinutes: 10,
      maxTurns: 4,
      maxMessagesPerTurn: 3,
      resourceBudget: {
        unit: "tokens",
        maxInputTokensPerInference: 100,
        maxOutputTokensPerInference: 10,
        maxTokensPerTurn: 220,
        maxTokensPerWindow: 880,
        maxTokensPerDay: 1000,
        maxInferencesPerTurn: 2,
      },
    },
  };
  const service = {
    store,
    assertBinding: (ctx) => {
      if (!ctx?.socialBinding) throw Error("IDENTITY_DENIED");
    },
    assertVisit: (identity, id) => {
      const v = db
        .prepare("SELECT * FROM home_social_visits WHERE id=?")
        .get(id);
      if (
        !v ||
        ![v.host_generation, v.guest_generation].includes(identity.generation)
      )
        throw Error("IDENTITY_DENIED");
      return v;
    },
    targetBinding: (identity, target) => ({
      target,
      actorIdentity: identity,
      targetHostGeneration: "ga",
      targetGuestGeneration: "gb",
      policyRevision: 0,
      configRevision: "config",
      deadline: 999999,
    }),
  };
  const runtime = {
    homeSocial: service,
    config,
    now: () => now,
    socialSourceAllowed: () => true,
    socialRuntime: {
      assertContext: (ctx) => {
        const turn = db
          .prepare("SELECT * FROM home_social_turns WHERE id=?")
          .get(ctx.socialBinding.turnId);
        if (turn.status !== "running") throw Error("SOCIAL_TURN_CLOSED");
      },
      limits: () => config.homeSocial,
    },
  };
  const exchange = new SocialExchange(runtime);
  const context = (generation, turnId = null, windowId = null) => ({
    socialBinding: {
      runId: turnId,
      actorIdentity: { agentId: generation === "ga" ? "a" : "b", generation },
      target: { kind: "visit", id: "visit" },
      turnId,
      runMode: windowId ? "window" : "async",
      windowId,
      fence: 0,
      policyRevision: 0,
    },
  });
  return {
    db,
    store,
    config,
    runtime,
    exchange,
    context,
    setNow: (v) => {
      now = v;
    },
  };
}

test("one actor lease is shared by subject and all social targets", () => {
  const locks = new SubjectExecution(),
    one = {},
    two = {};
  const release = locks.acquire("a", one);
  assert.equal(locks.acquire("a", two), null);
  assert.equal(locks.busy("a"), true);
  release();
  release();
  assert.equal(typeof locks.acquire("a", two), "function");
});

test("two consents create one window queue; four alternating turns seal once", (t) => {
  const f = setup(t),
    a = f.context("ga"),
    b = f.context("gb");
  const proposal = f.exchange.propose(a, {
    requestId: "propose-0001",
    visitId: "visit",
  }).result;
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM home_social_dispatches").get().n,
    0,
  );
  f.exchange.decide(b, {
    requestId: "decide-00001",
    windowId: proposal.windowId,
    expectedWindowRevision: 1,
    termsRevision: proposal.termsRevision,
    accept: true,
  });
  const authors = [];
  for (let i = 0; i < 4; i++) {
    const d = f.db
      .prepare(
        "SELECT * FROM home_social_dispatches WHERE status='queued' ORDER BY rowid LIMIT 1",
      )
      .get();
    assert.ok(d);
    authors.push(d.actor_generation);
    f.db
      .prepare("UPDATE home_social_dispatches SET status='claimed' WHERE id=?")
      .run(d.id);
    f.db
      .prepare(
        "UPDATE home_social_turns SET status='running',started_at=1000,message_count=2 WHERE id=?",
      )
      .run(d.turn_id);
    f.db
      .prepare(
        "UPDATE home_social_windows SET turns_used=turns_used+1 WHERE id=?",
      )
      .run(d.window_id);
    f.db
      .prepare(
        "INSERT INTO home_social_messages(id,visit_id,author_agent_id,author_generation,sequence,body,source_labels,audience,created_at) VALUES(?,'visit',?,?,?,'synthetic message','[]','[]',1000)",
      )
      .run(
        `message-${i}`,
        d.actor_generation === "ga" ? "a" : "b",
        d.actor_generation,
        i + 1,
      );
    f.db
      .prepare(
        "INSERT INTO home_social_events(id,entity_id,actor_generation,type,created_at,metadata) VALUES(?,'visit',?,'message_committed',1000,?)",
      )
      .run(
        `event-${i}`,
        d.actor_generation,
        JSON.stringify({ messageId: `message-${i}`, turnId: d.turn_id }),
      );
    const ctx = f.context(d.actor_generation, d.turn_id, d.window_id);
    f.exchange.yield(ctx, {
      requestId: `yield-0000${i}`,
      windowId: d.window_id,
      expectedWindowRevision: f.db
        .prepare("SELECT revision FROM home_social_windows WHERE id=?")
        .get(d.window_id).revision,
    });
    const turn = f.db
      .prepare("SELECT * FROM home_social_turns WHERE id=?")
      .get(d.turn_id);
    f.store.transaction((now) => f.exchange.finishBatch(turn, now));
    f.db
      .prepare("UPDATE home_social_turns SET status='completed' WHERE id=?")
      .run(turn.id);
    f.db
      .prepare(
        "UPDATE home_social_dispatches SET status='completed' WHERE id=?",
      )
      .run(d.id);
  }
  assert.deepEqual(authors, ["ga", "gb", "ga", "gb"]);
  assert.equal(
    f.db.prepare("SELECT status FROM home_social_windows").get().status,
    "closed",
  );
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM home_social_dispatches").get().n,
    4,
  );
});

test("empty batch closes window, async enqueue never creates another actor task", (t) => {
  const f = setup(t);
  const first = f.exchange.propose(f.context("ga"), {
    requestId: "propose-0001",
    visitId: "visit",
  }).result;
  f.exchange.decide(f.context("gb"), {
    requestId: "decide-00001",
    windowId: first.windowId,
    expectedWindowRevision: 1,
    termsRevision: first.termsRevision,
    accept: true,
  });
  const d = f.db.prepare("SELECT * FROM home_social_dispatches").get();
  f.db
    .prepare(
      "UPDATE home_social_turns SET status='running',batch_sealed=1 WHERE id=?",
    )
    .run(d.turn_id);
  f.store.transaction((now) =>
    f.exchange.finishBatch(
      f.db.prepare("SELECT * FROM home_social_turns WHERE id=?").get(d.turn_id),
      now,
    ),
  );
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM home_social_dispatches").get().n,
    1,
  );
  f.store.transaction((now) =>
    f.exchange.enqueue(
      { agentId: "a", generation: "ga" },
      { kind: "visit", id: "visit" },
      "async",
      null,
      now,
      "async-a",
    ),
  );
  assert.equal(
    f.db
      .prepare(
        "SELECT count(*) n FROM home_social_dispatches WHERE mode='async'",
      )
      .get().n,
    1,
  );
});

test("inference reservations enforce per-turn/day cap; not_started releases and unknown stays", async (t) => {
  const f = setup(t);
  const queued = f.store.transaction((now) =>
    f.exchange.enqueue(
      { agentId: "a", generation: "ga" },
      { kind: "visit", id: "visit" },
      "async",
      null,
      now,
      "async-a",
    ),
  );
  f.db
    .prepare("UPDATE home_social_turns SET status='running' WHERE id=?")
    .run(queued.turnId);
  const resources = new SocialResources(
    f.runtime,
    f.context("ga", queued.turnId),
  );
  const input = {
    runId: queued.turnId,
    requestId: "inference-one",
    inputUpperBound: 100,
    outputCap: 10,
  };
  const first = await resources.reserveInference(input);
  assert.equal((await resources.reserveInference(input)).claimed, false);
  await resources.settleInference({
    reservationId: first.reservationId,
    status: "not_started",
  });
  assert.equal(
    f.db.prepare("SELECT reserved FROM home_social_usage").get().reserved,
    0,
  );
  const second = await resources.reserveInference({
    ...input,
    requestId: "inference-two",
  });
  await resources.settleInference({
    reservationId: second.reservationId,
    status: "unknown",
  });
  assert.equal(
    f.db.prepare("SELECT reserved FROM home_social_usage").get().reserved,
    110,
  );
  await assert.rejects(
    resources.reserveInference({ ...input, requestId: "inference-three" }),
    /SOCIAL_RESOURCE_LIMIT/,
  );
  assert.equal(
    f.db.prepare("SELECT started_at FROM home_social_turns").get().started_at,
    1000,
  );
});

test("future consent activates exactly once with the agreed first speaker and actual deadline", (t) => {
  const f = setup(t);
  const proposed = f.exchange.propose(f.context("ga"), {
    requestId: "future-propose",
    visitId: "visit",
    notBefore: 2000,
    latestStartAt: 4000,
    consentExpiresAt: 700000,
    firstSpeakerAgentId: "b",
  }).result;
  const decision = f.exchange.decide(f.context("gb"), {
    requestId: "future-decide",
    windowId: proposed.windowId,
    expectedWindowRevision: 1,
    termsRevision: proposed.termsRevision,
    accept: true,
  }).result;
  assert.equal(decision.status, "proposed");
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM home_social_dispatches").get().n,
    0,
  );
  f.setNow(2000);
  const row = f.db.prepare("SELECT * FROM home_social_windows").get();
  f.store.transaction((now) => f.exchange.activate(row, now));
  f.store.transaction((now) => f.exchange.activate(row, now));
  const w = f.db.prepare("SELECT * FROM home_social_windows").get();
  assert.equal(w.started_at, 2000);
  assert.equal(w.deadline, 602000);
  assert.equal(
    f.db.prepare("SELECT actor_generation FROM home_social_dispatches").get()
      .actor_generation,
    "gb",
  );
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM home_social_dispatches").get().n,
    1,
  );
});

test("missed latest start expires without moving the interval or launching a turn", (t) => {
  const f = setup(t),
    p = f.exchange.propose(f.context("ga"), {
      requestId: "late-propose",
      visitId: "visit",
      notBefore: 2000,
      latestStartAt: 3000,
    }).result;
  f.exchange.decide(f.context("gb"), {
    requestId: "late-decide1",
    windowId: p.windowId,
    expectedWindowRevision: 1,
    termsRevision: p.termsRevision,
    accept: true,
  });
  f.setNow(3001);
  f.store.transaction((now) =>
    f.exchange.activate(
      f.db.prepare("SELECT * FROM home_social_windows").get(),
      now,
    ),
  );
  assert.equal(
    f.db.prepare("SELECT status FROM home_social_windows").get().status,
    "expired",
  );
  assert.equal(
    f.db.prepare("SELECT count(*) n FROM home_social_dispatches").get().n,
    0,
  );
});

test("terms revisions require exact consent; tightening takes min while relaxation preserves accepted limits", (t) => {
  const f = setup(t),
    p = f.exchange.propose(f.context("ga"), {
      requestId: "terms-propose",
      visitId: "visit",
    }).result;
  assert.throws(
    () =>
      f.exchange.decide(f.context("gb"), {
        requestId: "bad-terms-01",
        windowId: p.windowId,
        expectedWindowRevision: 1,
        termsRevision: "different",
        accept: true,
      }),
    /REVISION_CONFLICT/,
  );
  const w = f.db.prepare("SELECT * FROM home_social_windows").get();
  f.config.homeSocial.durationMinutes = 20;
  f.config.homeSocial.maxTurns = 12;
  assert.equal(f.exchange.effective(w).durationMinutes, 10);
  assert.equal(f.exchange.effective(w).maxTurns, 4);
  f.config.homeSocial.durationMinutes = 2;
  f.config.homeSocial.resourceBudget.maxInferencesPerTurn = 1;
  assert.equal(f.exchange.effective(w).durationMinutes, 2);
  assert.equal(f.exchange.effective(w).resourceBudget.maxInferencesPerTurn, 1);
});

for (const maximum of [2, 12])
  test(`shared window turn boundary stops exactly at ${maximum}`, (t) => {
    const f = setup(t);
    f.config.homeSocial.maxTurns = maximum;
    const p = f.exchange.propose(f.context("ga"), {
      requestId: "boundary-propose",
      visitId: "visit",
    }).result;
    f.exchange.decide(f.context("gb"), {
      requestId: "boundary-decide",
      windowId: p.windowId,
      expectedWindowRevision: 1,
      termsRevision: p.termsRevision,
      accept: true,
    });
    for (let i = 0; i < maximum; i++) {
      const d = f.db
        .prepare(
          "SELECT * FROM home_social_dispatches WHERE status='queued' LIMIT 1",
        )
        .get();
      assert.ok(d);
      f.db
        .prepare(
          "UPDATE home_social_dispatches SET status='completed' WHERE id=?",
        )
        .run(d.id);
      f.db
        .prepare(
          "UPDATE home_social_turns SET status='completed',batch_sealed=1,message_count=1 WHERE id=?",
        )
        .run(d.turn_id);
      f.db
        .prepare(
          "UPDATE home_social_windows SET turns_used=turns_used+1 WHERE id=?",
        )
        .run(d.window_id);
      f.db
        .prepare(
          "INSERT INTO home_social_messages(id,visit_id,author_agent_id,author_generation,sequence,body,source_labels,audience,created_at) VALUES(?,'visit','a',?,?,'synthetic','[]','[]',1000)",
        )
        .run(`m-${i}`, d.actor_generation, i);
      f.db
        .prepare(
          "INSERT INTO home_social_events(id,entity_id,actor_generation,type,created_at,metadata) VALUES(?,'visit',?,'message_committed',1000,?)",
        )
        .run(
          `e-${i}`,
          d.actor_generation,
          JSON.stringify({ messageId: `m-${i}`, turnId: d.turn_id }),
        );
      f.store.transaction((now) =>
        f.exchange.finishBatch(
          f.db
            .prepare("SELECT * FROM home_social_turns WHERE id=?")
            .get(d.turn_id),
          now,
        ),
      );
    }
    assert.equal(
      f.db.prepare("SELECT turns_used FROM home_social_windows").get()
        .turns_used,
      maximum,
    );
    assert.equal(
      f.db.prepare("SELECT count(*) n FROM home_social_dispatches").get().n,
      maximum,
    );
    assert.equal(
      f.db.prepare("SELECT status FROM home_social_windows").get().status,
      "closed",
    );
  });
