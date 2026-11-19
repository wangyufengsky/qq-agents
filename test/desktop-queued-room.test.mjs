import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createDesktopRoomHost } from "../src/home/desktop-host.mjs";
import { desktopToken } from "../src/home/desktop-auth.mjs";
import { createServer } from "../src/server.mjs";
import { config, fixture } from "./helpers.mjs";

test("the normal desktop HTTP entry queues chatting and touches for the roles actually present", async (t) => {
  const cfg = config(2);
  cfg.desktopHome.enabled = true;
  const { runtime } = fixture(t, {
    cfg,
    createDesktopHost: createDesktopRoomHost,
  });
  let now = runtime.now();
  runtime.clock = () => new Date(now);
  const host = runtime.desktopVisits;
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

  const initial = await command("sync", true);
  assert.equal(initial.room.nextRefill, now + 10 * 60_000);
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
  now += 1_000;
  await command("send", "只有第一只在场");
  const afterOwner = await command("sync", true);
  assert.equal(afterOwner.room.nextRefill, now + 10 * 60_000);
  assert.equal(afterOwner.room.activityEnabled, false);
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

  const nativeGrant = {
    agentId: first.id,
    roomEpoch,
    visitId: move.visitId,
    grantId: randomUUID(),
    targetId: randomUUID(),
  };
  const browserGrant = {
    agentId: first.id,
    roomEpoch,
    grantId: randomUUID(),
    targetId: randomUUID(),
  };
  const before = (await command("sync")).room;
  assert.deepEqual(before.nativeControl.targetEligible, [first.id, second.id]);
  assert.deepEqual(before.browserControl.targetEligible, [first.id, second.id]);
  assert.equal(runtime.config.desktopHome.nativeControl.enabled, false);
  assert.equal(runtime.config.desktopHome.browserControl.enabled, false);
  await command("native-grant", nativeGrant);
  await command("browser-grant", browserGrant);

  await command("leave", first.id);
  await command("send", "第一只离开期间");
  const away = (await command("sync")).room;
  assert.deepEqual(away.nativeControl.targetEligible, [second.id]);
  assert.equal(away.nativeControl.grants[0].grantId, nativeGrant.grantId);
  assert.equal(away.browserControl.grants[0].grantId, browserGrant.grantId);
  arrive(first);
  await command("send", "第一只回来了");
  assert.ok(
    runs.some(
      ({ role, prompt }) => role === first && prompt.includes("第一只回来了"),
    ),
  );
  assert.ok(
    runs.every(
      ({ role, prompt }) =>
        role !== first || !prompt.includes("第一只离开期间"),
    ),
  );
  const back = (await command("sync")).room;
  assert.equal(back.nativeControl.grants[0].targetId, nativeGrant.targetId);
  assert.equal(back.browserControl.grants[0].targetId, browserGrant.targetId);
  await command("native-revoke", { roomEpoch, grantId: nativeGrant.grantId });
  const revoked = (await command("sync")).room;
  assert.deepEqual(revoked.nativeControl.grants, []);
  assert.equal(
    revoked.browserControl.grants[0].targetId,
    browserGrant.targetId,
  );
});
