import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture, config, raw, context } from "./helpers.mjs";
import { GameHost } from "../src/games/framework/host.mjs";
import { secret, digest } from "../src/games/core/value.mjs";
import { registerChoiceProbe } from "../src/games/fixtures/choice-probe.mjs";
import { createGameHttp } from "../src/games/core/http.mjs";
import { renderGame } from "../src/games/framework/page.mjs";
import { buildChildEnv } from "../src/core/child-env.mjs";

function setup(t, run = async () => {}) {
  const cfg = config(1);
  cfg.games.enabled = true;
  cfg.agents[0].games.enabled = true;
  const f = fixture(t, { cfg, run });
  f.runtime.games = new GameHost(f.runtime, { launch: false });
  const h = f.runtime.games;
  h.ensure();
  return { ...f, h, k: h.kernel };
}
async function create(f, conversation = "private:30000") {
  const mem = f.store.bind("agent-0");
  const event = mem.append({
    kind: "message.received",
    conversation,
    senderId: "30000",
    direction: "in",
    body: "下五子棋",
    observedAt: f.runtime.now(),
    payload: { trustedInput: true },
    dedupe: randomUUID(),
  });
  const ctx = context(f.runtime, "agent-0", conversation),
    args = {
      eventId: event.id,
      requestId: randomUUID(),
      gameType: "gomoku",
      options: {},
    };
  const result = await f.h.create(ctx, args);
  return { ...result, ctx, args };
}
function join(f, roomId) {
  const room = f.k.store.room(roomId),
    actor = f.k.actor(room.owner),
    inv = f.h.identity.invite(
      roomId,
      actor,
      room.participants[0].participantId,
    ),
    browser = secret();
  const proof = f.h.identity.request(
    roomId,
    inv.bindingId,
    inv.invite,
    browser,
  );
  f.h.identity.confirm(roomId, inv.bindingId, proof.challenge, actor);
  return f.h.identity.exchange(roomId, inv.bindingId, browser).session;
}
function act(f, roomId, type, payload = {}) {
  const room = f.k.store.room(roomId);
  return f.k.act(roomId, f.k.actor(room.owner), {
    actionId: randomUUID(),
    expectedRevision: room.revision,
    action: { type, payload },
  });
}
async function decision(f) {
  const result = await create(f);
  join(f, result.roomId);
  act(f, result.roomId, "room.start");
  act(f, result.roomId, "game.place", { x: 7, y: 7 });
  return { ...result, id: f.k.store.room(result.roomId).decision.decisionId };
}

test("QQ invitations derive sender, redact the URL and never resend an ambiguous delivery", async (t) => {
  const f = setup(t);
  f.runtime.transports.get("qq-0").failure = "UNCONFIRMED";
  const result = await create(f);
  assert.equal(result.delivery, "unknown");
  assert.equal((await f.h.create(result.ctx, result.args)).delivery, "unknown");
  const sent = f.runtime.transports.get("qq-0").sent;
  assert.equal(sent.length, 1);
  assert.equal(JSON.stringify(result).includes("invite="), false);
  const rows = f.store.db.prepare("SELECT body,payload FROM events").all();
  assert.equal(JSON.stringify(rows).includes("invite="), false);
  await assert.rejects(
    f.h.create(result.ctx, { ...result.args, eventId: randomUUID() }),
    /GAME_REQUEST_REQUIRED/,
  );
  const other = context(f.runtime, "agent-0", "group:20000");
  assert.throws(() => f.h.view(other, result), /ROOM_UNAVAILABLE/);
});

test("group join requires the exact QQ sender and source; confirmation secrets are absent from memory", async (t) => {
  const f = setup(t),
    { roomId } = await create(f, "group:20000"),
    browser = secret(),
    proof = f.h.identity.requestPublic(roomId, browser);
  const body = `确认游戏 ${roomId} ${proof.bindingId} ${proof.challenge}`;
  const message = (id, user_id, group_id = 20000) =>
    raw(id, {
      user_id,
      group_id,
      message: [{ type: "text", data: { text: body } }],
    });
  await f.runtime.ingestEvent("qq-0", message(1, 30001));
  assert.throws(
    () => f.h.identity.exchange(roomId, proof.bindingId, browser),
    /JOIN_UNCONFIRMED/,
  );
  await f.runtime.ingestEvent("qq-0", message(2, 30000, 20001));
  assert.throws(
    () => f.h.identity.exchange(roomId, proof.bindingId, browser),
    /JOIN_UNCONFIRMED/,
  );
  await f.runtime.ingestEvent("qq-0", message(3, 30000));
  const session = f.h.identity.exchange(
    roomId,
    proof.bindingId,
    browser,
  ).session;
  assert.equal(
    f.k.view(roomId, f.h.identity.session(roomId, session)).owner,
    true,
  );
  assert.equal(
    JSON.stringify(
      f.store.db.prepare("SELECT body,payload FROM events").all(),
    ).includes(proof.challenge),
    false,
  );
});

test("AI is isolated from chat state, gets only game tools, and commits a fenced move", async (t) => {
  let calls = 0,
    seen;
  const f = setup(t, async (p) => {
    calls++;
    seen = p;
    const data = JSON.parse(p.prompt);
    assert.equal(p.session, null);
    assert.equal(p.game, true);
    assert.equal(p.prompt.includes("CHAT_SECRET"), false);
    assert.equal(p.instructions.includes("SELF_SECRET"), false);
    assert.deepEqual(
      p.tools.map((x) => x.name),
      ["game_view", "game_act"],
    );
    await assert.rejects(p.callTool("memory_read", {}), /TOOL_DISABLED/);
    p.saveSession({ backend: "codex", id: "native-game", signature: "test" });
    p.onInputSubmitted();
    p.onBackendTurn({ turnId: "native-turn" });
    await p.callTool("game_act", {
      roomId: data.scope.roomId,
      actionId: data.actionId,
      expectedRevision: data.snapshot.revision,
      action: { type: "game.place", payload: { x: 8, y: 7 } },
    });
  });
  f.runtime.agent("agent-0").persona = "SELF_SECRET";
  f.store.bind("agent-0").setState("private:30000", {
    session: { backend: "codex", id: "CHAT_SECRET" },
  });
  const { roomId, id } = await decision(f);
  f.h.jobs.receive(id);
  await f.h.worker.run(id);
  assert.equal(calls, 1);
  assert.ok(seen);
  assert.equal(f.k.store.room(roomId).state.board[7 * 15 + 8], 2);
  assert.equal(f.h.jobs.get(id).status, "completed");
  assert.equal(
    f.store.bind("agent-0").state("private:30000").session.id,
    "CHAT_SECRET",
  );
  assert.equal(
    f.store.db.prepare("SELECT count(*) AS n FROM model_turns").get().n,
    0,
  );
  assert.equal(f.runtime.running.size, 0);
});

test("expired leases cannot revive, and unresolved native runs block newer decisions", async (t) => {
  const f = setup(t),
    { roomId, id } = await decision(f);
  f.h.jobs.receive(id);
  const run = f.h.jobs.claim(id, "worker", "claim");
  assert.deepEqual(f.h.jobs.claim(id, "worker", "claim"), run);
  const job = f.h.jobs.get(id);
  job.run.leaseUntil = f.runtime.now() - 1;
  f.h.jobs.save(job);
  assert.throws(() => f.h.jobs.renew(run), /GAME_LEASE_LOST/);
  const room = f.k.store.room(roomId),
    actor = f.k.actor("agent:agent-0");
  assert.throws(
    () =>
      f.k.act(
        roomId,
        actor,
        {
          actionId: randomUUID(),
          expectedRevision: room.revision,
          action: { type: "game.place", payload: { x: 8, y: 7 } },
        },
        run,
      ),
    /GAME_EXECUTION_STALE/,
  );
  f.h.jobs.recover();
  assert.equal(f.h.jobs.get(id).status, "outcome_unknown");
  act(f, roomId, "room.pause");
  act(f, roomId, "room.resume");
  const next = f.k.store.room(roomId).decision.decisionId;
  f.h.jobs.receive(next);
  assert.equal(f.h.jobs.claim(next, "worker", "new-claim"), null);
  assert.equal(f.h.jobs.get(next).reason, "GAME_OUTCOME_UNKNOWN");
  await assert.rejects(f.h.retry(id), /GAME_OUTCOME_UNKNOWN/);
});

test("pause, disconnect, unsupported backend and finite budgets gate AI attempts", async (t) => {
  const f = setup(t),
    { id } = await decision(f);
  f.h.jobs.receive(id);
  f.runtime.config.globalPaused = true;
  assert.equal(f.h.jobs.claim(id, "w", "1"), null);
  assert.equal(f.h.jobs.get(id).reason, "GLOBAL_PAUSED");
  f.runtime.config.globalPaused = false;
  f.runtime.transports.get("qq-0").connected = false;
  assert.equal(f.h.jobs.claim(id, "w", "2"), null);
  assert.equal(f.h.jobs.get(id).reason, "QQ_NOT_CONNECTED");
  f.runtime.transports.get("qq-0").connected = true;
  f.runtime.config.backends[0].type = "dsh";
  assert.equal(f.h.jobs.claim(id, "w", "3"), null);
  assert.equal(f.h.jobs.get(id).reason, "GAME_BACKEND_UNSUPPORTED");
  f.runtime.config.backends[0].type = "codex";
  f.h.jobs.limits.totalAttempts = 1;
  const run = f.h.jobs.claim(id, "w", "4");
  f.h.jobs.settle(run, { terminal: true });
  assert.throws(() => f.h.jobs.claim(id, "w", "5"), /GAME_BUDGET_EXHAUSTED/);
  assert.equal(
    f.k.store.db
      .prepare("SELECT attempts FROM game_budgets WHERE scope='framework'")
      .get().attempts,
    1,
  );
});

test("close retries retain the first version instead of silently closing a newer state", async (t) => {
  const f = setup(t),
    result = await create(f);
  join(f, result.roomId);
  const original = f.k.act.bind(f.k);
  f.k.act = () => {
    throw Error("INTERRUPTED");
  };
  const args = { roomId: result.roomId, requestId: randomUUID() };
  assert.throws(() => f.h.closeRoom(result.ctx, args), /INTERRUPTED/);
  f.k.act = original;
  act(f, result.roomId, "room.start");
  assert.throws(() => f.h.closeRoom(result.ctx, args), /REVISION_CONFLICT/);
  assert.equal(f.k.store.room(result.roomId).lifecycle, "active");
});

test("non-board hidden-choice module uses the same worker without opponent choices", async (t) => {
  const f = setup(t, async (p) => {
    const data = JSON.parse(p.prompt);
    assert.deepEqual(data.snapshot.view, {
      ownChoice: null,
      revealed: null,
      canChoose: true,
      result: null,
    });
    await p.callTool("game_act", {
      roomId: data.scope.roomId,
      actionId: data.actionId,
      expectedRevision: data.snapshot.revision,
      action: { type: "game.choose", payload: { symbol: "moon" } },
    });
  });
  registerChoiceProbe(f.k.registry);
  const owner = f.k.actor("human"),
    { roomId } = f.k.createRoom(owner, {
      requestId: randomUUID(),
      gameType: "choice-probe",
      moduleVersion: "1",
      options: {},
      participants: [
        { principalId: "human", kind: "human", label: "player" },
        {
          principalId: "agent:agent-0",
          kind: "ai",
          agentId: "agent-0",
          label: "AI",
        },
      ],
    });
  f.k.store.db.prepare("INSERT INTO game_host_rooms VALUES(?,?)").run(
    roomId,
    JSON.stringify({
      agentId: "agent-0",
      connectionId: "qq-0",
      conversation: "private:30000",
      senderId: "30000",
      group: false,
      access: true,
      accessUntil: f.runtime.now() + 3000,
    }),
  );
  f.h.identity.confirmAgent(roomId, f.k.actor("agent:agent-0"), "agent-0");
  join(f, roomId);
  act(f, roomId, "room.start");
  act(f, roomId, "game.choose", { symbol: "sun" });
  const id = f.k.store.room(roomId).decision.decisionId;
  f.h.jobs.receive(id);
  await f.h.worker.run(id);
  assert.equal(f.k.store.room(roomId).lifecycle, "finished");
  assert.equal(f.k.store.room(roomId).outcome.kind, "loss");
});

test("public HTTP keeps HTTPS, exact Origin and management separation", async (t) => {
  const f = setup(t),
    { roomId } = await create(f, "group:20000");
  const server = createGameHttp({
    kernel: f.k,
    identity: f.h.identity,
    assets: new Map(),
    render: renderGame,
    publicOrigin: "https://games.example.test",
    publicJoin: true,
  });
  const address = await server.listen(0);
  t.after(() => server.close());
  // The configured public origin is intentionally not resolved; exercise the loopback proxy boundary.
  const port = address.port;
  const url = `http://127.0.0.1:${port}`;
  assert.equal(address.origin, "https://games.example.test");
  const request = (route, headers, body) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        url + route,
        {
          method: body ? "POST" : "GET",
          headers: { host: "games.example.test", ...headers },
        },
        (res) => {
          res.resume();
          res.on("end", () =>
            resolve({
              status: res.statusCode,
              headers: { get: (name) => String(res.headers[name] || "") },
            }),
          );
        },
      );
      req.on("error", reject);
      req.end(body ? JSON.stringify(body) : undefined);
    });
  assert.equal((await request("/health", {})).status, 403);
  assert.equal(
    (await request("/api/config", { "x-forwarded-proto": "https" })).status,
    404,
  );
  assert.equal(
    (
      await request(
        `/rooms/${roomId}/join`,
        {
          "x-forwarded-proto": "https",
          "content-type": "application/json",
          origin: "https://evil.example.test",
        },
        { start: true },
      )
    ).status,
    403,
  );
  const joined = await request(
    `/rooms/${roomId}/join`,
    {
      "x-forwarded-proto": "https",
      "content-type": "application/json",
      origin: "https://games.example.test",
    },
    { start: true },
  );
  assert.equal(joined.status, 200);
  assert.match(
    joined.headers.get("set-cookie"),
    /HttpOnly.*SameSite=Strict.*Secure/,
  );
  assert.equal(
    buildChildEnv(
      "game-service",
      {},
      {
        parent: {
          PATH: "test",
          QQ_TOKEN: "secret",
          OPENAI_API_KEY: "secret",
          HTTPS_PROXY: "secret",
        },
      },
    ).QQ_TOKEN,
    undefined,
  );
});

test("outbox attempts survive lost acknowledgements and the inbox deduplicates registration", async (t) => {
  const f = setup(t),
    { id } = await decision(f);
  let now = f.runtime.now();
  f.k.clock = () => now;
  for (let i = 0; i < 6; i++) {
    await f.h.jobs.dispatch(
      async (jobId) => {
        f.h.jobs.receive(jobId);
        throw Error("ACK_LOST");
      },
      () => 0.5,
    );
    now += 40000;
  }
  assert.equal(
    f.k.store.db.prepare("SELECT attempts FROM game_outbox WHERE id=?").get(id)
      .attempts,
    6,
  );
  assert.equal(
    f.k.store.db
      .prepare("SELECT count(*) AS n FROM game_inbox WHERE id=?")
      .get(id).n,
    1,
  );
  f.h.jobs.recover();
  await f.h.jobs.dispatch(async () => {
    throw Error("MUST_NOT_REDELIVER");
  });
  assert.equal(f.h.jobs.get(id).status, "delivery_failed");
});

test("decision enqueue failure rolls back the move, revision, receipt and outbox together", async (t) => {
  const f = setup(t),
    { roomId } = await create(f);
  join(f, roomId);
  act(f, roomId, "room.start");
  const before = f.k.store.room(roomId);
  f.h.jobs.enqueue = () => {
    throw Error("WRITE_FAILED");
  };
  assert.throws(
    () => act(f, roomId, "game.place", { x: 7, y: 7 }),
    /GAME_STORAGE_FAILURE/,
  );
  assert.deepEqual(f.k.store.room(roomId), before);
  assert.equal(
    f.k.store.db.prepare("SELECT count(*) AS n FROM game_outbox").get().n,
    0,
  );
});

test("maintenance drains an already running game, then forbids new game work", async (t) => {
  const started = Promise.withResolvers(),
    release = Promise.withResolvers();
  const f = setup(t, async (p) => {
    started.resolve(p);
    await release.promise;
    const data = JSON.parse(p.prompt);
    await p.callTool("game_act", {
      roomId: data.scope.roomId,
      actionId: data.actionId,
      expectedRevision: data.snapshot.revision,
      action: { type: "game.place", payload: { x: 8, y: 7 } },
    });
  });
  const { id } = await decision(f);
  f.h.jobs.receive(id);
  const run = f.h.worker.run(id);
  await started.promise;
  const drain = f.runtime.maintenance.begin();
  assert.equal(drain.pending, 1);
  release.resolve();
  await run;
  await f.runtime.maintenance.wait();
  assert.equal(f.h.jobs.get(id).status, "completed");
  assert.equal(f.runtime.maintenance.snapshot().pending, 0);
});

test("source pause rejects late AI writes and terminal failure retains reserved usage", async (t) => {
  const f = setup(t, async (p) => {
    f.runtime.config.globalPaused = true;
    const data = JSON.parse(p.prompt);
    await assert.rejects(
      p.callTool("game_act", {
        roomId: data.scope.roomId,
        actionId: data.actionId,
        expectedRevision: data.snapshot.revision,
        action: { type: "game.place", payload: { x: 8, y: 7 } },
      }),
      /GLOBAL_PAUSED/,
    );
  });
  const { roomId, id } = await decision(f);
  f.h.jobs.receive(id);
  await f.h.worker.run(id);
  assert.equal(f.k.store.room(roomId).state.board.filter(Boolean).length, 1);
  assert.equal(f.h.jobs.get(id).status, "model_failed");
  assert.equal(
    f.k.store.db
      .prepare("SELECT tokens FROM game_budgets WHERE scope='framework'")
      .get().tokens,
    f.h.policy.reservedTokensPerAttempt,
  );
});

test("same browser can recover a lost join response; a second browser cannot reuse the invite", async (t) => {
  const f = setup(t),
    { roomId } = await create(f),
    room = f.k.store.room(roomId),
    actor = f.k.actor(room.owner),
    browser = secret();
  const invite = f.h.identity.invite(
    roomId,
    actor,
    room.participants[0].participantId,
  );
  f.h.identity.request(roomId, invite.bindingId, invite.invite, browser);
  assert.throws(
    () =>
      f.h.identity.request(roomId, invite.bindingId, invite.invite, secret()),
    /INVITATION_UNAVAILABLE/,
  );
  const recovered = f.h.identity.request(
    roomId,
    invite.bindingId,
    invite.invite,
    browser,
  );
  f.h.identity.confirm(roomId, invite.bindingId, recovered.challenge, actor);
  assert.ok(f.h.identity.exchange(roomId, invite.bindingId, browser).session);
});

test("external verification is tied to the current entry boot and never inferred from local health", (t) => {
  const f = setup(t);
  f.runtime.config.games.publicOrigin = "https://games.example.test";
  f.h.settings = JSON.stringify(f.h.policy);
  f.k.store.db.prepare("INSERT INTO game_entry VALUES(1,?)").run(
    JSON.stringify({
      boot: secret(),
      challenge: "known-test-challenge",
      verified: false,
      publicOrigin: f.h.policy.publicOrigin,
    }),
  );
  assert.equal(f.h.status().externallyVerified, false);
  assert.throws(
    () => f.h.verifyEntry("wrong", true),
    /EXTERNAL_VERIFICATION_REQUIRED/,
  );
  assert.throws(
    () => f.h.verifyEntry("known-test-challenge", false),
    /EXTERNAL_VERIFICATION_REQUIRED/,
  );
  assert.equal(f.h.verifyEntry("known-test-challenge", true).verified, true);
  f.runtime.config.games.publicOrigin = "https://replacement.example.test";
  assert.equal(f.h.status().ready, false);
  assert.equal(f.h.status().externallyVerified, false);
  f.h.settings = JSON.stringify(f.h.policy);
  assert.equal(f.h.status().externallyVerified, false);

  f.k.store.db.prepare("UPDATE game_entry SET data=?").run(
    JSON.stringify({
      boot: secret(),
      challenge: secret(),
      verified: false,
      publicOrigin: f.h.policy.publicOrigin,
    }),
  );
  assert.equal(f.h.status().externallyVerified, false);
});

test("private QQ confirmation binds the private source without granting another browser", async (t) => {
  const f = setup(t),
    { roomId } = await create(f),
    room = f.k.store.room(roomId),
    actor = f.k.actor(room.owner),
    browser = secret();
  const invite = f.h.identity.invite(
      roomId,
      actor,
      room.participants[0].participantId,
    ),
    proof = f.h.identity.request(
      roomId,
      invite.bindingId,
      invite.invite,
      browser,
    );
  await f.runtime.ingestEvent(
    "qq-0",
    raw(1, {
      message_type: "private",
      group_id: undefined,
      message: [
        {
          type: "text",
          data: {
            text: `确认游戏 ${roomId} ${invite.bindingId} ${proof.challenge}`,
          },
        },
      ],
    }),
  );
  assert.throws(
    () => f.h.identity.exchange(roomId, invite.bindingId, secret()),
    /JOIN_UNCONFIRMED/,
  );
  assert.ok(f.h.identity.exchange(roomId, invite.bindingId, browser).session);
});

test("separate game process starts with only game routes and stops on bridge close", async (t) => {
  const f = setup(t);
  await f.h.close();
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  f.runtime.config.games.port = port;
  const host = (f.runtime.games = new GameHost(f.runtime));
  host.ensure();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("CHILD_START_TIMEOUT")), 10000);
    host.child.once("message", () => {
      clearTimeout(timer);
      resolve();
    });
    host.child.once("error", reject);
  });
  assert.equal(host.ready, true);
  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.equal(health.service, "qq-agents-games");
  assert.equal(health.challenge.length, 43);
  assert.equal(
    (await fetch(`http://127.0.0.1:${port}/api/config`)).status,
    404,
  );
  assert.equal(
    (await fetch(`http://127.0.0.1:${port}/rooms/${randomUUID()}`)).status,
    403,
  );
  await host.close();
  assert.equal(host.ready, false);
  assert.notEqual(host.child.exitCode, null);
});

test("chat wakes remain queued while a game owns the backend", (t) => {
  const f = setup(t),
    mem = f.store.bind("agent-0");
  f.h.worker.active.set("busy", {
    agentId: "agent-0",
    backendId: "fixture",
    controller: new AbortController(),
  });
  try {
    mem.setState("private:30000", {
      pendingWakes: [{ reason: "private", at: f.runtime.now() }],
      wakeDueAt: f.runtime.now(),
    });
    assert.deepEqual(
      f.runtime.conversations.flush("agent-0", "private:30000"),
      { queued: true },
    );
    assert.equal(mem.state("private:30000").pendingWakes.length, 1);
  } finally {
    f.h.worker.active.delete("busy");
  }
});

test("reopening the game database preserves unknown native runs, budgets and outbox attempts", async (t) => {
  const f = setup(t),
    { roomId, id } = await decision(f);
  f.h.jobs.receive(id);
  const run = f.h.jobs.claim(id, "worker", "original");
  f.h.jobs.observe(run, {
    session: { backend: "codex", id: "native-thread" },
    backendTurn: "native-turn",
    submitted: true,
  });
  f.k.store.db.prepare("UPDATE game_outbox SET attempts=4 WHERE id=?").run(id);
  await f.h.close();
  const restored = (f.runtime.games = new GameHost(f.runtime, {
    launch: false,
  }));
  restored.ensure();
  assert.equal(restored.jobs.get(id).status, "outcome_unknown");
  assert.equal(restored.jobs.get(id).run.backendTurn, "native-turn");
  assert.equal(
    restored.kernel.store.db
      .prepare("SELECT attempts FROM game_outbox WHERE id=?")
      .get(id).attempts,
    4,
  );
  assert.equal(
    restored.kernel.store.db
      .prepare("SELECT attempts FROM game_budgets WHERE scope='framework'")
      .get().attempts,
    1,
  );
  const room = restored.kernel.store.room(roomId);
  room.lifecycle = "expired";
  room.deleteAt = restored.kernel.clock() - 1;
  restored.kernel.store.save(room);
  restored.kernel.sweep();
  assert.equal(restored.kernel.store.room(roomId).id, roomId);
});

test("an administrator cannot replace a locally finishing worker before its cleanup", async (t) => {
  const started = Promise.withResolvers(),
    release = Promise.withResolvers();
  const f = setup(t, async () => {
    started.resolve();
    await release.promise;
  });
  const { id } = await decision(f);
  f.h.jobs.receive(id);
  const pending = f.h.worker.run(id);
  await started.promise;
  try {
    await assert.rejects(f.h.retry(id), /GAME_BACKEND_BUSY/);
    assert.equal(f.h.jobs.get(id).fence, 1);
  } finally {
    release.resolve();
    await pending;
  }
  assert.equal(f.runtime.running.size, 0);
  assert.equal(f.h.worker.active.size, 0);
});

test("retrying an older claim returns its original fence and never replaces the current attempt", async (t) => {
  const f = setup(t),
    { id } = await decision(f);
  f.h.jobs.receive(id);
  const first = f.h.jobs.claim(id, "worker", "claim-1");
  f.h.jobs.settle(first, { terminal: true });
  const second = f.h.jobs.claim(id, "worker", "claim-2");
  const replay = f.h.jobs.claim(id, "worker", "claim-1");
  assert.equal(replay.runId, first.runId);
  assert.equal(replay.fencingToken, first.fencingToken);
  assert.equal(f.h.jobs.get(id).run.runId, second.runId);
  assert.equal(second.fencingToken, 2);
  assert.throws(() => f.h.jobs.renew(first), /GAME_EXECUTION_STALE/);
  f.h.jobs.settle(second, { terminal: true });
});

test("private invitation tokens survive the unified sender Markdown conversion", async (t) => {
  const f = setup(t),
    token = "a".repeat(10) + "__abc__" + "b".repeat(26),
    original = f.h.identity.invite.bind(f.h.identity);
  f.h.identity.invite = (...args) => {
    const invitation = original(...args),
      row = f.k.store.db
        .prepare("SELECT data FROM game_bindings WHERE id=?")
        .get(invitation.bindingId),
      data = JSON.parse(row.data);
    data.tokenHash = digest(token);
    f.k.store.db
      .prepare("UPDATE game_bindings SET data=? WHERE id=?")
      .run(JSON.stringify(data), invitation.bindingId);
    return { ...invitation, invite: token };
  };
  const result = await create(f);
  assert.equal(result.delivery, "sent");
  const text = f.runtime.transports
    .get("qq-0")
    .sent[0].segments.map((s) => s.data.text || "")
    .join("");
  const link = new URL(text.match(/http:\/\/[^\s]+/)[0]);
  assert.equal(link.searchParams.get("invite"), token);
  assert.ok(text.includes("%5F%5Fabc%5F%5F"));
  assert.ok(
    f.h.identity.request(
      result.roomId,
      link.searchParams.get("binding"),
      link.searchParams.get("invite"),
      secret(),
    ).challenge,
  );
});

function rejoinEvent(
  f,
  roomId,
  {
    senderId = "30000",
    conversation = "private:30000",
    body = `重新加入游戏 ${roomId}`,
  } = {},
) {
  return f.store.bind("agent-0").append({
    kind: "message.received",
    conversation,
    senderId,
    direction: "in",
    body,
    observedAt: f.runtime.now(),
    payload: { trustedInput: true },
    dedupe: randomUUID(),
  });
}

test("re-entry retains the same seat and game, revokes old invitations and rotates the browser on exchange", async (t) => {
  const f = setup(t),
    result = await create(f),
    session = join(f, result.roomId);
  act(f, result.roomId, "room.start");
  const before = f.k.store.room(result.roomId),
    old = f.h.identity.invite(
      result.roomId,
      f.k.actor(before.owner),
      before.participants[0].participantId,
    );
  const event = rejoinEvent(f, result.roomId),
    args = { roomId: result.roomId, eventId: event.id };
  const rejoined = await f.h.rejoin(result.ctx, args);
  assert.equal(rejoined.roomId, result.roomId);
  assert.deepEqual(f.k.store.room(result.roomId), before);
  assert.throws(
    () => f.h.identity.load(result.roomId, old.bindingId),
    /INVITATION_UNAVAILABLE/,
  );
  assert.ok(f.h.identity.session(result.roomId, session));
  const sent = f.runtime.transports.get("qq-0").sent;
  const invitation = new URL(
    sent
      .at(-1)
      .segments.find((s) => s.type === "text")
      .data.text.match(/https?:\/\/\S+/)[0],
  );
  const binding = invitation.searchParams.get("binding"),
    token = invitation.searchParams.get("invite"),
    browser = secret();
  const proof = f.h.identity.request(result.roomId, binding, token, browser);
  f.h.identity.confirm(
    result.roomId,
    binding,
    proof.challenge,
    f.k.actor(before.owner),
  );
  assert.ok(f.h.identity.exchange(result.roomId, binding, browser).session);
  assert.throws(() => f.h.identity.session(result.roomId, session));
  const count = sent.length;
  assert.deepEqual(await f.h.rejoin(result.ctx, args), rejoined);
  assert.equal(sent.length, count);
});

test("re-entry rejects other senders, stale events, wrong rooms, changed origins and closed games", async (t) => {
  const f = setup(t),
    result = await create(f),
    roomId = result.roomId;
  const event = rejoinEvent(f, roomId, { senderId: "30001" });
  await assert.rejects(
    f.h.rejoin(result.ctx, { roomId, eventId: event.id }),
    /ROOM_UNAVAILABLE/,
  );
  const mismatch = rejoinEvent(f, randomUUID());
  await assert.rejects(
    f.h.rejoin(result.ctx, { roomId, eventId: mismatch.id }),
    /GAME_REQUEST_REQUIRED/,
  );
  const old = rejoinEvent(f, roomId);
  f.store.db
    .prepare("UPDATE events SET observed_at=? WHERE id=?")
    .run(f.runtime.now() - 600001, old.id);
  await assert.rejects(
    f.h.rejoin(result.ctx, { roomId, eventId: old.id }),
    /GAME_REQUEST_EXPIRED/,
  );
  const good = rejoinEvent(f, roomId),
    args = { roomId, eventId: good.id };
  f.runtime.config.games.publicOrigin = "https://new.example.test";
  assert.equal(f.h.status().ready, false);
  assert.equal(f.h.status().externallyVerified, false);
  await assert.rejects(
    f.h.rejoin(result.ctx, args),
    /GAME_SERVICE_UNAVAILABLE/,
  );
  f.h.settings = JSON.stringify(f.h.policy);
  await assert.rejects(
    f.h.rejoin(result.ctx, args),
    /EXTERNAL_VERIFICATION_REQUIRED/,
  );
  f.k.store.db
    .prepare("INSERT INTO game_entry VALUES(1,?)")
    .run(
      JSON.stringify({ publicOrigin: f.h.policy.publicOrigin, verified: true }),
    );
  assert.equal((await f.h.rejoin(result.ctx, args)).delivery, "sent");
  act(f, roomId, "room.close");
  const closed = rejoinEvent(f, roomId);
  await assert.rejects(
    f.h.rejoin(result.ctx, { roomId, eventId: closed.id }),
    /ROOM_CLOSED/,
  );
});

test("QQ re-entry command uses the source event once and never invokes the chat model", async (t) => {
  let calls = 0;
  const f = setup(t, async () => {
      calls++;
    }),
    result = await create(f);
  const message = raw(987, {
    user_id: 30000,
    group_id: undefined,
    message_type: "private",
    message: [
      { type: "text", data: { text: `重新加入游戏 ${result.roomId}` } },
    ],
  });
  await f.runtime.ingestEvent("qq-0", message);
  const sent = f.runtime.transports.get("qq-0").sent;
  assert.equal(sent.length, 2);
  assert.match(sent.at(-1).segments[0].data.text, /五子棋邀请/);
  await f.runtime.ingestEvent("qq-0", message);
  assert.equal(sent.length, 2);
  assert.equal(calls, 0);
});

test("an unknown re-entry delivery is not repeated and source account changes deny re-entry", async (t) => {
  const f = setup(t),
    result = await create(f),
    event = rejoinEvent(f, result.roomId),
    args = { roomId: result.roomId, eventId: event.id };
  const transport = f.runtime.transports.get("qq-0");
  transport.failure = "UNCONFIRMED";
  assert.equal((await f.h.rejoin(result.ctx, args)).delivery, "unknown");
  assert.equal((await f.h.rejoin(result.ctx, args)).delivery, "unknown");
  assert.equal(transport.sent.length, 2);
  f.runtime.connection("qq-0").accountId = "10002";
  await assert.rejects(f.h.rejoin(result.ctx, args), /GAMES_DISABLED/);
});

test("group re-entry accepts a trailing mention and revokes outstanding group challenges", async (t) => {
  const f = setup(t),
    result = await create(f, "group:20000"),
    old = f.h.identity.requestPublic(result.roomId, secret());
  await f.runtime.ingestEvent(
    "qq-0",
    raw(988, {
      user_id: 30000,
      group_id: 20000,
      message: [
        { type: "text", data: { text: `重新加入游戏 ${result.roomId} ` } },
        { type: "at", data: { qq: f.runtime.connection("qq-0").accountId } },
      ],
    }),
  );
  const sent = f.runtime.transports.get("qq-0").sent;
  assert.equal(sent.length, 2);
  assert.match(sent.at(-1).segments[0].data.text, /五子棋邀请/);
  assert.throws(
    () => f.h.identity.load(result.roomId, old.bindingId),
    /INVITATION_UNAVAILABLE/,
  );
  assert.ok(f.h.identity.requestPublic(result.roomId, secret()).challenge);
});
