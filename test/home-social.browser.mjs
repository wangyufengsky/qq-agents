/* global document */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { chromium } from "playwright-core";
import { fixture, config } from "./helpers.mjs";
import { createServer } from "../src/server.mjs";

if (!process.env.CHROME_PATH) throw Error("CHROME_PATH_REQUIRED");
const cleanup = [],
  f = fixture({ after: (fn) => cleanup.push(fn) }, { cfg: config(2) });
const app = createServer({
  runtime: f.runtime,
  token: "social-test-token",
  allowLive: true,
});
const base = `http://127.0.0.1:${await app.listen()}`;
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH,
  headless: true,
});
try {
  const context = await browser.newContext({
    viewport: { width: 375, height: 900 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage(),
    errors = [],
    operations = [];
  page.on("pageerror", (e) => errors.push(e.message));
  for (const name of ["social.mjs", "social.css"])
    await page.route(`**/home-space/${name}`, async (route) =>
      route.fulfill({
        contentType: name.endsWith("mjs") ? "text/javascript" : "text/css",
        body: await fs.readFile(
          new URL(`../public/home-space/${name}`, import.meta.url),
          "utf8",
        ),
      }),
    );
  let failed = false,
    release,
    arrived;
  const waiting = new Promise((resolve) => {
    arrived = resolve;
  });
  await page.route("**/api/home-social/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("overview"))
      return route.fulfill({
        json: {
          items: [
            {
              kind: "visit",
              id: "visit-1",
              owner: { name: "房主甲" },
              visitor: { name: "访客乙" },
              state: "active",
              expiresAt: Date.now() + 60000,
            },
          ],
        },
      });
    if (path.endsWith("moderate")) {
      operations.push(route.request().postDataJSON());
      return route.fulfill({ json: { changed: true } });
    }
    if (failed)
      return route.fulfill({ status: 410, json: { error: "VISIT_CLOSED" } });
    if (release === "hold") {
      await new Promise((resolve) => {
        release = resolve;
        arrived();
      });
    }
    const cursor = route.request().postDataJSON()?.cursor;
    return route.fulfill({
      json: {
        id: "visit-1",
        revision: 1,
        policyRevision: 1,
        owner: { name: "房主甲", identityGeneration: "host-gen" },
        visitor: { name: "访客乙", identityGeneration: "guest-gen" },
        state: "expired",
        expiresAt: Date.now() - 1000,
        grantExpiresAt: Date.now() - 2000,
        lease: { expiresAt: Date.now() + 1200 },
        permittedActions: ["terminate-visit", "hide-message"],
        effectiveScope: [],
        messages: [
          {
            messageId: "m-1",
            messageRevision: 1,
            author: { name: "访客乙" },
            committedAt: Date.now(),
            state: "committed",
            body: cursor
              ? "NEXT_PAGE_PRIVATE"
              : "<img src=x onerror=alert(1)>真实消息",
          },
        ],
        nextCursor: cursor ? null : "messages-page-2",
        usage: {
          windowTurns: { used: 2, reserved: 1, limit: 12 },
          windowResources: {
            used: 0,
            reserved: 0,
            limit: null,
            usageAvailable: false,
            unit: "tokens",
          },
          asyncResources: {
            used: 300,
            reserved: 100,
            limit: null,
            limits: { perTurn: 1047676, perDay: 3143028 },
            unit: "tokens",
          },
          dailyMessages: {
            committed: 1,
            limit: 40,
            byParticipant: [
              { identityGeneration: "host-gen", committed: 1, limit: 20 },
              { identityGeneration: "guest-gen", committed: 0, limit: 20 },
            ],
            resetsAt: Date.now() + 60000,
          },
        },
      },
    });
  });
  await page.goto(base);
  await page.evaluate(() =>
    sessionStorage.setItem("qq-unified-token", "social-test-token"),
  );
  await page.goto(base + "/home-space/#room/agent-0");
  await page.locator("#home-content").waitFor({ state: "visible" });
  await page.locator("#menu-toggle").click();
  await page.locator("#social-open").click();
  await page.getByRole("button", { name: "核验权限并查看详情" }).click();
  await page
    .getByText("<img src=x onerror=alert(1)>真实消息", { exact: true })
    .waitFor();
  assert.equal(await page.locator("#reader-content img").count(), 0);
  assert.equal(
    await page.getByRole("button", { name: /接受邀请|发送消息/ }).count(),
    0,
  );
  assert.ok(await page.getByText("本时段模型回合", { exact: true }).count());
  assert.ok(await page.getByText("每日成功消息", { exact: true }).count());
  assert.ok(
    await page.getByText("后端未提供可信用量", { exact: false }).count(),
  );
  assert.ok(
    await page.getByText("未设 token 硬上限", { exact: false }).count(),
  );
  assert.ok(
    await page
      .getByText("累计值不与每日上限直接比较", { exact: false })
      .count(),
  );
  assert.ok(
    await page
      .getByText("房主甲：每日1 / 20条成功消息", { exact: true })
      .count(),
  );
  for (const width of [320, 375, 390]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth + 1,
      ),
      `room and social dialog fit ${width}px`,
    );
  }
  await page
    .getByRole("button", { name: "下一页消息（重新核验权限）", exact: true })
    .click();
  await page.getByText("NEXT_PAGE_PRIVATE", { exact: true }).waitFor();
  await page.getByText("正文验证已到期", { exact: false }).waitFor();
  assert.equal(
    await page.getByText("NEXT_PAGE_PRIVATE", { exact: true }).count(),
    0,
  );
  assert.equal(
    await page
      .getByText("<img src=x onerror=alert(1)>真实消息", { exact: true })
      .count(),
    0,
  );
  await page.getByRole("button", { name: "往来管理", exact: false }).count();
  await page.locator("#close-reader").click();
  await page.locator("#menu-toggle").click();
  await page.locator("#social-open").click();
  release = "hold";
  await page.getByRole("button", { name: "核验权限并查看详情" }).click();
  await waiting;
  await page.locator("#close-reader").click();
  release();
  await page.waitForTimeout(100);
  assert.equal(await page.locator("#reader-content").textContent(), "");
  await page.locator("#menu-toggle").click();
  await page.locator("#social-open").click();
  await page.getByText("实例社交设置", { exact: true }).click();
  await page.getByRole("button", { name: "读取当前设置", exact: true }).click();
  await page.locator('input[name="durationMinutes"]').fill("11");
  let configFailure = "CONFIG_CONFLICT",
    saves = 0;
  await page.route("**/api/config", async (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON();
      saves++;
      assert.ok(body.revision);
      assert.equal(body.config.homeSocial.durationMinutes, 11);
      if (saves === 2) {
        assert.equal(body.config.homeSocial.exchangeEnabled, true);
        assert.equal(body.config.homeSocial.resourceBudget, null);
      }
      return route.fulfill({
        status: configFailure === "CONFIG_CONFLICT" ? 409 : 400,
        json: { error: configFailure },
      });
    }
    return route.continue();
  });
  await page.getByRole("button", { name: "保存实例设置", exact: true }).click();
  await page
    .getByText("配置已有新版本，草稿已保留。", { exact: false })
    .waitFor();
  assert.equal(
    await page.locator('input[name="durationMinutes"]').inputValue(),
    "11",
  );
  assert.equal(
    await page.locator('select[name="budgetMode"]').inputValue(),
    "unconfigured",
  );
  assert.equal(
    await page.locator('input[name="maxInputTokensPerInference"]').inputValue(),
    "",
  );
  assert.equal(await page.locator('input[name="maxTurns"]').inputValue(), "12");
  await page.locator('input[name="enabled"]').check();
  await page.locator('input[name="exchangeEnabled"]').check();
  const before = saves;
  const noBudgetSave = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/config") &&
      response.request().method() === "PUT",
  );
  await page.getByRole("button", { name: "保存实例设置", exact: true }).click();
  await noBudgetSave;
  await page
    .getByText("配置已有新版本，草稿已保留。", { exact: false })
    .waitFor();
  assert.equal(saves, before + 1);
  assert.ok(
    await page.getByText("一方运行一次计 1 回合", { exact: false }).count(),
  );
  assert.ok(
    await page
      .getByText("同一时段各自接着自己的会话聊", { exact: false })
      .count(),
  );
  await page.locator('select[name="budgetMode"]').selectOption("configured");
  for (const [key, value] of Object.entries({
    maxInputTokensPerInference: 1047576,
    maxOutputTokensPerInference: 100,
    maxTokensPerTurn: 1047676,
    maxTokensPerWindow: 2095352,
    maxTokensPerDay: 3143028,
    maxInferencesPerTurn: 2,
  }))
    await page.locator(`input[name="${key}"]`).fill(String(value));
  configFailure = "CONFIG_SCHEMA_INVALID";
  await page.getByRole("button", { name: "保存实例设置", exact: true }).click();
  await page.getByText("服务端拒绝配置：", { exact: false }).waitFor();
  assert.equal(
    await page.locator('input[name="maxTokensPerTurn"]').inputValue(),
    "1047676",
  );
  assert.ok(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth + 1,
    ),
  );
  await page.locator("#close-reader").click();
  await page.locator("#menu-toggle").click();
  await page.locator("#social-open").click();
  failed = true;
  await page.getByRole("button", { name: "核验权限并查看详情" }).click();
  await page.locator("#gate").waitFor({ state: "visible" });
  assert.equal(await page.locator("#reader-content").textContent(), "");
  assert.equal(operations.length, 0);
  assert.deepEqual(errors, []);
  console.log(
    "home social browser: literal rendering, permissions, separate counters, mobile, lease, stale response and 410 checks passed",
  );
} finally {
  await browser.close();
  await app.close();
  for (const fn of cleanup.reverse()) await fn();
}
