import test from "node:test";
import assert from "node:assert/strict";
import { config, fixture, raw, settle } from "./helpers.mjs";

async function group(
  t,
  run,
  {
    privateLike = true,
    enabled = true,
    mentionEnabled = false,
    optionalBacklog = false,
    backlog = 41,
  } = {},
) {
  const cfg = config(1);
  cfg.privateLikeGroups = privateLike ? ["20000"] : [];
  Object.assign(cfg.agents[0].wake, {
    private: false,
    participation: 0,
    names: false,
  });
  cfg.agents[0].behavior.focusedGroupReply = enabled;
  cfg.agents[0].behavior.focusedGroupMentionReply = mentionEnabled;
  cfg.agents[0].behavior.optionalGroupBacklog = optionalBacklog;
  cfg.agents[0].tools.push("qq_send_burst");
  const f = fixture(t, { cfg, run });
  const ingest = (id, message) =>
    f.runtime.ingest("qq-0", raw(id, { message }));
  for (let id = 0; id < backlog; id++) await ingest(100 + id, "合成积压消息");
  await ingest(42, "当前来信");
  const memory = f.store.bind("agent-0");
  const source = memory.db
    .prepare("SELECT id,seq FROM events WHERE message_id='42'")
    .get();
  return {
    ...f,
    ingest,
    source,
    memory,
    wake: () =>
      f.runtime.wake("agent-0", "group:20000", {
        reasons: [
          { reason: privateLike ? "private" : "message", seq: source.seq },
        ],
      }),
    sent: () => f.runtime.transports.get("qq-0").sent,
    reviewed: () =>
      memory.db
        .prepare(
          `SELECT e.message_id FROM input_versions v JOIN events e ON e.id=v.id WHERE v.current=1 AND json_array_length(v.reviewed_deliveries)>0 ORDER BY v.seq`,
        )
        .all()
        .map((r) => r.message_id),
  };
}

const quoted = (id, text) => [
  { type: "reply", data: { id: String(id) } },
  { type: "text", data: { text } },
];
const reply = {
  requestId: "focused-test",
  text: "回复当前来信",
  replyTo: "42",
};
const resumeDraft = ({ draft, preparation }) => ({
  action: "continue",
  draftId: draft.draftId,
  expectedVersion: draft.version,
  inputReview: { token: preparation.token, decision: "continue" },
});

test("a quoted reply to the wake input sends despite old and newly arriving unrelated messages", async (t) => {
  let result, prompt;
  const f = await group(t, async (p) => {
    prompt = p.prompt;
    await f.ingest(43, "另一段群聊");
    result = await p.callTool("qq_send", reply);
  });
  await f.wake();
  assert.equal(result?.actionResult, "sent");
  assert(prompt.includes(f.source.id));
  assert.deepEqual(f.reviewed(), ["42"]);
  assert.equal(f.memory.state("group:20000").readThroughSeq || 0, 0);
  assert.deepEqual(f.sent()[0].segments[0], {
    type: "reply",
    data: { id: "42" },
  });
});

test("the current quote's follow-up invalidates its grant while unrelated messages stay queued", async (t) => {
  let first, challenged, result;
  const f = await group(t, async ({ callTool }) => {
    await f.ingest(43, quoted(42, "引用来信补充"));
    first = await callTool("qq_send", reply);
    await f.ingest(44, quoted(42, "再次补充"));
    challenged = await callTool("qq_draft", resumeDraft(first));
    await f.ingest(45, "不相关的新群聊");
    result = await callTool("qq_draft", resumeDraft(challenged));
  });
  await f.wake();
  assert.equal(first?.preparation?.state, "ready");
  assert.equal(challenged?.preparation?.reason, "NEW_INPUT");
  assert.equal(challenged?.attemptedThisCall, false);
  assert.equal(result?.actionResult, "sent");
  assert.equal(f.sent().length, 1);
  assert.deepEqual(f.reviewed(), ["42", "43", "44"]);
});

test("disabled focused replies still require review of the whole pending conversation", async (t) => {
  let result;
  const f = await group(
    t,
    async ({ callTool }) => {
      result = await callTool("qq_send", reply);
    },
    { enabled: false },
  );
  await f.wake();
  assert.equal(result?.actionResult, "not_sent");
  assert(result.preparation.pendingDecision > 1);
  assert.equal(f.sent().length, 0);
});

test("quoting an old message uses the ordinary review scope", async (t) => {
  let result;
  const f = await group(t, async ({ callTool }) => {
    result = await callTool("qq_send", { ...reply, replyTo: "100" });
  });
  await f.wake();
  assert.equal(result?.actionResult, "not_sent");
  assert(result.preparation.pendingDecision > 1);
  assert.equal(f.sent().length, 0);
});

test("recalling the quoted wake input before confirmation blocks the focused draft", async (t) => {
  let first, after;
  const f = await group(t, async ({ callTool }) => {
    await f.ingest(43, quoted(42, "引用来信补充"));
    first = await callTool("qq_send", reply);
    await f.runtime.ingest(
      "qq-0",
      raw(42, {
        post_type: "notice",
        notice_type: "group_recall",
      }),
    );
    after = await callTool("qq_draft", resumeDraft(first));
  });
  await f.wake();
  assert.equal(first?.preparation?.state, "ready");
  assert.equal(after?.preparation?.reason, "SOURCE_CHANGED");
  assert.equal(f.sent().length, 0);
  assert.deepEqual(f.reviewed(), []);
});

test("a recalled follow-up must be shown before its draft can be confirmed again", async (t) => {
  let challenged, result;
  const f = await group(t, async ({ callTool }) => {
    await f.ingest(43, quoted(42, "合成补充原文"));
    const first = await callTool("qq_send", reply);
    await f.runtime.ingest(
      "qq-0",
      raw(43, {
        post_type: "notice",
        notice_type: "group_recall",
      }),
    );
    challenged = await callTool("qq_draft", resumeDraft(first));
    result = await callTool("qq_draft", resumeDraft(challenged));
  });
  await f.wake();
  assert.equal(challenged?.attemptedThisCall, false);
  assert.deepEqual(
    challenged.preparation.items.map((item) => [
      item.kind,
      item.messageId,
      item.body,
    ]),
    [["message.recalled", "43", "[消息已撤回]"]],
  );
  assert.equal(result?.actionResult, "sent");
  assert.equal(f.sent().length, 1);
});

const mentioned = (id) => [
  { type: "at", data: { qq: id } },
  { type: "text", data: { text: "请答这条合成提问" } },
];

test("a direct mention in an ordinary group can be quoted ahead of hundreds of old messages", async (t) => {
  let result, prompt;
  const f = await group(
    t,
    async (p) => {
      prompt = p.prompt;
      await f.ingest(301, "同时出现的不相关群消息");
      result = await p.callTool("qq_send", { ...reply, replyTo: "300" });
    },
    { privateLike: false, enabled: false, mentionEnabled: true, backlog: 200 },
  );
  await f.ingest(300, mentioned("10000"));
  await settle(f.runtime);
  assert.equal(result?.actionResult, "sent");
  assert.match(prompt, /replyTo="300"/);
  assert.deepEqual(f.reviewed(), ["300"]);
  assert.equal(f.memory.state("group:20000").readThroughSeq || 0, 0);
  assert.deepEqual(f.sent()[0].segments[0], {
    type: "reply",
    data: { id: "300" },
  });
});

for (const [name, mentionEnabled, target, quote] of [
  ["a disabled policy", false, "10000", "300"],
  ["a mention of another account", true, "10001", "300"],
  ["an at-all mention", true, "all", "300"],
  ["a send without a quote", true, "10000", undefined],
  ["a quote of old input", true, "10000", "100"],
]) {
  test(`an ordinary group keeps whole-chat review for ${name}`, async (t) => {
    let result;
    const f = await group(
      t,
      async ({ callTool }) => {
        result = await callTool("qq_send", { ...reply, replyTo: quote });
      },
      { privateLike: false, mentionEnabled },
    );
    await f.ingest(300, mentioned(target));
    if (target !== "10000") {
      const { seq } = f.memory.db
        .prepare("SELECT seq FROM events WHERE message_id='300'")
        .get();
      await f.runtime.wake("agent-0", "group:20000", {
        reasons: [{ reason: "mention", seq }],
      });
    }
    await settle(f.runtime);
    assert.equal(result?.actionResult, "not_sent");
    assert(result.preparation.pendingDecision > 1);
    assert.equal(f.sent().length, 0);
  });
}

test("ordinary draft review guides and delivers batches of pending originals", async (t) => {
  let pages;
  const f = await group(
    t,
    async ({ callTool }) => {
      const first = await callTool("qq_send", {
        requestId: "batch-review",
        text: "合成回复",
      });
      pages = [first.preparation];
      const { draftId, version } = first.draft;
      for (let i = 0; i < 10 && pages.at(-1).state === "needs_input"; i++) {
        const next = await callTool("qq_draft", {
          action: "prepare",
          draftId,
          expectedVersion: version,
        });
        pages.push(next.preparation);
      }
    },
    { privateLike: false, backlog: 99 },
  );
  await f.wake();
  assert.equal(pages[0].state, "needs_input");
  assert.match(pages[0].hint, /qq_draft prepare.*分批/);
  assert(pages[0].items.length > 1);
  assert.equal(pages.at(-1).state, "ready");
  assert(pages.length < 10);
  assert.equal(f.sent().length, 0);
  assert.equal(f.memory.state("group:20000").readThroughSeq || 0, 0);
});

for (const [label, tool, input, preview] of [
  [
    "an unquoted reply without reading old input",
    "qq_send",
    { ...reply, replyTo: undefined },
    false,
  ],
  ["a new quote after only reading some old input", "qq_send", reply, true],
  ["a quote of a past message", "qq_send", { ...reply, replyTo: "100" }, false],
  [
    "a text burst",
    "qq_send_burst",
    { requestId: "group-burst", messages: ["合成回复"] },
    false,
  ],
]) {
  test(`optional ordinary group backlog allows ${label}`, async (t) => {
    let result, prompt, read, after;
    const f = await group(
      t,
      async ({ callTool, prompt: opening }) => {
        prompt = opening;
        if (preview) {
          read = await callTool("conversation_read", { afterSeq: 0, limit: 2 });
        }
        result = await callTool(tool, input);
        if (preview) {
          after = await callTool("conversation_read", {
            afterSeq: read.nextAfterSeq,
            limit: 2,
          });
        }
      },
      { privateLike: false, optionalBacklog: true, backlog: 100 },
    );
    await f.wake();
    assert.equal(result?.actionResult, "sent");
    assert(prompt.includes("当前来信"));
    assert.deepEqual(f.reviewed(), ["42"]);
    if (preview) {
      assert.equal(read.items.length, 2);
      assert.equal(after.items.length, 2);
      assert(after.items[0].seq > read.items.at(-1).seq);
    }
    assert.equal(f.memory.state("group:20000").readThroughSeq || 0, 0);
    assert.equal(f.sent().length, 1);
  });
}

test("optional backlog still reviews inputs that arrive during the current turn", async (t) => {
  let first, sent;
  const f = await group(
    t,
    async ({ callTool }) => {
      await f.ingest(300, "本轮新来信");
      first = await callTool("qq_send", { ...reply, replyTo: undefined });
      sent = await callTool("qq_draft", resumeDraft(first));
    },
    { privateLike: false, optionalBacklog: true },
  );
  await f.wake();
  assert.equal(first.preparation.state, "ready");
  assert.equal(first.preparation.pendingDecision, 2);
  assert.deepEqual(
    first.preparation.items.map((x) => x.messageId),
    ["300"],
  );
  assert.equal(sent.actionResult, "sent");
  assert.deepEqual(f.reviewed(), ["42", "300"]);
});

test("optional backlog keeps the beginning of a merged wake and its intervening inputs", async (t) => {
  let prompt, result;
  const f = await group(
    t,
    async (p) => {
      prompt = p.prompt;
      result = await p.callTool("qq_send", { ...reply, replyTo: undefined });
    },
    { privateLike: false, optionalBacklog: true },
  );
  const a = f.runtime.agent("agent-0");
  a.behavior.batchWindowMs = 1000;
  a.behavior.batchMaxMs = 2000;
  let now = Date.now();
  f.runtime.clock = () => new Date(now);
  await f.ingest(300, [
    ...mentioned("10000"),
    { type: "text", data: { text: "本轮问题第一段" } },
  ]);
  await f.ingest(301, "本轮中间补充");
  await f.ingest(302, [
    ...mentioned("10000"),
    { type: "text", data: { text: "本轮问题最后一段" } },
  ]);
  now += 2001;
  f.runtime.conversations.tick();
  await settle(f.runtime);
  assert.match(prompt, /本轮问题第一段/);
  assert.match(prompt, /本轮中间补充/);
  assert.match(prompt, /本轮问题最后一段/);
  assert.equal(result.actionResult, "sent");
  assert.deepEqual(f.reviewed(), ["300", "301", "302"]);
});
