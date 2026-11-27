import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  adminGardenView,
  adminGardenWrite,
  performGardenAction,
  subjectGardenView,
} from "../src/home/garden-console.mjs";
import { operatorGardenJournal } from "../src/home/garden-journal-console.mjs";
import { DAY, HOUR, defaultGardenSettings } from "../src/home/garden-rules.mjs";
import { GardenService } from "../src/home/garden-service.mjs";
import { fixedWeather } from "./garden-fixtures.mjs";
import { config, context, fixture } from "./helpers.mjs";

const admin = { kind: "admin", id: "administrator" };
function setup(t, id, { run, weather = "cloud" } = {}) {
  const cfg = config(2);
  for (const role of cfg.agents) role.subject.enabled = true;
  const { runtime, store } = fixture(t, { cfg, run });
  let garden = runtime.home.garden;
  let now = Date.UTC(2026, 0, 1);
  runtime.clock = () => now;
  const settings = defaultGardenSettings();
  settings.initialBalance = 3000;
  settings.turnLimit = 30;
  settings.weather = fixedWeather(weather);
  settings.events.rate = 1;
  const set = (state, id) => {
    for (const [key, entry] of Object.entries(state.events.entries))
      entry.enabled = key === id;
  };
  set(settings, id);
  for (const crop of Object.values(settings.crops)) {
    crop.hours = 3;
    crop.dailyWater = 0;
    crop.fertilizer = 0;
  }
  const actors = cfg.agents.map(({ id }, i) => ({
    kind: "agent",
    id,
    turnId: `memory-${i}`,
  }));
  for (const role of actors) {
    const gen = runtime.home.generation(role.id);
    settings.roles[role.id] = gen;
    settings.giftBudgetGenerations[role.id] = gen;
    settings.giftBudgets.roles[role.id] = 100;
  }
  settings.giftBudgets.total = 200;
  garden.initialize(now, settings);
  garden.syncClock(now, true);
  const act = (action, actor = admin, requestId = randomUUID()) =>
    performGardenAction(runtime, actor, { requestId, action });
  const view = (actor = admin) =>
    actor.kind === "admin"
      ? adminGardenView(runtime)
      : subjectGardenView(runtime, actor.id, actor.turnId);
  const pick = (choiceId, actor = admin, filters = {}, projectId) => {
    const state = view(actor);
    const actions = projectId
      ? state.gardenProjects.find(({ id }) => id === projectId)?.actions
      : actor.kind === "admin"
        ? state.eventActions
        : state.event?.actions;
    const choice = actions?.find(
      ({ args }) =>
        args.choiceId === choiceId &&
        Object.entries(filters).every(([key, value]) => args[key] === value),
    );
    assert.ok(choice, `missing ${choiceId}: ${JSON.stringify(actions)}`);
    return { kind: choice.kind, ...choice.args };
  };
  const change = (update) => {
    const state = garden.requireState();
    update(state.settings);
    garden.configure(now, state.settingsRevision, state.settings);
  };
  return {
    runtime,
    store,
    actors,
    act,
    pick,
    view,
    change,
    get garden() {
      return garden;
    },
    sow: (plot, cropId) =>
      act({
        kind: "plant",
        plot,
        cropId,
        buyPrice: settings.crops[cropId].seedPrice,
      }).plantId,
    harvest: (plot, plantId) => act({ kind: "harvest", plot, plantId }),
    advance(delta) {
      now += delta;
      garden.syncClock(now, true);
    },
    reopen() {
      garden.syncClock(now, false);
      garden = runtime.home.garden = new GardenService(store);
      garden.syncClock(now, true);
    },
  };
}

test("only a real floating gourd returns with three actual weather days and grants one physical item", (t) => {
  for (const choose of ["keep-gourd", "cut-dipper"]) {
    const f = setup(t, "drift-gourd-returns");
    const plant = f.sow(1, "drift-gourd");
    f.advance(2 * DAY);
    const harvested = f.harvest(1, plant);
    assert.equal(harvested.harvestStage, "floating");
    f.advance(DAY);
    const launch = f.pick("release-gourd", f.actors[0], {
      harvestId: harvested.harvestId,
    });
    f.act(launch, f.actors[0]);
    f.change((settings) => {
      settings.weather = fixedWeather("drizzle");
    });
    f.advance(2 * DAY);
    assert.equal(f.view().followups.length, 0);
    assert.equal(f.view(f.actors[1]).gardenProjects[0].actions.length, 0);
    f.reopen();
    f.advance(DAY);
    const { text } = f.view().followups.find(({ id }) => id === launch.eventId);
    assert.match(text, /第 4 天.*第 5 天.*第 6 天/);
    const action = f.pick(choose, f.actors[1], {}, launch.eventId);
    const request = randomUUID();
    f.act(action, f.actors[1], request);
    assert.equal(f.act(action, f.actors[1], request).replayed, true);
    const [item] = f.view(f.actors[1]).personalGifts.items;
    assert.equal(
      item.giftId,
      choose === "keep-gourd" ? "drift-gourd" : "gourd-dipper",
    );
    assert.equal(item.craftMeta.ingredients[0].plantId, plant);
    assert.equal(item.craftMeta.weatherRoute.length, 3);
    assert.equal(
      item.craftMeta.weatherRoute[1].weather[0],
      f.view().weather.name,
    );
  }
});

test("a selected nine-plot photo renders its actual historical plant after the plot is replanted", async (t) => {
  const f = setup(t, "old-nine-plot-photo");
  assert.equal(
    adminGardenWrite(f.runtime, "event-trial", { day: 1 }).rows.find(
      ({ id }) => id === "old-nine-plot-photo",
    ).probability,
    0,
  );
  const old = f.sow(1, "clover");
  const another = f.sow(2, "mint");
  f.advance(DAY);
  assert.equal(
    JSON.parse(
      f.store.db
        .prepare("SELECT plots FROM garden_memory_days WHERE day=1")
        .get().plots,
    ).length,
    9,
  );
  f.harvest(1, old);
  f.sow(1, "sunflower");
  const query = { view: "plant", referenceDay: 1, plot: 1 };
  const guest = context(f.runtime, f.actors[1].id);
  assert.equal(
    (await f.runtime.callTool(guest, "garden_read", query)).plantId,
    old,
  );
  assert.equal(f.view().event.photos[0].plots.length, 9);
  assert.equal(f.view().event.today[0].name, "向日葵");
  assert.deepEqual(f.view().event.photos[0].plots[8], {
    plot: 9,
    name: null,
    stage: null,
  });
  const pick = f.pick("compare-plot", admin, { referenceDay: 1, plot: 1 });
  const { outcome } = f.act(pick);
  assert.equal(outcome.plantCard.before.plantId, old);
  assert.equal(outcome.plantCard.after.cropId, "sunflower");
  assert.equal(outcome.plantCard.before.cropId, "clover");
  f.reopen();
  const card = await f.runtime.callTool(guest, "garden_read", query);
  assert.equal(card.referenceDay, 1);
  assert.equal(card.plantId, old);
  assert.equal(card.status, "mature");
  assert.notEqual(card.plantId, another);
  assert.equal(
    (await f.runtime.callTool(guest, "garden_read", { ...query, plot: 2 }))
      .plantId,
    another,
  );
  await assert.rejects(
    f.runtime.callTool(guest, "garden_read", { ...query, plot: 9 }),
    /INVALID_REQUEST/,
  );
  const image = await operatorGardenJournal(
    f.runtime,
    outcome.plantCard.imageRequest,
  );
  assert.equal(
    Buffer.from(image.png, "base64").subarray(1, 4).toString(),
    "PNG",
  );
});

test("a time jar follows two real plant milestones, ignoring duplicate and souvenir blooms", (t) => {
  const f = setup(t, "future-garden-jar");
  f.sow(1, "perilla");
  f.advance(DAY);
  const target = f.pick("bury-blooms", admin, { plot: 1 });
  f.act(target);
  const id = target.eventId;
  const first = f.sow(2, "sunflower");
  f.advance(8 * HOUR);
  f.garden.journal.record({
    type: "mature",
    source: "action",
    clock: f.view().clock,
    plants: [
      { plot: 2, plantId: first, cropId: "sunflower", name: "纪念花开" },
    ],
    key: "echo-first-bloom-fixture",
  });
  assert.throws(
    () => f.act({ kind: "choose_event", choiceId: "open-jar", eventId: id }),
    /GARDEN_EVENT_CHOICE_INVALID/,
  );
  f.sow(3, "moonflower");
  f.reopen();
  f.advance(3 * DAY);
  const action = f.pick("open-jar", f.actors[1], {}, id);
  const { outcome } = f.act(action, f.actors[1]);
  assert.equal(outcome.evidence.length, 2);
  assert.ok(outcome.evidence.every(({ factId }) => Number.isInteger(factId)));
  assert.ok(!outcome.evidence.some(({ plant }) => plant === "纪念花开"));
});

test("a rain jar stays shut through prior rain and opens after three observed rainy days across catch-up", (t) => {
  const f = setup(t, "future-garden-jar", { weather: "drizzle" });
  f.sow(1, "perilla");
  f.advance(DAY + HOUR);
  const action = f.pick("bury-rain", f.actors[0], { plot: 1 });
  f.act(action, f.actors[0]);
  f.reopen();
  f.advance(3 * DAY);
  const progress = f
    .view(f.actors[1])
    .gardenProjects.find(({ id }) => id === action.eventId);
  assert.match(progress.detail, /2\/3/);
  assert.equal(progress.actions.length, 0);
  f.advance(DAY);
  const { outcome } = f.act(
    f.pick("open-jar", f.actors[1], {}, action.eventId),
    f.actors[1],
  );
  assert.deepEqual(
    outcome.evidence.map(({ day }) => day),
    [3, 4, 5],
  );
});

test("silver paper moon and an owned lamp make one night card with a real source plant", (t) => {
  const f = setup(t, "paper-moon-shadow");
  const [owner, other] = f.actors;
  const moon = f.sow(1, "paper-moon");
  const pumpkin = f.sow(2, "pocket-pumpkin");
  const retained = f.sow(3, "moonflower");
  f.advance(2 * DAY);
  const silver = f.harvest(1, moon);
  assert.equal(silver.harvestStage, "silver");
  const hard = f.harvest(2, pumpkin);
  const lamp = f.act(
    {
      kind: "craft_gift",
      recipeId: "craft-pumpkin-lantern",
      harvestIds: [hard.harvestId],
      price: 14,
    },
    owner,
  );
  f.advance(DAY + 8 * HOUR);
  assert.equal(f.view(owner).event.actions.length, 0);
  f.advance(12 * HOUR);
  const action = f.pick("make-shadow-card", owner, {
    itemId: lamp.itemId,
    harvestId: silver.harvestId,
    plot: 3,
  });
  assert.throws(() => f.act(action, other), /GARDEN_EVENT_CHOICE_INVALID/);
  f.act(action, owner);
  const items = f.view(owner).personalGifts.items;
  assert.ok(items.some(({ id }) => id === lamp.itemId));
  const card = items.find(({ giftId }) => giftId === "paper-moon-night-card");
  assert.equal(card.craftMeta.ingredients[0].plantId, moon);
  assert.equal(card.craftMeta.ingredients[1].plantId, retained);
});

test("seasonal display samples an actively chosen template and keeps original item IDs and private notes out of history", async (t) => {
  const f = setup(t, "seasonal-door-display");
  const [owner, receiver] = f.actors;
  f.garden.gifts.grantEventItem(
    {
      kind: "agent",
      id: owner.id,
      generation: f.runtime.home.generation(owner.id),
    },
    "perilla-half-cloth",
    "私人背面字",
  );
  const sample = f.view(owner).personalGifts.items[0];
  f.act(
    {
      kind: "send_gift",
      itemId: sample.id,
      recipient: { kind: "agent", id: receiver.id },
      note: "这份赠言别公开",
    },
    owner,
  );
  f.advance(DAY);
  const action = f.pick("hang-keepsake", receiver, { itemId: sample.id });
  assert.throws(() => f.act(action, owner), /GARDEN_EVENT_CHOICE_INVALID/);
  f.act(action, receiver);
  const first = f.view().gateHistory;
  assert.equal(first[0].season, 1);
  const guest = context(f.runtime, owner.id);
  const published = await f.runtime.callTool(guest, "garden_read", {
    view: "gate_history",
  });
  assert.deepEqual(published, { gateHistory: first });
  assert.deepEqual(Object.keys(first[0].display).sort(), ["name", "style"]);
  assert.ok(!JSON.stringify(first).includes(sample.id));
  assert.ok(!JSON.stringify(first).includes("赠言"));
  f.advance(7 * DAY);
  f.act(f.pick("hang-keepsake", receiver, { itemId: sample.id }), receiver);
  assert.deepEqual(
    f.view().gateHistory.map(({ season }) => season),
    [2, 1],
  );
  assert.equal(
    f.view(receiver).personalGifts.received[0].note,
    "这份赠言别公开",
  );
});

test("an actually empty saved plot can be compared to a new plant and renders the present plant", async (t) => {
  const f = setup(t, "old-nine-plot-photo");
  f.advance(DAY);
  assert.equal(f.view().event.photos[0].plots[0].name, null);
  assert.ok(!f.view().eventActions.some(({ args }) => args.plot === 1));
  const planted = f.sow(1, "mint");
  const { outcome } = f.act(
    f.pick("compare-plot", admin, { referenceDay: 1, plot: 1 }),
  );
  assert.equal(outcome.plantCard.before, null);
  assert.equal(outcome.plantCard.after.plantId, planted);
  assert.deepEqual(outcome.plantCard.imageRequest, {
    view: "plant_image",
    plantId: planted,
  });
  const guest = context(f.runtime, f.actors[0].id);
  await assert.rejects(
    f.runtime.callTool(guest, "garden_read", {
      view: "plant",
      referenceDay: 1,
      plot: 1,
    }),
    /INVALID_REQUEST/,
  );
});

test("upgrading an active old garden never invents pre-upgrade snapshots", (t) => {
  const f = setup(t, "old-nine-plot-photo");
  f.sow(1, "clover");
  f.advance(3 * DAY);
  // Recreate an existing save at the migration boundary without any new history rows.
  f.store.db.exec(
    "DELETE FROM garden_memory_days; DELETE FROM garden_memory_coverage",
  );
  f.reopen();
  const first = f.store.db
    .prepare("SELECT first_day FROM garden_memory_coverage")
    .get().first_day;
  assert.equal(first, 4);
  assert.deepEqual(
    f.store.db.prepare("SELECT day FROM garden_memory_days").all(),
    [],
  );
  assert.equal(
    adminGardenWrite(f.runtime, "event-trial", { day: 4 }).rows.find(
      ({ id }) => id === "old-nine-plot-photo",
    ).probability,
    0,
  );
  f.advance(DAY);
  assert.deepEqual(
    f.store.db
      .prepare("SELECT day FROM garden_memory_days")
      .all()
      .map(({ day }) => day),
    [4],
  );
  assert.equal(f.view().event.photos[0].day, 4);
});
