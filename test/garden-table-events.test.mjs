import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { gardenCraftOrigin } from "../public/garden-art/gifts.js";
import { GardenService } from "../src/home/garden-service.mjs";
import { DAY, HOUR, defaultGardenSettings } from "../src/home/garden-rules.mjs";
import {
  adminGardenView,
  subjectGardenView,
  performGardenAction,
} from "../src/home/garden-console.mjs";
import { config, context, fixture } from "./helpers.mjs";
import { fixedWeather } from "./garden-fixtures.mjs";

const admin = { kind: "admin", id: "administrator" };
function setup(t, id, run) {
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

test("perilla cloth can stay private or be finished next day with real different leaves and two makers", (t) => {
  for (const keep of [false, true]) {
    const f = setup(t, "half-perilla-cloth");
    const first = f.sow(1, "perilla");
    const other = f.sow(2, "perilla");
    f.advance(DAY);
    const [maker, helper] = f.actors;
    const id = f.view(maker).event.id;
    const start = f.pick(keep ? "keep-half" : "leave-half", maker, { plot: 1 });
    f.act(start, maker);
    if (keep) {
      const [item] = f.view(maker).personalGifts.items;
      assert.equal(item.giftId, "perilla-half-cloth");
      assert.equal(item.craftMeta.ingredients[0].plantId, first);
      assert.equal(f.view(helper).personalGifts.items.length, 0);
      continue;
    }
    assert.ok(
      !f
        .view(helper)
        .event.actions.some(({ args }) => args.choiceId === "finish-cloth"),
    );
    f.advance(DAY);
    f.reopen();
    const action = f.pick("finish-cloth", helper, { plot: 2 }, id);
    assert.throws(
      () => f.act({ ...action, plot: 1 }, helper),
      /GARDEN_EVENT_CHOICE_INVALID/,
    );
    const request = randomUUID();
    f.act(action, helper, request);
    assert.equal(f.act(action, helper, request).replayed, true);
    assert.equal(f.view(helper).gardenProjects.length, 0);
    const [item] = f.view(helper).personalGifts.items;
    assert.equal(item.giftId, "perilla-printed-cloth");
    assert.deepEqual(
      item.craftMeta.ingredients.map(({ plantId }) => plantId),
      [first, other],
    );
    assert.deepEqual(
      item.craftMeta.makers,
      f.runtime.config.agents.map(({ name }) => name),
    );
    assert.equal(
      new Set(item.craftMeta.ingredients.map(({ maker }) => maker)).size,
      2,
    );
  }
});

test("a hard pumpkin can be finished in relay and only its owner can lend it and receive the same lamp back", async (t) => {
  const f = setup(t, "pumpkin-face");
  const [maker, helper] = f.actors;
  const plantId = f.sow(1, "pocket-pumpkin");
  f.advance(2 * DAY);
  const harvestId = f.harvest(1, plantId);
  f.advance(DAY);
  const id = f.view(maker).event.id;
  f.act(f.pick("carve-eyes", maker, { harvestId }), maker);
  f.advance(DAY);
  f.act(f.pick("carve-mouth", helper, {}, id), helper);
  f.act(f.pick("light-lamp", helper, {}, id), helper);
  const [lamp] = f.view(helper).personalGifts.items;
  assert.equal(lamp.giftId, "pumpkin-lantern");
  assert.equal(lamp.craftMeta.ingredients[0].harvestStage, "hard");
  assert.equal(lamp.craftMeta.ingredients[0].plantId, plantId);
  const recipient = { kind: maker.kind, id: maker.id };
  f.act(
    { kind: "send_gift", itemId: lamp.id, recipient, note: "只有收件人知道" },
    helper,
  );
  f.act({ kind: "display_gift", itemId: lamp.id, slot: 5 }, maker);
  f.switchTo("last-window-lamp");
  f.advance(DAY);
  assert.equal(f.view(helper).event.actions.length, 0);
  const lend = f.pick("lend-lamp", maker, { itemId: lamp.id });
  assert.throws(() => f.act(lend, helper), /GARDEN_EVENT_CHOICE_INVALID/);
  f.act(lend, maker);
  assert.equal(f.view(maker).personalGifts.items[0].loaned, true);
  assert.ok(
    !f
      .view(helper)
      .communityShelves.some(({ items }) =>
        items.some(({ giftId }) => giftId === "pumpkin-lantern"),
      ),
  );
  assert.throws(
    () =>
      f.act(
        {
          kind: "send_gift",
          itemId: lamp.id,
          recipient: { kind: "agent", id: helper.id },
        },
        maker,
      ),
    /GARDEN_ITEM_UNAVAILABLE/,
  );
  f.reopen();
  f.advance(2 * DAY);
  const [returned] = f.view(maker).personalGifts.items;
  assert.equal(returned.id, lamp.id);
  assert.equal(returned.loaned, undefined);
  assert.equal(returned.craftMeta.mothMark, true);
  assert.equal(f.view(maker).personalGifts.received[0].note, "只有收件人知道");
  assert.equal(
    f.view(helper).communityShelves.find(({ owner }) => owner.id === maker.id)
      .items[0].note,
    undefined,
  );
  const guest = context(f.runtime, helper.id);
  const publicTimeline = await f.runtime.callTool(guest, "garden_read", {
    view: "timeline",
    type: "followup",
  });
  assert.equal(publicTimeline.entries.length, 1);
  assert.match(publicTimeline.entries[0].text, /原灯已归还/);
  assert.ok(!JSON.stringify(publicTimeline).includes("只有收件人知道"));
  assert.ok(!JSON.stringify(publicTimeline).includes(lamp.id));
});

test("a real jam batch supplies exactly one spoon, with original maturity retained after restart", (t) => {
  const f = setup(t, "last-spoon-jam");
  const [maker, eater] = f.actors;
  const fruit = f.sow(1, "strawberry");
  f.advance(8 * HOUR);
  const harvestId = f.harvest(1, fruit);
  const jam = f.act(
    {
      kind: "craft_gift",
      recipeId: "craft-strawberry-jam",
      harvestIds: [harvestId],
      price: 12,
    },
    maker,
  );
  f.advance(16 * HOUR);
  const leave = f.pick("leave-spoon", maker, { itemId: jam.itemId });
  const sourceId = leave.eventId;
  const request = randomUUID();
  assert.match(f.act(leave, maker, request).outcome.detail, /第 1 天成熟/);
  assert.equal(f.act(leave, maker, request).replayed, true);
  assert.equal(f.view(maker).personalGifts.items.length, 0);
  f.advance(DAY);
  f.reopen();
  const taste = f.pick("taste-spoon", eater, {}, sourceId);
  assert.match(f.act(taste, eater).outcome.detail, /第 1 天成熟.*草莓/);
  assert.ok(!f.view(eater).gardenProjects.some(({ id }) => id === sourceId));
  assert.equal(f.view(eater).personalGifts.items.length, 0);
  assert.equal(
    f.store.db.prepare("SELECT count(*) AS n FROM garden_items").get().n,
    1,
  );
});

test("real cotton-soft leaf and corn make distinct edge textures next day, without taking the daily draw", (t) => {
  const f = setup(t, "nest-materials");
  const a = f.sow(1, "lambs-ear");
  const b = f.sow(2, "sweet-corn");
  f.advance(8 * HOUR);
  const first = f.harvest(1, a);
  const second = f.harvest(2, b);
  f.advance(16 * HOUR);
  const today = f.view().event.id;
  f.act(f.pick("weave-edge", f.actors[0], { harvestId: first }), f.actors[0]);
  f.act(f.pick("weave-edge", f.actors[1], { harvestId: second }), f.actors[1]);
  assert.equal(f.view().followups.length, 0);
  f.reopen();
  f.advance(DAY);
  assert.match(f.view().followups[0].text, /柔软的银边.*结实的金边/);
  assert.notEqual(f.view().event?.id, today);
  assert.equal(f.garden.timeline({ type: "followup" }).entries.length, 1);
});

test("two very different real pigments make one persistent attributed sample card", (t) => {
  const f = setup(t, "exchange-color");
  const [first, helper] = f.actors;
  f.runtime.config.agents[1].name = f.runtime.config.agents[0].name;
  const a = f.sow(1, "sunflower");
  const b = f.sow(2, "perilla");
  f.advance(8 * HOUR);
  const firstLot = f.harvest(1, a);
  const secondLot = f.harvest(2, b);
  f.advance(16 * HOUR);
  const id = f.view(first).event.id;
  f.act(f.pick("mix-color", first, { harvestId: firstLot }), first);
  f.advance(DAY);
  const action = f.pick("mix-color", helper, { harvestId: secondLot }, id);
  const before = f.store.db
    .prepare("SELECT quantity FROM garden_harvests WHERE id=?")
    .get(secondLot).quantity;
  f.store.db.exec(
    "CREATE TRIGGER fixture_abort_table_receipt BEFORE INSERT ON garden_actions WHEN NEW.action='choose_event' BEGIN SELECT RAISE(ABORT,'fixture failure'); END",
  );
  const request = randomUUID();
  assert.throws(() => f.act(action, helper, request), /fixture failure/);
  assert.equal(
    f.store.db
      .prepare("SELECT quantity FROM garden_harvests WHERE id=?")
      .get(secondLot).quantity,
    before,
  );
  assert.equal(f.view(helper).personalGifts.items.length, 0);
  f.store.db.exec("DROP TRIGGER fixture_abort_table_receipt");
  f.act(action, helper, request);
  assert.equal(f.act(action, helper, request).replayed, true);
  const [item] = f.view(helper).personalGifts.items;
  assert.equal(item.giftId, "mixed-color-swatches");
  assert.deepEqual(
    item.craftMeta.ingredients.map(({ cropId, color }) => [cropId, color]),
    [
      ["sunflower", "向日葵黄"],
      ["perilla", item.craftMeta.ingredients[1].leafBack],
    ],
  );
  assert.equal(item.craftMeta.makers.length, 2);
  assert.deepEqual(
    item.craftMeta.makerRefs.map(({ id }) => id),
    [first.id, helper.id],
  );
  assert.ok(!JSON.stringify(item.craftMeta).includes("generation"));
  assert.match(
    gardenCraftOrigin(item.craftMeta),
    new RegExp(first.id + ".*" + helper.id),
  );
  assert.equal(f.view(helper).gardenProjects.length, 0);
});

test("a workshop lantern qualifies, and the real tool returns it to the original generation without a public owner record", async (t) => {
  const f = setup(t, "last-window-lamp", async (p) => {
    const read = await p.callTool("garden_read", { view: "overview" });
    assert.equal(read.event.game, undefined);
    const lend = read.event.actions.find(
      ({ args }) => args.choiceId === "lend-lamp",
    );
    assert.equal(lend.args.itemId, receipt.itemId);
    const req = { kind: lend.kind, args: lend.args, requestId: randomUUID() };
    await p.callTool("garden_act", req);
    assert.equal((await p.callTool("garden_act", req)).replayed, true);
  });
  const [role] = f.actors;
  const plantId = f.sow(1, "pocket-pumpkin");
  f.advance(2 * DAY);
  const harvestId = f.harvest(1, plantId);
  const receipt = f.act(
    {
      kind: "craft_gift",
      recipeId: "craft-pumpkin-lantern",
      harvestIds: [harvestId],
      price: 14,
    },
    role,
  );
  f.advance(DAY);
  assert.equal(
    (await f.runtime.wake(role.id, "@subject")).status,
    "completed-no-send",
  );
  const owningKey = f.store.db
    .prepare("SELECT owner FROM garden_items WHERE id=?")
    .get(receipt.itemId).owner;
  f.store.db
    .prepare("UPDATE home_identities SET generation=? WHERE agent_id=?")
    .run(randomUUID(), role.id);
  f.advance(DAY);
  assert.deepEqual(f.view(role).personalGifts.items, []);
  const returned = f.store.db
    .prepare("SELECT owner,craft_meta FROM garden_items WHERE id=?")
    .get(receipt.itemId);
  assert.equal(returned.owner, owningKey);
  assert.equal(JSON.parse(returned.craft_meta).mothMark, true);
  assert.match(gardenCraftOrigin(JSON.parse(returned.craft_meta)), /蛾灰印/);
  const publicFact = f.garden.timeline(
    { type: "followup" },
    { publicView: true },
  ).entries[0];
  assert.equal(publicFact.actor, undefined);
  assert.ok(!JSON.stringify(publicFact).includes(role.id));
});
