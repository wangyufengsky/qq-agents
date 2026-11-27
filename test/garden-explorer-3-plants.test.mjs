import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { gardenCraftOrigin } from "../public/garden-art/gifts.js";
import {
  performGardenAction,
  subjectGardenView,
} from "../src/home/garden-console.mjs";
import {
  gardenPlantSnapshot,
  gardenPublicSnapshot,
} from "../src/home/garden-public.mjs";
import { HOUR, defaultGardenSettings } from "../src/home/garden-rules.mjs";
import { GardenService } from "../src/home/garden-service.mjs";
import { fixedWeather } from "./garden-fixtures.mjs";
import { config, fixture } from "./helpers.mjs";

const admin = { kind: "admin", id: "administrator" };

function setup(t) {
  const cfg = config(1);
  for (const role of cfg.agents) role.subject.enabled = true;
  const { runtime, store } = fixture(t, { cfg });
  const settings = defaultGardenSettings();
  settings.weather = fixedWeather();
  settings.events.rate = 0;
  settings.roles = Object.fromEntries(
    cfg.agents.map(({ id }) => [id, runtime.home.generation(id)]),
  );
  for (const cropId of [
    "drift-gourd",
    "paper-moon",
    "echo-tuberose",
    "mint",
    "clover",
  ]) {
    settings.crops[cropId].hours = 4;
    settings.crops[cropId].dailyWater = 0;
  }
  let now = Date.UTC(2026, 0, 1);
  runtime.clock = () => now;
  let garden = runtime.home.garden;
  garden.initialize(now, settings);
  garden.syncClock(now, true);
  const act = (action) =>
    performGardenAction(runtime, admin, { requestId: randomUUID(), action });
  const role = cfg.agents[0].id;
  return {
    runtime,
    store,
    role,
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
    publicView() {
      const state = garden.observe(now);
      return gardenPublicSnapshot(state, { running: state.running, now });
    },
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

test("drift gourd stores different tender and floating lots at the actual harvest stages", (t) => {
  const f = setup(t);
  const early = f.sow(1, "drift-gourd");
  const late = f.sow(2, "drift-gourd");
  f.advance(5);
  assert.equal(f.card(early).explorer.harvestStage, "tender");
  const tender = f.harvest(1, early);
  f.reopen();
  f.advance(23);
  assert.equal(f.card(late).explorer.harvestStage, "floating");
  const floating = f.harvest(2, late);
  assert.equal(tender.harvestStage, "tender");
  assert.equal(floating.harvestStage, "floating");
  assert.deepEqual(
    f.overview().inventory.harvests.map(({ harvestStage }) => harvestStage),
    ["tender", "floating"],
  );
});

test("paper moon shows bloom, green pods and silver pods and only silver becomes a real string", (t) => {
  const f = setup(t);
  const early = f.sow(1, "paper-moon");
  const late = f.sow(2, "paper-moon");
  f.advance(4);
  assert.equal(f.card(late).explorer.harvestStage, "bloom");
  f.advance(12);
  assert.equal(f.card(late).explorer.harvestStage, "green");
  const green = f.harvest(1, early);
  f.reopen();
  f.advance(12);
  assert.equal(f.card(late).explorer.harvestStage, "silver");
  const silver = f.harvest(2, late);
  const string = (harvestId) =>
    f.act({
      kind: "craft_gift",
      recipeId: "craft-paper-moon-string",
      harvestIds: [harvestId],
      price: 12,
    });
  assert.throws(() => string(green.harvestId), /GARDEN_RECIPE_INGREDIENTS/);
  const made = string(silver.harvestId);
  assert.equal(made.craftMeta.ingredients[0].plantId, late);
  assert.equal(made.craftMeta.ingredients[0].harvestStage, "silver");
  assert.match(gardenCraftOrigin(made.craftMeta), /银荚/);
  f.act({ kind: "display_gift", itemId: made.itemId, slot: 16 });
  assert.equal(
    f.read().harvests.find(({ id }) => id === green.harvestId).quantity,
    1,
  );
});

test("an unrevealed scent leads to a true seed and first-bloom neighbors remain after harvest and restart", (t) => {
  const f = setup(t);
  const mint = f.sow(2, "mint");
  const clover = f.sow(4, "clover");
  assert.ok(
    !f.overview().market.crops.some(({ id }) => id === "echo-tuberose"),
  );
  const prior = f.garden.requireState();
  for (const id of ["drift-gourd", "paper-moon", "echo-tuberose"])
    delete prior.settings.crops[id];
  f.store.db
    .prepare("UPDATE garden_state SET settings=? WHERE id=1")
    .run(JSON.stringify(prior.settings));
  f.reopen();
  assert.equal(f.read().balance, prior.balance);
  assert.equal(f.read().plots[1].plant.id, mint);
  f.advance(30);
  const hints = f.garden.timeline({ type: "discovery" }).entries;
  const clue = hints.find(({ detail }) => detail.phase === "scent");
  assert.match(clue.text, /空花盆昨夜有一阵香气/);
  assert.equal(clue.detail.cropId, undefined);
  assert.deepEqual(clue.plants, []);
  assert.equal(f.overview().scene.echoScent.plot, 1);
  assert.ok(!JSON.stringify(f.overview().scene.echoScent).includes("回声晚香"));
  assert.equal(f.publicView().echoScent.plot, 1);
  assert.match(f.publicView().text, /空花盆昨夜有一阵香气/);
  assert.ok(
    !f.overview().market.crops.some(({ id }) => id === "echo-tuberose"),
  );
  f.reopen();
  f.advance(24);
  assert.equal(f.read().seeds["echo-tuberose"], 1);
  assert.equal(f.read().mistbellDiscovered, false);
  const discovery = f.garden.timeline({
    type: "discovery",
    cropId: "echo-tuberose",
  }).entries[0];
  assert.deepEqual(
    discovery.plants.map(({ plantId }) => plantId),
    [mint, clover],
  );
  assert.equal(
    f.garden.almanac().entries.find(({ cropId }) => cropId === "echo-tuberose")
      .plantedCount,
    0,
  );
  const echo = f.sow(1, "echo-tuberose");
  f.advance(50);
  const recorded = f.card(echo).explorer.neighbors;
  assert.deepEqual(
    recorded.map(({ plantId }) => plantId),
    [mint, clover],
  );
  f.harvest(2, mint);
  f.sow(2, "tomato");
  f.harvest(1, echo);
  f.reopen();
  assert.deepEqual(f.card(echo).explorer.neighbors, recorded);
  assert.equal(
    f.garden
      .timeline({ type: "mature", plantId: echo })
      .entries.filter(({ text }) => text.includes("初开")).length,
    1,
  );
});

test("without a mature fragrant neighbor, an empty plot does not hint at a hidden plant", (t) => {
  const f = setup(t);
  f.sow(2, "clover");
  f.advance(6 * 24);
  assert.equal(f.overview().scene.echoScent, undefined);
  assert.equal(f.read().seeds["echo-tuberose"], undefined);
  assert.ok(
    !f.garden
      .timeline({ type: "discovery" })
      .entries.some(({ detail }) => detail.phase === "scent"),
  );
});
