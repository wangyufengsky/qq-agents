import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { gardenCraftOrigin } from "../public/garden-art/gifts.js";
import {
  performGardenAction,
  subjectGardenGifts,
  subjectGardenView,
} from "../src/home/garden-console.mjs";
import { gardenPlantSnapshot } from "../src/home/garden-public.mjs";
import { HOUR, defaultGardenSettings } from "../src/home/garden-rules.mjs";
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
  for (const cropId of ["morning-glory", "rattle-pea", "balsam", "lambs-ear"]) {
    settings.crops[cropId].hours = 4;
    settings.crops[cropId].dailyWater = 0;
  }
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

test("new crop defaults are added to old settings without replacing a custom crop or changing prior plants", (t) => {
  const f = setup(t);
  const plant = f.sow(1, "morning-glory");
  const before = f.garden.requireState();
  delete before.settings.crops.balsam;
  delete before.settings.crops["rattle-pea"];
  delete before.settings.crops["lambs-ear"];
  before.settings.crops["morning-glory"].name = "我的牵牛";
  f.store.db
    .prepare("UPDATE garden_state SET settings=? WHERE id=1")
    .run(JSON.stringify(before.settings));
  f.reopen();
  const state = f.read();
  assert.equal(state.balance, before.balance);
  assert.equal(state.plots[0].plant.id, plant);
  assert.equal(state.settings.crops["morning-glory"].name, "我的牵牛");
  assert.ok(state.settings.crops.balsam.market);
  assert.ok(state.settings.crops["rattle-pea"].market);
  assert.ok(state.settings.crops["lambs-ear"].market);
});

test("morning glory has different text and image card details before and after noon", (t) => {
  const f = setup(t);
  const plant = f.sow(1, "morning-glory");
  f.advance(8);
  const morning = f.card(plant);
  assert.equal(morning.explorer.bloom, "open");
  assert.match(morning.text, /花瓣舒展/);
  assert.ok(morning.cardDetails.some(([, value]) => /花瓣舒展/.test(value)));
  f.advance(6);
  const afternoon = f.card(plant);
  assert.equal(afternoon.explorer.bloom, "rolled");
  assert.match(afternoon.text, /花瓣轻轻卷起/);
  assert.ok(
    afternoon.cardDetails.some(([, value]) => /花瓣轻轻卷起/.test(value)),
  );
  assert.notEqual(morning.snapshotId, afternoon.snapshotId);
  f.harvest(1, plant);
  assert.equal(f.card(plant).explorer, undefined);
});

test("pea rattle count at maturity matches the harvested lot after reopening", (t) => {
  const f = setup(t);
  const plant = f.sow(1, "rattle-pea");
  assert.equal(f.overview().plots[0].plant.explorer, undefined);
  f.advance(8);
  const rattles = f.overview().plots[0].plant.explorer.rattles;
  assert.ok(rattles.length >= 2 && rattles.length <= 5);
  assert.ok(rattles.every((sound) => sound === "嗒"));
  f.reopen();
  assert.deepEqual(f.card(plant).explorer.rattles, rattles);
  const harvested = f.harvest(1, plant);
  assert.equal(harvested.quantity, rattles.length);
  assert.equal(f.read().harvests[0].quantity, rattles.length);
  assert.equal(harvested.peasPerPod, rattles.length);
  assert.equal(harvested.podCount, 1);
});

test("the first successful pea harvest receives twin pods with the same audible count per pod", (t) => {
  const f = setup(t, "cloud", (settings) => {
    settings.events.rate = 1;
    for (const [id, event] of Object.entries(settings.events.entries))
      event.enabled = id === "twin-fruit";
  });
  const plantId = f.sow(1, "rattle-pea");
  f.advance(8);
  const count = f.card(plantId).explorer.rattles.length;
  const harvested = f.harvest(1, plantId);
  assert.equal(harvested.peasPerPod, count);
  assert.equal(harvested.podCount, 2);
  assert.equal(harvested.quantity, count * 2);
  assert.equal(f.read().harvests[0].quantity, count * 2);
  assert.equal(f.read().event.status, "claimed");
});

test("guessing and listening to the pinned pea plot reveals the same count as harvest", (t) => {
  const f = setup(t, "cloud", (settings) => {
    settings.events.rate = 1;
    for (const [id, event] of Object.entries(settings.events.entries))
      event.enabled = id === "pea-guess";
  });
  const plantId = f.sow(2, "rattle-pea");
  f.advance(24);
  assert.equal(f.read().event.id, "2:pea-guess");
  const count = f.card(plantId).explorer.rattles.length;
  const choice = (choiceId) =>
    f.act({ kind: "choose_event", eventId: "2:pea-guess", choiceId });
  assert.equal(
    (choice("listen").outcome.detail.match(/嗒/g) ?? []).length,
    count,
  );
  choice(`guess-${count}`);
  const opened = choice("open-pod");
  assert.match(opened.outcome.detail, new RegExp(`共 ${count} 颗豆`));
  assert.match(opened.outcome.detail, /1 份猜中/);
  assert.equal(f.harvest(2, plantId).quantity, count);
});

test("balsam grants one public seed bag only when its mature pod is popped", (t) => {
  const f = setup(t);
  const first = f.sow(1, "balsam");
  const second = f.sow(2, "balsam");
  const action = { kind: "pop_seed_pod", plot: 1, plantId: first };
  assert.throws(() => f.act(action), /GARDEN_PLANT_STATE/);
  f.advance(8);
  assert.deepEqual(f.overview().plots[0].plant.podAction.args, {
    plot: 1,
    plantId: first,
  });
  const request = randomUUID();
  assert.equal(f.act(action, request).seedBag, true);
  assert.equal(f.act(action, request).replayed, true);
  f.reopen();
  assert.equal(f.overview().plots[0].plant.explorer.canPop, false);
  assert.throws(() => f.act(action), /GARDEN_PLANT_STATE/);
  assert.equal(f.harvest(1, first).seedBag, undefined);
  const directHarvest = f.harvest(2, second);
  assert.equal(directHarvest.cropId, "balsam");
  assert.equal(directHarvest.seedBag, undefined);
  assert.equal(f.read().mysterySeeds.count, 1);
  assert.equal(
    f.garden.timeline({ type: "event", cropId: "balsam" }).entries.length,
    1,
  );
  f.act({ kind: "plant_mystery_seed", plot: 1 });
  assert.equal(f.read().mysterySeeds.count, 0);
});

test("lamb's ear catches outdoor drizzle and its intact leaf remains on a shared bookmark", (t) => {
  const f = setup(t, "drizzle");
  const plant = f.sow(1, "lambs-ear");
  assert.equal(f.card(plant).explorer.silverBeads, true);
  f.act({ kind: "shelter", plot: 1 });
  assert.equal(f.card(plant).explorer.silverBeads, false);
  f.advance(8);
  const shape = f.card(plant).explorer.leafShape;
  const { harvestId, quality } = f.harvest(1, plant);
  assert.equal(quality, "ordinary");
  const recipes = subjectGardenGifts(f.runtime, f.role).craftRecipes;
  assert.ok(recipes.find(({ id }) => id === "craft-lambs-ear-bookmark").ready);
  assert.equal(
    recipes.find(({ id }) => id === "craft-pressed-flower").ready,
    false,
  );
  const bookmark = f.act({
    kind: "craft_gift",
    recipeId: "craft-lambs-ear-bookmark",
    harvestIds: [harvestId],
    price: 10,
  });
  assert.equal(bookmark.craftMeta.ingredients[0].plantId, plant);
  assert.equal(bookmark.craftMeta.ingredients[0].leafShape, shape);
  assert.match(gardenCraftOrigin(bookmark.craftMeta), new RegExp(shape));
  f.act({
    kind: "send_gift",
    itemId: bookmark.itemId,
    recipient: { kind: f.recipient.kind, id: f.recipient.id },
    note: "只给伙伴看",
  });
  f.act(
    { kind: "display_gift", itemId: bookmark.itemId, slot: 1 },
    randomUUID(),
    f.recipient,
  );
  const item = subjectGardenGifts(f.runtime, f.role)
    .communityShelves.flatMap(({ items }) => items)
    .find(({ giftId }) => giftId === "craft-lambs-ear-bookmark");
  assert.equal(item.craftMeta.ingredients[0].leafShape, shape);
  assert.equal(item.craftMeta.ingredients[0].cropName, "绒耳草");
  assert.equal(item.id, undefined);
  assert.equal(item.note, undefined);
});

test("morning glory and balsam can be pressed or bundled as two distinct flowers", (t) => {
  const f = setup(t, "cloud", (settings) => {
    settings.baseQuality = 100;
  });
  const crops = [
    "morning-glory",
    "balsam",
    "morning-glory",
    "balsam",
    "rattle-pea",
    "lambs-ear",
  ];
  const plants = crops.map((cropId, index) => f.sow(index + 1, cropId));
  f.advance(8);
  const [morning, balsam, secondMorning, secondBalsam, pea, leaf] = plants.map(
    (plantId, index) => f.harvest(index + 1, plantId).harvestId,
  );
  const make = (recipeId, harvestIds, price) =>
    f.act({ kind: "craft_gift", recipeId, harvestIds, price });
  const recipes = subjectGardenGifts(f.runtime, f.role).craftRecipes;
  const pressing = recipes.find(({ id }) => id === "craft-pressed-flower");
  assert.deepEqual(pressing.harvestIds, [
    morning,
    balsam,
    secondMorning,
    secondBalsam,
  ]);
  f.act({ kind: "build_facility", facilityId: "drying_rack", price: 420 });
  assert.throws(
    () => make("craft-flower-bouquet", [morning, secondMorning], 9),
    /GARDEN_RECIPE_INGREDIENTS/,
  );
  for (const ingredient of [pea, leaf])
    assert.throws(
      () => make("craft-flower-bouquet", [morning, ingredient], 9),
      /GARDEN_RECIPE_INGREDIENTS/,
    );
  assert.equal(
    make("craft-pressed-flower", [morning], 5).craftMeta.ingredients[0].cropId,
    "morning-glory",
  );
  assert.equal(
    make("craft-pressed-flower", [balsam], 5).craftMeta.ingredients[0].cropId,
    "balsam",
  );
  const bouquet = make(
    "craft-flower-bouquet",
    [secondMorning, secondBalsam],
    9,
  );
  assert.deepEqual(
    bouquet.craftMeta.ingredients.map(({ cropId }) => cropId),
    ["morning-glory", "balsam"],
  );
});

for (const [cropId, eventType, choiceId] of [
  ["rattle-pea", "pea-guess", "listen"],
  ["balsam", "balsam-dishes", "dish-left"],
]) {
  test(`${eventType} cannot use a regrowing or newly ripe pod from the same plant`, (t) => {
    const f = setup(t, "cloud", (settings) => {
      settings.crops[cropId].maxHarvests = 2;
      settings.events.rate = 1;
      for (const [id, event] of Object.entries(settings.events.entries))
        event.enabled = id === eventType;
    });
    const plantId = f.sow(1, cropId);
    f.advance(24);
    const eventId = f.read().event.id;
    const choices = () => f.overview().event.actions;
    const choose = () => f.act({ kind: "choose_event", eventId, choiceId });
    assert.ok(choices().some(({ args }) => args.choiceId === choiceId));

    assert.equal(f.harvest(1, plantId).regrowing, true);
    assert.equal(f.read().plots[0].plant.status, "growing");
    assert.deepEqual(choices(), []);
    assert.throws(choose, /GARDEN_EVENT_CHOICE_INVALID/);

    f.advance(4);
    assert.equal(f.read().plots[0].plant.id, plantId);
    assert.equal(f.read().plots[0].plant.status, "mature");
    assert.deepEqual(choices(), []);
    assert.throws(choose, /GARDEN_EVENT_CHOICE_INVALID/);
    assert.equal(f.read().mysterySeeds.count, 0);
  });
}
