import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { GardenService } from "../src/home/garden-service.mjs";
import { DAY, HOUR, defaultGardenSettings } from "../src/home/garden-rules.mjs";
import { backupDatabase } from "../src/memory/backup.mjs";
import { MemoryStore } from "../src/memory/store.mjs";
import { fixedWeather } from "./garden-fixtures.mjs";
import { config, fixture, temp } from "./helpers.mjs";

const admin = { kind: "admin", id: "administrator" };
const actor = { kind: "agent", id: "agent-0", turnId: "first-turn" };
const recipient = { kind: "agent", id: "agent-1" };
const LEASE = 15_000;

function setup(t, update = () => {}) {
  const store = new MemoryStore(":memory:");
  t.after(() => store.close());
  const garden = new GardenService(store);
  const settings = defaultGardenSettings();
  settings.weather = fixedWeather();
  settings.events.rate = 0;
  update(settings);
  let now = 1000;
  garden.initialize(now, settings);
  garden.syncClock(now, true);
  return {
    garden,
    state: () => garden.read(now),
    act: (action, by = admin, requestId = randomUUID()) =>
      garden.act(now, by, { requestId, action }),
    wait: (ms) => {
      now += ms;
      garden.syncClock(now, true);
    },
    configure: (edit) => {
      const state = garden.read(now);
      edit(state.settings);
      return garden.configure(now, state.settingsRevision, state.settings);
    },
  };
}

test("an existing memory database opens without initializing a garden and backups preserve the shared data", async (t) => {
  const root = temp(t);
  const file = path.join(root, "memory.sqlite");
  const copy = path.join(root, "restored.sqlite");
  {
    const legacy = new DatabaseSync(file);
    legacy.exec(
      "CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES('hello')",
    );
    legacy.close();
  }
  const store = new MemoryStore(file);
  const garden = new GardenService(store);
  try {
    assert.throws(() => garden.read(0), /GARDEN_NOT_INITIALIZED/);
    assert.equal(
      store.db.prepare("SELECT value FROM retained").get().value,
      "hello",
    );
    const defaults = garden.initialize(0);
    assert.equal(defaults.plots.length, 9);
    assert.equal(defaults.balance, 1000);
    assert.equal(Object.keys(defaults.settings.crops).length, 8);
    assert.equal(defaults.ledger.length, 1);
    garden.syncClock(0, true);
    garden.act(0, admin, {
      requestId: "test-backup-plant",
      action: { kind: "plant", plot: 8, cropId: "clover" },
    });
    garden.syncClock(4000, true);
    garden.syncClock(5000, false);
    assert.equal((await backupDatabase(file, copy)).integrity, "ok");
  } finally {
    store.close();
  }
  const restored = new MemoryStore(copy);
  try {
    const garden = new GardenService(restored);
    const state = garden.initialize(DAY);
    assert.equal(state.clock, 5000);
    assert.equal(state.running, false);
    assert.equal(state.plots[7].plant.cropId, "clover");
    assert.equal(state.balance, 1000);
    assert.equal(state.ledger.length, 1);
    assert.equal(
      garden.act(DAY, admin, {
        requestId: "test-backup-plant",
        action: { kind: "plant", plot: 8, cropId: "clover" },
      }).replayed,
      true,
    );
  } finally {
    restored.close();
  }
});

test("shared accounting covers a complete zero-balance loop and rejects stale harvest and sale requests", (t) => {
  const f = setup(t, (s) => {
    s.initialBalance = 0;
  });
  assert.throws(
    () => f.act({ kind: "plant", plot: 1, cropId: "radish", buyPrice: 30 }),
    /GARDEN_BALANCE_LOW/,
  );
  assert.equal(f.state().plots[0].plant, null);
  const { plantId } = f.act(
    { kind: "plant", plot: 1, cropId: "clover" },
    actor,
  );
  f.wait(DAY);
  const { harvestId } = f.act({ kind: "harvest", plot: 1, plantId }, admin);
  assert.throws(
    () => f.act({ kind: "harvest", plot: 1, plantId }, actor),
    /GARDEN_PLANT_CHANGED/,
  );
  const sale = { kind: "sell", harvestId, quantity: 1, price: 25 };
  assert.equal(f.act(sale, actor, "test-market-retry").balance, 25);
  assert.equal(
    f.act(sale, { ...actor, turnId: "another-turn" }, "test-market-retry")
      .replayed,
    true,
  );
  assert.throws(
    () => f.act({ ...sale, price: 24 }, actor, "test-market-retry"),
    /GARDEN_REQUEST_CONFLICT/,
  );
  assert.throws(
    () => f.act({ kind: "gift", harvestId, quantity: 1, recipient }),
    {
      message: "GARDEN_STOCK_UNAVAILABLE",
      cause: { available: 0, lastUse: "sell" },
    },
  );
  assert.equal(f.state().balance, 25);
  assert.deepEqual(
    f.state().ledger.map((entry) => entry.delta),
    [25, 0],
  );
});

test("shared care applies exact water increments, respects turn budgets, locks quality and supports gifts", (t) => {
  const f = setup(t);
  f.act({ kind: "buy_seed", cropId: "radish", quantity: 1, price: 30 });
  f.act({ kind: "buy_fertilizer", quantity: 1, price: 20 });
  const { plantId } = f.act({ kind: "plant", plot: 2, cropId: "radish" });
  f.wait(24 * HOUR);
  assert.equal(f.state().plots[1].plant.water, 50);
  const care = { plot: 2, plantId };
  assert.equal(f.act({ kind: "water", ...care }, actor).water, 85);
  assert.equal(f.act({ kind: "fertilize", ...care }, actor).fertilizer, 1);
  assert.throws(
    () => f.act({ kind: "water", ...care }, actor),
    /GARDEN_TURN_LIMIT/,
  );
  f.configure((s) => {
    s.turnLimit = 4;
  });
  assert.equal(f.act({ kind: "water", ...care }, actor).water, 100);
  assert.throws(
    () => f.act({ kind: "water", ...care }, actor),
    /GARDEN_WATER_FULL/,
  );
  assert.throws(
    () => f.act({ kind: "clear", ...care }, actor),
    /GARDEN_PLANT_STATE/,
  );
  f.wait(12 * HOUR);
  const mature = f.state().plots[1].plant;
  assert.equal(mature.quality, "perfect");
  f.wait(48 * HOUR);
  assert.deepEqual(f.state().plots[1].plant, mature);
  const { harvestId, quality } = f.act({ kind: "harvest", ...care }, actor);
  assert.equal(quality, "perfect");
  const before = f.state();
  for (const giver of [admin, { ...actor, turnId: "gift-turn" }]) {
    assert.throws(
      () =>
        f.act(
          {
            kind: "gift",
            harvestId,
            quantity: 1,
            recipient: { kind: giver.kind, id: giver.id },
          },
          giver,
        ),
      /GARDEN_RECIPIENT_UNAVAILABLE/,
    );
  }
  assert.deepEqual(f.state(), before);
  assert.ok(f.act({ kind: "gift", harvestId, quantity: 1, recipient }).giftId);
  assert.equal(f.state().balance, 950);
  assert.deepEqual(
    f.state().gifts.map((gift) => gift.recipient_id),
    [recipient.id],
  );
  assert.deepEqual(
    f
      .state()
      .activity.slice(0, 2)
      .map((entry) => entry.action),
    ["gift", "harvest"],
  );
});

test("projected growth is refresh independent, dries out, withers and can be cleared by another member", (t) => {
  const f = setup(t, (s) => {
    s.careMode = "classic";
    s.startingWater = 30;
    s.crops.mint.hours = 100;
    s.crops.mint.dailyWater = 24;
  });
  const { plantId } = f.act(
    { kind: "plant", cropId: "mint", plot: 1, buyPrice: 50 },
    actor,
  );
  const care = { plot: 1, plantId };
  f.wait(10 * HOUR);
  assert.equal(f.state().plots[0].plant.growth, 10);
  for (let i = 0; i < 8; i++) {
    f.wait(HOUR);
    assert.equal(f.state().plots[0].plant.growth, 10 + (i + 1) / 2);
  }
  f.wait(12 * HOUR);
  assert.equal(f.state().plots[0].plant.water, 0);
  f.wait(47 * HOUR);
  assert.equal(f.state().plots[0].plant.growth, 20);
  assert.equal(f.state().plots[0].plant.status, "growing");
  f.wait(HOUR);
  assert.equal(f.state().plots[0].plant.witheredReason, "drought");
  assert.throws(() => f.act({ kind: "water", ...care }), /GARDEN_PLANT_STATE/);
  f.act({ kind: "clear", ...care });
  f.act({ kind: "plant", cropId: "clover", plot: 1 });
  assert.throws(
    () => f.act({ kind: "clear", ...care }),
    /GARDEN_PLANT_CHANGED/,
  );
  assert.equal(f.state().balance, 950);
});

test("new settings apply prospectively, while price changes reject stale trades", (t) => {
  const f = setup(t);
  f.act({ kind: "plant", cropId: "clover", plot: 1 });
  f.configure((s) => {
    s.initialBalance = 42;
    s.crops.clover.hours = 1;
    s.crops.radish.seedPrice = 31;
  });
  assert.throws(
    () => f.act({ kind: "buy_seed", cropId: "radish", quantity: 1, price: 30 }),
    /GARDEN_PRICE_CHANGED/,
  );
  assert.equal(f.state().balance, 1000);
  f.act({ kind: "plant", cropId: "clover", plot: 2 });
  f.wait(HOUR);
  assert.equal(f.state().plots[0].plant.status, "growing");
  assert.equal(f.state().plots[1].plant.status, "mature");
  assert.throws(
    () => f.garden.configure(0, 0, f.state().settings),
    /GARDEN_SETTINGS_CONFLICT/,
  );
});

test("an open garden accrues only service uptime, changes speed prospectively and freezes while disabled", (t) => {
  const f = setup(t);
  f.wait(2 * HOUR);
  assert.equal(f.state().clock, 2 * HOUR);
  f.configure((s) => {
    s.speed = 4;
  });
  f.wait(HOUR);
  assert.equal(f.state().clock, 6 * HOUR);
  f.configure((s) => {
    s.enabled = false;
  });
  assert.throws(
    () => f.act({ kind: "plant", cropId: "clover", plot: 1 }),
    /GARDEN_PAUSED/,
  );
  f.wait(DAY);
  f.configure((s) => {
    s.speed = 1;
  });
  f.wait(DAY);
  assert.equal(f.state().clock, 6 * HOUR);
  f.configure((s) => {
    s.enabled = true;
  });
  f.wait(18 * HOUR);
  assert.equal(f.state().clock, DAY);
  assert.equal(f.state().day, 2);
  assert.equal(f.state().dayRemaining, DAY);
});

test("the live garden grows before desktop connection, after disconnect and beyond the client lease", async (t) => {
  const cfg = config(2);
  cfg.desktopHome.enabled = true;
  let now = Date.UTC(2026, 0, 1);
  const { runtime } = fixture(t, { cfg });
  runtime.clock = () => now;
  const { garden } = runtime.home;
  garden.initialize(now);
  const client = randomUUID();
  const desktop = (action = "sync") =>
    runtime.desktopVisits.command({
      client,
      action,
      ...(action === "sync" && { data: false }),
    });
  const elapsed = () => garden.read(now).clock;
  now += HOUR;
  runtime.tick();
  assert.equal(garden.requireState().clock, HOUR);
  assert.equal(elapsed(), HOUR);
  desktop();
  now += 2000;
  desktop("disconnect");
  now += HOUR;
  assert.equal(elapsed(), 2 * HOUR + 2000);
  desktop();
  now += LEASE + HOUR;
  runtime.desktopVisits.refresh();
  assert.equal(runtime.desktopVisits.connected(), false);
  const afterExpiry = 3 * HOUR + 2000 + LEASE;
  assert.equal(elapsed(), afterExpiry);
  await runtime.pause("agent-0", true);
  now += HOUR;
  const beforePause = afterExpiry + HOUR;
  await runtime.pause("all", true);
  now += HOUR;
  assert.equal(elapsed(), beforePause);
  await runtime.pause("all", false);
  await runtime.setMode("isolated");
  now += HOUR;
  assert.equal(elapsed(), beforePause);
  await runtime.setMode("live", runtime.configStore.revision);
  runtime.maintenance.begin();
  now += HOUR;
  assert.equal(elapsed(), beforePause);
  runtime.updateMaintenance = false;
  runtime.maintenance.clear();
  now += 500;
  await runtime.close();
  now += HOUR;
  assert.equal(elapsed(), beforePause + 500);
});

test("a failed garden checkpoint leaves global pause available and retries the frozen progress", async (t) => {
  const { runtime } = fixture(t);
  let now = Date.UTC(2026, 0, 1);
  runtime.clock = () => now;
  const { garden } = runtime.home;
  garden.initialize(now);
  garden.db.exec(
    "CREATE TRIGGER reject_clock BEFORE UPDATE OF clock ON garden_state BEGIN SELECT RAISE(ABORT, 'fixture'); END",
  );
  now += 20_000;
  await runtime.pause("all", true);
  assert.equal(garden.requireState().clock, 0);
  assert.equal(garden.read(now).running, false);
  garden.db.exec("DROP TRIGGER reject_clock");
  now += HOUR;
  runtime.tick();
  assert.equal(garden.requireState().clock, 20_000);
});

test("an interrupted framework reopens at the last durable clock checkpoint", (t) => {
  const root = temp(t);
  const file = path.join(root, "memory.sqlite");
  let store = new MemoryStore(file);
  try {
    let garden = new GardenService(store);
    garden.initialize(0);
    garden.syncClock(0, true);
    garden.syncClock(10_000, true);
    garden.syncClock(20_000, true);
    garden.syncClock(22_000, true);
    assert.equal(garden.read(22_000).clock, 22_000);
    store.close();
    store = new MemoryStore(file);
    garden = new GardenService(store);
    assert.equal(garden.read(DAY).clock, 20_000);
    garden.syncClock(DAY, true);
    garden.syncClock(DAY + 5000, true);
    assert.equal(garden.read(DAY + 5000).clock, 25_000);
  } finally {
    store.close();
  }
});

test("competing sales and gifts settle once and a failed receipt rolls back the sale", async (t) => {
  const f = setup(t);
  const { plantId } = f.act({ kind: "plant", plot: 1, cropId: "clover" });
  f.wait(DAY);
  const { harvestId } = f.act({ kind: "harvest", plot: 1, plantId });
  const sale = { kind: "sell", harvestId, quantity: 1, price: 25 };
  f.garden.db.exec(
    "CREATE TRIGGER fail_receipt BEFORE INSERT ON garden_actions BEGIN SELECT RAISE(ABORT, 'receipt failure'); END",
  );
  assert.throws(() => f.act(sale), /receipt failure/);
  assert.equal(f.state().balance, 1000);
  assert.equal(f.state().ledger.length, 1);
  assert.equal(f.state().harvests[0].quantity, 1);
  f.garden.db.exec("DROP TRIGGER fail_receipt");
  const results = await Promise.allSettled([
    Promise.resolve().then(() => f.act(sale)),
    Promise.resolve().then(() =>
      f.act({ kind: "gift", harvestId, quantity: 1, recipient }, actor),
    ),
  ]);
  assert.deepEqual(
    results.map(({ status }) => status),
    ["fulfilled", "rejected"],
  );
  assert.equal(results[1].reason.cause.lastUse, "sell");
  assert.equal(f.state().balance, 1025);
  assert.equal(f.state().harvests.length, 0);
  assert.equal(f.state().gifts.length, 0);
});

test("switching speed between runtime ticks accounts for the prefix at the old speed", (t) => {
  const f = setup(t);
  const state = f.state();
  state.settings.speed = 4;
  const updated = f.garden.configure(
    5000,
    state.settingsRevision,
    state.settings,
  );
  assert.equal(updated.clock, 4000);
  f.garden.syncClock(6000, true);
  assert.equal(f.garden.read(6000).clock, 8000);
});

test("a plant created between runtime ticks starts at its action time", (t) => {
  const { garden } = setup(t);
  garden.act(5000, admin, {
    requestId: "between-ticks",
    action: { kind: "plant", plot: 1, cropId: "clover" },
  });
  assert.equal(garden.read(5000).clock, 4000);
  assert.equal(garden.read(5000).plots[0].plant.growth, 0);
  garden.syncClock(6000, true);
  assert.equal(garden.read(6000).plots[0].plant.growth, 1000 / HOUR);
});

test("a runtime pause freezes all projections and retries resume at the configured speed", (t) => {
  const { garden } = setup(t);
  const state = garden.read(15_000, admin);
  assert.equal(state.clock, 14_000);
  garden.syncClock(16_000, false);
  const frozen = garden.snapshot(20_000);
  assert.equal(frozen.running, false);
  assert.equal(frozen.clock, 15_000);
  const action = {
    requestId: "paused-plant",
    action: { kind: "plant", plot: 1, cropId: "clover" },
  };
  assert.throws(() => garden.act(21_000, admin, action), /GARDEN_PAUSED/);
  state.settings.speed = 4;
  garden.configure(22_000, state.settingsRevision, state.settings);
  assert.equal(garden.read(25_000, admin).clock, frozen.clock);
  garden.syncClock(30_000, true);
  garden.act(31_000, admin, action);
  assert.equal(garden.snapshot(32_000).clock, frozen.clock + 8_000);
  assert.equal(garden.read(32_000, admin).clock, garden.snapshot(32_000).clock);
});
