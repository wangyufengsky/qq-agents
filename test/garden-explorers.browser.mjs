/* global window */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { chromium } from "playwright-core";
import { HOUR, defaultGardenSettings } from "../src/home/garden-rules.mjs";
import { createServer } from "../src/server.mjs";
import { performGardenAction } from "../src/home/garden-console.mjs";
import { fixedWeather } from "./garden-fixtures.mjs";
import { config, fixture } from "./helpers.mjs";

async function openGarden(t, runtime) {
  const executablePath = process.env.QQ_TEST_GARDEN_BROWSER;
  assert.ok(
    executablePath,
    "Set QQ_TEST_GARDEN_BROWSER to a Chromium executable",
  );
  const token = randomUUID();
  const server = createServer({ runtime, token, allowLive: true });
  t.after(() => server.close());
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 375, height: 850 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.gardenRattleCount = 0;
    const create = window.AudioContext.prototype.createOscillator;
    window.AudioContext.prototype.createOscillator = function () {
      window.gardenRattleCount++;
      return create.call(this);
    };
  });
  await page.goto(`http://127.0.0.1:${await server.listen()}/`);
  await page.locator("#token").fill(token);
  await page.locator("#login-button").click();
  await page.getByRole("button", { name: "花园", exact: true }).click();
  return { page, errors };
}

function explorerGarden(t, settings) {
  const { runtime } = fixture(t, { cfg: config(1) });
  const start = 1_800_000_000_000;
  const garden = runtime.home.garden;
  let now = start;
  runtime.clock = () => now;
  garden.initialize(now, settings);
  garden.syncClock(now, true);
  return {
    runtime,
    garden,
    act: (action) =>
      garden.act(
        now,
        { kind: "admin", id: "administrator" },
        {
          requestId: randomUUID(),
          action,
        },
      ),
    configure: () =>
      garden.configure(now, garden.requireState().settingsRevision, settings),
    advance: (hours) => {
      now += hours * HOUR;
      garden.syncClock(now, true);
    },
  };
}

test("explorer plants show time-of-day flower cards, play rattles, pop seeds and preserve a pressed leaf", async (t) => {
  const settings = defaultGardenSettings();
  settings.weather = fixedWeather("drizzle");
  settings.events.rate = 0;
  const cropIds = ["morning-glory", "rattle-pea", "balsam", "lambs-ear"];
  for (const id of cropIds) settings.crops[id].hours = 1;
  const garden = explorerGarden(t, settings);
  const plants = cropIds.map((cropId, i) =>
    garden.act({
      kind: "plant",
      plot: i + 1,
      cropId,
      buyPrice: settings.crops[cropId].seedPrice,
    }),
  );
  garden.advance(8);

  const { page, errors } = await openGarden(t, garden.runtime);
  const tile = (plot) => page.locator(`[data-plot="${plot}"]`);
  const detail = page.locator("[data-garden-inspector]");
  const journal = page.locator("[data-journal-body]");
  const refresh = () =>
    page.getByRole("button", { name: "刷新花园", exact: true }).click();
  await tile(1).getByText("早安牵牛", { exact: true }).waitFor();
  await tile(1)
    .locator(".garden-art-plant")
    .evaluate((img) => img.decode());
  await tile(1).getByText("花瓣舒展", { exact: true }).waitFor();
  const flowerCard = async (condition) => {
    await detail.getByRole("button", { name: "看这株 · 生长手帐" }).click();
    await journal.getByRole("button", { name: "查看单株花卡" }).click();
    const image = journal.getByRole("img", { name: condition });
    await image.waitFor({ timeout: 30000 });
    const png = await image.evaluate((canvas) => canvas.toDataURL());
    await journal.getByRole("button", { name: /返回花圃/ }).click();
    return png;
  };
  const morning = await flowerCard(/清晨花瓣舒展/);
  garden.advance(5);
  await refresh();
  await tile(1).getByText("花瓣卷起", { exact: true }).waitFor();
  const afternoon = await flowerCard(/花瓣轻轻卷起/);
  assert.notEqual(afternoon, morning);
  assert.equal(
    garden.garden.read(garden.runtime.now()).plots[0].plant.id,
    plants[0].plantId,
  );

  await tile(2).click();
  await detail.getByText(/轻晃豆荚.*嗒/).waitFor();
  await detail.getByRole("button", { name: "听豆荚", exact: true }).click();
  await page.waitForFunction(() => window.gardenRattleCount >= 2);
  await tile(3).click();
  await detail.getByRole("button", { name: "轻碰弹籽荚", exact: true }).click();
  await detail.getByText("果荚已弹过籽", { exact: true }).waitFor();
  assert.equal(
    await detail.getByRole("button", { name: "轻碰弹籽荚" }).count(),
    0,
  );
  assert.equal(garden.garden.read(garden.runtime.now()).mysterySeeds.count, 1);
  await tile(4).click();
  await detail.getByText("绒叶挂着细雨银珠", { exact: true }).waitFor();
  const leafShape = await detail.getByText(/叶形 · /).textContent();
  await detail.getByRole("button", { name: "收成", exact: true }).click();
  await tile(4).getByText("空地", { exact: true }).waitFor();
  await page
    .locator(".garden-nav")
    .getByRole("button", { name: "手作台", exact: true })
    .click();
  const recipe = page.locator(
    '[data-garden-recipe="craft-lambs-ear-bookmark"]',
  );
  await recipe.getByRole("button", { name: "制作", exact: true }).click();
  await page
    .locator("[data-garden-status]")
    .getByText(/绒耳叶压花书签已收入/)
    .waitFor();
  await page
    .locator(".garden-nav")
    .getByRole("button", { name: "我的物品", exact: true })
    .click();
  const item = page
    .locator('[data-garden-pane="items"] .garden-good')
    .filter({ hasText: "绒耳叶压花书签" });
  await item
    .locator('img[src$="/gift-wrapped.webp"]')
    .evaluate((img) => img.decode());
  await item.getByText("查看物品", { exact: true }).click();
  await item
    .getByText(leafShape.split(" · ").at(-1), { exact: false })
    .waitFor();
  assert.equal(
    await page
      .locator("#garden-page")
      .evaluate((node) => node.scrollWidth > node.clientWidth),
    false,
  );
  assert.deepEqual(errors, []);
});

test("all ten explorer stories expose working actions on the 375px garden", async (t) => {
  const settings = defaultGardenSettings();
  settings.events.rate = 1;
  settings.weather = fixedWeather("drizzle");
  const only = (selected) => {
    for (const [id, event] of Object.entries(settings.events.entries))
      event.weight = Number(id === selected);
  };
  only("pea-guess");
  const crops = [
    "rattle-pea",
    "morning-glory",
    "balsam",
    "lambs-ear",
    "tomato",
    "radish",
  ];
  for (const id of crops.slice(0, 4)) settings.crops[id].hours = 1;
  for (const id of crops.slice(4)) settings.crops[id].hours = 1000;
  const garden = explorerGarden(t, settings);
  for (const plot of [5, 6]) garden.act({ kind: "shelter", plot });
  const plants = crops.map((cropId, i) =>
    garden.act({
      kind: "plant",
      plot: i + 1,
      cropId,
      buyPrice: settings.crops[cropId].seedPrice,
    }),
  );
  garden.advance(32);
  const { page, errors } = await openGarden(t, garden.runtime);
  const tab = (name) =>
    page.locator(".garden-nav").getByRole("button", { name, exact: true });
  const refresh = async () => {
    await page.getByRole("button", { name: "刷新花园", exact: true }).click();
    await page
      .locator("[data-garden-status]")
      .getByText("花园已刷新")
      .waitFor();
  };
  const ticket = page.locator("[data-garden-ticket]");
  const click = (name) =>
    ticket
      .getByRole("button", { name, exact: typeof name === "string" })
      .click();
  const outcome = async (text) => {
    try {
      await ticket.getByText(text).waitFor({ timeout: 8000 });
    } catch (cause) {
      const rendered = await ticket.innerText();
      throw Error(`Missing explorer outcome ${text}: ${rendered}`, { cause });
    }
  };
  const next = async (id, heading) => {
    only(id);
    garden.configure();
    garden.advance(24);
    await refresh();
    await tab("今日事件").click();
    await ticket.getByRole("heading", { name: heading, exact: true }).waitFor();
  };
  const target = async (label, plot, after = label) => {
    const form = ticket.locator("form").filter({
      has: page.getByRole("button", {
        name: label,
        exact: typeof label === "string",
      }),
    });
    const select = form.locator("select");
    const choices = await select.locator("option").allTextContents();
    const position = choices.find((name) => name.startsWith(`第 ${plot} 块地`));
    assert.ok(position, `Plot ${plot} offered for ${label}`);
    await select.selectOption({ label: position });
    await click(after);
  };

  await tab("今日事件").click();
  await ticket.getByRole("heading", { name: "豆荚里住着几个" }).waitFor();
  await click("轻轻听一下");
  await outcome(/听见了嗒/);
  await click("猜 2 颗");
  await outcome("这次猜数记下了，等开荚再揭晓。");
  await click("打开豆荚");
  await outcome(/豆荚揭晓.*颗豆/);
  const peas = garden.act({
    kind: "harvest",
    plot: 1,
    plantId: plants[0].plantId,
  });
  assert.equal(peas.quantity, peas.peasPerPod * peas.podCount);

  await next("snail-silver-map", "蜗牛走过的银地图");
  await click("画下银地图");
  await outcome(/画下了从.*号地.*银线/);
  assert.equal(
    await ticket.getByRole("button", { name: /看第 .* 块地/ }).count(),
    2,
  );

  await next("bamboo-rain", "竹筒滴答");
  await target("引水到地里", 6);
  await outcome(/6 号地.*补了.*点水分/);
  await next("bamboo-rain", "竹筒滴答");
  await click("摆一个空罐");
  await outcome(/空罐接住了竹筒.*鼓点/);
  await page.waitForFunction(() => window.gardenRattleCount >= 5);

  await next("sparrow-sandbath", "麻雀沙浴场");
  await target("留出沙浴脚印", 8);
  await outcome(/8 号空地.*仍可以正常播种/);
  await click("看第 8 块地");
  await page
    .locator('[data-garden-detail="8"]')
    .getByRole("button", { name: "播种" })
    .waitFor();

  await next("balsam-dishes", "凤仙弹射赛");
  const beforePopping = garden.garden.read(garden.runtime.now()).mysterySeeds
    .count;
  await click("接到右边的碟子");
  await outcome(/凤仙把花籽弹到了.*公共仓收好了一袋种子/);
  assert.equal(
    garden.garden.read(garden.runtime.now()).mysterySeeds.count,
    beforePopping + 1,
  );

  await next("shadow-measure", "给影子量身高");
  await target("记录株影", 5);
  await outcome(/5 号地.*明日此时回来对照/);

  await next("boot-pond", "雨靴里的小池塘");
  await tab("花圃").click();
  await page
    .locator(".garden-followups")
    .filter({ hasText: /影子尺的次日对照.*昨天是.*今天同刻/ })
    .waitFor();
  await tab("今日事件").click();
  await click("放一只叶舟");
  await outcome(/船头暂时朝靴口/);
  garden.advance(1);
  await refresh();
  await click("来看叶舟");
  await outcome(/船头已从靴口转向靴尖/);

  await next("leaf-identity", "两张叶子谁是谁");
  const leaf = ticket.getByRole("button", { name: /^猜是/ });
  assert.equal(await leaf.count(), 2);
  await leaf.first().click();
  await outcome(/这张叶子来自 .*号地/);

  await next("windmill-search", "小风车找风");
  await target(/^插在 /, 2, "插在 2 号地旁");
  await outcome(/小风车在 2 号地旁转了起来/);
  await target(/^把风车挪到 /, 4, "把风车挪到 4 号地");
  await outcome(/小风车在 4 号地旁转了起来.*最快/);

  await next("doorstep-peas", "门口留一把豆");
  await click("包一把豆留在门口");
  await outcome(/门边放着一包响铃豌豆/);
  only("snail-silver-map");
  garden.configure();
  garden.advance(24);
  await refresh();
  await tab("花圃").click();
  const project = page.locator(".garden-explorer-project");
  await project.getByRole("button", { name: "在纸包上添画一粒豆" }).click();
  await project.getByText(/画着 1 粒圆豆/).waitFor();
  assert.equal(
    await project.getByRole("button", { name: "收下纸包里的豆种" }).count(),
    0,
  );

  const choose = (eventId, choiceId, extra) =>
    performGardenAction(
      garden.runtime,
      { kind: "agent", id: "agent-0", turnId: "explorer-browser-visit" },
      {
        requestId: randomUUID(),
        action: { kind: "choose_event", eventId, choiceId, ...extra },
      },
    );
  const day = garden.garden.read(garden.runtime.now()).day;
  const oldEvent = garden.garden.calendar.events.get(day - 1);
  choose(oldEvent.id, "take_peas");
  await next("doorstep-peas", "门口留一把豆");
  const newEvent = garden.garden.read(garden.runtime.now()).event;
  choose(newEvent.id, "leave_peas", { harvestId: peas.harvestId });
  await refresh();
  await click("收下纸包里的豆种");
  await outcome(/纸包拆开了.*响铃豌豆/);
  assert.equal(
    await page
      .locator("#garden-page")
      .evaluate((node) => node.scrollWidth > node.clientWidth),
    false,
  );
  assert.deepEqual(errors, []);
});
