import { gardenLayers } from "../public/garden-art/art.js";
import { fixedWeather, keepNeutralWeather } from "./garden-fixtures.mjs";
import assert from "node:assert/strict";
import { HOUR, defaultGardenSettings } from "../src/home/garden-rules.mjs";
import { runNativeSocial } from "../src/backends/native-social.mjs";
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
  keepNeutralWeather(garden);
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
      "dayRemainingHours",
      "nightScene",
      "plots",
      "pollenPairs",
      "running",
      "text",
      "weather",
    ]);
    assert.equal(state.plots.length, 9);
    assert.equal(state.plots[0].name, "野生三叶草");
    assert.equal(state.plots[0].stage, "seedling");
    assert.ok(!state.text.includes("管理员"));
    assert.deepEqual(Object.keys(state.plots[0]).sort(), [
      "careMode",
      "dormant",
      "lowWater",
      "name",
      "plot",
      "sheltered",
      "stage",
      "stageLabel",
      "water",
    ]);
    if (ctx === group || ctx === desk)
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

test("an authorized subject can plant after reading chat while gift text still uses publication checks", async (t) => {
  const { runtime, garden } = setup(t);
  const ctx = context(runtime, "agent-0", "@subject");
  ctx.turnId = randomUUID();
  runtime.running.set("agent-0|@subject", ctx);
  t.after(() => runtime.running.delete("agent-0|@subject"));
  const settings = defaultGardenSettings();
  settings.roles[ctx.agentId] = runtime.home.generation(ctx.agentId);
  garden.initialize(runtime.now(), settings);
  garden.desktopSync(runtime.now(), 15_000);
  ctx.privateRead.add("context:private:30000");
  ctx.privateRead.add("context:group:20000");
  const call = (kind, args) =>
    runtime.callTool(ctx, "garden_act", {
      kind,
      args,
      requestId: randomUUID(),
    });
  const view = await runtime.callTool(ctx, "garden_read", {});
  assert.equal(view.turnRemaining, settings.turnLimit);
  const receipt = await call("plant", {
    plot: 4,
    cropId: "moonflower",
    buyPrice: settings.crops.moonflower.seedPrice,
  });
  await call("water", { plot: 4, plantId: receipt.plantId });
  assert.equal(garden.turnUsed(ctx.agentId, ctx.turnId), 2);
  await assert.rejects(
    call("send_gift", {
      itemId: randomUUID(),
      recipient: admin,
      note: "一张纸条",
    }),
    /HOME_SOURCE_DENIED/,
  );
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
  assert.ok(Array.isArray(result.garden.ledger));
  assert.equal(result.garden.settings, undefined);
  const adminView = await fetch(origin + "/api/home-garden", {
    headers: { connection: "close", "x-admin-token": token },
  }).then((r) => r.json());
  assert.equal(adminView.plots[0].plant.id, result.garden.plots[0].plant.id);
  assert.deepEqual(adminView.seeds, result.garden.seeds);
  assert.deepEqual(adminView.ledger, result.garden.ledger);
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

test("read-only plant snapshots keep identity, strip actors, and preserve original images after harvest", async (t) => {
  const f = setup(t);
  const { runtime, garden } = f;
  let now = runtime.now();
  runtime.clock = () => now;
  const rules = defaultGardenSettings();
  rules.crops.clover.hours = 0.5;
  rules.events.rate = 0;
  garden.initialize(now, rules);
  garden.desktopSync(now, 10 * HOUR);
  garden.act(now, admin, fakePlot);
  garden.act(now, admin, {
    requestId: "garden-second-plot",
    action: { ...seed, plot: 2 },
  });
  const ctx = context(runtime);
  const read = (args) => runtime.callTool(ctx, "garden_read", args);
  const choices = await read({ view: "plant", cropId: "野生三叶草" });
  assert.equal(choices.status, "ambiguous");
  assert.deepEqual(
    choices.choices.map(({ plot, planted }) => [plot, planted.day]),
    [
      [1, 1],
      [2, 1],
    ],
  );
  assert.equal((await read({ view: "plant", plot: 3 })).status, "empty");
  const current = await read({ view: "plant", plot: 1 });
  const { plantId } = current;
  assert.equal(current.stageLabel, "已播种");
  assert.doesNotMatch(JSON.stringify(current), /actorId|administrator/);
  assert.equal(
    (await read({ view: "plant_history", plantId })).plant.actor,
    undefined,
  );
  const subject = context(runtime, "agent-0", "@subject");
  subject.turnId = randomUUID();
  runtime.running.set("agent-0|@subject", subject);
  try {
    const history = await runtime.callTool(subject, "garden_read", {
      view: "plant_history",
      plantId,
    });
    assert.equal(history.plant.actor.id, admin.id);
  } finally {
    runtime.running.delete("agent-0|@subject");
  }
  const page = await read({ view: "timeline", limit: 1 });
  assert.equal(page.entries.length, 1);
  assert.notEqual(
    (await read({ view: "timeline", limit: 1, cursor: page.nextCursor }))
      .entries[0].id,
    page.entries[0].id,
  );
  const exact = await read({ view: "timeline", factId: page.entries[0].id });
  assert.deepEqual(exact.entries, page.entries);
  await assert.rejects(
    read({ view: "timeline", actorId: admin.id }),
    /INVALID_REQUEST/,
  );
  const digest = await read({ view: "digest" });
  assert.equal(digest.initial, true);
  assert.deepEqual(await read({ view: "digest" }), digest);
  assert.equal(digest.through, undefined);
  let rendered;
  const result = await gardenTool(
    runtime,
    ctx,
    "garden_read",
    { view: "plant_image", plot: 1 },
    undefined,
    async (snapshot) => {
      rendered = snapshot;
      return png;
    },
  );
  const card = JSON.parse(result.content[0].text);
  assert.equal(card.snapshotId, current.snapshotId);
  assert.equal(card.text, rendered.text);
  assert.equal(card.modelImageAttached, true);

  const clockBeforeHistory = garden.requireState().clock;
  now += HOUR;
  await read({ view: "timeline" });
  await read({ view: "plant_history", plantId });
  await read({ view: "digest" });
  assert.equal(garden.requireState().clock, clockBeforeHistory);
  garden.act(now, admin, {
    requestId: "garden-first-harvest",
    action: { kind: "harvest", plot: 1, plantId },
  });
  garden.act(now, admin, { requestId: "garden-replant", action: seed });
  assert.notEqual((await read({ view: "plant", plot: 1 })).plantId, plantId);
  const archived = await read({ view: "plant", plantId });
  assert.equal(archived.status, "harvested");
  assert.match(archived.text, /已收成/);
  assert.ok(archived.quality);
  garden.desktopStop(now);
  assert.match((await read({ view: "plant", plantId })).text, /花园时钟已停/);
  const wrongScope = context(runtime, "agent-0", "private:30000");
  await assert.rejects(
    runtime.callTool(wrongScope, "qq_send", {
      requestId: "garden-wrong-chat",
      mediaId: card.mediaId,
    }),
    /HOME_SOURCE_DENIED/,
  );
  assert.equal(
    (
      await runtime.callTool(ctx, "qq_send", {
        requestId: "garden-original-card",
        mediaId: card.mediaId,
      })
    ).status,
    "sent",
  );
  assert.equal(
    runtime.media.read("agent-0", card.mediaId).data,
    png.toString("base64"),
  );
});

test("desktop replies publish an authorized garden attachment and retrieve the same PNG", async (t) => {
  const { runtime, open } = setup(t, config(1));
  open();
  const token = randomUUID();
  const server = createServer({ runtime, token, allowLive: true });
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${await server.listen()}/api/desktop-home/`;
  const client = randomUUID();
  const post = (route, input, key = desktopToken(token)) =>
    fetch(origin + route, {
      method: "POST",
      headers: {
        connection: "close",
        "x-desktop-home-token": key,
        "content-type": "application/json",
      },
      body: JSON.stringify({ client, ...input }),
    });
  const {
    room: { roomEpoch },
  } = await post("client", { action: "sync" }).then((r) => r.json());
  const host = runtime.desktopVisits;
  const { live } = host;
  const role = live.room.roles[0];
  live.room.members[role.id] = "invited";
  live.admit(role);
  const backend = runtime.backendConnections.adapter(runtime.agent(role.id));
  const meta = {
    gardenSnapshot: true,
    kind: "garden-snapshot",
    title: "野生三叶草",
  };
  const { id: mediaId } = runtime.media.put(role.id, png, "image/png", {
    ...meta,
    conversation: "group:20000",
  });
  backend.runDesktop = (params) =>
    runNativeSocial(backend, params, async () => {}, "desktop");
  backend.run = async (params) => {
    await params.beforeInputSubmitted();
    params.onInputSubmitted?.();
    params.saveSession(
      params.session ?? { backend: "codex", id: "fixture-garden-shared-image" },
    );
    await assert.rejects(
      params.callTool("desktop_room_decide", { action: "say", mediaId }),
      /DESKTOP_ATTACHMENT_UNAVAILABLE/,
    );
    runtime.media.put(role.id, png, "image/png", {
      ...meta,
      conversation: "@desktop",
    });
    const decision = await params.callTool("desktop_room_decide", {
      action: "say",
      mediaId,
    });
    assert.equal(decision.status, "recorded");
  };
  assert.equal(
    (await post("client", { action: "send", data: "看看花卡" })).status,
    200,
  );
  await live.foreground?.done;
  const archived = host.archive.history().at(-1);
  assert.equal(archived.actor, role.id);
  assert.equal(archived.text, "");
  assert.equal(archived.attachments[0].id, mediaId);
  const input = { roomEpoch, messageId: archived.messageId };
  assert.equal((await post("shared-image", input, token)).status, 401);
  assert.equal(
    (await post("shared-image", { ...input, roomEpoch: randomUUID() })).ok,
    false,
  );
  assert.equal(
    (await post("shared-image", { ...input, messageId: randomUUID() })).ok,
    false,
  );
  assert.deepEqual(await post("shared-image", input).then((r) => r.json()), {
    data: png.toString("base64"),
    mimeType: "image/png",
  });
});

test("a text-only backend retains the card media and cannot resend an unconfirmed image under another request", async (t) => {
  const cfg = config(1);
  cfg.backends[0] = {
    id: "fixture",
    type: "openai",
    label: "Fixture",
    baseUrl: "http://127.0.0.1:9",
    model: "synthetic",
    vision: false,
  };
  const { runtime, garden, open } = setup(t, cfg);
  open();
  garden.desktopSync(runtime.now(), HOUR);
  garden.act(runtime.now(), admin, fakePlot);
  const ctx = context(runtime);
  const card = await gardenTool(
    runtime,
    ctx,
    "garden_read",
    { view: "plant_image", plot: 1 },
    undefined,
    async () => png,
  );
  assert.equal(card.imageAvailable, true);
  assert.equal(card.modelImageAttached, false);
  assert.equal(card.content, undefined);
  assert.match(card.text, /野生三叶草/);
  const transport = runtime.transports.get("qq-0");
  transport.failure = "GATEWAY_TIMEOUT";
  const send = (requestId, text) =>
    runtime.send(ctx, { requestId, text, mediaId: card.mediaId });
  await assert.rejects(send("card-unknown", "第一次分享"), /DELIVERY_UNKNOWN/);
  await Promise.allSettled(runtime.work);
  transport.failure = null;
  await assert.rejects(
    send("card-retry-with-a-different-id", "换一条说明"),
    /QQ_DRAFT_DELIVERY_UNRESOLVED/,
  );
  await assert.rejects(
    send("card-unknown", "第一次分享"),
    /DELIVERY_ALREADY_ATTEMPTED_UNKNOWN/,
  );
  assert.equal(transport.sent.length, 1);
});

test("a subject can acknowledge only its own observed digest without swallowing later facts", async (t) => {
  const cfg = config(2);
  cfg.agents[1].subject.enabled = true;
  const { runtime, garden, open } = setup(t, cfg);
  open();
  garden.desktopSync(runtime.now(), HOUR);
  garden.act(runtime.now(), admin, fakePlot);
  const subject = (role) => {
    const ctx = context(runtime, role, "@subject");
    ctx.turnId = randomUUID();
    runtime.running.set(role + "|@subject", ctx);
    return ctx;
  };
  t.after(() => {
    runtime.running.delete("agent-0|@subject");
    runtime.running.delete("agent-1|@subject");
  });
  const first = subject("agent-0");
  const other = subject("agent-1");
  const publicChat = context(runtime);
  const read = (ctx) =>
    runtime.callTool(ctx, "garden_read", { view: "digest" });
  const ack = (ctx, readToken) =>
    runtime.callTool(ctx, "garden_read", { view: "ack_digest", readToken });
  const publicDigest = await read(publicChat);
  assert.equal(publicDigest.initial, true);
  assert.equal(publicDigest.readToken, undefined);
  const { readToken: earlierToken } = await read(first);
  const { initial, readToken } = await read(first);
  assert.equal(initial, true);
  assert.notEqual(readToken, earlierToken);
  await assert.rejects(ack(first, earlierToken), /INVALID_REQUEST/);
  await assert.rejects(ack(first, randomUUID()), /INVALID_REQUEST/);
  await assert.rejects(ack(publicChat, readToken), /TOOL_DISABLED/);
  await assert.rejects(ack(other, readToken), /INVALID_REQUEST/);
  const earlierTurn = await read(other);
  const otherNextTurn = subject("agent-1");
  await assert.rejects(
    ack(otherNextTurn, earlierTurn.readToken),
    /INVALID_REQUEST/,
  );

  garden.act(runtime.now(), admin, {
    requestId: "garden-new-after-digest",
    action: { ...seed, plot: 2 },
  });
  assert.deepEqual(await ack(first, readToken), { acknowledged: true });
  assert.deepEqual(await ack(first, readToken), { acknowledged: true });
  const next = await read(first);
  assert.equal(next.initial, false);
  assert.deepEqual(
    next.entries.map(({ plants }) => plants[0]?.plot),
    [2],
  );
  assert.equal((await read(otherNextTurn)).initial, true);
  assert.equal(garden.digest({ kind: "admin", id: admin.id }).initial, true);
});

test("public and single-plant reads leave pending garden rewards and turn budgets untouched", async (t) => {
  const cfg = config(1);
  cfg.agents[0].subject.enabled = true;
  const { runtime, store, root } = fixture(t, { cfg });
  runtime.media = new MediaStore(path.join(root, "media"));
  const garden = runtime.home.garden;
  let now = runtime.now();
  runtime.clock = () => now;
  const settings = defaultGardenSettings();
  settings.weather = fixedWeather();
  settings.events.rate = 1;
  for (const [id, event] of Object.entries(settings.events.entries))
    event.enabled = id === "visitor";
  settings.events.entries.visitor.conditions = [];
  for (const cropId of ["moonflower", "catnip"]) {
    settings.crops[cropId].hours = 4;
    settings.crops[cropId].dailyWater = 0;
  }
  garden.initialize(now, settings);
  garden.desktopSync(now, 170 * HOUR);
  for (const [plot, cropId] of [
    [1, "moonflower"],
    [2, "catnip"],
  ])
    garden.act(now, admin, {
      requestId: randomUUID(),
      action: {
        kind: "plant",
        plot,
        cropId,
        buyPrice: settings.crops[cropId].seedPrice,
      },
    });
  const ctx = context(runtime, "agent-0", "@subject");
  ctx.turnId = randomUUID();
  runtime.running.set("agent-0|@subject", ctx);
  t.after(() => runtime.running.delete("agent-0|@subject"));
  const read = (view, query = {}) =>
    runtime.callTool(ctx, "garden_read", { view, ...query });
  const count = () =>
    store.db
      .prepare(
        "SELECT COUNT(*) AS count FROM garden_facts WHERE type IN ('visitor_reward', 'discovery')",
      )
      .get().count;
  assert.equal((await read("public")).event.status, "open");
  assert.equal((await read("plant", { plot: 1 })).name, "月光夜来香");
  assert.equal(count(), 0);
  const before = garden.requireState();
  now += 160 * HOUR;
  await read("public");
  await read("plant", { plot: 1 });
  const image = await gardenTool(
    runtime,
    ctx,
    "garden_read",
    { view: "plant_image", plot: 1 },
    undefined,
    async () => png,
  );
  assert.equal(JSON.parse(image.content[0].text).imageAvailable, true);
  assert.equal(count(), 0);
  assert.deepEqual(garden.requireState(), before);
  assert.equal(garden.turnUsed(ctx.agentId, ctx.turnId), 0);

  // The regular clock can still settle the pending pair and its reward.
  garden.desktopSync(now, 170 * HOUR);
  assert.equal(garden.requireState().seeds.mistbell, 1);
});

test("sunflower milestones align between the timeline, whole garden, individual plant and stickers", async (t) => {
  const { runtime, garden } = setup(t);
  const start = runtime.now();
  let now = start;
  runtime.clock = () => now;
  const settings = defaultGardenSettings();
  settings.crops.sunflower.hours = 10;
  garden.initialize(now, settings);
  garden.desktopSync(now, 24 * HOUR);
  const { plantId } = garden.act(now, admin, {
    requestId: randomUUID(),
    action: { kind: "plant", plot: 1, cropId: "sunflower", buyPrice: 60 },
  });
  const ctx = context(runtime);
  for (const [hours, label, stage, milestone, sticker] of [
    [0, "已播种", "seedling", "planted", "plant-seedling.webp"],
    [1.5, "发芽", "growing", "sprouted", "plant-sunflower-seedling.webp"],
    [7, "现蕾", "growing", "developed", "plant-sunflower-growing.webp"],
    [10, "开花", "mature", "mature", "plant-sunflower-mature.webp"],
  ]) {
    now = start + hours * HOUR;
    garden.desktopSync(now, 24 * HOUR);
    const whole = await runtime.callTool(ctx, "garden_read", {
      view: "public",
    });
    const card = await runtime.callTool(ctx, "garden_read", {
      view: "plant",
      plantId,
    });
    assert.equal(whole.plots[0].stage, stage);
    assert.equal(card.stage, stage);
    assert.equal(whole.plots[0].stageLabel, label);
    assert.equal(card.stageLabel, label);
    const layers = gardenLayers(garden.read(now).plots[0]);
    assert.equal(layers.find(({ layer }) => layer === "plant").file, sticker);
    if (milestone !== "planted") {
      const timeline = await runtime.callTool(ctx, "garden_read", {
        view: "timeline",
        plantId,
        type: milestone,
      });
      assert.equal(timeline.entries.length, 1);
      assert.ok(timeline.entries[0].text.endsWith(label));
    }
  }
});
