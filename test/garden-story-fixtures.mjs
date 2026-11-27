import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { GardenService } from "../src/home/garden-service.mjs";
import { defaultGardenSettings } from "../src/home/garden-rules.mjs";
import {
  adminGardenView,
  subjectGardenView,
  performGardenAction,
} from "../src/home/garden-console.mjs";
import { config, fixture } from "./helpers.mjs";
import { fixedWeather } from "./garden-fixtures.mjs";

const admin = { kind: "admin", id: "administrator" };
export function setupGardenStory(t, id, run) {
  const cfg = config(2);
  for (const role of cfg.agents) role.subject.enabled = true;
  const { runtime, store } = fixture(t, { cfg, run });
  let garden = runtime.home.garden;
  let now = Date.UTC(2026, 0, 1);
  runtime.clock = () => now;
  const settings = defaultGardenSettings();
  settings.weather = fixedWeather();
  settings.turnLimit = 30;
  settings.initialBalance = 2200;
  settings.events.rate = 1;
  const set = (s, id) => {
    for (const [key, entry] of Object.entries(s.events.entries))
      entry.enabled = key === id;
  };
  set(settings, id);
  for (const crop of Object.values(settings.crops)) {
    crop.hours = 3;
    crop.fertilizer = 0;
    crop.dailyWater = 0;
  }
  const actors = runtime.config.agents.map((role, i) => ({
    kind: "agent",
    id: role.id,
    turnId: `table-${i}`,
  }));
  for (const role of actors) {
    const generation = runtime.home.generation(role.id);
    settings.roles[role.id] = generation;
    settings.giftBudgetGenerations[role.id] = generation;
    settings.giftBudgets.roles[role.id] = 50;
  }
  settings.giftBudgets.total = 100;
  garden.initialize(now, settings);
  garden.syncClock(now, true);
  const act = (action, actor = admin, requestId = randomUUID()) =>
    performGardenAction(runtime, actor, { requestId, action });
  const view = (actor = admin) =>
    actor.kind === "admin"
      ? adminGardenView(runtime)
      : subjectGardenView(runtime, actor.id, actor.turnId);
  const pick = (choiceId, owner = admin, args = {}, old) => {
    const state = view(owner);
    const actions = old
      ? state.gardenProjects.find(({ id }) => id === old)?.actions
      : owner.kind === "admin"
        ? state.eventActions
        : state.event?.actions;
    const option = actions?.find(
      ({ args: values }) =>
        values.choiceId === choiceId &&
        Object.entries(args).every(([key, value]) => values[key] === value),
    );
    assert.ok(option, `missing ${choiceId}: ${JSON.stringify(actions)}`);
    return { kind: option.kind, ...option.args };
  };
  return {
    actors,
    runtime,
    store,
    act,
    pick,
    view,
    get garden() {
      return garden;
    },
    advance: (delta) => {
      now += delta;
      garden.syncClock(now, true);
    },
    sow: (plot, cropId) =>
      act({
        kind: "plant",
        cropId,
        plot,
        buyPrice: settings.crops[cropId].seedPrice,
      }).plantId,
    harvest: (plot, plantId) =>
      act({ kind: "harvest", plot, plantId }).harvestId,
    reopen: () => {
      garden.syncClock(now, false);
      garden = runtime.home.garden = new GardenService(store);
      garden.syncClock(now, true);
    },
    switchTo: (id) => {
      const state = garden.requireState();
      set(state.settings, id);
      garden.configure(now, state.settingsRevision, state.settings);
    },
  };
}
