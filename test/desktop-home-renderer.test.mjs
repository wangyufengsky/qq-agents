/* global window */
import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { findScreenshotBrowser } from "../src/tools/public-screenshot.mjs";

test("the desktop panel drops the old messages and guests when its room closes", async (t) => {
  let executablePath;
  try {
    executablePath = findScreenshotBrowser();
  } catch {
    t.skip("local Chromium unavailable");
    return;
  }
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const room = {
    live: true,
    framework: true,
    connected: true,
    roles: [
      {
        id: "fish",
        name: "小鱼",
        color: "mint",
        state: "here",
        available: true,
      },
    ],
    messages: [
      { id: 1, actor: "owner", text: "上一间房间", now: 1 },
      { id: 2, actor: "fish", text: "上一间的回复", now: 2 },
    ],
    nextRefill: null,
    budget: 5,
    maxTurns: 6,
    notice: "",
  };
  await page.addInitScript((data) => {
    window.nest = {
      onRoom: (update) => (window.testRoom = update),
      onSection() {},
      get: async () => ({ data, section: "chat" }),
      attach: async () => {
        window.testAttachmentCalls = (window.testAttachmentCalls ?? 0) + 1;
        return "cancelled";
      },
    };
  }, room);
  await page.goto(
    new URL("../desktop/home/index.html?type=panel", import.meta.url).href,
  );
  await page.getByText("上一间的回复", { exact: true }).waitFor();
  const thread = page.getByRole("log", { name: "聊天记录" });
  const push = (data) => page.evaluate((next) => window.testRoom(next), data);
  await push({
    ...room,
    connected: false,
    roles: [],
    messages: [],
  });
  assert.equal(await thread.locator(".message").count(), 0);
  assert.equal(await page.locator(".guest").count(), 0);
  assert.equal(await thread.locator(".empty").count(), 1);
  const attach = page.getByRole("button", { name: "发送附件" });
  assert.equal(await attach.isEnabled(), false);
  await push({
    ...room,
    attachmentInput: { text: true, image: false },
    messages: [
      { id: 1, actor: "owner", text: "新房间", now: 3 },
      {
        id: 2,
        actor: "admin",
        text: "",
        now: 4,
        attachments: [
          {
            id: "fixture-attachment",
            name: "<资料>.txt",
            mimeType: "text/plain",
            bytes: 8,
          },
        ],
      },
    ],
  });
  assert.equal(await thread.locator(".message").count(), 2);
  assert.equal(await thread.getByText("新房间", { exact: true }).count(), 1);
  assert.equal(
    await thread.getByText("附件 · <资料>.txt", { exact: true }).count(),
    1,
  );
  assert.equal(await attach.isEnabled(), true);
  await attach.click();
  assert.equal(await page.evaluate(() => window.testAttachmentCalls), 1);
});

test("the desktop panel exposes each authorization only while eligible", async (t) => {
  let executablePath;
  try {
    executablePath = findScreenshotBrowser();
  } catch {
    t.skip("local Chromium unavailable");
    return;
  }
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const room = {
    live: true,
    framework: true,
    connected: true,
    roles: [
      {
        id: "fish",
        name: "小鱼",
        color: "mint",
        state: "here",
        available: true,
      },
    ],
    messages: [],
    budget: 5,
    maxTurns: 6,
  };
  await page.addInitScript((data) => {
    window.nest = {
      onRoom: (update) => (window.testRoom = update),
      onSection() {},
      get: async () => ({ data, section: "chat" }),
      screenView: async () => {
        window.testScreenCalls = (window.testScreenCalls ?? 0) + 1;
        return "cancelled";
      },
      nativeControl: async () => {
        window.testNativeCalls = (window.testNativeCalls ?? 0) + 1;
        return "cancelled";
      },
    };
  }, room);
  await page.goto(
    new URL("../desktop/home/index.html?type=panel", import.meta.url).href,
  );
  const push = (data) => page.evaluate((next) => window.testRoom(next), data);
  const authorize = page.getByRole("button", { name: "授权查看屏幕" });
  const authorizeNative = page.getByRole("button", { name: "授权控制窗口" });
  assert.equal(await authorize.isVisible(), false);
  assert.equal(await authorizeNative.isVisible(), false);
  await push({
    ...room,
    screenView: { eligible: ["fish"], grantedAgentId: null },
  });
  await authorize.click();
  assert.equal(await page.evaluate(() => window.testScreenCalls), 1);
  assert.equal(await authorizeNative.isVisible(), false);
  await push({
    ...room,
    screenView: { eligible: ["fish"], grantedAgentId: "fish" },
    nativeControl: { eligible: ["fish"], grantedAgentId: null },
  });
  const revoke = page.getByRole("button", { name: "撤销屏幕授权" });
  assert.equal(await revoke.isVisible(), true);
  await revoke.click();
  assert.equal(await page.evaluate(() => window.testScreenCalls), 2);
  await authorizeNative.click();
  assert.equal(await page.evaluate(() => window.testNativeCalls), 1);
  await push({
    ...room,
    nativeControl: { eligible: ["fish"], grantedAgentId: "fish" },
  });
  const revokeNative = page.getByRole("button", { name: "撤销窗口控制" });
  assert.equal(await revoke.isVisible(), false);
  await revokeNative.click();
  assert.equal(await page.evaluate(() => window.testNativeCalls), 2);
  await push({ ...room, connected: false });
  assert.equal(await revokeNative.isVisible(), false);
});

test("site authorization requires an explicit role and origin and follows the room", async (t) => {
  let executablePath;
  try {
    executablePath = findScreenshotBrowser();
  } catch {
    t.skip("local Chromium unavailable");
    return;
  }
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const room = {
    live: true,
    framework: true,
    connected: true,
    roomEpoch: "room",
    roles: [
      {
        id: "fish",
        name: "小鱼",
        color: "mint",
        state: "here",
        available: true,
      },
    ],
    messages: [],
    budget: 5,
    maxTurns: 6,
  };
  await page.addInitScript((data) => {
    window.testBrowserCalls = [];
    window.nest = {
      onRoom: (update) => (window.testRoom = update),
      onSection() {},
      get: async () => ({ data, section: "chat" }),
      browserControl: async (selection) => {
        window.testBrowserCalls.push(selection ?? null);
        return selection ? "granted" : "revoked";
      },
    };
  }, room);
  await page.goto(
    new URL("../desktop/home/index.html?type=panel", import.meta.url).href,
  );
  const push = (data) => page.evaluate((next) => window.testRoom(next), data);
  const authorize = page.getByRole("button", { name: "授权访问站点" });
  const dialog = page.getByRole("dialog", { name: "授权隔离浏览器" });
  assert.equal(await authorize.isVisible(), false);
  const eligible = {
    ...room,
    browserControl: { eligible: ["fish"], grantedAgentId: null },
  };
  await push(eligible);
  await authorize.click();
  assert.equal(await dialog.getByLabel("角色").inputValue(), "");
  await push({ ...eligible, roomEpoch: "new-room" });
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual(await page.evaluate(() => window.testBrowserCalls), []);
  await authorize.click();
  await dialog.getByLabel("角色").selectOption("fish");
  const origin = "https://example.com";
  await dialog.getByLabel("站点来源").fill(origin);
  await dialog.getByRole("button", { name: "继续" }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual(await page.evaluate(() => window.testBrowserCalls), [
    { agentId: "fish", origin },
  ]);
  await push({
    ...eligible,
    browserControl: {
      eligible: ["fish"],
      grantedAgentId: "fish",
      grantedOrigin: origin,
    },
  });
  assert.equal(await page.getByText(`小鱼 · ${origin}`).isVisible(), true);
  await page.getByRole("button", { name: "撤销站点授权" }).click();
  assert.equal(await page.evaluate(() => window.testBrowserCalls.at(-1)), null);
});
