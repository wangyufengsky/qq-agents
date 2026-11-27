import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { drawGardenEvent, eventOdds } from "../src/home/garden-event-rules.mjs";
import {
  DAY,
  HOUR,
  defaultGardenSettings,
  gardenSettings,
} from "../src/home/garden-rules.mjs";
import { GardenService } from "../src/home/garden-service.mjs";
import { MemoryStore } from "../src/memory/store.mjs";
import { fixedWeather } from "./garden-fixtures.mjs";

const admin = { kind: "admin", id: "administrator" };

function setup(t, rules) {
  const store = new MemoryStore(":memory:");
  t.after(() => store.close());
  const garden = new GardenService(store);
  let now = 0;
  garden.initialize(now, rules);
  garden.syncClock(now, true);
  return {
    store,
    garden,
    act(action, actor = admin) {
      return garden.act(now, actor, { requestId: randomUUID(), action });
    },
    read: () => garden.read(now),
    jump(elapsed) {
      now = elapsed;
      garden.syncClock(now, true);
    },
  };
}

function onlyEvent(id, weather = "cloud") {
  const settings = defaultGardenSettings();
  settings.weather = fixedWeather(weather);
  settings.events.rate = 1;
  for (const [key, entry] of Object.entries(settings.events.entries))
    entry.weight = Number(key === id);
  return settings;
}

test("story presets enforce daily eligibility in the same probability engine used by trial and draw", () => {
  const rules = defaultGardenSettings();
  const plant = { id: "flower", status: "mature", crop: { name: "花" } };
  const plots = [
    { id: 1, plant, sheltered: true },
    { id: 2, plant: { ...plant, id: "second" } },
  ];
  const ctx = {
    day: 2,
    plots,
    harvests: { strawberry: 1 },
    caretakers: { flower: ["admin:a", "agent:b"] },
  };
  const odds = (kind, context) =>
    Object.fromEntries(
      eventOdds(rules, context, rules.weather.entries[kind]).rows.map(
        ({ id, reason, probability }) => [id, { reason, probability }],
      ),
    );
  const sunny = odds("sun", ctx);
  const rain = odds("drizzle", ctx);
  for (const id of [
    "hedgehog-share",
    "sketch-painter",
    "odd-seed-trader",
    "migratory-bird",
    "fence-note",
  ])
    assert.ok(sunny[id].probability > 0 && rain[id].probability > 0, id);
  assert.ok(sunny["garden-tea-party"].probability > 0);
  assert.equal(rain["garden-tea-party"].reason, "story_unavailable");
  assert.ok(rain["rain-cat-shelter"].probability > 0);
  assert.equal(sunny["rain-cat-shelter"].reason, "story_unavailable");
  assert.equal(sunny["full-moon-night"].reason, "story_unavailable");
  assert.equal(
    odds("sun", { ...ctx, day: 14 })["full-moon-night"].probability,
    1,
  );
  assert.equal(odds("sun", { ...ctx, day: 14 }).merchant.probability, 0);
  const empty = odds("storm", { day: 2, plots: [], harvests: {} });
  for (const id of Object.keys(empty).filter(
    (id) =>
      Object.hasOwn(sunny, id) &&
      [
        "hedgehog-share",
        "sketch-painter",
        "odd-seed-trader",
        "migratory-bird",
        "fence-note",
        "rain-cat-shelter",
      ].includes(id),
  ))
    assert.equal(empty[id].reason, "story_unavailable", id);

  const draw = (id) =>
    drawGardenEvent(
      onlyEvent(id),
      ctx,
      rules.weather.entries.cloud,
      "garden",
      2,
    );
  assert.deepEqual(draw("fence-note").target, {
    plot: 1,
    plantId: "flower",
    cropName: "花",
  });
  assert.deepEqual(draw("migratory-bird"), draw("migratory-bird"));
});

test("choice presets accept configured coin costs and validate immediate reward references", () => {
  const rules = defaultGardenSettings();
  const fields = rules.events.entries["rain-cat-shelter"].effect.options[1];
  fields.cost = { kind: "coins", amount: 10 };
  for (const reward of [
    { kind: "seed", cropId: "clover", quantity: 2 },
    { kind: "fertilizer", quantity: 3 },
    { kind: "gift", giftId: "dried-fish" },
  ]) {
    fields.immediateReward = reward;
    assert.equal(gardenSettings.safeParse(rules).success, true);
  }
  fields.immediateReward = { kind: "seed", cropId: "missing", quantity: 1 };
  assert.equal(gardenSettings.safeParse(rules).success, false);
  delete fields.immediateReward;
  fields.cost = { kind: "harvest", cropIds: ["missing"] };
  assert.equal(gardenSettings.safeParse(rules).success, false);
});

test("legacy migration adds each missing story exactly once and retains 40 custom entries", (t) => {
  const { store, garden } = setup(t, onlyEvent("full-moon-night"));
  const { settings } = garden.requireState();
  const old = Object.fromEntries(
    Array.from({ length: 40 }, (_, i) => [
      `custom-${i}`,
      structuredClone(settings.events.entries.visitor),
    ]),
  );
  settings.events.entries = old;
  store.db
    .prepare("UPDATE garden_state SET settings=? WHERE id=1")
    .run(JSON.stringify(settings));
  store.db.prepare("DELETE FROM garden_story_presets").run();
  const reopened = new GardenService(store);
  const expanded = reopened.requireState();
  assert.equal(Object.keys(expanded.settings.events.entries).length, 48);
  for (const [id, entry] of Object.entries(old))
    assert.deepEqual(expanded.settings.events.entries[id], entry);
  delete expanded.settings.events.entries["fence-note"];
  expanded.settings.events.entries["full-moon-night"].enabled = false;
  reopened.configure(0, expanded.settingsRevision, expanded.settings);
  const final = new GardenService(store).requireState().settings.events.entries;
  assert.equal(Object.hasOwn(final, "fence-note"), false);
  assert.equal(final["full-moon-night"].enabled, false);
});

test("a preexisting disabled story ID is preserved during migration", (t) => {
  const { store, garden } = setup(t, onlyEvent("full-moon-night"));
  const { settings } = garden.requireState();
  const disabled = {
    ...settings.events.entries["full-moon-night"],
    enabled: false,
    name: "自定义满月",
  };
  settings.events.entries = { "full-moon-night": disabled };
  store.db
    .prepare("UPDATE garden_state SET settings=? WHERE id=1")
    .run(JSON.stringify(settings));
  store.db.prepare("DELETE FROM garden_story_presets").run();
  const reopened = new GardenService(store);
  assert.deepEqual(
    reopened.requireState().settings.events.entries["full-moon-night"],
    disabled,
  );
  assert.equal(
    Object.keys(reopened.requireState().settings.events.entries).length,
    8,
  );
});

test("a fence review ranks only plants tended by at least two distinct actors", (t) => {
  const rules = onlyEvent("fence-note");
  const f = setup(t, rules);
  const { plantId } = f.act({ kind: "plant", plot: 1, cropId: "clover" });
  const other = f.act({ kind: "plant", plot: 3, cropId: "clover" }).plantId;
  f.jump(HOUR);
  f.act({ kind: "water", plot: 3, plantId: other });
  f.act(
    { kind: "water", plot: 1, plantId },
    { kind: "agent", id: "gardener", turnId: "turn-one" },
  );
  f.jump(DAY);
  assert.deepEqual(f.garden.calendar.events.get(2).target, {
    plot: 1,
    plantId,
    cropName: "野生三叶草",
  });
});

test("a rain shelter choice freezes only its selected plot until day rollover", (t) => {
  const rules = onlyEvent("rain-cat-shelter", "drizzle");
  rules.crops.clover.hours = 72;
  rules.crops.clover.dailyWater = 0;
  rules.crops.clover.lightRates = { low: 1 };
  const f = setup(t, rules);
  f.act({ kind: "shelter", plot: 1 });
  f.act({ kind: "shelter", plot: 2 });
  f.act({ kind: "plant", plot: 1, cropId: "clover" });
  f.act({ kind: "plant", plot: 2, cropId: "clover" });
  f.jump(DAY);
  f.jump(DAY + 4 * HOUR);
  const event = f.garden.calendar.events.get(2);
  f.act({
    kind: "choose_event",
    eventId: event.id,
    choiceId: "share_shelter",
    plot: 1,
  });
  const start = f.read();
  f.jump(2 * DAY + HOUR);
  const end = f.read();
  assert.equal(end.plots[0].plant.growth - start.plots[0].plant.growth, 1);
  assert.equal(end.plots[1].plant.growth - start.plots[1].plant.growth, 21);
});

test("full moon adds shade quality once and doubles only that night's pair trials", (t) => {
  const rules = onlyEvent("full-moon-night");
  rules.crops.moonflower.hours = 4;
  rules.crops.catnip.hours = 4;
  rules.crops.mint.hours = 72;
  for (const id of ["moonflower", "catnip", "mint", "clover"])
    rules.crops[id].dailyWater = 0;
  const f = setup(t, rules);
  f.jump(12 * DAY);
  const moonflower = f.act({
    kind: "plant",
    plot: 1,
    cropId: "moonflower",
    buyPrice: 140,
  }).plantId;
  const catnip = f.act({
    kind: "plant",
    plot: 2,
    cropId: "catnip",
    buyPrice: 65,
  }).plantId;
  f.act({ kind: "plant", plot: 5, cropId: "mint", buyPrice: 50 });
  f.act({ kind: "plant", plot: 6, cropId: "clover" });
  const early = f.act({
    kind: "plant",
    plot: 7,
    cropId: "moonflower",
    buyPrice: 140,
  }).plantId;
  const pair = [moonflower, catnip].sort().join(":");
  const roll = (seed) =>
    createHash("sha256")
      .update(JSON.stringify([seed, pair, 14]))
      .digest()
      .readUInt32BE() / 0x100000000;
  let seed = 0;
  while (roll(String(seed)) < 1 / 3 || roll(String(seed)) >= 2 / 3) seed++;
  f.store.db
    .prepare("UPDATE garden_weather_seed SET seed=? WHERE id=1")
    .run(String(seed));
  // Make the parents eligible when the full moon begins, but after the previous night's dawn trials.
  const state = f.garden.requireState();
  for (const { plant } of state.plots.slice(0, 2)) plant.sownClock -= 6 * HOUR;
  f.store.db
    .prepare("UPDATE garden_state SET plots=? WHERE id=1")
    .run(JSON.stringify(state.plots));
  f.jump(13 * DAY + 18 * HOUR);
  const afternoon = f.read();
  assert.equal(afternoon.event.id, "14:full-moon-night");
  assert.equal(afternoon.plots[4].plant.qualityAdjustment, undefined);
  assert.equal(afternoon.seeds.mistbell, undefined);
  f.act({ kind: "harvest", plot: 7, plantId: early });
  f.act({ kind: "plant", plot: 4, cropId: "mint", buyPrice: 50 });
  f.jump(13 * DAY + 21 * HOUR);
  const night = f.read();
  assert.equal(night.plots[6].plant, null);
  assert.equal(night.seeds.mistbell, 1);
  assert.equal(
    f.garden.plantHistory({ plantId: early }).plant.snapshot.qualityAdjustment,
    undefined,
  );
  assert.equal(night.plots[3].plant.qualityAdjustment, 15);
  assert.equal(night.plots[4].plant.qualityAdjustment, 15);
  assert.equal(night.plots[5].plant.qualityAdjustment, undefined);
  assert.equal(f.read().plots[4].plant.qualityAdjustment, 15);
  f.act({ kind: "water", plot: 5, plantId: night.plots[4].plant.id });
  const reopened = new GardenService(f.store).read(13 * DAY + 21 * HOUR);
  assert.equal(reopened.plots[4].plant.qualityAdjustment, 15);
});
