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
  await list.getByRole("button", { name: "停止动作 · 小鱼" }).click();
  await list.getByRole("button", { name: "回到座位 · 小鱼" }).click();
  assert.deepEqual(await page.evaluate(() => window.testActions), [
    ["invite", "dragon"],
    ["body-stop", "fish"],
    ["body-seat", "fish"],
  ]);
  assert.equal(
    await list.getByRole("button", { name: "停止动作 · 小龙" }).isVisible(),
    false,
  );
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

test("the visit panel uses confirmed body state and announces each manual interruption once", async (t) => {
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
  const role = {
    id: "fish",
    name: "小鱼",
    color: "teal",
    state: "here",
    available: true,
    activity: "move",
  };
  const room = {
    live: true,
    framework: true,
    connected: true,
    roles: [{ ...role, bodyStatus: { state: "idle" } }],
    messages: [],
    notice: "",
    observation: {
      eligible: [role.id],
      grantedAgentId: role.id,
      target: "合成文档窗口",
      expiresAt: Date.UTC(2026, 0, 2, 12, 15),
      remaining: 2,
    },
  };
  await page.addInitScript((data) => {
    window.testActions = [];
    window.nest = {
      onRoom: (update) => (window.testRoom = update),
      onSection() {},
      get: async () => ({ data, section: "visits" }),
      act: (...args) => window.testActions.push(args),
    };
  }, room);
  await page.goto(
    new URL("../desktop/home/index.html?type=panel", import.meta.url).href,
  );
  const push = (data) => page.evaluate((next) => window.testRoom(next), data);
  const state = page.locator(".guest-state");
  const detail = page.locator(".guest-detail");
  const recent = page.locator(".guest-recent");
  const announcement = page.locator(".body-announcement");
  const zoneEditor = page.getByRole("button", { name: "设置桌宠禁停区" });
  const stop = page.getByRole("button", { name: "停止动作 · 小鱼" });
  await state.waitFor();
  assert.equal(await state.textContent(), "在桌边");
  assert.equal(await detail.isVisible(), false);
  assert.equal(await zoneEditor.isVisible(), false);

  const put = (bodyStatus, other = {}, options = {}) =>
    push({ ...room, ...options, roles: [{ ...role, ...other, bodyStatus }] });
  const at = Date.UTC(2026, 0, 2, 12);
  await put({ state: "waiting", until: at });
  assert.equal(await state.textContent(), "等待自主活动");
  assert.match(await detail.textContent(), /^至 \d{2}:\d{2}$/);
  await put({ state: "observing" });
  assert.equal(await state.textContent(), "正在观察桌面");
  assert.match(await detail.textContent(), /合成文档窗口.*许可至.*剩余 2 次/);
  await put({ state: "qq" });
  assert.equal(await state.textContent(), "QQ 优先处理");
  assert.equal(await detail.isVisible(), false);
  await put(
    { state: "paused", reason: "rest" },
    { state: "home", available: false },
  );
  assert.equal(await state.textContent(), "休息时段 · 已暂停");
  await put({ state: "paused", stateReason: "rest", reason: "completed", at });
  assert.equal(await state.textContent(), "休息时段 · 已暂停");
  assert.match(await recent.textContent(), /动作已完成$/);
  await put({ state: "moving", pose: "stand", facing: "left" });
  assert.equal(await state.textContent(), "正在移动");
  assert.equal(await detail.textContent(), "站立 · 面向左侧");
  await stop.focus();
  await put({ state: "idle", reason: "manual-control" });
  assert.equal(await announcement.textContent(), "");
  assert.equal(await recent.isVisible(), false);

  await announcement.evaluate((node) => {
    window.testAnnouncements = [];
    new window.MutationObserver(() =>
      window.testAnnouncements.push(node.textContent),
    ).observe(node, { childList: true });
  });
  const interrupted = { state: "idle", reason: "manual-control", at };
  await put(interrupted);
  await put(interrupted);
  await put({ ...interrupted, state: "waiting", until: at + 120_000 });
  assert.deepEqual(await page.evaluate(() => window.testAnnouncements), [
    "已停止小鱼的移动",
  ]);
  assert.match(
    await recent.textContent(),
    /^最近 · \d{2}:\d{2} · 拖动已打断移动$/,
  );
  assert.equal(
    await stop.evaluate((node) => node === node.ownerDocument.activeElement),
    true,
  );
  await page.keyboard.press("Enter");
  assert.deepEqual(await page.evaluate(() => window.testActions), [
    ["body-stop", "fish"],
  ]);
  const nextStop = { ...interrupted, at: at + 1 };
  await push({
    ...room,
    roles: [
      { ...role, bodyStatus: nextStop },
      { ...role, id: "dragon", name: "小龙", bodyStatus: nextStop },
    ],
  });
  assert.deepEqual(await page.evaluate(() => window.testAnnouncements), [
    "已停止小鱼的移动",
    "已停止小鱼的移动。已停止小龙的移动",
  ]);

  await put(
    { state: "idle", reason: "target-blocked", at },
    {},
    { bodyZones: true },
  );
  assert.match(
    await recent.textContent(),
    /落点被占用或位于禁停区，请重新选择/,
  );
  await zoneEditor.focus();
  await page.keyboard.press("Enter");
  assert.deepEqual(await page.evaluate(() => window.testActions.at(-1)), [
    "body-zones",
  ]);
  const observationWarning = page.locator("#visits .observation-ended");
  await put(
    { state: "idle", reason: "permission", at },
    {},
    { observationEnded: "target-unavailable" },
  );
  assert.match(
    await recent.textContent(),
    /请在管理台检查该角色的桌宠控制权限/,
  );
  assert.match(
    await observationWarning.textContent(),
    /选择其他窗口并重新授权/,
  );
  await put(
    { state: "idle", reason: "private diagnostic", at },
    {},
    { observationEnded: "permission" },
  );
  assert.equal(await recent.isVisible(), false);
  assert.match(await observationWarning.textContent(), /在系统设置中恢复权限/);
  await put({ state: "idle" }, {}, { observationEnded: "unsupported" });
  assert.match(
    await observationWarning.textContent(),
    /在管理台检查角色的后端/,
  );

  const notice = "与管理台断开，正在重连。若持续断开，请确认管理台正在运行。";
  await put(
    { state: "moving" },
    {},
    { connected: false, connectionLost: true, notice },
  );
  assert.equal(await state.textContent(), "连接中断");
  assert.equal(await page.locator(".room-notice").textContent(), notice);
  assert.equal(
    await page.getByRole("button", { name: "请回家 · 小鱼" }).isEnabled(),
    false,
  );
  assert.equal(await stop.isEnabled(), true);
  assert.equal(await observationWarning.isVisible(), false);
  await page.getByRole("button", { name: "聊天", exact: true }).click();
  assert.equal(await page.locator(".turn-status").textContent(), notice);
  assert.equal(
    await page.getByRole("textbox", { name: "发到房间" }).isEnabled(),
    false,
  );
});

test("floating door distinguishes clicks from dragging", async (t) => {
  let executablePath;
  try {
    executablePath = findScreenshotBrowser();
  } catch {
    t.skip("local Chromium unavailable");
    return;
  }
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 100, height: 118 } });
  await page.addInitScript(() => {
    window.testActions = [];
    window.nest = {
      onRoom() {},
      get: async () => ({ data: { roles: [] } }),
      act: (action) => window.testActions.push(action),
    };
  });
  await page.goto(
    new URL("../desktop/home/index.html?type=door", import.meta.url).href,
  );
  const door = page.getByRole("button", { name: "打开小窝的门" });
  await door.click();
  await page.mouse.move(40, 45);
  await page.mouse.down();
  await page.mouse.move(65, 65);
  await page.mouse.up();
  assert.deepEqual(await page.evaluate(() => window.testActions), [
    "open",
    "drag-start",
    "drag-move",
    "drag-end",
  ]);
  await door.focus();
  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(() => window.testActions.at(-1)), "open");
});

test("floating resident replays six short actions with a still hold and respects reduced motion", async (t) => {
  let executablePath;
  try {
    executablePath = findScreenshotBrowser();
  } catch {
    t.skip("local Chromium unavailable");
    return;
  }
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({
    viewport: { width: 194, height: 156 },
    reducedMotion: "reduce",
  });
  const room = {
    roles: [{ id: "resident", name: "小鱼", art: "fish", activity: "idle" }],
    bubbles: {},
  };
  await page.addInitScript((data) => {
    window.nest = {
      onRoom: (update) => (window.testRoom = update),
      onFacing: (update) => (window.testFacing = update),
      onMotion: (update) => (window.testMotion = update),
      act: (action, data) => {
        if (action === "motion-preference") window.testReducedMotion = data;
      },
      get: async () => ({ data }),
    };
  }, room);
  await page.goto(
    new URL(
      "../desktop/home/index.html?type=sprite&id=resident",
      import.meta.url,
    ).href,
  );
  const artButton = page.locator(".sprite-button");
  const sprite = artButton.locator("img");
  const pose = artButton.locator(".sprite-pose");
  assert.equal(await page.evaluate(() => window.testReducedMotion), true);
  await page.evaluate(() => window.testFacing("left"));
  assert.equal(await artButton.getAttribute("data-facing"), "left");
  await page.evaluate((next) => window.testRoom(next), {
    ...room,
    roles: [{ ...room.roles[0], bodyStatus: { state: "idle", pose: "sit" } }],
  });
  assert.equal(await artButton.getAttribute("data-pose"), "sit");
  assert.match(await artButton.getAttribute("aria-label"), /坐下/);
  assert.equal(
    await pose.evaluate((node) => window.getComputedStyle(node).scale),
    "-1 0.88",
  );
  await page.evaluate((next) => window.testRoom(next), {
    ...room,
    roles: [{ ...room.roles[0], bodyStatus: { state: "idle", pose: "look" } }],
  });
  assert.equal(await artButton.getAttribute("data-pose"), "look");
  assert.equal(
    await pose.evaluate((node) => window.getComputedStyle(node).rotate),
    "4deg",
  );
  assert.equal(await sprite.getAttribute("src"), "art/actions/fish-idle.webp");
  for (const art of ["fish", "dragon", "cat"]) {
    for (const activity of [
      "qq",
      "chat",
      "observe",
      "control",
      "idle",
      "sleep",
    ]) {
      await page.evaluate((next) => window.testRoom(next), {
        ...room,
        roles: [{ ...room.roles[0], art, activity }],
      });
      assert.equal(
        await sprite.getAttribute("src"),
        `art/actions/${art}-${activity}.webp`,
      );
      assert.equal(
        await sprite.evaluate(async (img) => {
          await img.decode();
          return img.naturalWidth;
        }),
        320,
      );
    }
  }
  const button = page.locator(".sprite-button");
  assert.equal(
    await button.evaluate(
      (node) => node.getAnimations({ subtree: true }).length,
    ),
    0,
  );
  await page.evaluate(() => window.testMotion("moving"));
  assert.equal(
    await pose.evaluate((node) => window.getComputedStyle(node).animationName),
    "none",
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.waitForFunction(() => window.testReducedMotion === false);
  const travelPeriods = new Set();
  for (const art of ["fish", "dragon", "cat"]) {
    await page.evaluate((next) => window.testRoom(next), {
      ...room,
      roles: [{ ...room.roles[0], art }],
    });
    const { name, period } = await pose.evaluate((node) => {
      const style = window.getComputedStyle(node);
      return { name: style.animationName, period: style.animationDuration };
    });
    assert.equal(name, "paper-travel");
    travelPeriods.add(period);
  }
  assert.equal(travelPeriods.size, 3);
  await page.evaluate(() => window.testMotion("suspended"));
  assert.equal(
    await pose.evaluate(
      (node) => window.getComputedStyle(node).animationPlayState,
    ),
    "paused",
  );
  await page.evaluate(() => window.testMotion("still"));
  for (const activity of [
    "qq",
    "chat",
    "observe",
    "control",
    "idle",
    "sleep",
  ]) {
    const state = { ...room, roles: [{ ...room.roles[0], activity }] };
    const timing = await button.evaluate((node, state) => {
      window.testRoom(state);
      const animations = node.getAnimations({ subtree: true });
      const period = animations[0]?.effect.getTiming().duration;
      for (const animation of animations) animation.pause();
      const frame = (time) => {
        for (const animation of animations) animation.currentTime = time;
        return [...node.querySelectorAll("span, img")].map((part) => {
          const { transform, opacity } = window.getComputedStyle(part);
          return [transform, opacity];
        });
      };
      const samples = [180, 340, 560, 740, 960, 1200];
      const first = samples.map(frame);
      const rest = [2000, period / 2, period - 100].map(frame);
      const next = samples.map((time) => frame(period + time));
      frame(period / 2);
      window.testRoom(state);
      const current = node.getAnimations({ subtree: true });
      const sameCycle =
        current.length === animations.length &&
        current.every(
          (animation) =>
            animations.includes(animation) &&
            animation.currentTime === period / 2,
        );
      for (const animation of animations) animation.play();
      return { period, first, rest, next, sameCycle };
    }, state);
    assert.ok(timing.period >= 5000, activity);
    assert.ok(
      new Set(timing.first.map((frame) => JSON.stringify(frame))).size > 1,
      activity,
    );
    assert.deepEqual(
      timing.rest,
      [timing.rest[0], timing.rest[0], timing.rest[0]],
      activity,
    );
    assert.ok(
      timing.first.some(
        (frame) => JSON.stringify(frame) !== JSON.stringify(timing.rest[0]),
      ),
      activity,
    );
    assert.deepEqual(timing.next, timing.first, activity);
    assert.equal(timing.sameCycle, true, activity);
  }
});
