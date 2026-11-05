import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture, config, context, settle } from "./helpers.mjs";
import { validateConfig } from "../src/core/config.mjs";
import { OpenAIBackend } from "../src/backends/openai.mjs";
import { SOCIAL_ADMIN_PRINCIPAL } from "../src/home/social-policy.mjs";
import { Runtime } from "../src/core/runtime.mjs";

test("constructing a service client does not interrupt another authorized turn", async (t) => {
  const f = setup(t),
    r = f.runtime;
  const queued = await f.process("agent-0", { kind: "compose", id: "agent-1" });
  const observer = new Runtime({
    memory: f.store,
    configStore: f.configStore,
    backendFactory: () => ({ run: async () => {}, close: async () => {} }),
  });
  try {
    assert.equal(
      f.store.db
        .prepare("SELECT status FROM home_social_turns WHERE id=?")
        .get(queued.result.turnId).status,
      "queued",
    );
  } finally {
    await observer.close();
  }
  assert.equal(r.runtimeInitialized, undefined);
});

test("explicit process initialization interrupts active windows once and never replays unknown HTTP", async (t) => {
  const f = setup(t),
    r = f.runtime,
    v = await visitFixture(f);
  const a = boundContext(f, "agent-0", { kind: "visit", id: v.id }),
    p = r.socialRuntime.exchange.propose(a, {
      requestId: randomUUID(),
      visitId: v.id,
    }).result;
  r.capabilities.delete(a.token);
  f.store.db
    .prepare("UPDATE home_social_turns SET status='completed' WHERE id=?")
    .run(a.socialBinding.turnId);
  const b = boundContext(f, "agent-1", { kind: "visit", id: v.id });
  r.socialRuntime.exchange.decide(b, {
    requestId: randomUUID(),
    windowId: p.windowId,
    expectedWindowRevision: 1,
    termsRevision: p.termsRevision,
    accept: true,
  });
  r.capabilities.delete(b.token);
  f.store.db
    .prepare("UPDATE home_social_turns SET status='completed' WHERE id=?")
    .run(b.socialBinding.turnId);
  const pending = f.store.db
      .prepare("SELECT * FROM home_social_turns WHERE window_id=?")
      .get(p.windowId),
    reservation = randomUUID();
  f.store.db
    .prepare(
      "INSERT INTO home_social_inference_reservations(id,run_id,request_id,turn_id,actor_generation,mode,status,reserved,created_at) VALUES(?,?,?,?,?,'window','unknown','{\"tokens\":123}',?)",
    )
    .run(
      reservation,
      pending.id,
      "unknown-start",
      pending.id,
      pending.actor_generation,
      r.now(),
    );
  const before = f.requests.length;
  assert.deepEqual(r.initializeRuntime(), { initialized: true });
  assert.equal(
    f.store.db
      .prepare("SELECT status FROM home_social_windows WHERE id=?")
      .get(p.windowId).status,
    "interrupted",
  );
  assert.equal(
    f.store.db
      .prepare(
        "SELECT status FROM home_social_inference_reservations WHERE id=?",
      )
      .get(reservation).status,
    "unknown",
  );
  await f.pump();
  assert.equal(f.requests.length, before);
  const fresh = await f.process("agent-0", { kind: "visit", id: v.id });
  r.startTimers();
  clearInterval(r.ticker);
  r.ticker = null;
  assert.equal(
    f.store.db
      .prepare("SELECT status FROM home_social_turns WHERE id=?")
      .get(fresh.result.turnId).status,
    "queued",
  );
  assert.deepEqual(r.initializeRuntime(), { initialized: false });
});

test("only recipient consumption marks viewed without business revisions, events or visit cursors", async (t) => {
  const f = setup(t),
    inv = await pendingInvitation(f),
    db = f.store.db;
  f.setScript(() => []);
  const events = db
    .prepare("SELECT count(*) n FROM home_social_events")
    .get().n;
  await f.process("agent-0", { kind: "invitation", id: inv.id });
  await f.pump();
  assert.equal(
    db.prepare("SELECT recipient_viewed_at FROM home_social_invitations").get()
      .recipient_viewed_at,
    null,
  );
  await f.process("agent-1", { kind: "invitation", id: inv.id });
  await f.pump();
  const first = db
    .prepare("SELECT recipient_viewed_at,revision FROM home_social_invitations")
    .get();
  assert.notEqual(first.recipient_viewed_at, null);
  assert.equal(first.revision, inv.revision);
  await f.process("agent-1", { kind: "invitation", id: inv.id });
  await f.pump();
  assert.equal(
    db.prepare("SELECT recipient_viewed_at FROM home_social_invitations").get()
      .recipient_viewed_at,
    first.recipient_viewed_at,
  );
  assert.equal(
    db.prepare("SELECT count(*) n FROM home_social_events").get().n,
    events,
  );
  assert.equal(
    db.prepare("SELECT count(*) n FROM home_social_read_cursors").get().n,
    0,
  );
});

test("recipient view is acknowledged only after successful leased model consumption, before tools", async (t) => {
  const f = setup(t),
    r = f.runtime,
    inv = await pendingInvitation(f),
    entered = Promise.withResolvers(),
    release = Promise.withResolvers(),
    db = f.store.db;
  const c = context(r, "agent-1", "@subject");
  r.socialRuntime.capabilities(c, {});
  r.capabilities.delete(c.token);
  r.homeSocial.adminRead(SOCIAL_ADMIN_PRINCIPAL, {
    kind: "invitation",
    id: inv.id,
  });
  assert.equal(
    db.prepare("SELECT recipient_viewed_at FROM home_social_invitations").get()
      .recipient_viewed_at,
    null,
  );
  let viewedBeforeTool = false;
  const call = r.callTool.bind(r);
  r.callTool = async (ctx, name, args) => {
    if (name === "home_visit_decide")
      viewedBeforeTool =
        db
          .prepare("SELECT recipient_viewed_at FROM home_social_invitations")
          .get().recipient_viewed_at !== null;
    return call(ctx, name, args);
  };
  f.setScript((_agent, b, round) =>
    round
      ? []
      : [
          [
            "home_visit_decide",
            {
              requestId: randomUUID(),
              invitationId: b.target.id,
              expectedInvitationRevision: inv.revision,
              decision: "accept",
            },
          ],
        ],
  );
  f.setResponseGate(async () => {
    entered.resolve();
    await release.promise;
  });
  await f.process("agent-1", { kind: "invitation", id: inv.id });
  r.socialRuntime.tick();
  await entered.promise;
  assert.equal(
    db.prepare("SELECT recipient_viewed_at FROM home_social_invitations").get()
      .recipient_viewed_at,
    null,
  );
  release.resolve();
  await settle(r);
  assert.equal(viewedBeforeTool, true);
  assert.notEqual(
    db.prepare("SELECT recipient_viewed_at FROM home_social_invitations").get()
      .recipient_viewed_at,
    null,
  );
  assert.equal(
    db.prepare("SELECT count(*) n FROM home_social_read_cursors").get().n,
    0,
  );
});

for (const failure of [
  "budget",
  "preflight-revoke",
  "inflight-cancel",
  "transport",
])
  test(`invitation remains unviewed when model consumption fails: ${failure}`, async (t) => {
    const f = setup(t),
      r = f.runtime,
      inv = await pendingInvitation(f),
      db = f.store.db,
      before = f.requests.length;
    f.setScript(() => []);
    if (failure === "budget")
      db.prepare(
        "INSERT INTO home_social_usage(actor_generation,day,scope,kind,used,reserved) VALUES(?,?,'social','tokens',?,0)",
      ).run(
        r.home.generation("agent-1"),
        new Date(r.now()).toISOString().slice(0, 10),
        r.config.homeSocial.resourceBudget.maxTokensPerDay - 1,
      );
    if (failure === "preflight-revoke") {
      const factory = r.backendFactory;
      r.backendFactory = (...args) => {
        const adapter = factory(...args),
          run = adapter.runSocial.bind(adapter);
        adapter.runSocial = (params) =>
          run({
            ...params,
            beforeInput: () => {
              r.config.globalPaused = true;
              return params.beforeInput();
            },
          });
        return adapter;
      };
    }
    if (failure === "transport")
      f.setResponseGate(async () => {
        throw Error("SYNTHETIC_TRANSPORT_FAILURE");
      });
    if (failure === "inflight-cancel") {
      const entered = Promise.withResolvers(),
        release = Promise.withResolvers();
      f.setResponseGate(async () => {
        entered.resolve();
        await release.promise;
      });
      await f.process("agent-1", { kind: "invitation", id: inv.id });
      r.socialRuntime.tick();
      await entered.promise;
      const actor = boundContext(f, "agent-0", {
        kind: "invitation",
        id: inv.id,
      });
      r.homeSocial.decide(actor, {
        requestId: randomUUID(),
        invitationId: inv.id,
        expectedInvitationRevision: inv.revision,
        decision: "cancel",
      });
      r.capabilities.delete(actor.token);
      db.prepare(
        "UPDATE home_social_turns SET status='completed' WHERE id=?",
      ).run(actor.socialBinding.turnId);
      release.resolve();
      await settle(r);
    } else {
      await f.process("agent-1", { kind: "invitation", id: inv.id });
      await f.pump();
    }
    assert.equal(
      db
        .prepare("SELECT recipient_viewed_at FROM home_social_invitations")
        .get().recipient_viewed_at,
      null,
    );
    if (["budget", "preflight-revoke"].includes(failure))
      assert.equal(f.requests.length, before);
    assert.equal(
      db.prepare("SELECT count(*) n FROM home_social_read_cursors").get().n,
      0,
    );
  });

test("cleanup database failure cannot retain actor capability, active ownership or unresolved done", async (t) => {
  const f = setup(t),
    r = f.runtime,
    entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  f.setResponseGate(async () => {
    entered.resolve();
    await release.promise;
  });
  f.setScript(() => []);
  await f.process("agent-0", { kind: "compose", id: "agent-1" });
  r.socialRuntime.tick();
  await entered.promise;
  const ctx = r.socialRuntime.active.get("agent-0");
  let done = false;
  ctx.done.then(() => {
    done = true;
  });
  f.store.db.exec(
    "CREATE TRIGGER synthetic_context_failure BEFORE UPDATE ON home_social_contexts BEGIN SELECT RAISE(ABORT,'synthetic cleanup failure');END",
  );
  release.resolve();
  await settle(r);
  assert.equal(done, true);
  assert.equal(r.socialRuntime.active.has("agent-0"), false);
  assert.equal(r.capabilities.has(ctx.token), false);
  assert.equal(r.subjectExecution.busy("agent-0"), false);
  assert.equal(r.faults.get("agent-0"), "SOCIAL_CONTEXT_FINALIZATION_FAILED");
  assert.equal(
    f.store.db.prepare("SELECT status FROM home_social_turns").get().status,
    "interrupted",
  );
  f.store.db.exec("DROP TRIGGER synthetic_context_failure");
});

test("legal Self version evidence taints initial instructions and self_read across fresh contexts", async (t) => {
  const f = setup(t),
    r = f.runtime,
    v = await visitFixture(f),
    m = f.store.bind("agent-0");
  const evidence = m.append({
    dedupe: "private-self-proof",
    conversation: "private:30000",
    kind: "message.received",
    senderId: "30000",
    body: "RAW_PRIVATE_SELF_EVIDENCE",
    payload: {},
  });
  m.identity.writeVersion(
    {
      body: "Synthetic derived private trait",
      reason: "Synthetic legal version",
      actor: "administrator",
      expectedVersion: m.identity.current().version,
      evidence: [evidence.id],
    },
    r.now(),
  );
  const direct = boundContext(f, "agent-0", { kind: "visit", id: v.id });
  await r.executeTool(direct, "self_read", {});
  assert.equal(direct.privateRead.has(evidence.id), true);
  r.capabilities.delete(direct.token);
  f.store.db
    .prepare("UPDATE home_social_turns SET status='completed' WHERE id=?")
    .run(direct.socialBinding.turnId);
  f.setScript((_agent, b, round) =>
    round
      ? []
      : [
          [
            "home_visit_send",
            {
              requestId: randomUUID(),
              visitId: b.target.id,
              expectedVisitRevision: v.revision,
              body: "Synthetic derived private trait",
            },
          ],
        ],
  );
  const before = f.requests.length;
  await f.process("agent-0", { kind: "visit", id: v.id });
  await f.pump();
  assert.doesNotMatch(
    JSON.stringify(f.requests[before].body.messages),
    /RAW_PRIVATE_SELF_EVIDENCE/,
  );
  assert.equal(
    f.store.db.prepare("SELECT count(*) n FROM home_social_messages").get().n,
    0,
  );
  const labels = f.store.db
    .prepare(
      "SELECT source_labels FROM home_social_contexts ORDER BY rowid DESC LIMIT 1",
    )
    .get().source_labels;
  assert.ok(JSON.parse(labels).includes(evidence.id));
  m.identity.writeVersion(
    {
      body: "Synthetic safe replacement",
      reason: "New version cannot erase earlier consumed provenance",
      actor: "administrator",
      expectedVersion: m.identity.current().version,
      evidence: [],
    },
    r.now(),
  );
  await f.process("agent-0", { kind: "visit", id: v.id });
  await f.pump();
  assert.equal(
    f.store.db.prepare("SELECT count(*) n FROM home_social_messages").get().n,
    0,
  );
});

for (const reader of ["person_notes", "person_items", "mood_read"])
  for (const restricted of [true, false])
    test(`${reader} tracks nested raw provenance; restricted=${restricted}`, async (t) => {
      const f = setup(t),
        r = f.runtime,
        m = f.store.bind("agent-0"),
        scope = restricted ? "private:30000" : "@subject";
      const event = m.append({
        dedupe: `source-${reader}`,
        conversation: scope,
        kind: restricted ? "message.received" : "app.observation",
        senderId: "30000",
        body: "SYNTHETIC_MEMORY_FACT",
        payload: restricted ? {} : { app: { origin: "app-browser" } },
      });
      const c = context(r, "agent-0", scope);
      const writer =
        reader === "person_notes"
          ? "person_note"
          : reader === "person_items"
            ? "person_item"
            : "mood_set";
      const args =
        writer === "person_note"
          ? {
              personId: "30000",
              body: "SYNTHETIC_MEMORY_FACT",
              evidence: [event.id],
            }
          : writer === "person_item"
            ? {
                personId: "30000",
                kind: "promise",
                body: "SYNTHETIC_MEMORY_FACT",
                evidence: [event.id],
              }
            : {
                mood: "synthetic",
                intensity: 2,
                reason: "SYNTHETIC_MEMORY_FACT",
                evidence: [event.id],
                hours: 1,
              };
      await r.executeTool(c, writer, args);
      r.capabilities.delete(c.token);
      const v = await visitFixture(f);
      f.setScript((_agent, b, round) =>
        round === 0
          ? [[reader, reader === "mood_read" ? {} : { personIds: ["30000"] }]]
          : round === 1
            ? [
                [
                  "home_visit_send",
                  {
                    requestId: randomUUID(),
                    visitId: b.target.id,
                    expectedVisitRevision: v.revision,
                    body: "SYNTHETIC_MEMORY_FACT",
                  },
                ],
              ]
            : [],
      );
      await f.process("agent-0", { kind: "visit", id: v.id });
      await f.pump();
      assert.equal(
        f.store.db.prepare("SELECT count(*) n FROM home_social_messages").get()
          .n,
        restricted ? 0 : 1,
      );
    });

test("fresh context reconstructs committed, not_sent and unknown without rejected draft bodies", async (t) => {
  const f = setup(t),
    r = f.runtime,
    v = await visitFixture(f),
    unknownId = randomUUID();
  r.config.homeSocial.maxMessagesPerVisitPerDay = 1;
  const original = r.callTool.bind(r);
  r.callTool = async (ctx, name, args) => {
    if (args.requestId === unknownId) throw Error("RESULT_UNKNOWN");
    return original(ctx, name, args);
  };
  f.setScript((_agent, b, round) =>
    round
      ? []
      : [
          [
            "home_visit_send",
            {
              requestId: randomUUID(),
              visitId: b.target.id,
              expectedVisitRevision: v.revision,
              body: "confirmed synthetic text",
            },
          ],
          [
            "home_visit_send",
            {
              requestId: randomUUID(),
              visitId: b.target.id,
              expectedVisitRevision: v.revision + 1,
              body: "PRIVATE_DRAFT_NOT_SENT",
            },
          ],
          [
            "home_visit_send",
            {
              requestId: unknownId,
              visitId: b.target.id,
              expectedVisitRevision: v.revision + 1,
              body: "PRIVATE_DRAFT_UNKNOWN",
            },
          ],
        ],
  );
  await f.process("agent-0", { kind: "visit", id: v.id });
  await f.pump();
  const recorded = f.store.db
    .prepare(
      "SELECT metadata FROM home_social_outbox WHERE type='social-receipt'",
    )
    .all();
  assert.ok(recorded.every((row) => !row.metadata.includes("PRIVATE_DRAFT")));
  f.setScript(() => []);
  const before = f.requests.length;
  await f.process("agent-0", { kind: "visit", id: v.id });
  await f.pump();
  const prompt = JSON.stringify(f.requests[before].body.messages);
  assert.match(prompt, /confirmed synthetic text/);
  assert.doesNotMatch(prompt, /PRIVATE_DRAFT/);
  assert.match(prompt, /not_sent/);
  assert.match(prompt, /unknown/);
  assert.match(prompt, /committed/);
  assert.equal(
    f.store.db.prepare("SELECT count(*) n FROM home_social_messages").get().n,
    1,
  );
});

test("backend processing-scope change during HTTP prevents late model tools", async (t) => {
  const f = setup(t),
    r = f.runtime,
    v = await visitFixture(f),
    entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  f.setResponseGate(async () => {
    entered.resolve();
    await release.promise;
  });
  f.setScript((_agent, b) => [
    [
      "home_visit_send",
      {
        requestId: randomUUID(),
        visitId: b.target.id,
        expectedVisitRevision: v.revision,
        body: "late old-provider draft",
      },
    ],
  ]);
  await f.process("agent-0", { kind: "visit", id: v.id });
  r.socialRuntime.tick();
  await entered.promise;
  r.config.backends[0].model = "changed-model";
  r.socialRuntime.cancelStale();
  release.resolve();
  await settle(r);
  assert.equal(
    f.store.db.prepare("SELECT count(*) n FROM home_social_messages").get().n,
    0,
  );
  assert.equal(r.subjectExecution.busy("agent-0"), false);
});

function setup(t) {
  const cfg = config(2);
  cfg.homeSocial = {
    enabled: true,
    exchangeEnabled: true,
    durationMinutes: 10,
    maxTurns: 4,
    maxMessagesPerTurn: 3,
    resourceBudget: {
      unit: "tokens",
      maxInputTokensPerInference: 1047576,
      maxOutputTokensPerInference: 128,
      maxTokensPerTurn: 5000000,
      maxTokensPerWindow: 60000000,
      maxTokensPerDay: 100000000,
      maxInferencesPerTurn: 4,
    },
  };
  cfg.backends = [
    {
      id: "social",
      type: "openai",
      label: "Synthetic social backend",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4.1-mini-2025-04-14",
      socialProfile: "openai-gpt-4.1-mini",
    },
  ];
  for (const a of cfg.agents) {
    a.backendId = "social";
    a.home = { ...a.home, enabled: true, social: { enabled: true } };
    a.subject.enabled = true;
  }
  const f = fixture(t, { cfg: validateConfig(cfg) }),
    r = f.runtime,
    requests = [],
    runs = [];
  let script = () => [],
    responseGate = async () => {};
  r.backendFactory = (backend, agent) => {
    let params,
      round = 0;
    const adapter = new OpenAIBackend(backend, agent, {
      root: f.root,
      fetch: async (_url, options) => {
        const body = JSON.parse(options.body);
        requests.push({ agentId: agent.id, runId: params.binding.runId, body });
        await responseGate(agent.id, params.binding, round);
        const calls = script(agent.id, params.binding, round++, body) || [];
        return {
          ok: true,
          json: async () => ({
            usage: { prompt_tokens: 100, completion_tokens: 20 },
            choices: [
              {
                message: calls.length
                  ? {
                      tool_calls: calls.map(([name, args]) => ({
                        id: randomUUID(),
                        type: "function",
                        function: { name, arguments: JSON.stringify(args) },
                      })),
                    }
                  : { content: "draft never delivered" },
              },
            ],
          }),
        };
      },
    });
    const run = adapter.runSocial.bind(adapter);
    adapter.runSocial = (value) => {
      params = value;
      round = 0;
      runs.push(value.binding);
      return run(value);
    };
    return adapter;
  };
  async function process(agentId, target) {
    const c = context(r, agentId, "@subject");
    try {
      return r.socialRuntime.process(c, { requestId: randomUUID(), target });
    } finally {
      r.capabilities.delete(c.token);
    }
  }
  async function pump() {
    r.socialRuntime.tick();
    await settle(r);
  }
  return {
    ...f,
    requests,
    runs,
    setScript: (value) => {
      script = value;
    },
    setResponseGate: (value) => {
      responseGate = value;
    },
    process,
    pump,
  };
}

async function pendingInvitation(f) {
  f.setScript((_agent, _binding, round) =>
    round
      ? []
      : [
          [
            "home_visit_invite",
            {
              requestId: randomUUID(),
              targetAgentId: "agent-1",
              roomOwnerAgentId: "agent-1",
              purpose: "Synthetic complete invitation",
              scope: ["layout"],
              selectedItems: [],
            },
          ],
        ],
  );
  await f.process("agent-0", { kind: "compose", id: "agent-1" });
  await f.pump();
  return f.store.db.prepare("SELECT * FROM home_social_invitations").get();
}

async function visitFixture(f) {
  const db = f.store.db;
  f.setScript((_agent, b, round) =>
    round
      ? []
      : b.target.kind === "compose"
        ? [
            [
              "home_visit_invite",
              {
                requestId: randomUUID(),
                targetAgentId: "agent-1",
                roomOwnerAgentId: "agent-1",
                purpose: "Synthetic visit",
                scope: ["layout"],
                selectedItems: [],
              },
            ],
          ]
        : [
            [
              "home_visit_decide",
              {
                requestId: randomUUID(),
                invitationId: b.target.id,
                expectedInvitationRevision: 1,
                decision: "accept",
              },
            ],
          ],
  );
  await f.process("agent-0", { kind: "compose", id: "agent-1" });
  await f.pump();
  const invitation = db.prepare("SELECT id FROM home_social_invitations").get();
  await f.process("agent-1", { kind: "invitation", id: invitation.id });
  await f.pump();
  return db.prepare("SELECT * FROM home_social_visits").get();
}

function boundContext(f, agentId, target) {
  const r = f.runtime,
    s = r.homeSocial,
    base = s.targetBinding(s.identity(agentId), target),
    turnId = randomUUID(),
    ctx = r.makeContext(agentId, `@social:${turnId}`);
  ctx.runtimeKind = "subject-social";
  ctx.socialBinding = {
    ...base,
    runId: turnId,
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
      target.kind === "visit" ? target.id : null,
      base.target.kind,
      base.target.id,
      base.targetHostGeneration,
      base.targetGuestGeneration,
      base.actorIdentity.generation,
      base.policyRevision,
      base.configRevision,
      r.now(),
    );
  return ctx;
}

test("real runtime async invitation and consent window alternate twice with ephemeral HTTP inputs", async (t) => {
  const f = setup(t),
    r = f.runtime,
    db = f.store.db;
  let phase = "invite";
  f.setScript((agentId, binding, round) => {
    if (round) return [];
    if (binding.runMode === "window") {
      const visit = db
          .prepare("SELECT * FROM home_social_visits WHERE id=?")
          .get(binding.target.id),
        w = db
          .prepare("SELECT * FROM home_social_windows WHERE id=?")
          .get(binding.windowId);
      return [
        [
          "home_visit_send",
          {
            requestId: randomUUID(),
            visitId: visit.id,
            expectedVisitRevision: visit.revision,
            body: `synthetic ${agentId} message`,
          },
        ],
        [
          "home_exchange_yield",
          {
            requestId: randomUUID(),
            windowId: w.id,
            expectedWindowRevision: w.revision,
          },
        ],
      ];
    }
    if (phase === "invite")
      return [
        [
          "home_visit_invite",
          {
            requestId: randomUUID(),
            targetAgentId: "agent-1",
            roomOwnerAgentId: "agent-1",
            purpose: "Synthetic voluntary visit",
            scope: ["layout"],
            selectedItems: [],
          },
        ],
      ];
    if (phase === "accept") {
      const inv = db.prepare("SELECT * FROM home_social_invitations").get();
      return [
        [
          "home_visit_decide",
          {
            requestId: randomUUID(),
            invitationId: inv.id,
            expectedInvitationRevision: inv.revision,
            decision: "accept",
          },
        ],
      ];
    }
    if (phase === "propose")
      return [
        [
          "home_exchange_propose",
          {
            requestId: randomUUID(),
            visitId: binding.target.id,
            firstSpeakerAgentId: "agent-0",
          },
        ],
      ];
    const w = db.prepare("SELECT * FROM home_social_windows").get();
    return [
      [
        "home_exchange_decide",
        {
          requestId: randomUUID(),
          windowId: w.id,
          expectedWindowRevision: w.revision,
          termsRevision: w.terms_revision,
          accept: true,
        },
      ],
    ];
  });
  await f.process("agent-0", { kind: "compose", id: "agent-1" });
  await f.pump();
  const invitation = db.prepare("SELECT * FROM home_social_invitations").get();
  assert.ok(
    invitation,
    JSON.stringify({
      turns: db
        .prepare("SELECT status,safe_error FROM home_social_turns")
        .all(),
      requests: f.requests.length,
      faults: [...r.faults],
    }),
  );
  assert.equal(f.runs.length, 1);
  assert.equal(
    db.prepare("SELECT count(*) n FROM home_social_messages").get().n,
    0,
  );
  phase = "accept";
  await f.process("agent-1", { kind: "invitation", id: invitation.id });
  await f.pump();
  const visit = db.prepare("SELECT * FROM home_social_visits").get();
  assert.ok(visit);
  phase = "propose";
  await f.process("agent-0", { kind: "visit", id: visit.id });
  await f.pump();
  assert.equal(
    db
      .prepare(
        "SELECT count(*) n FROM home_social_dispatches WHERE mode='window'",
      )
      .get().n,
    0,
  );
  phase = "consent";
  await f.process("agent-1", { kind: "visit", id: visit.id });
  await f.pump();
  for (let i = 0; i < 6; i++) await f.pump();
  const messages = db
    .prepare(
      "SELECT author_agent_id FROM home_social_messages ORDER BY sequence",
    )
    .all();
  assert.deepEqual(
    messages.map((x) => x.author_agent_id),
    ["agent-0", "agent-1", "agent-0", "agent-1"],
  );
  const window = db.prepare("SELECT * FROM home_social_windows").get();
  assert.equal(window.status, "closed");
  assert.equal(window.turns_used, 4);
  assert.equal(window.turns_reserved, 0);
  assert.equal(
    db.prepare("SELECT status FROM home_social_visits").get().status,
    "active",
  );
  assert.equal(new Set(f.runs.map((x) => x.runId)).size, f.runs.length);
  assert.ok(
    f.requests.every(
      (x) => x.body.max_completion_tokens === 128 && x.body.store === false,
    ),
  );
  assert.equal(r.capabilities.size, 0);
  assert.equal(r.subjectExecution.busy("agent-0"), false);
  for (const transport of r.transports.values())
    assert.equal(transport.sent.length, 0);
  const chats = f.store.db
    .prepare("SELECT value FROM runtime WHERE conversation='@subject'")
    .all();
  assert.ok(chats.every((x) => !JSON.parse(x.value).session));
});

test("unsupported role reports capability and does not silently switch backend", async (t) => {
  const f = setup(t),
    r = f.runtime;
  r.config.backends[0].type = "codex";
  const c = context(r, "agent-0", "@subject");
  assert.equal(r.socialRuntime.capabilities(c, {}).backend.supported, false);
  await assert.rejects(
    f.process("agent-0", { kind: "compose", id: "agent-1" }),
    /SOCIAL_BACKEND_UNSUPPORTED/,
  );
  assert.equal(f.requests.length, 0);
  assert.equal(r.config.backends[0].type, "codex");
  r.capabilities.delete(c.token);
});

test("ending a visit during HTTP rejects late tool calls and releases actor ownership", async (t) => {
  const f = setup(t),
    r = f.runtime,
    v = await visitFixture(f),
    entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  const before = f.requests.length;
  f.setResponseGate(async () => {
    entered.resolve();
    await release.promise;
  });
  f.setScript((_agent, b) => [
    [
      "home_visit_send",
      {
        requestId: randomUUID(),
        visitId: b.target.id,
        expectedVisitRevision: v.revision,
        body: "late synthetic output",
      },
    ],
  ]);
  await f.process("agent-0", { kind: "visit", id: v.id });
  r.socialRuntime.tick();
  await entered.promise;
  r.homeSocial.store.transaction((now) =>
    r.homeSocial.closeVisit(v, now, "ended", "administrator"),
  );
  r.socialRuntime.cancelStale();
  release.resolve();
  await settle(r);
  assert.equal(
    f.store.db.prepare("SELECT count(*) n FROM home_social_messages").get().n,
    0,
  );
  assert.equal(f.requests.length, before + 1);
  assert.equal(r.subjectExecution.busy("agent-0"), false);
  const held = f.store.db
    .prepare(
      "SELECT status FROM home_social_inference_reservations ORDER BY rowid DESC LIMIT 1",
    )
    .get();
  assert.equal(held.status, "completed");
});

test("unknown model result retains resources and ordinary restart never replays HTTP", async (t) => {
  const f = setup(t),
    r = f.runtime;
  f.setResponseGate(async () => {
    throw Error("synthetic transport failure");
  });
  await f.process("agent-0", { kind: "compose", id: "agent-1" });
  await f.pump();
  const db = f.store.db,
    count = f.requests.length;
  assert.equal(
    db.prepare("SELECT status FROM home_social_inference_reservations").get()
      .status,
    "unknown",
  );
  assert.ok(
    db
      .prepare("SELECT reserved FROM home_social_usage WHERE kind='tokens'")
      .get().reserved > 0,
  );
  r.homeSocial.store.interruptRuntime(randomUUID());
  await f.pump();
  assert.equal(f.requests.length, count);
  assert.equal(r.subjectExecution.busy("agent-0"), false);
});

test("room grant reduction after tool read prevents the next HTTP inference", async (t) => {
  const f = setup(t),
    r = f.runtime,
    v = await visitFixture(f),
    before = f.requests.length;
  const original = r.callTool.bind(r);
  r.callTool = async (ctx, name, args) => {
    const result = await original(ctx, name, args);
    if (name === "home_visit_room_read") {
      const host = boundContext(f, "agent-1", { kind: "visit", id: v.id }),
        grant = f.store.db
          .prepare("SELECT * FROM home_social_grants WHERE visit_id=?")
          .get(v.id);
      r.homeSocial.grantReduce(host, {
        requestId: randomUUID(),
        visitId: v.id,
        expectedGrantRevision: grant.revision,
        scope: [],
        selectedItems: [],
        expiresAt: grant.expires_at,
      });
      r.capabilities.delete(host.token);
      f.store.db
        .prepare("UPDATE home_social_turns SET status='completed' WHERE id=?")
        .run(host.socialBinding.turnId);
    }
    return result;
  };
  f.setScript((_agent, b, round) =>
    round ? [] : [["home_visit_room_read", { visitId: b.target.id }]],
  );
  await f.process("agent-0", { kind: "visit", id: v.id });
  await f.pump();
  assert.equal(f.requests.length, before + 1);
  assert.equal(
    f.store.db
      .prepare("SELECT scope FROM home_social_grants WHERE visit_id=?")
      .get(v.id).scope,
    "[]",
  );
  assert.equal(
    f.store.db
      .prepare(
        "SELECT status FROM home_social_turns ORDER BY rowid DESC LIMIT 1",
      )
      .get().status,
    "completed",
  );
  assert.equal(
    f.store.db
      .prepare("SELECT status FROM home_social_turns WHERE id=?")
      .get(f.runs.at(-1).turnId).status,
    "failed",
  );
});

test("human turn preempts social work while ordinary subject waits for cleanup", async (t) => {
  const f = setup(t),
    r = f.runtime,
    v = await visitFixture(f),
    entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  f.setResponseGate(async () => {
    entered.resolve();
    await release.promise;
  });
  f.setScript(() => []);
  await f.process("agent-0", { kind: "visit", id: v.id });
  r.socialRuntime.tick();
  await entered.promise;
  let humanRan = false;
  r.backends.get("agent-0").run = async () => {
    humanRan = true;
  };
  await r.runTurn("agent-0", "group:20000", {
    reasons: [{ reason: "private" }],
  });
  assert.equal(humanRan, true);
  assert.equal(
    r.socialRuntime.active.get("agent-0").controller.signal.aborted,
    true,
  );
  assert.deepEqual(await r.runTurn("agent-0", "@subject"), {
    status: "queued",
  });
  release.resolve();
  await settle(r);
  assert.equal(r.subjectExecution.busy("agent-0"), false);
});

test("a non-yielding model closes the window without inventing a partner response", async (t) => {
  const f = setup(t),
    r = f.runtime,
    v = await visitFixture(f);
  const a = boundContext(f, "agent-0", { kind: "visit", id: v.id });
  const p = r.socialRuntime.exchange.propose(a, {
    requestId: randomUUID(),
    visitId: v.id,
  }).result;
  r.capabilities.delete(a.token);
  f.store.db
    .prepare("UPDATE home_social_turns SET status='completed' WHERE id=?")
    .run(a.socialBinding.turnId);
  const b = boundContext(f, "agent-1", { kind: "visit", id: v.id });
  r.socialRuntime.exchange.decide(b, {
    requestId: randomUUID(),
    windowId: p.windowId,
    expectedWindowRevision: 1,
    termsRevision: p.termsRevision,
    accept: true,
  });
  r.capabilities.delete(b.token);
  f.store.db
    .prepare("UPDATE home_social_turns SET status='completed' WHERE id=?")
    .run(b.socialBinding.turnId);
  f.setScript(() => []);
  await f.pump();
  assert.equal(
    f.store.db.prepare("SELECT status FROM home_social_windows").get().status,
    "closed",
  );
  assert.equal(
    f.store.db
      .prepare(
        "SELECT count(*) n FROM home_social_dispatches WHERE mode='window'",
      )
      .get().n,
    1,
  );
});

test("terminal invitation processing exposes only safe receipts without Self or memory tools", async (t) => {
  const f = setup(t),
    r = f.runtime,
    invitation = await pendingInvitation(f);
  f.store.db
    .prepare("UPDATE home_social_invitations SET status='declined' WHERE id=?")
    .run(invitation.id);
  const before = f.requests.length;
  f.setScript(() => []);
  await f.process("agent-1", { kind: "invitation", id: invitation.id });
  await f.pump();
  const input = f.requests[before].body;
  assert.deepEqual(input.tools.map((x) => x.function.name).sort(), [
    "home_social_capabilities",
    "home_social_operation_read",
    "home_visit_invitation_read",
  ]);
  assert.equal(
    JSON.stringify(input.messages).includes(invitation.purpose),
    false,
  );
  assert.match(input.messages[0].content, /Self固定版本：null/);
  assert.equal(r.subjectExecution.busy("agent-1"), false);
});

test("current invitation state denies stale broad tool lists in actual dispatch", async (t) => {
  const f = setup(t),
    r = f.runtime,
    invitation = await pendingInvitation(f);
  const ctx = boundContext(f, "agent-1", {
    kind: "invitation",
    id: invitation.id,
  });
  ctx.allowedTools = [
    ...r.socialRuntime.tools(ctx),
    "diary_write",
    "subject_log",
  ];
  assert.equal(ctx.allowedTools.includes("self_read"), true);
  f.store.db
    .prepare("UPDATE home_social_invitations SET status='cancelled' WHERE id=?")
    .run(invitation.id);
  ctx.socialBinding.readOnly = false;
  for (const name of [
    "self_read",
    "person_notes",
    "mood_read",
    "diary_write",
    "subject_log",
    "home_visit_send",
  ])
    await assert.rejects(r.executeTool(ctx, name, {}), /TOOL_DISABLED/);
  assert.equal(r.socialRuntime.tools(ctx).length, 3);
  r.capabilities.delete(ctx.token);
});

test("cached ordinary OpenAI adapters refresh social profiles without replacing chat history", async (t) => {
  for (const removal of ["null", "omitted"]) {
    const f = setup(t),
      r = f.runtime;
    const initial = structuredClone(r.config);
    delete initial.backends[0].socialProfile;
    initial.backends[0].contextWindow = 1000000;
    await r.changeConfig(initial, f.configStore.revision);
    const adapter = r.backendConnections.adapter(r.agent("agent-0"));
    const socialFetch = adapter.fetch;
    adapter.fetch = async () => ({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: { role: "assistant", content: "ordinary synthetic reply" },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    });
    let session;
    await adapter.run({
      signal: new AbortController().signal,
      tools: [],
      prompt: "ordinary synthetic input",
      saveSession: (value) => {
        session = value;
      },
    });
    adapter.fetch = socialFetch;
    const history = adapter.load(session.id);
    assert.equal(r.socialRuntime.backendCapability("agent-0").supported, false);
    await assert.rejects(
      f.process("agent-0", { kind: "compose", id: "agent-1" }),
      /SOCIAL_BACKEND_UNSUPPORTED/,
    );
    const enabled = structuredClone(r.config);
    enabled.backends[0].socialProfile = "openai-gpt-4.1-mini";
    await r.changeConfig(enabled, f.configStore.revision);
    assert.equal(r.socialRuntime.backendCapability("agent-0").supported, true);
    f.setScript(() => []);
    await f.process("agent-0", { kind: "compose", id: "agent-1" });
    await f.pump();
    assert.equal(f.requests.length, 1);
    assert.equal(r.backends.get("agent-0"), adapter);
    assert.equal(adapter.config.socialProfile, "openai-gpt-4.1-mini");
    assert.deepEqual(adapter.load(session.id), history);
    const queued = await f.process("agent-0", {
      kind: "compose",
      id: "agent-1",
    });
    const disabled = structuredClone(r.config);
    if (removal === "null") disabled.backends[0].socialProfile = null;
    else delete disabled.backends[0].socialProfile;
    await r.changeConfig(disabled, f.configStore.revision);
    assert.equal(r.backendConnections.adapter(r.agent("agent-0")), adapter);
    assert.equal(adapter.config.socialProfile, null);
    assert.equal(r.socialRuntime.backendCapability("agent-0").supported, false);
    await assert.rejects(
      f.process("agent-0", { kind: "compose", id: "agent-1" }),
      /SOCIAL_BACKEND_UNSUPPORTED/,
    );
    await f.pump();
    assert.notEqual(
      f.store.db
        .prepare("SELECT status FROM home_social_turns WHERE id=?")
        .get(queued.result.turnId).status,
      "queued",
    );
    assert.equal(f.requests.length, 1);
    assert.deepEqual(adapter.load(session.id), history);
  }
});
