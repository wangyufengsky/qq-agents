/* global document */
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { fixture, config, context as turnContext } from "./helpers.mjs";
import { createServer } from "../src/server.mjs";
if (!process.env.CHROME_PATH) throw Error("CHROME_PATH_REQUIRED");
const cleanup = [],
  cfg = config();
for (const a of cfg.agents) {
  a.subject.enabled = true;
  a.home = { enabled: true, publishing: true, maxWritesPerDay: 20 };
}
const f = fixture({ after: (fn) => cleanup.push(fn) }, { cfg });
const ctx = turnContext(f.runtime, "agent-0", "@subject");
const call = (n, a = {}) => f.runtime.executeTool(ctx, n, a);
let request = 0;
async function publish(body, slot = "intro") {
  const v = await call("room_read");
  return call("room_publish", {
    identityGeneration: v.identityGeneration,
    requestId: "browser-" + ++request,
    slot,
    expectedItemRevision: v.items.find((i) => i.slot === slot).itemRevision,
    title: "合成介绍",
    body,
    source: "original-text",
  });
}
const token = "test-admin-token-placeholder",
  app = createServer({ runtime: f.runtime, token });
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
try {
  const browserContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
    }),
    page = await browserContext.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(base + "/home-space/");
  await page.evaluate(
    (t) => sessionStorage.setItem("qq-unified-token", t),
    token,
  );
  async function open() {
    await page.goto(base + "/home-space/#room/agent-0");
    await page.reload();
    await page.waitForFunction(
      () =>
        !document.getElementById("home-content").hidden &&
        document.getElementById("stage").dataset.route === "#room/agent-0",
    );
    await page
      .locator("#scene-actions")
      .getByRole("button", { name: "查看介绍卡", exact: true })
      .click();
  }
  const payload =
    '<img src=x onerror="document.body.dataset.injected=1"> 合成正文';
  await publish(payload);
  await open();
  await page.waitForFunction(
    (s) => document.getElementById("reader-content").textContent.includes(s),
    payload,
  );
  check(
    "published text renders literally",
    (await page.locator("#reader-content img").count()) === 0 &&
      !(await page.locator("body").getAttribute("data-injected")),
  );
  for (const width of [375, 390, 1440]) {
    await page.setViewportSize({ width, height: 950 });
    check(
      `reader fits ${width}px`,
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth + 1,
      ),
    );
  }
  await page.getByRole("button", { name: "隐藏此内容", exact: true }).click();
  await page.waitForFunction(() =>
    document
      .getElementById("reader-content")
      .textContent.includes("已被管理员隐藏"),
  );
  check(
    "admin hide removes original body",
    !(await page.locator("#reader-content").textContent()).includes(payload),
  );
  await page
    .getByRole("button", { name: "解除隐藏限制（不恢复正文）", exact: true })
    .click();
  await page.waitForFunction(() =>
    document.getElementById("reader-content").textContent.includes("已撤回"),
  );
  check(
    "release does not restore text",
    f.runtime.home.rooms.display("agent-0").items[0].body === undefined,
  );
  await publish("RETRACT_ME");
  await open();
  await page.waitForFunction(() =>
    document
      .getElementById("reader-content")
      .textContent.includes("RETRACT_ME"),
  );
  const view = await call("room_read");
  await call("room_retract", {
    identityGeneration: view.identityGeneration,
    slot: "intro",
    expectedItemRevision: view.items[0].itemRevision,
    requestId: "browser-retract",
  });
  await page.waitForFunction(
    () =>
      !document
        .getElementById("reader-content")
        .textContent.includes("RETRACT_ME"),
    null,
    { timeout: 16000 },
  );
  check("open reader drops retracted text on poll", true);
  await publish("DISABLE_ME");
  await open();
  await page.waitForFunction(() =>
    document
      .getElementById("reader-content")
      .textContent.includes("DISABLE_ME"),
  );
  f.runtime.agent("agent-0").home.publishing = false;
  await page.waitForFunction(
    () =>
      document
        .getElementById("reader-content")
        .textContent.includes("尚未开启或已关闭"),
    null,
    { timeout: 16000 },
  );
  check(
    "publishing switch clears open text",
    !(await page.locator("#reader-content").textContent()).includes(
      "DISABLE_ME",
    ),
  );
  f.runtime.agent("agent-0").home.publishing = true;
  await open();
  await page.waitForFunction(() =>
    document
      .getElementById("reader-content")
      .textContent.includes("DISABLE_ME"),
  );
  // Hold only content replies: overview success must not extend content's lease.
  const held = [];
  await page.route("**/api/home/content?**", async (route) => {
    const response = await route.fetch();
    held.push({ route, response });
  });
  await page.waitForFunction(
    () =>
      !document
        .getElementById("reader-content")
        .textContent.includes("DISABLE_ME"),
    null,
    { timeout: 19000 },
  );
  check("stalled content cannot keep old text alive", true);
  for (const { route, response } of held)
    await route.fulfill({ response }).catch(() => {});
  await page.unroute("**/api/home/content?**");
  check(
    "late response cannot revive expired display",
    !(await page.locator("#reader-content").textContent()).includes(
      "DISABLE_ME",
    ),
  );
  await open();
  await page.waitForFunction(() =>
    document
      .getElementById("reader-content")
      .textContent.includes("DISABLE_ME"),
  );
  await page.evaluate(() => sessionStorage.removeItem("qq-unified-token"));
  await page.waitForFunction(
    () => document.getElementById("home-content").hidden,
    null,
    { timeout: 16000 },
  );
  check(
    "login loss clears published text",
    !(await page.locator("body").textContent()).includes("DISABLE_ME"),
  );
  check("no browser script errors", errors.length === 0);
  check(
    "no QQ sends or model jobs",
    [...f.runtime.transports.values()].every((v) => !v.sent.length) &&
      f.runtime.jobs.size === 0,
  );
  console.log(JSON.stringify({ checks, errors }, null, 2));
} finally {
  await browser.close();
  await app.close();
  for (const fn of cleanup.reverse()) await fn();
}
