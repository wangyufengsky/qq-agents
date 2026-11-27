import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import {
  defaultGardenSettings,
  HOUR,
  neighborBuffs,
} from "../src/home/garden-rules.mjs";
import { GardenService } from "../src/home/garden-service.mjs";
import { MemoryStore } from "../src/memory/store.mjs";
import { fixedWeather } from "./garden-fixtures.mjs";

const admin = { kind: "admin", id: "administrator" };

function setup(t, kind, customize = () => {}) {
  const store = new MemoryStore(":memory:");
  t.after(() => store.close());
  let now = 0;
  const garden = new GardenService(store);
  const settings = defaultGardenSettings();
  settings.weather = fixedWeather(kind);
  settings.events.rate = 0;
  customize(settings);
  garden.initialize(now, settings);
  garden.syncClock(now, true);
  const act = (action, requestId = randomUUID()) =>
    garden.act(now, admin, { action, requestId });
  return {
    garden,
    db: store.db,
    store,
    act,
    read: () => garden.read(now),
    sow: (plot, cropId) =>
      act({
        kind: "plant",
        plot,
        cropId,
        buyPrice: settings.crops[cropId].seedPrice,
      }).plantId,
    advance(hours) {
      now += hours * HOUR;
      garden.syncClock(now, true);
    },
  };
}

test("legacy settings and starbell pairs survive expanded crop defaults", (t) => {
  const f = setup(t, "cloud");
  const plantId = f.sow(1, "clover");
  const state = f.garden.requireState();
  for (const id of [
    "hydrangea",
    "tomato",
    "succulent",
    "chamomile",
    "sunberry",
    "four_leaf_clover",
  ])
    delete state.settings.crops[id];
  state.settings.crops.catnip.name = "自定义猫薄荷";
  f.db
    .prepare("UPDATE garden_state SET settings=? WHERE id=1")
    .run(JSON.stringify(state.settings));
  f.db
    .prepare("INSERT INTO garden_neighbor_pairs VALUES(?,?,?,?)")
    .run("legacy:a", 3, 8, 1);
  const opened = new GardenService(f.store).read(0);
  assert.equal(opened.balance, state.balance);
  assert.equal(opened.plots[0].plant.id, plantId);
  assert.equal(opened.settings.crops.catnip.name, "自定义猫薄荷");
  assert.equal(opened.settings.crops.tomato.maxHarvests, 3);
  assert.equal(opened.settings.crops.succulent.rainSensitive, true);
  assert.equal(opened.settings.crops.sunberry.market, false);
  assert.equal(opened.settings.crops.four_leaf_clover.market, false);
  assert.equal(opened.mistbellDiscovered, true);
});

for (const [weather, variant] of [
  ["drizzle", "rain_blue"],
  ["sun", "sun_pink"],
  ["cloud", "mist_lilac"],
]) {
  test(`hydrangea locks ${variant} at maturity and records it in the flower card`, (t) => {
    const f = setup(t, weather, (settings) => {
      settings.crops.hydrangea.hours = 4;
      settings.crops.hydrangea.dailyWater = 0;
    });
    const plantId = f.sow(1, "hydrangea");
    f.advance(12);
    const plant = f.read().plots[0].plant;
    assert.equal(plant.variant, variant);
    assert.ok(plant.variantName);
    assert.equal(plant.qualityAdjustment ?? 0, weather === "drizzle" ? 5 : 0);
    const first = f.act({ kind: "harvest", plot: 1, plantId });
    assert.equal(first.surprise.firstTime, true);
    assert.equal(first.variantName, plant.variantName);
    assert.equal(
      f.garden.plantHistory({ plantId }, { publicView: true }).plant.snapshot
        .variantName,
      plant.variantName,
    );
    assert.ok(
      f.garden
        .timeline({ plantId, type: "mature" })
        .entries.some(({ text }) => text.includes(plant.variantName)),
    );
    const next = f.sow(1, "hydrangea");
    f.advance(12);
    assert.equal(
      f.act({ kind: "harvest", plot: 1, plantId: next }).surprise,
      undefined,
    );
  });
}

test("tomato keeps its plant, cycles growth and archives only its third harvest", (t) => {
  const f = setup(t, "cloud", (settings) => {
    settings.crops.tomato.hours = 8;
    settings.crops.tomato.dailyWater = 0;
  });
  const plantId = f.sow(1, "tomato");
  for (let count = 1; count <= 3; count++) {
    f.advance(count === 1 ? 8 : 4);
    const action = { kind: "harvest", plot: 1, plantId };
    const requestId = randomUUID();
    const harvested = f.act(action, requestId);
    assert.equal(harvested.harvestCount, count);
    assert.equal(f.act(action, requestId).harvestId, harvested.harvestId);
    const live = f.read().plots[0].plant;
    if (count < 3) {
      assert.equal(live.id, plantId);
      assert.equal(live.status, "growing");
      assert.equal(live.growth, 4);
      assert.equal(live.quality, null);
    } else {
      assert.equal(live, null);
    }
  }
  assert.equal(f.read().harvests.length, 3);
  assert.equal(f.garden.plantHistory({ plantId }).plant.status, "harvested");
});

test("chamomile protects neighbors from the exact maturity crossing and through a lazy jump", (t) => {
  const f = setup(t, "sun", (settings) => {
    settings.crops.chamomile.hours = 2;
    settings.crops.clover.dailyWater = 24;
    settings.crops.clover.hours = 48;
  });
  f.sow(1, "chamomile");
  f.sow(2, "clover");
  f.sow(5, "clover");
  const aphids = defaultGardenSettings().events.entries["aphid-squad"];
  f.db.prepare("UPDATE garden_events SET value=? WHERE day=1").run(
    JSON.stringify({
      ...aphids,
      id: "aphids",
      kind: "nuisance",
      status: "open",
      startedAt: 0,
    }),
  );
  f.advance(8);
  const state = f.read();
  const [, guarded, , , diagonal] = state.plots.map(({ plant }) => plant);
  assert.deepEqual(neighborBuffs(state, 2), ["洋甘菊护卫"]);
  assert.deepEqual(neighborBuffs(state, 5), []);
  assert.equal(guarded.growth, 5);
  assert.equal(diagonal.growth, 4);
  const demand = state.weather.demand;
  assert.ok(Math.abs(guarded.water - (75 - demand * (4 + 4 * 0.85))) < 1e-9);
  assert.ok(Math.abs(diagonal.water - (75 - demand * 8)) < 1e-9);
});

function rolled(seed, lane, day) {
  return (
    createHash("sha256")
      .update(JSON.stringify([seed, lane, day]))
      .digest()
      .readUInt32BE() / 0x100000000
  );
}

test("sunberry leaves gold pollen after two missed sunny trials, then guarantees one seed", (t) => {
  const f = setup(t, "sun", (settings) => {
    for (const crop of ["sunflower", "strawberry"]) {
      settings.crops[crop].hours = 4;
      settings.crops[crop].dailyWater = 0;
    }
    settings.crops.sunberry.dailyWater = 0;
  });
  const parents = [f.sow(1, "sunflower"), f.sow(2, "strawberry")];
  const key = `sunberry:${parents.sort().join(":")}`;
  let seed = 0;
  while ([3, 4].some((day) => rolled(String(seed), key, day) < 1 / 3)) seed++;
  f.db
    .prepare("UPDATE garden_weather_seed SET seed=? WHERE id=1")
    .run(String(seed));
  f.advance(53);
  assert.deepEqual(f.read().pollenPairs, []);
  f.advance(1);
  assert.deepEqual(f.read().pollenPairs, [{ plots: [1, 2], hint: "金色花粉" }]);
  f.advance(24);
  assert.equal(f.read().seeds.sunberry, undefined);
  f.advance(24);
  assert.equal(f.read().seeds.sunberry, 1);
  assert.equal(f.read().mistbellDiscovered, false);
  f.advance(48);
  assert.equal(f.read().seeds.sunberry, 1);
  assert.equal(f.garden.calendar.neighbors.status(key).attempts, 3);
  const plantId = f.sow(3, "sunberry");
  f.advance(72);
  const harvest = f.act({ kind: "harvest", plot: 3, plantId });
  assert.equal(harvest.surprise.kind, "hidden_harvest");
  assert.equal(harvest.surprise.firstTime, true);
});

test("clover mutation uses blessing or perfect quality, preserves the source and is replayable", (t) => {
  const f = setup(t, "cloud", (settings) => {
    settings.crops.clover.hours = 8;
    settings.crops.clover.dailyWater = 0;
  });
  const plantId = f.sow(1, "clover");
  let seed = 0;
  while (rolled(String(seed), plantId, "four_leaf_clover") >= 0.2) seed++;
  f.db
    .prepare("UPDATE garden_weather_seed SET seed=? WHERE id=1")
    .run(String(seed));
  const dew = Object.values(defaultGardenSettings().events.entries).find(
    ({ effect }) => effect.effect === "dew",
  );
  const state = f.garden.requireState();
  f.garden.calendar.events.bless({ ...dew }, state, String(seed), 1);
  f.db
    .prepare("UPDATE garden_state SET plots=? WHERE id=1")
    .run(JSON.stringify(state.plots));
  assert.equal(f.read().plots[0].plant.blessed, true);
  f.advance(8);
  const action = { kind: "harvest", plot: 1, plantId };
  const requestId = randomUUID();
  const receipt = f.act(action, requestId);
  assert.equal(receipt.surprise.kind, "variant_harvest");
  assert.ok(Number.isInteger(receipt.surprise.evidenceId));
  assert.equal(
    f.garden.timeline({ factId: receipt.surprise.evidenceId }).entries[0].type,
    "variant",
  );
  assert.equal(receipt.cropId, "four_leaf_clover");
  assert.equal(receipt.quality, "ordinary");
  assert.equal(f.act(action, requestId).harvestId, receipt.harvestId);
  assert.equal(f.read().harvests[0].crop_id, "four_leaf_clover");
  assert.equal(f.garden.plantHistory({ plantId }).plant.cropId, "clover");
  assert.ok(
    f.garden
      .timeline({ plantId, type: "harvest" })
      .entries[0].text.includes("四叶幸运草"),
  );
});
