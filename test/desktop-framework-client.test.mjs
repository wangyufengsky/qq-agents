import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createFrameworkClient } from "../desktop/home/framework-client.mjs";
import { createDesktopRoomHost } from "../src/home/desktop-host.mjs";
import { desktopToken } from "../src/home/desktop-auth.mjs";
import { createServer } from "../src/server.mjs";
import { config, fixture } from "./helpers.mjs";

async function waitFor(condition) {
  const deadline = Date.now() + 6000;
  while (!condition()) {
    if (Date.now() >= deadline) throw Error("DESKTOP_TEST_STATE_TIMEOUT");
    await delay(15);
  }
}

test("desktop client receives pushed states, idles on heartbeats and reconnects with a new room", async (t) => {
  const cfg = config(1);
  cfg.desktopHome.enabled = true;
  cfg.desktopHome.publicPerception.enabled = true;
  const { runtime, root } = fixture(t, { cfg });
  const now = runtime.now.bind(runtime);
  let timeOffset = 0;
  runtime.now = () => now() + timeOffset;
  const admin = randomBytes(32).toString("hex");
  await writeFile(join(root, "desktop-home-token"), desktopToken(admin));
  const app = createServer({ runtime, token: admin, allowLive: true });
  const port = await app.listen();
  const traffic = [];
  const delayedResult = Promise.withResolvers();
  const handle = app.server.listeners("request")[0];
  app.server.off("request", handle);
  app.server.on("request", (request, response) => {
    const path = request.url.split("?")[0];
    traffic.push(path);
    if (path !== "/api/desktop-home/fixture-slow-result")
      return handle(request, response);
    request.resume();
    void delayedResult.promise.then(() => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"accepted":true}');
    });
  });

  let visible = false;
  const changes = [];
  const client = createFrameworkClient(
    root,
    (state, action) => changes.push({ state, action }),
    port,
    () => ({
      visible,
      dragged: [],
      bodyProtocol: 2,
      bodyPublic: true,
      ...(visible &&
        runtime.desktopVisits.live && {
          publicSpace: {
            roomEpoch: runtime.desktopVisits.live.room.epoch,
            residents: [],
          },
        }),
    }),
  );
  t.after(async () => {
    await client.close();
    await app.close();
  });
  const last = () => changes.findLast(({ state }) => state.room)?.state;
  const count = (endpoint) =>
    traffic.filter((url) => url === "/api/desktop-home/" + endpoint).length;

  await waitFor(last);
  const first = last();
  assert.ok(Number.isSafeInteger(first.sequence));
  assert.equal(count("events"), 1);
  await waitFor(() => count("heartbeat") >= 2);
  assert.equal(count("client"), 1);
  assert.equal(changes.filter(({ state }) => state.room).length, 1);

  visible = true;
  client.sync();
  await waitFor(
    () => runtime.desktopVisits.client?.activityVisibleUntil > runtime.now(),
  );
  const room = await client.command("door-mode", "welcome");
  assert.equal(room.roomEpoch, first.room.roomEpoch);
  await waitFor(() => last().sequence > first.sequence);
  assert.equal(count("client"), 2);

  const { perception } = runtime.desktopVisits.live;
  await waitFor(() => perception.view());
  const sample = perception.view();
  timeOffset = 3000;
  assert.equal(perception.view(), undefined);
  // Unchanged geometry is normally reported by a boolean visibility heartbeat.
  await waitFor(() => perception.view() && perception.view() !== sample);
  assert.equal(last().room.roomEpoch, first.room.roomEpoch);
  assert.equal(count("client"), 2);

  const result = client.result("fixture-slow-result", {}, () => true);
  let frameCurrent = true;
  let proving = false;
  const proof = Promise.withResolvers();
  const queuedFrame = client.result(
    "fixture-stale-frame",
    {},
    () => frameCurrent,
    async () => {
      proving = true;
      return proof.promise;
    },
  );
  try {
    await waitFor(() => count("fixture-slow-result") === 1);
    const lease = runtime.desktopVisits.client.activityVisibleUntil;
    await waitFor(
      () => runtime.desktopVisits.client.activityVisibleUntil > lease,
    );
    assert.ok(perception.view());
    const mode = await client.authorization("mode-set", "privacy");
    assert.equal(mode.companionMode, "privacy");
    assert.equal(proving, false);
  } finally {
    delayedResult.resolve();
    assert.deepEqual(await result, { accepted: true });
  }
  try {
    await waitFor(() => proving);
    frameCurrent = false;
  } finally {
    proof.resolve(true);
  }
  assert.equal(await queuedFrame, undefined);
  assert.equal(count("fixture-stale-frame"), 0);

  runtime.desktopVisits.reset();
  await waitFor(() => changes.some(({ state }) => state.offline));
  await waitFor(() => last().room.roomEpoch !== first.room.roomEpoch);
  assert.equal(count("events"), 2);
  assert.ok(last().sequence > first.sequence);
});

test("a transient heartbeat or stream interruption preserves an invitation in the unified room", async (t) => {
  const cfg = config(1);
  cfg.desktopHome.enabled = true;
  cfg.agents[0].subject.enabled = true;
  const decision = Promise.withResolvers();
  let invitation;
  const { runtime, root } = fixture(t, {
    cfg,
    createDesktopHost: createDesktopRoomHost,
    run: async (params) => {
      if (params.conversation !== "@subject") return;
      invitation = /"desktopInvitation":\{"id":"([a-f0-9-]+)"/.exec(
        params.prompt,
      )?.[1];
      await decision.promise;
      await params.callTool("desktop_invitation_decide", {
        id: invitation,
        action: "accept",
      });
    },
  });
  const admin = randomBytes(32).toString("hex");
  await writeFile(join(root, "desktop-home-token"), desktopToken(admin));
  const app = createServer({ runtime, token: admin, allowLive: true });
  const port = await app.listen();
  const handle = app.server.listeners("request")[0];
  let stream,
    stall = false,
    recovered = false,
    stalledResponse;
  app.server.off("request", handle);
  app.server.on("request", (req, res) => {
    if (req.url.startsWith("/api/desktop-home/events?")) stream = res;
    if (req.url === "/api/desktop-home/heartbeat") {
      if (stall) {
        stall = false;
        req.resume();
        stalledResponse = res;
        return;
      }
      if (stalledResponse) recovered = true;
    }
    return handle(req, res);
  });
  let room,
    offline = 0;
  const client = createFrameworkClient(
    root,
    (value) => {
      if (value.room) room = value.room;
      if (value.offline) offline++;
    },
    port,
    () => ({ visible: true, dragged: [] }),
  );
  t.after(async () => {
    decision.resolve();
    stalledResponse?.destroy();
    await client.close();
    await app.close();
  });
  await waitFor(() => room);
  const epoch = room.roomEpoch;
  client.act("invite", "agent-0");
  await waitFor(() => invitation);
  stall = true;
  await waitFor(() => recovered);
  assert.equal(offline, 0);
  assert.equal(room.roles[0].state, "invited");
  const firstStream = stream;
  firstStream.destroy();
  await waitFor(
    () =>
      stream !== firstStream &&
      offline > 0 &&
      runtime.desktopVisits.eventSubscribers.size === 1,
  );
  assert.equal(room.roomEpoch, epoch);
  decision.resolve();
  await waitFor(() => room.roles[0].state === "here");
  assert.equal(room.roomEpoch, epoch);
});
