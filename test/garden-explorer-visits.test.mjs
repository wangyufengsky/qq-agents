import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { config, fixture } from "./helpers.mjs";
import { fixedWeather } from "./garden-fixtures.mjs";
import { DAY, HOUR, defaultGardenSettings } from "../src/home/garden-rules.mjs";
import { GardenService } from "../src/home/garden-service.mjs";
import {
  adminGardenView,
  performGardenAction,
  subjectGardenView,
} from "../src/home/garden-console.mjs";
import { explorerPresets } from "../src/home/garden-explorer-rules.mjs";

function setup(t, story) {
  const { runtime, store } = fixture(t, { cfg: config(2) });
  const settings = defaultGardenSettings();
  let now = Date.UTC(2026, 0, 1);
  runtime.clock = () => now;
  settings.turnLimit = 40;
  settings.weather = fixedWeather("cloud");
  settings.events.rate = 1;
  for (const entry of Object.values(settings.events.entries))
    entry.enabled =
      entry.effect.kind === "explorer" && entry.effect.story === story;
  settings.crops["rattle-pea"].hours = 2;
  settings.crops["rattle-pea"].dailyWater = 0;
  const actors = runtime.config.agents.map(({ id }, i) => ({
    kind: "agent",
    id,
    turnId: "visit-test-" + i,
  }));
  for (const actor of actors)
    settings.roles[actor.id] = runtime.home.generation(actor.id);
  let garden = runtime.home.garden;
  garden.initialize(now, settings);
  garden.syncClock(now, true);
  return {
    actors,
    store,
    runtime,
    get garden() {
      return garden;
    },
    act(actor, action, requestId = randomUUID()) {
      return performGardenAction(runtime, actor, { requestId, action });
    },
    advance(elapsed) {
      now += elapsed;
      garden.syncClock(now, true);
    },
    view(actor) {
      return subjectGardenView(runtime, actor.id, actor.turnId);
    },
    reopen() {
      garden.syncClock(now, false);
      garden = runtime.home.garden = new GardenService(store);
      garden.syncClock(now, true);
    },
  };
}

test("windmill can be placed and moved by different visitors and remembers the actual plot, sky and crop", (t) => {
  const f = setup(t, "windmill");
  const [first, second] = f.actors;
  f.act(first, {
    kind: "plant",
    plot: 1,
    cropId: "mint",
    buyPrice: f.garden.requireState().settings.crops.mint.seedPrice,
  });
  const initial = f.view(first).event;
  const pick = (event, plot) => {
    const a = event.actions.find((a) => a.args.plot === plot);
    assert.ok(a);
    return { kind: a.kind, ...a.args };
  };
  const result = f.act(first, pick(initial, 1));
  assert.match(result.outcome.detail, /薄荷/);
  f.act(second, {
    kind: "plant",
    plot: 3,
    cropId: "mint",
    buyPrice: f.garden.requireState().settings.crops.mint.seedPrice,
  });
  f.act(second, pick(f.view(second).event, 3));
  const summary = f.view(first).event.outcome.detail;
  assert.match(summary, /3 号地/);
  assert.ok(summary.includes(f.view(first).weather.name));
  f.reopen();
  assert.equal(f.view(second).event.outcome.detail, summary);
  f.advance(DAY);
  const history = adminGardenView(f.runtime).eventHistory.find(
    ({ id }) => id === initial.id,
  );
  assert.equal(history.status, "expired");
  assert.equal(history.outcome.detail, summary);
  assert.match(
    history.outcome.detail,
    /转得最快的一回在 [13] 号地.*薄荷.*多云/,
  );
  assert.equal(history.game, undefined);
});

test("a real harvested pea packet survives midnight and restart, shares one seed only once and keeps authors private", (t) => {
  const f = setup(t, "door_peas");
  const [giver, visitor] = f.actors;
  const price = f.garden.requireState().settings.crops["rattle-pea"].seedPrice;
  const plant = f.act(giver, {
    kind: "plant",
    cropId: "rattle-pea",
    plot: 5,
    buyPrice: price,
  });
  f.advance(6 * HOUR);
  const lot = f.act(giver, {
    kind: "harvest",
    plantId: plant.plantId,
    plot: 5,
  });
  f.advance(DAY);
  const event = f.view(giver).event;
  assert.equal(event.effect.story, "door_peas");
  const convert = (a) => ({ kind: a.kind, ...a.args });
  const leave = convert(
    event.actions.find((a) => a.args.harvestId === lot.harvestId),
  );
  const requestId = randomUUID();
  const placed = f.act(giver, leave, requestId);
  assert.equal(f.act(giver, leave, requestId).replayed, true);
  assert.equal(
    f.store.db
      .prepare("SELECT quantity FROM garden_harvests WHERE id=?")
      .get(lot.harvestId).quantity,
    lot.quantity - 1,
  );
  const wrong = {
    kind: "choose_event",
    eventId: event.id,
    choiceId: "take_peas",
  };
  assert.throws(() => f.act(giver, wrong), /GARDEN_EVENT_CHOICE_INVALID/);
  f.advance(DAY);
  f.reopen();
  const project = f.view(visitor).gardenProjects.find((p) => p.id === event.id);
  assert.ok(project);
  assert.equal(project.detail, placed.outcome.detail);
  assert.equal(JSON.stringify(project).includes("generation"), false);
  f.act(
    visitor,
    convert(project.actions.find((a) => a.args.choiceId === "draw_pea")),
  );
  const updated = f.view(visitor).gardenProjects.find((p) => p.id === event.id);
  assert.match(updated.detail, /1 粒/);
  const take = convert(
    updated.actions.find((a) => a.args.choiceId === "take_peas"),
  );
  const before = f.garden.requireState().seeds["rattle-pea"] ?? 0;
  const takeId = randomUUID();
  f.act(visitor, take, takeId);
  assert.equal(f.act(visitor, take, takeId).replayed, true);
  assert.equal(f.garden.requireState().seeds["rattle-pea"], before + 1);
  assert.ok(!f.view(visitor).gardenProjects.some((p) => p.id === event.id));
});

test("an existing full 48-entry pool gains this edition once and keeps custom settings, a disabled collision and the active day", (t) => {
  const f = setup(t, "windmill");
  const state = f.garden.requireState();
  const current = adminGardenView(f.runtime).event.id;
  const preset = Object.keys(explorerPresets)[0];
  state.settings.events.entries = Object.fromEntries(
    Array.from({ length: 47 }, (_, i) => [
      `custom-${i}`,
      {
        ...structuredClone(state.settings.events.entries.visitor),
        name: `旧条目 ${i}`,
      },
    ]),
  );
  state.settings.events.entries[preset] = {
    ...structuredClone(explorerPresets[preset]),
    enabled: false,
    name: "旧园自己的同名故事",
  };
  f.store.db
    .prepare("UPDATE garden_state SET settings=? WHERE id=1")
    .run(JSON.stringify(state.settings));
  f.store.db
    .prepare("DELETE FROM garden_explorer_editions WHERE edition=1")
    .run();
  f.reopen();
  const after = f.garden.requireState();
  assert.equal(Object.keys(after.settings.events.entries).length, 57);
  for (const [id, value] of Object.entries(state.settings.events.entries))
    assert.deepEqual(after.settings.events.entries[id], value);
  assert.equal(adminGardenView(f.runtime).event.id, current);
  const removed = Object.keys(explorerPresets)[1];
  delete after.settings.events.entries[removed];
  f.garden.configure(f.runtime.now(), after.settingsRevision, after.settings);
  f.reopen();
  assert.equal(
    f.garden.requireState().settings.events.entries[removed],
    undefined,
  );
});

test("a garden with 78 customized events gains the table edition and its full pool remains editable", (t) => {
  const f = setup(t, "windmill");
  const state = f.garden.requireState();
  const base = state.settings.events.entries.visitor;
  state.settings.events.entries = Object.fromEntries(
    Array.from({ length: 78 }, (_, i) => [
      `custom-${i}`,
      { ...base, name: `自己留下的条目 ${i}` },
    ]),
  );
  f.store.db
    .prepare("UPDATE garden_state SET settings=? WHERE id=1")
    .run(JSON.stringify(state.settings));
  f.store.db
    .prepare("DELETE FROM garden_explorer_editions WHERE edition=2")
    .run();
  f.reopen();
  const upgraded = f.garden.requireState();
  assert.equal(Object.keys(upgraded.settings.events.entries).length, 88);
  for (const [id, old] of Object.entries(state.settings.events.entries))
    assert.deepEqual(upgraded.settings.events.entries[id], old);
  upgraded.settings.events.entries["custom-77"].enabled = false;
  f.garden.configure(
    f.runtime.now(),
    upgraded.settingsRevision,
    upgraded.settings,
  );
  f.reopen();
  const saved = f.garden.requireState();
  assert.equal(saved.settings.events.entries["custom-77"].enabled, false);
  saved.settings.events.entries["extra-custom"] = base;
  assert.throws(() =>
    f.garden.configure(f.runtime.now(), saved.settingsRevision, saved.settings),
  );
});
