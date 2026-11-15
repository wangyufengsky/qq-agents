import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createFrameworkClient } from "../desktop/home/framework-client.mjs";
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
  app.server.on("request", (request) => {
    traffic.push(request.url.split("?")[0]);
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

  runtime.desktopVisits.reset();
  await waitFor(() => changes.some(({ state }) => state.offline));
  await waitFor(() => last().room.roomEpoch !== first.room.roomEpoch);
  assert.equal(count("events"), 2);
  assert.ok(last().sequence > first.sequence);
});
