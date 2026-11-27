import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { DAY, HOUR, defaultGardenSettings } from "../src/home/garden-rules.mjs";
import { GardenService } from "../src/home/garden-service.mjs";
import { MemoryStore } from "../src/memory/store.mjs";
import { fixedWeather } from "./garden-fixtures.mjs";

const admin = { kind: "admin", id: "administrator" };

function setup(t, customize = () => {}) {
  const store = new MemoryStore(":memory:");
  t.after(() => store.close());
  let now = 0;
  let garden = new GardenService(store);
  const settings = defaultGardenSettings();
  settings.weather = fixedWeather();
  settings.events.rate = 0;
  customize(settings);
  garden.initialize(now, settings);
  garden.syncClock(now, true);
  const act = (action, requestId = randomUUID()) =>
    garden.act(now, admin, { action, requestId });
  return {
    store,
    get garden() {
      return garden;
    },
    act,
    read: () => garden.read(now),
    plant: (plot, cropId) =>
      act({
        kind: "plant",
        plot,
        cropId,
        buyPrice: settings.crops[cropId].seedPrice,
      }),
    harvest: (plot, plantId) => act({ kind: "harvest", plot, plantId }),
    advance(hours) {
      now += hours * HOUR;
      garden.syncClock(now, true);
    },
    reopen() {
      garden.syncClock(now, false);
      garden = new GardenService(store);
      garden.syncClock(now, true);
    },
  };
}

test("plot identity survives tomato regrowth, while each harvest and the first variety are counted", (t) => {
  const f = setup(t, (settings) => {
    settings.crops.tomato.hours = 8;
    settings.crops.tomato.dailyWater = 0;
  });
  assert.equal(f.garden.almanac().unlocked, 0);
  assert.ok(!JSON.stringify(f.garden.almanac()).includes("太阳莓"));
  const planted = f.plant(1, "tomato");
  const publicFact = f.garden.timeline(
    { factId: planted.surprise.factId },
    { publicView: true },
  ).entries[0];
  assert.equal(planted.surprise.kind, "almanac_unlock");
  assert.equal(publicFact.type, "almanac");
  f.advance(8);
  const action = { kind: "harvest", plot: 1, plantId: planted.plantId };
  const request = randomUUID();
  assert.equal(f.act(action, request).regrowing, true);
  assert.equal(f.act(action, request).replayed, true);
  f.reopen();
  f.advance(4);
  f.harvest(1, planted.plantId);
  f.advance(4);
  f.harvest(1, planted.plantId);
  assert.deepEqual(f.garden.almanac().entries[0], {
    cropId: "tomato",
    name: "小灯笼番茄",
    plantedCount: 1,
    harvestCount: 3,
    bestQuality: "ordinary",
    variants: [],
    firstDiscoveredDay: 1,
  });
});

test("flower color and mutation discoveries keep existing surprises and public almanac evidence", (t) => {
  const f = setup(t, (settings) => {
    settings.weather = fixedWeather("drizzle");
    for (const id of ["hydrangea", "clover"]) {
      settings.crops[id].hours = 4;
      settings.crops[id].dailyWater = 0;
    }
    settings.baseQuality = 100;
  });
  const hydrangea = f.plant(1, "hydrangea").plantId;
  const clover = f.plant(2, "clover").plantId;
  let seed = 0;
  const roll = () =>
    createHash("sha256")
      .update(JSON.stringify([String(seed), clover, "four_leaf_clover"]))
      .digest()
      .readUInt32BE() /
    2 ** 32;
  while (roll() >= 0.2) seed++;
  f.store.db.prepare("UPDATE garden_weather_seed SET seed=?").run(String(seed));
  f.advance(8);
  for (const [plot, plantId] of [
    [1, hydrangea],
    [2, clover],
  ]) {
    const receipt = f.harvest(plot, plantId);
    assert.equal(receipt.surprise.kind, "variant_harvest");
    assert.deepEqual(
      receipt.surprises.map(({ kind }) => kind),
      ["variant_harvest", "almanac_unlock"],
    );
    assert.notEqual(receipt.surprises[0].factId, receipt.surprises[1].factId);
    assert.equal(
      f.garden.timeline(
        { factId: receipt.surprises[1].factId },
        { publicView: true },
      ).entries[0].type,
      "almanac",
    );
  }
  const entries = Object.fromEntries(
    f.garden.almanac().entries.map((entry) => [entry.cropId, entry]),
  );
  assert.equal(entries.clover.harvestCount, 0);
  assert.equal(entries.four_leaf_clover.harvestCount, 1);
  assert.equal(entries.four_leaf_clover.plantedCount, 0);
  assert.equal(entries.four_leaf_clover.bestQuality, "perfect");
  assert.deepEqual(entries.hydrangea.variants, [
    { id: "rain_blue", name: "雨蓝绣球" },
  ]);
});

test("old archives rebuild once from lots and plot records without inventing an unknown first day", (t) => {
  const f = setup(t, (settings) => {
    settings.crops.tomato.hours = 4;
    settings.crops.tomato.dailyWater = 0;
  });
  f.advance(25);
  const plantId = f.plant(1, "tomato").plantId;
  f.advance(4);
  const first = f.harvest(1, plantId);
  f.advance(2);
  f.harvest(1, plantId);
  f.act({ kind: "sell", harvestId: first.harvestId, quantity: 1, price: 120 });
  f.store.db.exec(`
    UPDATE garden_harvests SET plant_id=NULL;
    UPDATE garden_plant_archive SET planted_clock=NULL;
    DELETE FROM garden_facts WHERE type='almanac';
    DELETE FROM garden_almanac;
    DELETE FROM garden_almanac_migration;
  `);
  f.reopen();
  const recovered = f.garden.almanac().entries[0];
  assert.equal(recovered.harvestCount, 2);
  assert.equal(recovered.plantedCount, 1);
  assert.equal(recovered.bestQuality, "ordinary");
  assert.equal(recovered.firstDiscoveredDay, null);
  assert.deepEqual(f.garden.almanac().newlyUnlocked, []);
  f.reopen();
  assert.deepEqual(f.garden.almanac().entries[0], recovered);
});

test("three facilities build atomically, validate quotes and are idempotent", (t) => {
  const f = setup(t, (settings) => {
    settings.initialBalance = 1_200;
  });
  assert.equal(f.read().tomorrowForecast, undefined);
  assert.throws(
    () => f.act({ kind: "build_facility", facilityId: "bird_bath", price: 1 }),
    /GARDEN_PRICE_CHANGED/,
  );
  assert.equal(f.read().balance, 1200);
  for (const [facilityId, price] of [
    ["weather_chime", 280],
    ["bird_bath", 360],
    ["drying_rack", 420],
  ]) {
    const requestId = randomUUID();
    const action = { kind: "build_facility", facilityId, price };
    assert.equal(f.act(action, requestId).builtDay, 1);
    assert.equal(f.act(action, requestId).replayed, true);
    assert.throws(() => f.act(action), /GARDEN_FACILITY_ALREADY_BUILT/);
  }
  f.reopen();
  const state = f.read();
  assert.equal(state.balance, 140);
  assert.ok(state.facilities.every(({ built }) => built));
  assert.equal(
    state.ledger.filter(({ action }) => action === "build_facility").length,
    3,
  );
  assert.ok(state.facilities.every((row) => !("builderId" in row)));
});

test("wind chime accounts for the thief's automatic midnight spending without committing the preview", (t) => {
  const f = setup(t, (settings) => {
    settings.events.rate = 1;
    for (const [id, event] of Object.entries(settings.events.entries))
      event.enabled = id === "thief";
    const sun = settings.weather.entries.sun;
    sun.weight = 1;
    sun.conditions = [{ field: "balance", op: "lt", value: 710 }];
  });
  assert.equal(f.read().event.kind, "thief");
  f.act({ kind: "build_facility", facilityId: "weather_chime", price: 280 });
  const checkpoint = () =>
    [
      "garden_state",
      "garden_days",
      "garden_events",
      "garden_ledger",
      "garden_facts",
      "events",
    ].map((table) =>
      f.store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    );
  const before = checkpoint();
  for (let attempt = 0; attempt < 3; attempt++) {
    const read = f.read();
    assert.equal(read.tomorrowForecast.direction, "sun");
    assert.deepEqual(Object.keys(read.tomorrowForecast).sort(), [
      "direction",
      "hint",
    ]);
    assert.equal(read.balance, 720);
    assert.equal(read.event.status, "open");
    assert.deepEqual(checkpoint(), before);
  }
  f.advance(DAY / HOUR);
  assert.equal(f.read().weather.kind, "sun");
  assert.equal(f.read().balance, 690);
  assert.equal(
    f.read().ledger.filter(({ action }) => action === "thief_loss").length,
    1,
  );
});

test("bird bath multiplies only friendly event weights, boosts butterflies and brings rumors sooner", (t) => {
  const f = setup(t, (settings) => {
    settings.events.rate = 1;
    for (const [id, event] of Object.entries(settings.events.entries))
      event.enabled = id === "thief" || id === "visitor";
    settings.crops.catnip.hours = 4;
    settings.crops.catnip.dailyWater = 0;
  });
  f.plant(1, "catnip");
  const odds = () =>
    Object.fromEntries(
      f.garden.calendar
        .trial(f.garden.requireState(), {}, true)
        .rows.map((row) => [row.id, row.probability]),
    );
  assert.equal(odds().visitor / odds().thief, 2);
  let seed = 0;
  const roll = () =>
    createHash("sha256")
      .update(JSON.stringify([String(seed), "butterflies", 1]))
      .digest()
      .readUInt32BE() /
    2 ** 32;
  while (roll() < 1 / 3 || roll() >= 0.5) seed++;
  f.store.db.prepare("UPDATE garden_weather_seed SET seed=?").run(String(seed));
  f.advance(17);
  assert.equal(f.read().nightScene.butterflies, false);
  f.act({ kind: "build_facility", facilityId: "bird_bath", price: 360 });
  assert.equal(odds().visitor / odds().thief, 3);
  assert.equal(f.read().nightScene.butterflies, true);
  f.advance(3 * 24 - 17);
  assert.deepEqual(
    f
      .read()
      .rumors.filter(({ source }) => source === "calendar")
      .map(({ day }) => day),
    [4],
  );
});

test("first actual neighbor seed lights up the hidden catalog entry before it is sown", (t) => {
  const f = setup(t, (settings) => {
    settings.weather = fixedWeather("sun");
    for (const id of ["sunflower", "strawberry"]) {
      settings.crops[id].hours = 4;
      settings.crops[id].dailyWater = 0;
    }
  });
  f.plant(1, "sunflower");
  f.plant(2, "strawberry");
  f.advance(5 * 24);
  const entry = f.garden
    .almanac()
    .entries.find(({ cropId }) => cropId === "sunberry");
  assert.equal(entry.plantedCount, 0);
  assert.equal(entry.harvestCount, 0);
  assert.ok(entry.firstDiscoveredDay >= 3 && entry.firstDiscoveredDay <= 5);
  assert.equal(
    f.garden.timeline({ type: "almanac", cropId: "sunberry" }).entries.length,
    1,
  );
  f.store.db.exec(`
    DELETE FROM garden_facts WHERE type='almanac';
    DELETE FROM garden_almanac;
    DELETE FROM garden_almanac_migration;
  `);
  f.reopen();
  assert.deepEqual(
    f.garden.almanac().entries.find(({ cropId }) => cropId === "sunberry"),
    entry,
  );
  assert.equal(f.plant(3, "sunberry").surprise, undefined);
  assert.equal(
    f.garden.almanac().entries.find(({ cropId }) => cropId === "sunberry")
      .plantedCount,
    1,
  );
});

test("wind chime previews queued seeds without sending the follow-up early", (t) => {
  const f = setup(t, (settings) => {
    settings.events.rate = 1;
    for (const [id, event] of Object.entries(settings.events.entries))
      event.enabled = id === "hedgehog-share";
    settings.crops.strawberry.hours = 4;
    settings.crops.strawberry.dailyWater = 0;
    const sun = settings.weather.entries.sun;
    sun.weight = 1;
    sun.mode = "any";
    sun.conditions = ["moonflower", "strawberry", "tomato"].map((cropId) => ({
      field: "seed",
      cropId,
      op: "gt",
      value: 0,
    }));
  });
  const plantId = f.plant(1, "strawberry").plantId;
  f.advance(8);
  const { harvestId } = f.harvest(1, plantId);
  f.advance(16);
  f.act({
    kind: "choose_event",
    eventId: "2:hedgehog-share",
    choiceId: "feed",
    harvestId,
  });
  f.act({ kind: "build_facility", facilityId: "weather_chime", price: 280 });
  assert.equal(f.read().tomorrowForecast.direction, "sun");
  assert.equal(f.read().followups.length, 0);
  assert.equal(
    f.store.db.prepare("SELECT status FROM garden_event_followups").get()
      .status,
    "pending",
  );
  assert.deepEqual(f.read().seeds, {});
  f.advance(24);
  assert.equal(f.read().weather.kind, "sun");
  assert.equal(f.read().followups.length, 1);
  assert.equal(
    Object.values(f.read().seeds).reduce((sum, count) => sum + count, 0),
    1,
  );
});
