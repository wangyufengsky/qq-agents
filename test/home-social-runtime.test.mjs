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
  const capabilities = r.socialRuntime.capabilities(c, {});
  assert.deepEqual(capabilities.pendingTargets, [
    { kind: "invitation", id: inv.id },
  ]);
  assert.match(
    capabilities.notice,
    /home_social_process.*compose.*pendingTargets/,
  );
  assert.match(capabilities.notice, /不会唤醒对方/);
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

for (const revoked of [false, true]) {
  test(`slow invitation HTTP rechecks current authority before consumption: revoked=${revoked}`, async (t) => {
    const f = setup(t),
      r = f.runtime,
      inv = await pendingInvitation(f),
      db = f.store.db;
    let now = r.now();
    r.now = () => now;
    f.setResponseGate(async (_agent, _binding, round) => {
      now += 20000;
      if (revoked && round === 0)
        db.prepare(
          "UPDATE home_social_invitations SET revision=revision+1 WHERE id=?",
        ).run(inv.id);
    });
    f.setScript((_agent, binding, round) =>
      round
        ? []
        : [
            [
              "home_visit_decide",
              {
                requestId: randomUUID(),
                invitationId: binding.target.id,
                expectedInvitationRevision: inv.revision,
                decision: "accept",
              },
            ],
          ],
    );
    await f.process("agent-1", { kind: "invitation", id: inv.id });
    await f.pump();
    const row = db
      .prepare(
        "SELECT recipient_viewed_at FROM home_social_invitations WHERE id=?",
      )
      .get(inv.id);
    assert.equal(row.recipient_viewed_at !== null, !revoked);
    assert.equal(
      db.prepare("SELECT count(*) n FROM home_social_visits").get().n,
      revoked ? 0 : 1,
    );
    assert.equal(r.subjectExecution.busy("agent-1"), false);
  });

  test(`slow multi-inference visit HTTP preserves room revocation checks: revoked=${revoked}`, async (t) => {
    const f = setup(t),
      r = f.runtime,
      visit = await visitFixture(f),
      db = f.store.db;
    let now = r.now();
    r.now = () => now;
    const before = f.requests.length;
    f.setResponseGate(async (_agent, _binding, round) => {
      now += 20000;
      if (revoked && round === 1)
        db.prepare(
          "UPDATE home_social_grants SET revision=revision+1 WHERE visit_id=?",
        ).run(visit.id);
    });
    f.setScript((_agent, binding, round) =>
      round === 0
        ? [["home_visit_room_read", { visitId: binding.target.id }]]
        : round === 1
          ? [
              [
                "home_visit_send",
                {
                  requestId: randomUUID(),
                  visitId: binding.target.id,
                  expectedVisitRevision: visit.revision,
                  body: "Synthetic authorized slow response",
                },
              ],
            ]
          : [],
    );
    await f.process("agent-0", { kind: "visit", id: visit.id });
    await f.pump();
    assert.ok(f.requests.length >= before + 2);
    assert.equal(
      db
        .prepare("SELECT count(*) n FROM home_social_messages WHERE visit_id=?")
        .get(visit.id).n,
      revoked ? 0 : 1,
    );
    assert.equal(r.subjectExecution.busy("agent-0"), false);
    for (const transport of r.transports.values())
      assert.equal(transport.sent.length, 0);
  });
}

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
  assert.equal(r.socialRuntime.tools(ctx).length, 4);
  assert.ok(r.socialRuntime.tools(ctx).includes("room_scene_view"));
  assert.equal(r.socialRuntime.tools(ctx).includes("room_read"), false);
  assert.doesNotThrow(() =>
    r.socialRuntime.assertToolAllowed(ctx, "room_scene_view"),
  );
  assert.equal(
    r
      .toolsFor(r.agent("agent-1"), ctx.conversation)
      .includes("room_scene_view"),
    false,
  );
  r.agent("agent-1").home.sceneView.enabled = true;
  assert.equal(
    r
      .toolsFor(r.agent("agent-1"), ctx.conversation)
      .includes("room_scene_view"),
    true,
  );
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

async function turnOnlyWindow(f, maximum = 12) {
  return agreeWindow(f, await visitFixture(f), maximum);
}

async function agreeWindow(f, visit, maximum = 12) {
  const r = f.runtime,
    db = f.store.db;
  r.config.homeSocial.resourceBudget = null;
  r.config.homeSocial.maxTurns = maximum;
  const a = boundContext(f, "agent-0", { kind: "visit", id: visit.id });
  const p = r.socialRuntime.exchange.propose(a, {
    requestId: randomUUID(),
    visitId: visit.id,
  }).result;
  const b = boundContext(f, "agent-1", { kind: "visit", id: visit.id });
  r.socialRuntime.exchange.decide(b, {
    requestId: randomUUID(),
    windowId: p.windowId,
    expectedWindowRevision: 1,
    termsRevision: p.termsRevision,
    accept: true,
  });
  for (const ctx of [a, b]) {
    r.capabilities.delete(ctx.token);
    db.prepare(
      "UPDATE home_social_turns SET status='completed' WHERE id=?",
    ).run(ctx.socialBinding.turnId);
  }
  return { visit, windowId: p.windowId };
}

test("turn-only exchange counts twelve alternating actor runs once despite multiple messages and start callbacks", async (t) => {
  const f = setup(t),
    r = f.runtime,
    db = f.store.db;
  const { visit, windowId } = await turnOnlyWindow(f);
  const authors = [];
  for (const agentId of ["agent-0", "agent-1"])
    r.backends.set(agentId, {
      close: async () => {},
      runSocial: async (params) => {
        assert.equal(params.budget, null);
        assert.equal(params.maxInferences, null);
        assert.equal(params.outputCap, null);
        await params.beforeInput();
        assert.deepEqual(await params.onRunStarted(), { started: true });
        assert.equal((await params.onRunStarted()).historicalReplay, true);
        authors.push(agentId);
        for (let n = 0; n < 2; n++) {
          const current = db
            .prepare("SELECT revision FROM home_social_visits WHERE id=?")
            .get(visit.id);
          const sent = await params.callTool("home_visit_send", {
            requestId: randomUUID(),
            visitId: visit.id,
            expectedVisitRevision: current.revision,
            body: "Synthetic turn-only message",
          });
          assert.equal(sent.status, "committed");
        }
        const w = db
          .prepare("SELECT revision FROM home_social_windows WHERE id=?")
          .get(windowId);
        await params.callTool("home_exchange_yield", {
          requestId: randomUUID(),
          windowId,
          expectedWindowRevision: w.revision,
        });
      },
    });
  for (let n = 0; n < 14; n++) await f.pump();
  const window = db
    .prepare("SELECT * FROM home_social_windows WHERE id=?")
    .get(windowId);
  assert.deepEqual(
    authors,
    Array.from({ length: 12 }, (_, n) => `agent-${n % 2}`),
  );
  assert.equal(window.turns_used, 12);
  assert.equal(window.turns_reserved, 0);
  assert.equal(window.status, "closed");
  assert.equal(
    db
      .prepare("SELECT count(*) n FROM home_social_messages WHERE visit_id=?")
      .get(visit.id).n,
    24,
  );
  assert.equal(
    db
      .prepare(
        "SELECT count(*) n FROM home_social_inference_reservations WHERE turn_id IN (SELECT id FROM home_social_turns WHERE window_id=?)",
      )
      .get(windowId).n,
    0,
  );
  assert.equal(
    r.homeSocial.usageDTO(visit, null, window).windowResources.usageAvailable,
    false,
  );
});

for (const phase of ["before", "after", "restart"])
  test(`turn-only failure ${phase} start preserves exact charge and never dispatches again`, async (t) => {
    const f = setup(t),
      r = f.runtime,
      db = f.store.db;
    const { windowId } = await turnOnlyWindow(f);
    let entered = 0;
    r.backends.set("agent-0", {
      close: async () => {},
      runSocial: async (params) => {
        entered++;
        if (phase !== "before") await params.onRunStarted();
        if (phase === "restart")
          r.homeSocial.store.interruptRuntime("synthetic-restart");
        throw Error("SOCIAL_TURN_FAILED");
      },
    });
    await f.pump();
    await f.pump();
    const window = db
      .prepare("SELECT * FROM home_social_windows WHERE id=?")
      .get(windowId);
    assert.equal(window.turns_used, phase === "before" ? 0 : 1);
    assert.equal(window.turns_reserved, 0);
    assert.equal(entered, 1);
    assert.equal(
      db
        .prepare(
          "SELECT count(*) n FROM home_social_dispatches WHERE window_id=? AND status='queued'",
        )
        .get(windowId).n,
      0,
    );
  });

test("turn-only backend support covers all four types while explicit budgets retain precise profile requirements", (t) => {
  const f = setup(t),
    r = f.runtime,
    budget = r.config.homeSocial.resourceBudget;
  r.config.homeSocial.resourceBudget = null;
  for (const type of ["dsh", "codex", "antigravity", "openai"]) {
    r.config.backends[0].type = type;
    r.config.backends[0].preset = "qq-unified";
    assert.equal(r.socialRuntime.backendCapability("agent-0").supported, true);
    assert.equal(
      r.socialRuntime.backendCapability("agent-0", budget).supported,
      type === "openai",
    );
  }
});

test("adding a hard token budget during a turn-only run prevents all further input and tools", async (t) => {
  const f = setup(t),
    r = f.runtime,
    db = f.store.db;
  const budget = structuredClone(r.config.homeSocial.resourceBudget);
  const { windowId } = await turnOnlyWindow(f);
  let continued = false;
  r.backends.set("agent-0", {
    close: async () => {},
    runSocial: async (params) => {
      await params.onRunStarted();
      r.config.homeSocial.resourceBudget = budget;
      assert.throws(() => params.beforeInput(), /SOCIAL_TURN_CLOSED/);
      await assert.rejects(
        params.callTool("home_exchange_status", { windowId }),
        /SOCIAL_TURN_CLOSED/,
      );
      continued = true;
      throw Error("SOCIAL_TURN_CLOSED");
    },
  });
  await f.pump();
  assert.equal(continued, true);
  const w = db
    .prepare("SELECT * FROM home_social_windows WHERE id=?")
    .get(windowId);
  assert.equal(w.turns_used, 1);
  assert.equal(w.status, "closed");
  assert.equal(
    r.homeSocial.usageDTO(
      db.prepare("SELECT * FROM home_social_visits").get(),
      null,
      w,
    ).windowResources.usageAvailable,
    false,
  );
});

test("DSH capability rejects presets that expose ordinary tools", (t) => {
  const f = setup(t),
    r = f.runtime;
  r.config.homeSocial.resourceBudget = null;
  r.config.backends[0].type = "dsh";
  r.config.backends[0].preset = "ordinary-preset";
  assert.equal(r.socialRuntime.backendCapability("agent-0").supported, false);
});

test("an explicit async budget remains binding after its global configuration is removed", async (t) => {
  const f = setup(t),
    r = f.runtime,
    budget = structuredClone(r.config.homeSocial.resourceBudget);
  let checked = false;
  r.backends.set("agent-0", {
    close: async () => {},
    runSocial: async (params) => {
      await params.onRunStarted();
      r.config.homeSocial.resourceBudget = null;
      assert.deepEqual(params.limitsForInference().resourceBudget, budget);
      assert.equal(
        params.limitsForInference().outputCap,
        budget.maxOutputTokensPerInference,
      );
      checked = true;
    },
  });
  await f.process("agent-0", { kind: "compose", id: "agent-1" });
  await f.pump();
  assert.equal(checked, true);
});

for (const change of ["revoked", "expired", "configuration"])
  test(`native-style inherited sources cancel without another model input: ${change}`, async (t) => {
    const f = setup(t),
      r = f.runtime,
      db = f.store.db;
    const visit = await visitFixture(f);
    r.config.homeSocial.resourceBudget = null;
    const entered = Promise.withResolvers();
    let runs = 0,
      stopped = false,
      lateWriteRejected = false;
    r.backends.set("agent-0", {
      close: async () => {},
      runSocial: async (params) => {
        await params.beforeInput();
        await params.onRunStarted();
        if (!runs++) {
          await params.callTool("home_visit_room_read", { visitId: visit.id });
          return;
        }
        // The next physical session inherits source markers, but does not read the
        // room again or invoke another beforeInput while native reasoning is busy.
        entered.resolve();
        await new Promise((resolve) =>
          params.signal.addEventListener("abort", resolve, { once: true }),
        );
        stopped = true;
        await assert.rejects(
          params.callTool("home_visit_send", {
            requestId: randomUUID(),
            visitId: visit.id,
            expectedVisitRevision: visit.revision,
            body: "Synthetic late write denied",
          }),
        );
        lateWriteRejected = true;
      },
    });
    await f.process("agent-0", { kind: "visit", id: visit.id });
    await f.pump();
    await f.process("agent-0", { kind: "visit", id: visit.id });
    r.socialRuntime.tick();
    await entered.promise;
    const active = r.socialRuntime.active.get("agent-0");
    assert.ok(
      [...active.privateRead].some((marker) =>
        marker.startsWith("social-grant:"),
      ),
    );
    if (change === "configuration") {
      const next = structuredClone(r.config);
      next.agents[0].home.social.enabled = false;
      await r.changeConfig(next, f.configStore.revision);
    } else {
      const column = change === "revoked" ? "revoked_at" : "expires_at";
      db.prepare(
        `UPDATE home_social_grants SET ${column}=? WHERE visit_id=?`,
      ).run(r.now(), visit.id);
      r.socialRuntime.tick();
      await settle(r);
    }
    assert.equal(active.controller.signal.aborted, true);
    assert.equal(stopped, true);
    assert.equal(lateWriteRejected, true);
    assert.equal(
      db
        .prepare("SELECT count(*) n FROM home_social_messages WHERE visit_id=?")
        .get(visit.id).n,
      0,
    );
    assert.equal(r.socialRuntime.active.size, 0);
  });

function inputState(prompt) {
  return JSON.parse(prompt.slice(prompt.indexOf("{")).split("\n")[0]);
}

function windowReply(f, binding, body = "Synthetic continuation") {
  const db = f.store.db;
  return [
    [
      "home_visit_send",
      {
        requestId: randomUUID(),
        visitId: binding.target.id,
        expectedVisitRevision: db
          .prepare("SELECT revision FROM home_social_visits WHERE id=?")
          .get(binding.target.id).revision,
        body,
      },
    ],
    [
      "home_exchange_yield",
      {
        requestId: randomUUID(),
        windowId: binding.windowId,
        expectedWindowRevision: db
          .prepare("SELECT revision FROM home_social_windows WHERE id=?")
          .get(binding.windowId).revision,
      },
    ],
  ];
}

test("window continuation appends new input once and disposes both actor histories at its limit", async (t) => {
  const f = setup(t),
    r = f.runtime;
  const { windowId } = await turnOnlyWindow(f, 6);
  const before = f.requests.length;
  f.setScript((_agent, binding) => windowReply(f, binding));
  for (let i = 0; i < 7; i++) await f.pump();
  const requests = f.requests.slice(before);
  assert.equal(requests.length, 6);
  for (const agent of ["agent-0", "agent-1"]) {
    const own = requests.filter((x) => x.agentId === agent);
    assert.equal(own.length, 3);
    const seen = new Set();
    for (const [index, request] of own.entries()) {
      const messages = request.body.messages;
      assert.equal(messages.filter((x) => x.role === "system").length, 1);
      assert.equal(messages.filter((x) => x.role === "user").length, index + 1);
      const state = inputState(
        messages.filter((x) => x.role === "user").at(-1).content,
      );
      assert.equal(state.continuation, index > 0);
      for (const m of state.state.messages) {
        assert.equal(seen.has(m.messageId), false);
        seen.add(m.messageId);
      }
    }
    assert.equal(
      r.backendConnections.adapter(r.agent(agent)).socialSessionPool.capsules
        .size,
      0,
    );
  }
  assert.equal(r.socialRuntime.windowSessions.size, 0);
  assert.equal(
    f.store.db
      .prepare("SELECT status FROM home_social_windows WHERE id=?")
      .get(windowId).status,
    "closed",
  );
});

test("initial history pagination exposes all forty-five messages and next turn does not replay them", async (t) => {
  const f = setup(t),
    r = f.runtime,
    db = f.store.db;
  const { visit } = await turnOnlyWindow(f, 4);
  const insert = db.prepare(
    "INSERT INTO home_social_messages(id,visit_id,author_agent_id,author_generation,sequence,body,source_labels,audience,created_at) VALUES(?,?,?,?,?,?,'[]',?,?)",
  );
  for (let i = 1; i <= 45; i++)
    insert.run(
      randomUUID(),
      visit.id,
      visit.host_agent_id,
      visit.host_generation,
      i,
      `Synthetic history item ${i}`,
      JSON.stringify([visit.host_generation, visit.guest_generation]),
      r.now(),
    );
  db.prepare("UPDATE home_social_visits SET next_sequence=46 WHERE id=?").run(
    visit.id,
  );
  const received = new Map(),
    prompts = [];
  for (const agent of ["agent-0", "agent-1"])
    r.backends.set(agent, {
      close: async () => {},
      closeSocialSessions: async () => {},
      runSocial: async (params) => {
        await params.beforeInput();
        await params.onRunStarted();
        const input = inputState(params.prompt);
        prompts.push({ agent, input });
        assert.match(params.prompt, /home_visit_read/);
        let page = input.state;
        const seen = [];
        while (true) {
          seen.push(...page.messages.map((x) => x.sequence));
          if (!page.nextCursor) break;
          page = await params.callTool("home_visit_read", {
            visitId: visit.id,
            cursor: page.nextCursor,
            limit: 20,
          });
        }
        if (!received.has(agent)) received.set(agent, seen);
        for (const [name, args] of windowReply(f, params.binding))
          await params.callTool(name, args);
      },
    });
  for (let i = 0; i < 5; i++) await f.pump();
  assert.deepEqual(
    received.get("agent-0"),
    Array.from({ length: 45 }, (_, i) => i + 1),
  );
  assert.equal(prompts.length, 4);
  for (const { input } of prompts.filter((x) => x.input.continuation))
    assert.ok(input.state.messages.every((x) => x.sequence > 45));
});

test("idle actor sessions close on pause before another model run starts", async (t) => {
  const f = setup(t),
    r = f.runtime;
  const { windowId } = await turnOnlyWindow(f, 6);
  f.setScript((_agent, binding) => windowReply(f, binding));
  await f.pump();
  const adapter = r.backendConnections.adapter(r.agent("agent-0"));
  assert.equal(adapter.socialSessionPool.capsules.size, 1);
  const before = f.requests.length;
  r.config.globalPaused = true;
  r.socialRuntime.cancelStale();
  await settle(r);
  assert.equal(adapter.socialSessionPool.capsules.size, 0);
  assert.equal(r.socialRuntime.windowSessions.size, 0);
  assert.equal(f.requests.length, before);
  assert.equal(
    f.store.db
      .prepare("SELECT status FROM home_social_windows WHERE id=?")
      .get(windowId).status,
    "closed",
  );
});

test("ordinary room withdrawal preserves the conversation and fresh room reads remain denied", async (t) => {
  const f = setup(t),
    r = f.runtime,
    db = f.store.db;
  const { visit, windowId } = await turnOnlyWindow(f, 6);
  const before = f.requests.length;
  let changed = false;
  f.setResponseGate(async (_agent, binding, round) => {
    const turn = f.runs.filter((x) => x.windowId === windowId).length;
    if (turn === 3 && round === 0) {
      db.prepare(
        "UPDATE home_social_grants SET revision=revision+1,revoked_at=? WHERE visit_id=?",
      ).run(r.now(), visit.id);
      changed = true;
    }
  });
  f.setScript((_agent, binding, round) => {
    const turn = f.runs.filter((x) => x.windowId === windowId).length;
    if (turn <= 2 && round === 0)
      return [["home_visit_room_read", { visitId: visit.id }]];
    if (turn === 4 && round === 0)
      return [["home_visit_room_read", { visitId: visit.id }]];
    return windowReply(
      f,
      binding,
      "Synthetic friendly continuation after room changes",
    );
  });
  for (let i = 0; i < 7; i++) await f.pump();
  assert.equal(changed, true);
  const row = db
    .prepare("SELECT * FROM home_social_windows WHERE id=?")
    .get(windowId);
  assert.equal(row.turns_used, 6);
  assert.equal(row.status, "closed");
  assert.equal(
    db
      .prepare("SELECT count(*) n FROM home_social_messages WHERE visit_id=?")
      .get(visit.id).n,
    6,
  );
  const denied = f.requests
    .slice(before)
    .flatMap((x) => x.body.messages)
    .filter((x) => x.role === "tool")
    .map((x) => JSON.parse(x.content))
    .some((x) => x.isError);
  assert.equal(denied, true);
  assert.equal(r.socialRuntime.windowSessions.size, 0);
});

test("a replaced adapter rebuilds a successful sealed window turn with readable history and handoff", async (t) => {
  const f = setup(t),
    r = f.runtime,
    db = f.store.db;
  const { visit, windowId } = await turnOnlyWindow(f, 6);
  const pendingText = "Synthetic pending topic about the copper kite",
    agreementText = "Synthetic agreement to finish the kite tomorrow";
  const old = r.backendConnections.adapter(r.agent("agent-0"));
  const run = old.runSocial.bind(old);
  let sentId;
  old.runSocial = (params) =>
    run({
      ...params,
      callTool: async (name, args) => {
        const result = await params.callTool(
          name,
          name === "home_exchange_yield"
            ? {
                ...args,
                handoff: {
                  pendingTopics: [
                    { text: pendingText, sourceMessageIds: [sentId] },
                  ],
                  agreements: [
                    { text: agreementText, sourceMessageIds: [sentId] },
                  ],
                },
              }
            : args,
        );
        if (name === "home_visit_send") sentId = result.result.messageId;
        return result;
      },
    });
  f.setScript((_agent, binding) =>
    windowReply(f, binding, "Synthetic copper kite source"),
  );
  await f.pump();
  await f.pump();
  const previous = db
    .prepare(
      "SELECT * FROM home_social_turns WHERE window_id=? AND actor_generation=? AND status='completed' ORDER BY created_at DESC LIMIT 1",
    )
    .get(windowId, r.home.generation("agent-0"));
  assert.equal(previous.status, "completed");
  assert.equal(previous.batch_sealed, 1);
  let disposed = 0,
    rebuilt;
  const close = old.closeSocialSessions.bind(old);
  old.closeSocialSessions = async (...args) => {
    await close(...args);
    disposed++;
  };
  r.backends.set("agent-0", {
    close: async () => {},
    closeSocialSessions: async () => {},
    runSocial: async (params) => {
      assert.equal(disposed, 1, "the old capsule closes before new input");
      rebuilt = inputState(params.prompt);
      assert.equal(rebuilt.continuation, false);
      assert.equal(rebuilt.state.messages.length, 2);
      assert.ok(
        rebuilt.state.messages.some((message) => message.messageId === sentId),
      );
      assert.equal(rebuilt.handoff.pendingTopics[0].text, pendingText);
      assert.equal(rebuilt.handoff.agreements[0].text, agreementText);
      await params.beforeInput();
      await params.onRunStarted();
      for (const [name, args] of windowReply(f, params.binding))
        await params.callTool(name, args);
    },
  });
  await f.pump();
  assert.ok(rebuilt);
  const window = db
    .prepare("SELECT * FROM home_social_windows WHERE id=?")
    .get(windowId);
  assert.equal(window.status, "active");
  assert.equal(window.turns_used, 3);
  assert.equal(
    db
      .prepare("SELECT count(*) n FROM home_social_messages WHERE visit_id=?")
      .get(visit.id).n,
    3,
  );
});

for (const removal of ["retracted_at", "hidden_at"])
  test(`a newly prepared window message is not history before model delivery: ${removal}`, async (t) => {
    const f = setup(t),
      r = f.runtime,
      db = f.store.db;
    const { visit, windowId } = await turnOnlyWindow(f, 6);
    f.setScript((_agent, binding) => windowReply(f, binding));
    await f.pump();
    let denied = false,
      started = 0;
    r.backends.set("agent-1", {
      close: async () => {},
      runSocial: async (params) => {
        const input = inputState(params.prompt);
        assert.equal(input.state.messages.length, 1);
        db.prepare(
          `UPDATE home_social_messages SET ${removal}=?,revision=revision+1 WHERE id=?`,
        ).run(r.now(), input.state.messages[0].messageId);
        try {
          await params.beforeInput();
        } catch {
          denied = true;
          throw Error("AUDIENCE_DENIED");
        }
        await params.onRunStarted();
        started++;
      },
    });
    await f.pump();
    assert.equal(denied, true);
    assert.equal(started, 0);
    const window = db
      .prepare("SELECT * FROM home_social_windows WHERE id=?")
      .get(windowId);
    assert.equal(window.turns_used, 1);
    assert.equal(window.status, "closed");
    assert.equal(
      db
        .prepare("SELECT count(*) n FROM home_social_messages WHERE visit_id=?")
        .get(visit.id).n,
      1,
    );
  });

test("OpenAI window tool results are not history before the next HTTP input", async (t) => {
  const f = setup(t),
    r = f.runtime,
    db = f.store.db;
  const { visit, windowId } = await turnOnlyWindow(f, 6);
  const adapter = r.backendConnections.adapter(r.agent("agent-0"));
  const run = adapter.runSocial.bind(adapter);
  adapter.runSocial = (params) => {
    const call = params.callTool;
    return run({
      ...params,
      callTool: async (name, args) => {
        const result = await call(name, args);
        if (name === "home_visit_room_read")
          db.prepare(
            "UPDATE home_social_grants SET revision=revision+1,revoked_at=? WHERE visit_id=?",
          ).run(r.now(), visit.id);
        return result;
      },
    });
  };
  const before = f.requests.length;
  f.setScript((_agent, binding, round) =>
    round === 0
      ? [["home_visit_room_read", { visitId: visit.id }]]
      : windowReply(f, binding),
  );
  await f.pump();
  assert.equal(f.requests.length - before, 1);
  assert.equal(
    db
      .prepare("SELECT count(*) n FROM home_social_messages WHERE visit_id=?")
      .get(visit.id).n,
    0,
  );
  assert.equal(
    db
      .prepare("SELECT status FROM home_social_windows WHERE id=?")
      .get(windowId).status,
    "closed",
  );
});

async function handoffReply(f, params, handoff) {
  await params.beforeInput();
  await params.onRunStarted();
  const [send, yieldTurn] = windowReply(f, params.binding);
  const sent = await params.callTool(...send);
  const note =
    typeof handoff === "function" ? handoff(sent.result.messageId) : handoff;
  await params.callTool(yieldTurn[0], {
    ...yieldTurn[1],
    ...(note === undefined ? {} : { handoff: note }),
  });
  return sent.result.messageId;
}

function closeTestWindow(f, windowId) {
  const r = f.runtime;
  r.homeSocial.store.transaction((now) =>
    r.socialRuntime.exchange.closeRow(
      f.store.db
        .prepare("SELECT * FROM home_social_windows WHERE id=?")
        .get(windowId),
      now,
      "participant_closed",
    ),
  );
  r.socialRuntime.cancelStale();
}

test("handoff stays out of normal continuation and an omitted update survives into a fresh visit session", async (t) => {
  const f = setup(t),
    r = f.runtime;
  const { visit, windowId } = await turnOnlyWindow(f, 6);
  const topic = "Synthetic unfinished copper kite topic";
  let rounds = 0,
    recovered;
  const prompts = [];
  for (const agent of ["agent-0", "agent-1"])
    r.backends.set(agent, {
      close: async () => {},
      closeSocialSessions: async () => {},
      runSocial: async (params) => {
        const input = inputState(params.prompt);
        prompts.push({ agent, input });
        if (!params.binding.windowId) {
          recovered = input;
          await params.beforeInput();
          await params.onRunStarted();
          return;
        }
        const save = agent === "agent-0" && rounds++ === 0;
        await handoffReply(
          f,
          params,
          save
            ? (messageId) => ({
                pendingTopics: [{ text: topic, sourceMessageIds: [messageId] }],
                agreements: [],
              })
            : undefined,
        );
      },
    });
  for (let i = 0; i < 3; i++) await f.pump();
  const continued = prompts.find(
    (item) => item.agent === "agent-0" && item.input.continuation,
  );
  assert.ok(continued);
  assert.equal(Object.hasOwn(continued.input, "handoff"), false);
  closeTestWindow(f, windowId);
  await settle(r);
  await f.process("agent-0", { kind: "visit", id: visit.id });
  await f.pump();
  assert.equal(recovered.continuation, false);
  assert.equal(recovered.handoff.pendingTopics[0].text, topic);
  assert.equal(recovered.handoff.agreements.length, 0);
  assert.ok(
    recovered.handoff.references.some(
      (reference) => reference.body === "Synthetic continuation",
    ),
  );
});

test("explicit empty handoff clears the old note without reviving it on a fresh session", async (t) => {
  const f = setup(t),
    r = f.runtime;
  const { visit, windowId } = await turnOnlyWindow(f, 6);
  let ownTurns = 0,
    recovered;
  for (const agent of ["agent-0", "agent-1"])
    r.backends.set(agent, {
      close: async () => {},
      closeSocialSessions: async () => {},
      runSocial: async (params) => {
        if (!params.binding.windowId) {
          recovered = inputState(params.prompt);
          await params.beforeInput();
          await params.onRunStarted();
          return;
        }
        const turn = agent === "agent-0" ? ++ownTurns : 0;
        await handoffReply(
          f,
          params,
          turn === 1
            ? (messageId) => ({
                pendingTopics: [
                  {
                    text: "Synthetic cleared topic",
                    sourceMessageIds: [messageId],
                  },
                ],
                agreements: [],
              })
            : turn === 2
              ? { pendingTopics: [], agreements: [] }
              : undefined,
        );
      },
    });
  for (let i = 0; i < 3; i++) await f.pump();
  closeTestWindow(f, windowId);
  await settle(r);
  await f.process("agent-0", { kind: "visit", id: visit.id });
  await f.pump();
  assert.deepEqual(recovered.handoff?.pendingTopics || [], []);
  assert.deepEqual(recovered.handoff?.agreements || [], []);
  assert.doesNotMatch(JSON.stringify(recovered), /Synthetic cleared topic/);
});

for (const phase of ["transport", "after-yield"])
  test(`failed or unknown window input cannot be replayed as a fresh adapter handoff: ${phase}`, async (t) => {
    const f = setup(t),
      r = f.runtime,
      db = f.store.db;
    const { windowId } = await turnOnlyWindow(f, 6);
    let attempts = 0;
    r.backends.set("agent-0", {
      close: async () => {},
      closeSocialSessions: async () => {},
      runSocial: async (params) => {
        attempts++;
        if (phase === "after-yield")
          await handoffReply(f, params, (messageId) => ({
            pendingTopics: [
              {
                text: "Synthetic uncompleted handoff",
                sourceMessageIds: [messageId],
              },
            ],
            agreements: [],
          }));
        else {
          await params.beforeInput();
          await params.onRunStarted();
        }
        throw Error(
          phase === "transport"
            ? "SOCIAL_INFERENCE_UNKNOWN"
            : "SOCIAL_TURN_FAILED",
        );
      },
    });
    await f.pump();
    let replayed = 0;
    r.backends.set("agent-0", {
      close: async () => {},
      runSocial: async () => {
        replayed++;
      },
    });
    for (let i = 0; i < 2; i++) await f.pump();
    const window = db
      .prepare("SELECT * FROM home_social_windows WHERE id=?")
      .get(windowId);
    assert.equal(attempts, 1);
    assert.equal(replayed, 0);
    assert.equal(window.turns_used, 1);
    assert.equal(window.status, "closed");
    assert.equal(
      db
        .prepare(
          "SELECT count(*) n FROM home_social_dispatches WHERE window_id=? AND status='queued'",
        )
        .get(windowId).n,
      0,
    );
  });

test("handoff references beyond the first history page do not skip unread messages on continuation", async (t) => {
  const f = setup(t),
    r = f.runtime,
    db = f.store.db;
  const visit = await visitFixture(f);
  const sourceIds = [];
  const insert = db.prepare(
    "INSERT INTO home_social_messages(id,visit_id,author_agent_id,author_generation,sequence,body,source_labels,audience,created_at) VALUES(?,?,?,?,?,?,'[]',?,?)",
  );
  for (let sequence = 1; sequence <= 25; sequence++) {
    const id = randomUUID();
    sourceIds.push(id);
    insert.run(
      id,
      visit.id,
      "agent-1",
      r.home.generation("agent-1"),
      sequence,
      `Synthetic paging reference ${sequence}`,
      JSON.stringify([visit.host_generation, visit.guest_generation]),
      r.now(),
    );
  }
  db.prepare("UPDATE home_social_visits SET next_sequence=26 WHERE id=?").run(
    visit.id,
  );
  const first = await agreeWindow(f, visit, 6);
  const topic = "Synthetic pending topic linked to page two";
  let phase = "save",
    fresh,
    continued;
  for (const agent of ["agent-0", "agent-1"])
    r.backends.set(agent, {
      close: async () => {},
      closeSocialSessions: async () => {},
      runSocial: async (params) => {
        const input = inputState(params.prompt);
        if (phase === "save") {
          assert.equal(agent, "agent-0");
          await params.beforeInput();
          await params.onRunStarted();
          const page = await params.callTool("home_visit_read", {
            visitId: visit.id,
            cursor: input.state.nextCursor,
            limit: 20,
          });
          assert.ok(
            page.messages.some(
              (message) => message.messageId === sourceIds[24],
            ),
          );
          const [send, yieldTurn] = windowReply(f, params.binding);
          await params.callTool(...send);
          await params.callTool(yieldTurn[0], {
            ...yieldTurn[1],
            handoff: {
              pendingTopics: [
                { text: topic, sourceMessageIds: [sourceIds[24]] },
              ],
              agreements: [],
            },
          });
          return;
        }
        if (agent === "agent-0") {
          if (input.continuation) continued = input;
          else fresh = input;
        }
        await handoffReply(f, params);
      },
    });
  await f.pump();
  closeTestWindow(f, first.windowId);
  await settle(r);
  phase = "resume";
  await agreeWindow(f, visit, 6);
  for (let i = 0; i < 3; i++) await f.pump();
  assert.equal(fresh.continuation, false);
  assert.equal(fresh.handoff.pendingTopics[0].text, topic);
  assert.ok(
    fresh.handoff.references.some(
      (reference) => reference.messageId === sourceIds[24],
    ),
  );
  assert.deepEqual(
    fresh.state.messages.map((message) => message.sequence),
    Array.from({ length: 20 }, (_, i) => i + 1),
  );
  assert.ok(fresh.state.nextCursor);
  assert.equal(continued.continuation, true);
  assert.equal(Object.hasOwn(continued, "handoff"), false);
  assert.ok(
    continued.state.messages.some((message) => message.sequence === 21),
  );
  assert.ok(
    continued.state.messages.some((message) => message.sequence === 25),
  );
});

test("restart interrupts the old window while new authorization restores the visit handoff", async (t) => {
  const f = setup(t),
    r = f.runtime,
    db = f.store.db;
  const { visit, windowId } = await turnOnlyWindow(f, 6);
  const topic = "Synthetic durable unfinished topic after restart";
  const inputs = [];
  let saved = false;
  for (const agent of ["agent-0", "agent-1"])
    r.backends.set(agent, {
      close: async () => {},
      closeSocialSessions: async () => {},
      runSocial: async (params) => {
        const input = inputState(params.prompt);
        inputs.push({ binding: params.binding, input });
        if (!params.binding.windowId) {
          await params.beforeInput();
          await params.onRunStarted();
          return;
        }
        await handoffReply(
          f,
          params,
          !saved && agent === "agent-0"
            ? (messageId) => ({
                pendingTopics: [{ text: topic, sourceMessageIds: [messageId] }],
                agreements: [],
              })
            : undefined,
        );
        saved = true;
      },
    });
  await f.pump();
  assert.equal(inputs.length, 1);
  assert.deepEqual(r.initializeRuntime(), { initialized: true });
  await f.pump();
  assert.equal(inputs.length, 1, "restart must not replay the old actor run");
  assert.equal(
    db
      .prepare("SELECT status FROM home_social_windows WHERE id=?")
      .get(windowId).status,
    "interrupted",
  );
  await f.process("agent-0", { kind: "visit", id: visit.id });
  await f.pump();
  const async = inputs.at(-1);
  assert.equal(async.binding.runMode, "async");
  assert.equal(async.input.continuation, false);
  assert.equal(async.input.handoff.pendingTopics[0].text, topic);
  const next = await agreeWindow(f, visit, 4);
  await f.pump();
  const restarted = inputs.at(-1);
  assert.notEqual(next.windowId, windowId);
  assert.equal(restarted.binding.windowId, next.windowId);
  assert.equal(restarted.input.continuation, false);
  assert.equal(restarted.input.handoff.pendingTopics[0].text, topic);
  assert.equal(
    inputs.filter((item) => item.binding.windowId === windowId).length,
    1,
  );
});

for (const removal of ["retracted_at", "hidden_at"])
  for (const timing of ["before", "after"])
    test(`rebuilt handoff source ${removal} changes ${timing} input delivery`, async (t) => {
      const f = setup(t),
        r = f.runtime,
        db = f.store.db;
      const { visit, windowId } = await turnOnlyWindow(f, 6);
      let sourceId;
      r.backends.set("agent-0", {
        close: async () => {},
        closeSocialSessions: async () => {},
        runSocial: async (params) => {
          sourceId = await handoffReply(f, params, (messageId) => ({
            pendingTopics: [
              {
                text: "Synthetic leased handoff topic",
                sourceMessageIds: [messageId],
              },
            ],
            agreements: [],
          }));
        },
      });
      f.setScript((_agent, binding) => windowReply(f, binding));
      await f.pump();
      await f.pump();
      let entered = 0,
        started = 0,
        denied = false,
        sent = false,
        yielded = false;
      r.backends.set("agent-0", {
        close: async () => {},
        closeSocialSessions: async () => {},
        runSocial: async (params) => {
          entered++;
          const input = inputState(params.prompt);
          assert.equal(input.continuation, false);
          assert.equal(input.handoff.references[0].messageId, sourceId);
          const remove = () =>
            db
              .prepare(
                `UPDATE home_social_messages SET ${removal}=?,revision=revision+1 WHERE id=?`,
              )
              .run(r.now(), sourceId);
          if (timing === "before") remove();
          try {
            await params.beforeInput();
          } catch (error) {
            denied = true;
            throw error;
          }
          await params.onRunStarted();
          started++;
          if (timing === "after") remove();
          const [send, yieldTurn] = windowReply(
            f,
            params.binding,
            "Synthetic reply after delivered handoff",
          );
          const receipt = await params.callTool(...send);
          sent = receipt.status === "committed";
          const batch = await params.callTool(...yieldTurn);
          yielded = batch.status === "committed";
        },
      });
      await f.pump();
      const window = db
        .prepare("SELECT * FROM home_social_windows WHERE id=?")
        .get(windowId);
      assert.equal(entered, 1);
      assert.equal(started, timing === "after" ? 1 : 0);
      assert.equal(denied, timing === "before");
      assert.equal(sent, timing === "after");
      assert.equal(yielded, timing === "after");
      assert.equal(window.status, timing === "after" ? "active" : "closed");
      assert.equal(window.turns_used, timing === "after" ? 3 : 2);
      assert.equal(
        db
          .prepare(
            "SELECT count(*) n FROM home_social_messages WHERE visit_id=?",
          )
          .get(visit.id).n,
        timing === "after" ? 3 : 2,
      );
    });

test("failed old-session cleanup blocks adapter rebuild without charging another actor run", async (t) => {
  const f = setup(t),
    r = f.runtime,
    db = f.store.db;
  const { windowId } = await turnOnlyWindow(f, 6);
  f.setScript((_agent, binding) => windowReply(f, binding));
  await f.pump();
  await f.pump();
  const old = r.backendConnections.adapter(r.agent("agent-0"));
  let cleanupAttempts = 0,
    calls = 0;
  old.closeSocialSessions = async () => {
    cleanupAttempts++;
    throw Error("SOCIAL_CONTEXT_FINALIZATION_FAILED");
  };
  r.backends.set("agent-0", {
    close: async () => {},
    closeSocialSessions: async () => {},
    runSocial: async () => {
      calls++;
    },
  });
  await f.pump();
  const window = db
    .prepare("SELECT * FROM home_social_windows WHERE id=?")
    .get(windowId);
  assert.ok(cleanupAttempts > 0);
  assert.equal(calls, 0);
  assert.equal(window.status, "closed");
  assert.equal(window.turns_used, 2);
  assert.equal(window.turns_reserved, 0);
  assert.equal(
    db
      .prepare(
        "SELECT count(*) n FROM home_social_dispatches WHERE window_id=? AND status='queued'",
      )
      .get(windowId).n,
    0,
  );
});
