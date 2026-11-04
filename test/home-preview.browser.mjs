/* global document, location, window, innerWidth */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { chromium } from "playwright-core";
import { fixture, config } from "./helpers.mjs";
import { createServer } from "../src/server.mjs";
import { catalog as manifest } from "../public/home-preview/catalog.mjs";
if (!process.env.CHROME_PATH) throw Error("CHROME_PATH_REQUIRED");
const root =
  process.env.HOME_PREVIEW_OUTPUT ||
  (await fs.mkdtemp(path.join(os.tmpdir(), "qq-home-preview-")));
await fs.mkdir(path.join(root, "previews"), { recursive: true });
const cleanup = [],
  cfg = config(0);
cfg.mode = "isolated";
cfg.globalPaused = true;
const f = fixture({ after: (fn) => cleanup.push(fn) }, { cfg });
const app = createServer({
  runtime: f.runtime,
  token: "test-admin-token-placeholder",
});
const base = `http://127.0.0.1:${await app.listen()}/home-preview/`;
let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH,
    headless: true,
  });
} catch (error) {
  await app.close();
  for (const fn of cleanup.reverse()) await fn();
  throw error;
}
const results = [],
  errors = [];
const check = (name, value) => {
  assert.ok(value, name);
  results.push({ name, passed: true });
};
async function settled(page) {
  await page.waitForFunction(() => {
    const stage = document.getElementById("stage");
    return (
      (!stage || stage.dataset.route === (location.hash || "#living")) &&
      [...document.images].every((i) => i.complete)
    );
  });
  await page.evaluate(() => document.fonts.ready);
}
async function settings(page) {
  if (!(await page.locator("#settings").isVisible()))
    await page.locator("#settings-toggle").click();
}
async function closeSettings(page) {
  if (await page.locator("#settings").isVisible())
    await page.locator("#settings-toggle").click();
}
async function shot(page, name) {
  await closeSettings(page);
  await page.waitForFunction(
    () => !document.getElementById("toast")?.classList.contains("show"),
  );
  await page.evaluate(() => {
    document.activeElement?.blur();
    window.scrollTo(0, 0);
  });
  await settled(page);
  await page.screenshot({
    path: path.join(root, "previews", name + ".png"),
    fullPage: true,
  });
}
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(new URL("/", base).href);
  check(
    "console preview entry visible",
    await page.locator(".home-preview-link").isVisible(),
  );
  await page.setViewportSize({ width: 375, height: 844 });
  check(
    "console preview entry visible on mobile",
    await page.locator(".home-preview-link").isVisible(),
  );
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto(base);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await settled(page);
  for (const [hash, name] of [
    ["living", "living-desktop"],
    ["hall/1", "hall-desktop"],
    ["room/1", "room-desktop"],
  ]) {
    await page.goto(base + "#" + hash);
    await shot(page, name);
    check(
      name + " images load",
      await page.evaluate(() =>
        [...document.images].every((i) => i.naturalWidth > 0),
      ),
    );
  }
  await page.locator('[data-instance="card"]').click();
  check(
    "paper card opens introduction",
    await page.locator("#reader").isVisible(),
  );
  check(
    "empty introduction is neutral",
    (await page.locator("#reader-content").textContent()).includes(
      "尚未公开介绍",
    ),
  );
  await page.keyboard.press("Escape");
  check(
    "Esc restores paper card focus",
    await page
      .locator('[data-instance="card"]')
      .evaluate((n) => document.activeElement === n),
  );
  await settings(page);
  await page.selectOption("#object-select", "desk");
  const before = await page
    .locator('[data-instance="card"]')
    .evaluate((n) => parseFloat(n.style.left));
  await page.getByLabel("横向偏移", { exact: true }).fill("4");
  await page.getByLabel("横向偏移", { exact: true }).dispatchEvent("change");
  const after = await page
    .locator('[data-instance="card"]')
    .evaluate((n) => parseFloat(n.style.left));
  check("desk carries introduction card", Math.abs(after - before - 4) < 0.01);
  await page.selectOption("#asset-variant", "desk-simple");
  check(
    "desk replacement rendered",
    (await page
      .locator('[data-instance="desk"]')
      .getAttribute("data-asset")) === "desk-simple",
  );
  await page.reload();
  await settled(page);
  check(
    "layout survives reload",
    (await page
      .locator('[data-instance="desk"]')
      .getAttribute("data-asset")) === "desk-simple",
  );
  await settings(page);
  await page.selectOption("#object-select", "desk");
  await page.getByLabel("隐藏这张纸片", { exact: true }).check();
  check(
    "hidden parent also hides attachment",
    (await page.locator('[data-instance="card"]').count()) === 0,
  );
  await page
    .locator("#scene-actions")
    .getByRole("button", { name: "查看公开介绍", exact: true })
    .click();
  check(
    "hidden paper preserves text entry",
    await page.locator("#reader").isVisible(),
  );
  await page.keyboard.press("Escape");
  await page.locator("#undo").click();
  check(
    "undo restores parent and attachment",
    (await page.locator('[data-instance="card"]').count()) === 1,
  );
  await page.locator("#reset").click();
  for (const palette of ["cream", "blue", "rose"]) {
    await page.selectOption("#palette", palette);
    check(
      "palette " + palette,
      await page
        .locator("body")
        .evaluate((n, p) => n.classList.contains("palette-" + p), palette),
    );
    for (const id of ["bed", "rug"]) {
      check(
        `${palette} ${id} textile variant`,
        (await page
          .locator(`[data-instance="${id}"]`)
          .getAttribute("data-asset")) ===
          (palette === "cream" ? id : `${id}-${palette}`),
      );
    }
    if (palette !== "cream") {
      await shot(page, `palette-${palette}`);
      await settings(page);
    }
  }
  await page.selectOption("#palette", "cream");
  for (const count of [0, 1, 2, 3, 4, 7]) {
    await page.selectOption("#residents", String(count));
    await page.goto(base + "#hall/1");
    await settled(page);
    check(
      "hall resident count " + count,
      (await page.locator('[data-instance^="door-"]').count()) ===
        Math.min(3, count),
    );
    if (count > 3) {
      await page
        .getByRole("button", { name: "下一段走廊 →", exact: true })
        .click();
      await settled(page);
      check(
        "hall second-page count " + count,
        (await page.locator('[data-instance^="door-"]').count()) ===
          Math.min(3, count - 3),
      );
    }
  }
  await page.goto(base + "#hall/2");
  await page.locator('[data-instance="door-4"]').click();
  await page
    .locator("#scene-actions")
    .getByRole("button", { name: "返回走廊", exact: true })
    .click();
  await settled(page);
  check("return preserves hallway page", page.url().endsWith("#hall/2"));
  check(
    "return restores doorway focus",
    await page
      .locator('[data-instance="door-4"]')
      .evaluate((n) => document.activeElement === n),
  );
  await page.goto(base + "#room/1");
  await settings(page);
  await page.selectOption("#residents", "3");
  for (const state of ["empty", "denied", "error", "loading", "missing"]) {
    await page.selectOption("#page-state", state);
    await shot(page, "state-" + state);
    check(
      "state " + state + " has explanation",
      (await page.locator("#state-message").textContent()).trim().length > 0,
    );
    await settings(page);
  }
  await page.selectOption("#page-state", "denied");
  await page.selectOption("#sample-content", "sample");
  await page
    .locator("#scene-actions")
    .getByRole("button", { name: "查看作品展示", exact: true })
    .click();
  check(
    "denied reader excludes sample body",
    !(await page.locator("#reader-content").textContent()).includes("示例作品"),
  );
  await page.keyboard.press("Escape");
  await page.selectOption("#page-state", "ready");
  await page
    .locator("#scene-actions")
    .getByRole("button", { name: "查看作品展示", exact: true })
    .click();
  await settled(page);
  await page.screenshot({
    path: path.join(root, "previews", "reading-sample.png"),
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await page.selectOption("#sample-content", "empty");
  await closeSettings(page);
  const downloadPromise = page.waitForEvent("download");
  await settings(page);
  await page.locator("#export").click();
  const download = await downloadPromise;
  await download.saveAs(path.join(root, "example-room-scene.json"));
  const exported = JSON.parse(
    await fs.readFile(path.join(root, "example-room-scene.json"), "utf8"),
  );
  check(
    "export references template without embedding device coordinates or arbitrary actions",
    exported.kind === "scene-preview-only" &&
      exported.templateId === "paperbook-room-v1" &&
      !Object.hasOwn(exported, "hotspots") &&
      !JSON.stringify(exported).includes('"base"'),
  );
  for (const width of [375, 390]) {
    const phone = await browser.newContext({
      viewport: { width, height: 844 },
      isMobile: true,
      hasTouch: true,
      reducedMotion: "reduce",
    });
    const p = await phone.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    for (const [hash, name] of [
      ["living", "living-mobile"],
      ["hall/1", "hall-mobile"],
      ["room/1", "room-mobile"],
    ]) {
      await p.goto(base + "#" + hash);
      await settled(p);
      check(
        `${width} ${hash} no horizontal overflow`,
        await p.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      check(
        `${width} ${hash} images load`,
        await p.evaluate(() =>
          [...document.images].every((i) => i.naturalWidth > 0),
        ),
      );
      if (width === 390) await shot(p, name);
    }
    await settings(p);
    check(
      `${width} editor no horizontal overflow`,
      await p.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await p
      .locator("#scene-actions")
      .getByRole("button", { name: "查看作品展示", exact: true })
      .click();
    check(
      `${width} mobile reader opens`,
      await p.locator("#reader").isVisible(),
    );
    await p.locator("#reader-back").click();
    check(
      `${width} reader closes without leaving room`,
      p.url().endsWith("#room/1"),
    );
    await phone.close();
  }
  await page.goto(base + "#room/1");
  await page.route("**/assets/shelf.webp", (route) => route.abort());
  await page.reload();
  await settled(page);
  check(
    "failed image shows placeholder",
    (await page.locator('[data-instance="shelf"]').textContent()).includes(
      "纸片加载失败",
    ),
  );
  await page
    .locator("#scene-actions")
    .getByRole("button", { name: "查看作品展示", exact: true })
    .click();
  check(
    "failed image preserves reader",
    await page.locator("#reader").isVisible(),
  );
  await page.unroute("**/assets/shelf.webp");
  await page.evaluate(() =>
    localStorage.setItem(
      "qq-agents-home-preview-v1",
      JSON.stringify({
        count: 3,
        scenes: {
          "room-1": { palette: "invalid", objects: { desk: { scale: 999 } } },
        },
      }),
    ),
  );
  await page.reload();
  await settled(page);
  check(
    "invalid stored scene recovers to default",
    (await page
      .locator('[data-instance="desk"]')
      .getAttribute("data-asset")) === "desk",
  );
  await page.locator(".skip").focus();
  await page.keyboard.press("Enter");
  check("skip link keeps room route", page.url().endsWith("#room/1"));
  check(
    "skip link focuses text entries",
    await page
      .locator("#scene-actions")
      .evaluate((n) => document.activeElement === n),
  );
  await settings(page);
  await page.selectOption("#page-state", "error");
  const works = page
    .locator("#scene-actions")
    .getByRole("button", { name: "查看作品展示", exact: true });
  await works.click();
  await page
    .locator("#reader-content")
    .getByRole("button", { name: "重试", exact: true })
    .click();
  await page.keyboard.press("Escape");
  check(
    "reader retry preserves entry focus",
    await works.evaluate((n) => document.activeElement === n),
  );
  check("no browser JavaScript errors", errors.length === 0);
  check("26 web assets are catalogued", Object.keys(manifest).length === 26);
  check(
    "all 25 paper pieces have alpha",
    Object.entries(manifest)
      .filter(([id]) => id !== "room-board")
      .every(([, a]) => a.transparent),
  );
  await fs.writeFile(
    path.join(root, "validation.json"),
    JSON.stringify(
      {
        scope: "scene-preview-isolated",
        browser: "Chromium / local Google Chrome",
        viewports: ["1440x1100", "375x844", "390x844"],
        passed: results.length,
        results,
        errors,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    JSON.stringify({
      passed: results.length,
      errors,
      assets: Object.keys(manifest).length,
    }),
  );
} finally {
  await browser.close();
  await app.close();
  for (const fn of cleanup.reverse()) await fn();
}
