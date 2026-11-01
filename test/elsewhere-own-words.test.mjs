import test from "node:test";
import assert from "node:assert/strict";
import { fixture, config, context } from "./helpers.mjs";
import { elsewhereForTurn } from "../src/core/elsewhere.mjs";

const now = Date.parse("2026-11-01T12:00:00Z");

function setup(t, options = {}) {
  const f = fixture(t, options);
  const memory = f.store.bind("agent-0");
  f.runtime.agent("agent-0").behavior.elsewhere = {
    enabled: true,
    windowMs: 21600000,
    ownLookbackMs: 86400000,
  };
  let n = 0;
  // A message the agent sent, with its ledger receipt in the given state.
  function send(
    conversation,
    body,
    {
      status = "sent",
      at = now - 60000 + n,
      payload = {},
      bound = memory,
    } = {},
  ) {
    const requestId = `own-${++n}`,
      messageId = String(70000 + n);
    bound.reserveDelivery(requestId, conversation, { kind: "fixture" });
    bound.completeDelivery(requestId, status, messageId);
    return bound.append({
      dedupe: requestId,
      conversation,
      direction: "out",
      kind: "message.sent",
      status: "confirmed",
      messageId,
      body,
      occurredAt: new Date(at).toISOString(),
      payload: { requestId, ...payload },
    });
  }
  function receive(conversation, senderId, body, messageId) {
    return memory.append({
      dedupe: `in-${++n}`,
      conversation,
      direction: "in",
      kind: "message.received",
      senderId,
      body,
      messageId,
      occurredAt: new Date(now - 120000 + n).toISOString(),
      payload: {},
    });
  }
  return { ...f, memory, send, receive };
}

const words = (f, conversation, fresh = false) => {
  const ctx = context(f.runtime);
  ctx.conversation = conversation;
  return elsewhereForTurn(f.runtime, ctx, [], {
    fresh,
    now,
    accountId: "10000",
  }).words;
};

test("own group words reach a private chat with excerpt, explicit addressees and truncation", (t) => {
  const f = setup(t);
  f.receive("group:20000", "30001", "被引用的话", "88001");
  const plain = f.send("group:20000", "随口一句");
  const at = f.send("group:20000", "对你说", {
    payload: { atUserId: "30002" },
  });
  const reply = f.send("group:20000", "接你的话", {
    payload: { replyTo: "88001" },
  });
  const long = f.send("group:20000", "长".repeat(100));
  const result = words(f, "private:30000");
  // Three per chat: the oldest of the four is counted, not shown.
  assert.deepEqual(
    result.items.map((x) => [x.to, x.continuation.id]),
    [
      [["30002"], at.id],
      [["30001"], reply.id],
      ["unclear", long.id],
    ],
  );
  assert.ok(!result.items.some((x) => x.continuation.id === plain.id));
  assert.equal(result.more["group:20000"], 1);
  const last = result.items.at(-1);
  assert.equal(last.truncated, true);
  assert.equal([...last.excerpt].length, 80);
  assert.equal(result.items[0].truncated, undefined);
  assert.equal(result.through, long.seq);
});

test("words said in other private chats are only counted, never quoted or named", (t) => {
  const f = setup(t);
  f.send("private:30005", "只对他说的秘密");
  f.send("private:30005", "第二句");
  f.send("private:30006", "另一个人的私聊");
  const result = words(f, "group:20000");
  assert.deepEqual(result.items, []);
  assert.deepEqual(result.otherPrivate, { messages: 3, chats: 2 });
  const text = JSON.stringify(result);
  assert.doesNotMatch(text, /秘密|另一个人|30005|30006/);
});

test("unconfirmed, protected, stale, current-chat and other-agent words stay out", (t) => {
  const f = setup(t);
  f.send("group:20000", "还没确认", { status: "pending" });
  f.send("group:20000", "结果未知", { status: "unknown" });
  f.send("group:20000", "运维内容", {
    payload: { protectedOperations: true },
  });
  f.send("group:20000", "私有仓库", {
    payload: { protectedRepositories: ["owner/private"] },
  });
  f.send("group:20000", "太久以前", { at: now - 86400001 });
  f.send("private:30000", "就在当前聊天");
  f.send("group:20000", "别的角色说的", {
    bound: f.store.bind("other-agent"),
  });
  const result = words(f, "private:30000");
  assert.deepEqual(result.items, []);
  assert.equal(result.otherPrivate, undefined);
  f.runtime.agent("agent-0").behavior.elsewhere.ownLookbackMs = 600000;
  const recent = f.send("group:20000", "十分钟内", { at: now - 300000 });
  assert.deepEqual(
    words(f, "private:30000").items.map((x) => x.continuation.id),
    [recent.id],
  );
});

test("a session starts after the agent last spoke here and then only hears newer words", (t) => {
  const f = setup(t);
  f.send("group:20000", "上次在私聊说话之前");
  const here = f.send("private:30000", "在私聊里说的");
  const after = f.send("group:20000", "之后在群里说的");
  const first = words(f, "private:30000");
  assert.deepEqual(
    first.items.map((x) => x.continuation.id),
    [after.id],
  );
  assert.ok(here.seq < after.seq);
  f.memory.setState("private:30000", {
    ...f.memory.state("private:30000"),
    elsewhereWordsThroughSeq: first.through,
  });
  assert.deepEqual(words(f, "private:30000").items, []);
  // Speaking here again does not hide words the session has not yet seen.
  const unseen = f.send("group:20000", "还没被看到");
  f.send("private:30000", "又在私聊说了一句");
  assert.deepEqual(
    words(f, "private:30000").items.map((x) => x.continuation.id),
    [unseen.id],
  );
  // A fresh session starts again from the last words here.
  assert.deepEqual(words(f, "private:30000", true).items, []);
});

test("per-chat and per-turn caps keep the newest words in time order", (t) => {
  const f = setup(t);
  for (let g = 0; g < 4; g++)
    for (let i = 0; i < 4; i++) f.send(`group:${40000 + g}`, `群${g}第${i}句`);
  const result = words(f, "private:30000");
  assert.deepEqual(
    result.items.map((x) => x.excerpt),
    [
      "群1第2句",
      "群1第3句",
      "群2第1句",
      "群2第2句",
      "群2第3句",
      "群3第1句",
      "群3第2句",
      "群3第3句",
    ],
  );
  const perChat = {};
  for (const item of result.items)
    perChat[item.where] = (perChat[item.where] || 0) + 1;
  assert.ok(Object.values(perChat).every((n) => n <= 3));
  const times = result.items.map((x) => Date.parse(x.at));
  assert.deepEqual(
    times,
    [...times].sort((a, b) => a - b),
  );
  const shown = result.items.length;
  const counted = Object.values(result.more).reduce((a, b) => a + b, 0);
  assert.equal(shown + counted, 16);
  assert.equal(result.items.at(-1).excerpt, "群3第3句");
});

test("chat prompts carry own words once, record them and leave read state alone", async (t) => {
  const prompts = [];
  const cfg = config(1);
  cfg.agents[0].contextPolicy.capacityTokens = 1000000;
  const f = setup(t, {
    cfg,
    run: async (p) => {
      prompts.push(p);
      p.saveSession({ id: "fixture-session", backend: "fixture" });
    },
  });
  f.runtime.clock = () => new Date(now);
  f.runtime.agent("agent-0").behavior.elsewhere = {
    enabled: true,
    windowMs: 21600000,
    ownLookbackMs: 86400000,
  };
  const said = f.send("group:20000", "我在群里刚说过这句");
  const peer = "private:30000";
  const before = f.memory.state(peer).readThroughSeq;
  f.memory.append({
    dedupe: "owner-asks",
    conversation: peer,
    kind: "message.received",
    direction: "in",
    senderId: "30000",
    body: "现在呢",
    occurredAt: new Date(now - 1000).toISOString(),
    payload: {},
  });
  await f.runtime.wake("agent-0", peer);
  const line = prompts[0].prompt
    .split("\n\n")
    .find((s) => s.startsWith("别处近况（"));
  assert.ok(line, "the prompt carries the elsewhere line");
  const data = JSON.parse(line.slice(line.indexOf("）：") + 2));
  assert.equal(data.yourWords.items[0].excerpt, "我在群里刚说过这句");
  assert.equal(data.yourWords.items[0].to, "unclear");
  assert.equal(data.items, undefined);
  const state = f.memory.state(peer);
  assert.equal(state.elsewhereWordsThroughSeq, said.seq);
  assert.equal(state.readThroughSeq, before);
  assert.ok(!f.memory.state("group:20000").readThroughSeq);
  assert.ok(state.disclosureTaint.includes(said.id));
  const turn = f.memory.identity.get("model_turns", state.lastTurnId);
  assert.deepEqual(turn.elsewhereWords, [
    { where: "group:20000", id: said.id },
  ]);
  f.memory.append({
    dedupe: "owner-again",
    conversation: peer,
    kind: "message.received",
    direction: "in",
    senderId: "30000",
    body: "再问一次",
    occurredAt: new Date(now - 500).toISOString(),
    payload: {},
  });
  await f.runtime.wake("agent-0", peer);
  assert.doesNotMatch(prompts[1].prompt, /我在群里刚说过这句/);
});
