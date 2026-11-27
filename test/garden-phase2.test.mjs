import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  adminGardenView,
  performGardenAction,
  subjectGardenView,
} from "../src/home/garden-console.mjs";
import { DAY, HOUR, defaultGardenSettings } from "../src/home/garden-rules.mjs";
import { GardenService } from "../src/home/garden-service.mjs";
import { fixedWeather } from "./garden-fixtures.mjs";
import { config, context, fixture } from "./helpers.mjs";

const admin = { kind: "admin", id: "administrator" };

function setup(t, id, { weather = "cloud", run, customize } = {}) {
  const cfg = config(3);
  for (const role of cfg.agents) {
    role.subject.enabled = true;
    role.subject.maxToolCallsPerTurn = 20;
  }
  const { runtime, store } = fixture(t, { cfg, run });
  let now = Date.UTC(2026, 0, 1);
  runtime.clock = () => now;
  let garden = runtime.home.garden;
  const settings = defaultGardenSettings();
  settings.turnLimit = 30;
  settings.initialBalance = 1200;
  settings.weather = fixedWeather(weather);
  settings.events.rate = 1;
  for (const [eventId, entry] of Object.entries(settings.events.entries))
    entry.enabled = eventId === id;
  for (const id of ["clover", "strawberry", "chamomile", "mint"]) {
    settings.crops[id].hours = 4;
    settings.crops[id].dailyWater = 0;
    settings.crops[id].fertilizer = 0;
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
    turnId: `phase2-${i}`,
  }));
  const view = () => adminGardenView(runtime);
  const act = (action, actor = admin, requestId = randomUUID()) =>
    performGardenAction(runtime, actor, { requestId, action });
  return {
    runtime,
    store,
    actors,
    settings,
    get garden() {
      return garden;
    },
    view,
    act,
    harvest: (plot, plantId) => act({ kind: "harvest", plot, plantId }),
    plant: (plot, cropId, actor) =>
      act(
        {
          kind: "plant",
          plot,
          cropId,
          buyPrice: settings.crops[cropId].seedPrice,
        },
        actor,
      ).plantId,
    advance: (delta) => {
      now += delta;
      garden.syncClock(now, true);
    },
    reopen: () => {
      garden.syncClock(now, false);
      const record = garden.calendar.events.stories.recordObservation;
      garden = runtime.home.garden = new GardenService(store);
      garden.calendar.events.stories.recordObservation = record;
      garden.syncClock(now, true);
    },
    overview: (actor = actors[0]) =>
      subjectGardenView(runtime, actor.id, actor.turnId),
    choose: (choiceId, actor, requestId) => {
      const action = view().eventActions.find(
        (action) => action.args.choiceId === choiceId,
      );
      assert.ok(action, `expected ${choiceId}`);
      return act({ ...action.args, kind: action.kind }, actor, requestId);
    },
    context: (actor = actors[0]) => context(runtime, actor.id),
  };
}

test("parallel tool choices settle once and a pending cat letter survives reopening without taking the next event slot", async (t) => {
  const f = setup(t, "rain-cat-shelter", {
    weather: "drizzle",
    run: async (p) => {
      const { event } = await p.callTool("garden_read", { view: "overview" });
      assert.equal(event.effect.options, undefined);
      const { kind, args } = event.actions.find(
        ({ args }) => args.choiceId === "share_shelter",
      );
      const req = { kind, args, requestId: randomUUID() };
      const [first, replay] = await Promise.all([
        p.callTool("garden_act", req),
        p.callTool("garden_act", req),
      ]);
      assert.equal(Number(first.replayed) + Number(replay.replayed), 1);
      assert.equal(first.outcome.pausedPlot, 1);
      await assert.rejects(
        p.callTool("garden_act", { ...req, requestId: randomUUID() }),
        /GARDEN_EVENT_ALREADY_RESOLVED/,
      );
    },
  });
  f.act({ kind: "shelter", plot: 1 });
  f.advance(DAY);
  assert.equal(
    (await f.runtime.wake(f.actors[0].id, "@subject")).status,
    "completed-no-send",
  );
  const { id } = f.view().event;
  assert.equal(
    f.store.db
      .prepare(
        "SELECT count(*) AS n FROM garden_event_followups WHERE status='pending'",
      )
      .get().n,
    1,
  );
  f.reopen();
  f.advance(DAY);
  assert.notEqual(f.view().event.id, id);
  assert.equal(f.view().event.kind, "choice");
  assert.equal(f.view().followups.length, 1);
  assert.match(f.view().followups[0].title, /小猫/);
  const chooser = f.overview(f.actors[0]);
  const visitor = f.overview(f.actors[1]);
  assert.equal(chooser.personalGifts.items.length, 1);
  assert.equal(visitor.personalGifts.items.length, 0);
  assert.equal(chooser.highlights[0].type, "event");
  const followup = chooser.highlights.find(({ type }) => type === "followup");
  assert.equal(followup.surprise.factId, followup.id);
  assert.ok(
    chooser.observations.find(({ kind }) => kind === "followup")?.evidenceId,
  );
  const { evidenceId, surprise } = visitor.observations.find(
    ({ kind }) => kind === "followup",
  );
  assert.equal(surprise.evidenceId, evidenceId);
  assert.notEqual(
    evidenceId,
    chooser.observations.find(({ kind }) => kind === "followup").evidenceId,
  );
  const localRecord = (actor, id) =>
    f.store.db
      .prepare("SELECT body FROM events WHERE agent_id=? AND id=?")
      .get(actor.id, id)?.body;
  assert.match(
    localRecord(
      f.actors[0],
      chooser.observations.find(({ kind }) => kind === "followup").evidenceId,
    ),
    /作出的选择/,
  );
  assert.match(localRecord(f.actors[1], evidenceId), /来园时读到/);
  const publicRead = await f.runtime.callTool(f.context(), "garden_read", {
    view: "public",
  });
  assert.equal(publicRead.followups, undefined);
  const publicJournal = await f.runtime.callTool(f.context(), "garden_read", {
    view: "timeline",
    type: "followup",
  });
  assert.equal(publicJournal.entries.length, 1);
  assert.ok(
    !JSON.stringify(publicJournal).includes(
      chooser.personalGifts.items[0].name,
    ),
  );
  await assert.rejects(
    f.runtime.callTool(f.context(), "garden_act", {
      kind: "choose_event",
      args: { eventId: f.view().event.id, choiceId: "guide_eaves" },
      requestId: randomUUID(),
    }),
    /TOOL_DISABLED/,
  );
  f.reopen();
  f.advance(2 * DAY);
  assert.equal(f.overview().personalGifts.items.length, 1);
  assert.equal(f.view().followups.length, 1);
});

test("recreated actors neither receive the prior generation's cat gift nor inherit evidence", (t) => {
  const f = setup(t, "rain-cat-shelter", { weather: "drizzle" });
  f.act({ kind: "shelter", plot: 1 });
  f.advance(DAY);
  f.choose("share_shelter", f.actors[0]);
  f.store.db
    .prepare("UPDATE home_identities SET generation=? WHERE agent_id=?")
    .run(randomUUID(), f.actors[0].id);
  f.advance(DAY);
  assert.equal(
    f.store.db.prepare("SELECT count(*) AS n FROM garden_items").get().n,
    0,
  );
  assert.equal(
    f.store.db
      .prepare(
        "SELECT count(*) AS n FROM events WHERE kind='garden.observation'",
      )
      .get().n,
    0,
  );
  const observer = f.overview(f.actors[0]);
  assert.ok(observer.observations.some(({ kind }) => kind === "followup"));
  assert.match(
    observer.observations.find(({ kind }) => kind === "followup").surprise
      .detail,
    /来园时读到/,
  );
  assert.equal(observer.personalGifts.items.length, 0);
});

test("hedgehog and odd trader consume once, and tea produces isolated evidence for each visitor", (t) => {
  for (const id of ["hedgehog-share", "odd-seed-trader", "garden-tea-party"]) {
    const f = setup(t, id);
    const plant = f.plant(1, "strawberry");
    f.advance(8 * HOUR);
    const { harvestId } = f.harvest(1, plant);
    f.advance(16 * HOUR);
    const target = f
      .view()
      .eventActions.find(({ args }) => args.harvestId === harvestId);
    assert.ok(target);
    assert.throws(
      () =>
        f.act({ ...target.args, harvestId: randomUUID(), kind: target.kind }),
      /GARDEN_EVENT_CHOICE_INVALID/,
    );
    assert.ok(f.view().harvests.some(({ id }) => id === harvestId));
    const requestId = randomUUID();
    const action = { ...target.args, kind: target.kind };
    assert.equal(f.act(action, admin, requestId).replayed, false);
    assert.equal(f.act(action, admin, requestId).replayed, true);
    assert.ok(!f.view().harvests.some(({ id }) => id === harvestId));
    if (id === "hedgehog-share") {
      f.reopen();
      f.advance(2 * DAY);
      assert.equal(f.view().followups[0].day, 3);
      assert.equal(
        Object.values(f.view().seeds).reduce((sum, count) => sum + count, 0),
        1,
      );
    } else if (id === "odd-seed-trader") {
      assert.equal(f.view().mysterySeeds.count, 1);
      assert.ok(f.view().rumors.some(({ source }) => source === "trader"));
    } else {
      const observations = f.actors.map((actor) =>
        f.overview(actor).observations.find(({ kind }) => kind === "tea"),
      );
      assert.equal(
        new Set(observations.map(({ evidenceId }) => evidenceId)).size,
        3,
      );
      assert.equal(
        f.overview().observations.find(({ kind }) => kind === "tea").evidenceId,
        observations[0].evidenceId,
      );
    }
  }
});

test("sketch gift carries mature plant names after being transferred and displayed", (t) => {
  const f = setup(t, "sketch-painter");
  f.plant(1, "clover");
  f.plant(2, "mint");
  f.advance(DAY);
  const [owner, recipient] = f.actors;
  f.choose("commission", owner);
  const gift = f.overview(owner).personalGifts.items[0];
  assert.equal(gift.giftId, "garden-sketch-card");
  assert.match(gift.description, /野生三叶草.*薄荷/);
  const role = { kind: recipient.kind, id: recipient.id };
  f.act(
    {
      kind: "send_gift",
      itemId: gift.id,
      recipient: role,
      note: "纸条仅收件人可读",
    },
    owner,
  );
  f.act({ kind: "display_gift", itemId: gift.id, slot: 1 }, recipient);
  const displayed = f.overview(recipient).personalGifts.shelf[0];
  assert.equal(displayed.description, gift.description);
  assert.equal(displayed.note, "");
});

test("a bird grants the administrator only one feather on an undisturbed plot", (t) => {
  for (const harvestEarly of [true, false]) {
    const f = setup(t, "migratory-bird");
    const plantId = f.plant(1, "clover");
    f.advance(DAY);
    assert.equal(f.view().event.target.plantId, plantId);
    if (harvestEarly) {
      f.harvest(1, plantId);
      assert.equal(f.view().event.outcome.unavailable, true);
    }
    f.reopen();
    f.advance(DAY);
    assert.equal(f.view().followups.length, harvestEarly ? 0 : 1);
    assert.equal(
      f
        .view()
        .personalGifts.items.filter(
          ({ giftId }) => giftId === "migratory-feather",
        ).length,
      harvestEarly ? 0 : 1,
    );
    assert.equal(
      f.store.db
        .prepare(
          "SELECT status FROM garden_event_followups WHERE trigger_day=3",
        )
        .get().status,
      harvestEarly ? "cancelled" : "settled",
    );
  }
});

test("fence note evidence is limited to current-generation carers", (t) => {
  const f = setup(t, "fence-note", {
    customize(settings) {
      settings.crops.mint.hours = 60;
    },
  });
  const [owner, helper, visitor] = f.actors;
  const plantId = f.plant(1, "mint", owner);
  f.act({ kind: "water", plot: 1, plantId }, helper);
  f.advance(DAY);
  assert.equal(f.view().event.target.plantId, plantId);
  assert.ok(
    f.overview(owner).observations.some(({ kind }) => kind === "fence_note"),
  );
  assert.ok(
    f.overview(helper).observations.some(({ kind }) => kind === "fence_note"),
  );
  assert.ok(
    !f.overview(visitor).observations.some(({ kind }) => kind === "fence_note"),
  );
  f.store.db
    .prepare("UPDATE home_identities SET generation=? WHERE agent_id=?")
    .run(randomUUID(), helper.id);
  assert.ok(
    !f.overview(helper).observations.some(({ kind }) => kind === "fence_note"),
  );
  assert.ok(
    !JSON.stringify(f.garden.timeline().entries).includes("actorGeneration"),
  );
});

test("full moon observation starts in the evening and deduplicates past midnight", (t) => {
  const f = setup(t, "full-moon-night");
  f.advance(13 * DAY);
  assert.equal(f.view().day, 14);
  assert.ok(
    !f.overview().observations.some(({ kind }) => kind === "full_moon"),
  );
  f.advance(20 * HOUR);
  const observation = (actor) =>
    f.overview(actor).observations.find(({ kind }) => kind === "full_moon");
  assert.ok(observation(f.actors[0])?.evidenceId);
  assert.notEqual(
    observation(f.actors[0]).evidenceId,
    observation(f.actors[1]).evidenceId,
  );
  const id = observation(f.actors[0]).evidenceId;
  f.advance(6 * HOUR);
  assert.equal(f.view().day, 15);
  assert.equal(f.overview().scene.fullMoon, true);
  assert.equal(observation(f.actors[0]).evidenceId, id);
  f.advance(4 * HOUR);
  assert.equal(observation(f.actors[0]), undefined);
});

test("custom costs and instant rewards commit once and unaffordable choices leave no effects", (t) => {
  const fixtures = [
    { reward: { kind: "seed", cropId: "mint", quantity: 2 }, cost: 3 },
    { reward: { kind: "fertilizer", quantity: 2 }, cost: 3 },
    { reward: { kind: "gift", giftId: "garden-sketch-card" }, cost: 3 },
    { reward: { kind: "coins", amount: 25 }, cost: 3 },
    { reward: { kind: "gift", giftId: "garden-sketch-card" }, cost: 30 },
  ];
  for (const { reward, cost } of fixtures) {
    const f = setup(t, "rain-cat-shelter", {
      weather: "drizzle",
      customize(settings) {
        settings.initialBalance = 20;
        const option =
          settings.events.entries["rain-cat-shelter"].effect.options[1];
        option.cost = { kind: "coins", amount: cost };
        option.immediateReward = reward;
      },
    });
    f.act({ kind: "shelter", plot: 1 });
    f.advance(DAY);
    const before = f.view();
    const requestId = randomUUID();
    const { args } = before.eventActions.find(
      ({ args }) => args.choiceId === "guide_eaves",
    );
    const action = { ...args, kind: "choose_event" };
    if (cost > before.balance) {
      assert.throws(
        () => f.act(action, admin, requestId),
        /GARDEN_BALANCE_LOW/,
      );
      const after = f.view();
      assert.equal(after.balance, before.balance);
      assert.equal(after.personalGifts.items.length, 0);
      assert.equal(after.event.status, "open");
      assert.ok(!after.ledger.some(({ action }) => action === "choose_event"));
      continue;
    }
    assert.equal(f.act(action, admin, requestId).replayed, false);
    assert.equal(f.act(action, admin, requestId).replayed, true);
    assert.throws(
      () => f.act(action, f.actors[0]),
      /GARDEN_EVENT_ALREADY_RESOLVED/,
    );
    const after = f.view();
    assert.equal(
      after.balance,
      before.balance - cost + (reward.kind === "coins" ? reward.amount : 0),
    );
    if (reward.kind === "seed") assert.equal(after.seeds.mint, 2);
    if (reward.kind === "fertilizer")
      assert.equal(after.fertilizer, before.fertilizer + 2);
    if (reward.kind === "gift")
      assert.equal(
        after.personalGifts.items.filter(
          ({ giftId }) => giftId === reward.giftId,
        ).length,
        1,
      );
  }
});

test("after all rumors are heard the trader adds fertilizer alongside its seed bag", (t) => {
  const f = setup(t, "odd-seed-trader");
  const plantId = f.plant(1, "clover");
  f.advance(25 * DAY);
  assert.equal(f.view().rumors.length, 6);
  f.harvest(1, plantId);
  f.advance(DAY);
  const before = f.view();
  f.choose("trade");
  const after = f.view();
  assert.equal(after.mysterySeeds.count, 1);
  assert.equal(after.fertilizer, before.fertilizer + 1);
  assert.equal(after.rumors.length, 6);
});
