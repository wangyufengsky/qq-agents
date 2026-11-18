/* global window */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { _electron, chromium } from "playwright-core";
import { desktopResourcePath } from "../desktop/home/resource-protocol.mjs";
import { desktopToken } from "../src/home/desktop-auth.mjs";
import {
  gardenPublicSnapshot,
  renderGardenSnapshot,
} from "../src/home/garden-public.mjs";
import { createServer } from "../src/server.mjs";
import { MediaStore } from "../src/tools/media.mjs";
import { findScreenshotBrowser } from "../src/tools/public-screenshot.mjs";
import { DAY, HOUR, defaultGardenSettings } from "../src/home/garden-rules.mjs";
import { fixedWeather } from "./garden-fixtures.mjs";
import { config, context, fixture } from "./helpers.mjs";

test("actual Chromium produces a shareable nine-tile PNG and renders the desktop operator surface", async (t) => {
  const executablePath = findScreenshotBrowser();
  const cfg = config(1);
  cfg.desktopHome.enabled = true;
  const f = fixture(t, { cfg });
  const { runtime } = f;
  runtime.media = new MediaStore(path.join(f.root, "media"));
  const admin = randomUUID(),
    client = randomUUID();
  const host = createServer({ runtime, token: admin, allowLive: true });
  t.after(() => host.close());
  const origin = `http://127.0.0.1:${await host.listen()}`;
  let now = Date.UTC(2026, 0, 1);
  runtime.clock = () => now;
  const garden = runtime.home.garden;
  const rules = defaultGardenSettings();
  rules.weather = fixedWeather("storm");
  rules.events.rate = 1;
  for (const [id, event] of Object.entries(rules.events.entries))
    event.enabled = id === "thief";
  garden.initialize(now, rules);
  const callDesktop = (endpoint, body) =>
    fetch(origin + "/api/desktop-home/" + endpoint, {
      method: "POST",
      headers: {
        connection: "close",
        "content-type": "application/json",
        "x-desktop-home-token": desktopToken(admin),
      },
      body: JSON.stringify({ client, ...body }),
    }).then((r) => r.json());
  const opened = await callDesktop("client", { action: "sync", data: false });
  const roomEpoch = opened.room.roomEpoch;

  const source = fileURLToPath(new URL("../desktop/home/", import.meta.url));
  const testStatic = http.createServer(async (req, res) => {
    const file = desktopResourcePath("nest://app" + req.url, source);
    try {
      if (!file) throw Error("Not found");
      const body = await readFile(file);
      const type = file.endsWith(".js")
        ? "text/javascript"
        : file.endsWith(".html")
          ? "text/html"
          : file.endsWith(".css")
            ? "text/css"
            : "application/octet-stream";
      res.writeHead(200, { "content-type": type }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => testStatic.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    testStatic.closeAllConnections();
    return new Promise((resolve) => testStatic.close(resolve));
  });
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 430, height: 780 } });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.exposeFunction("gardenBridge", (epoch, action) =>
    callDesktop("garden", { roomEpoch: epoch, action }),
  );
  await page.addInitScript((epoch) => {
    window.nest = {
      onRoom: (listener) => {
        window.pushGardenRoom = listener;
      },
      onSection() {},
      setSection() {},
      get: async () => ({
        data: {
          live: true,
          framework: true,
          connected: true,
          roomEpoch: epoch,
          roles: [],
          messages: [],
          budget: 5,
        },
        section: "visits",
      }),
      garden: (...args) => window.gardenBridge(...args),
    };
  }, roomEpoch);
  await page.goto(
    `http://127.0.0.1:${testStatic.address().port}/desktop/home/index.html?type=panel`,
  );
  await page.getByRole("button", { name: "花园", exact: true }).click();
  const tiles = page.locator(".desktop-garden-tile");
  await tiles.first().getByText("空地", { exact: true }).waitFor();
  assert.equal(await tiles.count(), 9);
  const detail = page.locator(".garden-inspector");
  await tiles.nth(1).click();
  await detail.getByRole("button", { name: "搭棚", exact: true }).click();
  await detail.getByText("有棚", { exact: true }).waitFor();
  assert.equal(await tiles.nth(1).getAttribute("aria-pressed"), "true");
  await tiles.first().click();
  await detail.getByRole("button", { name: "播种", exact: true }).click();
  await tiles.first().getByText("野生三叶草", { exact: true }).waitFor();
  assert.equal(
    (
      await fetch(origin + "/api/home-garden", {
        headers: { "x-admin-token": admin },
      }).then((r) => r.json())
    ).plots[0].plant.cropId,
    "clover",
  );
  assert.deepEqual(pageErrors, []);

  garden.desktopSync(now, 10 * DAY);
  now += DAY + HOUR;
  garden.desktopSync(now, 10 * DAY);
  const renewed = await callDesktop("client", { action: "sync", data: false });
  await page.evaluate((room) => window.pushGardenRoom(room), {
    live: true,
    framework: true,
    connected: true,
    roomEpoch: renewed.room.roomEpoch,
    roles: [],
    messages: [],
    budget: 5,
  });
  await page
    .getByRole("button", { name: "刷新", exact: false })
    .first()
    .click();
  await page.getByText(/暴雨积水.*本日剩 23 花园小时.*否则枯萎/).waitFor();
  const ctx = context(runtime);
  const image = await runtime.callTool(ctx, "garden_read", { view: "image" });
  const payload = JSON.parse(image.content[0].text);
  const png = Buffer.from(image.content[1].data, "base64");
  assert.equal(payload.imageAvailable, true);
  assert.equal(payload.plots.length, 9);
  assert.equal(payload.plots[0].name, "野生三叶草");
  assert.equal(payload.weather.kind, "storm");
  assert.deepEqual(payload.event, {
    name: "小偷踩点",
    kind: "thief",
    status: "open",
  });
  assert.match(payload.text, /小偷踩点/);
  assert.equal(payload.plots[0].risk, "critical");
  assert.equal(payload.plots[1].sheltered, true);
  assert.match(payload.text, /暴雨.*本日剩 23 花园小时/);
  assert.equal(png.readUInt32BE(16), 720);
  assert.doesNotMatch(
    JSON.stringify(payload),
    /plant-clover|soil-normal|cropId/,
  );
  const readArt = async (file) => {
    if (file === "soil-normal.webp") return Buffer.from("broken WebP");
    if (file.startsWith("plant-")) throw new Error("Missing plant sprite");
    return readFile(new URL("../public/garden-art/" + file, import.meta.url));
  };
  const degraded = await renderGardenSnapshot(
    gardenPublicSnapshot(garden.read(now), { running: true, now }),
    { executablePath, readArt },
  );
  assert.equal(degraded.readUInt32BE(16), 720);
  assert.notDeepEqual(degraded, png);
  assert.ok(png.readUInt32BE(20) > 300);
  assert.equal(
    (
      await runtime.callTool(ctx, "qq_send", {
        requestId: "actual-garden-png",
        text: payload.text,
        mediaId: payload.mediaId,
      })
    ).status,
    "sent",
  );
  const [receipt] = runtime.transports.get("qq-0").sent;
  assert.deepEqual(
    receipt.segments.map((x) => x.type),
    ["text", "image"],
  );
  rules.events.entries.thief.enabled = false;
  rules.events.entries.merchant.enabled = true;
  rules.events.entries.merchant.conditions = [];
  rules.events.entries.merchant.effect.giftOffers = [
    { giftId: "dried-fish", stock: 3 },
    { giftId: "catnip-candy", stock: 2 },
  ];
  garden.configure(now, garden.requireState().settingsRevision, rules);
  garden.desktopSync(now, 10 * DAY);
  now += DAY;
  garden.desktopSync(now, 10 * DAY);
  const next = await callDesktop("client", { action: "sync", data: false });
  await page.evaluate(
    (epoch) =>
      window.pushGardenRoom({
        live: true,
        framework: true,
        connected: true,
        roomEpoch: epoch,
        roles: [],
        messages: [],
        budget: 5,
      }),
    next.room.roomEpoch,
  );
  const panel = page.locator("#garden-panel");
  await panel.getByRole("button", { name: "刷新花园", exact: true }).click();
  await panel.getByRole("button", { name: "今日事件", exact: true }).click();
  await panel.getByRole("button", { name: "小礼物", exact: true }).click();
  const candy = panel.locator(".garden-merchant .garden-good", {
    hasText: "薄荷糖罐",
  });
  await candy.locator('img[src$="/gift-wrapped.webp"]').waitFor();
  const fish = panel
    .locator(".garden-merchant .garden-good")
    .filter({ hasText: "小鱼干" });
  await fish.getByText("选购").click();
  await fish.getByRole("button", { name: "确认购买" }).click();
  await panel.getByText("小鱼干已收入我的物品栏，支出 12 元。").waitFor();
  await panel.getByRole("button", { name: "我的物品", exact: true }).click();
  const item = panel.locator(".garden-good").filter({ hasText: "小鱼干" });
  await item.getByText("查看物品").click();
  await item.getByText("摆入展示栏").click();
  await item.getByLabel("展示格").selectOption("2");
  await item.getByLabel("公开说明").fill("花园里带回来的小鱼干");
  await item.getByRole("button", { name: "确认展示" }).click();
  await panel
    .locator(".garden-display")
    .getByText("花园里带回来的小鱼干")
    .waitFor();
  const layout = await panel
    .locator(".garden-content")
    .evaluate((view) => view.scrollWidth <= view.clientWidth);
  assert.equal(layout, true);
  assert.deepEqual(pageErrors, []);
});

test("native Electron garden tab reaches shared state through its focused panel IPC", async (t) => {
  const executablePath = process.env.QQ_TEST_ELECTRON;
  if (!executablePath) {
    t.skip("Set QQ_TEST_ELECTRON for the native desktop check");
    return;
  }
  const cfg = config(1);
  cfg.desktopHome.enabled = true;
  const { runtime, root } = fixture(t, { cfg });
  const admin = randomUUID(),
    profile = path.join(root, "electron");
  await mkdir(profile);
  await writeFile(path.join(root, "desktop-home-token"), desktopToken(admin));
  runtime.home.garden.initialize(runtime.now());
  const server = createServer({ runtime, token: admin, allowLive: true });
  t.after(() => server.close());
  const port = await server.listen();
  let electron;
  try {
    electron = await _electron.launch({
      executablePath,
      args: [fileURLToPath(new URL("../desktop/home/", import.meta.url))],
      env: {
        ...process.env,
        DESKTOP_HOME_TRIAL_PROFILE: profile,
        DESKTOP_HOME_DATA_ROOT: root,
        DESKTOP_HOME_LIVE_ROOT: "",
        DESKTOP_HOME_PORT: String(port),
      },
    });
    const door = await electron.firstWindow();
    await door.locator(".door-button").click();
    let panel;
    for (let i = 0; i < 80 && !panel; i++) {
      panel = electron
        .windows()
        .find((value) => value.url().includes("type=panel"));
      if (!panel) await delay(100);
    }
    assert.ok(panel);
    await panel.getByRole("button", { name: "花园", exact: true }).click();
    const tile = panel.locator(".desktop-garden-tile").first();
    await tile.getByText("空地", { exact: true }).waitFor({ timeout: 8000 });
    const detail = panel.locator(".garden-inspector");
    await panel.locator(".garden-workspace-head .garden-coin-icon").waitFor();
    await detail.getByRole("button", { name: "搭棚", exact: true }).click();
    await detail.getByText("有棚", { exact: true }).waitFor();
    await detail.getByRole("button", { name: "播种", exact: true }).click();
    await tile
      .getByText("野生三叶草", { exact: true })
      .waitFor({ timeout: 8000 });
    await panel.waitForFunction(() => {
      const images = globalThis.document.querySelectorAll(
        ".desktop-garden-tile:first-child .garden-art-layer",
      );
      return (
        images.length === 4 &&
        Array.from(images).every((img) => img.complete && img.naturalWidth > 0)
      );
    });
    assert.equal(
      runtime.home.garden.read(runtime.now()).plots[0].plant.cropId,
      "clover",
    );
  } finally {
    await electron?.close();
  }
});
