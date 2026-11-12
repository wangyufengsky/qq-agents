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

test("paper tabs and portraits replace the desktop budget display", async (t) => {
  let executablePath;
  try {
    executablePath = findScreenshotBrowser();
  } catch {
    t.skip("local Chromium unavailable");
    return;
  }
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 430, height: 574 } });
  const roles = [
    ["fish", "小鱼", "teal", "here"],
    ["dragon", "小龙", "green", "home"],
    ["cat", "猫猫", "peach", "home"],
  ].map(([id, name, color, state]) => ({
    id,
    name,
    color,
    state,
    available: true,
  }));
  const data = {
    live: true,
    framework: true,
    connected: true,
    roles,
    messages: [],
    notice: "",
    budget: 5,
    maxTurns: 6,
    nextRefill: Date.now() + 3600_000,
    thinking: "fish",
  };
  await page.addInitScript((data) => {
    window.testActions = [];
    window.nest = {
      onRoom() {},
      onSection() {},
      get: async () => ({ data, section: "visits" }),
      act: (...args) => window.testActions.push(args),
    };
  }, data);
  await page.goto(
    new URL("../desktop/home/index.html?type=panel", import.meta.url).href,
  );
  const list = page.locator(".guest-list");
  await list.getByRole("button", { name: "邀请 · 小龙" }).click();
  assert.deepEqual(await page.evaluate(() => window.testActions), [
    ["invite", "dragon"],
  ]);
  const portraits = list.locator("img");
  assert.equal(await portraits.count(), 3);
  assert.ok(
    await portraits.evaluateAll((images) =>
      images.every(
        (img) => img.naturalWidth > 0 && img.src.endsWith("-paper.webp"),
      ),
    ),
  );
  await page.getByRole("button", { name: "聊天", exact: true }).click();
  assert.equal(
    await page.getByRole("log", { name: "聊天记录" }).isVisible(),
    true,
  );
  assert.equal(await page.getByText("小鱼正在想…").isVisible(), true);
  assert.equal(await page.getByText(/共用回合|后刷新/).count(), 0);
  assert.equal(
    await page.getByText("刷新设置", { exact: true }).isVisible(),
    false,
  );
  await page.getByRole("textbox", { name: "发到房间" }).fill("桌边试聊");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.testActions.at(-1)), [
    "send",
    "桌边试聊",
  ]);
});
