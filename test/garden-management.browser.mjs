import { keepNeutralWeather } from "./garden-fixtures.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { chromium } from "playwright-core";
import { createServer } from "../src/server.mjs";
import { HOUR } from "../src/home/garden-rules.mjs";
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
  const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
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
      .locator(".garden-grid")
      .evaluate(
        (grid) =>
          grid.ownerDocument.defaultView
            .getComputedStyle(grid)
            .gridTemplateColumns.split(" ").length,
      ),
    3,
  );
  const scrolls = await page
    .locator("#garden-page")
    .evaluate((view) => view.scrollWidth > view.clientWidth);
  assert.equal(scrolls, false);
  await page.getByText("等待桌面小窝连接", { exact: false }).waitFor();
  const { garden } = runtime.home;
  runtime.desktopVisits.command({
    client: randomUUID(),
    action: "sync",
    data: false,
  });
  await page.getByRole("button", { name: "刷新花园" }).click();
  const firstPlot = page.locator('[data-plot="1"]');
  await firstPlot.getByRole("button", { name: "播种" }).click();
  await firstPlot.getByText("野生三叶草", { exact: true }).waitFor();
  const settings = page.locator("[data-garden-settings]");
  await page.locator("summary").filter({ hasText: "花园设置" }).click();
  await settings.getByLabel("全园速度倍率").fill("4");
  await settings.getByLabel("作物 ID").fill("test-clover");
  await settings.getByRole("button", { name: "新增作物" }).click();
  const newCrop = settings.locator('[data-crop="test-clover"]');
  await newCrop.getByLabel("名称", { exact: true }).fill("试种三叶草");
  await newCrop.getByLabel("高光照倍率", { exact: true }).fill("1.2");
  await newCrop
    .getByLabel("基础成熟时长（花园小时）", { exact: true })
    .fill("1");
  await settings.getByLabel("角色0", { exact: true }).check();
  await settings.getByRole("button", { name: "保存花园设置" }).click();
  await page.getByText("设置已保存").waitFor();
  assert.equal(garden.read(now).settings.speed, 4);
  assert.deepEqual(garden.read(now).settings.crops["test-clover"].lightRates, {
    high: 1.2,
  });
  const secondPlot = page.locator('[data-plot="2"]');
  await secondPlot.getByLabel("第 2 块的作物").selectOption("test-clover");
  await secondPlot.getByRole("button", { name: "播种" }).click();
  await secondPlot.getByText("试种三叶草", { exact: true }).waitFor();
  const end = now + HOUR / 4;
  while (now < end) {
    now = Math.min(now + 10_000, end);
    garden.desktopSync(now, 15_000);
  }
  await page.getByRole("button", { name: "刷新花园" }).click();
  await page.getByText("第 2 块 · 可收成", { exact: true }).waitFor();
  await secondPlot.getByRole("button", { name: "收成" }).click();
  await page.getByText("收成完成", { exact: true }).waitFor();
  const lot = page.locator("[data-harvest]");
  await lot.getByRole("button", { name: "赠送" }).click();
  await page.getByText("赠礼完成", { exact: true }).waitFor();
  await page.locator("summary").filter({ hasText: "赠礼记录" }).click();
  await page.getByText(/管理员 送给 管理员 · 试种三叶草/).waitFor();
  assert.equal(await lot.count(), 0);
  assert.equal(
    await firstPlot.getByText("野生三叶草", { exact: true }).count(),
    1,
  );
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
