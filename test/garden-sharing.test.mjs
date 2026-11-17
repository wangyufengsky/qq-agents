import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { desktopToken } from "../src/home/desktop-auth.mjs";
import { createServer } from "../src/server.mjs";
import { gardenTool } from "../src/tools/garden.mjs";
import { MediaStore } from "../src/tools/media.mjs";
import { config, context, fixture } from "./helpers.mjs";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
const admin = { kind: "admin", id: "administrator" };
const seed = { kind: "plant", plot: 1, cropId: "clover" };
const fakePlot = { requestId: "garden-first-plot", action: seed };

function setup(t, cfg = config(2)) {
  cfg.desktopHome.enabled = true;
  cfg.agents[0].subject.enabled = true;
  const f = fixture(t, { cfg });
  f.runtime.media = new MediaStore(path.join(f.root, "media"));
  f.runtime.clock = () => Date.parse("2026-10-29T12:00:00Z");
  const garden = f.runtime.home.garden;
  return { ...f, garden, open: () => garden.initialize(f.runtime.now()) };
}

test("normal chat and desktop can read only the public projection while locked scopes stay fenced", async (t) => {
  const f = setup(t);
  const runtime = f.runtime,
    role = runtime.agent("agent-0");
  const list = (conversation) => runtime.toolsFor(role, conversation);
  assert.ok(!list("group:20000").includes("garden_read"));
  f.open();
  f.garden.desktopSync(runtime.now(), 15_000);
  f.garden.act(runtime.now(), admin, fakePlot);
  const group = context(runtime),
    priv = context(runtime, "agent-0", "private:30000");
  const subject = context(runtime, "agent-0", "@subject");
  const desk = runtime.makeContext("agent-0", "@desktop", {
    controller: new AbortController(),
    assertCurrent() {},
    decide() {},
  });
  for (const ctx of [group, priv, desk, subject]) {
    const state = await runtime.callTool(ctx, "garden_read", {});
    assert.deepEqual(Object.keys(state).sort(), [
      "capturedAt",
      "day",
      "plots",
      "running",
      "text",
    ]);
    assert.equal(state.plots.length, 9);
    assert.equal(state.plots[0].name, "野生三叶草");
    assert.equal(state.plots[0].stage, "seedling");
    assert.ok(!state.text.includes("管理员"));
    assert.deepEqual(Object.keys(state.plots[0]).sort(), [
      "lowWater",
      "name",
      "plot",
      "stage",
      "water",
    ]);
    if (ctx !== subject)
      assert.ok(!list(ctx.conversation).includes("garden_act"));
  }
  desk.desktopPrivateObservation = true;
  await assert.rejects(
    runtime.callTool(desk, "garden_read", {}),
    /TOOL_DISABLED/,
  );
  await assert.rejects(
    runtime.callTool(
      context(runtime, "agent-0", "group:20099"),
      "garden_read",
      {},
    ),
    /AGENT_PAUSED_OR_EXPIRED/,
  );
  for (const scope of [
    "@social:example",
    "@desktop-observation",
    "@desktop-window-task",
  ])
    assert.ok(!list(scope).includes("garden_read"));
});

test("garden image and text share the existing QQ delivery ledger and budget", async (t) => {
  const cfg = config(1);
  cfg.agents[0].maxSendsPerTurn = 10;
  cfg.agents[0].behavior.maxSendPerMinute = 3;
  const f = setup(t, cfg),
    runtime = f.runtime;
  f.open();
  const ctx = context(runtime),
    transport = runtime.transports.get("qq-0");
  const textView = await runtime.callTool(ctx, "garden_read", {
    view: "public",
  });
  const image = await gardenTool(
    runtime,
    ctx,
    "garden_read",
    { view: "image" },
    async (snapshot) => {
      assert.deepEqual(snapshot, textView);
      return png;
    },
  );
  const payload = JSON.parse(image.content[0].text);
  assert.equal(payload.text, textView.text);
  assert.equal(transport.sent.length, 0);
  const mediaId = payload.mediaId;
  assert.equal(
    runtime.media.metadata("agent-0", mediaId).kind,
    "garden-snapshot",
  );
  const send = (requestId, args) =>
    runtime.callTool(ctx, "qq_send", { requestId, ...args });
  assert.equal(
    (await send("garden-text", { text: textView.text })).status,
    "sent",
  );
  assert.equal((await send("garden-image", { mediaId })).status, "sent");
  assert.equal(
    (await send("garden-both", { text: payload.text, mediaId })).status,
    "sent",
  );
  assert.deepEqual(
    transport.sent.map((item) => item.segments.map((s) => s.type)),
    [["text"], ["image"], ["text", "image"]],
  );
  assert.ok(
    transport.sent.every(({ conversation }) => conversation === "group:20000"),
  );
  assert.equal(
    (await send("garden-both", { text: payload.text, mediaId })).duplicate,
    true,
  );
  await assert.rejects(
    send("garden-over-budget", { mediaId }),
    /SEND_RATE_LIMIT/,
  );
  await assert.rejects(
    runtime.callTool(context(runtime, "agent-0", "private:30099"), "qq_send", {
      requestId: "garden-invalid-target",
      mediaId,
    }),
    /AGENT_PAUSED_OR_EXPIRED/,
  );
  assert.equal(transport.sent.length, 3);
});

test("image failure leaves the public text and ships no unverified media reference", async (t) => {
  const f = setup(t);
  f.open();
  const ctx = context(f.runtime);
  const result = await gardenTool(
    f.runtime,
    ctx,
    "garden_read",
    { view: "image" },
    async () => {
      throw Error("test screenshot failure");
    },
  );
  assert.equal(result.imageAvailable, false);
  assert.equal(result.reason, "GARDEN_IMAGE_UNAVAILABLE");
  assert.equal(result.mediaId, undefined);
  assert.match(result.text, /第 9 块/);
  assert.equal(f.runtime.media.saved("agent-0").items.length, 0);
});

test("late image results cannot save media after the requesting turn is cancelled", async (t) => {
  const f = setup(t);
  f.open();
  const ctx = context(f.runtime);
  const image = gardenTool(
    f.runtime,
    ctx,
    "garden_read",
    { view: "image" },
    async () => {
      ctx.controller.abort();
      return png;
    },
  );
  await assert.rejects(image, /AGENT_PAUSED_OR_EXPIRED/);
  assert.equal(f.runtime.media.saved("agent-0").items.length, 0);
});

test("desktop garden endpoint binds client and room epoch and writes the same garden", async (t) => {
  const f = setup(t),
    token = randomUUID(),
    runtime = f.runtime;
  const server = createServer({ runtime, token, allowLive: true });
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${await server.listen()}`;
  const desktop = desktopToken(token),
    client = randomUUID();
  const post = async (url, input, credential = desktop) => {
    const response = await fetch(origin + url, {
      method: "POST",
      headers: {
        connection: "close",
        "x-desktop-home-token": credential,
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
    });
    return { status: response.status, body: await response.json() };
  };
  const remote = await post("/api/desktop-home/client", {
    client,
    action: "sync",
    data: false,
  });
  const roomEpoch = remote.body.room.roomEpoch;
  const bound = { client, roomEpoch };
  const send = (extra = {}, credential = desktop) =>
    post("/api/desktop-home/garden", { ...bound, ...extra }, credential);
  assert.equal((await send({}, "wrong")).status, 401);
  assert.equal(
    (await send({ client: randomUUID() })).body.error,
    "DESKTOP_VISIT_UNAVAILABLE",
  );
  assert.equal(
    (await send({ roomEpoch: randomUUID() })).body.error,
    "DESKTOP_VISIT_UNAVAILABLE",
  );
  assert.equal((await send()).body.garden.initialized, false);
  f.open();
  await post("/api/desktop-home/client", {
    client,
    action: "sync",
    data: false,
  });
  const { body: result } = await send({ action: fakePlot });
  assert.equal(result.garden.plots[0].plant.cropId, "clover");
  assert.equal(result.garden.ledger, undefined);
  const adminView = await fetch(origin + "/api/home-garden", {
    headers: { connection: "close", "x-admin-token": token },
  }).then((r) => r.json());
  assert.equal(adminView.plots[0].plant.id, result.garden.plots[0].plant.id);
  assert.deepEqual(adminView.seeds, result.garden.seeds);
  assert.deepEqual(adminView.priorities, result.garden.priorities);
  assert.equal(
    (
      await send({
        action: { requestId: "bad-update", action: { kind: "initialize" } },
      })
    ).body.error,
    "INVALID_REQUEST",
  );
  await post("/api/desktop-home/client", { client, action: "disconnect" });
  assert.equal((await send()).body.error, "DESKTOP_VISIT_UNAVAILABLE");
});
