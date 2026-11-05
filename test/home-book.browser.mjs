/* global document, innerWidth, getComputedStyle */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { fixture, config } from "./helpers.mjs";
import { createServer } from "../src/server.mjs";

if (!process.env.CHROME_PATH) throw Error("CHROME_PATH_REQUIRED");
const output =
  process.env.HOME_BOOK_OUTPUT ||
  (await fs.mkdtemp(path.join(os.tmpdir(), "home-book-")));
await fs.mkdir(output, { recursive: true });
const cleanup = [],
  cfg = config(7);
const f = fixture({ after: (fn) => cleanup.push(fn) }, { cfg });
const token = "test-admin-token-placeholder",
  app = createServer({ runtime: f.runtime, token });
const base = `http://127.0.0.1:${await app.listen()}`;
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH,
  headless: true,
});
const checks = [],
  errors = [];
function check(name, value) {
  assert.ok(value, name);
  checks.push(name);
}
async function ready(page, hash) {
  await page.waitForFunction((h) => {
    const stage = document.getElementById("stage");
    return (
      !document.getElementById("home-content").hidden &&
      stage.dataset.route === h &&
      !stage.inert &&
      !stage.hasAttribute("aria-busy")
    );
  }, hash);
}
try {
  const page = await browser.newPage({
    viewport: { width: 1024, height: 900 },
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + "/home-space/");
  await page.evaluate(
    (value) => sessionStorage.setItem("qq-unified-token", value),
    token,
  );
  await page.reload();
  await ready(page, "#living");
  check(
    "editor and secondary navigation start closed",
    !(await page.locator("#editor").isVisible()) &&
      !(await page.locator("#entries").isVisible()),
  );
  check(
    "room art is the original asset catalog",
    await page
      .locator("#stage img")
      .evaluateAll((imgs) =>
        imgs.every(
          (i) => i.src.includes("/home-preview/assets/") && i.naturalWidth > 0,
        ),
      ),
  );
  await page.screenshot({
    path: path.join(output, "living-desktop.png"),
    fullPage: true,
  });
  await page.locator('[data-instance="door"]').click();
  await page.locator(".book-turning").waitFor();
  check(
    "forward navigation turns a real paper page",
    await page
      .locator(".book-turning")
      .evaluate((n) => getComputedStyle(n).transform !== "none"),
  );
  await page.screenshot({ path: path.join(output, "turning.png") });
  await ready(page, "#hall/1");
  check(
    "finished turns discard the old scene",
    (await page.locator(".book-page").count()) === 1,
  );
  await page.locator('[data-instance="door-agent-0"]').click();
  await ready(page, "#room/agent-0");
  await page.click("#page-back");
  await ready(page, "#hall/1");
  check(
    "backward page turn restores the resident door focus",
    await page.evaluate(
      () => document.activeElement.dataset.instance === "door-agent-0",
    ),
  );

  // A new navigation owns the display even if an older HTTP response arrives later.
  await page.click("#bookmark-living");
  await ready(page, "#living");
  let release, arrived;
  const held = new Promise((r) => {
    release = r;
  });
  const started = new Promise((r) => {
    arrived = r;
  });
  await page.route("**/api/home/scene?type=hall", async (route) => {
    const response = await route.fetch();
    arrived();
    await held;
    await route.fulfill({ response });
  });
  await page.click("#bookmark-hall");
  await started;
  check(
    "pending navigation cannot open or edit the previous room",
    (await page.locator("#entry-toggle").isDisabled()) &&
      (await page.locator("#edit-toggle").isDisabled()) &&
      (await page.locator("#editor").evaluate((n) => n.inert)),
  );
  await page.click("#bookmark-living");
  await ready(page, "#living");
  release();
  await page.waitForResponse((r) =>
    r.url().endsWith("/api/home/scene?type=hall"),
  );
  await page.unroute("**/api/home/scene?type=hall");
  check(
    "late navigation cannot replace the selected page",
    (await page.locator("#stage").getAttribute("data-route")) === "#living",
  );

  await page.click("#bookmark-hall");
  await page.locator(".book-turning").waitFor();
  await page.evaluate(() => sessionStorage.removeItem("qq-unified-token"));
  await page.click("#menu-toggle");
  await page.click("#refresh");
  await page.waitForFunction(
    () => document.getElementById("home-content").hidden,
  );
  check(
    "login loss removes both animation surfaces",
    (await page.locator("#stage").textContent()) === "" &&
      (await page.locator(".book-page").count()) === 0,
  );
  check(
    "login loss removes resident labels from hidden controls",
    !(await page.locator("body").textContent()).includes("角色0"),
  );
  await page.evaluate(
    (value) => sessionStorage.setItem("qq-unified-token", value),
    token,
  );
  await page.click("#retry");
  await ready(page, "#hall/1");
  await page.click("#bookmark-living");
  await page.locator(".book-turning").waitFor();
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      value: true,
      configurable: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  check(
    "backgrounding clears the turning scene",
    (await page.locator("#stage").textContent()) === "",
  );
  await page.evaluate(() => {
    delete document.hidden;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await ready(page, "#living");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.click("#bookmark-hall");
  await ready(page, "#hall/1");
  check(
    "reduced motion switches without a flip",
    (await page.locator(".book-turning").count()) === 0,
  );

  const old = f.runtime.home.read("living");
  old.layout.objects.board = { hidden: true };
  f.runtime.home.saveShared("living", {
    layout: old.layout,
    expectedRevision: old.layoutRevision,
    rosterRevision: old.rosterRevision,
    requestId: "hidden-board-entry",
  });
  await page.click("#bookmark-living");
  await ready(page, "#living");
  check(
    "hidden furniture keeps a text entry",
    (await page.locator('[data-instance="board"]').count()) === 0,
  );
  await page.click("#entry-toggle");
  await page.getByRole("button", { name: "打开留言板", exact: true }).click();
  await page.locator("#reader[open]").waitFor();
  await page.keyboard.press("Escape");
  check(
    "reader closes and restores the fallback entry",
    await page
      .locator("#entry-toggle")
      .evaluate((n) => n === document.activeElement),
  );

  for (const width of [320, 375, 390, 640, 736, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    for (const hash of ["living", "hall/1", "room/agent-0"]) {
      await page.goto(base + "/home-space/#" + hash);
      await ready(page, "#" + hash);
      check(
        `single page and no overflow ${width} ${hash}`,
        (await page.locator("#stage .board").count()) === 1 &&
          (await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          )),
      );
      check(
        `loaded artwork ${width} ${hash}`,
        await page
          .locator("#stage img")
          .evaluateAll((imgs) =>
            imgs.every((i) => i.complete && i.naturalWidth > 0),
          ),
      );
      if (hash === "living") {
        await page.locator("#bookmark-living").hover();
        await page.locator("#bookmarks").evaluate(async (node) => {
          await Promise.all(
            node.getAnimations({ subtree: true }).map((a) => a.finished),
          );
        });
        check(
          `hovered bookmark stays inside viewport ${width}`,
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        );
        await page.mouse.move(0, 0);
      }
      if (width === 390 || width === 1024)
        await page.screenshot({
          path: path.join(output, `${hash.replaceAll("/", "-")}-${width}.png`),
          fullPage: true,
        });
    }
  }
  check("no browser errors", errors.length === 0);
  check(
    "no model work or QQ delivery",
    f.runtime.jobs.size === 0 &&
      [...f.runtime.transports.values()].every((t) => t.sent.length === 0),
  );
  await fs.writeFile(
    path.join(output, "report.json"),
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ passed: checks.length, errors }));
} finally {
  await browser.close();
  await app.close();
  for (const fn of cleanup.reverse()) await fn();
}
