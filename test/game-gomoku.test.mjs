import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { gomoku, registerGomoku } from "../src/games/gomoku/module.mjs";
import { registerChoiceProbe } from "../src/games/fixtures/choice-probe.mjs";
import { GameRegistry } from "../src/games/core/registry.mjs";
import { GameKernel, durations } from "../src/games/core/kernel.mjs";
import { GameIdentity } from "../src/games/core/identity.mjs";
import { secret } from "../src/games/core/value.mjs";
import { renderGomoku } from "../src/games/gomoku/page.mjs";

const players = [{ participantId: "black" }, { participantId: "white" }];
const start = () => gomoku.create({}, players);
function place(s, x, y) {
  const next = gomoku.applyAction(s, s.players[s.turn], {
    type: "game.place",
    payload: { x, y },
  });
  assert.ok(next.state);
  assert.ok(gomoku.schemas.state.safeParse(next.state).success);
  return next.state;
}
for (const [name, points] of Object.entries({
  horizontal: [
    [0, 0],
    [1, 0],
    [2, 0],
    [3, 0],
    [4, 0],
  ],
  vertical: [
    [14, 10],
    [14, 11],
    [14, 12],
    [14, 13],
    [14, 14],
  ],
  diagonal: [
    [0, 0],
    [1, 1],
    [2, 2],
    [3, 3],
    [4, 4],
  ],
  antiDiagonal: [
    [10, 14],
    [11, 13],
    [12, 12],
    [13, 11],
    [14, 10],
  ],
  overline: [
    [0, 0],
    [1, 0],
    [2, 0],
    [4, 0],
    [5, 0],
    [3, 0],
  ],
}))
  test(`gomoku ${name} wins at five or more and stops further play`, () => {
    let s = start();
    for (const [i, [x, y]] of points.entries()) {
      if (i) s = place(s, 2 * (i - 1), 7);
      assert.equal(gomoku.outcome(s), null);
      s = place(s, x, y);
    }
    assert.equal(gomoku.outcome(s).reasonCode, "FIVE_OR_MORE");
    assert.deepEqual(gomoku.outcome(s).winners, ["black"]);
    assert.equal(gomoku.nextActor(s), null);
    assert.equal(
      gomoku.projectView(s, { participantId: "white" }).canAct,
      false,
    );
    assert.deepEqual(
      gomoku.applyAction(s, "white", {
        type: "game.place",
        payload: { x: 9, y: 9 },
      }),
      { rejected: true },
    );
  });
test("gomoku rejects occupied/outside/fractional coordinates and wrong turn without mutating inputs", () => {
  const s = start(),
    before = structuredClone(s);
  assert.equal(gomoku.nextActor(s), "black");
  for (const [actor, payload] of [
    ["white", { x: 7, y: 7 }],
    ["black", { x: -1, y: 0 }],
    ["black", { x: 15, y: 0 }],
    ["black", { x: 0.5, y: 2 }],
    ["black", { x: 0, y: 15 }],
  ])
    assert.deepEqual(
      gomoku.applyAction(s, actor, { type: "game.place", payload }),
      { rejected: true },
    );
  const moved = place(s, 7, 7);
  assert.deepEqual(s, before);
  assert.equal(gomoku.nextActor(moved), "white");
  assert.deepEqual(
    gomoku.applyAction(moved, "white", {
      type: "game.place",
      payload: { x: 7, y: 7 },
    }),
    { rejected: true },
  );
});
test("gomoku detects white win, never wraps rows and requires consecutive stones", () => {
  let s = start();
  for (let i = 0; i < 5; i++) {
    s = place(s, i * 2, 10);
    s = place(s, i, 1);
  }
  assert.deepEqual(gomoku.outcome(s).winners, ["white"]);
  s = start();
  for (const index of [13, 14, 15, 16, 17]) s.board[index] = 1;
  assert.equal(gomoku.outcome(s), null);
});
test("gomoku full legal game draws on move 225; a final winning move takes precedence", () => {
  const cells = [[], []];
  for (let y = 0; y < 15; y++)
    for (let x = 0; x < 15; x++)
      cells[(x + 2 * y) % 4 < 2 ? 0 : 1].push([x, y]);
  let s = start();
  for (let i = 0; i < 225; i++) {
    assert.equal(gomoku.outcome(s), null);
    const [x, y] = cells[i % 2].shift();
    s = place(s, x, y);
  }
  assert.deepEqual(gomoku.outcome(s), {
    kind: "draw",
    winners: [],
    reasonCode: "BOARD_FULL",
    details: {},
  });
  s.board.fill(1, 0, 5);
  assert.equal(gomoku.outcome(s).reasonCode, "FIVE_OR_MORE");
});
test("gomoku resign awards opponent, only on the current turn", () => {
  const s = start();
  assert.deepEqual(
    gomoku.applyAction(s, "white", { type: "game.resign", payload: {} }),
    { rejected: true },
  );
  const next = gomoku.applyAction(s, "black", {
    type: "game.resign",
    payload: {},
  }).state;
  assert.deepEqual(gomoku.outcome(next), {
    kind: "win",
    winners: ["white"],
    reasonCode: "RESIGNED",
    details: {},
  });
  assert.equal(gomoku.nextActor(next), null);
});

// Identical transport-independent contract runs for a board game and a hidden-choice game.
for (const spec of [
  {
    type: "gomoku",
    register: registerGomoku,
    action: { type: "game.place", payload: { x: 7, y: 7 } },
    finish: { type: "game.resign", payload: {} },
  },
  {
    type: "choice-probe",
    register: registerChoiceProbe,
    action: { type: "game.choose", payload: { symbol: "sun" } },
    finish: { type: "game.choose", payload: { symbol: "sun" } },
  },
])
  test(`${spec.type}: shared identity, transaction, receipt, revision, restart and lifecycle contract`, (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "game-contract-")),
      database = path.join(dir, "game.sqlite"),
      registry = new GameRegistry();
    spec.register(registry);
    let now = 1800000000000,
      k = new GameKernel({ database, registry, clock: () => now });
    t.after(() => {
      k.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const actor = (p) => k.actor(p),
      view = (p) => k.view(roomId, actor(p));
    const creation = {
      requestId: randomUUID(),
      gameType: spec.type,
      moduleVersion: "1",
      options: {},
      participants: ["a", "b"].map((principalId) => ({
        principalId,
        kind: "human",
        label: principalId,
      })),
    };
    const { roomId } = k.createRoom(actor("a"), creation);
    assert.deepEqual(k.createRoom(actor("a"), creation), { roomId });
    const identity = new GameIdentity(k),
      sessions = [];
    for (const principal of ["a", "b"]) {
      const member = k.store
          .room(roomId)
          .participants.find((p) => p.principalId === principal),
        invite = identity.invite(roomId, actor("a"), member.participantId),
        browser = secret();
      const { challenge } = identity.request(
        roomId,
        invite.bindingId,
        invite.invite,
        browser,
      );
      if (principal === "b")
        assert.throws(
          () =>
            identity.confirm(roomId, invite.bindingId, challenge, actor("a")),
          /BINDING_DENIED/,
        );
      identity.confirm(roomId, invite.bindingId, challenge, actor(principal));
      sessions.push(
        identity.exchange(roomId, invite.bindingId, browser).session,
      );
    }
    const act = (p, action) =>
      k.act(roomId, actor(p), {
        actionId: randomUUID(),
        expectedRevision: k.store.room(roomId).revision,
        action,
      });
    assert.throws(() => k.view(roomId, {}), /AUTH_REQUIRED/);
    assert.throws(() => k.view(roomId, actor("outsider")), /ROOM_UNAVAILABLE/);
    assert.throws(
      () => act("b", { type: "room.start", payload: {} }),
      /ROOM_CONTROL_DENIED/,
    );
    act("a", { type: "room.start", payload: {} });
    assert.throws(() => act("b", spec.action), /NOT_YOUR_TURN/);
    const request = {
      actionId: randomUUID(),
      expectedRevision: 3,
      action: spec.action,
    };
    // A failing write must not leave a board change, receipt or event behind.
    const before = structuredClone(view("a"));
    k.store.db.exec(
      "CREATE TEMP TRIGGER fail_receipt BEFORE INSERT ON game_receipts BEGIN SELECT RAISE(ABORT, 'fixture'); END",
    );
    assert.throws(
      () => k.act(roomId, actor("a"), request),
      /GAME_STORAGE_FAILURE/,
    );
    assert.deepEqual(view("a"), before);
    assert.throws(
      () => k.receipt(roomId, actor("a"), request.actionId),
      /ACTION_UNCONFIRMED/,
    );
    k.store.db.exec("DROP TRIGGER fail_receipt");
    const receipt = k.act(roomId, actor("a"), request);
    assert.deepEqual(k.act(roomId, actor("a"), request), receipt);
    assert.equal(view("a").revision, 4);
    assert.throws(
      () => k.act(roomId, actor("a"), { ...request, expectedRevision: 4 }),
      /IDEMPOTENCY_CONFLICT/,
    );
    assert.throws(
      () => k.receipt(roomId, actor("b"), request.actionId),
      /ACTION_UNCONFIRMED/,
    );
    assert.throws(
      () => k.act(roomId, actor("b"), { ...request, actionId: randomUUID() }),
      /REVISION_CONFLICT/,
    );
    const saved = view("b");
    k.close();
    k = new GameKernel({ database, registry, clock: () => now });
    assert.deepEqual(
      k.view(roomId, new GameIdentity(k).session(roomId, sessions[1])),
      saved,
    );
    assert.deepEqual(k.receipt(roomId, actor("a"), request.actionId), receipt);
    act("a", { type: "room.pause", payload: {} });
    assert.throws(() => act("b", spec.finish), /ROOM_NOT_ACTIVE/);
    act("a", { type: "room.resume", payload: {} });
    act("b", spec.finish);
    assert.equal(view("a").lifecycle, "finished");
    assert.equal(view("a").view.result.kind, "win");
    assert.throws(() => act("a", spec.action), /ROOM_CLOSED/);
    assert.equal(
      JSON.stringify(k.events(roomId, actor("a"), 0)).includes('"payload"'),
      false,
    );
    const module = registry.select(spec.type, "1");
    const changed = new GameRegistry();
    changed.register(
      { ...module, manifest: { ...module.manifest, uiVersion: "2" } },
      { changed: "source" },
    );
    k.registry = changed;
    assert.throws(() => view("a"), /GAME_MODULE_UNAVAILABLE/);
    k.registry = registry;
    now += durations.retained;
    k.sweep();
    assert.throws(() => view("a"), /ROOM_UNAVAILABLE/);
  });

test("gomoku renders an authorized board without scripts and no board on an unauthenticated landing", () => {
  const s = place(start(), 7, 7),
    snapshot = {
      view: gomoku.projectView(s, { participantId: "black" }),
      viewer: "black",
      revision: 4,
      lifecycle: "active",
    };
  const html = renderGomoku(snapshot, "example");
  assert.match(html, /H8 黑子/);
  assert.match(html, /当前为非实时快照/);
  assert.match(html, /刷新快照/);
  assert.doesNotMatch(renderGomoku(null, "example"), /H8 黑子/);
});

test("AI display derives a two dimensional board without changing the participant projection", async () => {
  const { describeGomokuView } =
    await import("../src/games/gomoku/describe.mjs");
  const view = { board: Array(225).fill(0) };
  view.board[17] = 2;
  const display = describeGomokuView(view);
  assert.equal(display.board[1][2], 2);
  assert.equal(display.board.length, 15);
  display.board[1][2] = 1;
  assert.equal(view.board[17], 2);
});
