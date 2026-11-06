/* global document, innerWidth */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright-core";
import { fixture, config } from "./helpers.mjs";
import { createServer } from "../src/server.mjs";
import { findScreenshotBrowser } from "../src/tools/public-screenshot.mjs";

const cleanup = [],
  cfg = config(3);
cfg.homeSocial.enabled = true;
for (const agent of cfg.agents) {
  agent.home.enabled = true;
  agent.home.social.enabled = true;
  agent.subject.enabled = true;
  agent.subject.offlineReview = true;
  agent.subject.reviewInSilence = true;
}
const f = fixture({ after: (fn) => cleanup.push(fn) }, { cfg });
const service = f.runtime.homeSocial,
  db = f.store.db;
function actor(agentId, target) {
  const base = service.targetBinding(service.identity(agentId), target),
    turnId = randomUUID();
  db.prepare(
    "UPDATE home_social_turns SET status='completed' WHERE actor_generation=? AND status='running'",
  ).run(base.actorIdentity.generation);
  const ctx = f.runtime.makeContext(agentId, `@social:${turnId}`);
  ctx.runtimeKind = "subject-social";
  ctx.socialBinding = {
    ...base,
    runId: turnId,
    turnId,
    runMode: "async",
    windowId: null,
    epoch: 0,
    fence: 0,
  };
  db.prepare(
    "INSERT INTO home_social_turns(id,visit_id,target_kind,target_id,target_host_generation,target_guest_generation,actor_generation,mode,status,epoch,fence,policy_revision,config_revision,created_at) VALUES(?,?,?,?,?,?,?,'async','running',0,0,?,?,?)",
  ).run(
    turnId,
    base.target.kind === "visit" ? base.target.id : null,
    base.target.kind,
    base.target.id,
    base.targetHostGeneration,
    base.targetGuestGeneration,
    base.actorIdentity.generation,
    base.policyRevision,
    base.configRevision,
    f.runtime.now(),
  );
  return ctx;
}
function makeVisit(peer, roomOwner, body) {
  const owner = actor("agent-0", { kind: "compose", id: peer });
  const invitationId = service.invite(owner, {
    requestId: randomUUID(),
    targetAgentId: peer,
    roomOwnerAgentId: roomOwner,
    purpose: "合成访问阅读验收",
    scope: ["layout"],
    selectedItems: [],
  }).result.invitationId;
  const recipient = actor(peer, { kind: "invitation", id: invitationId });
  service.invitationRead(recipient, { invitationId });
  const visitId = service.decide(recipient, {
    requestId: randomUUID(),
    invitationId,
    expectedInvitationRevision: 1,
    decision: "accept",
  }).result.visitId;
  service.send(actor("agent-0", { kind: "visit", id: visitId }), {
    requestId: randomUUID(),
    visitId,
    expectedVisitRevision: 1,
    body,
  });
  return visitId;
}
const firstVisit = makeVisit("agent-1", "agent-0", "访问甲的合成对话正文");
const secondVisit = makeVisit("agent-2", "agent-2", "访问乙的合成对话正文");
const memory = f.store.bind("agent-0");
memory.append({
  dedupe: "record-menu-fixture",
  conversation: "private:30000",
  kind: "message.received",
  senderId: "30000",
  body: "只出现在记忆页的合成经历",
  occurredAt: new Date().toISOString(),
  observedAt: new Date().toISOString(),
});
memory.diaryWrite({ title: "只出现在日记页的合成标题", body: "合成日记全文" });
const app = createServer({
  runtime: f.runtime,
  token: "synthetic-record-menu-token",
});
const base = `http://127.0.0.1:${await app.listen()}`;
const browser = await chromium.launch({
  executablePath: findScreenshotBrowser(),
  headless: true,
});
try {
  const context = await browser.newContext({
    viewport: { width: 375, height: 900 },
  });
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base + "/?view=memory&agentId=agent-0");
  await page.locator("#token").fill("synthetic-record-menu-token");
  await page.locator("#login-button").click();
  await page
    .locator("#memory-results")
    .getByText("只出现在记忆页的合成经历", { exact: true })
    .first()
    .waitFor();
  assert.equal(
    await page
      .locator("#memory-results")
      .getByText("只出现在日记页的合成标题", { exact: true })
      .count(),
    0,
  );
  for (const name of ["memory", "diary", "visits"])
    assert.equal(await page.locator(`[data-page="${name}"]`).count(), 1);
  await page.locator('[data-page="diary"]').click();
  await page
    .locator("#memory-results")
    .getByText("只出现在日记页的合成标题", { exact: true })
    .waitFor();
  assert.equal(
    await page
      .locator("#memory-results")
      .getByText("只出现在记忆页的合成经历", { exact: true })
      .count(),
    0,
  );
  await page.locator("#memory-query").fill("找不到的日记内容");
  await page.locator("#search-memory").click();
  await page
    .locator("#memory-results")
    .getByText("没有匹配记录。", { exact: true })
    .waitFor();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
    "RECORD_MENUS_MOBILE_OVERFLOW",
  );
  await page.locator('[data-page="visits"]').click();
  await page.locator(`[data-letter-id="${firstVisit}"]`).waitFor();
  assert.equal(await page.locator("[data-letter-id]").count(), 2);
  await page.locator(`[data-letter-id="${firstVisit}"]`).click();
  await page.getByText("访问甲的合成对话正文", { exact: true }).waitFor();
  assert.equal(
    db.prepare("SELECT count(*) n FROM home_social_read_cursors").get().n,
    0,
  );
  await page.locator('[data-role="agent-2"]').click();
  await page.locator(`[data-letter-id="${secondVisit}"]`).waitFor();
  assert.equal(
    await page.getByText("访问甲的合成对话正文", { exact: true }).count(),
    0,
  );
  assert.equal(
    await page.locator(`[data-letter-id="${firstVisit}"]`).count(),
    0,
  );
  assert.equal(await page.locator("[data-letter-id]").count(), 1);
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
    "VISITS_MOBILE_OVERFLOW",
  );
  await page.goto(base + "/?view=diary&agentId=agent-1");
  await page.locator('[data-page="diary"][aria-selected="true"]').waitFor();
  assert.match(
    await page.locator('[data-role="agent-1"]').getAttribute("class"),
    /primary/,
  );
  assert.deepEqual(errors, []);
  await context.close();
  console.log(
    "record menus: separate queries, preserved filters and 375px layout passed",
  );
} finally {
  await browser.close();
  await app.close();
  for (const fn of cleanup.reverse()) await fn();
}
