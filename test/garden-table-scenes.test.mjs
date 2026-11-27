import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  performGardenAction,
  subjectGardenView,
} from "../src/home/garden-console.mjs";
import { DAY, HOUR, defaultGardenSettings } from "../src/home/garden-rules.mjs";
import { GardenService } from "../src/home/garden-service.mjs";
import { fixedWeather } from "./garden-fixtures.mjs";
import { config, fixture } from "./helpers.mjs";

const admin = { kind: "admin", id: "administrator" };

function setup(t, eventId, weather = "cloud") {
  const cfg = config(3);
  for (const role of cfg.agents) role.subject.enabled = true;
  const { runtime, store } = fixture(t, { cfg });
  let now = Date.UTC(2026, 0, 1);
  runtime.clock = () => now;
  let garden = runtime.home.garden;
  const settings = defaultGardenSettings();
  settings.turnLimit = 20;
  settings.events.rate = 1;
  settings.weather = fixedWeather(weather);
  for (const [id, preset] of Object.entries(settings.events.entries))
    preset.enabled = id === eventId;
  for (const crop of Object.values(settings.crops)) {
    crop.hours = 4;
    crop.dailyWater = 0;
  }
  settings.roles = Object.fromEntries(
    cfg.agents.map(({ id }) => [id, runtime.home.generation(id)]),
  );
  garden.initialize(now, settings);
  garden.syncClock(now, true);
  const actors = cfg.agents.map(({ id }, index) => ({
    kind: "agent",
    id,
    turnId: `table-${index}`,
  }));
  const act = (action, actor = admin, requestId = randomUUID()) =>
    performGardenAction(runtime, actor, { requestId, action });
  const view = (actor = actors[0]) =>
    subjectGardenView(runtime, actor.id, actor.turnId);
  return {
    actors,
    act,
    view,
    timeline: () =>
      garden.timeline({ type: "event" }, { publicView: true }).entries,
    choose(
      choiceId,
      { actor = actors[0], harvestId, cropId, text, requestId } = {},
    ) {
      const option = view(actor).event.actions.find(
        ({ args }) =>
          args.choiceId === choiceId &&
          args.harvestId === harvestId &&
          args.cropId === cropId,
      );
      assert.ok(option, `missing action ${choiceId}`);
      return act(
        {
          kind: option.kind,
          ...option.args,
          ...(text !== undefined && { text }),
        },
        actor,
        requestId,
      );
    },
    sow(plot, cropId) {
      return act({
        kind: "plant",
        plot,
        cropId,
        buyPrice: settings.crops[cropId].seedPrice,
      }).plantId;
    },
    harvest(plot, plantId) {
      return act({ kind: "harvest", plot, plantId });
    },
    lot(id) {
      return store.db
        .prepare(
          "SELECT crop_id, plant_id, quantity, harvest_meta FROM garden_harvests WHERE id=?",
        )
        .get(id);
    },
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

test("popcorn consumes only a genuine dry ear, keeps its chosen name, and serves each visitor once", (t) => {
  const f = setup(t, "first-popcorn");
  const plantId = f.sow(1, "sweet-corn");
  f.advance(6 * HOUR);
  const tender = f.harvest(1, plantId);
  f.advance(18 * HOUR);
  const dry = f.harvest(1, plantId);
  assert.equal(tender.harvestStage, "tender");
  assert.equal(dry.harvestStage, "dry");
  f.advance(DAY);
  const event = f.view().event;
  assert.equal(event.id, "3:first-popcorn");
  assert.deepEqual(
    event.actions.map(({ args }) => args.harvestId),
    [dry.harvestId],
  );
  assert.throws(
    () =>
      f.act(
        {
          kind: "choose_event",
          eventId: event.id,
          choiceId: "pop_corn",
          harvestId: tender.harvestId,
        },
        f.actors[0],
      ),
    /GARDEN_EVENT_CHOICE_INVALID/,
  );
  assert.equal(f.lot(tender.harvestId).quantity, 1);
  assert.match(
    f.choose("pop_corn", { harvestId: dry.harvestId }).outcome.detail,
    /第一粒爆成了/,
  );
  assert.equal(f.lot(dry.harvestId).quantity, 0);
  assert.match(
    f.choose("name_pop", { text: "  听雨的小星星  " }).outcome.detail,
    /「听雨的小星星」/,
  );
  const actor = f.actors[0];
  const requestId = randomUUID();
  const tasting = {
    kind: "choose_event",
    eventId: event.id,
    choiceId: "taste_pop",
  };
  assert.match(
    f.choose("taste_pop", { actor, requestId }).outcome.detail,
    /听雨的小星星/,
  );
  assert.equal(f.act(tasting, actor, requestId).replayed, true);
  f.reopen();
  assert.throws(() => f.act(tasting, actor), /GARDEN_EVENT_CHOICE_INVALID/);
  assert.match(
    f.choose("taste_pop", { actor: f.actors[1] }).outcome.detail,
    /听雨的小星星/,
  );
  assert.equal(f.lot(tender.harvestId).quantity, 1);
});

test("bench visitors can return and see a new view after restarting", (t) => {
  const f = setup(t, "wobbly-bench");
  f.sow(2, "mint");
  f.sow(4, "tomato");
  const eventId = f.view().event.id;
  assert.deepEqual(
    f.view().event.actions.map(({ args }) => args.choiceId),
    ["prop_wood", "prop_pot"],
  );
  assert.match(f.choose("prop_pot").outcome.detail, /倒扣的花盆/);
  const first = f.choose("sit_bench", { actor: f.actors[0] }).outcome.detail;
  f.advance(3 * HOUR);
  const second = f.choose("sit_bench", { actor: f.actors[1] }).outcome.detail;
  assert.match(first, /陶盆.*0 时.*2 号地的薄荷/);
  assert.match(second, /陶盆.*3 时.*4 号地的小灯笼番茄/);
  f.reopen();
  f.advance(2 * HOUR);
  const requestId = randomUUID();
  const again = f.choose("sit_bench", { actor: f.actors[0], requestId });
  assert.match(again.outcome.detail, /陶盆.*5 时.*1 号地空着/);
  const action = { kind: "choose_event", eventId, choiceId: "sit_bench" };
  assert.equal(f.act(action, f.actors[0], requestId).replayed, true);
  assert.match(
    f.choose("sit_bench", { actor: f.actors[0] }).outcome.detail,
    /3 号地空着/,
  );
});

test("mint ice permits a return at a different time and stops only after three cups", (t) => {
  const f = setup(t, "melting-mint-ice", "sun");
  const plantId = f.sow(1, "mint");
  f.advance(8 * HOUR);
  const { harvestId } = f.harvest(1, plantId);
  f.advance(DAY);
  const eventId = f.view().event.id;
  assert.equal(eventId, "2:melting-mint-ice");
  assert.match(
    f.choose("freeze_mint", { harvestId }).outcome.detail,
    /三块薄荷冰/,
  );
  assert.equal(f.lot(harvestId).quantity, 0);
  assert.match(
    f.choose("sip_mint", { actor: f.actors[0] }).outcome.detail,
    /碎冰.*2 杯/,
  );
  f.advance(3 * HOUR);
  assert.match(
    f.choose("sip_mint", { actor: f.actors[1] }).outcome.detail,
    /碎冰.*1 杯/,
  );
  f.reopen();
  f.advance(6 * HOUR);
  assert.match(
    f.choose("sip_mint", { actor: f.actors[0] }).outcome.detail,
    /冰角已化.*0 杯/,
  );
  assert.equal(f.view().event.status, "resolved");
  assert.deepEqual(f.view().event.actions, []);
  assert.throws(
    () =>
      f.act(
        { kind: "choose_event", eventId, choiceId: "sip_mint" },
        f.actors[2],
      ),
    /GARDEN_EVENT_ALREADY_RESOLVED/,
  );
});

test("a menu accepts a free name, tests guesses against the real ingredient, and never swaps the consumed lot", (t) => {
  const f = setup(t, "mixed-menu");
  const plantId = f.sow(1, "tomato");
  const otherPlant = f.sow(2, "clover");
  f.advance(6 * HOUR);
  const meal = f.harvest(1, plantId).harvestId;
  const other = f.harvest(2, otherPlant).harvestId;
  f.advance(DAY);
  const eventId = f.view().event.id;
  assert.equal(eventId, "2:mixed-menu");
  assert.equal(
    f.choose("cook_dish", { harvestId: meal }).outcome.harvestId,
    undefined,
  );
  const used = f.lot(meal);
  assert.equal(used.quantity, 0);
  assert.equal(used.plant_id, plantId);
  const naming = (text) =>
    f.act(
      {
        kind: "choose_event",
        eventId,
        choiceId: "name_dish",
        text,
      },
      f.actors[0],
    );
  assert.throws(() => naming("  "), { name: "ZodError" });
  const name = "晚风番茄，有一点甜";
  assert.equal(f.choose("name_dish", { text: name }).outcome.dishName, name);
  const wrong = f
    .view()
    .event.actions.find(
      ({ args }) => args.choiceId === "guess_dish" && args.cropId !== "tomato",
    );
  assert.ok(wrong);
  const wrongGuess = f.choose("guess_dish", {
    cropId: wrong.args.cropId,
  }).outcome;
  assert.match(wrongGuess.detail, /翻开菜牌看看.*小灯笼番茄/);
  assert.ok(wrongGuess.detail.includes(name));
  assert.equal(wrongGuess.harvestId, meal);
  f.reopen();
  const correct = f.choose("guess_dish", {
    cropId: "tomato",
    actor: f.actors[1],
  }).outcome;
  assert.match(correct.detail, /尝出来了.*小灯笼番茄/);
  assert.equal(correct.harvestId, meal);
  assert.deepEqual(f.lot(meal), used);
  assert.equal(f.lot(other).quantity, 1);
});

test("the menu's unopened taste view cannot identify a partly used lot by its public inventory ID", (t) => {
  const f = setup(t, "mixed-menu");
  const pea = f.sow(1, "rattle-pea");
  f.advance(8 * HOUR);
  const lot = f.harvest(1, pea);
  f.advance(DAY);
  const cooked = f.choose("cook_dish", { harvestId: lot.harvestId });
  assert.equal(cooked.outcome.harvestId, undefined);
  const visitor = f.view(f.actors[1]);
  assert.ok(
    visitor.inventory.harvests.some(
      ({ id, cropId }) => id === lot.harvestId && cropId === "rattle-pea",
    ),
  );
  assert.equal(visitor.event.outcome.harvestId, undefined);
  assert.ok(!visitor.event.outcome.detail.includes("响铃豌豆"));
  const facts = f
    .timeline()
    .filter(({ detail }) => detail.eventId === visitor.event.id);
  assert.ok(facts.length > 0);
  assert.ok(!JSON.stringify(facts).includes(lot.harvestId));
  assert.ok(!JSON.stringify(facts).includes("响铃豌豆"));
});
