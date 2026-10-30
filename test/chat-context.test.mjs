import test from "node:test";
import assert from "node:assert/strict";
import { fixture, config, context } from "./helpers.mjs";

const scope = "group:20000";
const section = (prompt, label) =>
  JSON.parse(prompt.split(label)[1].split("\n\n")[0]);
function setup(t) {
  const prompts = [];
  const f = fixture(t, {
    cfg: config(2),
    run: async (p) => {
      prompts.push(p.prompt);
      p.saveSession({ id: "chat-presentation", backend: "fixture" });
    },
  });
  return { ...f, prompts, m: f.store.bind("agent-0") };
}
function message(m, n, body = `来信 ${n}`) {
  return m.append({
    dedupe: `chat-${n}`,
    conversation: scope,
    connectionId: "qq-0",
    kind: "message.received",
    direction: "in",
    senderId: "30000",
    body,
    occurredAt: "2026-10-30T00:00:00Z",
  });
}
function delivery(m, id, status, conversation = scope) {
  m.reserveDelivery(id, conversation, { text: "fixture" });
  m.completeDelivery(id, status, status === "sent" ? "40000" : null);
}

test("chat starts with speech, keeps IDs and reading gaps, and leaves the durable handoff intact", async (t) => {
  const f = setup(t);
  for (let n = 0; n < 20; n++) delivery(f.m, `success-${n}`, "sent");
  const long = message(f.m, 1, "长句".repeat(200));
  const before = f.m.state(scope).readThroughSeq || 0;
  await f.runtime.wake("agent-0", scope, { reasons: [{ reason: "private" }] });
  const prompt = f.prompts[0];
  assert(prompt.indexOf("新增消息：") < prompt.indexOf("处理水位："));
  assert(prompt.indexOf("新增消息：") < prompt.indexOf("程序交接状态："));
  assert(prompt.indexOf("新增消息：") < prompt.indexOf("当前时间："));
  assert(prompt.indexOf("新增消息：") < prompt.indexOf("唤醒背景"));
  assert(!prompt.includes("success-"));
  assert(!prompt.includes('"summaryOnly"'));
  const shown = section(prompt, "新增消息：").items[0];
  assert.equal(shown.id, long.id);
  assert.equal(shown.bodyTruncated, true);
  assert.deepEqual(shown.continuation, {
    tool: "memory_read",
    id: long.id,
    offset: 0,
  });
  assert.match(prompt, /未完整读取/);
  assert.equal(f.m.state(scope).readThroughSeq || 0, before);
  const full = f.runtime.contexts.handoff("agent-0", scope);
  assert.equal(full.deliveries.length, 20);
  assert.deepEqual(full.summaryOnly, [long.seq]);
  message(f.m, 2, "接着说\n保留这行和句尾呀。");
  await f.runtime.wake("agent-0", scope);
  assert(!f.prompts[1].includes("程序交接状态："));
  assert.equal(
    section(f.prompts[1], "新增消息：").items.at(-1).body,
    "接着说\n保留这行和句尾呀。",
  );
});

test("old unresolved receipts survive newer successes and can be paged without sending or crossing scopes", async (t) => {
  const f = setup(t);
  for (let n = 0; n < 25; n++)
    delivery(f.m, `unknown-${String(n).padStart(2, "0")}`, "unknown");
  for (let n = 0; n < 30; n++) delivery(f.m, `success-${n}`, "sent");
  delivery(f.m, "other-chat", "unknown", "group:20001");
  delivery(f.store.bind("agent-1"), "other-agent", "unknown");
  const before = f.store.db
    .prepare("SELECT * FROM deliveries ORDER BY agent_id,request_id")
    .all();
  message(f.m, 1);
  await f.runtime.wake("agent-0", scope);
  const first = section(f.prompts[0], "待核对投递：");
  assert.equal(first.total, 25);
  assert.equal(first.items.length, 20);
  assert(first.items.some((r) => r.requestId === "unknown-00"));
  assert.equal(first.nextOffset, 20);
  const ctx = context(f.runtime);
  const { tool, ...args } = first.continuation;
  const second = await f.runtime.callTool(ctx, tool, args);
  assert.equal(second.items.length, 5);
  assert.equal(second.nextOffset, null);
  assert.equal(
    new Set([...first.items, ...second.items].map((r) => r.requestId)).size,
    25,
  );
  assert(!JSON.stringify([first, second]).includes("other-"));
  await assert.rejects(
    f.runtime.callTool(ctx, tool, { conversation: "group:20001" }),
  );
  assert.deepEqual(
    f.store.db
      .prepare("SELECT * FROM deliveries ORDER BY agent_id,request_id")
      .all(),
    before,
  );
  assert.equal(
    [...f.runtime.transports.values()].flatMap((x) => x.sent).length,
    0,
  );
});

test("scheduled instructions remain distinct from optional wake background", async (t) => {
  const f = setup(t);
  message(f.m, 1);
  await f.runtime.wake("agent-0", scope, {
    reasons: [
      {
        reason: "scheduled",
        taskRunId: "fixture-run",
        instruction: "整理本周读书进度",
      },
      { reason: "intent", topic: "可以聊聊读书" },
    ],
  });
  const prompt = f.prompts[0];
  assert.match(prompt, /本轮定时任务.*整理本周读书进度/);
  assert.match(prompt, /唤醒背景.*不是待发送台词.*可以聊聊读书/);
  assert(prompt.indexOf("本轮定时任务") > prompt.indexOf("新增消息："));
});
