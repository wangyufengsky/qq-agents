/* global document, innerWidth */
import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright-core";
import { createServer } from "../src/server.mjs";
import { findScreenshotBrowser } from "../src/tools/public-screenshot.mjs";
import { fixture } from "./helpers.mjs";

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
  const app = createServer({ runtime, token, desktopLauncher });
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
    "60",
  );
});
