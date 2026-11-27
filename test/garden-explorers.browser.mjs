/* global window */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { chromium } from "playwright-core";
import { DAY, HOUR, defaultGardenSettings } from "../src/home/garden-rules.mjs";
import { createServer } from "../src/server.mjs";
import {
  adminGardenView,
  performGardenAction,
} from "../src/home/garden-console.mjs";
import { fixedWeather } from "./garden-fixtures.mjs";
import { config, fixture } from "./helpers.mjs";

async function openGarden(t, runtime, mobile = false) {
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
  const page = await browser.newPage({
    viewport: { width: 375, height: 850 },
    ...(mobile && { isMobile: true, hasTouch: true, deviceScaleFactor: 2 }),
  });
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

test("second edition plants show both faces and harvest stages at 375px", async (t) => {
  const settings = defaultGardenSettings();
  settings.weather = fixedWeather("cloud");
  settings.events.rate = 0;
  const crops = ["perilla", "sweet-corn", "pocket-pumpkin", "pocket-pumpkin"];
  for (const crop of crops) settings.crops[crop].hours = 1;
  const garden = explorerGarden(t, settings);
  const plants = crops.map((cropId, index) =>
    garden.act({
      kind: "plant",
      plot: index + 1,
      cropId,
      buyPrice: settings.crops[cropId].seedPrice,
    }),
  );
  garden.advance(3);
  const { page, errors } = await openGarden(t, garden.runtime, true);
  const tab = (name) =>
    page.locator(".garden-nav").getByRole("button", { name, exact: true });
  const tile = (plot) => page.locator(`[data-plot="${plot}"]`);
  const detail = page.locator("[data-garden-inspector]");
  const harvest = () =>
    detail.getByRole("button", { name: "收成", exact: true }).click();

  await tile(1).getByText("晚霞紫苏", { exact: true }).waitFor();
  await tile(1)
    .locator('img[src$="/plant-seedling.webp"]')
    .evaluate((img) => img.decode());
  await detail.getByText(/叶面 .*脉/).waitFor();
  await detail.getByText(/叶背 .*色印/).waitFor();
  await detail.getByRole("button", { name: "看这株 · 生长手帐" }).click();
  const journal = page.locator("[data-journal-body]");
  await journal.getByRole("button", { name: "查看单株花卡" }).click();
  await journal
    .getByRole("img", { name: /正面是.*脉.*背面是.*色印/ })
    .waitFor({ timeout: 30000 });
  await journal.getByRole("button", { name: /返回花圃/ }).click();
  await harvest();
  await tile(1).getByText("空地", { exact: true }).waitFor();

  await tile(2).click();
  await detail.getByText(/第一穗正嫩/).waitFor();
  await harvest();
  await detail.getByText("已收 1 / 2 茬", { exact: true }).waitFor();
  assert.equal(
    garden.garden.read(garden.runtime.now()).plots[1].plant.id,
    plants[1].plantId,
  );
  await tile(3).click();
  await detail.getByText(/嫩瓜可以摘/).waitFor();
  await harvest();
  await tile(3).getByText("空地", { exact: true }).waitFor();

  garden.advance(27);
  await page.getByRole("button", { name: "刷新花园", exact: true }).click();
  await tile(2)
    .getByText(/第 2 茬.*干棒/)
    .waitFor();
  await tile(2).click();
  await detail.getByText(/第二穗已经干熟/).waitFor();
  await harvest();
  await tile(2).getByText("空地", { exact: true }).waitFor();
  await tile(4).click();
  await detail.getByText(/瓜皮已经变硬/).waitFor();
  await harvest();
  await tile(4).getByText("空地", { exact: true }).waitFor();

  await tab("公共仓库").click();
  const lots = page.locator(".garden-harvest");
  for (const trait of [/第 1 茬.*嫩棒/, /第 2 茬.*干棒/, /嫩瓜/, /硬壳/])
    await lots.filter({ hasText: trait }).waitFor();
  await tab("手作台").click();
  for (const [id, name, ingredient] of [
    ["craft-perilla-print", "晚霞紫苏叶拓", /叶面.*叶背/],
    ["craft-roasted-corn", "烤奶油甜玉米", /第 1 茬.*嫩棒/],
    ["craft-corn-rattle", "玉米沙锤", /第 2 茬.*干棒/],
    ["craft-pumpkin-lantern", "手刻南瓜灯", /硬壳/],
  ]) {
    const recipe = page.locator(`[data-garden-recipe="${id}"]`);
    assert.match(
      await recipe.locator('[name="harvestId"] option:checked').textContent(),
      ingredient,
    );
    await recipe.getByRole("button", { name: "制作", exact: true }).click();
    await page
      .locator("[data-garden-status]")
      .getByText(new RegExp(`${name}已收入`))
      .waitFor();
  }
  await tab("我的物品").click();
  const print = page
    .locator('[data-garden-pane="items"] .garden-good')
    .filter({ hasText: "晚霞紫苏叶拓" });
  await print
    .locator('img[src$="/gift-wrapped.webp"]')
    .evaluate((img) => img.decode());
  await print.getByText("查看物品", { exact: true }).click();
  await print.getByText(/叶面.*叶背/).waitFor();
  assert.equal(
    await page
      .locator("#garden-page")
      .evaluate((node) => node.scrollWidth > node.clientWidth),
    false,
  );
  assert.deepEqual(errors, []);
});

test("all ten second edition stories work for one person, with real ingredients and cross-day projects", async (t) => {
  const settings = defaultGardenSettings();
  settings.events.rate = 1;
  settings.initialBalance = 3000;
  settings.weather = fixedWeather("sun");
  const only = (selected) => {
    for (const [id, event] of Object.entries(settings.events.entries))
      event.weight = Number(id === selected);
  };
  only("half-perilla-cloth");
  const crops = [
    "perilla",
    "perilla",
    "sweet-corn",
    "pocket-pumpkin",
    "strawberry",
    "mint",
    "lambs-ear",
    "sunflower",
    "moonflower",
  ];
  for (const crop of [...crops, "radish"]) settings.crops[crop].hours = 1;
  settings.crops.strawberry.yield = 2;
  const garden = explorerGarden(t, settings);
  const plant = (cropId, plot) =>
    garden.act({
      kind: "plant",
      plot,
      cropId,
      buyPrice: settings.crops[cropId].seedPrice,
    });
  const plants = crops.map((cropId, index) => plant(cropId, index + 1));
  const harvest = (plot) =>
    garden.act({ kind: "harvest", plot, plantId: plants[plot - 1].plantId });
  garden.advance(3);
  const freshCorn = harvest(3).harvestId;
  const berries = harvest(5).harvestId;
  const mint = harvest(6).harvestId;
  const lamb = harvest(7).harvestId;
  const sun = harvest(8).harvestId;
  const moon = harvest(9).harvestId;
  const radish = plant("radish", 5);
  const prepareJam = () =>
    performGardenAction(
      garden.runtime,
      { kind: "admin", id: "administrator" },
      {
        requestId: randomUUID(),
        action: {
          kind: "craft_gift",
          recipeId: "craft-strawberry-jam",
          harvestIds: [berries],
          price: 12,
        },
      },
    ).itemId;
  const firstJam = prepareJam();
  const secondJam = prepareJam();
  garden.advance(29);
  const driedCorn = harvest(3).harvestId;
  const pumpkin = harvest(4).harvestId;
  const roots = garden.act({
    kind: "harvest",
    plot: 5,
    plantId: radish.plantId,
  }).harvestId;

  const { page, errors } = await openGarden(t, garden.runtime, true);
  page.setDefaultTimeout(10000);
  const ticket = page.locator("[data-garden-ticket]");
  const tab = (name) =>
    page.locator(".garden-nav").getByRole("button", { name, exact: true });
  const view = () => adminGardenView(garden.runtime);
  const refresh = async () => {
    await page.getByRole("button", { name: "刷新花园", exact: true }).click();
    await page
      .locator("[data-garden-status]")
      .getByText("花园已刷新")
      .waitFor();
  };
  const storyName = (id) => settings.events.entries[id].name;
  const next = async (id) => {
    only(id);
    garden.configure();
    garden.advance(24);
    await refresh();
    await tab("今日事件").click();
    await ticket
      .getByRole("heading", { name: storyName(id), exact: true })
      .waitFor();
  };
  const projectScope = (name) =>
    page.locator(".garden-explorer-project").filter({
      has: page.getByRole("heading", { name, exact: true }),
    });
  const choose = async (choiceId, fields = {}, projectName) => {
    const { text, ...target } = fields;
    const state = view();
    const actions = projectName
      ? state.gardenProjects.find(({ name }) => name === projectName).actions
      : state.eventActions;
    const index = actions.findIndex(
      ({ args }) =>
        args.choiceId === choiceId &&
        Object.entries(target).every(([key, value]) => args[key] === value),
    );
    assert.ok(index >= 0, `Missing ${choiceId} for ${JSON.stringify(target)}`);
    const action = actions[index];
    const scope = projectName ? projectScope(projectName) : ticket;
    const direct = scope.locator(`[data-garden-event-index="${index}"]`);
    const form = scope.locator(
      `form[data-garden-choice]:has([value="${index}"])`,
    );
    const isForm = (await form.count()) > 0;
    if (isForm) {
      const select = form.locator("select");
      if (await select.count()) await select.selectOption(String(index));
      if (text !== undefined) await form.getByRole("textbox").fill(text);
    }
    const response = page.waitForResponse((entry) =>
      entry.url().endsWith("/api/home-garden/act"),
    );
    await (
      isForm
        ? form.getByRole("button", { name: action.label, exact: true })
        : direct
    ).click();
    const reply = await response;
    assert.equal(reply.status(), 200, await reply.text());
    await page
      .locator("#garden-page[aria-busy]")
      .waitFor({ state: "detached" });
    return (await reply.json()).receipt;
  };

  await tab("今日事件").click();
  await ticket
    .getByRole("heading", { name: storyName("half-perilla-cloth") })
    .waitFor();
  await choose("leave-half", { plot: 1 });
  await ticket.getByText(/另半边留给后来者/).waitFor();

  await next("first-popcorn");
  await tab("花圃").click();
  await choose("finish-cloth", { plot: 2 }, storyName("half-perilla-cloth"));
  await page
    .locator("[data-garden-status]")
    .getByText(/一张方巾印好了/)
    .waitFor();
  await tab("今日事件").click();
  await choose("pop_corn", { harvestId: driedCorn });
  await choose("name_pop", { text: "云边一声啪" });
  await ticket.getByText(/云边一声啪/).waitFor();
  await choose("taste_pop");
  await ticket.getByText(/捏起一粒热爆米花/).waitFor();

  await next("pumpkin-face");
  await choose("carve-eyes", { harvestId: pumpkin });
  await choose("carve-mouth");
  await choose("light-lamp");
  await ticket.getByText(/有眼睛和嘴巴的南瓜灯点亮了/).waitFor();
  const lamp = view().personalGifts.items.find(
    ({ giftId }) => giftId === "pumpkin-lantern",
  );
  assert.ok(lamp);

  await next("last-spoon-jam");
  await choose("leave-spoon", { itemId: secondJam });
  await ticket.getByText(/最后一勺留在桌上/).waitFor();
  assert.equal(
    view().personalGifts.items.some(({ id }) => id === firstJam),
    true,
  );
  assert.equal(
    view().personalGifts.items.some(({ id }) => id === secondJam),
    false,
  );

  await next("wobbly-bench");
  await tab("花圃").click();
  await choose("taste-spoon", {}, storyName("last-spoon-jam"));
  await page
    .locator("[data-garden-status]")
    .getByText(/最后一勺果酱抹到了面包上/)
    .waitFor();
  await tab("今日事件").click();
  await choose("prop_pot");
  await choose("sit_bench");
  await ticket.getByText(/陶盆.*号地/).waitFor();

  await next("melting-mint-ice");
  await choose("freeze_mint", { harvestId: mint });
  await choose("sip_mint");
  await ticket.getByText(/桌上还留着 2 杯/).waitFor();

  await next("nest-materials");
  await choose("weave-edge", { harvestId: freshCorn });
  await choose("weave-edge", { harvestId: lamb });
  await ticket.getByText(/巢缘添上了绒耳草/).waitFor();

  await next("mixed-menu");
  await tab("花圃").click();
  await page
    .locator(".garden-followups")
    .filter({ hasText: /织巢的边编好了.*玉米衣.*绒耳叶/ })
    .waitFor();
  await tab("今日事件").click();
  await choose("cook_dish", { harvestId: roots });
  await choose("guess_dish", { cropId: "radish" });
  await ticket.getByText(/今天用的是樱桃小萝卜/).waitFor();
  await choose("name_dish", { text: "带 <叶> 的小菜" });
  await ticket.getByText(/带 <叶> 的小菜/).waitFor();
  assert.equal(await ticket.locator("叶").count(), 0);

  await next("exchange-color");
  await choose("mix-color", { harvestId: sun });
  await ticket.getByText(/向日葵黄/).waitFor();

  await next("last-window-lamp");
  await tab("花圃").click();
  await choose("mix-color", { harvestId: moon }, storyName("exchange-color"));
  await page
    .locator("[data-garden-status]")
    .getByText(/色样卡上并排留着/)
    .waitFor();
  await tab("今日事件").click();
  await choose("lend-lamp", { itemId: lamp.id });
  await tab("我的物品").click();
  const lampCard = page
    .locator('[data-garden-pane="items"] .garden-good')
    .filter({ hasText: lamp.name });
  await lampCard.getByText("查看物品", { exact: true }).click();
  await lampCard.getByText("窗边借用中，明早归还。", { exact: true }).waitFor();

  await next("wobbly-bench");
  const returned = view().personalGifts.items.find(({ id }) => id === lamp.id);
  assert.ok(returned);
  assert.equal(returned.loaned, undefined);
  await tab("花圃").click();
  await page
    .locator(".garden-followups")
    .filter({ hasText: /南瓜灯|窗边/ })
    .waitFor();
  assert.equal(
    await page
      .locator("#garden-page")
      .evaluate((node) => node.scrollWidth > node.clientWidth),
    false,
  );
  assert.deepEqual(errors, []);
});

test("third edition plants show real stages and remember the same opening neighbors at 375px", async (t) => {
  const settings = defaultGardenSettings();
  settings.weather = fixedWeather();
  settings.events.rate = 0;
  const crops = ["drift-gourd", "paper-moon", "echo-tuberose", "sunflower"];
  for (const crop of crops) settings.crops[crop].hours = 1;
  const garden = explorerGarden(t, settings);
  // Discovery is covered by the garden rule tests. Seed this fixture so it can check the actual renderer.
  garden.garden.db
    .prepare("UPDATE garden_state SET seeds=? WHERE id=1")
    .run(JSON.stringify({ "echo-tuberose": 1 }));
  const plant = (cropId, plot) =>
    garden.act({
      kind: "plant",
      plot,
      cropId,
      buyPrice: settings.crops[cropId].seedPrice,
    });
  plant("drift-gourd", 1);
  plant("paper-moon", 2);
  const neighbor = plant("sunflower", 5);
  plant("echo-tuberose", 4);
  garden.advance(3);
  const { page, errors } = await openGarden(t, garden.runtime, true);
  const tab = (name) =>
    page.locator(".garden-nav").getByRole("button", { name, exact: true });
  const tile = (plot) => page.locator(`[data-plot="${plot}"]`);
  const detail = page.locator("[data-garden-inspector]");
  const refresh = () =>
    page.getByRole("button", { name: "刷新花园", exact: true }).click();
  await tile(1).getByText("嫩葫芦", { exact: true }).waitFor();
  await tile(2).getByText("正开花", { exact: true }).waitFor();
  await tile(2)
    .locator('img[src$="/plant-seedling.webp"]')
    .evaluate((image) => image.decode());
  await tile(4).click();
  const remembered = detail.locator(".garden-echo-neighbors");
  await remembered.getByText("第 5 块地 · 向日葵", { exact: true }).waitFor();
  garden.act({ kind: "harvest", plot: 5, plantId: neighbor.plantId });
  plant("radish", 5);
  garden.advance(13);
  await refresh();
  await tile(2).getByText("青荚", { exact: true }).waitFor();
  await remembered.getByText("第 5 块地 · 向日葵", { exact: true }).waitFor();
  await detail.getByRole("button", { name: "看这株 · 生长手帐" }).click();
  const journal = page.locator("[data-journal-body]");
  await journal.getByRole("button", { name: "查看单株花卡" }).click();
  await journal
    .getByRole("img", { name: /初开时.*5 号地的向日葵/ })
    .waitFor({ timeout: 30000 });
  await journal.getByRole("button", { name: /返回花圃/ }).click();

  garden.advance(13);
  await refresh();
  await tile(1).getByText("可漂流", { exact: true }).waitFor();
  await tile(2).getByText("银荚", { exact: true }).waitFor();
  for (const plot of [1, 2]) {
    await tile(plot).click();
    await detail.getByRole("button", { name: "收成", exact: true }).click();
    await tile(plot).getByText("空地", { exact: true }).waitFor();
  }
  await tab("公共仓库").click();
  await page
    .locator(".garden-harvest")
    .filter({ hasText: /漂流葫芦.*可漂流/ })
    .waitFor();
  await page
    .locator(".garden-harvest")
    .filter({ hasText: /纸月花.*银荚/ })
    .waitFor();
  await tab("手作台").click();
  const string = page.locator('[data-garden-recipe="craft-paper-moon-string"]');
  assert.match(
    await string.locator('[name="harvestId"] option:checked').textContent(),
    /纸月花.*银荚/,
  );
  await string.getByRole("button", { name: "制作", exact: true }).click();
  await page
    .locator("[data-garden-status]")
    .getByText(/纸月串已收入/)
    .waitFor();
  await tab("我的物品").click();
  const item = page
    .locator('[data-garden-pane="items"] .garden-good')
    .filter({ hasText: "纸月串" });
  await item
    .locator('img[src$="/gift-wrapped.webp"]')
    .evaluate((image) => image.decode());
  assert.equal(
    await page
      .locator("#garden-page")
      .evaluate((node) => node.scrollWidth > node.clientWidth),
    false,
  );
  assert.deepEqual(errors, []);
});

test("all ten third edition memory events support actual choices and safe cross-day history", async (t) => {
  const settings = defaultGardenSettings();
  settings.events.rate = 1;
  settings.initialBalance = 3500;
  settings.weather = fixedWeather("drizzle");
  const entry = (story) =>
    Object.entries(settings.events.entries).find(
      ([, value]) => value.effect.story === story,
    );
  const only = (story) => {
    const [selected] = entry(story);
    for (const [id, event] of Object.entries(settings.events.entries))
      event.weight = Number(id === selected);
  };
  only("old_sign");
  const crops = [
    "drift-gourd",
    "paper-moon",
    "sunflower",
    "rattle-pea",
    "pocket-pumpkin",
    "radish",
    "mint",
    "paper-moon",
  ];
  for (const crop of crops) settings.crops[crop].hours = 1;
  settings.crops.clover.hours = 1000;
  settings.crops.tomato.hours = 1000;
  const garden = explorerGarden(t, settings);
  const plant = (cropId, plot) =>
    garden.act({
      kind: "plant",
      plot,
      cropId,
      buyPrice: settings.crops[cropId].seedPrice,
    });
  const plants = crops.map((cropId, index) => plant(cropId, index + 1));
  const harvest = (plot) =>
    garden.act({ kind: "harvest", plot, plantId: plants[plot - 1].plantId });
  garden.advance(3);
  harvest(6);
  plant("clover", 6);
  garden.act({
    kind: "build_facility",
    facilityId: "weather_chime",
    price: 280,
  });
  garden.advance(29);
  const gourd = harvest(1).harvestId;
  const silver = harvest(2).harvestId;
  const pumpkin = harvest(5).harvestId;
  const threading = harvest(8).harvestId;
  const craft = (recipeId, harvestIds, price) =>
    performGardenAction(
      garden.runtime,
      { kind: "admin", id: "administrator" },
      {
        requestId: randomUUID(),
        action: { kind: "craft_gift", recipeId, harvestIds, price },
      },
    ).itemId;
  const lamp = craft("craft-pumpkin-lantern", [pumpkin], 14);
  const string = craft("craft-paper-moon-string", [threading], 12);
  const { page, errors } = await openGarden(t, garden.runtime, true);
  page.setDefaultTimeout(10000);
  const view = () => adminGardenView(garden.runtime);
  const tab = (name) =>
    page.locator(".garden-nav").getByRole("button", { name, exact: true });
  const ticket = page.locator("[data-garden-ticket]");
  const refresh = async () => {
    await page.getByRole("button", { name: "刷新花园", exact: true }).click();
    await page
      .locator("[data-garden-status]")
      .getByText("花园已刷新")
      .waitFor();
  };
  const next = async (story, hour = 8) => {
    only(story);
    garden.configure();
    const now = garden.garden.read(garden.runtime.now()).clock;
    garden.advance((DAY - (now % DAY)) / HOUR + hour);
    await refresh();
    await tab("今日事件").click();
    await ticket
      .getByRole("heading", { name: entry(story)[1].name, exact: true })
      .waitFor();
  };
  const choose = async (choiceId, fields = {}, { project, label } = {}) => {
    const { text, ...target } = fields;
    const current = view();
    const name = project && entry(project)[1].name;
    const actions = project
      ? current.gardenProjects.find((candidate) => candidate.name === name)
          .actions
      : current.eventActions;
    const index = actions.findIndex(
      ({ args }) =>
        args.choiceId === choiceId &&
        Object.entries(target).every(([key, value]) => args[key] === value),
    );
    assert.ok(index >= 0, `Missing ${choiceId} ${JSON.stringify(target)}`);
    const action = actions[index];
    const scope = project
      ? page
          .locator(".garden-explorer-project")
          .filter({ has: page.getByRole("heading", { name, exact: true }) })
      : ticket;
    const direct = scope.locator(`[data-garden-event-index="${index}"]`);
    const form = scope.locator(
      `form[data-garden-choice]:has([value="${index}"])`,
    );
    const filled = (await form.count()) > 0;
    if (filled) {
      const select = form.locator("select");
      if (await select.count()) {
        await select.selectOption(String(index));
        if (label)
          assert.match(
            await select.locator("option:checked").textContent(),
            label,
          );
      }
      if (text !== undefined) await form.getByRole("textbox").fill(text);
    }
    const response = page.waitForResponse((entry) =>
      entry.url().endsWith("/api/home-garden/act"),
    );
    await (
      filled
        ? form.getByRole("button", { name: action.label, exact: true })
        : direct
    ).click();
    const reply = await response;
    assert.equal(reply.status(), 200, await reply.text());
    assert.deepEqual(reply.request().postDataJSON().action, {
      kind: "choose_event",
      ...action.args,
      ...(text !== undefined && { text }),
    });
    await page
      .locator("#garden-page[aria-busy]")
      .waitFor({ state: "detached" });
    return (await reply.json()).receipt;
  };

  await tab("今日事件").click();
  await ticket
    .getByRole("heading", { name: entry("old_sign")[1].name })
    .waitFor();
  await choose("then_and_now", { plot: 6 });
  await ticket.getByText(/旧牌写着.*樱桃小萝卜.*今天.*野生三叶草/).waitFor();

  await next("old_photo");
  const photos = ticket.locator(".garden-photo-grid");
  await photos.first().waitFor();
  assert.deepEqual(
    await photos.evaluateAll((grids) =>
      grids.map((grid) => grid.children.length),
    ),
    [9, 9],
  );
  assert.equal(
    await photos
      .nth(1)
      .locator(".garden-photo-cell")
      .nth(0)
      .getByText("空地")
      .count(),
    1,
  );
  const old = view().eventActions.find(
    ({ args }) => args.choiceId === "compare-plot",
  );
  assert.ok(old?.args.referenceDay);
  await ticket
    .getByLabel("旧照日期")
    .selectOption(String(old.args.referenceDay));
  await photos
    .first()
    .getByRole("button", {
      name: new RegExp(
        `对照第 ${old.args.referenceDay} 天第 ${old.args.plot} 格`,
      ),
    })
    .waitFor();
  await choose("compare-plot", {
    referenceDay: old.args.referenceDay,
    plot: old.args.plot,
  });
  await ticket
    .getByRole("button", { name: "查看对照花卡", exact: true })
    .click();
  await ticket
    .locator("[data-garden-history-image]")
    .getByRole("img")
    .waitFor({ timeout: 30000 });

  await next("drift_gourd");
  await choose(
    "release-gourd",
    { harvestId: gourd },
    { label: /漂流葫芦.*可漂流/ },
  );
  await next("future_jar");
  const candidate = view().eventActions.find(
    ({ args }) => args.choiceId === "bury-rain",
  );
  assert.ok(candidate?.args.plot);
  await choose("bury-rain", { plot: candidate.args.plot });

  await next("group_photo");
  const watered = plant("tomato", 9);
  await refresh();
  await tab("花圃").click();
  await page.locator('[data-plot="9"]').click();
  await page
    .locator("[data-garden-inspector]")
    .getByRole("button", { name: "浇水", exact: true })
    .click();
  await page
    .locator("[data-garden-status]")
    .getByText(/浇水完成/)
    .waitFor();
  assert.equal(
    garden.garden.read(garden.runtime.now()).plots[8].plant.id,
    watered.plantId,
  );
  await tab("今日事件").click();
  await choose("photo_can");
  await ticket
    .getByText(/今天用过的水壶.*实际|今天用过的水壶.*照料者.*管理员/)
    .waitFor();

  await next("paper_shadow", 20);
  const shadow = view().eventActions.find(
    ({ args }) =>
      args.choiceId === "make-shadow-card" &&
      args.harvestId === silver &&
      args.itemId === lamp,
  );
  assert.ok(shadow?.args.plot);
  await choose(
    "make-shadow-card",
    { plot: shadow.args.plot, harvestId: silver, itemId: lamp },
    {
      label: /第 .* 块地.*手刻南瓜灯.*纸月花.*银荚/,
    },
  );
  assert.ok(view().personalGifts.items.some(({ id }) => id === lamp));

  await next("poem");
  const first = await ticket.locator(".garden-event-outcome").textContent();
  assert.ok(first);
  await choose("add_line", { text: "池边留下 <一片月光>" });
  await ticket
    .locator(".garden-event-outcome")
    .getByText(/池边留下 <一片月光>/)
    .waitFor();
  await choose("keep_poem");
  assert.equal(await ticket.locator("一片月光").count(), 0);
  await tab("花圃").click();
  await choose("cut-dipper", {}, { project: "drift_gourd" });
  assert.ok(
    view().personalGifts.items.some(({ giftId }) => giftId === "gourd-dipper"),
  );

  await next("wind_note");
  await choose("keep_tone", { plot: 4 });
  await ticket.getByText(/两声一起留下了/).waitFor();
  await tab("花圃").click();
  await choose("open-jar", {}, { project: "future_jar" });

  await next("seed_memory");
  await choose("turn_seed", { cropId: "radish" });
  await ticket.getByText(/第一次播在第 1 天的 6 号地/).waitFor();
  await next("gate_display");
  await choose("hang-keepsake", { itemId: string }, { label: /纸月串/ });
  assert.ok(view().personalGifts.items.some(({ id }) => id === string));
  await tab("历季园门").click();
  const gates = page.locator("[data-garden-pane=gate]");
  await gates.getByText(/第 .* 季 · 第 .* 天/).waitFor();
  assert.equal(await gates.getByText(string).count(), 0);
  assert.equal(
    await page
      .locator("#garden-page")
      .evaluate((node) => node.scrollWidth > node.clientWidth),
    false,
  );
  assert.deepEqual(errors, []);
});
