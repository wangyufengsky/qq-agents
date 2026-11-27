import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { gardenCraftOrigin } from "../public/garden-art/gifts.js";
import {
  adminGardenView,
  performGardenAction,
  subjectGardenView,
} from "../src/home/garden-console.mjs";
import { gardenPlantSnapshot } from "../src/home/garden-public.mjs";
import { HOUR, defaultGardenSettings } from "../src/home/garden-rules.mjs";
import { initializeGardenTables } from "../src/home/garden-schema.mjs";
import { GardenService } from "../src/home/garden-service.mjs";
import { fixedWeather } from "./garden-fixtures.mjs";
import { config, fixture } from "./helpers.mjs";

const admin = { kind: "admin", id: "administrator" };

function setup(t, weather = "cloud", customize = () => {}) {
  const cfg = config(2);
  for (const role of cfg.agents) role.subject.enabled = true;
  const { runtime, store } = fixture(t, { cfg });
  const settings = defaultGardenSettings();
  settings.weather = fixedWeather(weather);
  settings.events.rate = 0;
  settings.roles = Object.fromEntries(
    cfg.agents.map(({ id }) => [id, runtime.home.generation(id)]),
  );
  for (const cropId of ["perilla", "sweet-corn", "pocket-pumpkin"]) {
    settings.crops[cropId].hours = 4;
    settings.crops[cropId].dailyWater = 0;
  }
  settings.giftBudgets = {
    total: 30,
    roles: Object.fromEntries(cfg.agents.map(({ id }) => [id, 15])),
  };
  settings.giftBudgetGenerations = settings.roles;
  customize(settings);
  let now = Date.UTC(2026, 0, 1);
  runtime.clock = () => now;
  let garden = runtime.home.garden;
  garden.initialize(now, settings);
  garden.syncClock(now, true);
  const act = (action, requestId = randomUUID(), actor = admin) =>
    performGardenAction(runtime, actor, { requestId, action });
  const role = cfg.agents[0].id;
  return {
    runtime,
    store,
    role,
    recipient: {
      kind: "agent",
      id: cfg.agents[1].id,
      turnId: "bookmark-display",
    },
    act,
    get garden() {
      return garden;
    },
    overview: () => subjectGardenView(runtime, role, "explorer-plants"),
    sow: (plot, cropId) =>
      act({
        kind: "plant",
        plot,
        cropId,
        buyPrice: settings.crops[cropId].seedPrice,
      }).plantId,
    harvest: (plot, plantId) => act({ kind: "harvest", plot, plantId }),
    read: () => garden.read(now),
    card(plantId) {
      const state = garden.observe(now);
      const history = garden.plantHistory({ plantId }, { publicView: true });
      return gardenPlantSnapshot(state, history, {
        running: state.running,
        now,
      });
    },
    advance(hours) {
      now += hours * HOUR;
      garden.syncClock(now, true);
    },
    reopen() {
      garden.syncClock(now, false);
      garden = runtime.home.garden = new GardenService(store);
      garden.syncClock(now, true);
    },
  };
}

test("perilla records both sides in the almanac and carries the same print through the harvest and craft", (t) => {
  const f = setup(t);
  const plantId = f.sow(1, "perilla");
  const shown = f.card(plantId).explorer;
  assert.ok(shown.leafFront && shown.leafBack);
  f.advance(6);
  const lot = f.harvest(1, plantId);
  assert.equal(lot.leafFront, shown.leafFront);
  assert.equal(lot.leafBack, shown.leafBack);
  assert.equal(lot.surprises.length, 2);
  assert.ok(lot.surprises.every(({ kind }) => kind === "almanac_unlock"));
  const inventory = f.overview().inventory.harvests[0];
  assert.equal(inventory.leafFront, shown.leafFront);
  assert.equal(inventory.leafBack, shown.leafBack);
  assert.deepEqual(
    f.garden
      .almanac()
      .entries[0].variants.map(({ id }) => id)
      .sort(),
    ["leaf-veins", "sunset-print"],
  );
  assert.equal(f.garden.almanac().entries[0].harvestCount, 1);
  const print = f.act({
    kind: "craft_gift",
    recipeId: "craft-perilla-print",
    harvestIds: [lot.harvestId],
    price: 10,
  });
  assert.equal(print.craftMeta.ingredients[0].plantId, plantId);
  assert.match(gardenCraftOrigin(print.craftMeta), new RegExp(shown.leafFront));
  assert.match(gardenCraftOrigin(print.craftMeta), new RegExp(shown.leafBack));
});

test("one corn plant yields a tender first ear and a dried second ear across a restart and a long jump", (t) => {
  const f = setup(t);
  const plantId = f.sow(1, "sweet-corn");
  f.advance(6);
  const first = f.harvest(1, plantId);
  assert.equal(first.ear, 1);
  assert.equal(first.harvestStage, "tender");
  assert.equal(first.regrowing, true);
  f.reopen();
  f.advance(30);
  const second = f.harvest(1, plantId);
  assert.equal(second.ear, 2);
  assert.equal(second.harvestStage, "dry");
  assert.equal(second.regrowing, false);
  assert.equal(f.read().plots[0].plant, null);
  const make = (recipeId, harvestId, price, recipient) =>
    f.act(
      {
        kind: "craft_gift",
        recipeId,
        harvestIds: [harvestId],
        price,
        ...(recipient && { recipient }),
      },
      randomUUID(),
      recipient ? { kind: "agent", id: f.role, turnId: "prepare-corn" } : admin,
    );
  assert.throws(
    () => make("craft-corn-rattle", first.harvestId, 12),
    /GARDEN_RECIPE_INGREDIENTS/,
  );
  assert.throws(
    () => make("craft-roasted-corn", second.harvestId, 8),
    /GARDEN_RECIPE_INGREDIENTS/,
  );
  const roasted = make("craft-roasted-corn", first.harvestId, 8, admin);
  assert.equal(roasted.craftMeta.ingredients[0].ear, 1);
  assert.equal(
    adminGardenView(f.runtime).personalGifts.received[0].giftId,
    "craft-roasted-corn",
  );
  const rattle = make("craft-corn-rattle", second.harvestId, 12);
  assert.equal(rattle.craftMeta.ingredients[0].ear, 2);
  assert.equal(rattle.craftMeta.ingredients[0].harvestStage, "dry");
  assert.equal(rattle.craftMeta.ingredients[0].plantId, plantId);
});

test("tender pumpkins are harvestable immediately while only a hard pumpkin can be carved and displayed", (t) => {
  const f = setup(t);
  const early = f.sow(1, "pocket-pumpkin");
  const late = f.sow(2, "pocket-pumpkin");
  f.advance(6);
  assert.equal(f.card(early).explorer.harvestStage, "tender");
  const tender = f.harvest(1, early).harvestId;
  f.reopen();
  f.advance(23);
  assert.equal(f.card(late).explorer.harvestStage, "hard");
  const hard = f.harvest(2, late).harvestId;
  const carve = (harvestId) =>
    f.act({
      kind: "craft_gift",
      recipeId: "craft-pumpkin-lantern",
      harvestIds: [harvestId],
      price: 14,
    });
  assert.throws(() => carve(tender), /GARDEN_RECIPE_INGREDIENTS/);
  const lamp = carve(hard);
  assert.equal(lamp.craftMeta.ingredients[0].harvestStage, "hard");
  f.act({ kind: "display_gift", itemId: lamp.itemId, slot: 16 });
  assert.equal(
    adminGardenView(f.runtime).personalGifts.shelf[0].giftId,
    "craft-pumpkin-lantern",
  );
});

test("the second corn ear can be harvested tender before the dry threshold", (t) => {
  const f = setup(t);
  const plantId = f.sow(1, "sweet-corn");
  f.advance(4);
  f.harvest(1, plantId);
  f.advance(13);
  assert.equal(f.card(plantId).explorer.harvestStage, "tender");
  const second = f.harvest(1, plantId);
  assert.equal(second.ear, 2);
  assert.equal(second.harvestStage, "tender");
  assert.equal(second.regrowing, false);
});

test("opening old crop settings and an old harvest schema retains preexisting lots and custom presets", (t) => {
  const f = setup(t, "cloud", (settings) => {
    settings.crops.clover.hours = 4;
    settings.crops.clover.name = "花园三叶草";
  });
  const plantId = f.sow(1, "clover");
  f.advance(8);
  const { harvestId } = f.harvest(1, plantId);
  const { settings } = f.garden.requireState();
  for (const id of ["perilla", "sweet-corn", "pocket-pumpkin"])
    delete settings.crops[id];
  f.store.db
    .prepare("UPDATE garden_state SET settings=?")
    .run(JSON.stringify(settings));
  f.store.db.exec("ALTER TABLE garden_harvests DROP COLUMN harvest_meta");
  initializeGardenTables(f.store.db);
  initializeGardenTables(f.store.db);
  f.reopen();
  assert.equal(f.read().settings.crops.clover.name, "花园三叶草");
  assert.equal(f.read().settings.crops["sweet-corn"].maxHarvests, 2);
  assert.equal(f.read().settings.crops.perilla.market, true);
  assert.equal(f.read().settings.crops["pocket-pumpkin"].market, true);
  assert.equal(f.read().harvests[0].id, harvestId);
  assert.equal(f.read().harvests[0].plant_id, plantId);
  assert.equal(f.read().harvests[0].harvest_meta, null);
});
