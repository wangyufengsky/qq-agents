/* global document, innerWidth, innerHeight, getComputedStyle */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { fixture, config } from "./helpers.mjs";
import { createServer } from "../src/server.mjs";
if (!process.env.CHROME_PATH) throw Error("CHROME_PATH_REQUIRED");
const output =
  process.env.HOME_EDITOR_OUTPUT ||
  (await fs.mkdtemp(path.join(os.tmpdir(), "home-editor-")));
await fs.mkdir(output, { recursive: true });
const cleanup = [],
  cfg = config(7);
cfg.agents[0].name = "窗边喜欢读书和种花的住户";
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
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
    reducedMotion: "reduce",
  });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.addInitScript(
    (t) => sessionStorage.setItem("qq-unified-token", t),
    token,
  );
  async function go(hash) {
    await page.goto(`${base}/home-space/#${hash}`);
    await page.reload();
    await page.waitForFunction(
      (h) =>
        document.getElementById("stage").dataset.route === `#${h}` &&
        !document.getElementById("stage").inert,
      hash,
    );
    await page.evaluate(() => document.fonts.ready);
  }
  async function fits(name) {
    const bounds = await page.evaluate(() => {
      const rect = (id) =>
        document.getElementById(id).getBoundingClientRect().toJSON();
      return {
        stage: rect("stage"),
        editor: rect("editor"),
        save: rect("save"),
        width: innerWidth,
        height: innerHeight,
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
      };
    });
    const { stage, editor, save, width, height } = bounds;
    const inside = (r) =>
      r.top >= 0 &&
      r.left >= 0 &&
      r.bottom <= height + 1 &&
      r.right <= width + 1;
    const ok =
      inside(stage) &&
      stage.width > 100 &&
      stage.height > 100 &&
      inside(editor) &&
      inside(save) &&
      (stage.right <= editor.left || stage.bottom <= editor.top) &&
      bounds.scrollWidth <= width &&
      bounds.scrollHeight <= height + 1;
    if (!ok)
      await page.screenshot({ path: path.join(output, "layout-failure.png") });
    check(ok ? name : `${name}: ${JSON.stringify(bounds)}`, ok);
  }
  await go("living");
  await page.click("#edit-toggle");
  await fits("scene, editor and save fit one screen without overlap");
  await page.locator('#object-strip [data-object="plant"]').click();
  await page.getByRole("slider", { name: "横向偏移", exact: true }).fill("2");
  await page.click("#editor-close");
  check(
    "close returns focus to the entry",
    await page
      .locator("#edit-toggle")
      .evaluate((n) => n === document.activeElement),
  );
  await page.click("#edit-toggle");
  check(
    "closing preserves the draft",
    (await page
      .getByRole("slider", { name: "横向偏移", exact: true })
      .inputValue()) === "2",
  );
  await page.keyboard.press("Escape");
  check(
    "Escape closes the panel",
    !(await page.locator("#editor").isVisible()),
  );
  await page.click("#edit-toggle");
  await page.locator('[data-instance="board"]').focus();
  await page.keyboard.press("Enter");
  check(
    "scene selection updates the inspector",
    (await page
      .locator('#object-strip [data-object="board"]')
      .getAttribute("aria-pressed")) === "true",
  );
  await page.click("#save");
  await page.waitForFunction(() =>
    document.getElementById("toast").textContent.includes("布置已保存"),
  );
  check(
    "saving persists the draft",
    f.runtime.home.read("living").layout.objects.plant.dx === 2,
  );
  for (const [width, height] of [
    [1440, 900],
    [1280, 720],
    [1024, 768],
    [844, 390],
    [640, 512],
    [390, 844],
    [375, 667],
    [320, 568],
  ]) {
    await page.setViewportSize({ width, height });
    for (const route of ["living", "hall/1"]) {
      await go(route);
      if (route.startsWith("hall")) {
        const door = page.locator('[data-instance="door-agent-0"]');
        for (const trigger of ["hover", "focus"]) {
          if (trigger === "hover") await door.locator(".door-status").hover();
          else {
            await page.mouse.move(0, 0);
            await page.keyboard.press("Tab");
            await door.focus();
          }
          check(
            `door hint stays clear of status ${width} ${trigger}`,
            await door.evaluate((n) => {
              const hint = n.querySelector(".label"),
                status = n.querySelector(".door-status");
              const a = hint.getBoundingClientRect(),
                b = status.getBoundingClientRect();
              return (
                getComputedStyle(hint).visibility === "visible" &&
                a.bottom <= b.top &&
                a.left >= 0 &&
                a.right <= innerWidth
              );
            }),
          );
        }
        if (width === 1280)
          await page.screenshot({ path: path.join(output, "hall-hint.png") });
      }
      await page.click("#edit-toggle");
      await fits(`workspace fits ${width}x${height} ${route}`);
      const slider = page.getByRole("slider", { name: "大小", exact: true });
      await slider.scrollIntoViewIfNeeded();
      const previous = await page.locator("#stage").boundingBox();
      await slider.fill("0.9");
      await fits(`slider interaction retains visible scene ${width} ${route}`);
      const current = await page.locator("#stage").boundingBox();
      assert.equal(current.y, previous.y);
      if ((width === 1280 || width === 390) && route === "living")
        await page.screenshot({
          path: path.join(output, `editor-${width}.png`),
        });
      await page.click("#editor-more summary");
      await page.click("#discard");
      await page.waitForFunction(() => !document.getElementById("stage").inert);
      await fits(`discard keeps workspace usable ${width} ${route}`);
      await page.click("#editor-close");
    }
  }
  await go("hall/1");
  await page.locator('[data-instance="door-agent-0"] .door-status').click();
  await page.waitForFunction(
    () =>
      document.getElementById("stage").dataset.route === "#room/agent-0" &&
      !document.getElementById("stage").inert,
  );
  check(
    "private rooms keep the editor unavailable",
    !(await page.locator("#edit-toggle").isVisible()) &&
      !(await page.locator("#editor").isVisible()),
  );
  await go("living");
  await page.click("#edit-toggle");
  await page.evaluate(() => {
    sessionStorage.removeItem("qq-unified-token");
  });
  await page.click("#editor-more summary");
  await page.click("#discard");
  await page.waitForFunction(
    () => document.getElementById("home-content").hidden,
  );
  check(
    "login loss closes and clears the editor",
    !(await page.locator("#editor").isVisible()) &&
      (await page.locator("#object-editor").textContent()) === "",
  );
  check("no browser errors", errors.length === 0);
  await fs.writeFile(
    path.join(output, "report.json"),
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ passed: checks.length, errors, output }));
} finally {
  await browser.close();
  await app.close();
  for (const fn of cleanup.reverse()) await fn();
}
