import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { desktopToken } from "../src/home/desktop-auth.mjs";
import { createServer } from "../src/server.mjs";
import { config, fixture } from "./helpers.mjs";

test("desktop event stream authenticates, pushes changes and revokes on disconnect", async (t) => {
  const cfg = config(1);
  cfg.desktopHome.enabled = true;
  const { runtime } = fixture(t, { cfg });
  const token = randomBytes(32).toString("hex");
  const server = createServer({ runtime, token, allowLive: true });
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${await server.listen()}`;
  const client = randomUUID();
  const headers = {
    "content-type": "application/json",
    "x-desktop-home-token": desktopToken(token),
  };
  const post = (endpoint, action, data) =>
    fetch(origin + endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ client, action, data }),
    });
  const initial = await (
    await post("/api/desktop-home/client", "sync", {
      visible: true,
      dragged: [],
    })
  ).json();
  assert.equal(initial.desktopPush, true);
  headers["x-desktop-room-epoch"] = initial.room.roomEpoch;
  const route = `/api/desktop-home/events?client=${client}&roomEpoch=${initial.room.roomEpoch}`;
  assert.equal((await fetch(origin + route)).status, 401);
  const controller = new AbortController();
  const response = await fetch(origin + route, {
    headers,
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const first = JSON.parse(
    decoder
      .decode((await reader.read()).value)
      .trim()
      .slice(6),
  );
  assert.equal(first.room.roomEpoch, initial.room.roomEpoch);
  await post("/api/desktop-home/client", "door-mode", "welcome");
  const changed = JSON.parse(
    decoder
      .decode((await reader.read()).value)
      .trim()
      .slice(6),
  );
  assert.ok(changed.sequence > first.sequence);
  const heartbeat = await (
    await post("/api/desktop-home/heartbeat", "sync", true)
  ).json();
  assert.equal(heartbeat.enabled, true);
  assert.equal(heartbeat.room, undefined);
  controller.abort();
  for (let i = 0; i < 50 && runtime.desktopVisits.live; i++) await delay(10);
  assert.equal(runtime.desktopVisits.live, null);
  const stale = await (
    await post("/api/desktop-home/heartbeat", "sync", true)
  ).json();
  assert.equal(stale.reconnect, true);
  assert.equal(runtime.desktopVisits.live, null);
  const reopened = await (
    await post("/api/desktop-home/client", "sync", true)
  ).json();
  assert.notEqual(reopened.room.roomEpoch, initial.room.roomEpoch);
  assert.equal((await fetch(origin + route, { headers })).status, 409);
  const oldHeartbeat = await (
    await post("/api/desktop-home/heartbeat", "sync", true)
  ).json();
  assert.equal(oldHeartbeat.reconnect, true);
  assert.equal(runtime.desktopVisits.live.room.epoch, reopened.room.roomEpoch);
});
