import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  adminGardenView,
  performGardenAction,
  subjectGardenGifts,
  subjectGardenView,
} from "../src/home/garden-console.mjs";
import { HOUR, defaultGardenSettings } from "../src/home/garden-rules.mjs";
import { initializeGardenTables } from "../src/home/garden-schema.mjs";
import { withExport } from "../src/memory/export.mjs";
import { fixedWeather } from "./garden-fixtures.mjs";
import { config, context, fixture } from "./helpers.mjs";

const admin = { kind: "admin", id: "administrator" };

function setup(t, { run, budget = 40 } = {}) {
  const cfg = config(3);
  for (const role of cfg.agents) {
    role.subject.enabled = true;
    role.subject.maxToolCallsPerTurn = 20;
  }
  const { runtime, store } = fixture(t, { cfg, run });
  let now = Date.UTC(2026, 0, 1);
  runtime.clock = () => now;
  const garden = runtime.home.garden;
  const settings = defaultGardenSettings();
  settings.turnLimit = 30;
  settings.initialBalance = 1400;
  settings.weather = fixedWeather("cloud");
  settings.events.rate = 0;
  settings.baseQuality = 100;
  for (const crop of Object.values(settings.crops)) {
    crop.hours = 4;
    crop.dailyWater = 0;
    crop.fertilizer = 0;
  }
  const generations = Object.fromEntries(
    cfg.agents.map(({ id }) => [id, runtime.home.generation(id)]),
  );
  settings.roles = generations;
  settings.giftBudgets = {
    total: budget * 3,
    roles: Object.fromEntries(cfg.agents.map(({ id }) => [id, budget])),
  };
  settings.giftBudgetGenerations = generations;
  garden.initialize(now, settings);
  garden.syncClock(now, true);
  const actors = cfg.agents.map(({ id }, i) => ({
    kind: "agent",
    id,
    turnId: `phase3-${i}`,
  }));
  const act = (action, actor = admin, requestId = randomUUID()) =>
    performGardenAction(runtime, actor, { requestId, action });
  const lot = (cropId, quality = "perfect", quantity = 1) => {
    const id = randomUUID();
    store.db
      .prepare(
        "INSERT INTO garden_harvests(id,crop_id,planted_by,quality,quantity,harvested_at) VALUES(?,?,?,?,?,?)",
      )
      .run(id, cropId, "administrator", quality, quantity, now);
    return id;
  };
  return {
    runtime,
    store,
    garden,
    actors,
    lot,
    roles: cfg.agents,
    view: () => adminGardenView(runtime),
    gifts: (role = actors[0]) => subjectGardenGifts(runtime, role.id),
    overview: (role = actors[0]) =>
      subjectGardenView(runtime, role.id, role.turnId),
    act,
    sow: (plot, cropId, owner) =>
      act(
        {
          kind: "plant",
          plot,
          cropId,
          buyPrice: settings.crops[cropId].seedPrice,
        },
        owner,
      ).plantId,
    advance: (delta) => {
      now += delta;
      garden.syncClock(now, true);
    },
  };
}

test("all six recipes work, and the rack unlocks advanced recipes and requotes all fees", (t) => {
  const f = setup(t);
  const flower = f.lot("moonflower", "perfect", 6);
  const secondFlower = f.lot("sunflower");
  const secondLotSameFlower = f.lot("moonflower");
  const jarFlower = f.lot("mistbell");
  const berry = f.lot("strawberry");
  const tea = f.lot("mint");
  const sachet = f.lot("chamomile");
  const make = (recipeId, harvestIds, price) =>
    f.act({ kind: "craft_gift", recipeId, harvestIds, price });
  assert.equal(f.view().craftRecipes.filter(({ locked }) => !locked).length, 5);
  for (const [recipeId, harvestId, fee] of [
    ["craft-pressed-flower", flower, 10],
    ["craft-strawberry-jam", berry, 12],
    ["craft-mint-tea", tea, 8],
    ["craft-chamomile-sachet", sachet, 12],
  ]) {
    const before = f.view().balance;
    const receipt = make(recipeId, [harvestId], fee);
    assert.equal(receipt.giftId, recipeId);
    assert.equal(receipt.balance, before - fee);
  }
  assert.throws(
    () => make("craft-mistbell-jar", [jarFlower], 20),
    /GARDEN_RECIPE_LOCKED/,
  );
  assert.throws(
    () => make("craft-flower-bouquet", [flower, secondFlower], 18),
    /GARDEN_RECIPE_LOCKED/,
  );
  f.act({ kind: "build_facility", facilityId: "drying_rack", price: 420 });
  const recipes = f.view().craftRecipes;
  assert.equal(recipes.filter(({ locked }) => !locked).length, 7);
  assert.equal(
    recipes.find(({ id }) => id === "craft-pressed-flower").price,
    5,
  );
  assert.throws(
    () => make("craft-pressed-flower", [flower], 10),
    /GARDEN_PRICE_CHANGED/,
  );
  assert.throws(
    () => make("craft-flower-bouquet", [flower, flower], 9),
    /GARDEN_RECIPE_INGREDIENTS/,
  );
  assert.throws(
    () => make("craft-flower-bouquet", [flower, secondLotSameFlower], 9),
    /GARDEN_RECIPE_INGREDIENTS/,
  );
  assert.equal(
    make("craft-flower-bouquet", [flower, secondFlower], 9).craftMeta
      .ingredients.length,
    2,
  );
  assert.equal(
    make("craft-mistbell-jar", [jarFlower], 10).craftMeta.ingredients[0].cropId,
    "mistbell",
  );
  const { items } = f.view().personalGifts;
  assert.equal(items.length, 6);
  assert.equal(items.filter(({ usable }) => usable).length, 2);
});

test("raw ingredient provenance survives a direct transfer, and every side effect rolls back on a failed receipt", (t) => {
  const f = setup(t, { budget: 14 });
  const [crafter, recipient, outsider] = f.actors;
  const plantId = f.sow(1, "strawberry", crafter);
  f.act({ kind: "water", plot: 1, plantId }, recipient);
  f.advance(8 * HOUR);
  const { harvestId } = f.act({ kind: "harvest", plot: 1, plantId });
  const before = f.overview(crafter);
  const requestId = randomUUID();
  const action = {
    kind: "craft_gift",
    recipeId: "craft-strawberry-jam",
    harvestIds: [harvestId],
    price: 12,
    recipient: { kind: recipient.kind, id: recipient.id },
    note: "不要公开的果酱纸条",
  };
  f.store.db
    .exec(`CREATE TRIGGER fixture_break_receipt BEFORE INSERT ON garden_actions
    WHEN NEW.action='craft_gift' BEGIN SELECT RAISE(ABORT,'fixture receipt failure'); END`);
  assert.throws(
    () => f.act(action, crafter, requestId),
    /fixture receipt failure/,
  );
  assert.equal(f.overview(crafter).balance, before.balance);
  assert.equal(f.overview(crafter).personalGifts.budget.used, 0);
  assert.equal(f.overview(crafter).turnRemaining, before.turnRemaining);
  assert.equal(
    f.view().harvests[0].quantity,
    before.inventory.harvests[0].quantity,
  );
  assert.deepEqual(f.gifts(recipient).personalGifts.received, []);
  assert.deepEqual(f.gifts(recipient).items, []);
  f.store.db.exec("DROP TRIGGER fixture_break_receipt");
  const receipt = f.act(action, crafter, requestId);
  assert.equal(f.act(action, crafter, requestId).replayed, true);
  assert.equal(f.overview(crafter).balance, before.balance - 12);
  assert.equal(f.overview(crafter).personalGifts.budget.used, 12);
  assert.throws(
    () =>
      f.act(
        {
          kind: "craft_gift",
          recipeId: "craft-mint-tea",
          harvestIds: [f.lot("mint")],
          price: 8,
        },
        crafter,
      ),
    /GARDEN_GIFT_BUDGET_LOW/,
  );
  const incoming = f.gifts(recipient);
  assert.equal(incoming.personalGifts.items[0].id, receipt.itemId);
  assert.deepEqual(
    incoming.personalGifts.received[0].craftMeta,
    receipt.craftMeta,
  );
  assert.deepEqual(incoming.personalGifts.items[0].craftMeta, {
    recipeId: "craft-strawberry-jam",
    ingredients: [
      {
        cropId: "strawberry",
        cropName: "奶油草莓",
        quality: "perfect",
        plantId,
        maturedDay: 1,
        carers: f.roles.slice(0, 2).map(({ name }) => name),
      },
    ],
  });
  assert.equal(incoming.personalGifts.received[0].note, action.note);
  assert.equal(incoming.items.length, 1);
  assert.deepEqual(f.gifts(outsider).communityShelves, []);
  f.act({ kind: "display_gift", itemId: receipt.itemId, slot: 16 }, recipient);
  const [shelf] = f.gifts(outsider).communityShelves;
  assert.equal(shelf.items[0].slot, 16);
  assert.equal(shelf.items[0].note, undefined);
  assert.equal(shelf.items[0].id, undefined);
  assert.deepEqual(shelf.items[0].craftMeta, receipt.craftMeta);
  assert.deepEqual(shelf.owner, {
    kind: "agent",
    id: recipient.id,
    name: f.roles[1].name,
  });
  f.act(
    {
      kind: "display_gift",
      itemId: receipt.itemId,
      slot: 16,
      publishNote: true,
    },
    recipient,
  );
  assert.equal(
    f.overview(outsider).communityShelves[0].items[0].note,
    action.note,
  );
  f.act({ kind: "use_gift", itemId: receipt.itemId }, recipient);
  assert.deepEqual(f.gifts(outsider).communityShelves, []);
  assert.equal(f.gifts(recipient).personalGifts.received[0].note, action.note);
});

test("old-column migration retains sparse attribution and a displayed craft cannot cross a replaced generation", async (t) => {
  const f = setup(t);
  const [crafter, recipient, outsider] = f.actors;
  f.store.db.exec(
    "ALTER TABLE garden_harvests DROP COLUMN plant_id; ALTER TABLE garden_items DROP COLUMN craft_meta",
  );
  const harvestId = f.lot("mint", "fine");
  f.store.transaction(() => initializeGardenTables(f.store.db));
  f.store.transaction(() => initializeGardenTables(f.store.db));
  const note = "这一句只给朋友";
  const receipt = f.act(
    {
      kind: "craft_gift",
      recipeId: "craft-mint-tea",
      harvestIds: [harvestId],
      price: 8,
      recipient: { kind: "agent", id: recipient.id },
      note,
    },
    crafter,
  );
  assert.deepEqual(receipt.craftMeta.ingredients, [
    { cropId: "mint", cropName: "薄荷盆栽", quality: "fine" },
  ]);
  const roleExport = (id) =>
    withExport(f.store, id, async ({ path }) =>
      JSON.parse(await readFile(path, "utf8")),
    );
  const exported = await roleExport(recipient.id);
  assert.equal(
    exported.tables.events.filter(({ kind }) => kind === "garden.item_gift")
      .length,
    1,
  );
  assert.ok(!JSON.stringify(exported).includes(note));
  assert.ok(
    !(await roleExport(outsider.id)).tables.events.some(
      ({ kind }) => kind === "garden.item_gift",
    ),
  );
  f.act({ kind: "display_gift", itemId: receipt.itemId, slot: 2 }, recipient);
  assert.equal(f.overview(outsider).communityShelves.length, 1);
  f.store.db
    .prepare("UPDATE home_identities SET generation=? WHERE agent_id=?")
    .run(randomUUID(), recipient.id);
  assert.deepEqual(f.gifts(recipient).personalGifts.items, []);
  assert.deepEqual(f.overview(outsider).communityShelves, []);
  assert.ok(
    !(await roleExport(recipient.id)).tables.events.some(
      ({ kind }) => kind === "garden.item_gift",
    ),
  );
});

test("AI discovers workshop actions and guests can read the public almanac without seeing private gifts", async (t) => {
  const f = setup(t, {
    run: async (p) => {
      const read = await p.callTool("garden_read", { view: "overview" });
      const mint = read.craftRecipes.find(({ id }) => id === "craft-mint-tea");
      assert.equal(mint.ready, true);
      assert.ok(read.almanacSummary.total > 0);
      const result = await p.callTool("garden_act", {
        kind: "craft_gift",
        args: {
          recipeId: mint.id,
          harvestIds: mint.suggestedHarvestIds,
          price: mint.price,
        },
        requestId: randomUUID(),
      });
      const gifts = await p.callTool("garden_read", { view: "gifts" });
      assert.equal(gifts.personalGifts.items[0].id, result.itemId);
      assert.equal(gifts.communityShelves.length, 0);
      assert.equal(gifts.facilities.length, 3);
      const chime = gifts.facilities.find(({ id }) => id === "weather_chime");
      await p.callTool("garden_act", {
        kind: "build_facility",
        args: { facilityId: chime.id, price: chime.price },
        requestId: randomUUID(),
      });
      const updated = await p.callTool("garden_read", { view: "gifts" });
      assert.equal(updated.tomorrowForecast.direction, "cloud");
    },
  });
  f.lot("mint");
  assert.equal(
    (await f.runtime.wake(f.actors[0].id, "@subject")).status,
    "completed-no-send",
  );
  const guest = context(f.runtime, f.actors[2].id);
  const almanac = await f.runtime.callTool(guest, "garden_read", {
    view: "almanac",
  });
  assert.ok(almanac.total > 0);
  assert.ok(!almanac.entries.some(({ cropId }) => cropId === "mistbell"));
  assert.equal(almanac.personalGifts, undefined);
  assert.equal(almanac.communityShelves, undefined);
  const publicGarden = await f.runtime.callTool(guest, "garden_read", {
    view: "public",
  });
  assert.equal(publicGarden.communityShelves, undefined);
  await assert.rejects(
    f.runtime.callTool(guest, "garden_read", { view: "gifts" }),
    /TOOL_DISABLED/,
  );
});
