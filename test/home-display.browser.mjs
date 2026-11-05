/* global document */
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { fixture, config, context } from "./helpers.mjs";
import { createServer } from "../src/server.mjs";
const cleanup = [],
  cfg = config();
cfg.agents[0].subject.enabled = true;
cfg.agents[0].home = { enabled: true, publishing: true };
const f = fixture({ after: (fn) => cleanup.push(fn) }, { cfg });
const ctx = context(f.runtime, "agent-0", "@subject"),
  call = (n, a = {}) => f.runtime.executeTool(ctx, n, a);
const read = await call("room_read"),
  tagline = "纸页上的门牌短语".repeat(8);
await call("room_publish", {
  identityGeneration: read.identityGeneration,
  requestId: "tagline-browser",
  expectedItemRevision: 0,
  slot: "tagline",
  title: "门牌",
  body: tagline,
  source: "original-text",
});
const app = createServer({
  runtime: f.runtime,
  token: "test-admin-token-placeholder",
});
const base = `http://127.0.0.1:${await app.listen()}`;
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH,
  headless: true,
});
try {
  const page = await browser.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + "/home-space/");
  await page.evaluate(() =>
    sessionStorage.setItem("qq-unified-token", "test-admin-token-placeholder"),
  );
  for (const width of [375, 390, 1440]) {
    await page.setViewportSize({ width, height: 950 });
    await page.goto(base + "/home-space/#hall");
    await page.reload();
    await page.waitForSelector('[data-instance="sign-agent-0"] .door-name');
    const sign = page.locator('[data-instance="sign-agent-0"] .door-name');
    assert.equal(
      await sign.getAttribute("title"),
      `测试角色 1 · ${tagline}`.replace(
        "测试角色 1",
        f.runtime.agent("agent-0").name,
      ),
    );
    assert.equal(await sign.textContent(), tagline);
    assert.ok(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth + 1,
      ),
    );
    await page.goto(base + "/home-space/#room/agent-0");
    await page.reload();
    await page.waitForSelector('[data-instance="nameplate"] .ink-nameplate');
    assert.equal(
      await page.locator(".ink-nameplate").getAttribute("title"),
      tagline,
    );
    assert.ok(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth + 1,
      ),
    );
    if (process.env.HOME_DISPLAY_SCREENSHOT && width === 375)
      await page.screenshot({
        path: process.env.HOME_DISPLAY_SCREENSHOT,
        fullPage: true,
      });
  }
  f.runtime.agent("agent-0").home.publishing = false;
  await page.reload();
  await page.waitForSelector(".ink-nameplate");
  assert.equal(
    (await page.locator("body").textContent()).includes(tagline),
    false,
  );
  assert.equal(errors.length, 0);
  assert.equal(f.runtime.jobs.size, 0);
  console.log(
    JSON.stringify({
      checks: [
        "long tagline full text accessible",
        "hall and room at 375/390/1440",
        "no horizontal overflow",
        "disabled publishing clears scene text",
        "no script errors or model jobs",
      ],
    }),
  );
} finally {
  await browser.close();
  await app.close();
  for (const fn of cleanup.reverse()) await fn();
}
