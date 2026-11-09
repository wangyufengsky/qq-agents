import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { MemoryStore } from "../src/memory/store.mjs";
import { Runtime } from "../src/core/runtime.mjs";
import { ConfigStore } from "../src/core/config.mjs";
import { config, context, fixture, raw, temp } from "./helpers.mjs";
import {
  inputDisposition,
  processingPending,
  snapshotReviewInput,
} from "../src/core/input-review.mjs";
import { requestedByHuman } from "../src/core/outbound-policy.mjs";
import { liveInput } from "../src/core/live-input.mjs";
import { restoreExport } from "../src/memory/migrate.mjs";
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

test("opening long-body gap survives a higher displayed short message and a new turn", async (t) => {
  const f = setup(t);
  const long = await incoming(f, 1, "长".repeat(17000));
  const short = await incoming(f, 2, "简短补充");
  await f.runtime.callTool(f.ctx, "conversation_read", { maxChars: 512 });
  await f.runtime.callTool(f.ctx, "conversation_read", { afterSeq: long.seq });
  assert.equal(f.ctx.replyInputSeq, short.seq);
  await assert.rejects(
    f.runtime.callTool(f.ctx, "qq_mark_read", { throughSeq: short.seq }),
    /UNSEEN_WATERMARK/,
  );

  const ctx = context(f.runtime);
  const draft = args("with-gap");
  const failure = await blocked(f.runtime.send(ctx, draft));
  assert.deepEqual(
    failure.items.map(({ id, reason }) => ({ id, reason })),
    [long, short].map(({ id }) => ({ id, reason: "full_input_not_presented" })),
  );
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
  assert.deepEqual(challenge.items, []);
  assert.equal(challenge.excludable[0].id, row.id);
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

test("a blocked checkpoint is not reserved until same-epoch continue is confirmed", async (t) => {
  const f = setup(t);
  const row = await incoming(f, 1, "补充");
  await f.runtime.callTool(f.ctx, "conversation_read", {});
  const draft = args("review-checkpoint");
  const send = (values) => f.runtime.callTool(f.ctx, "qq_send", values);
  const review = await blocked(send({ ...draft, readThroughSeq: row.seq }));
  assert.equal(f.mem.delivery(review.draft.items[0].requestId), undefined);
  assert.equal(f.mem.state(f.ctx.conversation).readThroughSeq || 0, 0);
  const receipt = await f.runtime.callTool(f.ctx, "qq_draft", {
    action: "continue",
    draftId: review.draft.draftId,
    expectedVersion: review.draft.version,
    inputReview: confirm(review),
  });
  assert.equal(receipt.status, "sent");
  assert.deepEqual(receipt.readCheckpoint, {
    throughSeq: row.seq,
    applied: true,
  });
  const duplicate = await send({ ...draft, readThroughSeq: row.seq });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.requestId, receipt.requestId);
  assert.deepEqual(duplicate.readCheckpoint, receipt.readCheckpoint);
  assert.equal(f.mem.state(f.ctx.conversation).readThroughSeq, row.seq);
  assert.equal(f.transport.sent.length, 1);
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

test("an updated event below an existing processed and sent watermark requires fresh review", async (t) => {
  const f = setup(t);
  const old = await incoming(f, 1, "原版本");
  await f.runtime.callTool(f.ctx, "conversation_read", {});
  await f.runtime.callTool(f.ctx, "qq_mark_read", { throughSeq: old.seq });
  const first = args("before-correction");
  const before = await blocked(f.runtime.send(f.ctx, first));
  await f.runtime.send(f.ctx, { ...first, inputReview: confirm(before) });
  assert.deepEqual(
    inputDisposition(f.runtime, f.ctx, {
      id: old.id,
      version: f.ctx.presentedInput.get(old.id),
    }),
    { processed: true, noReply: false, deliveryIds: [first.requestId] },
  );

  f.mem.db.prepare("UPDATE events SET body=? WHERE id=?").run("新版本", old.id);
  await readAll(f, f.ctx, old.id);
  const ctx = context(f.runtime);
  const reply = args("after-correction");
  const changed = await blocked(f.runtime.send(ctx, reply));
  assert.deepEqual(
    changed.items.map(({ id, reason }) => ({ id, reason })),
    [
      {
        id: old.id,
        reason: "full_input_not_presented",
      },
    ],
  );
  assert.equal(f.mem.state(ctx.conversation).readThroughSeq, old.seq);
  await readAll(f, ctx, old.id);
  const rebound = await blocked(
    f.runtime.send(ctx, {
      ...reply,
      inputReview: confirm(before),
    }),
  );
  assert.deepEqual(rebound.items, []);
  assert.notEqual(rebound.token, before.token);
  await f.runtime.send(ctx, { ...reply, inputReview: confirm(rebound) });

  const later = context(f.runtime);
  assert.equal(
    (await f.runtime.send(later, args("settled-correction"))).status,
    "sent",
  );
});

test("a later short message cannot consume an earlier human request's first complete presentation", async (t) => {
  const f = setup(t);
  const first = await incoming(f, 1, "较长请求".repeat(4200));
  const second = await incoming(f, 2, "附注");
  const tail = await f.runtime.callTool(f.ctx, "conversation_read", {
    afterSeq: first.seq,
  });
  assert.equal(tail.readThroughSeq, 0);
  assert.deepEqual([...f.ctx.requestEvents], [second.id]);
  f.ctx.replyBatchSends = 2;
  await readAll(f, f.ctx, first.id);
  assert.equal(f.ctx.shownSeq, second.seq);
  assert.equal(f.ctx.replyInputSeq, second.seq);
  assert.equal(f.ctx.replyBatchSends, 2);
  assert.deepEqual([...f.ctx.requestEvents], [second.id, first.id]);
  const later = context(f.runtime);
  await readAll(f, later, first.id);
  assert.equal(later.requestEvents.size, 0);
});

test("restricted real input blocks a checkpoint but a protected forward archive does not", async (t) => {
  const f = setup(t);
  await incoming(f, 1, "第一条");
  f.mem.append({
    kind: "forward.archive",
    dedupe: "restricted-archive",
    conversation: f.ctx.conversation,
    connectionId: "qq-0",
    origin: "forward",
    payload: { protectedOperations: true },
    body: "隐藏归档",
  });
  const second = await incoming(f, 2, "第二条");
  const page = await f.runtime.callTool(f.ctx, "conversation_read", {});
  assert.equal(page.readThroughSeq, second.seq);
  const protectedRow = f.mem.append({
    kind: "message.received",
    dedupe: "restricted-real",
    conversation: f.ctx.conversation,
    connectionId: "qq-0",
    senderId: "30000",
    payload: { trustedInput: true, protectedOperations: true },
    body: "隐藏输入",
  });
  const tail = await incoming(f, 3, "第三条");
  const next = await f.runtime.callTool(f.ctx, "conversation_read", {});
  assert.equal(next.readThroughSeq, second.seq);
  assert.deepEqual(next.readGap, { reason: "restricted_input" });
  assert(!JSON.stringify(next).includes(protectedRow.id));
  assert(!JSON.stringify(next).includes("隐藏输入"));
  await assert.rejects(
    f.runtime.callTool(f.ctx, "qq_mark_read", { throughSeq: tail.seq }),
    /UNSEEN_WATERMARK/,
  );
  const review = await blocked(f.runtime.send(f.ctx, args("hidden")));
  assert.equal(review.blocked, "restricted_input");
  assert.equal(review.token, undefined);
});

test("mark_read and exact noReply have separate effects across turns and versions", async (t) => {
  const f = setup(t);
  const first = await incoming(f, 1, "阅读后无需回答");
  const second = await incoming(f, 2, "暂未决定是否回答");
  const read = await f.runtime.callTool(f.ctx, "conversation_read", {});
  const noReply = read.items.find(({ id }) => id === first.id).inputRef;
  await f.runtime.callTool(f.ctx, "qq_mark_read", {
    throughSeq: second.seq,
    noReply: [noReply],
  });
  assert.deepEqual(processingPending(f.runtime, f.ctx), []);
  assert.deepEqual(
    snapshotReviewInput(f.runtime, f.ctx).items.map(({ id }) => id),
    [first.id, second.id],
  );
  const later = context(f.runtime);
  assert.deepEqual(
    snapshotReviewInput(f.runtime, later).items.map(({ id }) => id),
    [second.id],
  );
  assert.deepEqual(inputDisposition(f.runtime, later, noReply), {
    processed: true,
    noReply: true,
    deliveryIds: [],
  });
  f.mem.db
    .prepare("UPDATE events SET body=? WHERE id=?")
    .run("已改版的输入", first.id);
  assert.deepEqual(
    processingPending(f.runtime, later).map(({ id }) => id),
    [first.id],
  );
  assert.deepEqual(
    snapshotReviewInput(f.runtime, later).items.map(({ id }) => id),
    [first.id, second.id],
  );
  await assert.rejects(
    f.runtime.callTool(later, "qq_mark_read", {
      throughSeq: second.seq,
      noReply: [noReply],
    }),
    /UNSEEN_WATERMARK/,
  );
});

test("an ACK settles only exact review evidence and never marks either question as processed", async (t) => {
  const f = setup(t);
  const first = await incoming(f, 1, "问题一");
  const second = await incoming(f, 2, "问题二");
  await f.runtime.callTool(f.ctx, "conversation_read", {});
  const draft = args("reply-only-first", "回答问题一");
  const review = await blocked(f.runtime.send(f.ctx, draft));
  const entered = Promise.withResolvers();
  const gateway = Promise.withResolvers();
  f.transport.send = () => {
    entered.resolve();
    return gateway.promise;
  };
  const sending = f.runtime.send(f.ctx, {
    ...draft,
    inputReview: confirm(review),
  });
  await entered.promise;
  const oldVersion = f.ctx.presentedInput.get(first.id);
  f.mem.db
    .prepare("UPDATE events SET body=? WHERE id=?")
    .run("问题一已改", first.id);
  await f.runtime.callTool(f.ctx, "conversation_read", {});
  gateway.resolve({ messageId: "40001" });
  assert.equal((await sending).status, "sent");
  const later = context(f.runtime);
  assert.deepEqual(
    processingPending(f.runtime, later).map(({ id }) => id),
    [first.id, second.id],
  );
  assert.deepEqual(
    snapshotReviewInput(f.runtime, later).items.map(({ id }) => id),
    [first.id],
  );
  assert.deepEqual(
    inputDisposition(f.runtime, later, { id: first.id, version: oldVersion }),
    { processed: false, noReply: false, deliveryIds: [draft.requestId] },
  );
  assert.equal(f.mem.state(f.ctx.conversation).readThroughSeq, 0);
});

test("logical restore may display history but cannot create human or peer reply authority", async (t) => {
  const source = setup(t);
  const human = await incoming(source, 1, "历史真人请求");
  await incoming(source, 2, "历史同伴消息", {
    group_id: 20001,
    user_id: 10001,
  });
  const root = temp(t),
    store = new MemoryStore(path.join(root, "memory.sqlite"));
  const mem = store.bind("agent-0");
  restoreExport(mem, source.mem.export());
  const runtime = new Runtime({
    memory: store,
    configStore: new ConfigStore(
      path.join(root, "config.json"),
      source.runtime.config,
    ),
  });
  t.after(async () => {
    await runtime.close();
    store.close();
  });
  const restored = { runtime, mem, ctx: context(runtime) };
  assert.equal(
    liveInput(restored.runtime, "agent-0", restored.ctx.conversation, human.id),
    null,
  );
  restored.ctx.intentOnly = true;
  restored.ctx.intentSnapshotSeq = 0;
  restored.ctx.scheduleRunId = "preserved-schedule";
  restored.ctx.replyBatchSends = 2;
  await readAll(restored, restored.ctx, human.id);
  assert.equal(restored.ctx.requestEvents.size, 0);
  assert.equal(restored.ctx.replyBatchSends, 2);
  assert.equal(restored.ctx.intentOnly, true);
  assert.equal(restored.ctx.scheduleRunId, "preserved-schedule");
  const peer = context(restored.runtime, "agent-0", "group:20001");
  peer.replyBatchSends = 2;
  const page = await restored.runtime.callTool(peer, "conversation_read", {});
  assert.equal(page.items[0].body, "历史同伴消息");
  assert.equal(peer.replyBatchSends, 2);
  assert.equal(
    restored.mem.state(peer.conversation).peerReplyInputSeq,
    undefined,
  );
});

test("a transcript follows its source namespace when the role binding changes", async (t) => {
  const f = setup(t);
  const voice = await incoming(f, 1, "", {
    message: [{ type: "record", data: { file: "voice-fixture" } }],
  });
  const rawVoice = f.mem.db
    .prepare("SELECT * FROM events WHERE id=?")
    .get(voice.id);
  f.runtime.transcripts.store(
    { eventId: voice.id, conversation: f.ctx.conversation },
    f.runtime.agent("agent-0"),
    rawVoice,
    { id: "fixture", duration: 1 },
    "识别文本",
    {},
  );
  assert.deepEqual(
    snapshotReviewInput(f.runtime, f.ctx).items.map(({ kind }) => kind),
    ["message.received", "voice.transcript"],
  );
  f.runtime.connection("qq-0").messageIdNamespace = "new-namespace";
  const newer = context(f.runtime);
  assert.deepEqual(snapshotReviewInput(f.runtime, newer).items, []);
});

test("a wait begun in an obsolete epoch cannot stage or commit input to its replacement", async (t) => {
  const f = setup(t);
  const wait = f.runtime.callTool(
    f.ctx,
    "qq_wait_for_messages",
    { timeoutMs: 30000 },
    { deferInput: true },
  );
  const rejected = assert.rejects(wait, /INPUT_EPOCH_CHANGED/);
  f.runtime.contexts.resetInputEvidence(f.ctx);
  const fresh = await incoming(f, 1, "新世代消息");
  await rejected;
  assert.equal(f.ctx.waiting, false);
  assert.equal(f.ctx.waitObservedMs, 0);
  assert.equal(f.ctx.observationSatisfied, false);
  assert.equal(f.ctx.presentedInput?.has(fresh.id) ?? false, false);
});

test("only final review-receipt delivery can grant a same-version human request", async (t) => {
  const f = setup(t);
  const url = "https://example.com/";
  const row = await incoming(f, 1, "请读取 " + url);
  const request = { tool: "web_fetch", args: { url } };
  let receipt;
  await assert.rejects(
    f.runtime.callTool(f.ctx, "qq_send", args("review-source"), {
      deferInput: true,
    }),
    (error) => {
      receipt = error;
      return error.message === "INPUT_REVIEW_REQUIRED";
    },
  );
  assert.equal(requestedByHuman(f.runtime, f.ctx, request, row.id), false);
  f.runtime.commitToolInput(f.ctx, receipt);
  assert.equal(requestedByHuman(f.runtime, f.ctx, request, row.id), true);
  f.mem.db
    .prepare("UPDATE events SET body=? WHERE id=?")
    .run("更新内容仍含 " + url, row.id);
  assert.equal(requestedByHuman(f.runtime, f.ctx, request, row.id), false);
  f.ctx.replyBatchSends = 2;
  await readAll(f, f.ctx, row.id);
  assert.equal(requestedByHuman(f.runtime, f.ctx, request, row.id), true);
  assert.equal(f.ctx.replyBatchSends, 2);
});

test("a confirmed ACK retains the input scope bound at reservation", async (t) => {
  const f = setup(t);
  const row = await incoming(f, 1, "保留旧连接语义");
  await f.runtime.callTool(f.ctx, "conversation_read", {});
  const draft = args("old-scope");
  const review = await blocked(f.runtime.send(f.ctx, draft));
  const original = snapshotReviewInput(f.runtime, f.ctx);
  const entered = Promise.withResolvers(),
    ack = Promise.withResolvers();
  f.transport.send = () => {
    entered.resolve();
    return ack.promise;
  };
  const pending = f.runtime.send(f.ctx, {
    ...draft,
    inputReview: confirm(review),
  });
  await entered.promise;
  f.runtime.connection("qq-0").messageIdNamespace = "new-namespace";
  ack.resolve({ messageId: "40101" });
  assert.equal((await pending).status, "sent");
  const stored = f.mem.db
    .prepare(
      "SELECT reviewed_deliveries FROM input_versions WHERE scope=? AND id=?",
    )
    .get(original.scope, row.id);
  assert.deepEqual(JSON.parse(stored.reviewed_deliveries), [draft.requestId]);
});
