import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createServer } from "../src/server.mjs";
import { toolSpecs } from "../src/tools/specs.mjs";
import { DAY, HOUR } from "../src/home/garden-rules.mjs";
import { config, fixture } from "./helpers.mjs";

const gardenBase = "/api/home-garden";

async function setup(t, run) {
  const cfg = config(2);
  cfg.desktopHome.enabled = true;
  for (const role of cfg.agents) role.subject.enabled = true;
  const { runtime } = fixture(t, { cfg, run });
  const { garden } = runtime.home;
  let now = 1_800_000_000_000;
  runtime.clock = () => now;
  const admin = randomUUID();
  const server = createServer({ runtime, token: admin, allowLive: true });
  t.after(() => server.close());
  const url = `http://127.0.0.1:${await server.listen()}`;
  const http = async (suffix = "", payload, token = admin) => {
    const response = await fetch(url + gardenBase + suffix, {
      method: payload === undefined ? "GET" : "POST",
      headers: { "x-admin-token": token, "content-type": "application/json" },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const act = async (action, requestId = randomUUID()) =>
    http("/act", { requestId, action });
  const modify = async (fn) => {
    const { body: state } = await http();
    fn(state.settings, state.roleIds);
    return http("/settings", {
      settings: state.settings,
      roleIds: state.roleIds,
      expectedRevision: state.settingsRevision,
    });
  };
  const startDesktop = () =>
    runtime.desktopVisits.command({
      client: randomUUID(),
      action: "sync",
      data: false,
    });
  const advance = (milliseconds) => {
    const end = now + milliseconds;
    while (now < end) {
      now = Math.min(now + 10_000, end);
      garden.desktopSync(now, 15_000);
    }
  };
  return { runtime, http, act, modify, startDesktop, advance };
}

test("administrator API initializes explicitly, hot-edits revisions and honors crop history and price changes", async (t) => {
  const f = await setup(t);
  assert.equal((await f.http("", undefined, "invalid")).status, 401);
  assert.equal(
    (await f.http("/initialize", { initialBalance: 0 }, "invalid")).status,
    401,
  );
  assert.equal((await f.http()).body.initialized, false);
  assert.equal(
    f.runtime
      .toolsFor(f.runtime.agent("agent-0"), "@subject")
      .includes("garden_read"),
    false,
  );
  const first = (await f.http("/initialize", { initialBalance: 0 })).body;
  assert.equal(first.balance, 0);
  assert.equal(first.plots.length, 9);
  assert.deepEqual(first.roleIds, []);
  assert.equal(
    (await f.http("/initialize", { initialBalance: 1000 })).body.balance,
    0,
  );
  assert.equal(
    (await f.act({ kind: "plant", plot: 1, cropId: "clover" })).body.error,
    "GARDEN_PAUSED",
  );
  f.startDesktop();
  assert.equal(
    (await f.act({ kind: "plant", plot: 1, cropId: "clover" })).status,
    200,
  );
  f.advance(HOUR);
  const edit = await f.modify((settings) => {
    settings.speed = 4;
    settings.initialBalance = 1;
    settings.crops.clover.hours = 2;
    settings.crops.clover.salePrice = 27;
    settings.crops["test-mint"] = {
      ...settings.crops.mint,
      name: "试种薄荷",
      hours: 1,
    };
    settings.crops.mint.enabled = false;
  });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  assert.equal(edit.body.settings.speed, 4);
  assert.equal(edit.body.settings.initialBalance, 0);
  assert.equal(edit.body.plots[0].plant.crop.hours, 24);
  assert.equal(edit.body.settings.crops["test-mint"].name, "试种薄荷");
  assert.equal(
    await f
      .http("/settings", {
        settings: first.settings,
        roleIds: [],
        expectedRevision: 0,
      })
      .then((r) => r.status),
    409,
  );
  assert.equal(
    (await f.act({ kind: "plant", plot: 2, cropId: "mint", buyPrice: 50 })).body
      .error,
    "GARDEN_SEED_UNAVAILABLE",
  );
  assert.equal(
    (await f.act({ kind: "plant", plot: 2, cropId: "clover" })).body.garden
      .plots[1].plant.crop.hours,
    2,
  );
  f.advance(HOUR / 2);
  const state = (await f.http()).body;
  assert.equal(state.clock, 3 * HOUR);
  assert.equal(state.plots[0].plant.status, "growing");
  assert.equal(state.plots[1].plant.status, "mature");
  const harvest = await f.act({
    kind: "harvest",
    plot: 2,
    plantId: state.plots[1].plant.id,
  });
  assert.equal(harvest.status, 200);
  const harvestId = harvest.body.receipt.harvestId;
  assert.equal(
    (await f.act({ kind: "sell", harvestId, quantity: 1, price: 25 })).status,
    409,
  );
  assert.equal(
    (await f.act({ kind: "sell", harvestId, quantity: 1, price: 27 })).body
      .garden.balance,
    27,
  );
  assert.equal(
    (
      await f.act({
        kind: "gift",
        harvestId,
        quantity: 1,
        recipient: { kind: "agent", id: "missing" },
      })
    ).body.error,
    "GARDEN_RECIPIENT_UNAVAILABLE",
  );
  assert.equal(
    (
      await f.modify((settings) => {
        settings.crops.clover.enabled = false;
      })
    ).status,
    400,
  );
  await f.runtime.pause("all", true);
  assert.equal((await f.http()).body.pauseReason, "GLOBAL_PAUSED");
  assert.equal(
    (await f.act({ kind: "plant", plot: 3, cropId: "clover" })).body.error,
    "GARDEN_PAUSED",
  );
});

test("administrator and authorized subject turns share care and harvest with stable declarations", async (t) => {
  let f;
  const runs = [];
  let mode = "deny";
  f = await setup(t, async ({ callTool, tools, prompt }) => {
    runs.push(
      (async () => {
        assert.ok(tools.some((tool) => tool.name === "garden_read"));
        if (mode === "deny") {
          await assert.rejects(
            () => callTool("garden_read", {}),
            /GARDEN_ROLE_UNAVAILABLE/,
          );
          return;
        }
        assert.match(prompt, /可以先用 garden_read/);
        const state = await callTool("garden_read", {});
        assert.equal(state.turnRemaining, 2);
        assert.equal(state.ledger, undefined);
        const invoke = (kind, args, requestId = randomUUID()) =>
          callTool("garden_act", { kind, args, requestId });
        if (mode === "harvest") {
          const item = state.priorities.find((row) => row.kind === "harvest");
          await invoke("harvest", { plot: item.plot, plantId: item.plantId });
          return;
        }
        assert.deepEqual(
          state.priorities.slice(0, 3).map((row) => row.kind),
          ["drought", "water", "harvest"],
        );
        for (const row of state.priorities.slice(0, 2))
          await invoke("water", { plot: row.plot, plantId: row.plantId });
        await assert.rejects(
          () => invoke("plant", { plot: 9, cropId: "clover" }),
          /GARDEN_TURN_LIMIT/,
        );
        assert.equal((await callTool("garden_read", {})).turnRemaining, 0);
        assert.equal(
          (
            await f.modify((_settings, grants) => {
              grants.splice(grants.indexOf("agent-0"), 1);
            })
          ).status,
          200,
        );
        await assert.rejects(
          () => callTool("garden_read", {}),
          /GARDEN_ROLE_UNAVAILABLE/,
        );
      })(),
    );
    await runs.at(-1);
  });
  await f.http("/initialize", { initialBalance: 1000 });
  const a = f.runtime.agent("agent-0");
  const declare = () => toolSpecs(f.runtime.toolsFor(a, "@subject"));
  const original = declare();
  assert.ok(original.some((tool) => tool.name === "garden_read"));
  assert.ok(
    !f.runtime
      .toolsFor(a, "private:30000")
      .some((n) => n.startsWith("garden_")),
  );
  await f.runtime.wake("agent-0", "@subject");
  assert.equal(runs.length, 1);
  await runs[0];
  f.startDesktop();
  const configured = await f.modify((settings, grants) => {
    settings.speed = 4;
    settings.crops.sunflower.dailyWater = 100;
    settings.crops.sunflower.hours = 100;
    settings.crops.mint.dailyWater = 55;
    settings.crops.mint.hours = 100;
    grants.push("agent-0", "agent-1");
  });
  assert.equal(configured.status, 200);
  assert.deepEqual(declare(), original);
  for (const [plot, cropId, buyPrice] of [
    [1, "sunflower", 60],
    [2, "mint", 50],
    [3, "clover", 0],
  ])
    assert.equal(
      (await f.act({ kind: "plant", plot, cropId, buyPrice })).status,
      200,
    );
  f.advance((25 * HOUR) / 4);
  mode = "care";
  await f.runtime.wake("agent-0", "@subject");
  assert.equal(runs.length, 2);
  await runs[1];
  assert.deepEqual(declare(), original);
  mode = "harvest";
  await f.runtime.wake("agent-1", "@subject");
  assert.equal(runs.length, 3);
  await runs[2];
  const { body: state } = await f.http();
  assert.deepEqual(
    state.activity.slice(0, 3).map((row) => [row.actor_id, row.action]),
    [
      ["agent-1", "harvest"],
      ["agent-0", "water"],
      ["agent-0", "water"],
    ],
  );
  assert.equal(state.plots[0].plant.water, 35);
  assert.equal(state.plots[2].plant, null);
  assert.equal(state.market[0].cropId, "clover");
  assert.equal(state.dayRemaining, DAY - HOUR);
});

test("a successful administrator action can be retried while the garden is paused", async (t) => {
  const f = await setup(t);
  await f.http("/initialize", { initialBalance: 1000 });
  f.startDesktop();
  const action = { kind: "plant", cropId: "clover", plot: 1 };
  const first = await f.act(action, "plant-before-pause");
  assert.equal(first.status, 200);
  await f.runtime.pause("all", true);
  const retry = await f.act(action, "plant-before-pause");
  assert.equal(retry.status, 200);
  assert.equal(retry.body.receipt.replayed, true);
  assert.equal(retry.body.receipt.plantId, first.body.receipt.plantId);
  assert.equal(retry.body.garden.activity.length, 1);
});
