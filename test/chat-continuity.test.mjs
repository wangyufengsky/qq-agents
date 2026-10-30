import test from "node:test";
import assert from "node:assert/strict";
import { fixture, config, context } from "./helpers.mjs";
import { chatRecall } from "../src/core/chat-recall.mjs";

const scope = "group:20000";
const part = (prompt, name) =>
  JSON.parse(prompt.split(name)[1].split("\n\n")[0]);

test("quote fan-out remains bounded and advertises a continuation", async (t) => {
  const f = setup(t),
    old = [];
  for (let n = 1; n <= 50; n++)
    old.push(message(f.m, n, `正文 ${n} ` + "内容".repeat(450)));
  processed(f, old);
  const reply = message(f.m, 51, "回应这些引用", {
    payload: {
      segments: [1, 2, 3, 4, 5].map((id) => ({
        type: "reply",
        data: { id: String(id) },
      })),
    },
  });
  await f.runtime.wake("agent-0", scope);
  const replay = part(f.prompts[0], "最近对话（历史回放）：");
  assert(replay.quotesOmitted >= 1);
  assert.deepEqual(replay.quoteContinuation, {
    tool: "conversation_read",
    aroundId: reply.id,
  });
  assert(JSON.stringify(replay).length <= 12000);
  for (const item of replay.quoted) {
    if (item.bodyOmitted) assert.equal(item.continuation.tool, "memory_read");
    else assert.equal(item.body, old.find((x) => x.id === item.id).body);
  }
});

test("full chat speech does not expand large external records into the opening", async (t) => {
  const f = setup(t);
  const external = message(f.m, 1, "网页正文".repeat(1000), {
    kind: "external.read",
    direction: "internal",
  });
  const speech = message(f.m, 2, "新消息".repeat(300));
  await f.runtime.wake("agent-0", scope);
  const page = part(f.prompts[0], "新增消息：");
  const hint = page.items.find((x) => x.id === external.id);
  assert.equal(hint.body.length, 200);
  assert.equal(hint.bodyTruncated, true);
  assert.equal(hint.continuation.id, external.id);
  assert.equal(page.items.find((x) => x.id === speech.id).body, speech.body);
});

test("external handoff hints keep their partial reading scope and original source", async (t) => {
  const f = setup(t);
  const text = "实际读到的一段".repeat(120);
  const source = message(f.m, 1, "标题不是正文", {
    kind: "app.observation",
    direction: "internal",
    payload: {
      app: {
        platform: "zhihu",
        key: "zhihu:answer/fixture",
        readingScope: "body",
        coverage: "partial",
        text,
        sourceMayBeTruncated: true,
      },
    },
  });
  processed(f, [source]);
  message(f.m, 2, "继续刚才读到的内容");
  await f.runtime.wake("agent-0", scope);
  const hint = part(f.prompts[0], "程序交接状态：").continuity.sources[0];
  assert.equal(hint.id, source.id);
  assert.equal(hint.excerpt, text.slice(0, 200));
  assert.equal(hint.excerptTruncated, true);
  assert.equal(hint.coverage, "partial");
  assert.equal(hint.sourceMayBeTruncated, true);
  assert.equal(hint.continuation.tool, "app_record");
});
function setup(t, cfg = config(1)) {
  const prompts = [];
  const f = fixture(t, {
    cfg,
    run: async (p) => {
      prompts.push(p.prompt);
      p.saveSession({ id: "continuity-fixture", backend: "fixture" });
    },
  });
  return { ...f, prompts, m: f.store.bind("agent-0") };
}
function message(m, n, body = `完整消息 ${n}`, extra = {}) {
  const saved = m.append({
    dedupe: `continuity-${n}`,
    conversation: scope,
    connectionId: "qq-0",
    messageId: String(n),
    kind: "message.received",
    direction: "in",
    senderId: "30000",
    body,
    occurredAt: "2026-10-30T00:00:00Z",
    payload: { trustedInput: true },
    ...extra,
  });
  return m.event(
    m.db.prepare("SELECT * FROM events WHERE id=?").get(saved.id),
    scope,
    false,
  );
}
function processed(f, items) {
  f.runtime.contexts.seen(context(f.runtime), items);
  f.m.setState(scope, {
    ...f.m.state(scope),
    readThroughSeq: items.at(-1).seq,
  });
}

test("twelve new messages cannot evict the continuous old tail, whose long bodies keep their endings", async (t) => {
  const f = setup(t),
    old = [];
  for (let n = 1; n <= 20; n++)
    old.push(
      message(
        f.m,
        n,
        `旧消息 ${n}\n` + "长句".repeat(450) + `\n结尾 ${n} 呀。`,
      ),
    );
  processed(f, old);
  const newRows = [];
  for (let n = 21; n <= 32; n++) newRows.push(message(f.m, n));
  await f.runtime.wake("agent-0", scope);
  const replay = part(f.prompts[0], "最近对话（历史回放）：");
  const current = part(f.prompts[0], "新增消息：");
  assert(replay.items.length >= 2);
  assert.equal(replay.items.at(-1).id, old.at(-1).id);
  const start = old.findIndex((x) => x.id === replay.items[0].id);
  assert.deepEqual(
    replay.items.map((x) => x.id),
    old.slice(start).map((x) => x.id),
  );
  for (const row of replay.items)
    assert.equal(row.body, old.find((x) => x.id === row.id).body);
  assert.deepEqual(
    current.items.map((x) => x.id),
    newRows.map((x) => x.id),
  );
  assert.equal(f.m.state(scope).readThroughSeq, old.at(-1).seq);
  assert(JSON.stringify(replay).length <= 12000);
  assert(f.prompts[0].indexOf("最近对话") < f.prompts[0].indexOf("新增消息："));
  assert(!part(f.prompts[0], "程序交接状态：").continuity);
});

test("ordinary new speech is complete while an oversized body offers explicit continuation without granting input authority", async (t) => {
  const cfg = config(1);
  // Keep this paging test independent of schema-size retirement.
  cfg.agents[0].contextPolicy.capacityTokens = 131072;
  const f = setup(t, cfg);
  const ordinary = message(
    f.m,
    1,
    "我还在开会\n" + "事情".repeat(450) + "，太苦了呀。",
  );
  const huge = message(f.m, 2, "需要续读".repeat(6000));
  await f.runtime.wake("agent-0", scope);
  const first = part(f.prompts[0], "新增消息：");
  assert.equal(first.items[0].body, ordinary.body);
  assert.equal(first.items[0].bodyTruncated, false);
  assert.equal(first.truncated, true);
  assert.equal(f.m.state(scope).replyInputSeq, ordinary.seq);
  await f.runtime.wake("agent-0", scope);
  const second = part(f.prompts[1], "新增消息：").items[0];
  assert.equal(second.id, huge.id);
  assert.equal(second.summaryOmitted, true);
  assert.equal(second.body, undefined);
  assert.deepEqual(second.continuation, {
    tool: "memory_read",
    id: huge.id,
    offset: 0,
  });
  assert.equal(f.m.state(scope).replyInputSeq, ordinary.seq);
  assert.equal(f.m.state(scope).readThroughSeq || 0, 0);
});

test("a full first page advertises remaining messages even when the item limit is reached", async (t) => {
  const f = setup(t);
  const rows = Array.from({ length: 32 }, (_, n) => message(f.m, n + 1));
  await f.runtime.wake("agent-0", scope);
  const page = part(f.prompts[0], "新增消息：");
  assert(page.items.length < rows.length);
  assert.equal(page.truncated, true);
  assert.match(f.prompts[0], /还有未展示的消息/);
  assert.equal(page.nextAfterSeq, page.items.at(-1).seq);
});

test("explicit quotes outside the tail resolve within their connection and conversation", async (t) => {
  const f = setup(t),
    old = [];
  for (let n = 1; n <= 50; n++) old.push(message(f.m, n));
  processed(f, old);
  message(f.m, 100, "别的群同号内容", {
    conversation: "group:20001",
    messageId: "1",
  });
  const reply = message(f.m, 51, "刚才那条我同意", {
    payload: { segments: [{ type: "reply", data: { id: "1" } }] },
  });
  await f.runtime.wake("agent-0", scope);
  const replay = part(f.prompts[0], "最近对话（历史回放）：");
  const quote = replay.quoted.find((x) => x.id === old[0].id);
  assert.equal(quote.body, old[0].body);
  assert.equal(quote.quotedBy, reply.id);
  assert(!f.prompts[0].includes("别的群同号内容"));
  assert(!replay.items.some((x) => x.id === old[0].id));
});

test("an unavailable protected or ambiguous quote is not reconstructed", async (t) => {
  const f = setup(t);
  const secret = message(f.m, 1, "protected fixture detail", {
    payload: { protectedOperations: true },
  });
  message(f.m, 2, "ambiguous one", { messageId: "same" });
  const last = message(f.m, 3, "ambiguous two", { messageId: "same" });
  f.m.setState(scope, { ...f.m.state(scope), readThroughSeq: last.seq });
  message(f.m, 4, "引用资料", {
    payload: {
      segments: [
        { type: "reply", data: { id: "1" } },
        { type: "reply", data: { id: "same" } },
      ],
    },
  });
  await f.runtime.wake("agent-0", scope);
  const replay = part(f.prompts[0], "最近对话（历史回放）：");
  assert.equal(replay.missingQuotes.length, 2);
  assert.equal(replay.quoted.length, 0);
  assert(!f.prompts[0].includes(secret.body));
  assert(!f.prompts[0].includes(secret.id));
  assert.equal(replay.omittedBefore, true);
});

test("a long boundary stops the tail instead of silently joining disjoint earlier messages", async (t) => {
  const f = setup(t);
  const old = [
    message(f.m, 1, "很早的闲聊"),
    message(f.m, 2, "超长".repeat(9000)),
    message(f.m, 3, "最近完整一句"),
  ];
  f.m.setState(scope, { ...f.m.state(scope), readThroughSeq: old.at(-1).seq });
  message(f.m, 4);
  await f.runtime.wake("agent-0", scope);
  const replay = part(f.prompts[0], "最近对话（历史回放）：");
  assert.deepEqual(
    replay.items.map((x) => x.id),
    [old[2].id],
  );
  assert.equal(replay.omittedBefore, true);
  assert.equal(replay.continuation.beforeSeq, old[2].seq);
});

test("unfiled original conditions remain separate from the tail, and replay never refills reply authority", (t) => {
  const f = setup(t),
    old = [];
  old.push(message(f.m, 1, "旅行三人，每晚预算600元。"));
  for (let n = 2; n <= 50; n++) old.push(message(f.m, n));
  processed(f, old);
  f.m.setState(scope, { ...f.m.state(scope), replyBatchSends: 3 });
  const unreadTarget = message(f.m, 52, "尚未作为新输入读取的引用原文");
  const reply = message(f.m, 51, "引用前条", {
    payload: { segments: [{ type: "reply", data: { id: "52" } }] },
  });
  const ctx = context(f.runtime),
    before = f.m.state(scope);
  const replay = chatRecall(
    f.runtime,
    ctx,
    { items: [reply] },
    f.runtime.contexts.handoff("agent-0", scope),
    old.at(-1).seq,
  );
  assert(replay.earlier.some((x) => x.body === old[0].body));
  assert(!replay.items.some((x) => x.id === old[0].id));
  assert(replay.quoted.some((x) => x.id === unreadTarget.id));
  assert.equal(ctx.requestEvents.size, 0);
  assert.equal(ctx.replyInputSeq, undefined);
  assert.equal(f.m.state(scope).replyBatchSends, before.replyBatchSends);
  assert.equal(f.m.state(scope).readThroughSeq, before.readThroughSeq);
  assert.equal(f.m.state(scope).seenThroughSeq, before.seenThroughSeq);
  assert(ctx.privateRead.has(old[0].id));
  assert.equal(f.m.identity.notes(scope).length, 0);
});
