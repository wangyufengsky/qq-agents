/* global document */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright-core";
import { fixture, config } from "./helpers.mjs";
import { createServer } from "../src/server.mjs";

if (!process.env.CHROME_PATH) throw Error("CHROME_PATH_REQUIRED");
const cleanup = [],
  cfg = config(2);
for (const a of cfg.agents) a.home.enabled = true;
const f = fixture({ after: (fn) => cleanup.push(fn) }, { cfg });
const s = f.runtime.home.social,
  db = s.db,
  now = f.runtime.now();
const host = s.identity("agent-0").generation,
  guest = s.identity("agent-1").generation;
const invitationId = randomUUID(),
  visitId = randomUUID(),
  messageId = randomUUID();
db.prepare(
  "INSERT INTO home_social_invitations(id,host_agent_id,host_generation,guest_agent_id,guest_generation,initiator_generation,recipient_generation,room_id,audience,requested_scope,status,policy_revision,created_at,expires_at) VALUES(?,'agent-0',?,'agent-1',?,?,?,'room-fixture','[]',?,'accepted',1,?,?)",
).run(
  invitationId,
  host,
  guest,
  host,
  guest,
  JSON.stringify({ scope: ["layout"], selectedItems: [] }),
  now,
  now + 86400000,
);
db.prepare(
  "INSERT INTO home_social_visits(id,invitation_id,host_agent_id,host_generation,guest_agent_id,guest_generation,room_id,pair_key,status,policy_revision,started_at,expires_at) VALUES(?,?,'agent-0',?,'agent-1',?,'room-fixture','fixture-pair','active',1,?,?)",
).run(visitId, invitationId, host, guest, now, now + 86400000);
db.prepare(
  "INSERT INTO home_social_messages(id,visit_id,author_agent_id,author_generation,sequence,body,source_labels,audience,created_at) VALUES(?,?,'agent-0',?,1,?,'[]','[]',?)",
).run(
  messageId,
  visitId,
  host,
  "<img src=x onerror=alert(1)>合成实际接口消息",
  now,
);
const token = "synthetic-admin-token",
  app = createServer({ runtime: f.runtime, token }),
  base = `http://127.0.0.1:${await app.listen()}`;
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH,
  headless: true,
});
try {
  const context = await browser.newContext({
    viewport: { width: 375, height: 900 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(base);
  await page.evaluate(
    (t) => sessionStorage.setItem("qq-unified-token", t),
    token,
  );
  await page.goto(base + "/home-space/#room/agent-0");
  await page.locator("#home-content").waitFor({ state: "visible" });
  await page.locator("#menu-toggle").click();
  await page.locator("#social-open").click();
  await page
    .locator(".social-row")
    .filter({ hasText: "进行中" })
    .getByRole("button", { name: "核验权限并查看详情" })
    .click();
  await page
    .getByText("<img src=x onerror=alert(1)>合成实际接口消息", { exact: true })
    .waitFor();
  assert.equal(await page.locator("#reader-content img").count(), 0);
  assert.equal(
    db
      .prepare(
        "SELECT count(*) AS n FROM home_social_admin_access_audit WHERE outcome='success'",
      )
      .get().n,
    1,
  );
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM home_social_read_cursors").get().n,
    0,
  );
  assert.equal(
    await page.getByRole("button", { name: /接受邀请|发送消息/ }).count(),
    0,
  );
  assert.ok(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth + 1,
    ),
  );
  await page.getByRole("button", { name: "隐藏这条消息（管理操作）" }).click();
  await page.getByText("正文已由管理员隐藏。", { exact: true }).waitFor();
  assert.ok(
    db
      .prepare("SELECT hidden_at FROM home_social_messages WHERE id=?")
      .get(messageId).hidden_at,
  );
  await page.getByRole("button", { name: "终止拜访（管理操作）" }).click();
  await page.waitForFunction(
    () =>
      !Array.from(document.querySelectorAll("button")).some(
        (b) => b.textContent === "终止拜访（管理操作）",
      ),
  );
  assert.equal(
    db.prepare("SELECT status FROM home_social_visits WHERE id=?").get(visitId)
      .status,
    "invalidated",
  );
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM home_social_read_cursors").get().n,
    0,
  );
  assert.equal(f.runtime.config.homeSocial.enabled, false);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      synthetic: true,
      realHttp: true,
      checks: [
        "packaged scripts without interception",
        "audited real DTO",
        "plain text and mobile width",
        "admin hide and terminate",
        "no AI cursor or capability enablement",
      ],
    }),
  );
} finally {
  await browser.close();
  await app.close();
  for (const fn of cleanup.reverse()) await fn();
}
