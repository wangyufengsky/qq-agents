/* global document, innerWidth, requestAnimationFrame */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { fixture, config } from "./helpers.mjs";
import { createServer } from "../src/server.mjs";
if (!process.env.CHROME_PATH) throw Error("CHROME_PATH_REQUIRED");
const output =
  process.env.HOME_SPACE_OUTPUT ||
  (await fs.mkdtemp(path.join(os.tmpdir(), "qq-home-space-")));
await fs.mkdir(output, { recursive: true });
const cleanup = [],
  cfg = config(7);
cfg.agents[1].paused = true;
cfg.desktopHome.activityRoles = ["agent-0"];
const f = fixture({ after: (fn) => cleanup.push(fn) }, { cfg });
f.runtime.transports.get("qq-2").connected = false;
const token = "test-admin-token-placeholder",
  app = createServer({ runtime: f.runtime, token, allowLive: true });
const base = `http://127.0.0.1:${await app.listen()}`;
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH,
  headless: true,
});
const checks = [],
  errors = [];
function check(name, value) {
  assert.ok(value, name);
  checks.push(name);
}
async function ready(page, hash) {
  await page.waitForFunction(
    (h) =>
      !document.getElementById("home-content").hidden &&
      document.getElementById("stage").dataset.route === h &&
      !document.getElementById("stage").inert,
    hash,
  );
}
async function go(page, hash) {
  await page.goto(`${base}/home-space/#${hash}`);
  await page.reload();
  await ready(page, `#${hash}`);
}
async function editor(page) {
  if (!(await page.locator("#editor").isVisible()))
    await page.click("#edit-toggle");
}
async function request(url, body) {
  const r = await fetch(base + url, {
    method: body ? "POST" : "GET",
    headers: { "x-admin-token": token, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.equal(r.status, 200);
  return r.json();
}
try {
  const context = await browser.newContext({
      viewport: { width: 1440, height: 1100 },
      reducedMotion: "reduce",
    }),
    page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(base + "/home-space/");
  await page.waitForFunction(() =>
    document.getElementById("gate").textContent.includes("请先"),
  );
  check(
    "unauthenticated page has no residents",
    !(await page.locator("body").textContent()).includes("角色0"),
  );
  await page.evaluate(
    (t) => sessionStorage.setItem("qq-unified-token", t),
    token,
  );
  await go(page, "hall/1");
  check(
    "real configured residents and statuses",
    (await page.locator("#subtitle").textContent()).includes("7 位") &&
      (await page.locator("#stage").textContent()).includes("暂停") &&
      (await page.locator("#stage").textContent()).includes("离线"),
  );
  await page.click("#menu-toggle");
  await page.click("#desktop-open");
  const observationRoles = page.getByRole("group", {
    name: "可获窗口观察授权的角色",
  });
  const observationRole = observationRoles.getByRole("checkbox", {
    name: "角色0",
  });
  await observationRole.waitFor();
  check(
    "legacy observation inherits activity roles",
    await observationRole.isChecked(),
  );
  const retention = page.getByLabel("已保存观察摘要的保留期限");
  check(
    "observation retention defaults to seven days",
    (await retention.inputValue()) === "7",
  );
  const saveSettings = async () => {
    const put = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/config" &&
        response.request().method() === "PUT",
    );
    await page.getByRole("button", { name: "保存桌面设置" }).click();
    assert.equal((await put).status(), 200);
    await page.getByText("桌面小窝设置已保存。").waitFor();
  };
  await retention.selectOption("1");
  await saveSettings();
  check(
    "unrelated save preserves inherited observation roles",
    f.runtime.config.desktopHome.observationRoles === undefined &&
      f.runtime.config.desktopHome.observationRetentionDays === 1,
  );
  await page.getByRole("checkbox", { name: "使用独立观察角色名单" }).check();
  await retention.selectOption("30");
  await saveSettings();
  assert.deepEqual(f.runtime.config.desktopHome.observationRoles, ["agent-0"]);
  assert.equal(f.runtime.config.desktopHome.observationRetentionDays, 30);
  await observationRole.uncheck();
  await saveSettings();
  assert.deepEqual(f.runtime.config.desktopHome.observationRoles, []);
  await page.click("#close-reader");
  await page.locator("#pagination button").last().click();
  await ready(page, "#hall/2");
  await page.locator('[data-instance="door-agent-3"]').click();
  await ready(page, "#room/agent-3");
  check(
    "room belongs to stable id and editor is absent",
    (await page.locator("#title").textContent()).includes("角色3") &&
      !(await page.locator("#editor").isVisible()),
  );
  await page.click("#entry-toggle");
  await page.locator("#scene-actions button").first().click();
  await ready(page, "#hall/2");
  check(
    "back restores door focus",
    await page.evaluate(
      () => document.activeElement?.dataset.instance === "door-agent-3",
    ),
  );
  await go(page, "living");
  await editor(page);
  // Inspect the scene before pointer release: change-only handlers miss live drags.
  await page.selectOption("#object-select", "plant");
  for (const [label, property] of [
    ["横向偏移", "left"],
    ["纵向偏移", "bottom"],
    ["大小", "width"],
    ["前后层级", "zIndex"],
  ]) {
    const slider = page.getByRole("slider", { name: label, exact: true });
    const piece = page.locator('[data-instance="plant"]');
    const before = await piece.evaluate((n, p) => n.style[p], property);
    await slider.scrollIntoViewIfNeeded();
    const box = await slider.boundingBox();
    const values = await slider.evaluate((n) => ({
      min: Number(n.min),
      max: Number(n.max),
      value: Number(n.value),
    }));
    const track = box.width - 16;
    const x =
      box.x +
      8 +
      (track * (values.value - values.min)) / (values.max - values.min);
    await page.mouse.move(x, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 8 + track * 0.8, box.y + box.height / 2, {
      steps: 5,
    });
    check(
      `${label} previews while dragging before release`,
      (await piece.evaluate((n, p) => n.style[p], property)) !== before,
    );
    check(
      `${label} updates its displayed value`,
      await slider.evaluate(
        (n) => n.parentElement.querySelector("output").value === n.value,
      ),
    );
    await page.mouse.up();
  }
  check(
    "slider previews do not persist until save",
    !f.runtime.home.read("living").layout.objects.plant,
  );
  await page.click("#save");
  await page.waitForFunction(() =>
    document.getElementById("toast").textContent.includes("布置已保存"),
  );
  const savedPlant = f.runtime.home.read("living").layout.objects.plant;
  check(
    "all four slider values persist",
    ["dx", "dy", "scale", "z"].every(
      (key) => typeof savedPlant[key] === "number",
    ),
  );
  await page.reload();
  await ready(page, "#living");
  await editor(page);
  await page.selectOption("#object-select", "plant");
  check(
    "slider value survives reload",
    Number(
      await page.getByRole("slider", { name: "横向偏移" }).inputValue(),
    ) === savedPlant.dx,
  );
  await page.locator("#editor-more summary").click();
  await page.click("#undo");
  await page.waitForFunction(() =>
    document.getElementById("toast").textContent.includes("撤销后的新版本"),
  );
  await editor(page);
  await page.selectOption("#palette", "blue");
  await page.click("#save");
  await page.waitForFunction(() =>
    document.getElementById("toast").textContent.includes("布置已保存"),
  );
  await page.reload();
  await ready(page, "#living");
  check(
    "save survives page reload",
    await page
      .locator("body")
      .evaluate((n) => n.classList.contains("palette-blue")),
  );
  await editor(page);
  await page.locator("#editor-more summary").click();
  await page.click("#reset");
  check(
    "reset is only an unsaved draft",
    f.runtime.home.read("living").layout.palette === "blue",
  );
  await page.locator("#editor-more summary").click();
  await page.click("#discard");
  await ready(page, "#living");
  await editor(page);
  await page.locator("#editor-more summary").click();
  await page.click("#undo");
  await page.waitForFunction(() =>
    document.getElementById("toast").textContent.includes("撤销后的新版本"),
  );
  check(
    "undo appends a revision",
    f.runtime.home.read("living").layout.palette === "cream",
  );
  await editor(page);
  await page.selectOption("#palette", "rose");
  const old = f.runtime.home.read("living");
  f.runtime.home.saveShared("living", {
    layout: { ...old.layout, palette: "blue" },
    expectedRevision: old.layoutRevision,
    rosterRevision: old.rosterRevision,
    requestId: "browser-other-window",
  });
  await page.click("#save");
  await page.waitForFunction(() =>
    document.getElementById("save-status").textContent.includes("已有新版本"),
  );
  check(
    "stale browser cannot overwrite another save",
    f.runtime.home.read("living").layout.palette === "blue" &&
      (await page.locator("#save").isDisabled()),
  );
  await page.locator("#editor-more summary").click();
  await page.click("#discard");
  await ready(page, "#living");
  await page.clock.install();
  const oldEnvelope = f.runtime.home.read("living");
  f.runtime.home.saveShared("living", {
    layout: { ...oldEnvelope.layout, palette: "cream" },
    expectedRevision: oldEnvelope.layoutRevision,
    rosterRevision: oldEnvelope.rosterRevision,
    requestId: "delayed-poll-save",
  });
  let releasePoll, pollArrived;
  const released = new Promise((resolve) => {
    releasePoll = resolve;
  });
  const arrived = new Promise((resolve) => {
    pollArrived = resolve;
  });
  await page.route("**/api/home/scene?type=living", async (r) => {
    const response = await r.fetch();
    pollArrived();
    await released;
    await r.fulfill({ response });
  });
  await page.clock.runFor(10000);
  await arrived;
  await editor(page);
  await page.selectOption("#palette", "rose");
  releasePoll();
  await page.waitForResponse((r) =>
    r.url().includes("/api/home/scene?type=living"),
  );
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  check(
    "late poll never replaces a draft started during the request",
    (await page
      .locator("body")
      .evaluate((n) => n.classList.contains("palette-rose"))) &&
      (await page.locator("#layout-status").textContent()).includes("正在试摆"),
  );
  await page.unroute("**/api/home/scene?type=living");
  await page.click("#save");
  await page.waitForFunction(() =>
    document.getElementById("save-status").textContent.includes("已有新版本"),
  );
  check(
    "late-poll draft retains its original expected revision",
    f.runtime.home.read("living").layout.palette === "cream",
  );
  await page.locator("#editor-more summary").click();
  await page.click("#discard");
  await ready(page, "#living");
  const post = await request("/api/board/post", {
    title: "合成验收便签",
    body: "浏览留言不唤醒角色。",
    requestId: "browser-seed-post",
  });
  const reads = f.store.db.prepare("SELECT * FROM board_reads").all();
  await page.click("#entry-toggle");
  await page
    .locator("#scene-actions button")
    .filter({ hasText: "打开留言板" })
    .click();
  await page.locator(`[data-board-open="${post.id}"]`).click();
  await page.locator("[data-board-compose] textarea").fill("合成管理员评论");
  await page.locator("[data-board-compose] button[type=submit]").click();
  await page.waitForFunction(() =>
    document
      .querySelector(".board-replies")
      ?.textContent.includes("合成管理员评论"),
  );
  await page.locator("[data-board-pin]").click();
  await page.waitForFunction(
    () =>
      document.querySelector("[data-board-pin]")?.textContent === "取消置顶",
  );
  check(
    "full board works while disabled for agents",
    !f.runtime.config.board.enabled &&
      (await request(`/api/board/post?id=${post.id}`)).total === 1,
  );
  assert.deepEqual(
    f.store.db.prepare("SELECT * FROM board_reads").all(),
    reads,
  );
  check(
    "board browsing leaves agent cursors and jobs alone",
    f.runtime.jobs.size === 0,
  );
  await page.screenshot({
    path: path.join(output, "board-desktop.png"),
    fullPage: true,
  });
  await page.click("#close-reader");
  if (await page.locator("#editor").isVisible())
    await page.click("#editor-close");
  await page.screenshot({
    path: path.join(output, "living-desktop.png"),
    fullPage: true,
  });
  for (const width of [375, 390]) {
    await page.setViewportSize({ width, height: 844 });
    for (const route of ["living", "hall/1", "room/agent-0"]) {
      await go(page, route);
      check(
        `no overflow ${width} ${route}`,
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      await page.screenshot({
        path: path.join(output, `${route.replaceAll("/", "-")}-${width}.png`),
        fullPage: true,
      });
    }
    await go(page, "living");
    await page.click("#entry-toggle");
    await page
      .locator("#scene-actions button")
      .filter({ hasText: "打开留言板" })
      .click();
    await page.locator("[data-board-open]").first().waitFor();
    check(
      `board dialog fits ${width}`,
      await page
        .locator("#reader")
        .evaluate((n) => n.scrollWidth <= n.clientWidth),
    );
    await page.screenshot({
      path: path.join(output, `board-${width}.png`),
      fullPage: true,
    });
    await page.click("#close-reader");
  }
  await page.setViewportSize({ width: 1440, height: 1100 });
  for (const count of [0, 1, 2, 3, 4, 7]) {
    await f.runtime.commitConfig(config(count), f.runtime.configStore.revision);
    await go(page, "hall/1");
    check(
      `${count} residents without fake rooms`,
      (await page.locator('#stage [data-instance^="door-"]').count()) ===
        Math.min(count, 3),
    );
  }
  await go(page, "room/agent-0");
  await page.evaluate(() => sessionStorage.removeItem("qq-unified-token"));
  await page.click("#menu-toggle");
  await page.click("#refresh");
  await page.waitForFunction(
    () => document.getElementById("home-content").hidden,
  );
  check(
    "lost login clears resident names",
    !(await page.locator("body").textContent()).includes("角色0"),
  );
  await page.evaluate(
    (t) => sessionStorage.setItem("qq-unified-token", t),
    token,
  );
  await go(page, "hall/1");
  await page.route("**/api/home/overview", (r) => r.abort());
  await page.click("#menu-toggle");
  await page.click("#refresh");
  await page.waitForFunction(
    () => document.getElementById("home-content").hidden,
  );
  check(
    "network failure clears private scene",
    (await page.locator("#stage").textContent()) === "",
  );
  await page.unroute("**/api/home/overview");
  await page.goto(base + "/?view=board");
  await page.locator("[data-board-open]").first().waitFor();
  check(
    "legacy board bookmark opens the same board inside the home",
    page.url().includes("/home-space/") &&
      (await page.locator("#reader-content").textContent()).includes(
        "合成验收便签",
      ),
  );
  check("no browser script errors", errors.length === 0);
  await fs.writeFile(
    path.join(output, "report.json"),
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ passed: checks.length, errors }));
} finally {
  await browser.close();
  await app.close();
  for (const fn of cleanup.reverse()) await fn();
}
