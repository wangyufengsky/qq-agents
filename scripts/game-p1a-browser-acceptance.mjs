/* global document */
import { chromium, webkit } from "playwright-core";
import assert from "node:assert/strict";
import { createP1aFixture } from "../src/games/fixtures/server.mjs";
import { findScreenshotBrowser } from "../src/tools/public-screenshot.mjs";
import { secret } from "../src/games/core/value.mjs";

const service = createP1aFixture({ database: ":memory:" });
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
  const pages = await Promise.all(contexts.map((c) => c.newPage())),
    room = service.createRoom(),
    errors = [];
  for (const [index, page] of pages.entries()) {
    page.setDefaultTimeout(10000);
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(room.invitations[index].url);
    await page.getByRole("button", { name: "确认加入", exact: true }).click();
    await page.waitForURL((url) => !url.searchParams.has("invite"));
    if (index === 0) {
      await page.getByRole("button", { name: "开始", exact: true }).click();
      await page.waitForFunction(() =>
        document
          .getElementById("status")
          .textContent.includes("操作已拒绝：ROOM_NOT_READY"),
      );
      assert.equal(
        await page
          .getByRole("button", { name: "查询待确认操作", exact: true })
          .isVisible(),
        false,
      );
    }
  }
  const [a, b] = pages;
  const owner = service.kernel.actor("fixture-owner"),
    participant = service.kernel.store.room(room.roomId).participants[0];
  const rotated = service.identity.invite(
      room.roomId,
      owner,
      participant.participantId,
    ),
    browserSecret = secret();
  const challenge = service.identity.request(
    room.roomId,
    rotated.bindingId,
    rotated.invite,
    browserSecret,
  );
  service.identity.confirm(
    room.roomId,
    rotated.bindingId,
    challenge.challenge,
    owner,
  );
  service.identity.exchange(room.roomId, rotated.bindingId, browserSecret);
  const renewed = service.identity.invite(
    room.roomId,
    owner,
    participant.participantId,
  );
  const newUrl = new URL(room.invitations[0].url);
  newUrl.searchParams.set("binding", renewed.bindingId);
  newUrl.searchParams.set("invite", renewed.invite);
  await a.goto(newUrl.href);
  await a.getByRole("button", { name: "确认加入", exact: true }).click();
  await a.waitForURL((url) => !url.searchParams.has("invite"));
  await a.waitForFunction(
    () =>
      JSON.parse(document.getElementById("snapshot").textContent).revision ===
      2,
  );
  await a.getByRole("button", { name: "开始", exact: true }).click();
  await a.waitForFunction(
    () =>
      JSON.parse(document.getElementById("snapshot").textContent).lifecycle ===
      "active",
  );
  await a.getByRole("button", { name: "太阳", exact: true }).click();
  // Lose the response after commit; a refresh must reconcile the same action exactly once.
  await a.route("**/actions", async (route) => {
    await route.fetch();
    await route.abort();
  });
  await a.getByRole("button", { name: "确认选择", exact: true }).click();
  await a.waitForFunction(() =>
    document.getElementById("status").textContent.includes("操作未确认"),
  );
  await a.unroute("**/actions");
  await a.reload();
  await a.getByRole("button", { name: "查询待确认操作", exact: true }).click();
  await a.waitForFunction(
    () => document.getElementById("status").textContent === "操作已确认。",
  );
  await b.waitForFunction(
    () =>
      JSON.parse(document.getElementById("snapshot").textContent).view
        ?.canChoose === true,
  );
  const hidden = JSON.parse(await b.locator("#snapshot").textContent());
  assert.equal(hidden.view.revealed, null);
  assert.equal(hidden.view.ownChoice, null);
  await b.getByRole("button", { name: "太阳", exact: true }).click();
  await b.getByRole("button", { name: "确认选择", exact: true }).click();
  await b.waitForFunction(
    () =>
      JSON.parse(document.getElementById("snapshot").textContent).lifecycle ===
      "finished",
  );
  await b.reload();
  await b.waitForFunction(
    () => document.getElementById("status").textContent === "已同步。",
  );
  const finished = JSON.parse(await b.locator("#snapshot").textContent());
  assert.equal(finished.revision, 5);
  assert.equal(finished.view.result.winners.length, 2);
  assert.equal(
    await b.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
    true,
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      browser: engine === webkit ? "webkit" : "chromium",
      joined: 2,
      staleCookieRejoin: true,
      hiddenChoice: true,
      uncertainReceiptRecovered: true,
      refresh: true,
      sharedWin: true,
      mobileWidth: true,
    }),
  );
} finally {
  await browser.close();
  await service.close();
}
