import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { gardenPriorities } from "../src/home/garden-console.mjs";
import { HOUR, defaultGardenSettings } from "../src/home/garden-rules.mjs";
import { GardenService } from "../src/home/garden-service.mjs";
import { MemoryStore } from "../src/memory/store.mjs";
import { fixedWeather } from "./garden-fixtures.mjs";

const administrator = { kind: "admin", id: "administrator" };

function fixture(t, customize = () => {}) {
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
  const action = (value) =>
    garden.act(now, administrator, { requestId: randomUUID(), action: value });
  return {
    store,
    get garden() {
      return garden;
    },
    read: () => garden.read(now),
    restart: () => {
      garden.syncClock(now, false);
      garden = new GardenService(store);
      garden.syncClock(now, true);
    },
    advance(hours) {
      now += hours * HOUR;
      garden.syncClock(now, true);
    },
    configure(careMode, scope) {
      const { settings, settingsRevision } = garden.requireState();
      return garden.configure(
        now,
        settingsRevision,
        { ...settings, careMode },
        scope,
      );
    },
    action,
    sow(plot, cropId = "clover") {
      return action({
        kind: "plant",
        plot,
        cropId,
        buyPrice: garden.requireState().settings.crops[cropId].seedPrice,
      });
    },
  };
}

test("new gardens preserve drought progress and quality through a long dormancy", (t) => {
  const f = fixture(t, (rules) => {
    rules.startingWater = 10;
    rules.crops.clover.hours = 100;
    rules.crops.clover.dailyWater = 24;
  });
  const { plantId } = f.sow(1);
  f.advance(90);
  const state = f.read();
  const plant = state.plots[0].plant;
  assert.equal(state.settings.careMode, "gentle");
  assert.equal(plant.status, "growing");
  assert.equal(plant.water, 0);
  assert.equal(plant.growth, 5);
  assert.equal(plant.low, 0);
  assert.equal(gardenPriorities(state)[0].kind, "dormant");
  f.action({ kind: "water", plot: 1, plantId });
  f.advance(3);
  assert.equal(f.read().plots[0].plant.growth, 8);
});

test("safeguarding existing plants first applies the old rules and preserves accrued quality loss", (t) => {
  const f = fixture(t, (rules) => {
    rules.careMode = "classic";
    rules.startingWater = 10;
    rules.crops.clover.hours = 100;
    rules.crops.clover.dailyWater = 24;
  });
  f.sow(1);
  f.advance(60);
  f.sow(2);
  f.advance(20);
  // Simulate a persisted garden from before the mode and the two crops existed.
  const saved = f.garden.requireState();
  delete saved.settings.careMode;
  delete saved.settings.crops.catnip;
  delete saved.settings.crops.mistbell;
  for (const { plant } of saved.plots) if (plant) delete plant.rules.careMode;
  f.store.db
    .prepare("UPDATE garden_state SET settings=?,plots=? WHERE id=1")
    .run(JSON.stringify(saved.settings), JSON.stringify(saved.plots));
  assert.equal(f.read().settings.careMode, "classic");
  assert.equal(f.read().settings.crops.catnip.market, true);
  const future = f.configure("gentle", "future");
  assert.equal(future.plots[0].plant.status, "withered");
  assert.equal(future.plots[1].plant.rules.careMode, undefined);
  f.sow(3);
  const migrated = f.configure("gentle", "growing");
  const second = migrated.plots[1].plant;
  assert.equal(second.rules.careMode, "gentle");
  assert.equal(second.low, 20);
  assert.equal(second.growth, 5);
  f.advance(80);
  const state = f.read();
  assert.equal(state.plots[0].plant.status, "withered");
  assert.equal(state.plots[1].plant.status, "growing");
  assert.equal(state.plots[1].plant.low, 20);
  assert.equal(state.plots[2].plant.rules.careMode, "gentle");
});

test("consecutive storms suspend gentle plants until sheltered or clear weather", (t) => {
  const f = fixture(t, (rules) => {
    rules.weather = fixedWeather("storm");
    rules.crops.clover.floodDays = 1;
  });
  f.sow(1);
  f.advance(75);
  const plant = f.read().plots[0].plant;
  assert.equal(plant.status, "growing");
  assert.equal(plant.growth, 0);
  assert.equal(plant.floodLoss ?? 0, 0);
  f.action({ kind: "shelter", plot: 1 });
  f.advance(2);
  assert.ok(f.read().plots[0].plant.growth > 0);
});

function pairFixture(t) {
  return fixture(t, (rules) => {
    for (const cropId of ["moonflower", "catnip"]) {
      rules.crops[cropId].hours = 4;
      rules.crops[cropId].dailyWater = 0;
    }
  });
}

test("a full garden settles a mature orthogonal pair on the clock and awards exactly one seed across restarts", (t) => {
  const f = pairFixture(t);
  const moonflower = f.sow(2, "moonflower").plantId;
  const catnip = f.sow(5, "catnip").plantId;
  for (const plot of [1, 3, 4, 6, 7, 8, 9]) f.sow(plot);
  f.advance(47);
  assert.equal(f.read().seeds.mistbell, undefined);
  f.advance(1);
  assert.equal(f.read().nightScene.period, "night");
  assert.equal(f.read().nightScene.stars, "sparse");
  f.restart();
  f.advance(50);
  // The runtime tick has settled all three possible nights before any read.
  assert.equal(f.garden.requireState().seeds.mistbell, 1);
  assert.equal(f.read().mistbellDiscovered, true);
  const facts = f.store.db
    .prepare(
      "SELECT clock,plants FROM garden_facts WHERE type='discovery' AND json_extract(detail,'$.phase')='seed'",
    )
    .all();
  assert.equal(facts.length, 1);
  assert.deepEqual(
    JSON.parse(facts[0].plants).map(({ plantId }) => plantId),
    [moonflower, catnip],
  );
  assert.ok(facts[0].clock >= 48 * HOUR && facts[0].clock < 98 * HOUR);
  assert.equal(f.read().plots[1].plant.id, moonflower);
  assert.equal(f.read().plots[4].plant.id, catnip);
  f.restart();
  f.advance(96);
  assert.equal(f.read().seeds.mistbell, 1);
  f.action({ kind: "harvest", plot: 2, plantId: moonflower });
  f.sow(2, "mistbell");
  assert.equal(f.read().plots[1].plant.cropId, "mistbell");
  assert.equal(f.read().seeds.mistbell, 0);
  assert.equal(f.read().mistbellDiscovered, true);
});

test("diagonal, across-row and prematurely harvested parents never produce a neighbor reward", (t) => {
  const f = pairFixture(t);
  f.sow(3, "moonflower");
  f.sow(4, "catnip");
  f.sow(5, "catnip");
  const { plantId } = f.sow(6, "catnip");
  f.advance(24);
  f.action({ kind: "harvest", plot: 6, plantId });
  f.advance(120);
  assert.equal(f.read().seeds.mistbell, undefined);
  assert.deepEqual(f.read().pollenPairs, []);
  assert.equal(f.read().mistbellDiscovered, false);
});
