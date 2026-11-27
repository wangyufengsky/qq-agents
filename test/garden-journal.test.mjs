import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { GardenService } from "../src/home/garden-service.mjs";
import { MemoryStore } from "../src/memory/store.mjs";
import { backupDatabase } from "../src/memory/backup.mjs";
import { HOUR, defaultGardenSettings } from "../src/home/garden-rules.mjs";
import { fixedWeather } from "./garden-fixtures.mjs";
import { temp } from "./helpers.mjs";

const admin = { kind: "admin", id: "administrator" };
const helper = { kind: "agent", id: "helper", turnId: "first-turn" };

function setup(t, edit = () => {}, file = ":memory:") {
  const store = new MemoryStore(file);
  t.after(() => store.close());
  const { db } = store;
  const garden = new GardenService(store);
  const settings = defaultGardenSettings();
  settings.weather = fixedWeather();
  settings.events.rate = 0;
  edit(settings);
  let now = 1;
  garden.initialize(now, settings);
  garden.syncClock(now, true);
  return {
    db,
    store,
    garden,
    act(action, actor = admin, requestId = randomUUID()) {
      return garden.act(now, actor, { action, requestId });
    },
    wait(ms) {
      now += ms;
      garden.syncClock(now, true);
    },
    now: () => now,
  };
}

test("journal settles exact growth milestones and keeps the archived plant after harvest and replanting", (t) => {
  const { garden, store, act, wait } = setup(t);
  const { plantId } = act({ kind: "plant", plot: 1, cropId: "clover" });
  assert.equal(
    act({ kind: "water", plot: 1, plantId }, helper, "journal-water").replayed,
    false,
  );
  assert.equal(
    act({ kind: "water", plot: 1, plantId }, helper, "journal-water").replayed,
    true,
  );
  wait(24 * HOUR);
  const entries = garden.plantHistory({ plantId }).entries;
  assert.deepEqual(
    entries.map(({ type }) => type),
    ["mature", "developed", "sprouted", "water", "almanac", "planted"],
  );
  assert.deepEqual(
    entries.slice(0, 3).map(({ clock }) => Math.round(clock)),
    [24, 16.8, 3.6].map((h) => Math.round(h * HOUR)),
  );
  assert.deepEqual(entries.find(({ type }) => type === "water").actor, {
    kind: "agent",
    id: "helper",
  });
  act({ kind: "harvest", plot: 1, plantId });
  const replacement = act({ kind: "plant", plot: 1, cropId: "clover" }).plantId;
  const restarted = new GardenService(store);
  assert.equal(restarted.plantHistory({ plot: 1 }).plant.id, replacement);
  const archive = restarted.plantHistory({ plantId });
  assert.equal(archive.plant.status, "harvested");
  assert.equal(archive.plant.snapshot.status, "mature");
  assert.equal(
    archive.entries.filter(({ type }) => type === "mature").length,
    1,
  );
  const publicArchive = restarted.plantHistory(
    { plantId },
    { publicView: true },
  );
  assert.equal(publicArchive.plant.actor, undefined);
  assert.equal(publicArchive.plant.snapshot.actorId, undefined);
  assert.equal(publicArchive.plant.snapshot.plantedAt, undefined);
  assert.ok(publicArchive.entries.every((entry) => !("actor" in entry)));
  assert.ok(
    publicArchive.entries.every((entry) => !entry.text.includes("helper")),
  );
});

test("journal pagination pins the fact set and digest cursors isolate reader generations", (t) => {
  const { garden, act } = setup(t, (settings) => {
    settings.turnLimit = 0;
  });
  const { plantId } = act({ kind: "plant", plot: 1, cropId: "clover" });
  const page = garden.timeline({ limit: 2 });
  const original = garden.timeline().entries;
  act({ kind: "water", plot: 1, plantId });
  const pages = [...page.entries];
  let cursor = page.nextCursor;
  while (cursor) {
    const next = garden.timeline({ limit: 1, cursor });
    pages.push(...next.entries);
    cursor = next.nextCursor;
  }
  assert.deepEqual(pages, original);
  assert.throws(
    () => garden.timeline({ type: "water", cursor: page.nextCursor }),
    /INVALID_REQUEST/,
  );
  assert.throws(
    () => act({ kind: "water", plot: 1, plantId }, helper),
    /GARDEN_TURN_LIMIT/,
  );
  assert.equal(garden.turnUsed(helper.id, helper.turnId), 0);
  const role = { ...helper, generation: randomUUID() };
  const first = garden.digest(role);
  assert.equal(first.initial, true);
  assert.deepEqual(first.overview, {
    day: 1,
    occupied: 1,
    mature: 0,
    withered: 0,
  });
  assert.ok(first.entries.length > 0);
  assert.deepEqual(garden.digest(role), first);
  garden.ackDigest(role, first.through);
  assert.deepEqual(garden.digest(role).entries, []);
  assert.equal(
    garden.digest({ ...role, generation: randomUUID() }).initial,
    true,
  );
  const view = garden.digest(admin);
  garden.ackDigest(admin, view.through);
  assert.deepEqual(garden.digest({ ...admin, id: "desktop" }).entries, []);
});

test("historical reads do not collect a visitor reward or change the garden", (t) => {
  const { garden, now, db } = setup(t, (settings) => {
    settings.events.rate = 1;
    for (const [id, entry] of Object.entries(settings.events.entries))
      entry.weight = Number(id === "visitor");
  });
  const before = db.prepare("SELECT * FROM garden_state").get();
  const eventBefore = db
    .prepare("SELECT value FROM garden_events WHERE day=1")
    .get();
  assert.equal(garden.timeline({ type: "visitor" }).entries.length, 1);
  garden.digest(helper);
  garden.plantHistory({ plot: 5 });
  assert.deepEqual(db.prepare("SELECT * FROM garden_state").get(), before);
  assert.deepEqual(
    db.prepare("SELECT value FROM garden_events WHERE day=1").get(),
    eventBefore,
  );
  garden.read(now(), helper);
  const [reward] = garden.timeline({ type: "visitor_reward" }).entries;
  assert.deepEqual(reward.actor, { kind: "agent", id: "helper" });
  assert.equal(reward.plants.length, 0);
});

test("legacy receipts are imported once without inventing flower or watering times", (t) => {
  const { garden, db, store, act, wait } = setup(t);
  const legacyPlant = act({ kind: "plant", plot: 1, cropId: "clover" }).plantId;
  act({ kind: "water", plot: 1, plantId: legacyPlant }, helper);
  wait(24 * HOUR);
  act({ kind: "harvest", plot: 1, plantId: legacyPlant });
  const activePlant = act({ kind: "plant", plot: 2, cropId: "clover" }).plantId;
  db.exec(
    "DELETE FROM garden_history_start; DELETE FROM garden_plant_archive; DELETE FROM garden_facts",
  );
  const upgraded = new GardenService(store);
  const history = upgraded.plantHistory({ plantId: legacyPlant });
  assert.equal(history.plant.name, "野生三叶草");
  assert.equal(history.plant.status, "harvested");
  assert.equal(history.plant.snapshot, null);
  assert.deepEqual(
    history.entries.map(({ type }) => type),
    ["harvest", "mature", "water", "planted"],
  );
  assert.ok(
    history.entries.every(({ day, time }) => day === null && time === null),
  );
  assert.equal(history.coverage.partial, true);
  assert.equal(
    upgraded.plantHistory({ plantId: activePlant }).plant.snapshot.id,
    activePlant,
  );
  assert.deepEqual(new GardenService(store).timeline(), upgraded.timeline());
  assert.ok(garden.initialized());
});

test("a daily event records all growth thresholds it crosses at the event's garden clock", (t) => {
  const { garden, act, wait } = setup(t, (settings) => {
    settings.crops.clover.hours = 3;
    settings.events.rate = 1;
    for (const entry of Object.values(settings.events.entries))
      entry.weight = Number(
        entry.effect.kind === "blessing" && entry.effect.effect === "meteor",
      );
  });
  wait(23 * HOUR);
  const { plantId } = act({ kind: "plant", plot: 1, cropId: "clover" });
  wait(HOUR);
  const entries = garden.plantHistory({ plantId }).entries;
  const [mature, developed, sprouted] = entries;
  assert.deepEqual(
    [mature.type, developed.type, sprouted.type],
    ["mature", "developed", "sprouted"],
  );
  assert.equal(sprouted.source, "growth");
  for (const entry of [mature, developed]) {
    assert.equal(entry.clock, 24 * HOUR);
    assert.equal(entry.time, "00:00");
    assert.equal(entry.source, "event");
    assert.ok(entry.detail.eventId);
    assert.deepEqual(garden.timeline({ factId: entry.id }).entries, [entry]);
  }
});

test("saved snapshots stay coherent across an unsettled day and do not change stock or facts", (t) => {
  const { garden, act, db, now } = setup(t);
  const { plantId } = act({ kind: "plant", plot: 1, cropId: "clover" });
  garden.clock.elapsed = 25 * HOUR;
  assert.ok(garden.clock.running(now()));
  const committedRows = db.prepare("SELECT * FROM garden_state").get();
  const facts = garden.timeline();
  const previous = garden.observe(now());
  assert.equal(previous.day, 1);
  assert.equal(previous.clock, 0);
  assert.equal(previous.plots[0].plant.status, "growing");
  assert.deepEqual(
    db.prepare("SELECT * FROM garden_state").get(),
    committedRows,
  );
  assert.deepEqual(garden.timeline(), facts);

  garden.checkpoint(now());
  const saved = garden.observe(now());
  assert.equal(saved.day, 2);
  assert.equal(saved.clock, 25 * HOUR);
  assert.equal(saved.plots[0].plant.status, "mature");
  const history = garden.plantHistory({ plantId });
  assert.equal(history.plant.snapshot.maturedAt, 24 * HOUR);
  assert.equal(
    history.entries.find(({ type }) => type === "mature").clock,
    24 * HOUR,
  );
  garden.syncClock(now(), false);
  const frozen = garden.observe(now() + 15_000);
  assert.equal(frozen.running, false);
  assert.equal(frozen.clock, saved.clock);
  assert.deepEqual(frozen.plots, saved.plots);
});

test("old clock-only checkpoints keep earlier milestone times unknown until evidence exists", (t) => {
  const { db, store, act, now } = setup(t);
  const { plantId } = act({ kind: "plant", plot: 1, cropId: "clover" });
  db.exec(
    "DELETE FROM garden_history_start; DELETE FROM garden_plant_archive; DELETE FROM garden_facts",
  );
  db.prepare("UPDATE garden_state SET clock=? WHERE id=1").run(20 * HOUR);
  const upgraded = new GardenService(store);
  assert.equal(upgraded.observe(now()).plots[0].plant.growth, 0);
  upgraded.snapshot(now());
  assert.equal(upgraded.observe(now()).plots[0].plant.growth, 20);
  const history = upgraded.plantHistory({ plantId });
  assert.equal(history.coverage.fromClock, 20 * HOUR);
  assert.equal(history.coverage.partial, true);
  assert.deepEqual(history.entries.map(({ type }) => type).sort(), [
    "developed",
    "planted",
    "sprouted",
  ]);
  assert.ok(
    history.entries.every(
      ({ clock, source }) => clock === null && source === "legacy",
    ),
  );
});

test("a selector-based continuation keeps the original plant after the plot is replanted", (t) => {
  const { garden, act, wait } = setup(t);
  const { plantId } = act({ kind: "plant", plot: 1, cropId: "clover" });
  wait(24 * HOUR);
  const page = garden.plantHistory({ plot: 1, limit: 1 });
  const expected = garden.plantHistory({ plantId }).entries;
  act({ kind: "harvest", plot: 1, plantId });
  const replacement = act({ kind: "plant", plot: 1, cropId: "clover" }).plantId;
  const next = garden.plantHistory({ plot: 1, cursor: page.nextCursor });
  assert.equal(next.plant.id, plantId);
  assert.deepEqual([...page.entries, ...next.entries], expected);
  assert.equal(garden.plantHistory({ plot: 1 }).plant.id, replacement);
  assert.throws(
    () => garden.plantHistory({ plot: 2, cursor: page.nextCursor }),
    /INVALID_REQUEST/,
  );
});

test("online SQLite backups preserve the history, plant archives and administrator watermark", async (t) => {
  const root = temp(t);
  const file = path.join(root, "memory.sqlite");
  const backupFile = path.join(root, "backup.sqlite");
  const { garden, act, wait } = setup(t, undefined, file);
  const { plantId } = act({ kind: "plant", plot: 1, cropId: "clover" });
  wait(24 * HOUR);
  act({ kind: "harvest", plot: 1, plantId });
  garden.ackDigest(admin, garden.digest(admin).through);
  const timeline = garden.timeline();
  const history = garden.plantHistory({ plantId });
  const digest = garden.digest(admin);
  assert.equal((await backupDatabase(file, backupFile)).integrity, "ok");
  const restoredStore = new MemoryStore(backupFile);
  t.after(() => restoredStore.close());
  const restored = new GardenService(restoredStore);
  assert.deepEqual(restored.timeline(), timeline);
  assert.deepEqual(restored.plantHistory({ plantId }), history);
  assert.deepEqual(restored.digest(admin), digest);
  assert.equal(restored.observe(0).running, false);
});
