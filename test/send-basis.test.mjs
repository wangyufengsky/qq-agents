import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { randomBytes } from "node:crypto";
import { fixture, config, context, settle } from "./helpers.mjs";
import { activityPage } from "../src/core/activity.mjs";
import { createServer } from "../src/server.mjs";

const group = "group:20000",
  peer = "private:30000";
const HOUR = 3600000;

function setup(t, options = {}) {
  const cfg = options.cfg || config(1);
  // Several sends in one conversation without a new message in between.
  cfg.agents[0].maxSendsPerTurn = 10;
  const f = fixture(t, { ...options, cfg });
  let now = Date.parse("2026-10-29T12:00:00Z");
  f.runtime.clock = () => new Date(now);
  const m = f.store.bind("agent-0");
  // A minute apart, so the per-minute send budget never interferes.
  const send = async (ctx, args) => {
    const r = await f.runtime.send(ctx, args);
    now += 61000;
    return r;
  };
  const tool = async (ctx, args) => {
    const r = await f.runtime.callTool(ctx, "qq_send", args);
    now += 61000;
    return r;
  };
  return { ...f, m, send, tool, advance: (ms) => (now += ms) };
}
const card = (f, personId, call, body, expectedRevision = 0) =>
  f.m.identity.savePersonCard(
    { personId, call, body, expectedRevision },
    { writtenIn: "console", author: "admin", now: f.runtime.now() },
  );
const feel = (f, mood, intensity = 3, hours = 4) =>
  f.m.identity.setMood(
    { mood, intensity, reason: "测试用的心情", hours },
    { writtenIn: group, now: f.runtime.now() },
  );
const payload = (f, dedupe) =>
  JSON.parse(
    f.m.db
      .prepare("SELECT payload FROM events WHERE agent_id=? AND dedupe=?")
      .get("agent-0", dedupe).payload,
  );

test("an outbound message records the card and mood it rested on, by reference only", async (t) => {
  const f = setup(t);
  const c = card(f, "30000", "阿明", "说话很直的老朋友");
  const mood = feel(f, "开心");
  const ctx = context(f.runtime);
  const receipt = await f.send(ctx, {
    requestId: "at-1",
    text: "在吗",
    atUserId: "30000",
  });
  // DeliveryService.send keeps its receipt; only the record gains references.
  assert.deepEqual(Object.keys(receipt).sort(), [
    "messageId",
    "recordId",
    "status",
  ]);
  const sent = payload(f, "send:at-1:sent");
  assert.deepEqual(sent.personCard, {
    id: c.id,
    personId: "30000",
    revision: 1,
  });
  assert.equal(sent.moodId, mood.id);
  assert.doesNotMatch(JSON.stringify(sent), /阿明|老朋友|开心|测试用的心情/);
  // The attempt carries them too: reconciliation copies its payload.
  assert.deepEqual(payload(f, "send:at-1:pending").personCard, sent.personCard);

  // In a private chat the card is the peer's, with no at-mention needed.
  await f.send(context(f.runtime, "agent-0", peer), {
    requestId: "dm-1",
    text: "早",
  });
  assert.deepEqual(payload(f, "send:dm-1:sent").personCard, sent.personCard);

  // A group message to nobody in particular rests on no card.
  await f.send(ctx, { requestId: "plain", text: "大家好" });
  assert.equal("personCard" in payload(f, "send:plain:sent"), false);
  assert.equal(payload(f, "send:plain:sent").moodId, mood.id);

  // Nobody's card, and a mood that has expired: neither is written.
  f.advance(4 * HOUR);
  await f.send(ctx, { requestId: "at-2", text: "你好", atUserId: "30001" });
  const later = payload(f, "send:at-2:sent");
  assert.equal("personCard" in later, false);
  assert.equal("moodId" in later, false);
});

test("references never change a receipt: same-ID resends and reconciliation", async (t) => {
  const f = setup(t);
  card(f, "30000", "阿明", "说话很直的老朋友");
  feel(f, "开心");
  const ctx = context(f.runtime),
    transport = f.runtime.transports.get("qq-0");
  const args = { requestId: "same", text: "在吗", atUserId: "30000" };
  const first = await f.send(ctx, args);
  // The card and mood move on; the same request is still the same request.
  card(f, "30000", "明哥", "改叫明哥", 1);
  feel(f, "困", 2);
  const again = await f.send(context(f.runtime), args);
  assert.equal(again.duplicate, true);
  assert.equal(again.messageId, first.messageId);
  assert.equal(transport.sent.length, 1);

  // An unknown receipt stays fenced, and settling it keeps its references.
  transport.failure = "TIMEOUT";
  await assert.rejects(
    f.send(ctx, { requestId: "lost", text: "晚上见", atUserId: "30000" }),
    /DELIVERY_UNKNOWN/,
  );
  transport.failure = null;
  const attempt = payload(f, "send:lost:pending");
  assert.equal(attempt.personCard.revision, 2);
  feel(f, "平静", 2);
  await assert.rejects(
    f.send(ctx, { requestId: "lost", text: "晚上见", atUserId: "30000" }),
    /DELIVERY_ALREADY_ATTEMPTED_UNKNOWN/,
  );
  assert.equal(f.m.unresolvedDeliveries().items[0].preview, "晚上见");
  assert.deepEqual(f.m.reconcileDelivery("lost", "sent"), {
    requestId: "lost",
    status: "sent",
  });
  const settled = payload(f, "send:lost:reconciled");
  assert.deepEqual(settled.personCard, attempt.personCard);
  assert.equal(settled.moodId, attempt.moodId);
});

test("fixed control text sends as before and rests on no card or mood", async (t) => {
  const cfg = config(1);
  cfg.agents[0].behavior.failureNotice = {
    enabled: true,
    text: "稍等，我刚才没接上",
    cooldownMs: 600000,
  };
  const f = setup(t, {
    cfg,
    run: async () => {
      throw Error("BACKEND_DOWN_FIXTURE");
    },
  });
  card(f, "30000", "阿明", "说话很直的老朋友");
  feel(f, "开心");
  await f.runtime.wake("agent-0", peer, { reasons: [{ reason: "private" }] });
  await settle(f.runtime);
  const notice = f.m.db
    .prepare(
      "SELECT payload FROM events WHERE agent_id=? AND kind='message.sent'",
    )
    .all("agent-0")
    .map((r) => JSON.parse(r.payload));
  assert.equal(notice.length, 1);
  assert.match(notice[0].requestId, /^turn-failure:/);
  assert.equal("personCard" in notice[0], false);
  assert.equal("moodId" in notice[0], false);
  // A scheduler or owner reply goes the same way.
  await f.runtime.withContext("agent-0", peer, (ctx) =>
    f.runtime.send(ctx, { requestId: "schedule:fixture", text: "到点了" }),
  );
  const fixed = payload(f, "send:schedule:fixture:sent");
  assert.equal("personCard" in fixed, false);
  assert.equal("moodId" in fixed, false);
});

test("qq_send brings the card of someone addressed before they spoke, once per version", async (t) => {
  const f = setup(t);
  const c = card(f, "30000", "阿明", "说话很直的老朋友");
  const ctx = context(f.runtime);
  const first = await f.tool(ctx, {
    requestId: "q1",
    text: "欢迎",
    atUserId: "30000",
  });
  assert.equal(first.status, "sent");
  assert.deepEqual(first.personCard, {
    personId: "30000",
    call: "阿明",
    impression: "说话很直的老朋友",
    revision: 1,
  });
  assert.equal(
    f.m.state(group).personCardsShown["30000"],
    `${c.id}:1`,
    "later turns of this session know it",
  );
  const second = await f.tool(ctx, {
    requestId: "q2",
    text: "再说一句",
    atUserId: "30000",
  });
  assert.equal("personCard" in second, false);

  // A new version is shown again, and so is a card deleted and written anew.
  card(f, "30000", "明哥", "喜欢被叫明哥", 1);
  assert.equal(
    (await f.tool(ctx, { requestId: "q3", text: "明哥", atUserId: "30000" }))
      .personCard.call,
    "明哥",
  );
  f.m.identity.deletePersonCard("30000", 2);
  card(f, "30000", "阿明", "重新认识");
  const renewed = await f.tool(ctx, {
    requestId: "q4",
    text: "你好",
    atUserId: "30000",
  });
  assert.equal(renewed.personCard.revision, 1);
  assert.equal(renewed.personCard.impression, "重新认识");

  // Nobody's card, or no at-mention: the receipt is unchanged.
  for (const args of [
    { requestId: "q5", text: "你是？", atUserId: "30001" },
    { requestId: "q6", text: "大家好" },
  ])
    assert.deepEqual(Object.keys(await f.tool(ctx, args)).sort(), [
      "messageId",
      "recordId",
      "status",
    ]);
});

test("a failed qq_send neither shows nor marks the card", async (t) => {
  const f = setup(t);
  card(f, "30000", "阿明", "说话很直的老朋友");
  const ctx = context(f.runtime),
    transport = f.runtime.transports.get("qq-0");
  transport.failure = "ONEBOT_REJECTED";
  await assert.rejects(
    f.tool(ctx, { requestId: "f1", text: "在吗", atUserId: "30000" }),
    /DELIVERY_FAILED/,
  );
  assert.equal(f.m.state(group).personCardsShown?.["30000"], undefined);
  transport.failure = null;
  const ok = await f.tool(ctx, {
    requestId: "f2",
    text: "在吗",
    atUserId: "30000",
  });
  assert.equal(ok.personCard.call, "阿明");
});

test("a card shown when the turn began is not repeated; one not yet shown comes once", async (t) => {
  const receipts = [];
  const f = setup(t, {
    run: async (p) => {
      p.saveSession({ id: "s", backend: "fixture" });
      for (const atUserId of ["30000", "30001", "30001"])
        receipts.push(
          await p.callTool("qq_send", {
            requestId: "w:" + receipts.length,
            text: "收到",
            atUserId,
          }),
        );
    },
  });
  card(f, "30000", "阿明", "说话很直的老朋友");
  card(f, "30001", "小林", "刚来的同学");
  f.m.append({
    dedupe: "said:1",
    conversation: group,
    kind: "message.received",
    body: "有人在吗",
    senderId: "30000",
  });
  await f.runtime.wake("agent-0", group);
  assert.equal(receipts.length, 3);
  assert.equal("personCard" in receipts[0], false, "already in the prompt");
  assert.equal(receipts[1].personCard.call, "小林");
  assert.equal("personCard" in receipts[2], false);
});

// Turns and sent messages laid out by hand, so every lookup case is pinned.
test("the activity page names the card version and mood a message rested on", (t) => {
  const f = setup(t);
  const m = f.m;
  const T0 = Date.parse("2026-10-27T15:02:14Z"),
    at = (s) => new Date(T0 + s * 1000).toISOString();
  m.identity.put("model_turns", {
    id: "chat",
    conversation: group,
    startedAt: T0,
    endedAt: T0 + 90000,
    status: "sent",
    reason: ["mention"],
  });
  const v1 = card(f, "30000", "阿明", "说话很直的老朋友");
  card(f, "30000", "明哥", "喜欢被叫明哥", 1);
  const gone = card(f, "30001", "小林", "刚来的同学");
  m.identity.deletePersonCard("30001", 1);
  const before = card(f, "30002", "老王", "以前的卡");
  m.identity.deletePersonCard("30002", 1);
  card(f, "30002", "王哥", "删掉后重写的卡");
  const noCall = card(f, "30003", "", "没有称呼的卡");
  const mood = feel(f, "开心");
  const sends = [
    { personCard: { id: v1.id, personId: "30000", revision: 2 } },
    { personCard: { id: v1.id, personId: "30000", revision: 1 } },
    // Older than the kept history: only its number is known.
    { personCard: { id: v1.id, personId: "30000", revision: 99 } },
    { personCard: { id: gone.id, personId: "30001", revision: 1 } },
    { personCard: { id: before.id, personId: "30002", revision: 1 } },
    { personCard: { id: noCall.id, personId: "30003", revision: 1 } },
    { moodId: mood.id },
    { moodId: "pruned-mood-fixture" },
    {},
  ];
  sends.forEach((p, i) =>
    m.append({
      dedupe: "sent:" + i,
      conversation: group,
      kind: "message.sent",
      direction: "out",
      observedAt: at(10 + i),
      body: "第" + i + "条",
      payload: { requestId: "r" + i, ...p },
    }),
  );
  const [entry] = activityPage(f.store, "agent-0", {
    now: T0 + HOUR,
  }).items;
  assert.deepEqual(
    entry.sent.map((s) => s.basis),
    [
      { personCard: { personId: "30000", revision: 2, call: "明哥" } },
      { personCard: { personId: "30000", revision: 1, call: "阿明" } },
      { personCard: { personId: "30000", revision: 99 } },
      { personCard: { personId: "30001", revision: 1, deleted: true } },
      { personCard: { personId: "30002", revision: 1, deleted: true } },
      { personCard: { personId: "30003", revision: 1 } },
      { mood: { mood: "开心", intensity: 3 } },
      { mood: { missing: true } },
      undefined,
    ],
  );
});

test("the activity API returns the basis and the page shows it in one line", async (t) => {
  const f = setup(t);
  // Event times are wall-clock; keep the runtime on it for this send.
  f.runtime.clock = () => new Date();
  card(f, "30000", "阿明", "说话很直的老朋友");
  card(f, "30000", "<b>明哥</b>", "喜欢被叫明哥", 1);
  feel(f, "开心", 3);
  f.m.identity.put("model_turns", {
    id: "chat",
    conversation: group,
    startedAt: Date.now() - 1000,
    endedAt: Date.now() + 60000,
    status: "sent",
    reason: ["mention"],
  });
  await f.runtime.send(context(f.runtime), {
    requestId: "api-1",
    text: "明哥晚上好",
    atUserId: "30000",
  });
  const token = randomBytes(32).toString("hex"),
    app = createServer({ runtime: f.runtime, token });
  const port = await app.listen();
  t.after(() => app.close());
  const page = await (
    await fetch(
      `http://127.0.0.1:${port}/api/activity?agentId=agent-0&filter=chat`,
      { headers: { "x-admin-token": token } },
    )
  ).json();
  const [entry] = page.items;
  // The sent message's own record id lets the console open it.
  const record = f.m.db
    .prepare(
      "SELECT id FROM events WHERE agent_id='agent-0' AND kind='message.sent'",
    )
    .get();
  assert.deepEqual(entry.sent, [
    {
      id: record.id,
      text: "明哥晚上好",
      action: false,
      basis: {
        personCard: { personId: "30000", revision: 2, call: "<b>明哥</b>" },
        mood: { mood: "开心", intensity: 3 },
      },
    },
  ]);

  // The activity script renders that entry: escaped, one hint line.
  const sandbox = vm.createContext({
    esc: (s) =>
      String(s ?? "").replace(
        /[&<>"']/g,
        (c) =>
          ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;",
          })[c],
      ),
    tag: (text) => `<span class="pill">${text}</span>`,
  });
  vm.runInContext(
    fs.readFileSync(
      new URL("../public/activity-ui.js", import.meta.url),
      "utf8",
    ),
    sandbox,
  );
  sandbox.entry = entry;
  const html = vm.runInContext("activityEntry(entry)", sandbox);
  assert.match(
    html,
    /<p class="hint act-basis">参考人物卡：&lt;b&gt;明哥&lt;\/b&gt; v2 · 当时心情：开心（强度 3）<\/p>/,
  );
  sandbox.entry = {
    ...entry,
    sent: [
      {
        text: "旧消息",
        action: false,
        basis: {
          personCard: { personId: "30001", revision: 3, deleted: true },
          mood: { missing: true },
        },
      },
      { text: "没有依据", action: false },
    ],
  };
  const old = vm.runInContext("activityEntry(entry)", sandbox);
  assert.match(old, /参考人物卡：30001 v3（已删除） · 当时心情：记录已清理/);
  assert.equal(old.split("act-basis").length - 1, 1);
});
