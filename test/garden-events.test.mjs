import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { MemoryStore } from "../src/memory/store.mjs";
import { withExport } from "../src/memory/export.mjs";
import { backupDatabase } from "../src/memory/backup.mjs";
import { GardenService } from "../src/home/garden-service.mjs";
import {
  adminGardenView,
  performGardenAction,
} from "../src/home/garden-console.mjs";
import { DAY, HOUR, defaultGardenSettings } from "../src/home/garden-rules.mjs";
import { eventOdds } from "../src/home/garden-event-rules.mjs";
import { fixedWeather } from "./garden-fixtures.mjs";
import { config, context, fixture, raw, settle } from "./helpers.mjs";

const lease = 100 * DAY;
const admin = { kind: "admin", id: "administrator" };
const actor = { kind: "agent", id: "agent-0", turnId: "turn-01" };

function rules(kind, patches = {}) {
  const value = defaultGardenSettings();
  value.weather = fixedWeather();
  value.crops.clover.hours = 1;
  value.events.rate = 1;
  for (const [id, entry] of Object.entries(value.events.entries))
    entry.enabled = id === kind;
  Object.assign(value.events.entries[kind].effect, patches);
  return value;
}
function setup(t, settings) {
  const store = new MemoryStore(":memory:");
  t.after(() => store.close());
  const garden = new GardenService(store);
  let now = 0;
  garden.initialize(now, settings);
  garden.desktopSync(now, lease);
  return {
    garden,
    store,
    read: () => garden.read(now),
    act: (action, by = admin, requestId = randomUUID()) =>
      garden.act(now, by, { action, requestId }),
    claim: (by = admin) => garden.read(now, by),
    advance: (ms) => {
      now += ms;
      garden.desktopSync(now, lease);
    },
    configure: (fn) => {
      const state = garden.requireState();
      fn(state.settings);
      return garden.configure(now, state.settingsRevision, state.settings);
    },
  };
}
test("event odds use selected weather and strict balance thresholds, with independent no-event probability", () => {
  const s = rules("merchant");
  for (const entry of Object.values(s.events.entries)) entry.enabled = true;
  s.events.entries.visitor.weight = 0;
  s.events.entries.merchant.conditions = [
    { field: "today", match: { by: "kind", value: "sun" } },
  ];
  s.events.rate = 0.4;
  const ctx = {
    balance: 300,
    seeds: {},
    harvests: {},
    fertilizer: 0,
    previous: null,
  };
  const cloudy = s.weather.entries.cloud,
    sunny = s.weather.entries.sun;
  const trial = (weather) => eventOdds(s.events, ctx, weather);
  assert.equal(trial(cloudy).noEvent, 1);
  assert.equal(
    trial(sunny).rows.find(({ id }) => id === "merchant").probability,
    0.4,
  );
  assert.equal(
    trial(sunny).rows.find(({ id }) => id === "thief").reason,
    "conditions",
  );
  ctx.balance = 301;
  const odds = trial(sunny);
  assert.ok(
    Math.abs(odds.rows.find(({ id }) => id === "merchant").probability - 0.3) <
      1e-12,
  );
  assert.equal(odds.rows.find(({ id }) => id === "thief").probability, 0.1);
  assert.equal(odds.noEvent, 0.6);
  assert.equal(
    trial(cloudy).rows.find(({ id }) => id === "merchant").probability,
    0,
  );
});

test("merchant shares frozen quotes for paid and rare seeds and premium sales until day end", (t) => {
  const s = rules("merchant", {
    seeds: ["moonflower"],
    harvests: ["clover"],
    minPremium: 1.4,
    maxPremium: 1.4,
  });
  s.crops.moonflower.market = false;
  s.crops.moonflower.seedPrice = 139;
  const f = setup(t, s);
  const day = f.read().event;
  assert.deepEqual(
    day.seedOffers.map(({ rate }) => rate),
    [104.25],
  );
  f.configure((cfg) => {
    cfg.crops.moonflower.seedPrice = 500;
    cfg.crops.clover.salePrice = 50;
  });
  const buy = {
    kind: "merchant_buy",
    eventId: day.id,
    cropId: "moonflower",
    quantity: 2,
    price: 209,
  };
  assert.equal(f.act(buy, actor).price, 209);
  assert.equal(f.act({ ...buy, quantity: 1, price: 104 }).price, 104);
  assert.equal(f.read().seeds.moonflower, 3);
  assert.throws(() => f.act({ ...buy, price: 208 }), /GARDEN_PRICE_CHANGED/);
  const planted = f.act({ kind: "plant", plot: 1, cropId: "clover" });
  f.advance(HOUR);
  const { harvestId } = f.act({
    kind: "harvest",
    plot: 1,
    plantId: planted.plantId,
  });
  assert.equal(
    f.act(
      {
        kind: "merchant_sell",
        eventId: day.id,
        harvestId,
        quantity: 1,
        price: 35,
      },
      actor,
    ).eventId,
    day.id,
  );
  f.advance(DAY - HOUR);
  assert.throws(() => f.act(buy), /GARDEN_EVENT_EXPIRED/);
  assert.equal(f.read().day, 2);
  assert.equal(f.garden.calendar.events.get(1).status, "expired");
  assert.notEqual(f.read().event.id, day.id);
  assert.ok(
    f
      .read()
      .activity.some(
        (record) =>
          record.result.eventId === day.id && record.action === "merchant_sell",
      ),
  );
});

test("cross-day thief loss is bounded and updates the balance before the next condition check", (t) => {
  const s = rules("thief", { coinLoss: 80 });
  s.initialBalance = 330;
  const f = setup(t, s);
  assert.equal(f.read().event.kind, "thief");
  f.advance(3 * DAY);
  assert.equal(f.read().balance, 250);
  assert.equal(f.read().event, null);
  assert.equal(f.garden.calendar.events.get(1).status, "missed");
  assert.deepEqual(f.garden.calendar.events.get(1).outcome, { coins: 80 });
  assert.equal(f.garden.calendar.events.get(2), null);
  assert.equal(
    f.read().ledger.filter(({ action }) => action === "thief_loss").length,
    1,
  );
});

test("thief prefers one bounded harvest loss, and the first chase wins without duplicate rewards", async (t) => {
  const s = rules("thief", { cropLoss: 5 });
  const f = setup(t, s);
  const { plantId } = f.act({ kind: "plant", plot: 1, cropId: "clover" });
  f.advance(HOUR);
  f.act({ kind: "harvest", plot: 1, plantId });
  f.advance(DAY - HOUR);
  assert.equal(f.read().harvests.length, 0);
  assert.equal(f.read().balance, 1000);
  assert.equal(f.garden.calendar.events.get(1).outcome.quantity, 1);
  const action = { kind: "chase_thief", eventId: f.read().event.id };
  const requestId = randomUUID();
  const results = await Promise.allSettled([
    Promise.resolve().then(() => f.act(action, actor, requestId)),
    Promise.resolve().then(() => f.act(action)),
  ]);
  assert.equal(results[0].value.reward, 15);
  assert.equal(results[1].reason.message, "GARDEN_EVENT_HANDLED");
  assert.equal(f.act(action, actor, requestId).replayed, true);
  assert.equal(f.read().balance, 1015);
});

test("lucky visitor remains available after public reads, is collected once, and stores a usable fertilizer credit", async (t) => {
  const f = setup(
    t,
    rules("visitor", { reward: { kind: "fertilizer_credit", quantity: 1 } }),
  );
  assert.equal(f.read().event.status, "open");
  const claims = await Promise.all([
    Promise.resolve().then(() => f.claim(actor)),
    Promise.resolve().then(() => f.claim()),
  ]);
  assert.equal(claims[0].event.actor.id, actor.id);
  assert.equal(claims[1].event.actor.id, actor.id);
  assert.equal(f.read().fertilizerCredits, 1);
  const { plantId } = f.act({
    kind: "plant",
    plot: 1,
    cropId: "radish",
    buyPrice: 30,
  });
  assert.equal(f.act({ kind: "fertilize", plot: 1, plantId }).usedCredit, true);
  assert.equal(f.read().fertilizerCredits, 0);
  f.advance(2 * DAY);
  assert.equal(f.read().day, 3);
  assert.equal(f.garden.calendar.events.get(2).status, "expired");
  assert.equal(f.read().event.status, "open");
});

test("recipient sees authoritative gift evidence in a subject turn and can cite it in a private diary; export isolates roles", async (t) => {
  const cfg = config(2);
  cfg.agents[0].subject.enabled = true;
  cfg.agents[1].subject.enabled = true;
  let f, result;
  const roleId = "agent-1";
  f = fixture(t, {
    cfg,
    run: async (p) => {
      const gifts = await p.callTool("garden_read", { view: "gifts" });
      assert.match(p.prompt, /你收到的花园礼物/);
      const { evidenceId } = gifts.items[0];
      const diary = await p.callTool("diary_write", {
        title: "收到花园收成",
        body: "今天收到共享花园里的三叶草。",
        evidence: [evidenceId],
      });
      result = { diary, evidenceId };
    },
  });
  const { runtime: r, store } = f;
  let now = Date.UTC(2026, 0, 1);
  r.clock = () => now;
  const garden = r.home.garden;
  garden.initialize(now, rules("merchant", { harvests: ["clover"] }));
  garden.desktopSync(now, lease);
  const { plantId } = performGardenAction(r, admin, {
    requestId: randomUUID(),
    action: { kind: "plant", plot: 1, cropId: "clover" },
  });
  now += HOUR;
  garden.desktopSync(now, lease);
  const { harvestId } = performGardenAction(r, admin, {
    requestId: randomUUID(),
    action: { kind: "harvest", plot: 1, plantId },
  });
  const payload = {
    requestId: randomUUID(),
    action: {
      kind: "gift",
      harvestId,
      quantity: 1,
      recipient: { kind: "agent", id: roleId },
    },
  };
  const gift = performGardenAction(r, actor, payload);
  assert.equal(performGardenAction(r, actor, payload).giftId, gift.giftId);
  assert.equal((await r.wake(roleId, "@subject")).status, "completed-no-send");
  const { diary, evidenceId } = result;
  const backup = path.join(f.root, "gift-backup.sqlite");
  assert.equal((await backupDatabase(store.file, backup)).integrity, "ok");
  const restored = new MemoryStore(backup);
  t.after(() => restored.close());
  assert.equal(
    restored.db
      .prepare("SELECT kind FROM events WHERE agent_id=? AND id=?")
      .get(roleId, evidenceId).kind,
    "garden.gift",
  );
  assert.ok(
    restored.db
      .prepare("SELECT id FROM garden_gifts WHERE id=?")
      .get(gift.giftId),
  );
  assert.deepEqual(
    store.bind(roleId).readRecord({ id: diary.id }).metadata.evidence,
    [evidenceId],
  );
  assert.throws(
    () => store.bind(actor.id).readRecord({ id: evidenceId }),
    /RECORD_NOT_FOUND/,
  );
  const pub = await r.callTool(
    context(r, actor.id, "private:30000"),
    "garden_read",
    { view: "public" },
  );
  assert.ok(!JSON.stringify(pub).includes(gift.giftId));
  await assert.rejects(
    r.callTool(context(r, actor.id, "private:30000"), "garden_read", {
      view: "gifts",
    }),
    /TOOL_DISABLED/,
  );
  for (const agentId of [roleId, actor.id])
    await withExport(store, agentId, async ({ path: file }) => {
      const exported = await readFile(file, "utf8");
      assert.equal(exported.includes(evidenceId), agentId === roleId);
      assert.ok(!exported.includes("garden_reward_stock"));
    });
});

for (const speed of [1, 4]) {
  test(`event, delegation, garden clock and backup resume together at ${speed}×`, async (t) => {
    const cfg = config(2);
    cfg.agents[0].ownerIds = ["30000"];
    Object.assign(cfg.agents[0].subject, { enabled: true, inboxEnabled: true });
    let f, request;
    const agentId = cfg.agents[0].id;
    const nowStart = Date.UTC(2026, 0, 1);
    f = fixture(t, {
      cfg,
      run: async (p) => {
        if (p.conversation !== "private:30000" || request) return;
        const m = f.store.bind(agentId);
        const eventId = m.db
          .prepare(
            "SELECT id FROM events WHERE agent_id=? AND kind='message.received' ORDER BY seq DESC LIMIT 1",
          )
          .get(agentId).id;
        request = await p.callTool("garden_act", {
          kind: "delegate_water",
          requestId: randomUUID(),
          args: { eventId, plot: 2 },
        });
      },
    });
    let now = nowStart;
    const r = f.runtime,
      garden = r.home.garden;
    r.clock = () => new Date(now);
    const settings = rules("thief");
    settings.speed = speed;
    settings.delegationHours = 4;
    settings.roles = { [agentId]: r.home.generation(agentId) };
    settings.startingWater = 10;
    garden.initialize(now, settings);
    garden.desktopSync(now, lease);
    performGardenAction(r, admin, {
      requestId: randomUUID(),
      action: { kind: "shelter", plot: 1 },
    });
    performGardenAction(r, actor, {
      requestId: randomUUID(),
      action: { kind: "plant", plot: 2, cropId: "clover" },
    });
    now += (22 * HOUR) / speed;
    garden.desktopSync(now, lease);
    await r.ingest(
      "qq-0",
      raw(1, {
        message_type: "private",
        group_id: undefined,
        time: now / 1000,
      }),
    );
    await settle(r);
    if (!request) await r.wake(agentId, "private:30000");
    assert.equal(request.status, "queued");
    const event = garden.read(now).event;
    garden.desktopStop(now);
    now += DAY;
    const frozen = adminGardenView(r);
    assert.equal(frozen.dayRemaining, 2 * HOUR);
    assert.equal(frozen.event.id, event.id);
    assert.equal(r.subjectInbox.dispatch(r.agent(agentId)), false);
    const copy = path.join(f.root, "copy.sqlite");
    await backupDatabase(f.store.file, copy);
    const restored = new MemoryStore(copy);
    t.after(() => restored.close());
    const reopened = new GardenService(restored);
    const paused = reopened.read(now);
    assert.equal(paused.running, false);
    assert.equal(paused.settings.speed, speed);
    assert.equal(paused.settings.roles[agentId], settings.roles[agentId]);
    assert.equal(paused.event.id, event.id);
    assert.equal(paused.plots[0].sheltered, true);
    const saved = () =>
      restored.db
        .prepare(
          "SELECT expires_clock,status FROM garden_delegations WHERE id=?",
        )
        .get(request.id);
    assert.equal(saved().status, "queued");
    assert.equal(saved().expires_clock, 26 * HOUR);
    reopened.desktopSync(now, lease);
    now += (2 * HOUR) / speed;
    reopened.desktopSync(now, lease);
    const next = reopened.read(now);
    assert.equal(next.day, 2);
    assert.equal(reopened.calendar.events.get(1).status, "missed");
    assert.throws(
      () =>
        reopened.act(now, admin, {
          requestId: randomUUID(),
          action: { kind: "chase_thief", eventId: event.id },
        }),
      /GARDEN_EVENT_EXPIRED/,
    );
    now += (2 * HOUR) / speed;
    reopened.desktopSync(now, lease);
    assert.equal(reopened.read(now).clock, saved().expires_clock);
    garden.desktopSync(now - (4 * HOUR) / speed, lease);
    garden.desktopSync(now, lease);
    const status = await r.callTool(
      context(r, agentId, "private:30000"),
      "garden_act",
      {
        kind: "delegate_status",
        requestId: randomUUID(),
        args: { delegationId: request.id },
      },
    );
    assert.equal(status.status, "expired");
  });
}
