import { fixedWeather, keepNeutralWeather } from "./garden-fixtures.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { chromium } from "playwright-core";
import { createServer } from "../src/server.mjs";
import {
  defaultEvents,
  legacyEvents,
} from "../src/home/garden-event-rules.mjs";
import {
  performGardenAction,
  subjectGardenView,
} from "../src/home/garden-console.mjs";
import { DAY, defaultGardenSettings, HOUR } from "../src/home/garden-rules.mjs";
import { config, fixture } from "./helpers.mjs";

test("management console opens the garden, edits its catalog and trades from the grid", async (t) => {
  const executablePath = process.env.QQ_TEST_GARDEN_BROWSER;
  assert.ok(
    executablePath,
    "Set QQ_TEST_GARDEN_BROWSER to a Chromium executable",
  );
  const cfg = config(1);
  cfg.desktopHome.enabled = true;
  const { runtime } = fixture(t, { cfg });
  keepNeutralWeather(runtime.home.garden);
  let now = 1_800_000_000_000;
  runtime.clock = () => now;
  const admin = randomUUID();
  const server = createServer({ runtime, token: admin, allowLive: true });
  t.after(() => server.close());
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  const jsErrors = [];
  page.on("pageerror", (error) => jsErrors.push(error.message));
  await page.goto(`http://127.0.0.1:${await server.listen()}/`);
  await page.locator("#token").fill(admin);
  await page.locator("#login-button").click();
  await page.getByRole("button", { name: "花园", exact: true }).click();
  assert.deepEqual(jsErrors, []);
  await page.getByLabel("初始资金").fill("0");
  await page.getByRole("button", { name: "开园", exact: true }).click();
  await page.getByText("已开园", { exact: true }).waitFor();
  assert.equal(await page.locator(".garden-plot").count(), 9);
  assert.equal(
    await page
      .locator(".garden-workspace-head .garden-coins strong")
      .textContent(),
    "0",
  );
  assert.equal(await page.locator(".garden-grid button button").count(), 0);
  assert.equal(
    await page
      .locator(".garden-grid")
      .evaluate(
        (grid) =>
          grid.ownerDocument.defaultView
            .getComputedStyle(grid)
            .gridTemplateColumns.split(" ").length,
      ),
    3,
  );
  const board = page.locator('[data-garden-note="garden"]').locator("..");
  await board.locator("summary").click();
  const boardInput = board.getByLabel("园艺小黑板");
  await boardInput.fill("🌱".repeat(121));
  await board.getByRole("button", { name: "保存留言" }).click();
  await page.getByText("留言最多 120 字。", { exact: true }).waitFor();
  const noteText = "傍晚再来看 <蝴蝶>" + "🌱".repeat(110);
  assert.equal([...noteText].length, 120);
  await boardInput.fill(noteText);
  await board.getByRole("button", { name: "保存留言" }).click();
  await page
    .locator(".garden-note-text")
    .filter({ hasText: noteText })
    .waitFor();
  const map = await page.locator(".garden-grid").boundingBox();
  const rail = await page.locator(".garden-rail").boundingBox();
  assert.ok(rail.x >= map.x + map.width);
  await page.locator('[data-plot="4"]').click();
  assert.equal(
    await page.locator(".garden-inspector").getAttribute("data-garden-detail"),
    "4",
  );
  const noteContents = page.locator(".garden-note-text");
  const plotNote = page.locator('[data-garden-note="4"]').locator("..");
  await plotNote.locator("summary").click();
  await plotNote.getByLabel("地块便签").fill("这块地留作观察");
  await plotNote.getByRole("button", { name: "保存留言" }).click();
  await noteContents.filter({ hasText: "这块地留作观察" }).waitFor();
  await page.locator('[data-plot="1"]').click();
  assert.equal(await page.getByText("这块地留作观察").count(), 0);
  await page.locator('[data-plot="4"]').click();
  await noteContents.filter({ hasText: "这块地留作观察" }).waitFor();
  await plotNote.locator("summary").click();
  await plotNote.getByRole("button", { name: "清除留言" }).click();
  await page.getByText("留言已清除。", { exact: true }).waitFor();
  assert.equal(await page.getByText("这块地留作观察").count(), 0);
  await page.locator('[data-plot="1"]').click();
  await page.setViewportSize({ width: 375, height: 812 });
  const scrolls = await page
    .locator("#garden-page")
    .evaluate((view) => view.scrollWidth > view.clientWidth);
  assert.equal(scrolls, false);
  const { garden } = runtime.home;
  const firstPlot = page.locator('[data-plot="1"]');
  await page.waitForFunction(
    () =>
      Array.from(
        globalThis.document.querySelectorAll(".garden-art-soil"),
      ).filter((img) => img.complete && img.naturalWidth > 0).length === 9,
  );
  const seedling = "**/garden-art/plant-seedling.webp";
  await page.route(seedling, (route) => route.abort());
  const failedImage = page.waitForEvent("requestfailed", {
    predicate: (req) => req.url().endsWith("/plant-seedling.webp"),
  });
  const detail = page.locator(".garden-inspector");
  await detail.getByRole("button", { name: "播种" }).click();
  await failedImage;
  await firstPlot.locator(".garden-art-plant").waitFor({ state: "detached" });
  await page.unroute(seedling);
  await firstPlot.getByText("野生三叶草", { exact: true }).waitFor();
  const settings = page.locator("[data-garden-settings]");
  await page.getByRole("button", { name: "花园设置", exact: true }).click();
  await page.locator("summary").filter({ hasText: "花园设置" }).click();
  for (const field of [
    settings.getByLabel("全园速度倍率"),
    settings.getByLabel("花园继续运行"),
    settings.getByLabel("全园总额"),
    settings.locator("[data-crop-parent]"),
  ]) {
    const colors = await field.evaluate((control) => {
      const win = control.ownerDocument.defaultView;
      return {
        label: win.getComputedStyle(control.labels[0]).color,
        paperInk: win.getComputedStyle(control.closest(".garden-console-paper"))
          .color,
      };
    });
    assert.equal(colors.label, colors.paperInk);
  }
  await settings.getByLabel("全园速度倍率").fill("4");
  await settings.getByLabel("作物 ID").fill("test-clover");
  await settings.getByRole("button", { name: "新增作物" }).click();
  const newCrop = settings.locator('[data-crop="test-clover"]');
  const longName = "试种三叶草及其他耐旱多年生景观地被植物";
  await newCrop.getByLabel("名称", { exact: true }).fill(longName);
  await newCrop.getByLabel("高光照倍率", { exact: true }).fill("1.2");
  await newCrop
    .getByLabel("基础成熟时长（花园小时）", { exact: true })
    .fill("1");
  const hydrangea = settings.locator('[data-crop="hydrangea"]');
  await hydrangea.locator("summary").click();
  await hydrangea.getByLabel("种子单价").fill("0");
  await hydrangea.getByLabel("基础成熟时长（花园小时）").fill("1");
  await settings.getByLabel("角色0", { exact: true }).check();
  await settings.getByRole("button", { name: "保存花园设置" }).click();
  await page.getByText("设置已保存").waitFor();
  assert.equal(garden.read(now).settings.speed, 4);
  assert.equal(garden.read(now).settings.crops.tomato.maxHarvests, 3);
  assert.deepEqual(garden.read(now).settings.crops["test-clover"].lightRates, {
    high: 1.2,
  });
  await page.getByRole("button", { name: "花圃", exact: true }).click();
  const secondPlot = page.locator('[data-plot="2"]');
  await secondPlot.click();
  assert.equal(await secondPlot.getAttribute("aria-pressed"), "true");
  assert.equal(await firstPlot.getAttribute("aria-pressed"), "false");
  await detail.getByLabel("第 2 块的作物").selectOption("test-clover");
  await detail.getByRole("button", { name: "播种" }).click();
  await secondPlot.getByText(longName, { exact: true }).waitFor();
  await page.locator("#garden-page").evaluate((view) => {
    view.style.zoom = "125%";
  });
  const gridFits = await page.locator(".garden-grid").evaluate((grid) => {
    const bounds = grid.getBoundingClientRect();
    return (
      grid.scrollWidth === grid.clientWidth &&
      bounds.right <= grid.ownerDocument.documentElement.clientWidth
    );
  });
  assert.equal(gridFits, true);
  assert.equal(await secondPlot.locator(".garden-art-plant").count(), 0);
  await page.locator("#garden-page").evaluate((view) => {
    view.style.zoom = "";
  });
  now += HOUR / 4;
  await page.getByRole("button", { name: "刷新花园" }).click();
  await page.getByRole("button", { name: /第 2 块 · 可收成/ }).click();
  assert.equal(await detail.getAttribute("data-garden-detail"), "2");
  await detail.getByRole("button", { name: "收成" }).click();
  await page.getByText("收成完成", { exact: true }).waitFor();
  await page.getByRole("button", { name: "公共仓库", exact: true }).click();
  const lot = page.locator("[data-harvest]");
  const recipient = lot.getByLabel("送给");
  const send = lot.getByRole("button", { name: "赠送" });
  assert.equal(await recipient.inputValue(), "");
  assert.equal(await send.isDisabled(), true);
  assert.equal(
    await recipient.getByRole("option", { name: "管理员" }).count(),
    0,
  );
  await recipient.selectOption({ label: "角色0" });
  assert.equal(await send.isEnabled(), true);
  await recipient.selectOption("");
  assert.equal(await send.isDisabled(), true);
  await recipient.selectOption({ label: "角色0" });
  await send.click();
  await page
    .getByText(`已将 1 份${longName}送给角色0。`, { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "花园记录", exact: true }).click();
  await page.locator("summary").filter({ hasText: "赠礼记录" }).click();
  await page
    .getByText("管理员 送给 角色0 · " + longName, { exact: false })
    .waitFor();
  const journal = page.locator("[data-journal-body]");
  await journal.getByRole("heading", { name: "花园年表" }).waitFor();
  await journal.getByLabel("地块", { exact: true }).selectOption("2");
  await journal.getByLabel("记录", { exact: true }).selectOption("harvest");
  await journal.getByRole("button", { name: "筛选", exact: true }).click();
  await journal
    .getByRole("button", { name: longName + "手帐 ↗" })
    .first()
    .click();
  await journal.getByRole("heading", { name: longName + "的手帐" }).waitFor();
  const viewport = page.viewportSize();
  for (const width of [1440, 430]) {
    await page.setViewportSize({ ...viewport, width });
    const summary = journal.locator(".garden-digest");
    const box = await summary.boundingBox();
    const heading = await journal
      .getByRole("heading", { name: longName + "的手帐" })
      .boundingBox();
    const cardButton = await journal
      .getByRole("button", { name: "查看单株花卡" })
      .boundingBox();
    assert.ok(box.y >= heading.y + heading.height - 1);
    assert.ok(box.y + box.height <= cardButton.y + 1);
    assert.equal(
      await summary.evaluate(
        (node) =>
          node.ownerDocument.defaultView.getComputedStyle(node).position,
      ),
      "static",
    );
  }
  await page.setViewportSize(viewport);
  await journal.getByRole("button", { name: "查看单株花卡" }).click();
  await journal.locator("canvas[role=img]").waitFor({ timeout: 30000 });
  await journal
    .getByRole("button", { name: "返回花园年表", exact: false })
    .click();
  assert.equal(
    await journal.getByLabel("地块", { exact: true }).inputValue(),
    "2",
  );
  assert.equal(await lot.count(), 0);
  assert.equal(
    await firstPlot.getByText("野生三叶草", { exact: true }).count(),
    1,
  );
  await page.getByRole("button", { name: "花圃", exact: true }).click();
  await secondPlot.click();
  await detail.getByLabel("第 2 块的作物").selectOption("hydrangea");
  await detail.getByRole("button", { name: "播种" }).click();
  await secondPlot.getByText("蓝雨绣球", { exact: true }).waitFor();
  now += (2 * HOUR) / 4;
  await page.getByRole("button", { name: "刷新花园" }).click();
  await secondPlot.getByText("雾紫绣球", { exact: true }).waitFor();
  await secondPlot.getByText("开花", { exact: true }).waitFor();
  assert.equal(await secondPlot.locator(".garden-art-plant").count(), 0);
  await detail.getByRole("button", { name: "看这株 · 生长手帐" }).click();
  await journal.getByText(/雾紫绣球/).waitFor();
  await journal.getByRole("button", { name: "查看单株花卡" }).click();
  const variantCard = journal.locator("canvas[role=img]");
  await variantCard.waitFor({ timeout: 30000 });
  assert.match(await variantCard.getAttribute("aria-label"), /雾紫绣球/);
  assert.deepEqual(jsErrors, []);
});
test("weather form copies a variant, saves conditional weights, and previews exclusions and fallback", async (t) => {
  const executablePath = process.env.QQ_TEST_GARDEN_BROWSER;
  assert.ok(executablePath);
  const { runtime } = fixture(t, { cfg: config(1) });
  const garden = runtime.home.garden;
  keepNeutralWeather(garden);
  const token = randomUUID();
  const server = createServer({ runtime, token, allowLive: true });
  t.after(() => server.close());
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${await server.listen()}/`);
  await page.locator("#token").fill(token);
  await page.locator("#login-button").click();
  await page.getByRole("button", { name: "花园", exact: true }).click();
  await page.getByRole("button", { name: "开园", exact: true }).click();
  await page.getByText("已开园", { exact: true }).waitFor();
  await page.getByRole("button", { name: "花园设置", exact: true }).click();
  await page.locator("summary").filter({ hasText: "花园设置" }).click();
  await page.locator("summary").filter({ hasText: "天气池" }).click();
  const settings = page.locator("[data-garden-settings]");
  await settings.getByLabel("新天气 ID").fill("storm-test");
  await settings.getByLabel("复制天气").selectOption("storm");
  await settings.getByRole("button", { name: "复制为新天气" }).click();
  const row = settings.locator('[data-weather-entry="storm-test"]');
  await row.getByLabel("天气名称").fill("试配暴雨");
  await row.getByLabel("抽取权重").fill("4");
  const add = () => row.getByRole("button", { name: "新增条件" }).click();
  await add();
  await row.getByLabel("匹配天气").selectOption("kind:cloud");
  await add();
  const threshold = row.locator("[data-weather-condition]").last();
  await threshold.getByLabel("条件字段").selectOption("balance");
  await threshold.getByLabel("比较方式").selectOption("gt");
  await threshold.getByLabel("阈值").fill("300");
  await settings.getByRole("button", { name: "保存花园设置" }).click();
  await page.getByText("设置已保存", { exact: true }).waitFor();
  const state = garden.read(runtime.now());
  assert.equal(state.weather.kind, "cloud");
  assert.equal(state.weatherRevision, 0);
  assert.equal(state.settings.weather.entries["storm-test"].weight, 4);
  await page.locator("summary").filter({ hasText: "试配天气" }).click();
  const trial = page.locator("[data-garden-weather-trial]");
  await trial.getByLabel("模拟前一日天气").selectOption("cloud");
  await trial.getByLabel("模拟日初余额").fill("300");
  await trial.getByRole("button", { name: "计算天气概率" }).click();
  await trial.getByText(/多云.*100%.*兜底/).waitFor();
  await trial.getByText(/试配暴雨.*0%.*第 2 条/).waitFor();
  await trial.getByLabel("模拟日初余额").fill("301");
  await trial.getByRole("button", { name: "计算天气概率" }).click();
  await trial.getByText(/试配暴雨.*100%.*入池/).waitFor();
  assert.equal(garden.read(runtime.now()).weather.kind, "cloud");
  assert.deepEqual(errors, []);
  assert.equal(
    await page
      .locator("#garden-page")
      .evaluate((view) => view.scrollWidth > view.clientWidth),
    false,
  );
});
test("daily event form saves conditional variants, previews no event, and drives the live thief action", async (t) => {
  const executablePath = process.env.QQ_TEST_GARDEN_BROWSER;
  assert.ok(executablePath);
  const cfg = config(1);
  cfg.desktopHome.enabled = true;
  const { runtime } = fixture(t, { cfg });
  const garden = runtime.home.garden;
  keepNeutralWeather(garden);
  let now = 1_800_000_000_000;
  runtime.clock = () => now;
  const token = randomUUID();
  const server = createServer({ runtime, token, allowLive: true });
  t.after(() => server.close());
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${await server.listen()}/`);
  await page.locator("#token").fill(token);
  await page.locator("#login-button").click();
  await page.getByRole("button", { name: "花园", exact: true }).click();
  await page.getByRole("button", { name: "开园", exact: true }).click();
  await page.getByText("已开园", { exact: true }).waitFor();
  const form = page.locator("[data-garden-settings]");
  await page.getByRole("button", { name: "花园设置", exact: true }).click();
  await page.locator("summary").filter({ hasText: "花园设置" }).click();
  await page.locator("summary").filter({ hasText: "每日事件池" }).click();
  await form.getByLabel("每日事件触发率（0–1）").fill("1");
  for (const id of Object.keys(defaultGardenSettings().events.entries).filter(
    (id) => id !== "thief",
  )) {
    const row = form.locator(`[data-event-entry="${id}"]`);
    await row.locator("summary").click();
    await row.getByLabel("启用事件").uncheck();
  }
  await form.getByLabel("新事件 ID").fill("sunny-thief");
  await form.getByLabel("复制事件").selectOption("thief");
  await form.getByRole("button", { name: "新增事件", exact: true }).click();
  const copy = form.locator('[data-event-entry="sunny-thief"]');
  await copy.getByLabel("事件名称").fill("晴天小偷");
  await copy.getByRole("button", { name: "新增事件条件" }).click();
  await copy.getByLabel("匹配天气").selectOption("kind:sun");
  await form.getByRole("button", { name: "保存花园设置" }).click();
  await page.getByText("设置已保存", { exact: true }).waitFor();
  assert.equal(garden.read(now).event, null);
  assert.equal(
    garden.read(now).settings.events.entries["sunny-thief"].conditions[1].field,
    "today",
  );
  await page.locator("summary").filter({ hasText: "试配每日事件" }).click();
  const trial = page.locator("[data-garden-event-trial]");
  await trial.getByLabel("模拟当日天气").selectOption("cloud");
  await trial.getByLabel("模拟日初余额").fill("300");
  await trial.getByRole("button", { name: "计算事件概率" }).click();
  await trial.getByText(/无事件.*100%/).waitFor();
  await trial.getByLabel("模拟日初余额").fill("301");
  await trial.getByRole("button", { name: "计算事件概率" }).click();
  await trial.getByText(/小偷踩点.*100%.*入池/).waitFor();
  now += 24 * HOUR;
  await page.getByRole("button", { name: "刷新花园" }).click();
  await page.getByRole("button", { name: "今日事件", exact: true }).click();
  await page.getByRole("button", { name: "驱赶小偷", exact: true }).click();
  await page.getByText("小偷已被驱赶", { exact: true }).waitFor();
  assert.equal(garden.read(now).balance, 1015);
  assert.deepEqual(errors, []);
});

test("merchant shelf and gift delivery work at 430 px without exposing the note in shared records", async (t) => {
  const cfg = config(2);
  cfg.desktopHome.enabled = true;
  const { runtime } = fixture(t, { cfg });
  const { garden } = runtime.home;
  const settings = defaultGardenSettings();
  settings.weather = fixedWeather();
  settings.events.rate = 1;
  for (const [id, entry] of Object.entries(settings.events.entries))
    entry.enabled = id === "merchant";
  settings.events.entries.merchant.conditions = [];
  settings.events.entries.merchant.effect.giftOffers = [
    { giftId: "dried-fish", stock: 3 },
    { giftId: "catnip-candy", stock: 2 },
  ];
  const start = 1_800_000_000_000;
  runtime.clock = () => start;
  garden.initialize(start, settings);
  runtime.desktopVisits.command({
    client: randomUUID(),
    action: "sync",
    data: false,
  });
  const token = randomUUID();
  const server = createServer({ runtime, token, allowLive: true });
  t.after(() => server.close());
  const browser = await chromium.launch({
    executablePath: process.env.QQ_TEST_GARDEN_BROWSER,
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 430, height: 800 } });
  await page.goto(`http://127.0.0.1:${await server.listen()}/`);
  await page.locator("#token").fill(token);
  await page.locator("#login-button").click();
  await page.getByRole("button", { name: "花园", exact: true }).click();
  await page.getByRole("button", { name: "今日事件", exact: true }).click();
  await page.getByRole("button", { name: "小礼物", exact: true }).click();
  const shelf = page.locator(".garden-merchant .garden-shelf");
  assert.equal(
    await shelf.evaluate(
      (grid) =>
        grid.ownerDocument.defaultView
          .getComputedStyle(grid)
          .gridTemplateColumns.split(" ").length,
    ),
    2,
  );
  const candy = shelf.locator("article", { hasText: "薄荷糖罐" });
  await candy.locator('img[src$="/gift-catnip-candy.webp"]').waitFor();
  await page.waitForFunction(() =>
    Array.from(
      globalThis.document.querySelectorAll(
        '.garden-merchant img[src$="/gift-catnip-candy.webp"]',
      ),
    ).some((img) => img.complete && img.naturalWidth > 0),
  );
  const fish = shelf.locator("article").filter({ hasText: "小鱼干" });
  await fish.locator("summary").click();
  await fish.getByLabel("购买方式").selectOption("send");
  assert.equal(await fish.getByLabel("送给", { exact: true }).inputValue(), "");
  await fish
    .getByLabel("送给", { exact: true })
    .selectOption({ label: "角色0" });
  const note = "辛苦啦 <这张纸条仅收发双方可见>";
  await fish.getByLabel("赠言（可选）").fill(note);
  await fish.getByText(/用公共金币 12 元，送给角色0/).waitFor();

  let attempts = 0;
  const routePattern = "**/api/home-garden/act";
  await page.route(routePattern, (route) => {
    attempts++;
    return route.fulfill({
      status: 409,
      json: { error: "GARDEN_BALANCE_LOW" },
    });
  });
  await fish.getByRole("button", { name: "确认购买" }).click();
  await page.getByText("公共账户余额不足。", { exact: true }).waitFor();
  assert.equal(await fish.getByLabel("赠言（可选）").inputValue(), note);
  assert.equal(attempts, 1);
  await page.unroute(routePattern);
  const response = page.waitForResponse((entry) =>
    entry.url().endsWith("/api/home-garden/act"),
  );
  await fish.getByRole("button", { name: "确认购买" }).evaluate((button) => {
    button.click();
    button.click();
  });
  const { receipt, garden: state } = await (await response).json();
  await page
    .getByText("小鱼干已送给角色0，支出 12 元。", { exact: true })
    .waitFor();
  assert.equal(receipt.recipient.id, "agent-0");
  assert.equal(JSON.stringify(receipt).includes(note), false);
  for (const records of [state.activity, state.ledger, state.gifts]) {
    assert.equal(JSON.stringify(records).includes(note), false);
  }
  const recipient = subjectGardenView(runtime, "agent-0", "turn", false);
  assert.equal(recipient.personalGifts.received[0].note, note);
  const other = subjectGardenView(runtime, "agent-1", "turn", false);
  assert.equal(JSON.stringify(other).includes(note), false);
  assert.equal(garden.read(start).balance, 988);
  await page.getByRole("button", { name: "花圃", exact: true }).click();
  assert.equal(await page.locator(".garden-grid").isVisible(), true);
  assert.equal(await page.locator("[data-garden-ticket]").isVisible(), false);
  assert.equal(
    await page
      .locator("#garden-page")
      .evaluate((view) => view.scrollWidth > view.clientWidth),
    false,
  );
});

test("the management garden trades a selected harvest, hosts tea and keeps a sketch without custom art", async (t) => {
  const { runtime } = fixture(t, { cfg: config(1) });
  const garden = runtime.home.garden;
  const settings = defaultGardenSettings();
  settings.weather = fixedWeather();
  settings.events.rate = 1;
  const useEvent = (selected) => {
    for (const [id, event] of Object.entries(settings.events.entries))
      event.weight = Number(id === selected);
  };
  const crops = ["strawberry", "clover", "mint", "radish"];
  for (const id of crops) settings.crops[id].hours = 1;
  useEvent("odd-seed-trader");
  let now = 1_800_000_000_000;
  runtime.clock = () => now;
  garden.initialize(now, settings);
  garden.syncClock(now, true);
  const act = (action) =>
    garden.act(
      now,
      { kind: "admin", id: "administrator" },
      { requestId: randomUUID(), action },
    );
  const plants = crops.map((cropId, i) =>
    act({
      kind: "plant",
      plot: i + 1,
      cropId,
      buyPrice: settings.crops[cropId].seedPrice,
    }),
  );
  now += 2 * HOUR;
  garden.syncClock(now, true);
  const lots = plants
    .slice(0, 2)
    .map(({ plot, plantId }) => act({ kind: "harvest", plot, plantId }));
  now += DAY;
  garden.syncClock(now, true);

  const token = randomUUID();
  const server = createServer({ runtime, token, allowLive: true });
  t.after(() => server.close());
  const browser = await chromium.launch({
    executablePath: process.env.QQ_TEST_GARDEN_BROWSER,
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 375, height: 850 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${await server.listen()}/`);
  await page.locator("#token").fill(token);
  await page.locator("#login-button").click();
  await page.getByRole("button", { name: "花园", exact: true }).click();
  await page.getByRole("button", { name: "今日事件", exact: true }).click();
  const ticket = page.locator("[data-garden-ticket]");
  const target = ticket.getByLabel("选择一份收成");
  const options = await target.locator("option").allTextContents();
  const clover = options.find((label) => label.includes("野生三叶草"));
  assert.equal(options.length, 2);
  assert.match(options[0], /奶油草莓/);
  await target.selectOption({ label: clover });
  await ticket
    .getByRole("button", { name: "用一份收成交换", exact: true })
    .click();
  await ticket
    .getByText("交换客留下了一袋神秘种子。", { exact: true })
    .waitFor();
  const afterTrade = garden.read(now);
  assert.equal(afterTrade.mysterySeeds.count, 1);
  assert.ok(!afterTrade.harvests.some(({ id }) => id === lots[1].harvestId));

  const goToNextEvent = async (id, heading) => {
    useEvent(id);
    garden.configure(now, garden.requireState().settingsRevision, settings);
    now += DAY;
    garden.syncClock(now, true);
    await page.getByRole("button", { name: "刷新花园", exact: true }).click();
    await ticket.getByRole("heading", { name: heading, exact: true }).waitFor();
  };
  await goToNextEvent("garden-tea-party", "园中下午茶");
  assert.equal(await target.locator("option").count(), 1);
  await ticket
    .getByRole("button", { name: "开启园中下午茶", exact: true })
    .click();
  await page.getByText("园中茶会正在进行", { exact: true }).waitFor();
  assert.equal(garden.read(now).event.status, "resolved");

  await goToNextEvent("sketch-painter", "路过的植物速写师");
  await ticket
    .getByRole("button", { name: "收取写生场地费", exact: true })
    .waitFor();
  await ticket
    .getByRole("button", { name: "请他画下今天的花园", exact: true })
    .click();
  await ticket.getByText(/速写师画下了.*薄荷盆栽.*樱桃小萝卜/).waitFor();
  await page.getByRole("button", { name: "我的物品", exact: true }).click();
  const sketch = page.locator(".garden-good").filter({ hasText: "花园速写画" });
  await sketch.waitFor();
  await sketch.locator("img[src$='/gift-wrapped.webp']").waitFor();
  await sketch.getByText("查看物品", { exact: true }).click();
  await sketch.getByText("花园纪念品", { exact: true }).waitFor();
  await sketch.getByText(/速写师画下了.*薄荷盆栽.*樱桃小萝卜/).waitFor();
  assert.equal(
    await sketch.getByRole("button", { name: "吃掉这份" }).count(),
    0,
  );

  await page.getByRole("button", { name: "今日事件", exact: true }).click();
  await goToNextEvent("migratory-bird", "借宿的候鸟");
  const birdPlot = garden.read(now).event.target.plot;
  await ticket
    .getByRole("button", { name: `查看候鸟歇脚的第 ${birdPlot} 块地` })
    .click();
  await page.locator(`[data-plot="${birdPlot}"] .garden-bird`).waitFor();
  now += DAY;
  garden.syncClock(now, true);
  await page.getByRole("button", { name: "刷新花园", exact: true }).click();
  await page
    .locator(".garden-followups")
    .getByText(/候鸟平安飞走/)
    .waitFor();
  await page.getByRole("button", { name: "我的物品", exact: true }).click();
  const feather = page
    .locator(".garden-good")
    .filter({ hasText: "候鸟羽毛书签" });
  await feather.locator("img[src$='/gift-wrapped.webp']").waitFor();

  assert.deepEqual(errors, []);
});

test("the management garden builds facilities, crafts with two selected species and shows only public cabinet contents", async (t) => {
  const cfg = config(1);
  const { runtime } = fixture(t, { cfg });
  const garden = runtime.home.garden;
  const settings = defaultGardenSettings();
  settings.weather = fixedWeather();
  settings.events.rate = 0;
  settings.initialBalance = 3000;
  const cropIds = [
    "strawberry",
    "sunflower",
    "moonflower",
    "hydrangea",
    "mint",
  ];
  for (const id of cropIds) settings.crops[id].hours = 1;
  settings.crops.strawberry.yield = 2;
  let now = 1_800_000_000_000;
  runtime.clock = () => now;
  garden.initialize(now, settings);
  garden.syncClock(now, true);
  const admin = { kind: "admin", id: "administrator" };
  const act = (action, actor = admin) =>
    performGardenAction(runtime, actor, { requestId: randomUUID(), action });
  const plants = cropIds.map((cropId, index) =>
    act({
      kind: "plant",
      plot: index + 1,
      cropId,
      buyPrice: settings.crops[cropId].seedPrice,
    }),
  );
  now += 3 * HOUR;
  garden.syncClock(now, true);
  const harvested = Object.fromEntries(
    plants.map(({ plot, plantId }, i) => [
      cropIds[i],
      act({ kind: "harvest", plot, plantId }).harvestId,
    ]),
  );
  const token = randomUUID();
  const server = createServer({ runtime, token, allowLive: true });
  t.after(() => server.close());
  const browser = await chromium.launch({
    executablePath: process.env.QQ_TEST_GARDEN_BROWSER,
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 375, height: 850 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${await server.listen()}/`);
  await page.locator("#token").fill(token);
  await page.locator("#login-button").click();
  await page.getByRole("button", { name: "花园", exact: true }).click();
  const tab = (name) =>
    page.locator(".garden-nav").getByRole("button", { name, exact: true });
  const status = page.locator("[data-garden-status]");
  const currentBalance = () => garden.read(now).balance;
  await page.getByRole("button", { name: /图鉴已点亮 5/ }).waitFor();
  await tab("植物图鉴").click();
  await page
    .locator('[data-almanac-crop="hydrangea"]')
    .getByText(/雾紫绣球/)
    .waitFor();
  assert.equal(await page.locator('[data-almanac-crop="sunberry"]').count(), 0);

  await tab("手作台").click();
  const recipe = (id) => page.locator(`[data-garden-recipe="${id}"]`);
  const jam = recipe("craft-strawberry-jam");
  const bouquet = recipe("craft-flower-bouquet");
  assert.equal(await page.locator("[data-garden-recipe]").count(), 12);
  await bouquet.getByText("建好干花晾晒架后解锁。", { exact: true }).waitFor();
  const beforeJam = currentBalance();
  await jam.getByRole("button", { name: "制作", exact: true }).click();
  await status
    .getByText("手作草莓果酱已收入我的物品栏，工本费 12 元。")
    .waitFor();
  assert.equal(currentBalance(), beforeJam - 12);

  await tab("园角设施").click();
  for (const [name, price] of [
    ["晴雨风铃", 280],
    ["小鸟浴盆", 360],
    ["干花晾晒架", 420],
  ]) {
    const before = currentBalance();
    await page
      .getByRole("button", { name: `建造 · ${price} 元`, exact: true })
      .click();
    await status.getByText(`${name}已建成，支出 ${price} 元。`).waitFor();
    assert.equal(currentBalance(), before - price);
  }
  await page
    .locator('[data-garden-pane="facilities"] .garden-forecast')
    .waitFor();
  await tab("手作台").click();
  await jam.getByText(/工本费 6 元/).waitFor();
  await bouquet.getByText(/工本费 9 元/).waitFor();
  const primary = bouquet.getByLabel("原料 1", { exact: true });
  const second = bouquet.getByLabel("原料 2", { exact: true });
  await primary.selectOption(harvested.hydrangea);
  assert.equal(
    await second.locator(`option[value="${harvested.hydrangea}"]`).isDisabled(),
    true,
  );
  await second.selectOption(harvested.sunflower);
  await bouquet.getByLabel("成品去向").selectOption("send");
  await bouquet
    .getByLabel("送给", { exact: true })
    .selectOption({ label: "角色0" });
  const privateNote = "只有收礼人可见的花束赠言";
  await bouquet.getByLabel("赠言（可选）").fill(privateNote);
  const receipt = page.waitForResponse((response) =>
    response.url().endsWith("/api/home-garden/act"),
  );
  const beforeBouquet = currentBalance();
  await bouquet.getByRole("button", { name: "制作", exact: true }).click();
  const result = await (await receipt).json();
  await status.getByText("晴雨干花束已送给角色0，工本费 9 元。").waitFor();
  assert.equal(currentBalance(), beforeBouquet - 9);
  assert.equal(
    garden.read(now).harvests.some(({ id }) => id === harvested.moonflower),
    true,
  );
  assert.equal(
    garden.read(now).harvests.some(({ id }) => id === harvested.hydrangea),
    false,
  );

  await tab("串门").click();
  const community = page.locator('[data-garden-pane="community"]');
  assert.equal(await community.getByText("晴雨干花束").count(), 0);
  assert.equal(await community.getByText("手作草莓果酱").count(), 0);
  const role = {
    kind: "agent",
    id: cfg.agents[0].id,
    turnId: "phase3-cabinet-fixture",
  };
  const display = (publishNote) =>
    act(
      {
        kind: "display_gift",
        itemId: result.receipt.itemId,
        slot: 16,
        publishNote,
      },
      role,
    );
  display(false);
  await page.getByRole("button", { name: "刷新花园", exact: true }).click();
  const partnerCabinet = community
    .locator("details")
    .filter({ hasText: "角色0的展示柜" });
  await partnerCabinet.locator("summary").click();
  assert.equal(await partnerCabinet.locator(".cabinet-cell").count(), 16);
  await partnerCabinet.getByText("晴雨干花束", { exact: true }).waitFor();
  await partnerCabinet
    .getByText(/原料.*第 1 天成熟.*蓝雨绣球.*向日葵/)
    .waitFor();
  assert.equal(await partnerCabinet.getByText(privateNote).count(), 0);
  assert.equal(
    await partnerCabinet.getByRole("button", { name: "收回" }).count(),
    0,
  );

  display(true);
  await page.getByRole("button", { name: "刷新花园", exact: true }).click();
  await partnerCabinet
    .getByText(privateNote, { exact: true })
    .waitFor({ state: "attached" });
  await partnerCabinet.locator("summary").click();
  await partnerCabinet.getByText(privateNote, { exact: true }).waitFor();
  assert.equal(
    await page
      .locator("#garden-page")
      .evaluate((view) => view.scrollWidth > view.clientWidth),
    false,
  );
  assert.deepEqual(errors, []);
});

async function openEventSettings(t, prepare) {
  const executablePath = process.env.QQ_TEST_GARDEN_BROWSER;
  assert.ok(executablePath);
  const { runtime } = fixture(t, { cfg: config(1) });
  const garden = runtime.home.garden;
  const now = 1_800_000_000_000;
  runtime.clock = () => now;
  const settings = defaultGardenSettings();
  settings.weather = fixedWeather();
  settings.events = structuredClone(legacyEvents);
  prepare(settings);
  garden.initialize(now, settings);
  const token = randomUUID();
  const server = createServer({ runtime, token, allowLive: true });
  t.after(() => server.close());
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 430, height: 850 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${await server.listen()}/`);
  await page.locator("#token").fill(token);
  await page.locator("#login-button").click();
  await page.getByRole("button", { name: "花园", exact: true }).click();
  await page.getByRole("button", { name: "花园设置", exact: true }).click();
  const form = page.locator("[data-garden-settings]");
  const expand = async (name) => {
    const summary = page
      .locator("summary")
      .filter({ hasText: new RegExp(`^${name}`) });
    if (!(await summary.evaluate((node) => node.parentElement.open)))
      await summary.click();
  };
  await expand("花园设置");
  await expand("每日事件池");
  return {
    page,
    form,
    expand,
    errors,
    pool: () => garden.read(now).settings.events,
    row: (id) => form.locator(`[data-event-entry="${id}"]`),
    save: async () => {
      const response = page.waitForResponse((item) =>
        item.url().endsWith("/api/home-garden/settings"),
      );
      await form.getByRole("button", { name: "保存花园设置" }).click();
      assert.equal((await response).status(), 200);
      await page.getByText("设置已保存", { exact: true }).waitFor();
    },
  };
}

test("event settings import missing previews, round-trip optional effects and configure an independent gift shelf", async (t) => {
  const v = await openEventSettings(t, ({ events }) => {
    events.entries["similar-name"] = {
      ...structuredClone(events.entries.visitor),
      name: defaultEvents.entries["twin-fruit"].name,
      enabled: false,
    };
    const customChoice = structuredClone(
      defaultEvents.entries["rain-cat-shelter"],
    );
    customChoice.effect.options[1].description = "带它去我们的木门廊。";
    customChoice.effect.options[1].immediateReward.amount = 23;
    events.entries["rain-cat-shelter"] = customChoice;
    events.entries["custom-dew"] = {
      enabled: false,
      mode: "all",
      weight: 2,
      name: "自定义祝福",
      conditions: [
        { field: "alive", cropId: "strawberry", op: "gte", value: 3 },
      ],
      effect: { kind: "blessing", effect: "dew", quality: 4 },
    };
  });
  const original = v.pool();
  await v.expand("补入新版预设");
  assert.equal(
    await v.form.locator("[data-event-preset]:checked").count(),
    Object.keys(defaultEvents.entries).length - 4,
  );
  await v.form.getByRole("button", { name: "把选中预设加入表单" }).click();
  assert.equal(
    await v.form.locator("[data-event-entry]").count(),
    Object.keys(defaultEvents.entries).length + 2,
  );
  assert.deepEqual(v.pool(), original);
  await v.row("merchant").locator("summary").click();
  await v.row("merchant").getByLabel("可报价种子").selectOption([]);
  await v.row("merchant").getByLabel("可收购作物").selectOption([]);
  const mode = v.row("merchant").getByLabel("礼物货单");
  const fixed = v.row("merchant").locator("[data-fixed-gifts]");
  assert.equal(await mode.inputValue(), "random");
  assert.equal(await fixed.isHidden(), true);
  assert.equal(await fixed.locator("[data-gift-offer]").count(), 18);
  await mode.selectOption("fixed");
  const fish = v.row("merchant").locator('[data-gift-offer="dried-fish"]');
  await fish.getByLabel(/每日库存/).fill("4");
  await fish.getByLabel("礼物单价").fill("13");
  const candy = fixed.locator('[data-gift-offer="catnip-candy"]');
  await candy.getByLabel(/每日库存/).fill("2");
  assert.equal(
    await candy.getByLabel("礼物单价").getAttribute("placeholder"),
    "默认 15",
  );
  await mode.selectOption("random");
  assert.equal(await fixed.isHidden(), true);
  await mode.selectOption("fixed");
  assert.equal(await fish.getByLabel(/每日库存/).inputValue(), "4");
  await v.save();
  const saved = v.pool();
  assert.deepEqual(
    saved.entries["similar-name"],
    original.entries["similar-name"],
  );
  assert.deepEqual(saved.entries["custom-dew"], original.entries["custom-dew"]);
  assert.deepEqual(saved.entries.merchant.effect.seeds, []);
  assert.deepEqual(saved.entries.merchant.effect.harvests, []);
  assert.deepEqual(saved.entries.merchant.effect.giftOffers, [
    { giftId: "dried-fish", stock: 4, price: 13 },
    { giftId: "catnip-candy", stock: 2 },
  ]);
  for (const [id, entry] of Object.entries(defaultEvents.entries))
    if (!Object.hasOwn(legacyEvents.entries, id))
      assert.deepEqual(
        saved.entries[id],
        id === "rain-cat-shelter" ? original.entries[id] : entry,
        id,
      );
  await v.page.getByRole("button", { name: "花圃", exact: true }).click();
  await v.page.getByRole("button", { name: "花园设置", exact: true }).click();
  await v.expand("花园设置");
  await v.expand("每日事件池");
  const custom = v.row("custom-dew");
  await custom.locator("summary").click();
  assert.equal(await custom.getByLabel("阈值").inputValue(), "3");
  assert.equal(await custom.getByLabel("限定作物").inputValue(), "strawberry");
  assert.equal(await custom.getByLabel("增加品质分").inputValue(), "4");
  assert.equal(await custom.getByLabel("增加水分").inputValue(), "");
  assert.equal(
    await custom.getByLabel("增加水分").getAttribute("placeholder"),
    "默认 30",
  );
  await custom.getByLabel("阈值").fill("4");
  await v.save();
  assert.deepEqual(v.pool().entries["custom-dew"].conditions, [
    { field: "alive", cropId: "strawberry", op: "gte", value: 4 },
  ]);
  assert.deepEqual(
    v.pool().entries.merchant.effect.giftOffers,
    saved.entries.merchant.effect.giftOffers,
  );
  await v.expand("试配每日事件");
  const trial = v.page.locator("[data-garden-event-trial]");
  await trial.getByLabel("模拟花园日").fill("6");
  await trial.getByLabel("模拟当日天气").selectOption("cloud");
  await trial.getByRole("button", { name: "计算事件概率" }).click();
  await trial.getByText(/第 6 花园日.*抽取预报/).waitFor();
  await trial.getByText(/周末盲盒种子袋.*入池/).waitFor();
  await trial.getByText(/雨夜借棚的小猫.*当前花园条件无法触发/).waitFor();
  await trial.getByLabel("模拟花园日").fill("14");
  await trial.getByRole("button", { name: "计算事件概率" }).click();
  await trial.getByText(/满月露台夜.*100%.*入池/).waitFor();
  assert.deepEqual(
    v.pool().entries["rain-cat-shelter"].effect,
    original.entries["rain-cat-shelter"].effect,
  );
  await trial.getByLabel("模拟花园日").fill("8");
  await trial.getByRole("button", { name: "计算事件概率" }).click();
  await trial.getByText(/周末盲盒种子袋.*条件未满足/).waitFor();
  assert.deepEqual(v.errors, []);
});

test("event preset preview detects the 78-entry cap without changing saved settings", async (t) => {
  const v = await openEventSettings(t, ({ events }) => {
    for (let i = 1; i <= 79 - Object.keys(defaultEvents.entries).length; i++)
      events.entries[`custom-${i}`] = {
        ...structuredClone(events.entries.visitor),
        name: `测试条目 ${i}`,
        enabled: false,
      };
  });
  await v.expand("补入新版预设");
  const add = v.form.getByRole("button", { name: "把选中预设加入表单" });
  await add.click();
  await v.page
    .getByText("超过 78 条上限，请减少选中的预设。", { exact: true })
    .waitFor();
  assert.equal(
    await v.form.locator("[data-event-entry]").count(),
    82 - Object.keys(defaultEvents.entries).length,
  );
  await v.form.locator('[data-event-preset="twin-fruit"]').uncheck();
  await add.click();
  assert.equal(await v.form.locator("[data-event-entry]").count(), 78);
  assert.equal(
    Object.keys(v.pool().entries).length,
    82 - Object.keys(defaultEvents.entries).length,
  );
  await v.save();
  assert.equal(Object.keys(v.pool().entries).length, 78);
  assert.equal(v.pool().entries["custom-1"].enabled, false);
  assert.equal(v.pool().entries["twin-fruit"], undefined);
  assert.deepEqual(v.errors, []);
});

test("explicitly empty merchant shelf survives settings saves until switched to random", async (t) => {
  const v = await openEventSettings(t, ({ events }) => {
    events.entries.merchant.effect.giftOffers = [];
  });
  const merchant = v.row("merchant");
  await merchant.locator("summary").click();
  const mode = merchant.getByLabel("礼物货单");
  assert.equal(await mode.inputValue(), "fixed");
  assert.equal(await merchant.locator("[data-fixed-gifts]").isVisible(), true);
  await v.save();
  assert.deepEqual(v.pool().entries.merchant.effect.giftOffers, []);
  await v.expand("花园设置");
  await v.expand("每日事件池");
  if (!(await merchant.evaluate((details) => details.open)))
    await merchant.locator("summary").click();
  await mode.selectOption("random");
  await v.save();
  assert.equal(
    Object.hasOwn(v.pool().entries.merchant.effect, "giftOffers"),
    false,
  );
  assert.deepEqual(v.errors, []);
});

test("copying a merchant preserves its gift catalog and allows an independent shelf", async (t) => {
  const fixed = [{ giftId: "shell-music-box", stock: 3, price: 40 }];
  const v = await openEventSettings(t, ({ events }) => {
    events.entries.merchant.effect.giftOffers = fixed;
  });
  await v.form.getByLabel("新事件 ID").fill("shell-merchant");
  await v.form.getByLabel("复制事件").selectOption("merchant");
  await v.form.getByRole("button", { name: "新增事件", exact: true }).click();
  assert.deepEqual(v.errors, []);
  const copy = v.row("shell-merchant");
  assert.equal(await copy.count(), 1);
  assert.equal(await copy.getByLabel("礼物货单").inputValue(), "fixed");
  const box = copy.locator('[data-gift-offer="shell-music-box"]');
  assert.equal(await box.getByLabel("礼物单价").inputValue(), "40");
  await box.getByLabel(/每日库存/).fill("1");
  await v.save();
  assert.deepEqual(v.pool().entries.merchant.effect.giftOffers, fixed);
  assert.deepEqual(v.pool().entries["shell-merchant"].effect.giftOffers, [
    { giftId: "shell-music-box", stock: 1, price: 40 },
  ]);
  assert.deepEqual(v.errors, []);
});
