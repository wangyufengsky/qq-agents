import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import {
  adminGardenView,
  adminGardenWrite,
  performGardenAction,
  subjectGardenView,
} from "../src/home/garden-console.mjs";
import { DAY, HOUR, defaultGardenSettings } from "../src/home/garden-rules.mjs";
import { fixedWeather } from "./garden-fixtures.mjs";
import { config, fixture } from "./helpers.mjs";

const admin = { kind: "admin", id: "administrator" };

function options(event) {
  const settings = defaultGardenSettings();
  settings.turnLimit = 10;
  settings.weather = fixedWeather();
  settings.events.rate = event ? 1 : 0;
  for (const [id, entry] of Object.entries(settings.events.entries))
    entry.enabled = id === event;
  return settings;
}

function setup(t, settings, run) {
  const cfg = config(2);
  const [role, other] = cfg.agents;
  role.subject.enabled = true;
  role.subject.maxToolCallsPerTurn = 20;
  const { runtime, store } = fixture(t, { cfg, run });
  let now = Date.UTC(2026, 0, 1);
  runtime.clock = () => now;
  const garden = runtime.home.garden;
  settings.roles = { [role.id]: runtime.home.generation(role.id) };
  garden.initialize(now, settings);
  garden.syncClock(now, true);
  const actor = { kind: "agent", id: role.id, turnId: "notes-turn" };
  return {
    runtime,
    store,
    garden,
    actor,
    role,
    other,
    advance: (ms) => {
      now += ms;
      garden.syncClock(now, true);
    },
    act: (action, author = admin, requestId = randomUUID()) =>
      performGardenAction(runtime, author, { action, requestId }),
    view: () => adminGardenView(runtime),
    overview: () => subjectGardenView(runtime, role.id, actor.turnId),
  };
}

test("admin and garden tools share one blackboard with an independent three-write budget", async (t) => {
  const settings = options();
  settings.turnLimit = 1;
  settings.crops.clover.hours = 1;
  const f = setup(t, settings, async (p) => {
    const read = () => p.callTool("garden_read", { view: "overview" });
    const write = (args, requestId = randomUUID()) =>
      p.callTool("garden_act", { kind: "set_board_note", requestId, args });
    const initial = await read();
    assert.equal(initial.boardNotes.garden.text, "欢迎来到花园");
    assert.equal(initial.scene.period, "day");
    assert.equal(
      initial.market.crops.find(({ id }) => id === "tomato").maxHarvests,
      3,
    );
    assert.ok(!initial.market.crops.some(({ id }) => id === "sunberry"));
    const note = {
      scope: "plot",
      plot: 1,
      text: "  " + "🌷".repeat(120) + "  ",
    };
    const requestId = randomUUID();
    await write(note, requestId);
    assert.equal((await write(note, requestId)).replayed, true);
    await assert.rejects(
      write({ ...note, text: "花".repeat(121) }),
      /GARDEN_NOTE_TOO_LONG/,
    );
    await assert.rejects(
      write({ scope: "plot", text: "缺少地块" }),
      /INVALID_REQUEST/,
    );
    const beforeHarvest = await read();
    assert.equal(beforeHarvest.turnRemaining, 1);
    assert.equal(beforeHarvest.plots[0].note.authorName, f.role.name);
    assert.equal(beforeHarvest.plots[0].hasNote, true);
    assert.equal(
      beforeHarvest.priorities.find(({ plot }) => plot === 1).hasNote,
      true,
    );
    await p.callTool("garden_act", {
      kind: "harvest",
      requestId: randomUUID(),
      args: { plot: 1, plantId },
    });
    await write({ scope: "garden", text: "已经收好了" });
    await write({ ...note, text: "" });
    await assert.rejects(write(note), /GARDEN_NOTE_LIMIT/);
    const finished = await read();
    assert.equal(finished.turnRemaining, 0);
    assert.equal(finished.plots[0].note, null);
    assert.equal(finished.boardNotes.garden.text, "已经收好了");
  });
  const { plantId } = f.act({ kind: "plant", cropId: "clover", plot: 1 });
  adminGardenWrite(f.runtime, "act", {
    requestId: randomUUID(),
    action: { kind: "set_board_note", scope: "garden", text: "欢迎来到花园" },
  });
  f.advance(8 * HOUR);
  const outcome = await f.runtime.wake(f.role.id, "@subject");
  assert.equal(outcome.status, "completed-no-send");
  assert.equal(f.view().boardNotes.garden.text, "已经收好了");
});

test("rumors unlock on successful merchant transactions, visitor claims and five-day milestones", (t) => {
  const f = setup(t, options("merchant"));
  assert.deepEqual(
    f.view().rumors.map(({ source }) => source),
    ["initial"],
  );
  const { event } = f.view();
  const offer = event.seedOffers[0];
  const action = {
    kind: "merchant_buy",
    eventId: event.id,
    cropId: offer.cropId,
    quantity: 1,
    price: Math.round(offer.rate),
  };
  assert.throws(
    () => f.act({ ...action, price: action.price + 1 }),
    /GARDEN_PRICE_CHANGED/,
  );
  assert.equal(f.view().rumors.length, 1);
  const requestId = randomUUID();
  f.act(action, admin, requestId);
  assert.equal(f.act(action, admin, requestId).replayed, true);
  assert.deepEqual(
    f.view().rumors.map(({ source }) => source),
    ["initial", "merchant"],
  );
  f.advance(5 * DAY);
  assert.ok(
    f.store.db
      .prepare(
        "SELECT 1 FROM garden_rumors WHERE source='calendar' AND unlocked_day=6",
      )
      .get(),
  );
  assert.deepEqual(
    f.view().rumors.map(({ source }) => source),
    ["initial", "merchant", "calendar"],
  );
  const identity = {
    ...f.actor,
    generation: f.runtime.home.generation(f.role.id),
  };
  assert.ok(f.overview().highlights.some(({ type }) => type === "rumor"));
  const { through } = f.garden.digest(identity);
  assert.deepEqual(f.garden.ackDigest(identity, through), { through });
  assert.deepEqual(f.overview().highlights, []);

  const visitor = setup(t, options("visitor"));
  assert.equal(visitor.view().rumors.length, 1);
  assert.deepEqual(
    visitor.overview().rumors.map(({ source }) => source),
    ["initial", "visitor"],
  );
  assert.equal(visitor.overview().rumors.length, 2);
});

test("blind box surprise cites its garden fact and the actor's reusable diary evidence", async (t) => {
  const f = setup(t, options("mystery-seed-bag"), async (p) => {
    const request = {
      kind: "plant_mystery_seed",
      requestId: randomUUID(),
      args: { plot: 1 },
    };
    const first = await p.callTool("garden_act", request);
    const repeated = await p.callTool("garden_act", request);
    assert.equal(first.surprise.kind, "mystery_seed");
    assert.deepEqual(repeated.surprise, first.surprise);
    assert.equal(repeated.replayed, true);
    const { evidenceId, factId } = first.surprise;
    const { entries } = await p.callTool("garden_read", {
      view: "timeline",
      factId,
    });
    assert.equal(entries[0].id, factId);
    const diary = await p.callTool("diary_write", {
      title: "拆开花种盲盒",
      body: first.surprise.detail,
      evidence: [evidenceId],
    });
    assert.deepEqual(
      f.store.bind(f.role.id).readRecord({ id: diary.id }).metadata.evidence,
      [evidenceId],
    );
  });
  f.advance(5 * DAY);
  const { event } = f.view();
  f.act({
    kind: "buy_mystery_seed",
    eventId: event.id,
    price: event.effect.price,
    quantity: 1,
  });
  assert.equal(
    (await f.runtime.wake(f.role.id, "@subject")).status,
    "completed-no-send",
  );
  assert.equal(
    f.store.db
      .prepare(
        "SELECT count(*) AS n FROM events WHERE kind='garden.observation'",
      )
      .get().n,
    1,
  );
});

test("gift highlights are recipient-only and public timelines do not expose the gift or note", (t) => {
  const f = setup(t, options("merchant"));
  const offer = f.view().event.giftOffers[0];
  f.act({
    kind: "buy_gift",
    eventId: f.view().event.id,
    giftId: offer.giftId,
    price: offer.price,
    recipient: { kind: "agent", id: f.role.id },
    note: "仅收件人可读",
  });
  const recipient = f.overview();
  const outsider = subjectGardenView(f.runtime, f.other.id, "other-turn");
  assert.ok(recipient.highlights.some(({ type }) => type === "gift"));
  assert.ok(!outsider.highlights.some(({ type }) => type === "gift"));
  assert.ok(!JSON.stringify(outsider).includes("仅收件人可读"));
  for (const publicView of [true, false]) {
    const timeline = f.garden.timeline({}, { publicView });
    assert.ok(!timeline.entries.some(({ type }) => type === "private_gift"));
    assert.ok(!JSON.stringify(timeline).includes("仅收件人可读"));
  }
  const identity = {
    ...f.actor,
    generation: f.runtime.home.generation(f.role.id),
  };
  assert.ok(
    f.garden.digest(identity).entries.some(({ type }) => type === "gift"),
  );
  assert.ok(
    !f.garden
      .digest(identity, { publicView: true })
      .entries.some(({ type }) => type === "gift"),
  );
});

test("meteor overview creates one personal, reusable observation; public reads create none", (t) => {
  const settings = options("meteor-shower");
  settings.events.entries["meteor-shower"].conditions = [];
  const f = setup(t, settings);
  f.advance(8 * HOUR);
  f.garden.observe(f.runtime.now());
  assert.deepEqual(f.overview().observations, []);
  assert.equal(
    f.store.db
      .prepare(
        "SELECT count(*) AS n FROM events WHERE kind='garden.observation'",
      )
      .get().n,
    0,
  );
  f.advance(12 * HOUR);
  const first = f.overview().observations.find(({ kind }) => kind === "meteor");
  const second = f
    .overview()
    .observations.find(({ kind }) => kind === "meteor");
  assert.ok(first?.evidenceId);
  assert.deepEqual(first.surprise, {
    kind: "meteor",
    title: "流星雨许愿夜",
    detail: "你在小窝花园观察了流星雨许愿夜。",
    evidenceId: first.evidenceId,
  });
  assert.deepEqual(first, second);
  assert.equal(
    f.store.db
      .prepare(
        "SELECT count(*) AS n FROM events WHERE kind='garden.observation'",
      )
      .get().n,
    1,
  );
});

test("dusk butterflies and visible pollen grant distinct observations only once per role and day", (t) => {
  const settings = options();
  for (const id of ["moonflower", "catnip"]) {
    settings.crops[id].hours = 4;
    settings.crops[id].dailyWater = 0;
  }
  const f = setup(t, settings);
  const pair = ["moonflower", "catnip"]
    .map(
      (cropId, index) =>
        f.act({
          kind: "plant",
          plot: index + 1,
          cropId,
          buyPrice: settings.crops[cropId].seedPrice,
        }).plantId,
    )
    .sort()
    .join(":");
  const draw = (seed, lane, day) =>
    createHash("sha256")
      .update(JSON.stringify([seed, lane, day]))
      .digest()
      .readUInt32BE() <
    0x100000000 / 3;
  // The previous night yields a clue and the following dusk has butterflies.
  const seed = Array.from({ length: 64 }, (_, i) => `fixture-${i}`).find(
    (candidate) =>
      !draw(candidate, pair, 2) && draw(candidate, "butterflies", 3),
  );
  assert.ok(seed);
  f.store.db
    .prepare("UPDATE garden_weather_seed SET seed=? WHERE id=1")
    .run(seed);
  f.advance(2 * DAY + 18 * HOUR);
  const first = f.overview();
  assert.equal(first.scene.period, "dusk");
  assert.equal(first.scene.butterflies, true);
  assert.deepEqual(first.scene.pollenPairs, [
    { plots: [1, 2], hint: "蓝紫色花粉" },
  ]);
  assert.deepEqual(
    first.observations.map(({ kind }) => kind),
    ["butterflies", "pollen"],
  );
  assert.deepEqual(f.overview().observations, first.observations);
  assert.equal(
    f.store.db
      .prepare(
        "SELECT count(*) AS n FROM events WHERE kind='garden.observation'",
      )
      .get().n,
    2,
  );
});

test("neighbor seed highlights cite the journal and disappear after acknowledgement", (t) => {
  const settings = options();
  for (const id of ["moonflower", "catnip"]) {
    settings.crops[id].hours = 4;
    settings.crops[id].dailyWater = 0;
  }
  const f = setup(t, settings);
  for (const [index, cropId] of ["moonflower", "catnip"].entries())
    f.act({
      kind: "plant",
      plot: index + 1,
      cropId,
      buyPrice: settings.crops[cropId].seedPrice,
    });
  // Three eligible nights guarantee a real seed regardless of the garden seed.
  f.advance(4 * DAY + 8 * HOUR);
  const { highlights, observations } = f.overview();
  const discovery = highlights.find(
    ({ surprise }) => surprise?.kind === "neighbor_seed",
  );
  assert.ok(discovery);
  assert.equal(discovery.surprise.factId, discovery.id);
  assert.equal(discovery.surprise.evidenceId, undefined);
  assert.equal(observations.length, 0);
  const [fact] = f.garden.timeline({
    factId: discovery.surprise.factId,
  }).entries;
  assert.equal(fact.detail.phase, "seed");
  const identity = {
    ...f.actor,
    generation: f.runtime.home.generation(f.role.id),
  };
  f.garden.ackDigest(identity, f.garden.digest(identity).through);
  assert.deepEqual(f.overview().highlights, []);
});
