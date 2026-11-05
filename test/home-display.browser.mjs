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
  const hall = await browser.newPage({ viewport: { width: 390, height: 950 } });
  await hall.goto(base + "/home-space/");
  await hall.evaluate(() =>
    sessionStorage.setItem("qq-unified-token", "test-admin-token-placeholder"),
  );
  await hall.goto(base + "/home-space/#hall");
  await hall.reload();
  await hall.waitForSelector('[data-instance="sign-agent-0"] .door-name');
  const screens = [
    {
      page: hall,
      selector: '[data-instance="sign-agent-0"] .door-name',
      type: "hall",
    },
    { page, selector: ".ink-nameplate", type: "room" },
  ];
  const origins = await Promise.all(
    screens.map((screen) => screen.page.evaluate(() => performance.timeOrigin)),
  );
  const revisions = screens.map(
    (screen) =>
      f.runtime.home.read(
        screen.type,
        screen.type === "room" ? "agent-0" : undefined,
      ).layoutRevision,
  );
  let operation = 0;
  async function publishTagline(body) {
    const view = await call("room_read");
    return call("room_publish", {
      identityGeneration: view.identityGeneration,
      requestId: `poll-publish-${++operation}`,
      slot: "tagline",
      expectedItemRevision: view.items.find((item) => item.slot === "tagline")
        .itemRevision,
      title: "门牌",
      body,
      source: "original-text",
    });
  }
  async function expectPolled(expected, removed) {
    await Promise.all(
      screens.map(async (screen, index) => {
        await screen.page.waitForFunction(
          ({ selector, expected }) =>
            document.querySelector(selector)?.textContent === expected,
          { selector: screen.selector, expected },
          { timeout: 16000 },
        );
        assert.equal(
          await screen.page.evaluate(() => performance.timeOrigin),
          origins[index],
        );
        assert.equal(
          f.runtime.home.read(
            screen.type,
            screen.type === "room" ? "agent-0" : undefined,
          ).layoutRevision,
          revisions[index],
        );
        if (removed)
          assert.equal(
            (await screen.page.locator("#stage").innerHTML()).includes(removed),
            false,
          );
      }),
    );
  }
  const firstPoll = "已打开页面时发布的新门牌";
  await publishTagline(firstPoll);
  await expectPolled(firstPoll, tagline);
  const current = await call("room_read");
  await call("room_retract", {
    identityGeneration: current.identityGeneration,
    requestId: "poll-retract",
    slot: "tagline",
    expectedItemRevision: current.items.find((item) => item.slot === "tagline")
      .itemRevision,
  });
  await expectPolled(f.runtime.agent("agent-0").name, firstPoll);
  const hiddenPoll = "即将被管理员隐藏的门牌";
  await publishTagline(hiddenPoll);
  await expectPolled(hiddenPoll);
  const beforeHide = await call("room_read");
  f.runtime.home.rooms.moderate("agent-0", {
    identityGeneration: beforeHide.identityGeneration,
    requestId: "poll-admin-hide",
    slot: "tagline",
    expectedItemRevision: beforeHide.items.find(
      (item) => item.slot === "tagline",
    ).itemRevision,
    action: "hide",
  });
  await expectPolled(f.runtime.agent("agent-0").name, hiddenPoll);
  // Unavailable reads must clear the complete scene even when its saved layout did not change.
  await Promise.all(
    screens.map((screen) =>
      screen.page.route("**/api/home/**", (route) => route.abort()),
    ),
  );
  await Promise.all(
    screens.map(async (screen) => {
      await screen.page.waitForFunction(
        () => document.getElementById("home-content").hidden,
        null,
        { timeout: 17000 },
      );
      assert.equal(await screen.page.locator("#stage").innerHTML(), "");
    }),
  );
  await hall.close();
  await page.unroute("**/api/home/**");
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
        "open hall and room poll publication, withdrawal and moderation without navigation or layout changes",
        "unavailable scene reads clear both open pages",
        "no script errors or model jobs",
      ],
    }),
  );
} finally {
  await browser.close();
  await app.close();
  for (const fn of cleanup.reverse()) await fn();
}
