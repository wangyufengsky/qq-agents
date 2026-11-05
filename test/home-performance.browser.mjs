/* global document, getComputedStyle, Element */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { fixture, config } from "./helpers.mjs";
import { createServer } from "../src/server.mjs";
import { catalog } from "../public/home-preview/catalog.mjs";

if (!process.env.CHROME_PATH) throw Error("CHROME_PATH_REQUIRED");
const output =
  process.env.HOME_PERFORMANCE_OUTPUT ||
  (await fs.mkdtemp(path.join(os.tmpdir(), "home-performance-")));
await fs.mkdir(output, { recursive: true });
const cleanup = [],
  f = fixture({ after: (fn) => cleanup.push(fn) }, { cfg: config(7) });
const token = "test-admin-token-placeholder",
  app = createServer({ runtime: f.runtime, token });
const base = `http://127.0.0.1:${await app.listen()}`;
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH,
  headless: true,
});
const checks = [],
  results = [];
const check = (name, value) => {
  assert.ok(value, name);
  checks.push(name);
};
async function ready(page, route) {
  await page.waitForFunction((hash) => {
    const stage = document.getElementById("stage");
    return (
      !document.getElementById("home-content").hidden &&
      stage.dataset.route === hash &&
      !stage.inert &&
      !stage.hasAttribute("aria-busy")
    );
  }, route);
}
function contrast(a, b) {
  const luminance = (rgb) =>
    rgb
      .map((v) => {
        v /= 255;
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      })
      .reduce((n, v, i) => n + v * [0.2126, 0.7152, 0.0722][i], 0);
  const x = luminance(a),
    y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
try {
  for (const scenario of [
    { name: "desktop", width: 1440, height: 900, cpu: 1, reduced: false },
    { name: "phone375", width: 375, height: 812, cpu: 1, reduced: false },
    {
      name: "phone390-reduced-cpu4",
      width: 390,
      height: 844,
      cpu: 4,
      reduced: true,
    },
  ]) {
    const context = await browser.newContext({
      viewport: { width: scenario.width, height: scenario.height },
      reducedMotion: scenario.reduced ? "reduce" : "no-preference",
    });
    await context.addInitScript(
      (value) => sessionStorage.setItem("qq-unified-token", value),
      token,
    );
    await context.addInitScript(() => {
      const original = Element.prototype.animate;
      globalThis.homeAnimationCount = 0;
      Element.prototype.animate = function (...args) {
        globalThis.homeAnimationCount++;
        return original.apply(this, args);
      };
    });
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: scenario.cpu });
    await page.goto(base + "/home-space/");
    await ready(page, "#living");
    const interactiveMs = await page.evaluate(() => performance.now());
    await page.evaluate(() => document.fonts.ready);
    await page
      .locator("#stage img")
      .evaluateAll((imgs) => Promise.all(imgs.map((i) => i.decode())));
    check(
      `${scenario.name}: all current images decode successfully`,
      await page
        .locator("#stage img")
        .evaluateAll(
          (imgs) =>
            imgs.length > 0 &&
            imgs.every((i) => i.complete && i.naturalWidth > 0),
        ),
    );
    check(
      `${scenario.name}: the intended font is loaded`,
      await page.evaluate(
        () =>
          [...document.fonts].some(
            (font) =>
              font.family === "Paper Nest Hand" && font.status === "loaded",
          ) &&
          performance
            .getEntriesByType("resource")
            .some((r) => r.name.endsWith(".woff2") && r.encodedBodySize > 0),
      ),
    );
    const cold = await page.evaluate(() => {
      const resources = performance.getEntriesByType("resource");
      return {
        readyMs: performance.now(),
        resources: resources.map((r) => ({
          path: new URL(r.name).pathname,
          bytes: r.encodedBodySize,
          transferred: r.transferSize,
        })),
      };
    });
    check(
      `${scenario.name}: first page does not load every furniture variant`,
      cold.resources.filter((r) => r.path.includes("/assets/")).length <
        Object.keys(catalog).length,
    );
    check(
      `${scenario.name}: cold page remains within the measured 12 MiB resource budget`,
      cold.resources.reduce((n, r) => n + r.bytes, 0) < 12 * 1024 * 1024,
    );
    const transitions = [];
    for (const [selector, route] of [
      ["#bookmark-hall", "#hall/1"],
      ['[data-instance="sign-agent-0"]', "#room/agent-0"],
      ["#page-back", "#hall/1"],
      ["#bookmark-living", "#living"],
    ]) {
      const before = performance.now();
      await page.click(selector);
      await ready(page, route);
      transitions.push({ route, ms: Math.round(performance.now() - before) });
      check(
        `${scenario.name}: ${route} has no horizontal overflow`,
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth,
        ),
      );
    }
    await page.click("#bookmark-hall");
    await ready(page, "#hall/1");
    const colors = await page.evaluate(() => {
      const rgba = (s) => s.match(/[\d.]+/g).map(Number);
      const background = (node) => {
        if (!node) return [255, 255, 255];
        const [r, g, b, a = 1] = rgba(getComputedStyle(node).backgroundColor);
        return a === 1
          ? [r, g, b]
          : background(node.parentElement).map(
              (v, i) => v * (1 - a) + [r, g, b][i] * a,
            );
      };
      const original = document.body.className,
        pairs = [];
      for (const palette of ["cream", "blue", "rose"]) {
        document.body.className = `palette-${palette}`;
        for (const selector of [
          "#bookmark-living",
          "#bookmark-hall",
          "#entry-toggle",
        ]) {
          const node = document.querySelector(selector),
            s = getComputedStyle(node);
          pairs.push({
            selector: `${palette} ${selector}`,
            foreground: rgba(s.color).slice(0, 3),
            background: background(node),
          });
        }
      }
      document.body.className = original;
      return pairs;
    });
    for (const pair of colors) {
      const ratio = contrast(pair.foreground, pair.background);
      pair.ratio = Number(ratio.toFixed(2));
      check(
        `${scenario.name}: ${pair.selector} text contrast meets 4.5:1`,
        ratio >= 4.5,
      );
    }
    await page.keyboard.press("Tab");
    const focus = await page.evaluate(() => {
      const s = getComputedStyle(document.activeElement);
      return {
        width: parseFloat(s.outlineWidth),
        style: s.outlineStyle,
        label:
          document.activeElement.getAttribute("aria-label") ||
          document.activeElement.textContent,
      };
    });
    check(
      `${scenario.name}: keyboard focus has a visible outline and name`,
      focus.width >= 2 && focus.style !== "none" && focus.label.trim(),
    );
    check(
      `${scenario.name}: page-turn creation follows the reduced motion preference`,
      await page.evaluate(
        (reduced) =>
          reduced
            ? globalThis.homeAnimationCount === 0
            : globalThis.homeAnimationCount > 0,
        scenario.reduced,
      ),
    );
    await page.screenshot({
      path: path.join(output, `${scenario.name}.png`),
      fullPage: true,
    });
    const warmStart = await page.evaluate(
      () => performance.getEntriesByType("resource").length,
    );
    await page.click("#bookmark-living");
    await ready(page, "#living");
    await page.click("#bookmark-hall");
    await ready(page, "#hall/1");
    const warmAssetBytes = await page.evaluate(
      (start) =>
        performance
          .getEntriesByType("resource")
          .slice(start)
          .filter(
            (r) => r.name.includes("/assets/") || r.name.endsWith(".woff2"),
          )
          .reduce((n, r) => n + r.transferSize, 0),
      warmStart,
    );
    check(
      `${scenario.name}: repeated navigation reuses loaded art and font`,
      warmAssetBytes === 0,
    );
    results.push({
      ...scenario,
      interactiveMs: Math.round(interactiveMs),
      fullFontAndArtMs: Math.round(cold.readyMs),
      encodedBytes: cold.resources.reduce((n, r) => n + r.bytes, 0),
      fontBytes: cold.resources
        .filter((r) => r.path.endsWith(".woff2"))
        .reduce((n, r) => n + r.bytes, 0),
      imageCount: cold.resources.filter((r) => r.path.includes("/assets/"))
        .length,
      warmAssetBytes,
      transitions,
      contrast: colors,
    });
    check(`${scenario.name}: no browser errors`, errors.length === 0);
    await context.close();
  }
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 },
    reducedMotion: "reduce",
  });
  await context.addInitScript(
    (value) => sessionStorage.setItem("qq-unified-token", value),
    token,
  );
  await context.route("**/*.woff2", (r) => r.abort());
  await context.route("**/assets/door.webp", (r) => r.abort());
  const page = await context.newPage();
  await page.goto(base + "/home-space/#hall/1");
  await ready(page, "#hall/1");
  await page.locator(".missing-object").first().waitFor();
  check(
    "missing art is named and preserves door navigation",
    await page
      .locator('[data-instance="door-agent-0"]')
      .getAttribute("aria-label"),
  );
  await page.locator('[data-instance="door-agent-0"]').focus();
  await page.keyboard.press("Enter");
  await ready(page, "#room/agent-0");
  check(
    "the missing door itself still activates from the keyboard",
    (await page.locator("#stage").getAttribute("data-route")) ===
      "#room/agent-0",
  );
  await page.click("#page-back");
  await ready(page, "#hall/1");
  await page.click('[data-instance="sign-agent-0"]');
  await ready(page, "#room/agent-0");
  await page.click("#entry-toggle");
  check(
    "font and art failure preserve text entry points",
    (await page.locator("#scene-actions button").count()) >= 4,
  );
  check(
    "browsing never schedules a model or sends QQ",
    f.runtime.jobs.size === 0 &&
      [...f.runtime.transports.values()].every((tr) => tr.sent.length === 0),
  );
  await context.close();
  await fs.writeFile(
    path.join(output, "report.json"),
    JSON.stringify(
      {
        synthetic: true,
        network: "local loopback; no mobile network emulation",
        checks,
        scenarios: results,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({ passed: checks.length, scenarios: results }, null, 2),
  );
} finally {
  await browser.close();
  await app.close();
  for (const fn of cleanup.reverse()) await fn();
}
