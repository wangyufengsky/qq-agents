import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { MemoryStore } from "../src/memory/store.mjs";
import { GardenService } from "../src/home/garden-service.mjs";
import { gardenPriorities } from "../src/home/garden-console.mjs";
import { gardenPublicSnapshot } from "../src/home/garden-public.mjs";
import {
  DAY,
  HOUR,
  defaultGardenSettings,
  projectPlant,
} from "../src/home/garden-rules.mjs";
import { drawWeather, weatherOdds } from "../src/home/garden-weather.mjs";
import { fixedWeather } from "./garden-fixtures.mjs";
import { temp } from "./helpers.mjs";

const admin = { kind: "admin", id: "administrator" };
const lease = 100 * DAY;

function fixture(t, kind = "cloud", edit = () => {}, file = ":memory:") {
  const store = new MemoryStore(file);
  t.after(() => store.close());
  return use(store, kind, edit);
}

function use(store, kind = "cloud", edit = () => {}) {
  const garden = new GardenService(store);
  const rules = defaultGardenSettings();
  rules.weather = fixedWeather(kind);
  edit(rules);
  let now = 0;
  garden.initialize(now, rules);
  garden.desktopSync(now, lease);
  const act = (action, actor = admin, requestId = randomUUID()) =>
    garden.act(now, actor, { requestId, action });
  return {
    store,
    garden,
    act,
    now: () => now,
    plant: (plot, cropId = "clover") =>
      act({
        kind: "plant",
        plot,
        cropId,
        buyPrice: garden.requireState().settings.crops[cropId].seedPrice,
      }),
    read: () => garden.read(now),
    advance: (ms) => {
      now += ms;
      garden.desktopSync(now, lease);
    },
    skipWall: (ms) => (now += ms),
    configure: (fn) => {
      const { settings, settingsRevision } = garden.requireState();
      fn(settings);
      return garden.configure(now, settingsRevision, settings);
    },
    rows: () =>
      store.db.prepare("SELECT * FROM garden_days ORDER BY day").all(),
  };
}
const closeTo = (actual, wanted) =>
  assert.ok(Math.abs(actual - wanted) < 1e-10, `${actual} != ${wanted}`);

test("conditional weights, type variants, streak, inventory and permanent fallback determine exact odds", () => {
  const pool = fixedWeather();
  const { entries } = pool;
  entries.sun.weight = 3;
  entries.sun.conditions = [
    { field: "balance", op: "gt", value: 300 },
    { field: "seed", cropId: "clover", op: "gte", value: 1 },
  ];
  entries.drizzle.weight = 1;
  entries.drizzle.mode = "any";
  entries.drizzle.conditions = [
    { field: "previous", match: { by: "kind", value: "storm" } },
    { field: "harvest", cropId: "clover", op: "gt", value: 0 },
  ];
  entries.storm.weight = 9;
  entries.storm.conditions = [
    {
      field: "streak",
      match: { by: "kind", value: "storm" },
      op: "lt",
      value: 2,
    },
  ];
  entries["heavy-storm"] = {
    ...entries.storm,
    name: "强暴雨",
    enabled: false,
    conditions: [],
  };
  const previous = {
    day: 4,
    revision: 1,
    weather: { ...entries["heavy-storm"], id: "heavy-storm" },
    kindStreak: 2,
    idStreak: 1,
  };
  let ctx = {
    balance: 301,
    seeds: { clover: 1 },
    harvests: {},
    fertilizer: 0,
    previous,
  };
  const odds = (id) => weatherOdds(pool, ctx).rows.find((row) => row.id === id);
  assert.equal(odds("sun").probability, 0.75);
  assert.equal(odds("drizzle").probability, 0.25);
  assert.equal(odds("storm").reason, "conditions");
  assert.equal(odds("heavy-storm").reason, "disabled");
  ctx = { ...ctx, balance: 300 };
  assert.equal(odds("sun").reason, "conditions");
  assert.equal(odds("drizzle").probability, 1);
  entries.drizzle.conditions[0].match = { by: "id", value: "storm" };
  assert.equal(weatherOdds(pool, ctx).fallback, "cloud");
  assert.equal(odds("cloud").probability, 1);
  entries.storm.conditions[0].match = { by: "id", value: "heavy-storm" };
  assert.equal(odds("storm").probability, 1);
  entries.drizzle.conditions[0].match = { by: "kind", value: "storm" };
  entries.storm.conditions[0].match = { by: "kind", value: "storm" };
  ctx.balance = 301;
  const session = Array.from(
    { length: 50 },
    (_, day) => drawWeather(pool, ctx, "test-seed", day).id,
  );
  assert.deepEqual([...new Set(session)].sort(), ["drizzle", "sun"]);
  assert.deepEqual(
    session,
    Array.from(
      { length: 50 },
      (_, day) => drawWeather(pool, ctx, "test-seed", day).id,
    ),
  );
});

test("sun multiplies light after water and increases demand, while customizable shade applies under a shelter", (t) => {
  const f = fixture(t, "sun", (s) => {
    s.startingWater = 12;
  });
  f.plant(1, "sunflower");
  f.configure((s) => {
    s.startingWater = 75;
  });
  f.plant(2, "sunflower");
  f.configure((s) => {
    s.crops.mint.lightRates = { high: 0.6, medium: 1.2, low: 1.4 };
  });
  f.act({ kind: "shelter", plot: 3 });
  f.plant(3, "mint");
  f.advance(8 * HOUR);
  const [, wet, sheltered] = f.read().plots;
  closeTo(wet.plant.growth, 10);
  closeTo(wet.plant.water, 60);
  closeTo(sheltered.plant.growth, 9.6);
  const alwaysLow = { ...f.garden.requireState().plots[0].plant };
  alwaysLow.water = 17;
  const projected = projectPlant(alwaysLow, 8 * HOUR, f.read().weather);
  closeTo(projected.growth, 5);
  closeTo(projected.water, 2);
  let repeated = alwaysLow;
  for (let h = 1; h <= 8; h++)
    repeated = projectPlant(repeated, h * HOUR, f.read().weather);
  closeTo(repeated.growth, projected.growth);
  closeTo(repeated.low, projected.low);
  closeTo(repeated.water, projected.water);
});

test("drizzle adds net water only outdoors, resets drought, and locks only pre-maturity water damage into quality", (t) => {
  const f = fixture(t, "drizzle", (s) => {
    s.crops.strawberry.dailyWater = 30;
    s.crops.strawberry.hours = 36;
    s.crops.strawberry.fertilizer = 1;
    s.startingWater = 50;
    s.baseQuality = 58;
  });
  const outside = f.plant(1, "strawberry");
  f.act({ kind: "shelter", plot: 2 });
  f.plant(2, "strawberry");
  f.plant(3, "clover");
  f.act({ kind: "buy_fertilizer", quantity: 1, price: 20 });
  f.act({ kind: "fertilize", plot: 1, plantId: outside.plantId });
  f.advance(DAY);
  let [wet, covered, clover] = f.read().plots;
  closeTo(wet.plant.water, 65);
  closeTo(covered.plant.water, 20);
  assert.equal(wet.plant.floodLoss, 5);
  assert.equal(covered.plant.floodLoss, 0);
  assert.equal(clover.plant.quality, "ordinary");
  assert.equal(clover.plant.floodLoss ?? 0, 0);
  const dry = { ...wet.plant, water: 0, dry: 15 };
  const relieved = projectPlant(dry, DAY + 2 * HOUR, f.read().weather);
  assert.equal(relieved.dry, 0);
  assert.ok(relieved.water > 0);
  f.advance(2 * DAY);
  [wet] = f.read().plots;
  assert.equal(wet.plant.quality, "fine");
  assert.equal(wet.plant.floodLoss, 5);
  assert.equal(wet.plant.status, "mature");
  closeTo(wet.plant.water, 72.5);
  const crop = f.act({ kind: "harvest", plot: 1, plantId: outside.plantId });
  assert.equal(crop.quality, "fine");
  f.act({ kind: "sell", harvestId: crop.harvestId, quantity: 1, price: 363 });
});

test("two storms count at day end, evening shelter saves the crop, and shelter belongs to the plot", (t) => {
  const f = fixture(t, "storm", (s) => {
    s.crops.clover.hours = 16;
  });
  f.plant(1);
  const lost = f.plant(2);
  f.act({ kind: "shelter", plot: 3 });
  const protectedPlant = f.plant(3);
  f.advance(DAY + HOUR);
  let state = f.read();
  assert.equal(state.plots[0].plant.water, 100);
  assert.equal(state.plots[0].plant.growth, 0);
  assert.equal(state.plots[0].plant.floodDays, 1);
  assert.equal(state.plots[0].plant.floodLoss, 15);
  const critical = gardenPriorities(state).find(({ plot }) => plot === 1);
  assert.equal(critical.kind, "flood");
  assert.equal(critical.risk, "critical");
  assert.equal(critical.hours, 23);
  const snapshot = gardenPublicSnapshot(state, { running: true, now: f.now() });
  assert.equal(snapshot.weather.name, "暴雨");
  assert.equal(snapshot.plots[0].risk, "critical");
  assert.equal(snapshot.plots[2].sheltered, true);
  assert.match(snapshot.text, /本日剩 23 花园小时/);
  assert.match(snapshot.text, /本日结束前搭棚/);
  assert.equal(state.plots[2].plant.status, "mature");
  f.act({ kind: "harvest", plot: 3, plantId: protectedPlant.plantId });
  assert.equal(f.read().plots[2].sheltered, true);
  f.plant(3);
  assert.equal(f.read().plots[2].sheltered, true);
  f.advance(22 * HOUR);
  assert.equal(f.read().plots[0].plant.floodDays, 1);
  f.act({ kind: "shelter", plot: 1 });
  f.advance(HOUR);
  state = f.read();
  assert.equal(state.plots[0].plant.floodDays, 0);
  assert.equal(state.plots[0].plant.floodLoss, 15);
  assert.equal(state.plots[1].plant.witheredReason, "flood");
  f.act({ kind: "shelter", plot: 2 });
  f.act({ kind: "clear", plot: 2, plantId: lost.plantId });
  assert.equal(f.read().plots[1].sheltered, true);
  f.act({ kind: "unshelter", plot: 2 });
  assert.equal(f.read().plots[1].sheltered, false);
  assert.equal(f.read().plots[1].plant, null);
});

test("cross-day configuration backfills untouched days with their prior revision and reopens with exactly the committed results", (t) => {
  const file = path.join(temp(t), "weather.sqlite");
  const store = new MemoryStore(file);
  const f = use(store, "storm");
  f.plant(1);
  f.advance(2 * DAY + HOUR);
  assert.equal(f.rows().length, 1);
  const patched = f.configure((s) => {
    s.weather = fixedWeather("sun");
  });
  assert.equal(patched.weather.kind, "storm");
  assert.equal(patched.plots[0].plant.witheredReason, "flood");
  assert.deepEqual(
    f.rows().map((row) => row.rules_revision),
    [0, 0, 0],
  );
  assert.equal(f.read().weatherRevision, 0);
  f.advance(DAY - HOUR);
  assert.equal(f.read().weather.kind, "sun");
  assert.equal(f.read().weatherRevision, 1);
  const saved = f.rows();
  store.close();
  const restarted = new MemoryStore(file);
  t.after(() => restarted.close());
  const garden = new GardenService(restarted);
  assert.equal(garden.read(10 * DAY).running, false);
  assert.equal(garden.read(10 * DAY).day, 4);
  assert.deepEqual(
    restarted.db.prepare("SELECT * FROM garden_days ORDER BY day").all(),
    saved,
  );
  const newAction = (action) =>
    garden.act(10 * DAY, admin, { requestId: randomUUID(), action });
  assert.throws(() => newAction({ kind: "shelter", plot: 1 }), /GARDEN_PAUSED/);
});

test("legacy weather starts neutral at the saved clock with no retrospective storms", (t) => {
  const store = new MemoryStore(":memory:");
  t.after(() => store.close());
  const f = use(store);
  f.plant(1);
  f.advance(3 * DAY);
  store.db
    .exec(`UPDATE garden_state SET settings=json_remove(settings,'$.weather');
    DELETE FROM garden_days; DELETE FROM garden_weather_seed;`);
  const reopened = new GardenService(store);
  const migrated = reopened.read(8 * DAY);
  assert.equal(migrated.day, 4);
  assert.equal(migrated.weather.kind, "cloud");
  assert.equal(migrated.plots[0].plant.status, "mature");
  assert.equal(migrated.plots[0].plant.floodLoss ?? 0, 0);
  assert.equal(f.rows().length, 1);
});

test("trial validates references, reports real odds and is read-only even when the garden is paused across days", (t) => {
  const f = fixture(t, "storm", (s) => {
    s.weather.entries.sun.weight = 1;
    s.weather.entries.sun.conditions = [
      { field: "balance", op: "gt", value: 300 },
    ];
    s.weather.entries.drizzle.weight = 3;
    s.weather.entries.drizzle.conditions = [
      {
        field: "streak",
        match: { by: "kind", value: "storm" },
        op: "gte",
        value: 2,
      },
    ];
  });
  f.advance(4 * HOUR);
  f.garden.desktopStop(f.now());
  const before = f.read();
  const rows = f.rows();
  const trial = (value) =>
    f.garden.calendar.trial(f.garden.requireState(), value);
  f.skipWall(5 * DAY);
  assert.equal(trial({ balance: 300 }).fallback, "storm");
  const odds = trial({ balance: 301, previousId: "storm", streak: 2 });
  assert.deepEqual(
    odds.rows
      .filter((row) => row.probability)
      .map((row) => [row.id, row.probability]),
    [
      ["drizzle", 0.75],
      ["sun", 0.25],
    ],
  );
  assert.throws(() => trial({ previousId: "unknown" }), /INVALID_REQUEST/);
  assert.throws(() => trial({ balance: -1 }));
  assert.throws(() =>
    f.configure((s) => {
      s.weather.entries.storm.enabled = false;
    }),
  );
  assert.throws(() =>
    f.configure((s) => {
      s.weather.entries.sun.conditions = [
        { field: "previous", match: { by: "id", value: "unknown" } },
      ];
    }),
  );
  assert.throws(() =>
    f.configure((s) => {
      s.weather.entries.sun.conditions = [
        { field: "seed", cropId: "unknown", op: "gte", value: 1 },
      ];
    }),
  );
  assert.throws(() =>
    f.configure((s) => {
      s.weather.entries.sun.weight = -1;
    }),
  );
  assert.equal(f.read().clock, before.clock);
  assert.deepEqual(f.read().weather, before.weather);
  assert.deepEqual(f.rows(), rows);
});

test("shelter actions use the same idempotent turn budget as other operations and leave later plantings untouched", (t) => {
  const f = fixture(t, "storm", (s) => {
    s.turnLimit = 1;
  });
  const actor = { kind: "agent", id: "agent-0", turnId: "first-turn" };
  assert.throws(
    () => f.act({ kind: "unshelter", plot: 1 }, actor),
    /GARDEN_SHELTER_UNCHANGED/,
  );
  const requestId = randomUUID();
  assert.equal(
    f.act({ kind: "shelter", plot: 1 }, actor, requestId).replayed,
    false,
  );
  assert.equal(
    f.act({ kind: "shelter", plot: 1 }, actor, requestId).replayed,
    true,
  );
  assert.throws(
    () => f.act({ kind: "plant", plot: 1, cropId: "clover" }, actor),
    /GARDEN_TURN_LIMIT/,
  );
  f.plant(1);
  assert.equal(f.read().plots[0].sheltered, true);
});
