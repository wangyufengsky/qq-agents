import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { GameRegistry } from "../src/games/core/registry.mjs";
import {
  registerGomokuP2,
  gomokuSources,
} from "../src/games/framework/module.mjs";
import { gameDatabase } from "../src/games/framework/database.mjs";
import { checkGameCompatibility } from "../src/games/framework/compatibility.mjs";
import releases from "../src/games/framework/compatible-releases.json" with { type: "json" };

test("published rule digest is stable and unrelated/UI resources are not rule dependencies", () => {
  const registry = new GameRegistry();
  const ref = registerGomokuP2(registry);
  assert.equal(ref.moduleVersion, "3");
  assert.equal(
    ref.moduleDigest,
    "c0b24a9a41e56149e2bd5209f6604e0eed372758861203309530518988278811",
    "publish a new module version when rules or schemas change",
  );
  assert.deepEqual(Object.keys(gomokuSources()).sort(), [
    "rules.mjs",
    "zod.version",
  ]);
  assert.throws(
    () => registry.select("gomoku", "1"),
    /GAME_MODULE_UNAVAILABLE/,
  );
  const legacy = releases[0].ref;
  assert.deepEqual(registry.resolve(legacy).ref, legacy);
  assert.throws(
    () => registry.resolve({ ...legacy, moduleDigest: "0".repeat(64) }),
    /GAME_MODULE_UNAVAILABLE/,
  );
});

test("exact legacy rooms survive reopening without rewriting identity; preflight is read-only and fails closed", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "game-compat-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const database = path.join(root, "rooms.sqlite");
  assert.deepEqual(checkGameCompatibility(database), {
    compatible: true,
    rooms: 0,
  });
  let { kernel } = gameDatabase({ database });
  const { roomId } = kernel.createRoom(kernel.actor("owner"), {
    requestId: randomUUID(),
    gameType: "gomoku",
    moduleVersion: "3",
    options: {},
    participants: [
      { principalId: "owner", kind: "human", label: "玩家" },
      { principalId: "ai", kind: "ai", agentId: "agent", label: "对手" },
    ],
  });
  const room = kernel.store.room(roomId);
  room.moduleRef = releases[0].ref;
  for (const member of room.participants) member.confirmed = true;
  kernel.store.save(room);
  const before = JSON.stringify(room);
  kernel.close();
  assert.deepEqual(checkGameCompatibility(database), {
    compatible: true,
    rooms: 1,
  });
  ({ kernel } = gameDatabase({ database }));
  try {
    assert.equal(JSON.stringify(kernel.store.room(roomId)), before);
    assert.deepEqual(
      kernel.registry.resolve(room.moduleRef).ref,
      room.moduleRef,
    );
    assert.equal(
      kernel.view(roomId, kernel.actor("owner")).lifecycle,
      "waiting",
    );
    kernel.act(roomId, kernel.actor("owner"), {
      actionId: randomUUID(),
      expectedRevision: room.revision,
      action: { type: "room.start", payload: {} },
    });
    assert.equal(
      kernel.view(roomId, kernel.actor("owner")).view.board.length,
      225,
    );
    assert.deepEqual(kernel.store.room(roomId).moduleRef, releases[0].ref);
    room.moduleRef = { ...room.moduleRef, moduleDigest: "1".repeat(64) };
    kernel.store.save(room);
    assert.throws(
      () => checkGameCompatibility(database),
      /GAME_MODULE_UNAVAILABLE/,
    );
    assert.equal(
      kernel.store.room(roomId).moduleRef.moduleDigest,
      "1".repeat(64),
    );
  } finally {
    kernel.close();
  }
});
