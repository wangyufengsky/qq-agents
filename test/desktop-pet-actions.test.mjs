import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createBodyActions } from "../desktop/home/body-actions.mjs";
import { petPacks } from "../desktop/home/renderer-petpacks.js";
import { pickSmallAction } from "../desktop/home/renderer-pet.js";
import { desktopResourcePath } from "../desktop/home/resource-protocol.mjs";
import { fileURLToPath } from "node:url";
import { desktopSessionBodyActionSchema } from "../src/home/desktop-body-protocol.mjs";

test("every role animates from packaged resources and keeps real events out of the ambient pool", async () => {
  const source = fileURLToPath(new URL("../desktop/home/", import.meta.url));
  for (const [role, pack] of Object.entries(petPacks)) {
    assert.equal(
      pack.states.walk,
      role === "dragon" ? "原地漂浮踏步" : "螃蟹走路",
    );
    assert.equal(pack.states.run, "原地左转奔跑");
    for (const name of Object.values(pack.states))
      assert.equal(pack.clips[name].category, undefined);
    const first = pickSmallAction(pack, null, () => 0);
    assert(pack.clips[first].category);
    assert.notEqual(
      pickSmallAction(pack, first, () => 0),
      first,
    );
    for (const clip of Object.values(pack.clips)) {
      const path = desktopResourcePath(
        new URL(
          `art/actions/${role}/${clip.file}.webp`,
          "nest://app/desktop/home/",
        ).href,
        source,
      );
      assert.equal((await readFile(path)).toString("ascii", 8, 12), "WEBP");
    }
  }
});
test("small action listings and playback use the acting resident and wait for its renderer", () => {
  const agentId = "resident";
  const entry = { win: { isDestroyed: () => false } };
  const context = {
    remoteState: { desktopUnified: true, roles: [{ id: agentId, art: "cat" }] },
    bodyInputAfter: 0,
  };
  const api = createBodyActions({
    entries: new Map([[agentId, entry]]),
    context,
    windowVisible: () => true,
    activeFollow: () => false,
    randomUUID: () => "token",
    update() {},
    recordBodyFeedback() {},
  });
  const results = [];
  const run = (operation, name) =>
    api.executeVerifiedBodyAction(
      {
        agentId,
        inputAt: 2,
        action: { type: "small-action", operation, ...(name && { name }) },
      },
      () => true,
      (r) => results.push(r),
    );
  run("list");
  assert(results.pop().actions.some((x) => x.name === "小提琴演奏"));
  run("play", "螃蟹走路");
  assert.equal(results.pop().status, "failed");
  const cancel = run("play", "小提琴演奏");
  assert.equal(results.length, 0);
  cancel();
  assert.equal(entry.smallAction, undefined);
  run("play", "小提琴演奏");
  entry.smallAction.done(true);
  assert.deepEqual(results, [{ status: "completed" }]);
  assert(
    !desktopSessionBodyActionSchema.safeParse({
      type: "small-action",
      operation: "play",
      requestId: "1",
    }).success,
  );
});
