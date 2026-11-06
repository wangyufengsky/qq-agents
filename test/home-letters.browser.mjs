/* global document, window, getComputedStyle */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { fixture, config } from "./helpers.mjs";
import { createServer } from "../src/server.mjs";

if (!process.env.CHROME_PATH) throw Error("CHROME_PATH_REQUIRED");
const output =
  process.env.HOME_LETTERS_OUTPUT ||
  (await fs.mkdtemp(path.join(os.tmpdir(), "qq-home-letters-")));
await fs.mkdir(output, { recursive: true });
const cleanup = [],
  f = fixture({ after: (fn) => cleanup.push(fn) }, { cfg: config(3) });
const app = createServer({ runtime: f.runtime, token: "letters-test-token" });
const base = `http://127.0.0.1:${await app.listen()}`;
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH,
  headless: true,
});
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage(),
    errors = [],
    reads = [],
    lists = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const identities = [0, 1, 2].map((i) => ({
    agentId: `agent-${i}`,
    name: `住户${i}`,
    identityGeneration: `generation-${i}`,
  }));
  const visits = [
    {
      kind: "visit",
      id: "room-zero-letter",
      owner: identities[0],
      visitor: identities[1],
      state: "active",
      startedAt: 1793923200000,
    },
    {
      kind: "visit",
      id: "room-two-letter",
      owner: identities[2],
      visitor: identities[0],
      state: "ended",
      startedAt: 1793923200000,
    },
  ];
  let leaseMs = 15000,
    fail = false,
    hold = false,
    release,
    arrived;
  await context.route("**/api/home-social/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("overview")) {
      lists.push(Object.fromEntries(url.searchParams));
      const owner = url.searchParams.get("roomOwnerAgentId"),
        agent = url.searchParams.get("agentId");
      return route.fulfill({
        json: {
          items: visits.filter(
            (item) =>
              (!owner || item.owner.agentId === owner) &&
              (!agent ||
                [item.owner.agentId, item.visitor.agentId].includes(agent)),
          ),
        },
      });
    }
    assert.ok(
      url.pathname.endsWith("read"),
      "letters do not send or moderate automatically",
    );
    const request = route.request().postDataJSON();
    reads.push(request);
    if (hold)
      await new Promise((resolve) => {
        release = resolve;
        arrived();
      });
    if (fail)
      return route.fulfill({ status: 410, json: { error: "AUDIENCE_DENIED" } });
    const item = visits.find((visit) => visit.id === request.id);
    return route.fulfill({
      json: {
        ...item,
        revision: 1,
        policyRevision: 1,
        lease: { expiresAt: Date.now() + leaseMs },
        permittedActions: ["hide-message", "terminate-visit"],
        messages: request.cursor
          ? [
              {
                messageId: "page-two",
                author: identities[1],
                state: "committed",
                committedAt: 1793923200000,
                body: "SECOND_PAGE_PRIVATE",
              },
            ]
          : [
              {
                messageId: "first",
                messageRevision: 1,
                author: identities[0],
                state: "committed",
                committedAt: 1793923200000,
                body: "<img src=x onerror=alert(1)>信纸正文",
              },
              {
                messageId: "hidden",
                author: identities[1],
                state: "hidden",
                body: "HIDDEN_PRIVATE",
              },
              {
                messageId: "retracted",
                author: identities[0],
                state: "retracted",
                body: "RETRACTED_PRIVATE",
              },
            ],
        nextCursor: request.cursor ? null : "second-page",
      },
    });
  });
  await page.goto(base);
  await page.evaluate(() =>
    sessionStorage.setItem("qq-unified-token", "letters-test-token"),
  );
  await page.goto(base + "/home-space/#room/agent-0");
  await page.waitForFunction(
    () =>
      !document.getElementById("stage").inert &&
      document.getElementById("stage").dataset.route === "#room/agent-0",
  );
  assert.equal(await page.locator("#social-room-open").count(), 0);
  const wall = page.locator('[data-instance="envelope"]');
  for (const width of [375, 390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    const bounds = await wall.boundingBox();
    assert.ok(
      bounds.width >= 44 && bounds.height >= 44,
      `wall envelope tap target at ${width}px`,
    );
    await page.screenshot({
      path: path.join(output, `room-${width}.png`),
      fullPage: true,
    });
  }
  await wall.focus();
  await wall.press("Enter");
  await page.locator(".letter-envelope").waitFor();
  assert.equal(reads.length, 0, "envelopes only load metadata");
  assert.equal(await page.locator(".letter-envelope").count(), 1);
  assert.equal(lists.at(-1).roomOwnerAgentId, "agent-0");
  assert.equal(lists.at(-1).kind, "visit");
  assert.equal(lists.at(-1).agentId, undefined);
  assert.equal(
    await page.getByText("与住户2的往来", { exact: true }).count(),
    0,
  );
  assert.equal(
    await page.getByText("实例社交设置", { exact: true }).count(),
    0,
  );
  await page.screenshot({
    path: path.join(output, "letters-desktop.png"),
    fullPage: true,
  });
  await page.locator(".letter-envelope").focus();
  await page.locator(".letter-envelope").press("Space");
  await page.locator(".letter-paper").waitFor();
  assert.equal(
    await page
      .locator(".letter-paper")
      .evaluate((node) => getComputedStyle(node).animationName),
    "none",
  );
  assert.equal(
    await page
      .locator(".letter-title")
      .evaluate((node) => node === document.activeElement),
    true,
  );
  assert.equal(
    await page
      .getByText("<img src=x onerror=alert(1)>信纸正文", { exact: true })
      .count(),
    1,
  );
  assert.equal(await page.locator(".social-body img").count(), 0);
  assert.equal(
    await page.getByText("HIDDEN_PRIVATE", { exact: true }).count(),
    0,
  );
  assert.equal(
    await page.getByText("RETRACTED_PRIVATE", { exact: true }).count(),
    0,
  );
  assert.equal(
    await page.locator(".letter-metadata").getAttribute("open"),
    null,
  );
  for (const width of [1440, 375, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.ok(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth + 1,
      ),
      `letter fits ${width}px`,
    );
    await page.screenshot({
      path: path.join(output, `letter-${width}.png`),
      fullPage: true,
    });
  }
  leaseMs = 500;
  await page.getByRole("button", { name: "继续读下一页", exact: true }).click();
  await page.getByText("SECOND_PAGE_PRIVATE", { exact: true }).waitFor();
  assert.equal(
    await page
      .locator(".letter-title")
      .evaluate((node) => node === document.activeElement),
    true,
  );
  await page.getByText("正文验证已到期", { exact: false }).waitFor();
  assert.equal(
    await page.getByText("SECOND_PAGE_PRIVATE", { exact: true }).count(),
    0,
  );
  const beforeReload = lists.length;
  await page.getByRole("button", { name: "重新读取信件", exact: true }).click();
  await page.locator(".letter-envelope").waitFor();
  assert.equal(lists.length, beforeReload + 1);
  leaseMs = 15000;
  await page.locator(".letter-envelope").click();
  await page.locator(".letter-paper").waitFor();
  await page.getByRole("button", { name: "收起信纸", exact: true }).click();
  await page.waitForFunction(() =>
    document.activeElement.matches(
      '.letter-envelope[data-letter-id="room-zero-letter"]',
    ),
  );
  await page.keyboard.press("Escape");
  await page.waitForFunction(() =>
    document.activeElement.matches('[data-instance="envelope"], #entry-toggle'),
  );
  await page.locator("#menu-toggle").click();
  await page.locator("#social-open").click();
  await page.getByText("实例社交设置", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await wall.click();
  const waiting = new Promise((resolve) => {
    arrived = resolve;
  });
  hold = true;
  await page.locator(".letter-envelope").click();
  await waiting;
  await page.keyboard.press("Escape");
  release();
  hold = false;
  await page.waitForTimeout(100);
  assert.equal(await page.locator("#reader-content").textContent(), "");
  await page.goto(base + "/home-space/#room/agent-1");
  await page.waitForFunction(
    () =>
      !document.getElementById("stage").inert &&
      document.getElementById("stage").dataset.route === "#room/agent-1",
  );
  await page.locator('[data-instance="envelope"]').click();
  await page.getByText("信封里还没有来信。", { exact: true }).waitFor();
  assert.equal(await page.locator(".letter-envelope").count(), 0);
  await page.keyboard.press("Escape");

  // A plain console-sized container needs only letters.css, not the home theme.
  await page.route("**/letters-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/home-space/letters.css"></head><body><main id="fixture"></main></body></html>',
    }),
  );
  await page.goto(base + "/letters-fixture");
  await page.evaluate(async () => {
    const { createSocialView } = await import("/home-space/social.mjs");
    window.letters = createSocialView({
      root: document.getElementById("fixture"),
      presentation: "letters",
      agentId: "agent-0",
      isActive: () => true,
      api: async (url, body) => {
        const response = await fetch(url, {
          method: body ? "POST" : "GET",
          body: body && JSON.stringify(body),
        });
        if (!response.ok) throw Error("READ_DENIED");
        return response.json();
      },
    });
    await window.letters.render();
  });
  assert.equal(lists.at(-1).agentId, "agent-0");
  assert.equal(lists.at(-1).roomOwnerAgentId, undefined);
  assert.equal(await page.locator(".letter-envelope").count(), 2);
  fail = true;
  await page.locator(".letter-envelope").first().click();
  await page.getByText("已隐藏旧正文", { exact: false }).waitFor();
  await page.evaluate(() => window.letters.close());
  assert.equal(await page.locator("#fixture").textContent(), "");
  assert.equal(await page.locator(".social-letters").count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    `home letters browser: room owner filter, keyboard, paper layout, tombstones, lease and disposal passed; screenshots ${output}`,
  );
} finally {
  await browser.close();
  await app.close();
  for (const close of cleanup.reverse()) await close();
}
