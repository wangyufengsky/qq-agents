/* global document */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright-core";
import { createServer } from "../src/server.mjs";
import { context, config, fixture } from "./helpers.mjs";

test("paper pages take an open draft through overlapping writes, notes and library reading", async (t) => {
  const executablePath = process.env.QQ_TEST_STORY_BROWSER;
  assert.ok(
    executablePath,
    "Set QQ_TEST_STORY_BROWSER to a Chromium executable",
  );
  const cfg = config(1);
  cfg.agents[0].subject.enabled = true;
  cfg.agents[0].tools.push("story_circle");
  const { runtime } = fixture(t, { cfg });
  const token = randomUUID();
  const server = createServer({ runtime, token, allowLive: true });
  t.after(() => server.close());
  const url = `http://127.0.0.1:${await server.listen()}`;
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const session = await browser.newContext({
    viewport: { width: 1280, height: 820 },
  });
  await session.addInitScript(
    (token) => sessionStorage.setItem("qq-unified-token", token),
    token,
  );
  const page = await session.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url + "/home-space/");
  await page.getByRole("link", { name: "故事会" }).click();
  await page.getByRole("button", { name: "＋ 开一本书" }).click();
  await page.getByLabel("书名", { exact: true }).fill("纸船和雨");
  await page.getByLabel("第一段").fill("她把纸船放进雨里。");
  await page.getByRole("button", { name: "保存开篇" }).click();
  const editor = page.getByLabel("接着写下去");
  await editor.fill("回家后，她找出一张新纸。");
  const ctx = context(runtime, "agent-0", "@subject");
  const act = (kind, args = {}) =>
    runtime.callTool(ctx, "story_circle", { kind, ...args });
  const { items } = await act("list", { shelf: "writing" });
  const bookId = items[0].id;
  await act("append", {
    bookId,
    revision: 1,
    text: "一阵风把船吹回岸边。",
    requestId: randomUUID(),
  });
  await page.getByRole("button", { name: "提交续写" }).click();
  await page.getByText("一阵风把船吹回岸边。", { exact: true }).waitFor();
  assert.equal(await editor.inputValue(), "回家后，她找出一张新纸。");
  await page.getByRole("button", { name: "提交续写" }).click();
  await page.getByText("回家后，她找出一张新纸。", { exact: true }).waitFor();

  await page.getByRole("button", { name: "批注", exact: true }).click();
  await page.getByLabel("写下批注").fill("她的纸船认得回来的路。");
  await page.getByRole("button", { name: "添加批注" }).click();
  await page.getByText("她的纸船认得回来的路。", { exact: true }).waitFor();
  await editor.fill("第二天，窗边停着两只纸船。");
  await page.getByRole("button", { name: "提出结尾" }).click();
  await page.getByRole("button", { name: "预览入馆" }).click();
  await page.getByLabel("简介", { exact: true }).fill("纸船在雨里漂了一晚。");
  await page.getByRole("button", { name: "确认入馆" }).click();
  await page.getByText("已入馆", { exact: true }).waitFor();
  await page.getByRole("button", { name: "显示批注" }).click();
  await page.getByRole("button", { name: "批注 1", exact: true }).click();
  await page.getByText("她的纸船认得回来的路。", { exact: true }).waitFor();
  await page.setViewportSize({ width: 375, height: 768 });
  await page.getByRole("complementary", { name: "段落批注" }).waitFor();
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth),
    375,
  );
  await page.getByLabel("搜书名或作者").fill("角色0");
  await page.getByRole("button", { name: "查找", exact: true }).click();
  await page.getByRole("button", { name: /纸船和雨/ }).waitFor();
  assert.deepEqual(errors, []);
});
