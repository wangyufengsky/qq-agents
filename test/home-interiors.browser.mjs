/* global document, getComputedStyle, innerWidth */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { fixture, config, context as turnContext } from "./helpers.mjs";
import { createServer } from "../src/server.mjs";

if (!process.env.CHROME_PATH) throw Error("CHROME_PATH_REQUIRED");
const output =
  process.env.HOME_INTERIORS_OUTPUT ||
  (await fs.mkdtemp(path.join(os.tmpdir(), "home-interiors-")));
await fs.mkdir(output, { recursive: true });
const cleanup = [],
  cfg = config(3);
cfg.agents[0].subject.enabled = true;
cfg.agents[0].home = { enabled: true, publishing: true, maxWritesPerDay: 20 };
const f = fixture({ after: (fn) => cleanup.push(fn) }, { cfg });
const token = "test-admin-token-placeholder",
  app = createServer({ runtime: f.runtime, token, allowLive: true });
const base = `http://127.0.0.1:${await app.listen()}`;
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH,
  headless: true,
});
const checks = [],
  errors = [],
  external = [];
function check(name, value) {
  assert.ok(value, name);
  checks.push(name);
}
async function api(url, body) {
  const response = await fetch(base + url, {
    method: body ? "POST" : "GET",
    headers: { "x-admin-token": token, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.equal(response.status, 200);
  return response.json();
}
try {
  for (const [index, title, body] of [
    [
      1,
      "窗边的小花开了",
      "今天给窗台的小花浇了水。等阳光照进来，整个客厅都暖暖的。",
    ],
    [
      2,
      "留一盏灯",
      "晚归的时候，记得看看桌上的小纸条。热茶和故事都在这里等你。",
    ],
    [
      3,
      "周末的约定",
      "找个晴天，一起收拾书架吧。把喜欢的小物件摆好，再慢慢读一本书。",
    ],
  ])
    await api("/api/board/post", {
      title,
      body,
      requestId: `interiors-post-${index}`,
    });
  const ctx = turnContext(f.runtime, "agent-0", "@subject");
  let room = await f.runtime.executeTool(ctx, "room_read", {});
  for (const slot of ["intro", "work-1", "work-2", "work-3"]) {
    await f.runtime.executeTool(ctx, "room_publish", {
      identityGeneration: room.identityGeneration,
      slot,
      expectedItemRevision: 0,
      requestId: `interiors-${slot}`,
      title: slot === "intro" ? "欢迎来坐坐" : "留在纸上的小故事",
      body: "风从窗边吹过，把阳光翻到下一页。我们把今天的好心情，轻轻放进这间小屋。\n\n".repeat(
        slot === "work-1" ? 80 : 2,
      ),
      source: "original-text",
    });
  }
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (!r.url().startsWith(base)) external.push(new URL(r.url()).origin);
  });
  await page.goto(base);
  await page.evaluate(
    (t) => sessionStorage.setItem("qq-unified-token", t),
    token,
  );
  const nav = page.locator('a[href="/home-space/"]');
  check(
    "home replaces the board navigation slot",
    (await nav.evaluate(
      (n) =>
        n.previousElementSibling?.dataset.section === "links" &&
        n.nextElementSibling?.dataset.section === "system",
    )) && (await page.locator('[data-section="board"]').count()) === 0,
  );
  async function go(route = "living") {
    await page.goto(`${base}/home-space/#${route}`);
    await page.reload();
    await page.waitForFunction(
      (r) =>
        document.getElementById("stage").dataset.route === `#${r}` &&
        !document.getElementById("home-content").hidden &&
        !document.getElementById("stage").inert,
      route,
    );
    await page.evaluate(() => document.fonts.ready);
  }
  async function open(name) {
    await page.click("#entry-toggle");
    await page
      .locator("#scene-actions")
      .getByRole("button", { name, exact: true })
      .click();
  }
  async function shot(name) {
    await page.screenshot({
      path: path.join(output, `${name}.png`),
      fullPage: true,
    });
  }
  async function fits(name) {
    check(
      name,
      await page.evaluate(() => {
        const d = document.getElementById("reader");
        const c = document.getElementById("reader-content");
        return (
          document.documentElement.scrollWidth <= innerWidth &&
          (!d.open ||
            (d.getBoundingClientRect().right <= innerWidth &&
              c.scrollWidth <= c.clientWidth + 1))
        );
      }),
    );
  }
  await go();
  check(
    "local handwriting font loaded",
    await page.evaluate(
      () =>
        document.fonts.check('18px "Paper Nest Hand"', "纸页小窝") &&
        getComputedStyle(document.body).fontFamily.includes("Paper Nest Hand"),
    ),
  );
  check(
    "separate console return and no example entry",
    (await page.locator("#console-return").isVisible()) &&
      (await page.locator('a[href="/home-preview/"]').count()) === 0,
  );
  for (const id of ["board", "guide"]) {
    const piece = page.locator(`[data-instance="${id}"]`);
    await page.mouse.move(0, 0);
    await page.locator("#brand-home").focus();
    check(
      `${id} has no permanent label`,
      (await piece.locator(".object-ink").count()) === 0 &&
        !(await piece.locator(".label").isVisible()),
    );
    await piece.hover();
    check(
      `${id} label appears on hover`,
      await piece.locator(".label").isVisible(),
    );
    await page.mouse.move(0, 0);
    await piece.focus();
    check(
      `${id} label appears on keyboard focus`,
      await piece.locator(".label").isVisible(),
    );
  }
  await open("打开留言板");
  await page.locator("[data-board-open]").first().waitFor();
  check(
    "search tools start folded",
    !(await page.locator(".board-search-drawer").evaluate((n) => n.open)),
  );
  await shot("board-desktop");
  await page.locator(".board-search-drawer summary").click();
  await page.locator('[name="q"]').fill("小花");
  await page.waitForFunction(
    () => document.querySelectorAll("[data-board-open]").length === 1,
  );
  check(
    "search remains accessible after filtering",
    await page.locator('[name="q"]').isVisible(),
  );
  await page.click("[data-board-clear]");
  await page.waitForFunction(
    () => document.querySelectorAll("[data-board-open]").length === 3,
  );
  await page.locator(".board-search-drawer summary").click();
  async function preferences() {
    await page.locator(".board-settings summary").click();
    await page.click('[data-do="board-settings"]');
    await page.locator('.board-preferences [name="dailyPosts"]').waitFor();
  }
  const before = structuredClone(f.runtime.config);
  await preferences();
  await page.locator('[name="dailyPosts"]').fill("4");
  await page.getByRole("button", { name: "收好约定", exact: true }).click();
  await page.locator(".board-preferences").waitFor({ state: "detached" });
  const expected = structuredClone(before);
  expected.board.dailyPosts = 4;
  assert.deepEqual(f.runtime.config, expected);
  check("board settings preserve unrelated configuration", true);
  await preferences();
  const other = structuredClone(f.runtime.config);
  other.board.dailyComments = 12;
  await f.runtime.commitConfig(other, f.runtime.configStore.revision);
  await page.locator('[name="dailyPosts"]').fill("5");
  await page.getByRole("button", { name: "收好约定", exact: true }).click();
  await page
    .locator('.board-preferences [role="status"]')
    .filter({ hasText: "没有保存" })
    .waitFor();
  check(
    "concurrent config is protected and draft stays editable",
    f.runtime.config.board.dailyPosts === 4 &&
      f.runtime.config.board.dailyComments === 12 &&
      (await page.locator('[name="dailyPosts"]').inputValue()) === "5",
  );
  await page.click("#close-reader");
  await open("打开留言板");
  await page.locator(".board-settings summary").click();
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let arrived;
  const arrival = new Promise((resolve) => {
    arrived = resolve;
  });
  await page.route("**/api/config", async (route) => {
    const response = await route.fetch();
    arrived();
    await held;
    await route.fulfill({ response });
  });
  await page.click('[data-do="board-settings"]');
  await arrival;
  await page.click("#close-reader");
  release();
  await page.waitForResponse((r) => r.url().endsWith("/api/config"));
  check(
    "late settings response cannot reopen a closed reader",
    !(await page.locator("#reader").evaluate((n) => n.open)) &&
      (await page.locator(".board-preferences").count()) === 0,
  );
  await page.unroute("**/api/config");
  await open("翻开参观小册");
  await page.getByRole("button", { name: "后一页 →", exact: true }).click();
  check(
    "booklet advances and keeps keyboard focus",
    (await page.locator(".guide-pagination").textContent()).includes("2 / 3") &&
      (await page.evaluate(
        () => document.activeElement.textContent === "后一页 →",
      )),
  );
  await shot("guide-desktop");
  await page.keyboard.press("Escape");
  await page.click("#edit-toggle");
  await page.locator('#object-strip [data-object="board"]').click();
  check(
    "toolbox selection retains focus",
    await page.evaluate(
      () => document.activeElement.dataset.object === "board",
    ),
  );
  await page.locator('[data-instance="guide"]').focus();
  await page.keyboard.press("Enter");
  check(
    "scene keyboard selects furniture without opening reader",
    (await page
      .locator('#object-strip [data-object="guide"]')
      .getAttribute("aria-pressed")) === "true" &&
      !(await page.locator("#reader").evaluate((n) => n.open)),
  );
  await shot("toolbox-desktop");
  for (const width of [320, 375, 390, 640, 1024, 1440]) {
    await page.setViewportSize({ width, height: 950 });
    await go();
    await page.locator('[data-instance="board"]').hover();
    await fits(`scene and hover fit ${width}`);
    await page.click("#edit-toggle");
    await fits(`toolbox fits ${width}`);
    if (width === 390) await shot("toolbox-mobile");
    await page.click("#edit-toggle");
    for (const [name, kind] of [
      ["打开留言板", "board"],
      ["翻开参观小册", "guide"],
    ]) {
      await open(name);
      if (kind === "board")
        await page.locator("[data-board-open]").first().waitFor();
      await fits(`${kind} fits ${width}`);
      if (width === 390) await shot(`${kind}-mobile`);
      await page.click("#close-reader");
    }
    await go("room/agent-0");
    await open("查看作品展示");
    await page.locator(".home-text-card").first().waitFor();
    await fits(`works fit ${width}`);
    check(
      `long writing remains scrollable ${width}`,
      await page
        .locator('[data-slot="work-1"] .home-text')
        .evaluate((n) => n.scrollHeight > n.clientHeight),
    );
    if (width === 390 || width === 1440) await shot(`works-${width}`);
    if (width === 1440) {
      const text = page.locator('[data-slot="work-1"] .home-text');
      await text.evaluate((n) => (n.scrollTop = 250));
      const previousParagraph = await text.elementHandle();
      await page.waitForResponse((response) =>
        response.url().includes("/api/home/content?"),
      );
      await page.waitForFunction(
        (node) => !node.isConnected,
        previousParagraph,
      );
      await page.waitForFunction(
        () =>
          document.querySelector('[data-slot="work-1"] .home-text')
            .scrollTop === 250,
      );
      check(
        "content refresh preserves long-text reading position",
        await text.evaluate((n) => n.scrollTop === 250),
      );
    }
    await page.click("#close-reader");
  }
  await page.goto(base + "/?view=board");
  await page.locator("[data-board-open]").first().waitFor();
  check(
    "legacy board URL enters the home",
    page.url().endsWith("/home-space/#living"),
  );
  check("no external font or asset requests", external.length === 0);
  check("no script errors", errors.length === 0);
  check(
    "browsing and layout tools never invoke models or send QQ",
    f.runtime.jobs.size === 0 &&
      [...f.runtime.transports.values()].every((v) => !v.sent.length),
  );
  await fs.writeFile(
    path.join(output, "interiors-report.json"),
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ passed: checks.length, errors }));
} finally {
  await browser.close();
  await app.close();
  for (const fn of cleanup.reverse()) await fn();
}
