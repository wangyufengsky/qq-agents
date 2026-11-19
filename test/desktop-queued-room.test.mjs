import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { DesktopHost } from "../src/home/desktop-host.mjs";
import { DesktopTurnQueue } from "../src/home/desktop-turn-queue.mjs";
import { desktopToken } from "../src/home/desktop-auth.mjs";
import { createServer } from "../src/server.mjs";
import { config, fixture } from "./helpers.mjs";

test("the normal desktop HTTP entry queues chatting and touches for the roles actually present", async (t) => {
  const cfg = config(2);
  cfg.desktopHome.enabled = true;
  const { runtime } = fixture(t, { cfg });
  const host = new DesktopHost(runtime, {
    createTurnQueue: () => new DesktopTurnQueue(),
  });
  runtime.desktopVisits = host;
  const admin = "fixture-admin-token";
  const app = createServer({ runtime, token: admin, allowLive: true });
  const url = `http://127.0.0.1:${await app.listen()}/api/desktop-home/client`;
  const client = randomUUID();
  const firstTurn = Promise.withResolvers();
  t.after(() => {
    firstTurn.resolve();
    return app.close();
  });

  async function command(action, data) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-desktop-home-token": desktopToken(admin),
      },
      body: JSON.stringify({ client, action, data }),
    });
    assert.equal(response.status, 200);
    return response.json();
  }

  await command("sync", true);
  const [first, second] = host.live.room.roles;
  const arrive = (role) => {
    host.live.room.members[role.id] = "invited";
    host.live.admit(role);
  };
  const runs = [];
  for (const role of [first, second]) {
    const backend = runtime.backendConnections.adapter(runtime.agent(role.id));
    backend.runDesktop = async (params) => {
      params.beforeInput();
      params.onInputSubmitted();
      runs.push({ role, prompt: params.prompt, signal: params.signal });
      if (runs.length === 1) await firstTurn.promise;
    };
  }

  arrive(first);
  await command("send", "只有第一只在场");
  assert.deepEqual(
    runs.map(({ role }) => role),
    [first],
  );

  arrive(second);
  await command("send", "两只都在场");
  const roomEpoch = host.live.room.epoch;
  const move = {
    eventId: randomUUID(),
    roomEpoch,
    agentId: first.id,
    visitId: host.body.visitId(host.live.visits.get(first.id)),
    kind: "drag",
    from: { x: 100, y: 50 },
    to: { x: 20, y: 70 },
  };
  const pet = {
    eventId: randomUUID(),
    roomEpoch,
    agentId: first.id,
    visitId: move.visitId,
    kind: "pet",
  };
  const packet = {
    visible: true,
    dragged: [first.id],
    desktopOwnerEvents: [move, pet],
  };
  for (let i = 0; i < 2; i++) {
    const state = await command("sync", packet);
    assert.deepEqual(state.desktopOwnerInput.acknowledged, [
      move.eventId,
      pet.eventId,
    ]);
  }
  assert.equal(runs[0].signal.aborted, false);
  assert.doesNotMatch(
    runs.find(({ role }) => role === second).prompt,
    /只有第一只在场/,
  );

  const active = host.live.activities.get(first.id)?.done;
  firstTurn.resolve();
  await active;
  const next = runs.find(({ prompt }) => prompt.includes(move.eventId));
  assert.ok(next);
  assert.match(next.prompt, /两只都在场/);
  assert.match(next.prompt, /"from":\{"x":100,"y":50\},"to":\{"x":20,"y":70\}/);
  assert.equal(next.prompt.split(move.eventId).length - 1, 1);
  assert.equal(next.prompt.split(pet.eventId).length - 1, 1);
});
