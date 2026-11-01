import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import { GameKernel, durations } from "../src/games/core/kernel.mjs";
import { GameIdentity } from "../src/games/core/identity.mjs";
import { GameRegistry } from "../src/games/core/registry.mjs";
import { choiceProbe } from "../src/games/fixtures/choice-probe.mjs";
import { secret } from "../src/games/core/value.mjs";

function setup(t, definition = choiceProbe, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "game-core-")),
    database = path.join(dir, "game.sqlite");
  const registry = new GameRegistry();
  registry.register(definition, { test: "test-module-v1" });
  let now = 1_800_000_000_000,
    kernel = new GameKernel({ database, registry, clock: () => now, ...extra });
  t.after(() => {
    kernel.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const f = {
    database,
    registry,
    get k() {
      return kernel;
    },
    get identity() {
      return new GameIdentity(kernel);
    },
    actor: (p) => kernel.actor(p),
    advance: (ms) => {
      now += ms;
    },
    restart: () => {
      kernel.close();
      kernel = new GameKernel({
        database,
        registry,
        clock: () => now,
        ...extra,
      });
    },
    create(members = ["a", "b"]) {
      const request = {
        requestId: randomUUID(),
        gameType: definition.manifest.gameType,
        moduleVersion: definition.manifest.moduleVersion,
        options: {},
        participants: members.map((p) =>
          typeof p === "string"
            ? { principalId: p, kind: "human", label: p }
            : p,
        ),
      };
      return { ...kernel.createRoom(f.actor("a"), request), request };
    },
    join(roomId, principal) {
      const room = kernel.store.room(roomId),
        member = room.participants.find((p) => p.principalId === principal),
        identity = f.identity;
      const invitation = identity.invite(
          roomId,
          f.actor("a"),
          member.participantId,
        ),
        browser = secret();
      const { challenge } = identity.request(
        roomId,
        invitation.bindingId,
        invitation.invite,
        browser,
      );
      identity.confirm(
        roomId,
        invitation.bindingId,
        challenge,
        f.actor(principal),
      );
      return identity.exchange(roomId, invitation.bindingId, browser).session;
    },
    act(roomId, principal, type, payload = {}, request) {
      return kernel.act(
        roomId,
        f.actor(principal),
        request ?? {
          actionId: randomUUID(),
          expectedRevision: kernel.store.room(roomId).revision,
          action: { type, payload },
        },
      );
    },
    start() {
      const { roomId } = f.create();
      f.join(roomId, "a");
      f.join(roomId, "b");
      f.act(roomId, "a", "room.start");
      return roomId;
    },
  };
  return f;
}
const code = (fn, expected) => assert.throws(fn, (e) => e.message === expected);

test("choice-probe uses a persistent generic room, shared win and per-principal receipts", (t) => {
  const f = setup(t),
    roomId = f.start();
  const request = {
    actionId: randomUUID(),
    expectedRevision: 3,
    action: { type: "game.choose", payload: { symbol: "sun" } },
  };
  const receipt = f.act(roomId, "a", null, null, request);
  assert.deepEqual(f.act(roomId, "a", null, null, request), receipt);
  assert.equal(f.k.store.room(roomId).revision, 4);
  assert.deepEqual(f.k.view(roomId, f.actor("b")).view, {
    ownChoice: null,
    revealed: null,
    canChoose: true,
    result: null,
  });
  assert.equal(JSON.stringify(receipt).includes("sun"), false);
  code(
    () => f.k.receipt(roomId, f.actor("b"), request.actionId),
    "ACTION_UNCONFIRMED",
  );
  code(
    () =>
      f.act(roomId, "a", null, null, {
        ...request,
        action: { type: "game.choose", payload: { symbol: "moon" } },
      }),
    "IDEMPOTENCY_CONFLICT",
  );
  f.restart();
  f.act(roomId, "b", "game.choose", { symbol: "sun" });
  const view = f.k.view(roomId, f.actor("b"));
  assert.equal(view.lifecycle, "finished");
  assert.equal(view.view.result.winners.length, 2);
  assert.deepEqual(view.view.revealed, ["sun", "sun"]);
  assert.deepEqual(f.act(roomId, "a", null, null, request), receipt);
  code(
    () => f.act(roomId, "a", "game.choose", { symbol: "sun" }),
    "ROOM_CLOSED",
  );
});

test("different choices produce shared loss without a fabricated winner", (t) => {
  const f = setup(t),
    roomId = f.start();
  f.act(roomId, "a", "game.choose", { symbol: "sun" });
  f.act(roomId, "b", "game.choose", { symbol: "moon" });
  assert.deepEqual(f.k.view(roomId, f.actor("a")).view.result, {
    kind: "loss",
    winners: [],
    reasonCode: "DIFFERENT",
    details: {},
  });
});

test("forged actors, unknown fields, wrong turns, cross-game actions and controls are refused", (t) => {
  const f = setup(t),
    roomId = f.start(),
    before = f.k.store.room(roomId).revision;
  code(() => f.k.view(roomId, { principalId: "a" }), "AUTH_REQUIRED");
  code(() => f.k.view(roomId, f.actor("outsider")), "ROOM_UNAVAILABLE");
  code(
    () => f.act(roomId, "b", "game.choose", { symbol: "sun" }),
    "NOT_YOUR_TURN",
  );
  code(() => f.act(roomId, "b", "room.close"), "ROOM_CONTROL_DENIED");
  code(
    () => f.act(roomId, "a", "game.place", { x: 7, y: 7 }),
    "UNKNOWN_ACTION",
  );
  code(
    () => f.act(roomId, "a", "game.choose", { symbol: "sun", actorId: "b" }),
    "INVALID_REQUEST",
  );
  code(
    () =>
      f.k.act(roomId, f.actor("a"), {
        actionId: randomUUID(),
        expectedRevision: before,
        actorId: "b",
        action: { type: "room.close", payload: {} },
      }),
    "INVALID_REQUEST",
  );
  assert.equal(f.k.store.room(roomId).revision, before);
});

test("hidden-value twins have identical other-player views, errors and event notifications", (t) => {
  const f = setup(t),
    roomId = f.start();
  f.act(roomId, "a", "game.choose", { symbol: "sun" });
  const a = f.k.view(roomId, f.actor("b")),
    events = f.k.events(roomId, f.actor("b"), 0);
  code(
    () => f.act(roomId, "b", "game.choose", { symbol: "secret" }),
    "INVALID_REQUEST",
  );
  const room = f.k.store.room(roomId);
  room.state.choices[0] = "moon";
  f.k.store.save(room);
  assert.deepEqual(f.k.view(roomId, f.actor("b")), a);
  assert.deepEqual(f.k.events(roomId, f.actor("b"), 0), events);
  code(
    () => f.act(roomId, "b", "game.choose", { symbol: "secret" }),
    "INVALID_REQUEST",
  );
  assert.equal(JSON.stringify(events).includes("choices"), false);
});

test("pause, resume, close and expiry invalidate versions and decisions without polling advancement", (t) => {
  const f = setup(t),
    roomId = f.start(),
    old = f.k.store.room(roomId).decision;
  f.act(roomId, "a", "room.pause");
  assert.equal(f.k.store.room(roomId).decision, null);
  code(
    () => f.act(roomId, "a", "game.choose", { symbol: "sun" }),
    "ROOM_NOT_ACTIVE",
  );
  f.act(roomId, "a", "room.resume");
  assert.notEqual(f.k.store.room(roomId).decision.decisionId, old.decisionId);
  code(
    () =>
      f.act(roomId, "a", null, null, {
        actionId: randomUUID(),
        expectedRevision: old.sourceRevision,
        action: { type: "game.choose", payload: { symbol: "sun" } },
      }),
    "REVISION_CONFLICT",
  );
  const revision = f.k.store.room(roomId).revision;
  for (let i = 0; i < 3; i++) f.k.view(roomId, f.actor("a"));
  assert.equal(f.k.store.room(roomId).revision, revision);
  f.advance(durations.active);
  code(() => f.k.view(roomId, f.actor("a")), "ROOM_DEADLINE_REACHED");
  f.k.sweep();
  assert.equal(f.k.store.room(roomId).lifecycle, "paused");
  assert.equal(f.k.store.room(roomId).decision, null);
  f.advance(durations.paused);
  f.k.sweep();
  assert.equal(f.k.store.room(roomId).lifecycle, "expired");
  f.advance(durations.retained);
  f.k.sweep();
  code(() => f.k.view(roomId, f.actor("a")), "ROOM_UNAVAILABLE");
});

test("creation is idempotent and deleted room requests never create replacement rooms", (t) => {
  const f = setup(t),
    created = f.create();
  assert.equal(
    f.k.createRoom(f.actor("a"), created.request).roomId,
    created.roomId,
  );
  code(
    () =>
      f.k.createRoom(f.actor("a"), {
        ...created.request,
        options: { different: true },
      }),
    "IDEMPOTENCY_CONFLICT",
  );
  f.advance(durations.waiting);
  f.k.sweep();
  f.advance(durations.retained);
  f.k.sweep();
  code(() => f.k.createRoom(f.actor("a"), created.request), "ROOM_UNAVAILABLE");
});

test("source authorization revocation gates reads, writes and old receipts", (t) => {
  let allowed = true;
  const f = setup(t, choiceProbe, { allow: () => allowed }),
    roomId = f.start();
  const receipt = f.act(roomId, "a", "game.choose", { symbol: "moon" });
  allowed = false;
  code(
    () => f.k.receipt(roomId, f.actor("a"), receipt.actionId),
    "ROOM_UNAVAILABLE",
  );
  code(() => f.k.view(roomId, f.actor("b")), "ROOM_UNAVAILABLE");
  code(
    () => f.act(roomId, "b", "game.choose", { symbol: "moon" }),
    "ROOM_UNAVAILABLE",
  );
});

test("participant revocation removes sessions, pauses active room and blocks resume", (t) => {
  const f = setup(t),
    roomId = f.start(),
    token = f.join(roomId, "b"),
    member = f.k.store.room(roomId).participants[1];
  f.k.revoke(roomId, f.actor("a"), member.participantId);
  assert.equal(f.k.store.room(roomId).lifecycle, "paused");
  code(() => f.identity.session(roomId, token), "AUTH_REQUIRED");
  code(() => f.k.events(roomId, f.actor("b"), 0), "ROOM_UNAVAILABLE");
  code(() => f.act(roomId, "a", "room.resume"), "ROOM_NOT_READY");
});

for (const [name, change] of Object.entries({
  exception: {
    applyAction() {
      throw Error("PRIVATE_VALUE_DO_NOT_RETURN");
    },
  },
  mutation: {
    applyAction(state) {
      state.choices[0] = "sun";
      return { state };
    },
  },
  invalidActor: {
    nextActor() {
      return "unknown-player";
    },
  },
  invalidOutcome: {
    outcome() {
      return { kind: "win", winners: [], reasonCode: "BAD", details: {} };
    },
  },
  invalidView: {
    projectView() {
      return { privateState: "SECRET" };
    },
  },
  asyncModule: { create: async () => ({}) },
}))
  test(`module ${name} is rejected atomically with a sanitized error`, (t) => {
    const f = setup(t, { ...choiceProbe, ...change }),
      { roomId } = f.create();
    f.join(roomId, "a");
    f.join(roomId, "b");
    if (["exception", "mutation"].includes(name))
      f.act(roomId, "a", "room.start");
    const before = f.k.store.room(roomId),
      events = f.k.events(roomId, f.actor("a"), 0);
    code(
      () =>
        f.act(
          roomId,
          "a",
          ["exception", "mutation"].includes(name)
            ? "game.choose"
            : "room.start",
          ["exception", "mutation"].includes(name) ? { symbol: "sun" } : {},
        ),
      "GAME_MODULE_INVALID_RESULT",
    );
    assert.deepEqual(f.k.store.room(roomId), before);
    assert.deepEqual(f.k.events(roomId, f.actor("a"), 0), events);
  });

test("a storage failure after state/event writes rolls back the entire action", (t) => {
  const f = setup(t),
    roomId = f.start(),
    before = f.k.store.room(roomId);
  f.k.store.db.exec(
    "CREATE TRIGGER fail_receipt BEFORE INSERT ON game_receipts BEGIN SELECT RAISE(ABORT,'synthetic fault'); END;",
  );
  code(
    () => f.act(roomId, "a", "game.choose", { symbol: "sun" }),
    "GAME_STORAGE_FAILURE",
  );
  assert.deepEqual(f.k.store.room(roomId), before);
  assert.equal(f.k.events(roomId, f.actor("a"), 0).length, 3);
  f.k.store.db.exec("DROP TRIGGER fail_receipt");
  f.act(roomId, "a", "game.choose", { symbol: "sun" });
});

test("registered versions stay pinned; missing or altered bundles fail closed after reopening", (t) => {
  const f = setup(t),
    roomId = f.start(),
    ref = f.k.store.room(roomId).moduleRef;
  code(
    () => f.registry.register(choiceProbe, { test: "different" }),
    "GAME_MODULE_VERSION_EXISTS",
  );
  f.registry.register(
    {
      ...choiceProbe,
      manifest: { ...choiceProbe.manifest, moduleVersion: "2" },
    },
    { test: "v2" },
  );
  assert.deepEqual(f.k.view(roomId, f.actor("a")).moduleRef, ref);
  f.registry.modules.delete("choice-probe:1");
  f.restart();
  code(() => f.k.view(roomId, f.actor("a")), "GAME_MODULE_UNAVAILABLE");
  f.registry.register(choiceProbe, { test: "different" });
  code(() => f.k.view(roomId, f.actor("a")), "GAME_MODULE_UNAVAILABLE");
  assert.deepEqual(f.k.store.room(roomId).moduleRef, ref);
});

test("registry rejects unsupported capabilities, unsafe API versions and unbounded limits", () => {
  for (const manifest of [
    { ...choiceProbe.manifest, capabilities: ["realtime"] },
    { ...choiceProbe.manifest, moduleApiVersion: 2 },
    {
      ...choiceProbe.manifest,
      limits: { ...choiceProbe.manifest.limits, view: 1_000_000 },
    },
  ])
    code(
      () =>
        new GameRegistry().register(
          { ...choiceProbe, manifest },
          { test: "x" },
        ),
      "GAME_MODULE_INVALID",
    );
});

test("independent non-choice module replays persisted random context and changes no core", (t) => {
  const state = z.strictObject({
    player: z.string(),
    random: z.string(),
    count: z.number().int().min(0).max(1),
  });
  const definition = {
    ...choiceProbe,
    manifest: {
      ...choiceProbe.manifest,
      gameType: "random-probe",
      participants: { min: 1, max: 1, kinds: ["human"] },
      capabilities: ["turn-sequential-v1", "random-context-v1"],
      limits: { ...choiceProbe.manifest.limits, random: 8 },
    },
    schemas: {
      ...choiceProbe.schemas,
      state,
      actions: { "game.advance": z.strictObject({}) },
      view: z.strictObject({ count: z.number() }),
      outcome: z.unknown(),
    },
    create(_o, players, context) {
      return {
        player: players[0].participantId,
        random: context.random,
        count: 0,
      };
    },
    applyAction(current) {
      return { state: { ...current, count: 1 } };
    },
    nextActor(current) {
      return current.count ? null : current.player;
    },
    outcome(current) {
      return current.count
        ? { kind: "draw", winners: [], reasonCode: "DONE", details: {} }
        : null;
    },
    projectView(current) {
      return { count: current.count };
    },
  };
  const f = setup(t, definition),
    { roomId } = f.create(["a"]);
  f.join(roomId, "a");
  const receipt = f.act(roomId, "a", "room.start"),
    room = f.k.store.room(roomId);
  const audit = JSON.parse(
    f.k.store.db
      .prepare("SELECT audit FROM game_receipts WHERE action_id=?")
      .get(receipt.actionId).audit,
  );
  assert.deepEqual(
    definition.create({}, f.k.roster(room), audit.context),
    room.state,
  );
  assert.equal(
    JSON.stringify(f.k.view(roomId, f.actor("a"))).includes(room.state.random),
    false,
  );
  f.restart();
  assert.deepEqual(f.act(roomId, "a", null, null, audit.request), receipt);
  assert.equal(f.k.store.room(roomId).state.random, room.state.random);
  f.act(roomId, "a", "game.advance");
  assert.equal(f.k.view(roomId, f.actor("a")).lifecycle, "finished");
});

test("AI participation is denied execution and persists a blocked decision reference", (t) => {
  const f = setup(t),
    { roomId } = f.create([
      "a",
      {
        principalId: "agent-b",
        kind: "ai",
        agentId: "agent-b",
        label: "AI fixture",
      },
    ]);
  f.join(roomId, "a");
  code(
    () => f.identity.confirmAgent(roomId, f.actor("a"), "agent-b"),
    "BINDING_DENIED",
  );
  f.identity.confirmAgent(roomId, f.actor("agent-b"), "agent-b");
  f.act(roomId, "a", "room.start");
  f.act(roomId, "a", "game.choose", { symbol: "moon" });
  const jobs = f.k.store.db.prepare("SELECT * FROM game_decisions").all();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, "blocked");
  assert.equal(JSON.parse(jobs[0].data).reason, "P2_NOT_IMPLEMENTED");
  assert.equal(jobs[0].data.includes("moon"), false);
  code(
    () => f.act(roomId, "agent-b", "game.choose", { symbol: "moon" }),
    "P2_NOT_IMPLEMENTED",
  );
  f.act(roomId, "a", "room.pause");
  assert.equal(
    f.k.store.db.prepare("SELECT status FROM game_decisions").get().status,
    "invalidated",
  );
});

test("foreign application databases are refused without adding game tables", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foreign-game-")),
    database = path.join(dir, "foreign.sqlite");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = new DatabaseSync(database);
  db.exec("CREATE TABLE original(value TEXT)");
  code(
    () => new GameKernel({ database, registry: new GameRegistry() }),
    "GAME_DATABASE_INCOMPATIBLE",
  );
  assert.equal(
    db
      .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'")
      .get().n,
    1,
  );
  db.close();
});

test("two SQLite connections serialize concurrent identical action requests", async (t) => {
  const f = setup(t),
    roomId = f.start(),
    request = {
      actionId: randomUUID(),
      expectedRevision: 3,
      action: { type: "game.choose", payload: { symbol: "sun" } },
    };
  const source = `import {parentPort,workerData} from 'node:worker_threads';
    import {GameKernel} from ${JSON.stringify(new URL("../src/games/core/kernel.mjs", import.meta.url).href)};
    import {GameRegistry} from ${JSON.stringify(new URL("../src/games/core/registry.mjs", import.meta.url).href)};
    import {choiceProbe} from ${JSON.stringify(new URL("../src/games/fixtures/choice-probe.mjs", import.meta.url).href)};
    const registry=new GameRegistry();registry.register(choiceProbe,{test:'test-module-v1'});
    const k=new GameKernel({database:workerData.database,registry,clock:()=>1800000000000});
    parentPort.postMessage(k.act(workerData.roomId,k.actor('a'),workerData.request));k.close();`;
  const run = () =>
    new Promise((resolve, reject) => {
      const worker = new Worker(
        new URL("data:text/javascript," + encodeURIComponent(source)),
        { workerData: { database: f.database, roomId, request } },
      );
      worker.once("message", resolve);
      worker.once("error", reject);
    });
  const results = await Promise.all([run(), run()]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(f.k.store.room(roomId).revision, 4);
});

test("old successful receipts remain queryable after a deadline before sweep", (t) => {
  const f = setup(t),
    roomId = f.start(),
    request = {
      actionId: randomUUID(),
      expectedRevision: 3,
      action: { type: "game.choose", payload: { symbol: "sun" } },
    };
  const receipt = f.act(roomId, "a", null, null, request);
  f.advance(durations.active);
  assert.deepEqual(
    f.k.receipt(roomId, f.actor("a"), request.actionId),
    receipt,
  );
  assert.deepEqual(f.act(roomId, "a", null, null, request), receipt);
  code(
    () => f.act(roomId, "b", "game.choose", { symbol: "sun" }),
    "ROOM_DEADLINE_REACHED",
  );
});

test("oversized module projections roll back before state, events or receipts commit", (t) => {
  const definition = {
    ...choiceProbe,
    schemas: { ...choiceProbe.schemas, view: z.string() },
    projectView() {
      return "x".repeat(5000);
    },
  };
  const f = setup(t, definition),
    { roomId } = f.create();
  f.join(roomId, "a");
  f.join(roomId, "b");
  code(() => f.act(roomId, "a", "room.start"), "GAME_MODULE_INVALID_RESULT");
  assert.equal(f.k.store.room(roomId).state, null);
  assert.equal(f.k.store.room(roomId).revision, 2);
});

test("capacity, action ceilings and stale event cursors are bounded without blocking controlled close", (t) => {
  const f = setup(t, choiceProbe, { maxRooms: 1 }),
    roomId = f.start();
  code(() => f.create(), "ROOM_CAPACITY");
  const room = f.k.store.room(roomId);
  room.actionCount = 10000;
  f.k.store.save(room);
  code(
    () => f.act(roomId, "a", "game.choose", { symbol: "moon" }),
    "GAME_ACTION_LIMIT",
  );
  f.k.store.transaction(() => {
    const r = f.k.store.room(roomId);
    for (let i = 0; i < 300; i++) f.k.notify(r, "view_changed");
    f.k.store.save(r);
  });
  code(() => f.k.events(roomId, f.actor("a"), 0), "SNAPSHOT_REQUIRED");
  assert.equal(
    f.k.store.db.prepare("SELECT count(*) AS n FROM game_events").get().n,
    256,
  );
  f.act(roomId, "a", "room.close");
  assert.equal(f.k.view(roomId, f.actor("a")).closeReason, "CLOSED_BY_OWNER");
});

test("persisted state must satisfy the pinned schema before view or further transitions", (t) => {
  const f = setup(t),
    roomId = f.start(),
    room = f.k.store.room(roomId);
  room.state = { corrupt: true };
  f.k.store.save(room);
  code(() => f.k.view(roomId, f.actor("a")), "GAME_MODULE_INVALID_RESULT");
  code(
    () => f.act(roomId, "a", "game.choose", { symbol: "sun" }),
    "GAME_MODULE_INVALID_RESULT",
  );
  assert.deepEqual(f.k.store.room(roomId).state, { corrupt: true });
});

test("AI room owners cannot use control actions to bypass the missing P2 execution boundary", (t) => {
  const f = setup(t),
    { roomId } = f.create([
      { principalId: "a", kind: "ai", agentId: "agent-a", label: "AI owner" },
      "b",
    ]);
  code(() => f.act(roomId, "a", "room.close"), "P2_NOT_IMPLEMENTED");
  assert.equal(f.k.store.room(roomId).lifecycle, "waiting");
});

test("creation tombstones expire after seven days while recent deleted rooms stay idempotent", (t) => {
  const f = setup(t),
    first = f.create();
  f.k.store.db.prepare("DELETE FROM game_rooms WHERE id=?").run(first.roomId);
  assert.throws(
    () => f.k.createRoom(f.actor("a"), first.request),
    /ROOM_UNAVAILABLE/,
  );
  f.advance(7 * 86400000);
  const next = f.k.createRoom(f.actor("a"), first.request);
  assert.notEqual(next.roomId, first.roomId);
  assert.equal(
    f.k.store.db.prepare("SELECT count(*) AS n FROM game_creations").get().n,
    1,
  );
});

test("historical room capacity prunes only terminal rooms and keeps creation tombstones", (t) => {
  const f = setup(t, choiceProbe, { maxRooms: 1, maxHistoryRooms: 1 });
  const first = f.create();
  f.act(first.roomId, "a", "room.close");
  const second = f.create();
  f.act(second.roomId, "a", "room.close");
  f.k.sweep();
  assert.equal(
    f.k.store.db.prepare("SELECT count(*) AS n FROM game_rooms").get().n,
    1,
  );
  assert.equal(
    f.k.store.db.prepare("SELECT count(*) AS n FROM game_creations").get().n,
    2,
  );
  const deleted = [first, second].find(
    (created) =>
      !f.k.store.db
        .prepare("SELECT id FROM game_rooms WHERE id=?")
        .get(created.roomId),
  );
  assert.throws(
    () => f.k.createRoom(f.actor("a"), deleted.request),
    /ROOM_UNAVAILABLE/,
  );
});

test("legacy creation tombstones receive one full upgrade retention period", (t) => {
  const f = setup(t),
    first = f.create();
  f.k.store.db.exec("DROP TABLE game_creation_expiries");
  const before = f.k.clock();
  f.restart();
  assert.equal(
    f.k.store.db.prepare("SELECT expires_at FROM game_creation_expiries").get()
      .expires_at,
    before + 7 * 86400000,
  );
  assert.equal(
    f.k.createRoom(f.actor("a"), first.request).roomId,
    first.roomId,
  );
  f.advance(1000);
  f.restart();
  assert.equal(
    f.k.store.db.prepare("SELECT expires_at FROM game_creation_expiries").get()
      .expires_at,
    before + 7 * 86400000,
  );
});
