import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  adminGardenView,
  adminGardenWrite,
  performGardenAction,
  subjectGardenView,
} from "../src/home/garden-console.mjs";
import { GardenService } from "../src/home/garden-service.mjs";
import {
  DAY,
  HOUR,
  defaultGardenSettings,
  rattlePeaCount,
} from "../src/home/garden-rules.mjs";
import { fixedWeather } from "./garden-fixtures.mjs";
import { config, context, fixture } from "./helpers.mjs";

const admin = { kind: "admin", id: "administrator" };

function setup(t, eventId, { weather = "cloud", run, customize } = {}) {
  const cfg = config(2);
  for (const role of cfg.agents) {
    role.subject.enabled = true;
    role.subject.maxToolCallsPerTurn = 20;
  }
  const { runtime, store } = fixture(t, { cfg, run });
  let now = Date.UTC(2026, 0, 1);
  runtime.clock = () => now;
  let garden = runtime.home.garden;
  const settings = defaultGardenSettings();
  settings.initialBalance = 1500;
  settings.weather = fixedWeather(weather);
  settings.events.rate = 1;
  for (const [id, entry] of Object.entries(settings.events.entries))
    entry.enabled = id === eventId;
  for (const crop of Object.values(settings.crops)) {
    crop.hours = 4;
    crop.fertilizer = 0;
  }
  settings.roles = Object.fromEntries(
    cfg.agents.map(({ id }) => [id, runtime.home.generation(id)]),
  );
  customize?.(settings);
  garden.initialize(now, settings);
  garden.syncClock(now, true);
  const actors = cfg.agents.map(({ id }, i) => ({
    kind: "agent",
    id,
    turnId: `explorer-${i}`,
  }));
  const act = (action, actor = admin, requestId = randomUUID()) =>
    performGardenAction(runtime, actor, { requestId, action });
  const view = () => adminGardenView(runtime);
  return {
    runtime,
    actors,
    view,
    act,
    get garden() {
      return garden;
    },
    get db() {
      return store.db;
    },
    sow: (plot, cropId) =>
      act({
        kind: "plant",
        plot,
        cropId,
        buyPrice: settings.crops[cropId].seedPrice,
      }).plantId,
    advance: (delta) => {
      now += delta;
      garden.syncClock(now, true);
    },
    reopen: () => {
      garden.syncClock(now, false);
      garden = runtime.home.garden = new GardenService(store);
      garden.syncClock(now, true);
    },
    subject: (actor = actors[0]) =>
      subjectGardenView(runtime, actor.id, actor.turnId),
    choose: (choiceId, { plot, actor, requestId } = {}) => {
      const actions = actor
        ? subjectGardenView(runtime, actor.id, actor.turnId).event.actions
        : view().eventActions;
      const selected = actions.find(
        ({ args }) => args.choiceId === choiceId && args.plot === plot,
      );
      assert.ok(selected, `missing ${choiceId} ${plot ?? ""}`);
      return act({ ...selected.args, kind: selected.kind }, actor, requestId);
    },
  };
}

test("the explorer presets enter the true draw and trial with live story conditions", (t) => {
  const f = setup(t, "pea-guess");
  const trial = () => adminGardenWrite(f.runtime, "event-trial", { day: 2 });
  assert.equal(
    trial().rows.find(({ id }) => id === "pea-guess").probability,
    0,
  );
  f.sow(1, "rattle-pea");
  f.advance(8 * HOUR);
  assert.equal(
    trial().rows.find(({ id }) => id === "pea-guess").probability,
    1,
  );
  f.advance(16 * HOUR);
  assert.equal(f.view().event.effect.story, "pea_guess");
});

test("multiple roles guess once each before a real pod opens, and the overview and history omit private guesses", async (t) => {
  const f = setup(t, "pea-guess", {
    run: async (p) => {
      const { event } = await p.callTool("garden_read", { view: "overview" });
      assert.equal(event.game, undefined);
      const selected = event.actions.find(
        ({ args }) => args.choiceId === "guess-2",
      );
      const request = {
        kind: selected.kind,
        args: selected.args,
        requestId: randomUUID(),
      };
      await p.callTool("garden_act", request);
      const replay = await p.callTool("garden_act", request);
      assert.equal(replay.replayed, true);
      const updated = await p.callTool("garden_read", { view: "overview" });
      assert.ok(
        !updated.event.actions.some(({ args }) =>
          args.choiceId.startsWith("guess-"),
        ),
      );
    },
  });
  const plantId = f.sow(1, "rattle-pea");
  f.advance(DAY);
  assert.equal(
    (await f.runtime.wake(f.actors[0].id, "@subject")).status,
    "completed-no-send",
  );
  f.choose("guess-3", { actor: f.actors[1] });
  const actual = rattlePeaCount(f.view().plots[0].plant);
  const listened = f.choose("listen").outcome;
  assert.match(listened.detail, new RegExp("嗒".repeat(actual)));
  const reveal = f.choose("open-pod").outcome;
  assert.match(reveal.detail, new RegExp(`共 ${actual} 颗豆。共有 2 份猜数`));
  assert.match(reveal.detail, /猜数从 2 到 3 颗/);
  const harvest = f.act({ kind: "harvest", plot: 1, plantId });
  assert.equal(harvest.quantity, actual);
  assert.ok(!f.view().eventHistory.some((row) => "game" in row));
  const guest = context(f.runtime, f.actors[0].id);
  const publicView = await f.runtime.callTool(guest, "garden_read", {
    view: "public",
  });
  assert.equal(publicView.event.game, undefined);
  assert.equal(publicView.event.actions, undefined);
  await assert.rejects(
    f.runtime.callTool(guest, "garden_act", {
      kind: "choose_event",
      args: { eventId: f.view().event.id, choiceId: "open-pod" },
      requestId: randomUUID(),
    }),
    /TOOL_DISABLED/,
  );
});

test("snail route records both real plots, and leaf guessing freezes actual crop candidates", (t) => {
  for (const id of ["snail-silver-map", "leaf-identity"]) {
    const f = setup(t, id);
    f.sow(1, "morning-glory");
    f.sow(4, "lambs-ear");
    f.advance(DAY);
    const { event, eventActions } = f.view();
    assert.equal(event.game, undefined);
    if (id === "snail-silver-map") {
      const map = f.choose("draw-map").outcome;
      assert.deepEqual([...map.plots].sort(), [1, 4]);
      assert.ok(
        f.garden
          .timeline({ type: "event" })
          .entries.some(
            ({ plants }) =>
              plants.length === 2 && plants.some(({ plot }) => plot === 4),
          ),
      );
    } else {
      assert.match(event.description, /叶|绒毛/);
      assert.equal(eventActions.length, 2);
      assert.ok(
        eventActions[0].label.includes(f.view().plots[0].plant.crop.name),
      );
      const result = f.choose("leaf-a").outcome;
      assert.equal(result.plots.length, 1);
      assert.match(result.detail, /这张叶子来自.*另一张来自/);
    }
  }
});

test("rain bamboo changes real water, and sparrow prints never disable planting", (t) => {
  const rain = setup(t, "bamboo-rain", {
    weather: "drizzle",
    customize(settings) {
      settings.crops["lambs-ear"].hours = 120;
    },
  });
  rain.sow(1, "lambs-ear");
  const before = rain.view().plots[0].plant.water;
  rain.choose("divert-water", { plot: 1 });
  assert.equal(rain.view().plots[0].plant.water, Math.min(100, before + 25));
  const sand = setup(t, "sparrow-sandbath");
  sand.choose("leave-print", { plot: 2 });
  assert.equal(sand.sow(2, "lambs-ear"), sand.view().plots[1].plant.id);
});

test("a chosen balsam dish grants one seed bag and the same pod will not grant another", (t) => {
  const f = setup(t, "balsam-dishes");
  const plantId = f.sow(1, "balsam");
  f.advance(DAY);
  assert.equal(f.view().mysterySeeds.count, 0);
  const result = f.choose("dish-right").outcome;
  assert.match(result.detail, /正好接住|捡回花籽/);
  assert.equal(f.view().mysterySeeds.count, 1);
  assert.throws(
    () => f.act({ kind: "pop_seed_pod", plot: 1, plantId }),
    /GARDEN_/,
  );
  f.act({ kind: "harvest", plot: 1, plantId });
  assert.equal(f.view().mysterySeeds.count, 1);
  const f2 = setup(t, "balsam-dishes");
  const secondPlant = f2.sow(1, "balsam");
  f2.advance(DAY);
  f2.act({ kind: "pop_seed_pod", plot: 1, plantId: secondPlant });
  assert.equal(f2.view().mysterySeeds.count, 1);
  assert.ok(
    !f2
      .view()
      .eventActions.some(({ args }) => args.choiceId.startsWith("dish-")),
  );
});

test("shadow comparison fires at the next day's exact same time after restarting, with an early harvest marker", (t) => {
  const f = setup(t, "shadow-measure", {
    customize(settings) {
      settings.crops["lambs-ear"].hours = 30;
      settings.crops["lambs-ear"].dailyWater = 0;
    },
  });
  const plantId = f.sow(1, "lambs-ear");
  f.advance(DAY + 2 * HOUR);
  f.choose("measure", { plot: 1 });
  f.advance(18 * HOUR);
  f.act({ kind: "harvest", plot: 1, plantId });
  f.reopen();
  f.advance(5 * HOUR);
  assert.equal(f.view().followups.length, 0);
  f.advance(HOUR);
  assert.equal(f.view().followups.length, 1);
  assert.match(f.view().followups[0].text, /末次标记是 100 格/);
  const fact = f.garden.timeline({ type: "followup" }).entries[0];
  assert.equal(fact.time, "02:00");
  assert.equal(fact.plants[0].plantId, plantId);
  f.advance(2 * DAY);
  assert.equal(f.garden.timeline({ type: "followup" }).entries.length, 1);
});

test("a leaf boat changes direction only after real garden time, and the later partner journals it", (t) => {
  const f = setup(t, "boot-pond", { weather: "drizzle" });
  f.choose("launch-boat", { actor: f.actors[0] });
  assert.ok(
    !f
      .subject()
      .event.actions.some(({ args }) => args.choiceId === "watch-boat"),
  );
  assert.match(
    f.choose("watch-boat", { actor: f.actors[1] }).outcome.detail,
    /仍朝着靴口/,
  );
  f.advance(HOUR);
  assert.match(f.subject(f.actors[1]).event.description, /转向靴尖/);
  assert.match(
    f.choose("watch-boat", { actor: f.actors[1] }).outcome.detail,
    /转向靴尖/,
  );
  assert.ok(
    f.garden
      .timeline({ type: "event" })
      .entries.some(({ text }) => text.includes("转向靴尖")),
  );
});

test("weather chime preview rolls back a simulated shadow comparison until the exact observed time", (t) => {
  const f = setup(t, "shadow-measure", {
    customize(settings) {
      settings.crops["lambs-ear"].hours = 80;
      settings.crops["lambs-ear"].dailyWater = 0;
      settings.weather.entries.sun.conditions = [
        { field: "balance", op: "gt", value: 0 },
      ];
    },
  });
  f.act({ kind: "build_facility", facilityId: "weather_chime", price: 280 });
  f.sow(1, "lambs-ear");
  f.advance(DAY + 2 * HOUR);
  f.choose("measure", { plot: 1 });
  f.advance(DAY - HOUR);
  const comparison = () =>
    f.db.prepare("SELECT result FROM garden_explorer_comparisons").get().result;
  assert.equal(comparison(), null);
  assert.ok(f.view().tomorrowForecast?.hint);
  assert.ok(f.garden.observe(f.runtime.now()).tomorrowForecast?.hint);
  assert.equal(comparison(), null);
  assert.deepEqual(f.garden.timeline({ type: "followup" }).entries, []);
  f.advance(HOUR);
  assert.equal(typeof comparison(), "string");
  assert.equal(
    f.garden.timeline({ type: "followup" }).entries[0].time,
    "02:00",
  );
});
