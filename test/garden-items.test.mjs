import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { gardenGifts } from "../public/garden-art/gifts.js";
import { createServer } from "../src/server.mjs";
import path from "node:path";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  adminGardenView,
  performGardenAction,
  subjectGardenView,
} from "../src/home/garden-console.mjs";
import { gardenGiftSources } from "../src/home/garden-gift-sources.mjs";
import { DAY, defaultGardenSettings } from "../src/home/garden-rules.mjs";
import { GardenService } from "../src/home/garden-service.mjs";
import { backupDatabase } from "../src/memory/backup.mjs";
import { MemoryStore } from "../src/memory/store.mjs";
import { withExport } from "../src/memory/export.mjs";
import { fixedWeather } from "./garden-fixtures.mjs";
import { config, fixture as runtimeFixture, temp } from "./helpers.mjs";

const admin = { kind: "admin", id: "administrator", generation: "instance" };
const cat = { kind: "agent", id: "agent-0", turnId: "turn-cat" };
const rabbit = { kind: "agent", id: "agent-1", turnId: "turn-rabbit" };

function fixture(t, options = {}) {
  const store = new MemoryStore(options.file ?? ":memory:");
  t.after(() => store.close());
  const garden = new GardenService(store);
  const people = [
    { ...cat, name: "猫猫", generation: randomUUID() },
    { ...rabbit, name: "兔兔", generation: randomUUID() },
  ];
  for (const role of people)
    store.db
      .prepare("INSERT INTO home_identities VALUES(?,?,1)")
      .run(role.id, role.generation);
  const generation = (id) => people.find((role) => role.id === id).generation;
  let now = 0;
  const runtime = {
    config: { mode: "live", agents: people },
    maintenance: { active: false },
    memory: store,
    home: { garden, generation },
    agent: (id) => people.find((role) => role.id === id),
    now: () => now,
  };
  const settings = defaultGardenSettings();
  settings.weather = fixedWeather();
  settings.initialBalance = options.balance ?? 100;
  settings.turnLimit = 10;
  settings.giftBudgets = options.limits ?? {
    total: 60,
    roles: { [cat.id]: 30, [rabbit.id]: 30 },
  };
  settings.giftBudgetGenerations = Object.fromEntries(
    people.map((role) => [role.id, role.generation]),
  );
  settings.events.rate = 1;
  for (const [key, entry] of Object.entries(settings.events.entries))
    entry.enabled = key === "merchant";
  settings.events.entries.merchant.effect.giftOffers = options.giftOffers ?? [
    { giftId: "dried-fish", stock: 2 },
    { giftId: "yarn-ball", stock: 1 },
    { giftId: "pressed-bookmark", stock: 2 },
  ];
  garden.initialize(now, settings);
  garden.desktopSync(now, DAY * 10);
  const view = () => adminGardenView(runtime);
  return {
    runtime,
    garden,
    store,
    people,
    generation,
    view,
    owner: (actor) => ({ ...actor, generation: generation(actor.id) }),
    role: (actor) =>
      subjectGardenView(runtime, actor.id, actor.turnId).personalGifts,
    buy: (giftId, price, recipient, note) => ({
      kind: "buy_gift",
      giftId,
      price,
      eventId: view().event.id,
      ...(recipient && {
        recipient: { kind: recipient.kind, id: recipient.id },
      }),
      ...(note && { note }),
    }),
    act: (actor, action, requestId = randomUUID()) =>
      performGardenAction(runtime, actor, { action, requestId }),
    advance: (delta) => {
      now += delta;
      garden.desktopSync(now, DAY * 10);
    },
  };
}

test("default gift budgets start closed and never share mutable role limits", () => {
  const settings = defaultGardenSettings();
  settings.giftBudgets.roles[cat.id] = 30;
  assert.deepEqual(defaultGardenSettings().giftBudgets, {
    total: 0,
    roles: {},
  });
});

test("a direct gift charges once, gives one private paper note, and supports shelf, eating and transfer by item", (t) => {
  const f = fixture(t);
  const buy = f.buy("dried-fish", 12, cat, "第一张纸条");
  const first = f.act(admin, buy, "dried-fish-purchase");
  assert.equal(f.act(admin, buy, "dried-fish-purchase").replayed, true);
  assert.equal(first.balance, 88);
  const second = f.act(admin, f.buy("dried-fish", 12, cat, "第二张纸条"));
  assert.equal(
    f.view().ledger.filter((row) => row.action === "buy_gift").length,
    2,
  );
  const catItems = f.role(cat);
  assert.equal(catItems.items.length, 2);
  assert.equal(
    catItems.items.find((item) => item.id === first.itemId).source.note,
    "第一张纸条",
  );
  assert.equal(gardenGiftSources(f.runtime, cat.id).length, 2);
  assert.equal(f.role(rabbit).received.length, 0);
  assert.equal(f.view().personalGifts.items.length, 0);
  assert.ok(!JSON.stringify(f.view().activity).includes(first.itemId));
  assert.throws(
    () => f.act(admin, { kind: "display_gift", itemId: first.itemId, slot: 1 }),
    /GARDEN_ITEM_UNAVAILABLE/,
  );
  f.act(cat, {
    kind: "display_gift",
    itemId: first.itemId,
    slot: 1,
    description: "晒一晒",
  });
  f.act(cat, {
    kind: "display_gift",
    itemId: second.itemId,
    slot: 2,
    publishNote: true,
  });
  assert.deepEqual(
    f.garden.gifts
      .shelfFor(f.owner(cat))
      .map((row) => [row.slot, row.description, row.note]),
    [
      [1, "晒一晒", ""],
      [2, "", "第二张纸条"],
    ],
  );
  f.act(cat, { kind: "use_gift", itemId: second.itemId });
  assert.equal(f.garden.gifts.shelfFor(f.owner(cat)).length, 1);
  f.act(cat, {
    kind: "send_gift",
    itemId: first.itemId,
    recipient: { kind: "agent", id: rabbit.id },
    note: "新纸条",
  });
  assert.deepEqual(f.garden.gifts.shelfFor(f.owner(cat)), []);
  assert.deepEqual(
    f.role(rabbit).received.map((row) => row.note),
    ["新纸条"],
  );
  assert.deepEqual(
    f.role(cat).received.map((row) => row.note),
    ["第二张纸条", "第一张纸条"],
  );
  assert.equal(f.view().balance, 76);
  assert.equal(
    f.view().event.giftOffers.find((row) => row.giftId === "dried-fish").stock,
    0,
  );
});

test("the expanded gift catalog supports purchasing, gifting and displaying each item", async (t) => {
  assert.equal(Object.keys(gardenGifts).length, 18);
  for (const [giftId, { name, price, usable }] of Object.entries(gardenGifts))
    await t.test(giftId, (itemTest) => {
      const f = fixture(itemTest, { giftOffers: [{ giftId, stock: 1 }] });
      const { itemId } = f.act(admin, f.buy(giftId, price));
      assert.equal(f.view().event.giftOffers[0].stock, 0);
      const { transferId } = f.act(admin, {
        kind: "send_gift",
        itemId,
        recipient: { kind: "agent", id: cat.id },
        note: "花园里挑的",
      });
      const [item] = f.role(cat).items;
      assert.equal(item.giftId, giftId);
      assert.equal(item.name, name);
      assert.equal(item.usable, usable);
      assert.equal(item.source.id, transferId);
      assert.equal(item.source.note, "花园里挑的");
      const sources = gardenGiftSources(f.runtime, cat.id);
      assert.equal(sources.length, 1);
      assert.ok(sources[0].text.includes(name));
      assert.ok(!sources[0].text.includes(item.source.note));
      for (const slot of [1, 3, 4, 16]) {
        f.act(cat, { kind: "display_gift", itemId, slot, publishNote: true });
        assert.deepEqual(
          f.role(cat).shelf.map((row) => ({ ...row })),
          [{ slot, giftId, name, description: "", note: "花园里挑的" }],
        );
      }
      const use = () => f.act(cat, { kind: "use_gift", itemId });
      if (usable) {
        use();
        assert.deepEqual(f.role(cat).items, []);
        assert.deepEqual(f.role(cat).shelf, []);
      } else {
        assert.throws(use, /GARDEN_ITEM_NOT_USABLE/);
        assert.equal(f.role(cat).items[0].id, itemId);
      }
    });
});

test("daily shared budgets, invalid recipient and failures do not spend stock or turn actions", (t) => {
  const f = fixture(t, {
    balance: 48,
    limits: { total: 30, roles: { [cat.id]: 30, [rabbit.id]: 30 } },
  });
  assert.throws(
    () =>
      f.act(
        cat,
        f.buy("pressed-bookmark", 24, { kind: "agent", id: "missing" }),
      ),
    /GARDEN_RECIPIENT_UNAVAILABLE/,
  );
  assert.equal(f.garden.turnUsed(cat.id, cat.turnId), 0);
  f.act(cat, f.buy("pressed-bookmark", 24, admin, "送给管理员"));
  assert.equal(f.view().personalGifts.received[0].note, "送给管理员");
  assert.equal(f.role(cat).budget.used, 24);
  assert.equal(f.role(rabbit).budget.remaining, 30);
  assert.equal(f.role(rabbit).budget.available, 6);
  assert.throws(
    () => f.act(rabbit, f.buy("yarn-ball", 18)),
    /GARDEN_GIFT_BUDGET_LOW/,
  );
  assert.equal(f.garden.turnUsed(rabbit.id, rabbit.turnId), 0);
  assert.equal(
    f.view().event.giftOffers.find((row) => row.giftId === "yarn-ball").stock,
    1,
  );
  const state = f.garden.requireState();
  state.settings.giftBudgets.roles[cat.id] = 12;
  f.garden.configure(0, state.settingsRevision, state.settings);
  assert.equal(f.role(cat).budget.used, 24);
  assert.equal(f.role(cat).budget.remaining, 0);
  const stale = f.buy("pressed-bookmark", 24, admin);
  f.advance(DAY);
  assert.equal(f.role(cat).budget.used, 0);
  assert.throws(() => f.act(rabbit, stale), /GARDEN_EVENT_EXPIRED/);
  f.act(rabbit, f.buy("pressed-bookmark", 24, admin));
  assert.equal(f.view().balance, 0);
  assert.throws(
    () => f.act(admin, f.buy("yarn-ball", 18)),
    /GARDEN_BALANCE_LOW/,
  );
});

test("opening a three-slot gift database preserves transfers and expands its constrained slots", (t) => {
  const file = path.join(temp(t), "legacy.sqlite");
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    CREATE TABLE garden_items (
      id TEXT PRIMARY KEY, gift_id TEXT, name TEXT, usable INTEGER, owner TEXT, consumed INTEGER,
      source_id TEXT, slot INTEGER CHECK (slot BETWEEN 1 AND 3), description TEXT, public_note TEXT,
      UNIQUE(owner,slot)
    );
    CREATE TABLE garden_item_transfers (
      id TEXT PRIMARY KEY, item_id TEXT REFERENCES garden_items(id), gift_id TEXT, name TEXT,
      giver TEXT, recipient TEXT, value TEXT, at INTEGER
    );
    CREATE INDEX garden_items_owned ON garden_items(owner,consumed);
    CREATE INDEX garden_item_received ON garden_item_transfers(recipient);
    CREATE INDEX garden_item_sent ON garden_item_transfers(giver);
    INSERT INTO garden_items VALUES ('gift','yarn-ball','毛线球',0,'owner',0,'transfer',3,'窗边','赠言');
    INSERT INTO garden_item_transfers VALUES ('transfer','gift','yarn-ball','毛线球','giver','owner','{}',1);
  `);
  legacy.close();
  for (const slot of [3, 16]) {
    const store = new MemoryStore(file);
    try {
      const { db } = store;
      assert.deepEqual(
        {
          ...db
            .prepare(
              "SELECT slot,description,public_note,source_id FROM garden_items",
            )
            .get(),
        },
        {
          slot,
          description: "窗边",
          public_note: "赠言",
          source_id: "transfer",
        },
      );
      assert.equal(
        db
          .prepare(
            "SELECT item_id FROM garden_item_transfers WHERE id='transfer'",
          )
          .get().item_id,
        "gift",
      );
      db.exec("UPDATE garden_items SET slot=16");
      assert.throws(() => db.exec("UPDATE garden_items SET slot=17"), /CHECK/);
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      store.close();
    }
  }
});

test("backup restores private shelf, budget and replay, while an identity replacement has no old items or gift citations", async (t) => {
  const root = temp(t);
  const file = path.join(root, "garden-gifts.sqlite");
  const f = fixture(t, { file });
  const buy = f.buy("pressed-bookmark", 24, cat, "仅收件人可见");
  const receipt = f.act(rabbit, buy, "bookmarked-request");
  f.act(cat, { kind: "display_gift", itemId: receipt.itemId, slot: 3 });
  const copy = path.join(root, "garden-restored.sqlite");
  await backupDatabase(file, copy);
  const restored = new MemoryStore(copy);
  t.after(() => restored.close());
  const garden = new GardenService(restored);
  const asRabbit = f.people[1];
  assert.equal(
    garden.gifts.budget(1, f.owner(rabbit), garden.requireState()).used,
    24,
  );
  assert.equal(garden.gifts.shelfFor(f.owner(cat))[0].slot, 3);
  assert.equal(
    garden.act(
      0,
      rabbit,
      { requestId: "bookmarked-request", action: buy },
      undefined,
      undefined,
      { owner: asRabbit, recipient: () => f.people[0] },
    ).replayed,
    true,
  );
  f.people[0].name = "新名字";
  assert.equal(f.role(cat).items[0].id, receipt.itemId);
  const exportFor = (id) =>
    withExport(f.store, id, async ({ path }) =>
      JSON.parse(await readFile(path, "utf8")),
    );
  const catExport = await exportFor(cat.id);
  assert.equal(
    catExport.tables.events.filter((row) => row.kind === "garden.item_gift")
      .length,
    1,
  );
  assert.ok(!JSON.stringify(catExport).includes("仅收件人可见"));
  assert.equal(
    (await exportFor(rabbit.id)).tables.events.filter(
      (row) => row.kind === "garden.item_gift",
    ).length,
    0,
  );
  f.people[0].generation = randomUUID();
  f.store.db
    .prepare("UPDATE home_identities SET generation=? WHERE agent_id=?")
    .run(f.people[0].generation, cat.id);
  assert.equal(f.role(cat).items.length, 0);
  assert.equal(f.role(cat).budget.limit, 0);
  assert.deepEqual(gardenGiftSources(f.runtime, cat.id), []);
  assert.deepEqual(f.garden.gifts.shelfFor(f.owner(cat)), []);
  assert.equal(
    (await exportFor(cat.id)).tables.events.filter(
      (row) => row.kind === "garden.item_gift",
    ).length,
    0,
  );
});

test("a failed purchase receipt rolls back wallet, stock, item, role citation and turn usage", (t) => {
  const f = fixture(t);
  const buy = f.buy("pressed-bookmark", 24, cat, "尚未成交");
  f.store.db.exec(`CREATE TRIGGER fail_receipt BEFORE INSERT ON garden_actions
    WHEN NEW.request_id='purchase-rollback' BEGIN SELECT RAISE(ABORT,'receipt cannot be saved'); END;`);
  assert.throws(
    () => f.act(rabbit, buy, "purchase-rollback"),
    /receipt cannot be saved/,
  );
  assert.equal(f.view().balance, 100);
  assert.equal(f.role(rabbit).budget.used, 0);
  assert.equal(f.garden.turnUsed(rabbit.id, rabbit.turnId), 0);
  assert.equal(
    f.view().event.giftOffers.find((row) => row.giftId === "pressed-bookmark")
      .stock,
    2,
  );
  assert.deepEqual(f.role(cat).items, []);
  assert.deepEqual(gardenGiftSources(f.runtime, cat.id), []);
  f.store.db.exec("DROP TRIGGER fail_receipt");
  assert.equal(f.act(rabbit, buy, "purchase-rollback").balance, 76);
});

test("a normal subject turn discovers the market and gift actions while room visitors see only permitted displays", async (t) => {
  const cfg = config(2);
  cfg.agents[0].subject.enabled = true;
  cfg.agents[0].home = { enabled: true, publishing: true };
  const runs = [];
  let direct;
  const { runtime } = runtimeFixture(t, {
    cfg,
    run: async ({ callTool, tools }) => {
      runs.push(
        (async () => {
          assert.ok(tools.some((tool) => tool.name === "garden_act"));
          const state = await callTool("garden_read", {});
          assert.equal(state.personalGifts.budget.available, 30);
          assert.ok(Object.hasOwn(state.giftActions, "buy_gift"));
          const quote = state.event.giftOffers.find(
            (item) => item.giftId === "catnip-candy",
          );
          direct = await callTool("garden_act", {
            kind: "buy_gift",
            requestId: "subject-direct-candy",
            args: {
              eventId: state.event.id,
              giftId: quote.giftId,
              price: quote.price,
              recipient: { kind: "admin", id: admin.id },
              note: "主动挑的糖",
            },
          });
          const inventory = (await callTool("garden_read", { view: "gifts" }))
            .personalGifts;
          assert.equal(inventory.sent[0].note, "主动挑的糖");
          assert.equal(inventory.received[0].note, "留在房间的纸条");
          await callTool("garden_act", {
            kind: "display_gift",
            requestId: "subject-display-fish",
            args: {
              itemId: inventory.items[0].id,
              slot: 2,
              description: "主人公开说明",
            },
          });
        })(),
      );
      await runs.at(-1);
    },
  });
  const garden = runtime.home.garden;
  const settings = defaultGardenSettings();
  settings.weather = fixedWeather();
  settings.events.rate = 1;
  for (const [key, entry] of Object.entries(settings.events.entries))
    entry.enabled = key === "merchant";
  settings.events.entries.merchant.effect.giftOffers = [
    { giftId: "dried-fish", stock: 2 },
    { giftId: "catnip-candy", stock: 2 },
  ];
  settings.roles[cat.id] = runtime.home.generation(cat.id);
  settings.giftBudgets = { total: 60, roles: { [cat.id]: 30 } };
  settings.giftBudgetGenerations[cat.id] = settings.roles[cat.id];
  garden.initialize(runtime.now(), settings);
  garden.desktopSync(runtime.now(), 60_000);
  const event = garden.read(runtime.now()).event;
  const fish = performGardenAction(runtime, admin, {
    requestId: "admin-fish-for-subject",
    action: {
      kind: "buy_gift",
      eventId: event.id,
      giftId: "dried-fish",
      price: 12,
      recipient: { kind: "agent", id: cat.id },
      note: "留在房间的纸条",
    },
  });
  const memory = runtime.memory.bind(cat.id);
  memory.setState("@subject", {
    ...memory.state("@subject"),
    disclosureTaint: [
      "context:private:30000",
      "context:group:20000",
      "operations:fixture",
    ],
  });
  await runtime.wake(cat.id, "@subject");
  assert.equal(runs.length, 1);
  await runs[0];
  assert.equal(direct.recipient.id, admin.id);
  assert.equal(direct.name, "薄荷糖罐");
  assert.equal(
    adminGardenView(runtime).personalGifts.received[0].note,
    "主动挑的糖",
  );
  const token = randomUUID();
  const server = createServer({ runtime, token, allowLive: true });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${await server.listen()}`;
  const request = (id, authorized = true) =>
    fetch(`${base}/api/home/content?agentId=${id}`, {
      headers: authorized
        ? { "x-admin-token": token, connection: "close" }
        : { connection: "close" },
    });
  assert.equal((await request(cat.id, false)).status, 401);
  const shelf = (await (await request(cat.id)).json()).giftShelf;
  assert.deepEqual(shelf, [
    {
      slot: 2,
      giftId: "dried-fish",
      name: "小鱼干",
      description: "主人公开说明",
      note: "",
    },
  ]);
  assert.ok(!JSON.stringify(shelf).includes(fish.itemId));
  assert.deepEqual((await (await request(rabbit.id)).json()).giftShelf, []);
  runtime.agent(cat.id).home.publishing = false;
  assert.deepEqual((await (await request(cat.id)).json()).giftShelf, []);
  assert.ok(
    [...runtime.transports.values()].every(
      (transport) => !transport.sent.length,
    ),
  );
});
