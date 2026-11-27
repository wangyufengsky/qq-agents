import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { MemoryStore } from "../src/memory/store.mjs";
import { withExport } from "../src/memory/export.mjs";
import { backupDatabase } from "../src/memory/backup.mjs";
import { GardenService } from "../src/home/garden-service.mjs";
import { gardenPublicSnapshot } from "../src/home/garden-public.mjs";
import {
  adminGardenView,
  performGardenAction,
} from "../src/home/garden-console.mjs";
import { DAY, HOUR, defaultGardenSettings } from "../src/home/garden-rules.mjs";
import {
  gardenGifts,
  isGardenMerchantGift,
} from "../public/garden-art/gifts.js";
import {
  drawGardenEvent,
  eventOdds,
  eventPool,
} from "../src/home/garden-event-rules.mjs";
import { fixedWeather } from "./garden-fixtures.mjs";
import { config, context, fixture, raw, settle } from "./helpers.mjs";

const admin = { kind: "admin", id: "administrator" };
const actor = { kind: "agent", id: "agent-0", turnId: "turn-01" };

function rules(kind, patches = {}) {
  const value = defaultGardenSettings();
  value.weather = fixedWeather();
  value.crops.clover.hours = 1;
  value.events.rate = 1;
  for (const [id, entry] of Object.entries(value.events.entries))
    entry.enabled = id === kind;
  Object.assign(value.events.entries[kind].effect, patches);
  return value;
}
function setup(t, settings) {
  const store = new MemoryStore(":memory:");
  t.after(() => store.close());
  const garden = new GardenService(store);
  let now = 0;
  garden.initialize(now, settings);
  garden.syncClock(now, true);
  return {
    garden,
    store,
    read: () => garden.read(now),
    act: (action, by = admin, requestId = randomUUID()) =>
      garden.act(now, by, { action, requestId }),
    claim: (by = admin) => garden.read(now, by),
    advance: (ms) => {
      now += ms;
      garden.syncClock(now, true);
    },
    configure: (fn) => {
      const state = garden.requireState();
      fn(state.settings);
      return garden.configure(now, state.settingsRevision, state.settings);
    },
  };
}
test("event odds use selected weather and strict balance thresholds, with independent no-event probability", () => {
  const s = rules("merchant");
  for (const id of ["merchant", "thief", "visitor"])
    s.events.entries[id].enabled = true;
  s.events.entries.visitor.weight = 0;
  s.events.entries.merchant.conditions = [
    { field: "today", match: { by: "kind", value: "sun" } },
  ];
  s.events.rate = 0.4;
  const ctx = {
    balance: 300,
    seeds: {},
    harvests: {},
    fertilizer: 0,
    previous: null,
  };
  const cloudy = s.weather.entries.cloud,
    sunny = s.weather.entries.sun;
  const trial = (weather) => eventOdds(s, ctx, weather);
  assert.equal(trial(cloudy).noEvent, 1);
  assert.equal(
    trial(sunny).rows.find(({ id }) => id === "merchant").probability,
    0.4,
  );
  assert.equal(
    trial(sunny).rows.find(({ id }) => id === "thief").reason,
    "conditions",
  );
  ctx.balance = 301;
  const odds = trial(sunny);
  assert.ok(
    Math.abs(odds.rows.find(({ id }) => id === "merchant").probability - 0.3) <
      1e-12,
  );
  assert.equal(odds.rows.find(({ id }) => id === "thief").probability, 0.1);
  assert.equal(odds.noEvent, 0.6);
  assert.equal(
    trial(cloudy).rows.find(({ id }) => id === "merchant").probability,
    0,
  );
});

test("merchant shares frozen quotes for paid and rare seeds and premium sales until day end", (t) => {
  const s = rules("merchant", {
    seeds: ["moonflower"],
    harvests: ["clover"],
    minPremium: 1.4,
    maxPremium: 1.4,
  });
  s.crops.moonflower.market = false;
  s.crops.moonflower.seedPrice = 139;
  const f = setup(t, s);
  const day = f.read().event;
  assert.deepEqual(
    day.seedOffers.map(({ rate }) => rate),
    [104.25],
  );
  f.configure((cfg) => {
    cfg.crops.moonflower.seedPrice = 500;
    cfg.crops.clover.salePrice = 50;
  });
  const buy = {
    kind: "merchant_buy",
    eventId: day.id,
    cropId: "moonflower",
    quantity: 2,
    price: 209,
  };
  assert.equal(f.act(buy, actor).price, 209);
  assert.equal(f.act({ ...buy, quantity: 1, price: 104 }).price, 104);
  assert.equal(f.read().seeds.moonflower, 3);
  assert.throws(() => f.act({ ...buy, price: 208 }), /GARDEN_PRICE_CHANGED/);
  const planted = f.act({ kind: "plant", plot: 1, cropId: "clover" });
  f.advance(HOUR);
  const { harvestId } = f.act({
    kind: "harvest",
    plot: 1,
    plantId: planted.plantId,
  });
  assert.equal(
    f.act(
      {
        kind: "merchant_sell",
        eventId: day.id,
        harvestId,
        quantity: 1,
        price: 35,
      },
      actor,
    ).eventId,
    day.id,
  );
  f.advance(DAY - HOUR);
  assert.throws(() => f.act(buy), /GARDEN_EVENT_EXPIRED/);
  assert.equal(f.read().day, 2);
  assert.equal(f.garden.calendar.events.get(1).status, "expired");
  assert.notEqual(f.read().event.id, day.id);
  assert.ok(
    f
      .read()
      .activity.some(
        (record) =>
          record.result.eventId === day.id && record.action === "merchant_sell",
      ),
  );
});

test("cross-day thief loss is bounded and updates the balance before the next condition check", (t) => {
  const s = rules("thief", { coinLoss: 80 });
  s.initialBalance = 330;
  const f = setup(t, s);
  assert.equal(f.read().event.kind, "thief");
  f.advance(3 * DAY);
  assert.equal(f.read().balance, 250);
  assert.equal(f.read().event, null);
  assert.equal(f.garden.calendar.events.get(1).status, "missed");
  assert.deepEqual(f.garden.calendar.events.get(1).outcome, { coins: 80 });
  assert.equal(f.garden.calendar.events.get(2), null);
  assert.equal(
    f.read().ledger.filter(({ action }) => action === "thief_loss").length,
    1,
  );
});

test("thief prefers one bounded harvest loss, and the first chase wins without duplicate rewards", async (t) => {
  const s = rules("thief", { cropLoss: 5 });
  const f = setup(t, s);
  const { plantId } = f.act({ kind: "plant", plot: 1, cropId: "clover" });
  f.advance(HOUR);
  f.act({ kind: "harvest", plot: 1, plantId });
  f.advance(DAY - HOUR);
  assert.equal(f.read().harvests.length, 0);
  assert.equal(f.read().balance, 1000);
  assert.equal(f.garden.calendar.events.get(1).outcome.quantity, 1);
  const action = { kind: "chase_thief", eventId: f.read().event.id };
  const requestId = randomUUID();
  const results = await Promise.allSettled([
    Promise.resolve().then(() => f.act(action, actor, requestId)),
    Promise.resolve().then(() => f.act(action)),
  ]);
  assert.equal(results[0].value.reward, 15);
  assert.equal(results[1].reason.message, "GARDEN_EVENT_HANDLED");
  assert.equal(f.act(action, actor, requestId).replayed, true);
  assert.equal(f.read().balance, 1015);
});

test("lucky visitor remains available after public reads, is collected once, and stores a usable fertilizer credit", async (t) => {
  const f = setup(
    t,
    rules("visitor", { reward: { kind: "fertilizer_credit", quantity: 1 } }),
  );
  assert.equal(f.read().event.status, "open");
  const claims = await Promise.all([
    Promise.resolve().then(() => f.claim(actor)),
    Promise.resolve().then(() => f.claim()),
  ]);
  assert.equal(claims[0].event.actor.id, actor.id);
  assert.equal(claims[1].event.actor.id, actor.id);
  assert.equal(f.read().fertilizerCredits, 1);
  const { plantId } = f.act({
    kind: "plant",
    plot: 1,
    cropId: "radish",
    buyPrice: 30,
  });
  assert.equal(f.act({ kind: "fertilize", plot: 1, plantId }).usedCredit, true);
  assert.equal(f.read().fertilizerCredits, 0);
  f.advance(2 * DAY);
  assert.equal(f.read().day, 3);
  assert.equal(f.garden.calendar.events.get(2).status, "expired");
  assert.equal(f.read().event.status, "open");
});

test("recipient sees authoritative gift evidence in a subject turn and can cite it in a private diary; export isolates roles", async (t) => {
  const cfg = config(2);
  cfg.agents[0].subject.enabled = true;
  cfg.agents[1].subject.enabled = true;
  let f, result;
  const roleId = "agent-1";
  f = fixture(t, {
    cfg,
    run: async (p) => {
      const gifts = await p.callTool("garden_read", { view: "gifts" });
      assert.match(p.prompt, /你收到的花园礼物/);
      const { evidenceId } = gifts.items[0];
      const diary = await p.callTool("diary_write", {
        title: "收到花园收成",
        body: "今天收到共享花园里的三叶草。",
        evidence: [evidenceId],
      });
      result = { diary, evidenceId };
    },
  });
  const { runtime: r, store } = f;
  let now = Date.UTC(2026, 0, 1);
  r.clock = () => now;
  const garden = r.home.garden;
  garden.initialize(now, rules("merchant", { harvests: ["clover"] }));
  garden.syncClock(now, true);
  const { plantId } = performGardenAction(r, admin, {
    requestId: randomUUID(),
    action: { kind: "plant", plot: 1, cropId: "clover" },
  });
  now += HOUR;
  garden.syncClock(now, true);
  const { harvestId } = performGardenAction(r, admin, {
    requestId: randomUUID(),
    action: { kind: "harvest", plot: 1, plantId },
  });
  const payload = {
    requestId: randomUUID(),
    action: {
      kind: "gift",
      harvestId,
      quantity: 1,
      recipient: { kind: "agent", id: roleId },
    },
  };
  const gift = performGardenAction(r, actor, payload);
  assert.equal(performGardenAction(r, actor, payload).giftId, gift.giftId);
  assert.equal((await r.wake(roleId, "@subject")).status, "completed-no-send");
  const { diary, evidenceId } = result;
  const backup = path.join(f.root, "gift-backup.sqlite");
  assert.equal((await backupDatabase(store.file, backup)).integrity, "ok");
  const restored = new MemoryStore(backup);
  t.after(() => restored.close());
  assert.equal(
    restored.db
      .prepare("SELECT kind FROM events WHERE agent_id=? AND id=?")
      .get(roleId, evidenceId).kind,
    "garden.gift",
  );
  assert.ok(
    restored.db
      .prepare("SELECT id FROM garden_gifts WHERE id=?")
      .get(gift.giftId),
  );
  assert.deepEqual(
    store.bind(roleId).readRecord({ id: diary.id }).metadata.evidence,
    [evidenceId],
  );
  assert.throws(
    () => store.bind(actor.id).readRecord({ id: evidenceId }),
    /RECORD_NOT_FOUND/,
  );
  const pub = await r.callTool(
    context(r, actor.id, "private:30000"),
    "garden_read",
    { view: "public" },
  );
  assert.ok(!JSON.stringify(pub).includes(gift.giftId));
  await assert.rejects(
    r.callTool(context(r, actor.id, "private:30000"), "garden_read", {
      view: "gifts",
    }),
    /TOOL_DISABLED/,
  );
  for (const agentId of [roleId, actor.id])
    await withExport(store, agentId, async ({ path: file }) => {
      const exported = await readFile(file, "utf8");
      assert.equal(exported.includes(evidenceId), agentId === roleId);
      assert.ok(!exported.includes("garden_reward_stock"));
    });
});

for (const speed of [1, 4]) {
  test(`event, delegation, garden clock and backup resume together at ${speed}×`, async (t) => {
    const cfg = config(2);
    cfg.agents[0].ownerIds = ["30000"];
    Object.assign(cfg.agents[0].subject, { enabled: true, inboxEnabled: true });
    let f, request;
    const agentId = cfg.agents[0].id;
    const nowStart = Date.UTC(2026, 0, 1);
    f = fixture(t, {
      cfg,
      run: async (p) => {
        if (p.conversation !== "private:30000" || request) return;
        const m = f.store.bind(agentId);
        const eventId = m.db
          .prepare(
            "SELECT id FROM events WHERE agent_id=? AND kind='message.received' ORDER BY seq DESC LIMIT 1",
          )
          .get(agentId).id;
        request = await p.callTool("garden_act", {
          kind: "delegate_water",
          requestId: randomUUID(),
          args: { eventId, plot: 2 },
        });
      },
    });
    let now = nowStart;
    const r = f.runtime,
      garden = r.home.garden;
    r.clock = () => new Date(now);
    const settings = rules("thief");
    settings.speed = speed;
    settings.delegationHours = 4;
    settings.roles = { [agentId]: r.home.generation(agentId) };
    settings.startingWater = 10;
    garden.initialize(now, settings);
    garden.syncClock(now, true);
    performGardenAction(r, admin, {
      requestId: randomUUID(),
      action: { kind: "shelter", plot: 1 },
    });
    performGardenAction(r, actor, {
      requestId: randomUUID(),
      action: { kind: "plant", plot: 2, cropId: "clover" },
    });
    now += (22 * HOUR) / speed;
    garden.syncClock(now, true);
    await r.ingest(
      "qq-0",
      raw(1, {
        message_type: "private",
        group_id: undefined,
        time: now / 1000,
      }),
    );
    await settle(r);
    if (!request) await r.wake(agentId, "private:30000");
    assert.equal(request.status, "queued");
    const event = garden.read(now).event;
    garden.syncClock(now, false);
    now += DAY;
    const frozen = adminGardenView(r);
    assert.equal(frozen.dayRemaining, 2 * HOUR);
    assert.equal(frozen.event.id, event.id);
    assert.equal(r.subjectInbox.dispatch(r.agent(agentId)), false);
    const copy = path.join(f.root, "copy.sqlite");
    await backupDatabase(f.store.file, copy);
    const restored = new MemoryStore(copy);
    t.after(() => restored.close());
    const reopened = new GardenService(restored);
    const paused = reopened.read(now);
    assert.equal(paused.running, false);
    assert.equal(paused.settings.speed, speed);
    assert.equal(paused.settings.roles[agentId], settings.roles[agentId]);
    assert.equal(paused.event.id, event.id);
    assert.equal(paused.plots[0].sheltered, true);
    const saved = () =>
      restored.db
        .prepare(
          "SELECT expires_clock,status FROM garden_delegations WHERE id=?",
        )
        .get(request.id);
    assert.equal(saved().status, "queued");
    assert.equal(saved().expires_clock, 26 * HOUR);
    reopened.syncClock(now, true);
    now += (2 * HOUR) / speed;
    reopened.syncClock(now, true);
    const next = reopened.read(now);
    assert.equal(next.day, 2);
    assert.equal(reopened.calendar.events.get(1).status, "missed");
    assert.throws(
      () =>
        reopened.act(now, admin, {
          requestId: randomUUID(),
          action: { kind: "chase_thief", eventId: event.id },
        }),
      /GARDEN_EVENT_EXPIRED/,
    );
    now += (2 * HOUR) / speed;
    reopened.syncClock(now, true);
    assert.equal(reopened.read(now).clock, saved().expires_clock);
    garden.syncClock(now - (4 * HOUR) / speed, true);
    garden.syncClock(now, true);
    const status = await r.callTool(
      context(r, agentId, "private:30000"),
      "garden_act",
      {
        kind: "delegate_status",
        requestId: randomUUID(),
        args: { delegationId: request.id },
      },
    );
    assert.equal(status.status, "expired");
  });
}

test("a merchant without any trading stock has no trial or daily draw probability", (t) => {
  const settings = rules("merchant");
  settings.events.entries.merchant.effect.fertilizerOffers = [];
  settings.events.entries.merchant.effect.giftOffers = [];
  for (const id of settings.events.entries.merchant.effect.seeds)
    settings.crops[id].enabled = false;
  const f = setup(t, settings),
    state = f.read();
  const odds = f.garden.calendar.events.trial(
    state,
    { balance: 300, seeds: {}, harvests: {}, fertilizer: 0, previous: null },
    undefined,
    state.weather,
  );
  assert.equal(odds.rows.find((row) => row.id === "merchant").probability, 0);
  assert.equal(odds.noEvent, 1);
  assert.equal(state.event, null);
});

test("the default pool includes previous presets and gates weather, stock, and weekend entries", () => {
  const settings = defaultGardenSettings();
  assert.equal(Object.keys(settings.events.entries).length, 61);
  const ctx = {
    day: 6,
    balance: 401,
    seeds: {},
    harvests: { strawberry: 1, moonflower: 2 },
    fertilizer: 0,
    previous: { weather: { kind: "sun" } },
    plots: [],
  };
  const eligible = (weather, context = ctx) =>
    Object.fromEntries(
      eventOdds(settings, context, settings.weather.entries[weather]).rows.map(
        ({ id, reason }) => [id, reason],
      ),
    );
  const sunny = eligible("sun");
  assert.equal(sunny["sunny-market"], null);
  assert.equal(sunny["rain-merchant"], "conditions");
  assert.equal(sunny["clearance-oldman"], "conditions");
  assert.equal(sunny["hedgehog-thief"], null);
  assert.equal(sunny["banquet-buyer"], null);
  assert.equal(sunny["mystery-seed-bag"], null);
  assert.equal(
    eligible("sun", { ...ctx, day: 8 })["mystery-seed-bag"],
    "conditions",
  );
  const rainy = eligible("storm");
  assert.equal(rainy["rain-merchant"], null);
  assert.equal(rainy["weather-blunder"], null);
  assert.equal(rainy["snail-express"], null);
  assert.equal(rainy["sunny-market"], "conditions");
});

test("targeted thief takes only matching crops and leaves the cash untouched after they sell out", (t) => {
  const settings = rules("hedgehog-thief");
  const f = setup(t, settings);
  const insert = f.store.db.prepare(
    "INSERT INTO garden_harvests (id,crop_id,planted_by,quality,quantity,harvested_at,last_use) VALUES(?,?,?,?,?,?,NULL)",
  );
  const ordinary = randomUUID();
  const strawberry = randomUUID();
  insert.run(ordinary, "clover", "owner", "ordinary", 3, 0);
  insert.run(strawberry, "strawberry", "owner", "ordinary", 3, 0);
  f.advance(DAY);
  assert.equal(f.read().event.kind, "thief");
  f.act({ kind: "sell", harvestId: strawberry, quantity: 3, price: 870 });
  const balance = f.read().balance;
  f.advance(DAY);
  assert.equal(f.read().balance, balance);
  assert.equal(f.read().harvests[0].quantity, 3);
  assert.deepEqual(f.garden.calendar.events.get(2).outcome, { empty: true });
});

test("weather blunder changes live water at noon, keeps storm forecasts, and ends without storm damage", (t) => {
  const settings = rules("weather-blunder");
  settings.weather = fixedWeather("storm");
  settings.crops.clover.hours = 100;
  settings.careMode = "classic";
  settings.crops.clover.floodDays = 1;
  const f = setup(t, settings);
  f.act({ kind: "plant", plot: 1, cropId: "clover" });
  f.advance(12 * HOUR - 60_000);
  assert.equal(f.read().weather.kind, "storm");
  assert.equal(
    gardenPublicSnapshot(f.read(), { running: true, now: 0 }).plots[0].risk,
    "waterlogging",
  );
  f.advance(60_000);
  assert.equal(f.read().weather.kind, "sun");
  assert.equal(
    gardenPublicSnapshot(f.read(), { running: true, now: 0 }).plots[0].risk,
    undefined,
  );
  assert.equal(f.read().weatherForecast.kind, "storm");
  assert.equal(f.read().plots[0].plant.water, 100);
  f.advance(60_000);
  assert.ok(f.read().plots[0].plant.water < 100);
  f.advance(12 * HOUR - 60_000);
  assert.equal(f.read().plots[0].plant.status, "growing");
  assert.equal(f.read().plots[0].plant.floodDays, 0);
  assert.equal(f.garden.calendar.latest().kindStreak, 2);
});

test("aphids slow new plantings through the time of treatment and damage untreated plants at day end", (t) => {
  const settings = rules("aphid-squad");
  settings.crops.clover.hours = 100;
  const f = setup(t, settings);
  f.act({ kind: "plant", plot: 1, cropId: "clover" });
  f.advance(DAY);
  assert.equal(f.read().plots[0].plant.growth, 24);
  f.act({ kind: "plant", plot: 2, cropId: "clover" });
  f.advance(15 * HOUR);
  const event = f.read().event;
  assert.equal(f.read().plots[1].plant.growth, 7.5);
  assert.equal(f.act({ kind: "resolve_event", eventId: event.id }).cost, 10);
  f.advance(9 * HOUR);
  assert.equal(f.read().plots[1].plant.growth, 16.5);
  assert.equal(f.garden.calendar.events.get(2).handledAt, DAY + 15 * HOUR);
  f.advance(DAY);
  assert.equal(f.read().plots[1].plant.qualityAdjustment, -10);
  assert.equal(f.garden.calendar.events.get(3).status, "missed");
});

test("day-start meteor grants actual growth and quality once and leaves already mature crops alone", (t) => {
  const settings = rules("meteor-shower");
  settings.crops.radish.hours = 27;
  const f = setup(t, settings);
  f.act({ kind: "plant", plot: 1, cropId: "clover" });
  f.act({ kind: "plant", plot: 2, cropId: "radish", buyPrice: 30 });
  f.advance(DAY);
  const { event, plots } = f.read();
  assert.equal(plots[0].plant.quality, "ordinary");
  assert.equal(plots[1].plant.quality, "fine");
  assert.deepEqual(
    event.outcome.plots.map(({ plotId, quality, growth }) => [
      plotId,
      quality,
      growth,
    ]),
    [[2, 15, 3]],
  );
  assert.deepEqual(f.read().event.outcome, event.outcome);
});

test("golden earthworm attaches to the initial plant across days and takes precedence over a public credit", (t) => {
  const settings = rules("golden-earthworm");
  settings.crops.radish.hours = 150;
  const f = setup(t, settings);
  const { plantId } = f.act({
    kind: "plant",
    plot: 1,
    cropId: "radish",
    buyPrice: 30,
  });
  f.store.db
    .prepare("UPDATE garden_reward_stock SET fertilizer_credits=1")
    .run();
  f.advance(DAY);
  assert.equal(f.read().event.outcome.plantId, plantId);
  f.advance(DAY);
  const fertilized = f.act({ kind: "fertilize", plot: 1, plantId });
  assert.equal(fertilized.usedEarthworm, true);
  assert.equal(f.read().fertilizerCredits, 1);
  assert.equal(f.garden.calendar.events.get(2).outcome.used, true);
});

test("sketch reevaluates live crops and awards once; twin doubles only the first successful harvest", (t) => {
  const sketch = setup(t, rules("sketch-contest"));
  const action = { kind: "resolve_event", eventId: sketch.read().event.id };
  assert.throws(() => sketch.act(action), /GARDEN_EVENT_OFFER/);
  sketch.act({ kind: "plant", plot: 1, cropId: "clover" });
  sketch.act({ kind: "plant", plot: 2, cropId: "radish", buyPrice: 30 });
  sketch.act({ kind: "plant", plot: 3, cropId: "mint", buyPrice: 50 });
  assert.deepEqual(sketch.read().event.progress, { current: 3, required: 3 });
  assert.equal(sketch.act(action).reward, 80);
  assert.throws(() => sketch.act(action), /GARDEN_EVENT_HANDLED/);

  const twin = setup(t, rules("twin-fruit"));
  const first = twin.act({ kind: "plant", plot: 1, cropId: "clover" });
  const second = twin.act({ kind: "plant", plot: 2, cropId: "clover" });
  const harvest = { kind: "harvest", plot: 1, plantId: first.plantId };
  assert.throws(() => twin.act(harvest), /GARDEN_PLANT_STATE/);
  twin.advance(HOUR);
  const receipt = twin.act(harvest);
  assert.equal(receipt.quantity, 2);
  assert.equal(
    twin.act({ kind: "harvest", plot: 2, plantId: second.plantId }).quantity,
    1,
  );
  assert.equal(
    twin.read().harvests.find(({ id }) => id === receipt.harvestId).quantity,
    2,
  );
});

test("seed bags preserve enabled candidates and crop rules across days, failures, and receipt replay", (t) => {
  const settings = rules("mystery-seed-bag");
  for (const [id, crop] of Object.entries(settings.crops))
    crop.enabled = id === "clover";
  const f = setup(t, settings);
  f.act({ kind: "plant", plot: 1, cropId: "clover" });
  f.advance(5 * DAY);
  const event = f.read().event;
  const buy = {
    kind: "buy_mystery_seed",
    eventId: event.id,
    quantity: 2,
    price: 50,
  };
  const requestId = randomUUID();
  f.act(buy, admin, requestId);
  assert.equal(f.act(buy, admin, requestId).replayed, true);
  assert.throws(
    () => f.act({ ...buy, quantity: 1, price: 25 }),
    /GARDEN_STOCK_UNAVAILABLE/,
  );
  assert.deepEqual(f.read().mysterySeeds.bags[0].candidates, [
    { cropId: "clover", name: settings.crops.clover.name },
  ]);
  f.configure((cfg) => {
    cfg.crops.clover.hours = 500;
    cfg.startingWater = 10;
  });
  f.advance(DAY);
  const blocked = { kind: "plant_mystery_seed", plot: 1 };
  assert.throws(() => f.act(blocked), /GARDEN_PLOT_OCCUPIED/);
  assert.equal(f.read().mysterySeeds.count, 2);
  const plant = { ...blocked, plot: 2 };
  const plantRequest = randomUUID();
  const receipt = f.act(plant, admin, plantRequest);
  assert.equal(receipt.cropId, "clover");
  assert.equal(f.act(plant, admin, plantRequest).bagId, receipt.bagId);
  assert.equal(f.read().plots[1].plant.crop.hours, 1);
  assert.equal(f.read().plots[1].plant.water, 75);
  assert.equal(f.read().mysterySeeds.count, 1);
});

test("stray cat uses shelters still in place at day end and chasing preserves them", (t) => {
  const f = setup(t, rules("stray-cat"));
  f.act({ kind: "shelter", plot: 1 });
  f.advance(DAY);
  assert.equal(f.read().event.kind, "nuisance");
  f.act({ kind: "unshelter", plot: 1 });
  f.act({ kind: "shelter", plot: 2 });
  f.advance(DAY);
  assert.equal(f.read().plots[1].sheltered, false);
  assert.deepEqual(f.garden.calendar.events.get(2).outcome, {
    plotId: 2,
    sheltered: false,
  });
  f.act({ kind: "shelter", plot: 2 });
  f.advance(DAY);
  assert.equal(
    f.act({ kind: "resolve_event", eventId: f.read().event.id }).reward,
    10,
  );
  f.advance(DAY);
  assert.equal(f.read().plots[1].sheltered, true);
});

test("public views do not create firefly evidence; one private observation is reusable in a diary", async (t) => {
  const cfg = config(1);
  const roleId = cfg.agents[0].id;
  cfg.agents[0].subject.enabled = true;
  let evidenceId;
  const f = fixture(t, {
    cfg,
    run: async (p) => {
      const pub = await p.callTool("garden_read", { view: "public" });
      assert.equal(pub.event.observation, undefined);
      assert.equal(count(), 0);
      const first = await p.callTool("garden_read", { view: "overview" });
      const second = await p.callTool("garden_read", { view: "overview" });
      evidenceId = first.event.observation.evidenceId;
      assert.equal(second.event.observation.evidenceId, evidenceId);
      const diary = await p.callTool("diary_write", {
        title: "花园夜晚",
        body: "我看了萤火虫音乐会。",
        evidence: [evidenceId],
      });
      assert.deepEqual(
        f.store.bind(roleId).readRecord({ id: diary.id }).metadata.evidence,
        [evidenceId],
      );
    },
  });
  const { runtime, store } = f;
  function count() {
    return store.db
      .prepare(
        "SELECT COUNT(*) AS count FROM events WHERE kind='garden.observation'",
      )
      .get().count;
  }
  const now = Date.UTC(2026, 0, 1);
  runtime.clock = () => now;
  const garden = runtime.home.garden;
  const settings = rules("firefly-concert");
  settings.roles[roleId] = runtime.home.generation(roleId);
  garden.initialize(now, settings);
  garden.syncClock(now, true);
  assert.equal(
    (await runtime.wake(roleId, "@subject")).status,
    "completed-no-send",
  );
  assert.equal(count(), 1);
  assert.ok(evidenceId);
});

test("configured merchant garden and buyback slots freeze quotes separately", (t) => {
  const f = setup(t, rules("merchant"));
  const event = f.read().event;
  assert.equal(event.seedOffers.length, 5);
  assert.equal(event.offers.length, 2);
  assert.equal(
    event.seedOffers.every(
      ({ discount, originalRate, rate }) => rate === originalRate * discount,
    ),
    true,
  );
  assert.equal(
    f.act({
      kind: "merchant_buy_fertilizer",
      eventId: event.id,
      quantity: 2,
      price: 40,
    }).price,
    40,
  );
  assert.equal(f.read().fertilizer, 2);
  const offer = event.offers[1];
  const harvestId = randomUUID();
  f.store.db
    .prepare(
      "INSERT INTO garden_harvests (id,crop_id,planted_by,quality,quantity,harvested_at,last_use) VALUES(?,?,?,?,?,?,NULL)",
    )
    .run(harvestId, offer.cropId, "owner", "fine", 2, 0);
  f.configure((settings) => {
    settings.fertilizerPrice = 500;
    settings.crops[offer.cropId].salePrice = 10;
  });
  const price = Math.round(2 * offer.rates.fine);
  assert.equal(
    f.act({
      kind: "merchant_sell",
      eventId: event.id,
      harvestId,
      quantity: 2,
      price,
    }).price,
    price,
  );
  assert.equal(f.read().event.fertilizerOffers[0].rate, 20);
});

test("backup retains unopened bag order, frozen crop rules and one reproducible draw across plots", async (t) => {
  const { root } = fixture(t);
  const file = path.join(root, "portable-garden.sqlite");
  const original = new MemoryStore(file);
  t.after(() => original.close());
  const garden = new GardenService(original);
  const settings = rules("mystery-seed-bag");
  const boughtAt = 5 * DAY;
  garden.initialize(0, settings);
  garden.syncClock(0, true);
  garden.syncClock(boughtAt, true);
  const buy = {
    kind: "buy_mystery_seed",
    eventId: garden.read(boughtAt).event.id,
    quantity: 2,
    price: 50,
  };
  const receipt = { requestId: randomUUID(), action: buy };
  garden.act(boughtAt, admin, receipt);
  const copy = path.join(root, "portable-copy.sqlite");
  await backupDatabase(file, copy);
  const restored = new MemoryStore(copy);
  t.after(() => restored.close());
  const reopened = new GardenService(restored);
  reopened.syncClock(boughtAt, true);
  assert.equal(reopened.act(boughtAt, admin, receipt).replayed, true);
  const open = (g, plot) =>
    g.act(boughtAt, admin, {
      requestId: randomUUID(),
      action: { kind: "plant_mystery_seed", plot },
    });
  const first = open(garden, 1);
  const retriedElsewhere = open(reopened, 9);
  assert.equal(first.bagId, retriedElsewhere.bagId);
  assert.equal(first.cropId, retriedElsewhere.cropId);
  assert.equal(reopened.read(boughtAt).mysterySeeds.count, 1);
});

test("repeated reads and a bulk catch-up produce the same weather flip day boundaries", (t) => {
  const settings = rules("weather-blunder");
  settings.weather = fixedWeather("storm");
  settings.crops.clover.hours = 250;
  const bulk = setup(t, settings);
  const steps = setup(t, settings);
  for (const f of [bulk, steps])
    f.act({ kind: "plant", plot: 1, cropId: "clover" });
  for (let i = 0; i < 14; i++) {
    steps.advance(6 * HOUR);
    steps.read();
  }
  bulk.advance(14 * 6 * HOUR);
  const state = (f) => {
    const { id, ...plant } = f.read().plots[0].plant;
    return plant;
  };
  assert.deepEqual(state(bulk), state(steps));
  assert.equal(bulk.read().day, 4);
  assert.equal(bulk.read().weather.kind, "sun");
});

test("legacy saves without an events setting retain the legacy pool alongside story presets", (t) => {
  const f = setup(t, rules("thief"));
  const prior = f.read().event;
  f.store.db
    .prepare(
      "UPDATE garden_state SET settings=json_remove(settings, '$.events') WHERE id=1",
    )
    .run();
  f.store.db.prepare("DELETE FROM garden_story_presets").run();
  const reopened = new GardenService(f.store);
  const state = reopened.read(0);
  assert.deepEqual(Object.keys(state.settings.events.entries).slice(0, 3), [
    "merchant",
    "thief",
    "visitor",
  ]);
  assert.equal(Object.keys(state.settings.events.entries).length, 11);
  assert.equal(state.settings.events.entries.merchant.effect.offers, 2);
  assert.deepEqual(state.event, prior);
});

test("default gift shelves draw three to five different catalog gifts per day with two to three of each", () => {
  const settings = rules("merchant");
  const ctx = { harvests: {} };
  const draw = (day) => drawGardenEvent(settings, ctx, null, "gift-shelf", day);
  const seenIds = new Set();
  const seenCounts = new Set();
  const seenStocks = new Set();
  for (let day = 1; day <= 64; day++) {
    const { giftOffers } = draw(day);
    assert.deepEqual(draw(day).giftOffers, giftOffers);
    assert.equal(
      new Set(giftOffers.map(({ giftId }) => giftId)).size,
      giftOffers.length,
    );
    seenCounts.add(giftOffers.length);
    for (const { giftId, originalPrice, stock, ...gift } of giftOffers) {
      assert.deepEqual(gift, gardenGifts[giftId]);
      assert.equal(originalPrice, gift.price);
      seenStocks.add(stock);
      seenIds.add(giftId);
    }
  }
  assert.deepEqual(seenCounts, new Set([3, 4, 5]));
  assert.deepEqual(seenStocks, new Set([2, 3]));
  assert.deepEqual(
    seenIds,
    new Set(Object.keys(gardenGifts).filter(isGardenMerchantGift)),
  );
});

test("configured and default gift shelves can open with all of a merchant's seeds disabled", (t) => {
  for (const giftOffers of [
    undefined,
    [{ giftId: "dried-fish", price: 13, stock: 1 }],
    Object.keys(gardenGifts)
      .filter(isGardenMerchantGift)
      .map((giftId) => ({ giftId, stock: 2 })),
  ]) {
    const settings = rules("merchant");
    const { effect } = settings.events.entries.merchant;
    effect.fertilizerOffers = [];
    effect.giftOffers = giftOffers;
    for (const id of effect.seeds) settings.crops[id].enabled = false;
    const f = setup(t, settings);
    const { event } = f.read();
    assert.equal(event.kind, "merchant");
    assert.deepEqual(event.seedOffers, []);
    if (giftOffers)
      assert.deepEqual(
        event.giftOffers.map(({ giftId, price, stock }) => ({
          giftId,
          price,
          stock,
        })),
        giftOffers.map((offer) => ({
          price: gardenGifts[offer.giftId].price,
          ...offer,
        })),
      );
    else assert.ok(event.giftOffers.length >= 3);
    assert.deepEqual(new GardenService(f.store).read(0).event, event);
  }
});

test("ordinary merchant fixed offers reject event keepsakes", () => {
  const { events } = rules("merchant");
  for (const [giftId] of Object.entries(gardenGifts).filter(
    ([id]) => !isGardenMerchantGift(id),
  )) {
    events.entries.merchant.effect.giftOffers = [{ giftId, stock: 2 }];
    assert.equal(eventPool.safeParse(events).success, false);
  }
});

test("an explicitly empty gift shelf stays empty", (t) => {
  const f = setup(t, rules("merchant", { giftOffers: [] }));
  assert.equal(f.read().event.kind, "merchant");
  assert.deepEqual(f.read().event.giftOffers, []);
});

test("restart retains day-start blessing, a claimed sketch, and the frozen forecast change", (t) => {
  const meteorRules = rules("meteor-shower");
  meteorRules.crops.radish.hours = 27;
  const meteor = setup(t, meteorRules);
  meteor.act({ kind: "plant", plot: 1, cropId: "radish", buyPrice: 30 });
  meteor.advance(DAY);
  const expected = meteor.read();
  const meteorReopened = new GardenService(meteor.store).read(DAY);
  assert.equal(meteorReopened.plots[0].plant.quality, "fine");
  assert.deepEqual(meteorReopened.event, expected.event);

  const sketch = setup(t, rules("sketch-contest"));
  sketch.act({ kind: "plant", plot: 1, cropId: "clover" });
  sketch.act({ kind: "plant", plot: 2, cropId: "radish", buyPrice: 30 });
  sketch.act({ kind: "plant", plot: 3, cropId: "mint", buyPrice: 50 });
  const action = { kind: "resolve_event", eventId: sketch.read().event.id };
  const requestId = randomUUID();
  sketch.act(action, admin, requestId);
  const sketchReopened = new GardenService(sketch.store);
  sketchReopened.syncClock(0, true);
  assert.equal(
    sketchReopened.act(0, admin, { action, requestId }).replayed,
    true,
  );
  assert.throws(
    () => sketchReopened.act(0, admin, { action, requestId: randomUUID() }),
    /GARDEN_EVENT_HANDLED/,
  );
  assert.equal(sketchReopened.read(0).balance, 1000);

  const weatherRules = rules("weather-blunder");
  weatherRules.weather = fixedWeather("storm");
  const flip = setup(t, weatherRules);
  flip.advance(11 * HOUR);
  const oldSun = flip.read().event.targetWeather;
  flip.configure((cfg) => {
    cfg.weather.entries.sun.demand = 10;
  });
  const flipReopened = new GardenService(flip.store);
  flipReopened.syncClock(11 * HOUR, true);
  flipReopened.syncClock(12 * HOUR, true);
  const after = flipReopened.read(12 * HOUR);
  assert.deepEqual(after.weather, oldSun);
  assert.equal(after.weatherForecast.kind, "storm");
  assert.equal(after.weather.demand, 1.5);
});
