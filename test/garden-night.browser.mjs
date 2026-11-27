/* global window */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { chromium } from "playwright-core";
import { adminGardenView } from "../src/home/garden-console.mjs";
import { HOUR, defaultGardenSettings } from "../src/home/garden-rules.mjs";
import { createServer } from "../src/server.mjs";
import { findScreenshotBrowser } from "../src/tools/public-screenshot.mjs";
import { config, fixture } from "./helpers.mjs";

test("the compact garden displays dusk and night, static fireflies and the unlocked crop guide", async (t) => {
  const { runtime } = fixture(t, { cfg: config(1) });
  const garden = runtime.home.garden;
  const settings = defaultGardenSettings();
  settings.events.rate = 0;
  garden.initialize(runtime.now(), settings);
  // Exercise an old operator garden with a crop catalog saved before the new varieties.
  const { settings: saved } = garden.requireState();
  delete saved.crops.catnip;
  delete saved.crops.mistbell;
  delete saved.crops.hydrangea;
  delete saved.crops.tomato;
  delete saved.crops.succulent;
  delete saved.crops.chamomile;
  delete saved.careMode;
  runtime.memory.db
    .prepare("UPDATE garden_state SET settings=? WHERE id=1")
    .run(JSON.stringify(saved));
  const state = adminGardenView(runtime);

  const host = createServer({ runtime, token: randomUUID(), allowLive: true });
  t.after(() => host.close());
  const origin = `http://127.0.0.1:${await host.listen()}`;
  const browser = await chromium.launch({
    executablePath: findScreenshotBrowser(),
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 430, height: 780 } });
  await page.route(origin + "/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/garden-art/art.css"><main id="garden"></main>',
    }),
  );
  await page.goto(origin + "/");
  await page.evaluate(async (operator) => {
    const { bindGardenWorkspace } = await import("/garden-art/workspace.js");
    const workspace = bindGardenWorkspace(
      window.document.querySelector("#garden"),
      { compact: true },
    );
    window.redrawGarden = (changes) =>
      workspace.draw({ ...operator, ...changes });
  }, state);
  const draw = (scene, options = {}) =>
    page.evaluate(
      ({ scene, options }) => {
        window.redrawGarden({ nightScene: scene, ...options });
      },
      { scene, options },
    );

  await draw({ period: "dusk", butterflies: true }, { dayRemaining: 7 * HOUR });
  await page.getByText(/小蝴蝶停在猫薄荷上/).waitFor();
  assert.equal(await page.locator(".garden-scene-butterfly").count(), 1);
  assert.equal(await page.locator(".garden-scene-star").count(), 0);

  await draw(
    { period: "night", stars: "sparse", fireflies: true },
    {
      dayRemaining: 4 * HOUR,
      pollenPairs: [{ plots: [2, 5], hint: "金色花粉" }],
    },
  );
  await page.getByText(/云间疏星 · 花间有萤点/).waitFor();
  assert.equal(await page.locator(".garden-scene-star").count(), 3);
  await page
    .locator(".garden-pollen")
    .getByText(/第 2、5 号地/)
    .waitFor();
  await page.getByText("金色花粉", { exact: true }).waitFor();
  const firefly = page.locator(".garden-scene-firefly").first();
  assert.equal(
    await firefly.evaluate(
      (spot) => window.getComputedStyle(spot).animationName,
    ),
    "garden-firefly-glow",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(
    await firefly.evaluate(
      (spot) => window.getComputedStyle(spot).animationName,
    ),
    "none",
  );

  await page.getByRole("button", { name: "公共仓库", exact: true }).click();
  await page.getByText("作物图鉴", { exact: true }).click();
  const guide = page.locator(".garden-crop-guide");
  await guide.getByRole("heading", { name: "猫薄荷" }).waitFor();
  await guide.getByRole("heading", { name: "未知邻株种子" }).waitFor();
  const hydrangea = guide.getByRole("heading", { name: "蓝雨绣球" });
  await hydrangea.waitFor();
  assert.equal(await hydrangea.locator("../..").locator("img").count(), 0);
  const mistbell = guide.locator("[data-discovered]");
  const sticker = mistbell.locator("img");
  await sticker.evaluate((image) => image.decode());
  assert.notEqual(
    await sticker.evaluate((image) => window.getComputedStyle(image).filter),
    "none",
  );
  await draw(
    { period: "night", stars: "clear" },
    { mistbellDiscovered: true, fullMoon: true },
  );
  await page
    .locator('[data-garden-mood="moon"]')
    .getByText("满月照着花圃")
    .waitFor();
  assert.equal(await page.locator(".garden-scene-star").count(), 6);
  await guide.getByRole("heading", { name: "星雾铃", exact: true }).waitFor();
  assert.equal(
    await sticker.evaluate((image) => window.getComputedStyle(image).filter),
    "none",
  );
  assert.equal(
    await page
      .locator("#garden")
      .evaluate((node) => node.scrollWidth > node.clientWidth),
    false,
  );
});
