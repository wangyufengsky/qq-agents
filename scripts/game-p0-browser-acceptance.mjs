// Playwright evaluates wait predicates inside the browser document.
/* global document */
import { chromium, webkit } from "playwright-core";
import { createP0Server } from "../src/games/p0-server.mjs";
import assert from "node:assert/strict";
import { findScreenshotBrowser } from "../src/tools/public-screenshot.mjs";
const service = createP0Server({ database: ":memory:" });
await service.listen();
const engine = process.argv.includes("--webkit") ? webkit : chromium;
const browser = await engine.launch({
  ...(engine === chromium ? { executablePath: findScreenshotBrowser() } : {}),
  headless: true,
});
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let releaseInitialSync;
  const initialSync = new Promise((resolve) => {
    releaseInitialSync = resolve;
  });
  await page.route("**/state", async (route) => {
    await initialSync;
    await route.continue();
  });
  await page.goto(service.createInvite().url);
  await page.getByRole("button", { name: "确认加入测试房间" }).click();
  await page.waitForURL((url) => !url.searchParams.has("invite"));
  await page.getByRole("button", { name: "H8 空位", exact: true }).click();
  assert.equal(
    await page.getByRole("button", { name: "确认落点" }).isDisabled(),
    true,
  );
  releaseInitialSync();
  await page.waitForFunction(() =>
    document.getElementById("connection")?.textContent.includes("已同步"),
  );
  await page.getByRole("button", { name: "H8 空位", exact: true }).click();
  await page.getByRole("button", { name: "取消选点" }).click();
  assert.equal(await page.locator("#revision").textContent(), "0");
  await page.getByRole("button", { name: "H8 空位", exact: true }).click();
  assert.equal(await page.locator("#zoom button").count(), 9);
  await page.getByRole("button", { name: "确认落点" }).click();
  await page.waitForFunction(
    () => document.getElementById("revision")?.textContent === "1",
  );
  await page.reload();
  await page.waitForFunction(() =>
    document.getElementById("connection")?.textContent.includes("已同步"),
  );
  assert.equal(await page.locator("#revision").textContent(), "1");
  // Commit succeeds but the browser loses its receipt; reload must reconcile once.
  await page.route("**/actions", async (route) => {
    await route.fetch();
    await route.abort();
  });
  await page.getByRole("button", { name: "I8 空位", exact: true }).click();
  await page.getByRole("button", { name: "确认落点" }).click();
  await page.waitForFunction(
    () => document.getElementById("revision")?.textContent === "2",
  );
  await page.unroute("**/actions");
  await page.reload();
  await page.waitForFunction(() =>
    document.getElementById("connection")?.textContent.includes("已同步"),
  );
  assert.equal(await page.locator("#revision").textContent(), "2");
  assert.equal(await page.locator("#retry").isVisible(), false);
  const nojs = await browser.newContext({
    javaScriptEnabled: false,
    storageState: await context.storageState(),
  });
  const snapshot = await nojs.newPage();
  await snapshot.goto(page.url());
  assert.match(
    await snapshot.locator("#connection").textContent(),
    /非实时快照/,
  );
  assert.equal(await snapshot.locator("#board button:disabled").count(), 225);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      engine: engine.name(),
      mobileViewport: "390x844",
      join: true,
      selectionCancel: true,
      delayedSyncDisablesSubmit: true,
      move: true,
      refresh: true,
      lostReceiptReconciled: true,
      noScriptSnapshot: true,
      pageErrors: errors,
    }),
  );
} finally {
  await browser.close();
  await service.close();
}
