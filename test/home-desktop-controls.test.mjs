/* global document, innerWidth */
import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright-core";
import { createServer } from "../src/server.mjs";
import { desktopHomePolicy } from "../src/home/desktop-home-policy.mjs";
import { findScreenshotBrowser } from "../src/tools/public-screenshot.mjs";
import { createDesktopRoomHost } from "../src/home/desktop-host.mjs";
import { fixture } from "./helpers.mjs";

test("desktop living preferences preserve legacy defaults and validate per-role cadence", () => {
  const legacy = desktopHomePolicy.parse({ enabled: true });
  assert.equal(legacy.interactionsEnabled, false);
  assert.deepEqual(legacy.residentPreferences, {});
  const residentPreferences = {
    "agent-0": { quiet: true, activityMinutes: 2 },
    "agent-1": { activityMinutes: 30 },
  };
  assert.deepEqual(
    desktopHomePolicy.parse({ residentPreferences }).residentPreferences,
    residentPreferences,
  );
  for (const activityMinutes of [1, 31, 2.5, "2"])
    assert.equal(
      desktopHomePolicy.safeParse({
        residentPreferences: { "agent-0": { activityMinutes } },
      }).success,
      false,
    );
});

test("paper nest opens, retries and closes the desktop home from its header", async (t) => {
  let executablePath;
  try {
    executablePath = findScreenshotBrowser();
  } catch {
    t.skip("local Chromium unavailable");
    return;
  }
  const { runtime } = fixture(t);
  let opens = 0;
  const desktopLauncher = {
    state: "idle",
    open() {
      opens++;
      this.state = "opening";
    },
    cancel() {
      this.state = "idle";
    },
  };
  const token = "test-admin-token-placeholder";
  const app = createServer({
    runtime,
    token,
    desktopLauncher,
    allowLive: true,
  });
  const port = await app.listen();
  t.after(() => app.close());
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 375, height: 800 } });
  await page.goto(`http://127.0.0.1:${port}/home-space/`);
  const controls = page.locator(".masthead #desktop-controls");
  assert.equal(await controls.isVisible(), false);
  await page.evaluate(
    (token) => sessionStorage.setItem("qq-unified-token", token),
    token,
  );
  await page.reload();
  await controls.getByRole("button", { name: "开启桌面小窝" }).click();
  const opening = controls.getByRole("button", { name: "打开中…" });
  await opening.waitFor();
  assert.equal(await opening.isEnabled(), false);
  assert.equal(opens, 1);
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  desktopLauncher.state = "failed";
  await controls.getByRole("button", { name: "重试打开" }).click();
  await opening.waitFor();
  assert.equal(opens, 2);
  await controls.getByRole("button", { name: "关闭桌面小窝" }).click();
  await controls.getByRole("button", { name: "开启桌面小窝" }).waitFor();
  assert.equal(runtime.config.desktopHome.enabled, false);
  assert.equal(desktopLauncher.state, "idle");
  await page.getByRole("button", { name: "更多入口" }).click();
  await page.getByRole("button", { name: "桌面小窝设置", exact: true }).click();
  const limit = page.getByLabel("共用回合上限");
  await limit.waitFor();
  assert.equal(await limit.inputValue(), "6");
  assert.equal(
    await page.getByLabel("额度补满间隔（分钟）").inputValue(),
    "10",
  );
  const settings = page.getByRole("group", { name: "角色生活偏好" });
  const role = settings.getByRole("group", { name: "角色0" });
  const quiet = role.getByRole("checkbox", { name: "安静模式" });
  const cadence = role.getByRole("combobox", { name: "自主活动间隔" });
  const interactions = page.getByRole("checkbox", { name: "启用桌宠互动" });
  assert.equal(await interactions.isChecked(), false);
  assert.equal(await cadence.inputValue(), "");
  await quiet.check();
  await cadence.selectOption("15");
  await interactions.check();
  const publicSettings = page.getByRole("group", {
    name: "公共感知与自主唤醒",
  });
  const perception = publicSettings.getByRole("checkbox");
  const publicCadence = publicSettings.getByLabel("公共活动节奏");
  const advanced = publicSettings.locator("details");
  assert.equal(await publicCadence.inputValue(), "normal");
  assert.equal(await advanced.evaluate((element) => element.open), false);
  await advanced.locator("summary").click();
  const nearby = publicSettings.getByLabel("普通动作感知距离（DIP）");
  await nearby.fill("400");
  await publicCadence.selectOption("quiet");
  assert.equal(
    await publicSettings.getByLabel("首次活动最短等待（分钟）").inputValue(),
    "10",
  );
  assert.equal(await nearby.inputValue(), "400");
  await publicCadence.selectOption("clingy");
  assert.equal(
    await publicSettings.getByLabel("恢复后最长等待（分钟）").inputValue(),
    "3",
  );
  await publicCadence.selectOption("normal");
  const idleLimit = publicSettings.getByLabel("每小时空闲活动上限");
  const totalLimit = publicSettings.getByLabel("每小时自主活动总上限");
  assert.equal(await perception.isChecked(), false);
  assert.equal(await idleLimit.inputValue(), "3");
  assert.equal(await totalLimit.inputValue(), "4");
  await perception.check();
  await idleLimit.fill("2");
  await totalLimit.fill("5");
  assert.equal(await publicCadence.inputValue(), "custom");
  const displayMinutes = page.getByLabel("显示器观察授权时长（分钟）");
  const displayAttempts = page.getByLabel("显示器观察最多取图尝试次数");
  assert.equal(await displayMinutes.inputValue(), "15");
  assert.equal(await displayAttempts.inputValue(), "4");
  await displayMinutes.fill("9");
  await displayAttempts.fill("2");
  const save = page.getByRole("button", { name: "保存桌面设置" });
  await save.click();
  await page.getByText("桌面小窝设置已保存。", { exact: true }).waitFor();
  assert.equal(runtime.config.desktopHome.interactionsEnabled, true);
  assert.equal(runtime.config.desktopHome.publicPerception.enabled, true);
  assert.equal(runtime.config.desktopHome.publicPerception.idleLimit, 2);
  assert.equal(runtime.config.desktopHome.publicPerception.totalLimit, 5);
  assert.equal(runtime.config.desktopHome.publicPerception.nearbyDip, 400);
  assert.deepEqual(runtime.config.desktopHome.displayObservation, {
    minutes: 9,
    attempts: 2,
  });
  assert.equal(await idleLimit.inputValue(), "2");
  await page.reload();
  await page.getByRole("button", { name: "更多入口" }).click();
  await page.getByRole("button", { name: "桌面小窝设置", exact: true }).click();
  assert.equal(await page.getByLabel("公共活动节奏").inputValue(), "custom");
  for (const [preset, expected] of [
    ["quiet", [10, 15, 25, 40, 5, 8, 1, 2]],
    ["normal", [5, 8, 15, 25, 2, 5, 3, 4]],
    ["clingy", [2, 4, 8, 12, 1, 3, 4, 6]],
  ]) {
    await page.getByLabel("公共活动节奏").selectOption(preset);
    await page.getByRole("button", { name: "保存桌面设置" }).click();
    await page.getByText("桌面小窝设置已保存。", { exact: true }).waitFor();
    const config = runtime.config.desktopHome.publicPerception;
    assert.deepEqual(
      [
        config.firstMin,
        config.firstMax,
        config.idleMin,
        config.idleMax,
        config.resumeMin,
        config.resumeMax,
        config.idleLimit,
        config.totalLimit,
      ],
      expected,
    );
    assert.equal(config.nearbyDip, 400);
    await page.reload();
    await page.getByRole("button", { name: "更多入口" }).click();
    await page
      .getByRole("button", { name: "桌面小窝设置", exact: true })
      .click();
    assert.equal(await page.getByLabel("公共活动节奏").inputValue(), preset);
  }
  assert.deepEqual(runtime.config.desktopHome.residentPreferences, {
    "agent-0": { quiet: true, activityMinutes: 15 },
  });
  assert.equal(await quiet.isChecked(), true);
  assert.equal(await cadence.inputValue(), "15");
  await quiet.uncheck();
  await cadence.selectOption("");
  await save.click();
  await save.waitFor({ state: "visible" });
  await page.waitForFunction(
    () => !document.querySelector(".desktop-settings .primary").disabled,
  );
  assert.deepEqual(runtime.config.desktopHome.residentPreferences, {});
});

test("unified settings present one global observation grant and configurable room cadence", async (t) => {
  let executablePath;
  try {
    executablePath = findScreenshotBrowser();
  } catch {
    t.skip("local Chromium unavailable");
    return;
  }
  const { runtime } = fixture(t, { createDesktopHost: createDesktopRoomHost });
  runtime.config.desktopHome.screenView.enabled = true;
  const token = "test-admin-token-placeholder";
  const app = createServer({ runtime, token, allowLive: true });
  const port = await app.listen();
  t.after(() => app.close());
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.addInitScript(
    (value) => sessionStorage.setItem("qq-unified-token", value),
    token,
  );
  let saved;
  await page.route("**/api/config", async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    saved = route.request().postDataJSON().config.desktopHome;
    return route.fulfill({ json: { accepted: true } });
  });
  await page.goto(`http://127.0.0.1:${port}/home-space/`);
  await page.getByRole("button", { name: "更多入口" }).click();
  await page.getByRole("button", { name: "桌面小窝设置", exact: true }).click();
  const observe = page.getByRole("checkbox", { name: "授权观察整个桌面" });
  await observe.waitFor();
  assert.equal(await observe.count(), 1);
  assert.equal(await observe.isChecked(), false);
  assert.equal(
    await page.locator(".desktop-settings input[type=number]").count(),
    3,
  );
  assert.equal(await page.getByLabel("允许在本机授权自主观察窗口").count(), 0);
  assert.equal(await page.getByLabel("显示器观察授权时长（分钟）").count(), 0);
  assert.equal(
    await page.getByRole("group", { name: "可获窗口观察授权的角色" }).count(),
    0,
  );
  assert.equal(await page.getByLabel("共用回合上限").inputValue(), "6");
  assert.equal(
    await page.getByLabel("额度补满间隔（分钟）").inputValue(),
    "10",
  );
  assert.equal(
    await page.getByLabel("自主唤醒间隔（分钟）").inputValue(),
    "10",
  );
  await observe.check();
  await page.getByLabel("自主唤醒间隔（分钟）").fill("12");
  await page.getByRole("button", { name: "保存桌面设置" }).click();
  await page.getByText("桌面小窝设置已保存。", { exact: true }).waitFor();
  assert.equal(saved.observeDesktop, true);
  assert.equal(
    saved.screenView.enabled,
    runtime.config.desktopHome.screenView.enabled,
  );
  assert.equal(saved.autonomyMinutes, 12);
  assert.equal(
    saved.autonomousObservation,
    runtime.config.desktopHome.autonomousObservation,
  );
});
