/* global document, window */
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
      get: async () => ({ data, section: window.testSection ?? "visits" }),
      setSection: (section) => (window.testSection = section),
      attach: async () => {
        if (window.testSection !== "chat") return "unavailable";
        window.testAttachmentCalls = (window.testAttachmentCalls ?? 0) + 1;
        return "cancelled";
      },
    };
  }, room);
  await page.goto(
    new URL("../desktop/home/index.html?type=panel", import.meta.url).href,
  );
  await page.getByRole("button", { name: "来访" }).waitFor();
  await page.getByRole("button", { name: "聊天" }).click();
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
  const attach = page.locator(".attach");
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
  await page.getByRole("button", { name: "附件和窗口任务" }).click();
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
      observation: async () => window.testObservationResult,
    };
  }, room);
  await page.goto(
    new URL("../desktop/home/index.html?type=panel", import.meta.url).href,
  );
  const push = (data) => page.evaluate((next) => window.testRoom(next), data);
  await page.getByRole("button", { name: /小窝工具/ }).click();
  const authorize = page.locator(".screen-view-button");
  const authorizeNative = page.locator(".native-control button.secondary");
  const authorizeObservation = page.locator(".observation button");
  const retention = page.locator("#observation-retention-notice");
  const ineligible = page.locator(".observation-ineligible");
  assert.equal(await authorize.isVisible(), false);
  assert.equal(await authorizeNative.isVisible(), false);
  assert.equal(await authorizeObservation.isVisible(), false);
  await push({
    ...room,
    observation: {
      eligible: [],
      grantedAgentId: null,
      ineligible: [{ id: "fish", reason: "image" }],
    },
    observationEnded: "unsupported",
  });
  assert.equal(await authorizeObservation.isVisible(), false);
  assert.equal(await retention.isVisible(), false);
  assert.match(await ineligible.textContent(), /小鱼.*后端不支持图片输入/);
  assert.equal(
    await page.locator("#chat .observation-ended").isVisible(),
    false,
  );
  await push({
    ...room,
    roles: [...room.roles, { ...room.roles[0], id: "dragon", name: "小龙" }],
    observation: {
      eligible: ["fish"],
      grantedAgentId: null,
      ineligible: [{ id: "dragon", reason: "activity" }],
    },
  });
  assert.equal(await retention.isVisible(), true);
  assert.match(await retention.textContent(), /模型服务.*自身规则保留/);
  assert.match(await ineligible.textContent(), /小龙.*未开启自主活动/);
  await page.evaluate(() => (window.testObservationResult = "permission"));
  await authorizeObservation.click();
  await page.getByText(/录制屏幕.*辅助功能/).waitFor();
  await page.evaluate(() => (window.testObservationResult = "missing-helper"));
  await authorizeObservation.click();
  await page.getByText(/缺少 agent-desktop.*重新打开桌面小窝/).waitFor();
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

test("the header tools remain interactive outside the chat tab", async (t) => {
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
  await page.addInitScript(() => {
    window.nest = {
      onRoom() {},
      onSection() {},
      get: async () => ({
        section: "visits",
        data: {
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
          observationReviewAvailable: true,
          browserControl: { eligible: ["fish"] },
        },
      }),
      browserControl() {},
      observationReview: async () => ({ records: [] }),
    };
  });
  await page.goto(
    new URL("../desktop/home/index.html?type=panel", import.meta.url).href,
  );
  const tools = page.getByRole("button", { name: "小窝工具" });
  const sheet = page.getByRole("dialog", { name: "小窝工具" });
  await tools.click();
  assert.equal(
    await sheet.isVisible(),
    true,
    "opening tools on Visits must show the modal, which blocks other controls",
  );
  await sheet.getByRole("button", { name: "关闭面板" }).click();
  await page.getByRole("button", { name: "观察", exact: true }).click();
  await tools.click();
  await sheet.getByRole("button", { name: "授权访问站点" }).click();
  const browserPermission = page.getByRole("dialog", {
    name: "授权隔离浏览器",
  });
  assert.equal(await browserPermission.isVisible(), true);
  await browserPermission.getByRole("button", { name: "取消" }).click();
  await page.keyboard.press("Escape");
  assert.equal(await sheet.isVisible(), false);
  assert.equal(
    await tools.evaluate((node) => node === document.activeElement),
    true,
  );
  await page.getByRole("button", { name: "聊天" }).click();
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
  await page.getByRole("button", { name: /小窝工具/ }).click();
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

test("observation review keeps candidates and saved summaries separate from room history", async (t) => {
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
  const now = Date.now();
  const candidate = {
    id: "observation-candidate",
    agentId: "fish",
    response: "<img src=x> 回复草稿",
    summary: "<script>摘要草稿</script>",
    expiresAt: now + 10_000,
  };
  const room = {
    framework: true,
    connected: true,
    roomEpoch: "observation-room",
    observationReviewAvailable: true,
    roles: [{ id: "fish", name: "小鱼", state: "here", available: true }],
    messages: [{ id: 1, actor: "admin", text: "房间消息", now }],
    observation: {
      eligible: ["fish"],
      grantedAgentId: "fish",
      target: "合成文档窗口",
      targetState: "ready",
      expiresAt: candidate.expiresAt,
      remaining: 2,
    },
  };
  await page.addInitScript(
    ({ room, candidate, now }) => {
      let review = { candidate: { ...candidate } };
      let records = [];
      window.reviewCalls = [];
      window.replaceReview = (next) => (review = next);
      window.nest = {
        onRoom: (update) => (window.testRoom = update),
        onSection() {},
        get: async () => ({ data: room, section: "chat" }),
        observationReview: async (action, data) => {
          window.reviewCalls.push([action, data]);
          if (action === "list") return { records };
          if (action === "delete") {
            records = records.filter(({ id }) => id !== data.id);
            return { deleted: true };
          }
          if (action === "publish") {
            review.published = { ...candidate, text: candidate.response };
            delete review.candidate.response;
          }
          if (action === "save") {
            records.push({
              id: "saved-observation",
              agentId: candidate.agentId,
              summary: candidate.summary,
              createdAt: now,
              expiresAt: now + 86_400_000,
            });
          }
          if (action === "save" || action === "discard")
            delete review.candidate;
          return review;
        },
      };
    },
    { room, candidate, now },
  );
  await page.goto(
    new URL("../desktop/home/index.html?type=panel", import.meta.url).href,
  );
  const reviewTab = page.getByRole("button", { name: "观察", exact: true });
  const review = page.getByRole("region", { name: "观察审核" });
  const thread = page.getByRole("log", { name: "聊天记录" });
  const push = (next) => page.evaluate((data) => window.testRoom(data), next);
  await reviewTab.waitFor();
  assert.deepEqual(await page.evaluate(() => window.reviewCalls), []);
  await reviewTab.click();
  await review.getByText(candidate.response, { exact: true }).waitFor();
  assert.match(
    await review.locator(".review-scope").textContent(),
    /小鱼.*合成文档窗口.*剩余 2 次/,
  );
  assert.equal(await review.locator("img, script").count(), 0);
  assert.equal(
    await review.getByText(candidate.summary, { exact: true }).count(),
    1,
  );
  assert.equal(await page.locator("#chat .thread .message").count(), 1);
  await page.evaluate(() => {
    const hasFocus = document.hasFocus;
    document.hasFocus = () => false;
    window.dispatchEvent(new Event("blur"));
    document.hasFocus = hasFocus;
  });
  assert.equal(
    await review.locator(".review-response .review-text").textContent(),
    "",
  );
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await review.getByText(candidate.response, { exact: true }).waitFor();

  await review.getByRole("button", { name: "发布回复" }).click();
  await review.getByText("已发布回复").waitFor();
  assert.equal(await review.locator(".review-response").isVisible(), false);
  assert.equal(
    await review.getByRole("button", { name: "保存摘要" }).isVisible(),
    true,
  );
  await review.getByRole("button", { name: "保存摘要" }).click();
  await review.getByText("摘要已保存。").waitFor();
  await review.getByText("已保存的观察摘要").click();
  await review.locator("li").getByText(candidate.summary).waitFor();
  await review.getByRole("button", { name: "删除摘要" }).click();
  await review.getByText("暂无已保存的摘要。").waitFor();

  const nextCandidate = { ...candidate, id: "next-observation" };
  await page.evaluate(
    (candidate) => window.replaceReview({ candidate }),
    nextCandidate,
  );
  await review.getByRole("button", { name: "丢弃候选" }).click();
  await review.getByText("候选已丢弃。").waitFor();
  assert.deepEqual(
    await page.evaluate(() =>
      window.reviewCalls.filter(
        ([action]) => action !== "status" && action !== "list",
      ),
    ),
    [
      ["publish", { id: candidate.id }],
      ["save", { id: candidate.id }],
      ["delete", { id: "saved-observation", agentId: candidate.agentId }],
      ["discard", { id: nextCandidate.id }],
    ],
  );

  await push({
    ...room,
    observation: { ...room.observation, targetState: "minimized" },
    observationEnded: "target-minimized",
  });
  await review.getByText("观察窗口已最小化。恢复窗口后可继续观察。").waitFor();
  assert.equal(await review.locator(".review-candidate").isVisible(), false);
  await page.getByRole("button", { name: "聊天", exact: true }).click();
  await thread.getByText("房间消息").waitFor();
  assert.doesNotMatch(await thread.textContent(), /回复草稿|摘要草稿/);
  assert.equal(
    await review
      .locator(".review-text")
      .allTextContents()
      .then((texts) => texts.every((text) => !text)),
    true,
  );
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
  const unreachable = {
    state: "idle",
    reason: "target-unreachable",
    at: at + 2,
  };
  await put(unreachable, {}, { bodyZones: true });
  await put(unreachable, {}, { bodyZones: true });
  assert.match(await recent.textContent(), /没有可通行的路线/);
  assert.deepEqual(
    (await page.evaluate(() => window.testAnnouncements)).slice(2),
    ["小鱼无法到达。没有可通行的路线，请重新选择落点。"],
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

test("resident controls are local and a window task stays bound to its selected grant", async (t) => {
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
  page.setDefaultTimeout(4500);
  const role = {
    id: "fish",
    name: "小鱼",
    color: "mint",
    state: "here",
    available: true,
    bodyControlAvailable: true,
  };
  const room = {
    framework: true,
    connected: true,
    interactionsAvailable: true,
    roles: [role],
    messages: [],
    notice: "",
  };
  await page.addInitScript((data) => {
    window.testActions = [];
    window.nest = {
      onRoom: (update) => (window.testRoom = update),
      onSection() {},
      get: async () => ({ data, section: "visits" }),
      act: (...args) => window.testActions.push(args),
      follow: async (...args) => {
        window.testActions.push(["follow", ...args]);
        return "started";
      },
    };
  }, room);
  await page.goto(
    new URL("../desktop/home/index.html?type=panel", import.meta.url).href,
  );
  const push = (update) =>
    page.evaluate((data) => window.testRoom(data), update);
  const resident = page.locator(".guest").filter({ hasText: "小鱼" });
  await resident.getByText("桌宠互动", { exact: true }).click();
  await resident.getByRole("button", { name: "标记当前停留点" }).click();
  await resident.getByRole("button", { name: "跟随鼠标" }).click();
  assert.equal(
    await resident.getByRole("button", { name: "跟随窗口" }).isVisible(),
    false,
  );
  await push({
    ...room,
    roles: [
      {
        ...role,
        place: "unavailable",
        follow: { mode: "pointer", until: 120_000 },
      },
    ],
  });
  await resident.getByText("常用停留点不可用", { exact: false }).waitFor();
  assert.equal(
    await resident.getByRole("button", { name: "去常用停留点" }).isEnabled(),
    false,
  );
  await resident.getByRole("button", { name: "停止跟随" }).click();
  await push({
    ...room,
    roles: [{ ...role, state: "home", place: "unavailable" }],
  });
  await resident.getByRole("button", { name: "清除停留点" }).click();
  assert.equal(
    await resident.getByRole("button", { name: "标记当前停留点" }).isVisible(),
    false,
  );

  await push(room);
  await page.getByRole("button", { name: "聊天", exact: true }).click();
  const scope = page.getByRole("combobox", { name: "发送方式" });
  const message = page.getByRole("textbox", { name: "发到房间" });
  const send = page.getByRole("button", { name: "发送", exact: true });
  assert.equal(await scope.isVisible(), false);
  await message.fill("桌边消息");
  await send.click();

  const authorized = { ...room, windowTaskScreenAgentId: role.id };
  await push({ ...authorized, windowTaskScreenGrantId: "grant-a" });
  const chooseTask = async () => {
    await page
      .getByRole("button", { name: "附件和窗口任务" })
      .click({ timeout: 5000 });
    await page.getByRole("button", { name: "窗口任务", exact: true }).click();
    await scope.selectOption("screen", { timeout: 5000 });
    await page.getByRole("button", { name: "带入输入框" }).click();
  };
  await chooseTask();
  await message.fill("请查看窗口内容");
  await push({ ...authorized, windowTaskScreenGrantId: "grant-b" });
  assert.equal(await send.isEnabled(), false);
  await message.press("Enter");
  await page.getByText("窗口授权已变化。", { exact: false }).waitFor();
  await page.locator(".task-clear").click();
  await chooseTask();
  await send.click();
  assert.equal(await page.locator("#window-task-scope").inputValue(), "");
  await push({
    ...authorized,
    windowTaskScreenGrantId: "grant-b",
    windowTaskStatus: {
      id: "task-a",
      agentId: role.id,
      scope: "screen",
      stage: "approaching",
    },
  });
  await page.getByRole("button", { name: "取消窗口任务" }).click();
  assert.deepEqual(await page.evaluate(() => window.testActions), [
    ["body-mark-place", "fish"],
    ["follow", "fish", "pointer"],
    ["follow", "fish", "stop"],
    ["body-clear-place", "fish"],
    ["send", "桌边消息"],
    [
      "window-task",
      {
        agentId: "fish",
        scope: "screen",
        grantId: "grant-b",
        text: "请查看窗口内容",
      },
    ],
    ["window-task-stop", "task-a"],
  ]);
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
    "page-visible",
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
      onMotionSpeed: (update) => (window.testMotionSpeed = update),
      act: (action, data) => {
        if (action === "motion-preference") window.testReducedMotion = data;
        if (action === "page-visible") window.testPageVisibility.push(data);
      },
      get: async () => ({ data }),
    };
    window.testPageVisibility = [];
  }, room);
  await page.goto(
    new URL(
      "../desktop/home/index.html?type=sprite&id=resident",
      import.meta.url,
    ).href,
  );
  const artButton = page.locator(".sprite-button");
  const sprite = artButton.locator(".sprite-rest");
  const body = artButton.locator(".sprite-body");
  const pose = artButton.locator(".sprite-pose");
  const walk = artButton.locator(".sprite-walk");
  assert.equal(await page.evaluate(() => window.testReducedMotion), true);
  await page.evaluate(() => window.testFacing("left"));
  assert.equal(await artButton.getAttribute("data-facing"), "left");
  await page.evaluate((next) => window.testRoom(next), {
    ...room,
    roles: [{ ...room.roles[0], bodyStatus: { state: "idle", pose: "sit" } }],
  });
  assert.equal(await artButton.getAttribute("data-pose"), "sit");
  assert.match(await artButton.getAttribute("aria-label"), /坐下/);
  assert.equal(await sprite.getAttribute("src"), "art/actions/fish-idle.webp");
  assert.equal(
    await pose.evaluate((node) => window.getComputedStyle(node).scale),
    "1 0.88",
  );
  assert.equal(
    await body.evaluate((node) => window.getComputedStyle(node).scale),
    "-1 1",
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
  assert.equal(await sprite.getAttribute("src"), "art/actions/fish-stand.webp");
  await page.evaluate((next) => window.testRoom(next), {
    ...room,
    roles: [{ ...room.roles[0], bodyStatus: { state: "idle", pose: "sit" } }],
  });
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
  await page.evaluate((next) => window.testRoom(next), {
    ...room,
    roles: [
      {
        ...room.roles[0],
        bodyStatus: {
          state: "idle",
          gesture: { id: "owner-pet", kind: "pet" },
        },
      },
    ],
  });
  assert.equal(await button.getAttribute("data-gesture"), "pet");
  assert.equal(await page.locator(".sprite-petting").isVisible(), true);
  assert.equal(await page.locator(".sprite-pet-face").isVisible(), true);
  assert.equal(await page.locator(".pet-eye").count(), 2);

  assert.equal(
    await page
      .locator(".sprite-petting")
      .evaluate((node) => window.getComputedStyle(node).animationName),
    "none",
  );
  await page.evaluate((next) => window.testRoom(next), room);
  assert.equal(
    await button.evaluate(
      (node) => node.getAnimations({ subtree: true }).length,
    ),
    0,
  );
  await page.evaluate(() => window.testMotion("moving"));
  assert.equal(
    await walk.evaluate((node) => window.getComputedStyle(node).animationName),
    "none",
  );
  assert.equal(await sprite.isVisible(), true);
  await page.evaluate(() => window.testMotion("still"));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.waitForFunction(() => window.testReducedMotion === false);
  const animate = (state) =>
    page.evaluate((state) => window.testMotion(state), state);
  const animations = () =>
    artButton.evaluate((node) =>
      node
        .getAnimations({ subtree: true })
        .map(({ animationName }) => animationName),
    );
  await page.evaluate((next) => window.testRoom(next), {
    ...room,
    roles: [
      {
        ...room.roles[0],
        bodyStatus: {
          state: "idle",
          gesture: { id: "owner-pet-motion", kind: "pet" },
        },
      },
    ],
  });
  assert((await animations()).includes("paper-pet-lid"));
  assert((await animations()).includes("paper-petting-hand"));
  await page.evaluate((next) => window.testRoom(next), room);
  assert.equal(await page.locator(".sprite-pet-face").isVisible(), false);

  const motionTiming = (state) =>
    body.evaluate((node, state) => {
      window.testMotion(state);
      const animation = node
        .getAnimations()
        .find(({ animationName }) => animationName);
      const { duration, iterations } = animation.effect.getTiming();
      return [animation.animationName, duration, iterations];
    }, state);
  assert.deepEqual(await motionTiming("moving"), ["paper-start", 150, 1]);
  const travelPeriods = new Set();
  for (const art of ["fish", "dragon", "cat"]) {
    await page.evaluate((next) => window.testRoom(next), {
      ...room,
      roles: [{ ...room.roles[0], art }],
    });
    const { name, period } = await walk.evaluate((node) => {
      const style = window.getComputedStyle(node);
      return { name: style.animationName, period: style.animationDuration };
    });
    assert.equal(name, "paper-travel");
    travelPeriods.add(period);
    assert.deepEqual(
      await walk.locator("img").evaluateAll(async (imgs) =>
        Promise.all(
          imgs.map(async (img) => {
            await img.decode();
            return [img.getAttribute("src"), img.naturalWidth];
          }),
        ),
      ),
      [
        [`art/actions/${art}-stride.webp`, 320],
        [`art/actions/${art}-step.webp`, 320],
      ],
    );
    assert.equal(
      await sprite.getAttribute("src"),
      `art/actions/${art}-stand.webp`,
    );
  }
  assert.equal(travelPeriods.size, 3);
  const gait = await walk.evaluate((node) => {
    const results = [];
    for (const speed of [80, 190, 300, 530, 750, 1100]) {
      window.testMotionSpeed(speed);
      results.push(node.getAnimations()[0].effect.getTiming().duration);
    }
    return results;
  });
  assert.ok(gait.slice(1, 5).every((period, index) => period < gait[index]));
  assert.equal(gait[4], gait[5]);
  const feet = await walk.evaluate((node) => {
    const frames = [...node.querySelectorAll("img")];
    const animations = frames.map((frame) => frame.getAnimations()[0]);
    const period = animations[0].effect.getTiming().duration;
    return [0, period * 0.75].map((time) => {
      for (const animation of animations) {
        animation.pause();
        animation.currentTime = time;
      }
      return frames.map((frame) => window.getComputedStyle(frame).opacity);
    });
  });
  assert.deepEqual(feet, [
    ["1", "0"],
    ["0", "1"],
  ]);
  assert.deepEqual(await motionTiming("still"), ["paper-stop", 160, 1]);
  assert.equal(await walk.isVisible(), false);
  const gesture = artButton.locator(".sprite-gesture");
  const pushGesture = (id, kind) =>
    page.evaluate(
      ({ id, kind, room }) =>
        window.testRoom({
          ...room,
          roles: [
            {
              ...room.roles[0],
              bodyStatus: {
                state: "idle",
                pose: "stand",
                gesture: { id, kind },
              },
            },
          ],
        }),
      { id, kind, room },
    );
  await pushGesture("jump-1", "jump");
  assert.equal(await artButton.getAttribute("data-gesture"), "jump");
  assert.deepEqual(
    await gesture.evaluate((node) => {
      const action = node.getAnimations()[0];
      return [action.animationName, action.effect.getTiming().iterations];
    }),
    ["paper-jump", 1],
  );
  await gesture.evaluate((node) => node.getAnimations()[0].finished);
  await pushGesture("jump-1", "jump");
  assert.equal(await artButton.getAttribute("data-gesture"), null);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForFunction(() => window.testReducedMotion === true);
  await pushGesture("land-1", "land");
  assert.match(await artButton.getAttribute("aria-label"), /站立.*落地/);
  assert.equal(await artButton.getAttribute("data-gesture"), "land");
  assert.equal(
    await gesture.evaluate((node) => node.getAnimations().length),
    0,
  );
  assert.equal(
    await artButton.evaluate(
      (node) => window.getComputedStyle(node, "::after").content,
    ),
    '"落地"',
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.waitForFunction(() => window.testReducedMotion === false);
  await pushGesture("land-1", "land");
  assert.equal(await artButton.getAttribute("data-gesture"), null);
  await pushGesture("climb-1", "climb");
  assert.equal(await artButton.getAttribute("data-gesture"), "climb");
  await animate("moving");
  await page.mouse.move(90, 100);
  await page.mouse.down();
  await page.mouse.move(107, 110);
  assert.equal(await artButton.getAttribute("data-dragging"), "true");
  assert.deepEqual(await animations(), []);
  assert.equal(await walk.isVisible(), false);
  assert.equal(await sprite.isVisible(), true);
  await animate("suspended");
  await page.mouse.up();
  assert.deepEqual(await animations(), []);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new window.Event("visibilitychange"));
    document.dispatchEvent(new window.Event("visibilitychange"));
    window.testMotion("moving");
  });
  assert.deepEqual(await animations(), []);
  assert.deepEqual(await page.evaluate(() => window.testPageVisibility), [
    true,
    false,
  ]);
  await page.evaluate(() => {
    window.testMotion("still");
    window.testRoom({
      roles: [
        {
          id: "resident",
          name: "小鱼",
          art: "fish",
          bodyStatus: { state: "idle", pose: "sit" },
        },
      ],
    });
    window.getComputedStyle(document.querySelector(".sprite-pose")).scale;
    delete document.hidden;
    document.dispatchEvent(new window.Event("visibilitychange"));
  });
  assert.deepEqual(await page.evaluate(() => window.testPageVisibility), [
    true,
    false,
    true,
  ]);
  const poseState = (posture) =>
    pose.evaluate(
      (node, next) => {
        window.testRoom(next);
        return node
          .getAnimations()
          .map(({ animationName, transitionProperty, effect }) => [
            animationName ?? transitionProperty,
            effect.getTiming().duration,
            effect.getTiming().iterations,
          ]);
      },
      {
        ...room,
        roles: [
          { ...room.roles[0], bodyStatus: { state: "idle", pose: posture } },
        ],
      },
    );
  assert.ok(
    (await poseState("stand")).some(
      ([name, duration]) => name === "scale" && duration === 180,
    ),
  );
  assert.equal(await sprite.getAttribute("src"), "art/actions/fish-stand.webp");
  assert.ok(
    (await poseState("look")).some(
      ([name, duration, count]) =>
        name === "paper-look" && duration === 410 && count === 1,
    ),
  );
  await pose.evaluate((node) =>
    Promise.all(node.getAnimations().map(({ finished }) => finished)),
  );
  assert.ok(
    (await poseState("sit")).some(
      ([name, duration]) => name === "scale" && duration === 180,
    ),
  );
  assert.equal(await sprite.getAttribute("src"), "art/actions/fish-idle.webp");
  const turn = await body.evaluate(
    (node, next) => {
      window.testRoom(next);
      return node
        .getAnimations()
        .find(({ transitionProperty }) => transitionProperty === "scale")
        ?.effect.getTiming().duration;
    },
    {
      ...room,
      roles: [
        { ...room.roles[0], bodyStatus: { state: "idle", facing: "right" } },
      ],
    },
  );
  assert.equal(turn, 140);
  await body.evaluate((node) =>
    Promise.all(node.getAnimations().map((animation) => animation.finished)),
  );
  assert.equal(
    await body.evaluate((node) => window.getComputedStyle(node).scale),
    "1",
  );
  await pose.evaluate((node) =>
    Promise.all(
      node
        .getAnimations()
        .filter(({ transitionProperty }) => transitionProperty)
        .map((animation) => animation.finished),
    ),
  );
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
      const cycles = () =>
        node
          .getAnimations({ subtree: true })
          .filter(({ animationName }) => animationName);
      const animations = cycles();
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
      const current = cycles();
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

test("one confirmation grants multiple separate targets and displays each observation outcome", async (t) => {
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
  const room = {
    framework: true,
    live: true,
    connected: true,
    messages: [],
    roomEpoch: "room",
    roles: [
      { id: "fish", name: "小鱼", color: "teal", state: "here" },
      { id: "dragon", name: "小龙", color: "green", state: "here" },
    ],
    screenView: { eligible: ["fish", "dragon"], grants: [] },
    observation: {
      eligible: ["fish", "dragon"],
      displays: [],
      displayLimits: { minutes: 9, attempts: 2 },
    },
  };
  await page.addInitScript((data) => {
    window.testActions = [];
    const change = (policy, list) => async (action, value) => {
      if (action === "list")
        return {
          status: "listed",
          displays: [
            { id: "main", name: "内建显示器", number: 1, primary: true },
            { id: "external", name: "外接显示器", number: 2, primary: false },
          ],
        };
      window.testActions.push([action, value]);
      if (action === "grant") {
        for (const { agentId, display } of value.selections) {
          policy[list] = policy[list].filter(
            (grant) => grant.agentId !== agentId,
          );
          policy[list].push({
            agentId,
            grantId: agentId + "-grant",
            expiresAt: Date.now() + 9 * 60_000,
            target: display === "main" ? "内建显示器" : "外接显示器",
            remaining: 2,
            opportunity: agentId === "dragon" ? "declined" : "waiting",
          });
        }
      } else
        policy[list] = policy[list].filter(
          (grant) =>
            grant.agentId !== value?.agentId && action !== "revoke-all",
        );
      window.testRoom(data);
      return { status: action === "grant" ? "granted" : "revoked" };
    };
    window.testExpire = (agentId) => {
      data.observation.displays = data.observation.displays.filter(
        (grant) => grant.agentId !== agentId,
      );
      data.observation.displayHistory = [
        { agentId, state: "expired", opportunity: "waiting" },
      ];
      window.testRoom(data);
    };
    window.nest = {
      onRoom: (update) => (window.testRoom = update),
      onSection() {},
      get: async () => ({ data, section: "chat" }),
      displayObservation: change(data.observation, "displays"),
      screenView: change(data.screenView, "grants"),
    };
  }, room);
  await page.goto(
    new URL("../desktop/home/index.html?type=panel", import.meta.url).href,
  );
  const thread = page.getByRole("log");
  await thread.waitFor();
  const height = (await thread.boundingBox()).height;
  assert(height >= 340);
  await page.getByRole("button", { name: "小龙" }).click();
  assert.equal(
    await page.getByRole("textbox", { name: "发到房间" }).inputValue(),
    "@小龙 ",
  );
  await page.getByRole("button", { name: /小窝工具/ }).click();
  await page.getByRole("button", { name: "管理自主观察显示器" }).click();
  await page.getByRole("button", { name: "选择角色与显示器" }).click();
  const confirm = page.getByRole("button", { name: "确认授权" });
  assert.equal(await confirm.isEnabled(), false);
  await page.getByRole("checkbox", { name: "全选可授权角色" }).check();
  assert.equal(await confirm.isEnabled(), false);
  await page.getByLabel("统一目标").selectOption("main");
  await page.getByLabel("小鱼的查看目标").selectOption("external");
  assert.match(
    await page.locator(".display-limits").textContent(),
    /9 分钟.*2 次/,
  );
  await confirm.click();
  await page.getByText("她选择这次不看").waitFor();
  await page.getByText("等待空闲机会", { exact: true }).waitFor();
  await page.evaluate(() => window.testExpire("fish"));
  await page.getByText("授权已到期 · 到期前未轮到").waitFor();
  await page.getByRole("button", { name: "撤销小龙的显示器授权" }).click();
  await page.getByText("她选择这次不看").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "‹ 小窝工具" }).click();
  await page.getByRole("button", { name: "管理查看屏幕" }).click();
  await page.getByRole("button", { name: "选择角色与查看目标" }).click();
  await page.getByRole("checkbox", { name: "全选可授权角色" }).check();
  await page.getByLabel("统一目标").selectOption("main");
  await confirm.click();
  await page.getByRole("button", { name: "撤销小鱼的看屏授权" }).click();
  await page.getByRole("button", { name: "撤销小龙的看屏授权" }).waitFor();
  await page.keyboard.press("Escape");
  assert.equal((await thread.boundingBox()).height, height);
  assert.deepEqual(await page.evaluate(() => window.testActions), [
    [
      "grant",
      {
        selections: [
          { agentId: "fish", display: "external" },
          { agentId: "dragon", display: "main" },
        ],
      },
    ],
    ["revoke", { agentId: "dragon", grantId: "dragon-grant" }],
    [
      "grant",
      {
        selections: [
          { agentId: "fish", display: "main" },
          { agentId: "dragon", display: "main" },
        ],
      },
    ],
    ["revoke", { agentId: "fish", grantId: "fish-grant" }],
  ]);
});
