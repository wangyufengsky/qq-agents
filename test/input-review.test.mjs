import test from "node:test";
import assert from "node:assert/strict";
import { config, context, fixture, raw } from "./helpers.mjs";
import { safeToolFailure } from "../src/tools/errors.mjs";

function setup(t, run) {
  const cfg = config(2);
  cfg.privateLikeGroups = ["20001"];
  const a = cfg.agents[0];
  a.wake = {
    ...a.wake,
    mentions: false,
    names: false,
    private: false,
    participation: 0,
  };
  a.tools.push("qq_send_burst", "qq_send_voice", "qq_wait_for_messages");
  a.behavior.maxSendPerMinute = 30;
  const f = fixture(t, { cfg, run });
  return {
    ...f,
    ctx: context(f.runtime),
    mem: f.store.bind("agent-0"),
    transport: f.runtime.transports.get("qq-0"),
  };
}

async function incoming(
  f,
  id,
  text,
  { group_id = 20000, user_id = 30000, ...extra } = {},
) {
  const event = raw(id, {
    group_id,
    user_id,
    message: [{ type: "text", data: { text } }],
    ...extra,
  });
  if (group_id === null) {
    delete event.group_id;
    event.message_type = "private";
  }
  await f.runtime.ingest("qq-0", event);
  return f.mem.db
    .prepare(
      "SELECT id,seq FROM events WHERE agent_id=? AND message_id=? ORDER BY seq DESC LIMIT 1",
    )
    .get(f.mem.agentId, String(id));
}

const args = (requestId, text = "拟定的回复") => ({ requestId, text });
const confirm = (inputReview, unrelated) => ({
  token: inputReview.token,
  decision: "continue",
  ...(unrelated ? { unrelated } : {}),
});
async function blocked(promise) {
  let failure;
  await assert.rejects(promise, (error) => {
    failure = safeToolFailure(error);
    return failure.code === "INPUT_REVIEW_REQUIRED";
  });
  return { ...failure.inputReview, draft: failure.draft };
}
async function readAll(f, ctx, id) {
  let offset = 0;
  do {
    const page = await f.runtime.callTool(ctx, "memory_read", {
      id,
      offset,
      maxChars: 512,
    });
    offset = page.nextOffset;
  } while (offset !== null);
}

for (const firstReplyMaxMs of [0, 100, 6000])
  test(
    "generation-time input requires review for old first wait setting " +
      firstReplyMaxMs,
    async (t) => {
      let checked = false;
      const f = setup(t, async (p) => {
        try {
          assert.match(p.prompt, /开场短句/);
          const change = await incoming(f, 2, "刚才说错了", { user_id: 10001 });
          const pending = args("new-reply");
          const review = await blocked(p.callTool("qq_send", pending));
          assert.match(review.token, /^[a-f0-9]{64}$/);
          assert.equal(review.items[0].id, change.id);
          assert.equal(review.items[0].body, "刚才说错了");
          assert.equal(f.mem.delivery(pending.requestId), undefined);
          assert.equal(
            (
              await p.callTool("qq_draft", {
                action: "continue",
                draftId: review.draft.draftId,
                expectedVersion: review.draft.version,
                inputReview: confirm(review),
              })
            ).status,
            "sent",
          );
          assert.equal(f.mem.state(p.conversation).readThroughSeq || 0, 0);
          assert.equal(
            (await p.callTool("qq_send", args("same-reviewed-input"))).status,
            "sent",
          );
          checked = true;
        } catch (error) {
          checked = error;
          throw error;
        }
      });
      f.runtime.agent("agent-0").behavior.typing.firstReplyMaxMs =
        firstReplyMaxMs;
      await incoming(f, 1, "开场短句");
      await f.runtime.wake("agent-0", f.ctx.conversation);
      assert.equal(checked, true);
    },
  );

test("opening long-body gap survives a higher displayed short message and a new read checkpoint", async (t) => {
  const f = setup(t);
  const long = await incoming(f, 1, "长".repeat(17000));
  const short = await incoming(f, 2, "简短补充");
  await f.runtime.callTool(f.ctx, "conversation_read", { maxChars: 512 });
  await f.runtime.callTool(f.ctx, "conversation_read", { afterSeq: long.seq });
  assert.equal(f.ctx.replyInputSeq, short.seq);
  await f.runtime.callTool(f.ctx, "qq_mark_read", { throughSeq: short.seq });

  const ctx = context(f.runtime);
  const draft = args("with-gap");
  const failure = await blocked(f.runtime.send(ctx, draft));
  assert(failure.items.some(({ id }) => id === long.id));
  const first = await f.runtime.callTool(ctx, "memory_read", {
    id: long.id,
    maxChars: 512,
  });
  assert(first.nextOffset);
  assert.equal((await blocked(f.runtime.send(ctx, draft))).token, undefined);
  await readAll(f, ctx, long.id);
  await readAll(f, ctx, short.id);
  const ready = await blocked(f.runtime.send(ctx, draft));
  assert.equal(ready.missing, 0);
  assert(ready.token);
  assert.notEqual(
    (
      await blocked(
        f.runtime.send(ctx, {
          ...draft,
          text: "修改后的回复",
          inputReview: confirm(ready),
        }),
      )
    ).token,
    ready.token,
  );
  assert.equal(
    (await f.runtime.send(ctx, { ...draft, inputReview: confirm(ready) }))
      .status,
    "sent",
  );
});

test("real recall replaces the original review ref, invalidates a displayed token, and adds no authority", async (t) => {
  const f = setup(t);
  const peer = await incoming(f, 1, "同伴的旧消息", { user_id: 10001 });
  await readAll(f, f.ctx, peer.id);
  const draft = args("recall");
  const old = await blocked(f.runtime.send(f.ctx, draft));
  await incoming(f, 1, "", {
    post_type: "notice",
    notice_type: "group_recall",
    user_id: 10001,
  });
  const failure = await blocked(
    f.runtime.send(f.ctx, { ...draft, inputReview: confirm(old) }),
  );
  assert.equal(failure.items.length, 1);
  assert.equal(failure.items[0].kind, "message.recalled");
  assert.notEqual(failure.items[0].id, peer.id);
  await readAll(f, f.ctx, failure.items[0].id);
  const ready = await blocked(f.runtime.send(f.ctx, draft));
  assert.notEqual(ready.token, old.token);
  assert.equal(f.ctx.requestEvents.size, 0);
  assert.equal(
    (await f.runtime.send(f.ctx, { ...draft, inputReview: confirm(ready) }))
      .status,
    "sent",
  );
  assert.equal(f.mem.state(f.ctx.conversation).readThroughSeq || 0, 0);
});

test("duplicate wire pushes retain the same canonical version and cannot be treated as an authenticated edit", async (t) => {
  const f = setup(t);
  const first = await incoming(f, 1, "原文");
  await readAll(f, f.ctx, first.id);
  const draft = args("dedupe");
  const ready = await blocked(f.runtime.send(f.ctx, draft));
  await incoming(f, 1, "原文");
  await incoming(f, 1, "同号异文");
  assert.equal(
    (await blocked(f.runtime.send(f.ctx, draft))).token,
    ready.token,
  );
  assert.equal(f.mem.readRecord({ id: first.id }).body, "原文");
  assert.equal(
    (await f.runtime.send(f.ctx, { ...draft, inputReview: confirm(ready) }))
      .status,
    "sent",
  );
});

test("gate rechecks queued sends immediately before reservation and never rolls back an issued network send", async (t) => {
  const f = setup(t);
  const entered = Promise.withResolvers(),
    firstReply = Promise.withResolvers();
  const send = f.transport.send.bind(f.transport);
  f.transport.send = (conversation, segments) => {
    if (conversation === "group:20001") {
      entered.resolve();
      return firstReply.promise;
    }
    return send(conversation, segments);
  };
  const other = context(f.runtime, "agent-0", "group:20001");
  const inFlight = f.runtime.send(other, args("already-network"));
  await entered.promise;
  const queued = f.runtime.send(f.ctx, args("queued"));
  const rejected = blocked(queued);
  const fresh = await incoming(f, 1, "当前聊天补充");
  await incoming(f, 2, "网关调用之后的补充", { group_id: 20001 });
  assert.equal(f.mem.delivery("already-network").status, "pending");
  firstReply.resolve({ messageId: "40000" });
  assert.equal((await inFlight).status, "sent");
  assert.equal((await rejected).items[0].id, fresh.id);
  assert.equal(f.mem.delivery("queued"), undefined);
  assert.equal(f.mem.state(f.ctx.conversation).sendTimes?.length || 0, 0);
  assert.equal(
    (await f.runtime.send(other, args("already-network"))).duplicate,
    true,
  );
});

test("voice conversion can yield before the commit fence but cannot consume an outbox or quota", async (t) => {
  const f = setup(t);
  const entered = Promise.withResolvers(),
    prepared = Promise.withResolvers();
  let conversions = 0;
  f.runtime.voices = {
    metadata: () => ({ id: "voice-fixture", title: "语音", sources: [] }),
    segment: () => {
      conversions++;
      entered.resolve();
      return prepared.promise;
    },
  };
  const input = { requestId: "voice", audioId: "voice-fixture" };
  const rejected = blocked(f.runtime.callTool(f.ctx, "qq_send_voice", input));
  await entered.promise;
  const fresh = await incoming(f, 1, "这时收到补充");
  prepared.resolve({ type: "record", data: { file: "fixture" } });
  const ready = await rejected;
  assert.equal(ready.items[0].id, fresh.id);
  assert.equal(f.mem.delivery(input.requestId), undefined);
  assert.equal(f.transport.sent.length, 0);
  assert.equal(
    (
      await f.runtime.callTool(f.ctx, "qq_draft", {
        action: "continue",
        draftId: ready.draft.draftId,
        expectedVersion: ready.draft.version,
        inputReview: confirm(ready),
      })
    ).status,
    "sent",
  );
  assert.equal(
    (await f.runtime.callTool(f.ctx, "qq_send_voice", input)).duplicate,
    true,
  );
  assert.equal(conversions, 2);
});

test("a duplicate burst prefix cannot authorize a new tail and the token binds the whole burst", async (t) => {
  const f = setup(t);
  await f.runtime.send(f.ctx, args("burst:0", "第一条"));
  const row = await incoming(f, 1, "更正");
  const burst = {
    requestId: "burst",
    messages: ["第一条", "旧第二条", "旧第三条"],
    gapMs: 0,
  };
  await assert.rejects(
    f.runtime.callTool(f.ctx, "qq_send_burst", {
      ...burst,
      messages: ["更改历史第一条", "旧第二条", "旧第三条"],
    }),
    /IDEMPOTENCY_CONFLICT/,
  );
  const stop = await f.runtime.callTool(f.ctx, "qq_send_burst", burst);
  assert.equal(stop.error, "QQ_DRAFT_CONTINUE_REQUIRED");
  assert.equal(stop.receipts[0].duplicate, true);
  assert.equal(f.mem.delivery("burst:1"), undefined);
  const continuation = {
    action: "continue",
    draftId: stop.draft.draftId,
    expectedVersion: stop.draft.version,
  };
  const ready = await f.runtime.callTool(f.ctx, "qq_draft", continuation);
  assert.equal(ready.error, "INPUT_REVIEW_REQUIRED");
  assert.equal(ready.failedIndex, 1);
  assert.equal(ready.inputReview.items[0].id, row.id);
  const edited = await f.runtime.callTool(f.ctx, "qq_draft", {
    ...continuation,
    action: "revise",
    position: 2,
    input: { text: "改第三条" },
  });
  const change = await f.runtime.callTool(f.ctx, "qq_draft", {
    ...continuation,
    expectedVersion: edited.version,
    inputReview: confirm(ready.inputReview),
  });
  assert.equal(change.error, "INPUT_REVIEW_REQUIRED");
  assert.notEqual(change.inputReview.token, ready.inputReview.token);
  const sent = await f.runtime.callTool(f.ctx, "qq_draft", {
    ...continuation,
    expectedVersion: edited.version,
    inputReview: confirm(change.inputReview),
  });
  assert.equal(sent.status, "sent");
  assert.equal(f.transport.sent.length, 3);
});

test("ordinary group exclusions apply only to the reviewed draft and survive as pending in another turn", async (t) => {
  const f = setup(t);
  const row = await incoming(f, 1, "另一段谈话");
  await readAll(f, f.ctx, row.id);
  const draft = args("group-review");
  const review = await blocked(f.runtime.send(f.ctx, draft));
  assert.equal(review.canExclude, true);
  const unrelated = [{ id: row.id, reason: "这条在约另一个时间" }];
  assert.equal(
    (
      await f.runtime.send(f.ctx, {
        ...draft,
        inputReview: confirm(review, unrelated),
      })
    ).status,
    "sent",
  );

  const ctx = context(f.runtime);
  await readAll(f, ctx, row.id);
  const next = args("new-draft");
  const challenge = await blocked(
    f.runtime.send(ctx, {
      ...next,
      inputReview: confirm(review, unrelated),
    }),
  );
  assert.equal(challenge.items[0].id, row.id);
  assert.notEqual(challenge.token, review.token);
});

for (const conversation of ["private:30000", "group:20001"])
  test(
    "private-style conversations require consideration of all inputs: " +
      conversation,
    async (t) => {
      const f = setup(t);
      const ctx = context(f.runtime, "agent-0", conversation);
      const row = await incoming(f, 1, "补充", {
        group_id: conversation.startsWith("private:") ? null : 20001,
      });
      await readAll(f, ctx, row.id);
      const draft = args("private-review");
      const review = await blocked(f.runtime.send(ctx, draft));
      assert.equal(review.canExclude, false);
      await blocked(
        f.runtime.send(ctx, {
          ...draft,
          inputReview: confirm(review, [{ id: row.id, reason: "不影响" }]),
        }),
      );
      assert.equal(f.mem.delivery(draft.requestId), undefined);
      assert.equal(
        (await f.runtime.send(ctx, { ...draft, inputReview: confirm(review) }))
          .status,
        "sent",
      );
    },
  );

test("review tokens bind the context, request, reply target and mentioned target", async (t) => {
  const f = setup(t);
  const row = await incoming(f, 1, "补充");
  await readAll(f, f.ctx, row.id);
  const draft = { ...args("scope"), replyTo: "1", atUserId: "30000" };
  const review = await blocked(f.runtime.send(f.ctx, draft));
  const retry = { ...draft, inputReview: confirm(review) };
  for (const change of [
    { replyTo: undefined },
    { atUserId: "30001" },
    { requestId: "other" },
  ])
    assert.notEqual(
      (await blocked(f.runtime.send(f.ctx, { ...retry, ...change }))).token,
      review.token,
    );
  const replacement = context(f.runtime);
  await readAll(f, replacement, row.id);
  assert.notEqual(
    (await blocked(f.runtime.send(replacement, retry))).token,
    review.token,
  );
  const other = context(f.runtime, "agent-0", "group:20001");
  assert.notEqual(
    (await blocked(f.runtime.send(other, { ...retry, replyTo: undefined })))
      .token,
    review.token,
  );
  assert.equal(f.transport.sent.length, 0);
});

test("pending input review cannot bypass quotas, pause, or revoked chat admission", async (t) => {
  const f = setup(t);
  await f.runtime.send(f.ctx, args("consumes-quota"));
  const row = await incoming(f, 1, "补充");
  await readAll(f, f.ctx, row.id);
  const draft = args("review-limits");
  const review = await blocked(f.runtime.send(f.ctx, draft));
  const retry = () =>
    f.runtime.send(f.ctx, { ...draft, inputReview: confirm(review) });
  const agent = f.runtime.agent("agent-0");
  agent.behavior.maxSendPerMinute = 1;
  await assert.rejects(retry(), /SEND_RATE_LIMIT/);
  agent.behavior.maxSendPerMinute = 30;
  agent.paused = true;
  await assert.rejects(retry(), /AGENT_PAUSED_OR_EXPIRED/);
  agent.paused = false;
  agent.allow.groups = [];
  await assert.rejects(retry(), /AGENT_PAUSED_OR_EXPIRED/);
  assert.equal(f.mem.delivery(draft.requestId), undefined);
  assert.equal(f.transport.sent.length, 1);
});

test("a blocked checkpoint is not reserved or recovered by a later duplicate", async (t) => {
  const f = setup(t);
  const row = await incoming(f, 1, "补充");
  await f.runtime.callTool(f.ctx, "conversation_read", {});
  const draft = args("review-checkpoint");
  const send = (values) => f.runtime.callTool(f.ctx, "qq_send", values);
  const review = await blocked(send({ ...draft, readThroughSeq: row.seq }));
  assert.equal(
    f.mem.state(f.ctx.conversation).readCheckpointReceipts,
    undefined,
  );
  assert.equal(
    (
      await f.runtime.callTool(f.ctx, "qq_draft", {
        action: "continue",
        draftId: review.draft.draftId,
        expectedVersion: review.draft.version,
        inputReview: confirm(review),
      })
    ).status,
    "sent",
  );
  const duplicate = await send({ ...draft, readThroughSeq: row.seq });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.readCheckpoint, undefined);
  assert.equal(f.mem.state(f.ctx.conversation).readThroughSeq || 0, 0);
});

test("a new file notice joins review without supplying human reply authority", async (t) => {
  const f = setup(t);
  await f.runtime.ingest(
    "qq-0",
    raw(1, {
      post_type: "notice",
      notice_type: "group_upload",
      file: { id: "file-fixture", name: "更新文件.txt", size: 31 },
    }),
  );
  const draft = args("file-notice");
  const first = await blocked(f.runtime.send(f.ctx, draft));
  assert.equal(first.items[0].kind, "notice.file");
  await readAll(f, f.ctx, first.items[0].id);
  const ready = await blocked(f.runtime.send(f.ctx, draft));
  assert.equal(f.ctx.requestEvents.size, 0);
  assert.equal(
    (await f.runtime.send(f.ctx, { ...draft, inputReview: confirm(ready) }))
      .status,
    "sent",
  );
});

test("an observed late voice transcript requires review and is presented with its source", async (t) => {
  const f = setup(t);
  const row = await incoming(f, 1, "", {
    message: [{ type: "record", data: { file: "voice-fixture" } }],
  });
  await f.runtime.callTool(f.ctx, "conversation_read", {});
  const draft = args("transcript");
  const before = await blocked(f.runtime.send(f.ctx, draft));
  assert(before.token);
  const voice = f.mem.db.prepare("SELECT * FROM events WHERE id=?").get(row.id);
  f.runtime.transcripts.store(
    { eventId: row.id, conversation: f.ctx.conversation },
    f.runtime.agent("agent-0"),
    voice,
    { id: "voice-fixture", duration: 1 },
    "晚到的机器转写",
    {},
  );
  const required = await blocked(
    f.runtime.send(f.ctx, { ...draft, inputReview: confirm(before) }),
  );
  assert.equal(required.items[0].kind, "voice.transcript");
  const events = [...f.ctx.requestEvents];
  await f.runtime.callTool(f.ctx, "conversation_read", {});
  const ready = await blocked(f.runtime.send(f.ctx, draft));
  assert.equal(ready.missing, 0);
  assert.notEqual(ready.token, before.token);
  assert.deepEqual([...f.ctx.requestEvents], events);
  assert.equal(
    (await f.runtime.send(f.ctx, { ...draft, inputReview: confirm(ready) }))
      .status,
    "sent",
  );
});

test("legal input larger than the old cumulative page limit can finish review", async (t) => {
  const f = setup(t);
  const row = await incoming(f, 1, "x".repeat(715000));
  const draft = args("large-review");
  assert.equal((await blocked(f.runtime.send(f.ctx, draft))).missing, 1);
  let offset = 0,
    page;
  do {
    page = await f.runtime.callTool(f.ctx, "memory_read", {
      id: row.id,
      offset,
      maxChars: 16000,
    });
    offset = page.nextOffset;
  } while (offset !== null);
  assert(page.totalChars > 2100000);
  const ready = await blocked(f.runtime.send(f.ctx, draft));
  assert(ready.token);
  assert.equal(
    (await f.runtime.send(f.ctx, { ...draft, inputReview: confirm(ready) }))
      .status,
    "sent",
  );
});

test("only current connection and live trusted inbound chat sources enter the gate", async (t) => {
  const f = setup(t);
  const source = {
    conversation: f.ctx.conversation,
    connectionId: "qq-0",
    kind: "message.received",
    direction: "in",
    senderId: "30000",
    body: "不进入当前审阅的归档内容",
    payload: { trustedInput: true },
  };
  for (const [i, variant] of [
    { origin: "import" },
    { payload: { trustedInput: false } },
    { conversation: "group:20001" },
    { connectionId: "qq-1" },
    { direction: "out" },
    { senderId: "10000" },
    { kind: "notice.reaction" },
  ].entries())
    f.mem.append({ ...source, ...variant, dedupe: "ignored:" + i });
  assert.equal(
    (await f.runtime.send(f.ctx, args("ignored-sources"))).status,
    "sent",
  );
});

test("full opening material is enough for a first reply when its versions stay current", async (t) => {
  let received;
  const f = setup(t, async (p) => {
    assert.match(p.prompt, /完整开场/);
    received = await p.callTool("qq_send", args("opening"));
  });
  await incoming(f, 1, "完整开场");
  await f.runtime.wake("agent-0", f.ctx.conversation);
  assert.equal(received?.status, "sent");
});
