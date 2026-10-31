/* global document, window */
import { chromium, webkit } from "playwright-core";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createGomokuFixture } from "../src/games/gomoku/server.mjs";
import { findScreenshotBrowser } from "../src/tools/public-screenshot.mjs";

const service = createGomokuFixture({ database: ":memory:" });
await service.listen();
const engine = process.argv.includes("--webkit") ? webkit : chromium;
const browser = await engine.launch({
  ...(engine === chromium ? { executablePath: findScreenshotBrowser() } : {}),
  headless: true,
});
try {
  const contexts = await Promise.all(
    [0, 1].map(() =>
      browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      }),
    ),
  );
  const [a, b] = await Promise.all(contexts.map((c) => c.newPage())),
    errors = [];
  let phase = "join";
  for (const page of [a, b]) {
    page.setDefaultTimeout(15000);
    page.on("pageerror", (e) => errors.push(`${phase}: ${e.message}`));
  }
  const join = async (page, url) => {
    await page.goto(url);
    await page.getByRole("button", { name: "确认加入", exact: true }).click();
    await page.waitForURL((url) => !url.searchParams.has("invite"));
  };
  const click = (page, name) =>
    page.getByRole("button", { name, exact: true }).click();
  const move = async (page, coordinate) => {
    await page
      .locator("#board")
      .getByRole("button", { name: `${coordinate} 空位`, exact: true })
      .click();
    await click(page, "确认落点");
    await page
      .locator("#board")
      .getByRole("button", { name: new RegExp(`^${coordinate} (黑子|白子)$`) })
      .waitFor();
  };
  const room = service.createRoom();
  // Preserve the binding cookie if the exchange never reaches the server, even across refresh.
  phase = "join-exchange-retry";
  let issuedInvites = 0;
  await a.route("**/join", async (route) => {
    if (route.request().postDataJSON().invite) {
      issuedInvites++;
      await route.continue();
    } else if (issuedInvites)
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "TEST_UNAVAILABLE" }),
      });
    else await route.continue();
  });
  await a.goto(room.invitations[0].url);
  await click(a, "确认加入");
  await a.waitForFunction(() =>
    document.getElementById("status").textContent.includes("操作未确认"),
  );
  await a.unroute("**/join");
  await a.reload();
  await a.route("**/join", async (route) => {
    if (route.request().postDataJSON().invite) issuedInvites++;
    await route.continue();
  });
  await click(a, "确认加入");
  await a.waitForURL((url) => !url.searchParams.has("invite"));
  assert.equal(issuedInvites, 1);
  await a.unroute("**/join");
  // A committed join must start polling even when its first view request fails.
  phase = "join-first-view-retry";
  let failedInitialView = false;
  await b.route("**/view", async (route) => {
    if (
      !failedInitialView &&
      service.kernel.store.room(room.roomId).participants[1].confirmed
    ) {
      failedInitialView = true;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "TEST_UNAVAILABLE" }),
      });
    } else await route.continue();
  });
  await join(b, room.invitations[1].url);
  await b.waitForFunction(() => !document.getElementById("game").hidden);
  assert.equal(failedInitialView, true);
  await b.unroute("**/view");
  await a.waitForFunction(
    () => document.getElementById("revision").textContent === "版本 2",
  );
  await a.locator("details summary").click();
  await click(a, "开始");
  await a.waitForFunction(
    () => document.getElementById("lifecycle").textContent === "对局进行中",
  );
  await a
    .locator("#board")
    .getByRole("button", { name: "H8 空位", exact: true })
    .click();
  assert.match(await a.locator("#selection").textContent(), /H8/);
  assert.equal(await a.locator("#zoom button").count(), 9);
  const target = await a.locator("#confirm").boundingBox();
  assert.ok(target.width >= 44 && target.height >= 44);
  await a.evaluate(() => window.dispatchEvent(new Event("orientationchange")));
  assert.equal(await a.locator("#confirm").isDisabled(), true);
  // Revision changes invalidate a previously selected coordinate.
  await a
    .locator("#board")
    .getByRole("button", { name: "H8 空位", exact: true })
    .click();
  const owner = service.kernel.actor("fixture-owner");
  const control = (type) =>
    service.kernel.act(room.roomId, owner, {
      actionId: randomUUID(),
      expectedRevision: service.kernel.store.room(room.roomId).revision,
      action: { type, payload: {} },
    });
  control("room.pause");
  await a.waitForFunction(
    () => document.getElementById("lifecycle").textContent === "已暂停",
  );
  assert.equal(await a.locator("#confirm").isDisabled(), true);
  control("room.resume");
  await a
    .locator("#board")
    .getByRole("button", { name: "H8 空位", exact: true })
    .click();
  phase = "delay";
  let delayedViews = 0;
  await a.route("**/view", async (route) => {
    delayedViews++;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await route.continue();
  });
  await a.waitForRequest((request) => request.url().endsWith("/view"));
  assert.equal(await a.locator("#confirm").isDisabled(), true);
  await a.waitForFunction(() => !document.getElementById("confirm").disabled);
  assert.equal(delayedViews, 1);
  await a.unroute("**/view");
  phase = "background";
  let hiddenRequests = 0;
  const countHidden = (request) => {
    if (request.url().endsWith("/view")) hiddenRequests++;
  };
  a.on("request", countHidden);
  await a.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await new Promise((resolve) => setTimeout(resolve, 3200));
  assert.equal(hiddenRequests, 0);
  assert.equal(await a.locator("#confirm").isDisabled(), true);
  a.off("request", countHidden);
  await a.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    document.dispatchEvent(new Event("visibilitychange"));
    delete document.hidden;
  });
  await a
    .locator("#board")
    .getByRole("button", { name: "H8 空位", exact: true })
    .click();
  if (process.env.GAME_ACCEPTANCE_SCREENSHOT)
    await a.screenshot({
      path: process.env.GAME_ACCEPTANCE_SCREENSHOT,
      fullPage: true,
    });
  phase = "lost-after";
  // Simulate a lost response after the database commits the action.
  await a.route("**/actions", async (route) => {
    await route.fetch();
    phase = "after-commit-abort";
    await route.abort();
  });
  await click(a, "确认落点");
  await a.waitForFunction(() =>
    document.getElementById("status").textContent.includes("操作未确认"),
  );
  phase = "before-reload";
  await a.unroute("**/actions");
  phase = "reload";
  await a.reload();
  phase = "reloaded";
  await a.waitForFunction(() => document.getElementById("retry").hidden);
  await b.waitForFunction(() =>
    document.getElementById("summary").textContent.includes("轮到你"),
  );
  assert.equal(
    service.kernel.store.room(room.roomId).state.board.filter(Boolean).length,
    1,
  );
  phase = "readonly";
  const readonly = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 390, height: 844 },
  });
  await readonly.addCookies(await contexts[0].cookies());
  const staticPage = await readonly.newPage();
  await staticPage.goto(
    new URL(`/rooms/${room.roomId}`, room.invitations[0].url).href,
  );
  assert.equal(
    await staticPage
      .locator("#board")
      .getByRole("button", { name: "H8 黑子", exact: true })
      .isDisabled(),
    true,
  );
  assert.match(await staticPage.locator("noscript").textContent(), /刷新快照/);
  await readonly.close();
  phase = "winning";
  for (const [white, black] of [
    ["A1", "H9"],
    ["C1", "H10"],
    ["E1", "H11"],
    ["G1", "H12"],
  ]) {
    await move(b, white);
    await move(a, black);
  }
  await b.waitForFunction(
    () => document.getElementById("lifecycle").textContent === "已结束",
  );
  assert.match(await a.locator("#summary").textContent(), /你获胜了/);
  assert.match(await b.locator("#summary").textContent(), /对方获胜了/);
  const winning = service.kernel.store.room(room.roomId);
  assert.equal(winning.state.board.filter(Boolean).length, 9);
  await b.reload();
  await b.waitForFunction(
    () => document.getElementById("status").textContent === "已同步。",
  );
  await b.setViewportSize({ width: 844, height: 390 });
  assert.equal(
    await b.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
    true,
  );
  await b.setViewportSize({ width: 375, height: 812 });
  assert.equal(
    await b.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
    true,
  );
  phase = "second-game";
  const next = service.createRoom();
  await join(a, next.invitations[0].url);
  await join(b, next.invitations[1].url);
  await a.waitForFunction(
    () => document.getElementById("revision").textContent === "版本 2",
  );
  await a.locator("details summary").click();
  await click(a, "开始");
  await a.waitForFunction(
    () => document.getElementById("lifecycle").textContent === "对局进行中",
  );
  phase = "lost-before";
  // A request lost before commit must be replayed using its original id and revision.
  let original;
  await a.route("**/actions", async (route) => {
    original = route.request().postDataJSON();
    await route.abort();
  });
  await a
    .locator("#board")
    .getByRole("button", { name: "O15 空位", exact: true })
    .click();
  assert.equal(await a.locator("#zoom button").count(), 9);
  await click(a, "确认落点");
  await a.waitForFunction(() =>
    document.getElementById("status").textContent.includes("操作未确认"),
  );
  await a.unroute("**/actions");
  await a.reload();
  await a.waitForFunction(() => !document.getElementById("retry").hidden);
  assert.equal(
    service.kernel.store.room(next.roomId).state.board.filter(Boolean).length,
    0,
  );
  await click(a, "查询待确认操作");
  await a.waitForFunction(() => document.getElementById("retry").hidden);
  assert.equal(
    service.kernel.receipt(next.roomId, owner, original.actionId).revision,
    4,
  );
  phase = "failed-sync";
  // Failed synchronization disables stale input; recovery uses the existing snapshot version.
  await b.route("**/view", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "TEST_UNAVAILABLE" }),
    }),
  );
  await b.waitForFunction(() =>
    document.getElementById("status").textContent.includes("操作未确认"),
  );
  assert.equal(await b.locator("#resign").isDisabled(), true);
  await b.unroute("**/view");
  await b.reload();
  await b.locator("details summary").click();
  await click(b, "我要认输");
  assert.equal(service.kernel.store.room(next.roomId).lifecycle, "active");
  await click(b, "确认认输");
  await b.waitForFunction(
    () => document.getElementById("lifecycle").textContent === "已结束",
  );
  assert.equal(
    service.kernel.store.room(next.roomId).outcome.reasonCode,
    "RESIGNED",
  );
  phase = "storage";
  // Storage-denied browsers retain read access without sending actions they cannot reconcile.
  const storagePage = await contexts[0].newPage();
  await storagePage.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw Error("storage denied");
    };
  });
  await storagePage.goto(
    new URL(`/rooms/${next.roomId}`, next.invitations[0].url).href,
  );
  await storagePage.waitForFunction(() =>
    document.getElementById("status").textContent.includes("已禁用提交"),
  );
  assert.equal(await storagePage.locator("#confirm").isDisabled(), true);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      browser: engine === webkit ? "webkit" : "chromium",
      mobile: true,
      joinExchangeRecovery: true,
      initialViewRecovery: true,
      fullGame: true,
      overlapGuard: true,
      orientation: true,
      backgroundEvents: true,
      revisionInvalidatesSelection: true,
      postCommitLoss: true,
      preCommitRetry: true,
      readonlySnapshot: true,
      resign: true,
      storageDenied: true,
    }),
  );
} finally {
  await browser.close();
  await service.close();
}
