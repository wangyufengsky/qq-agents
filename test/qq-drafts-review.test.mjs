import test from "node:test";
import assert from "node:assert/strict";
import { fixture, config, context, raw } from "./helpers.mjs";
import { safeToolFailure } from "../src/tools/errors.mjs";
import { recallBoundary } from "../src/core/recall-boundary.mjs";

const marker = "SYNTHETIC_RESTRICTED_TRANSCRIPT";

function make(t, run) {
  const cfg = config(1);
  cfg.agents[0].wake.participation = 0;
  cfg.agents[0].wake.names = false;
  cfg.agents[0].tools.push("qq_send_burst");
  const f = fixture(t, { cfg, run });
  return { ...f, ctx: context(f.runtime), mem: f.store.bind("agent-0") };
}

function storeTranscript(f, source, body, protection = {}) {
  f.runtime.transcripts.store(
    { eventId: source.id, conversation: source.conversation },
    f.runtime.agent("agent-0"),
    source,
    { id: "synthetic-voice", duration: 1, ...protection },
    body,
    {},
  );
}

async function seedProtectedTranscript(f) {
  await f.runtime.ingest(
    "qq-0",
    raw(1, {
      message: [{ type: "record", data: { file: "synthetic-voice" } }],
    }),
  );
  const source = f.mem.db
    .prepare("SELECT * FROM events WHERE message_id='1'")
    .get();
  storeTranscript(f, source, marker, { protectedOperations: true });
  const transcript = f.mem.db
    .prepare("SELECT * FROM events WHERE kind='voice.transcript'")
    .get();
  assert(
    recallBoundary(f.runtime, f.ctx).allowed(
      f.mem.readRecord({ id: source.id }, f.ctx.conversation),
    ),
  );
  assert(
    !recallBoundary(f.runtime, f.ctx).allowed(
      f.mem.readRecord({ id: transcript.id }, f.ctx.conversation),
    ),
  );
  return source;
}

function send(f, draft, inputReview) {
  return draft
    ? f.runtime.callTool(f.ctx, "qq_draft", {
        action: "continue",
        draftId: draft.draftId,
        expectedVersion: draft.version,
        ...(inputReview ? { inputReview } : {}),
      })
    : f.runtime.callTool(f.ctx, "qq_send", {
        requestId: "synthetic-review",
        text: "测试回复",
      });
}
async function blocked(f, draft, inputReview) {
  let result;
  await assert.rejects(send(f, draft, inputReview), (error) => {
    result = safeToolFailure(error);
    return result.code === "INPUT_REVIEW_REQUIRED";
  });
  return { ...result.inputReview, draft: result.draft };
}

test("an ordinary voice source does not expose the protected transcript in its review receipt", async (t) => {
  const f = make(t);
  const source = await seedProtectedTranscript(f);
  const result = await blocked(f);
  assert(result.items.some(({ id }) => id === source.id));
  assert(!JSON.stringify(result).includes(marker));
  assert.equal(f.ctx.requestEvents.size, 1);
  assert.equal(f.mem.state(f.ctx.conversation).readThroughSeq || 0, 0);
});

test("a gateway recall notice with an extra message field does not repeat recalled contents", async (t) => {
  const f = make(t);
  const recalled = "SYNTHETIC_RECALLED_BODY";
  await f.runtime.ingest("qq-0", raw(1, { message: recalled }));
  await f.runtime.ingest(
    "qq-0",
    raw(1, {
      post_type: "notice",
      notice_type: "group_recall",
      message: recalled,
    }),
  );
  const result = await blocked(f);
  assert(result.items.some(({ kind }) => kind === "message.recalled"));
  assert(!JSON.stringify(result).includes(recalled));
});

test("conversation_read and memory_read preserve the protection of a nested voice transcript", async (t) => {
  const f = make(t);
  const source = await seedProtectedTranscript(f);
  const recent = await f.runtime.callTool(f.ctx, "conversation_read", {});
  const full = await f.runtime.callTool(f.ctx, "memory_read", {
    id: source.id,
  });
  assert.deepEqual(
    {
      conversation_read: JSON.stringify(recent).includes(marker),
      memory_read: full.chunk.includes(marker),
    },
    { conversation_read: false, memory_read: false },
  );
  assert(recent.items.some(({ id }) => id === source.id));
  assert(full.chunk.includes(source.id));
});

test("the initial model prompt preserves the protection of a nested voice transcript", async (t) => {
  let prompt;
  const f = make(t, async (p) => {
    prompt = p.prompt;
  });
  const source = await seedProtectedTranscript(f);
  await f.runtime.wake("agent-0", f.ctx.conversation);
  assert(prompt?.includes(source.id));
  assert(!prompt.includes(marker));
});

test("only final original projection counts, and complete pagination is required for an omitted long item", async (t) => {
  const f = make(t);
  await f.runtime.ingest("qq-0", raw(1, { message: "Long-".repeat(2500) }));
  await f.runtime.ingest("qq-0", raw(2, { message: "Short fixture" }));
  const out = await blocked(f);
  assert.equal(out.missing, 1);
  assert.equal(out.completeThroughSeq, null);
  assert.equal(out.items[0].bodyOmitted, true);
  assert.equal(out.items[1].body, "Short fixture");
  assert.equal(out.token, undefined);
  assert.equal(f.ctx.requestEvents.size, 1);
  assert.equal(f.mem.state(f.ctx.conversation).readThroughSeq || 0, 0);
  const { id } = out.items[0];
  let offset = 0;
  do {
    const page = await f.runtime.callTool(f.ctx, "memory_read", {
      id,
      offset,
      maxChars: 16000,
    });
    offset = page.nextOffset;
    if (offset !== null)
      assert.equal((await blocked(f, out.draft)).token, undefined);
  } while (offset !== null);
  const ready = await blocked(f, out.draft);
  assert.equal(ready.missing, 0);
  assert.match(ready.token, /^[a-f0-9]{64}$/);
  assert.equal(f.mem.state(f.ctx.conversation).readThroughSeq || 0, 0);
  assert.equal(f.mem.delivery("synthetic-review"), undefined);
  const sent = await send(f, out.draft, {
    token: ready.token,
    decision: "continue",
  });
  assert.equal(sent.status, "sent");
  assert.equal(f.mem.state(f.ctx.conversation).readThroughSeq || 0, 0);
});

test("a burst stop keeps original, source, token and draft receipt in the same tool projection", async (t) => {
  const f = make(t);
  await f.runtime.ingest("qq-0", raw(1, { message: "Short review original" }));
  const out = await f.runtime.callTool(f.ctx, "qq_send_burst", {
    requestId: "synthetic-burst-review",
    messages: ["第一条", "第二条"],
    gapMs: 0,
  });
  assert.equal(out.status, "stopped");
  assert.equal(out.error, "INPUT_REVIEW_REQUIRED");
  assert.equal(out.failedIndex, 0);
  assert.equal(out.inputReview.items[0].body, "Short review original");
  assert.equal(
    out.inputReview.items[0].source.conversation,
    f.ctx.conversation,
  );
  assert.match(out.inputReview.token, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    out.draft.items.map(({ status }) => status),
    ["unsubmitted", "unsubmitted"],
  );
  assert.deepEqual(out.receipts, []);
  assert.equal(f.ctx.requestEvents.size, 1);
  assert.equal(f.mem.state(f.ctx.conversation).readThroughSeq || 0, 0);
  const sent = await send(f, out.draft, {
    token: out.inputReview.token,
    decision: "continue",
  });
  assert.equal(sent.status, "sent");
  assert.deepEqual(
    sent.draft.items.map(({ status }) => status),
    ["sent", "sent"],
  );
});

test("a partial burst returns its confirmed prefix and never replays it after reviewing new input", async (t) => {
  const f = make(t);
  const gateway = f.runtime.transports.get("qq-0");
  const deliver = gateway.send.bind(gateway);
  gateway.send = async (...args) => {
    const receipt = await deliver(...args);
    if (gateway.sent.length === 1) {
      await f.runtime.ingest("qq-0", raw(1, { message: "等一下，有新的补充" }));
    }
    return receipt;
  };
  const out = await f.runtime.callTool(f.ctx, "qq_send_burst", {
    requestId: "synthetic-partial-review",
    messages: ["第一条", "第二条"],
    gapMs: 0,
  });
  assert.equal(out.status, "stopped");
  assert.equal(out.error, "INPUT_REVIEW_REQUIRED");
  assert.equal(out.failedIndex, 1);
  assert.equal(out.receipts.length, 1);
  assert.equal(out.receipts[0].status, "sent");
  assert(out.receipts[0].recordId);
  assert.equal(out.inputReview.items[0].body, "等一下，有新的补充");
  assert.equal(
    out.inputReview.items[0].source.conversation,
    f.ctx.conversation,
  );
  assert.match(out.inputReview.token, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    out.draft.items.map(({ status }) => status),
    ["sent", "unsubmitted"],
  );
  assert.equal(gateway.sent.length, 1);
  assert.equal(f.ctx.requestEvents.size, 1);
  assert.equal(f.mem.state(f.ctx.conversation).replyBatchSends, 0);
  const pending = await send(f, out.draft);
  assert.equal(pending.error, "INPUT_REVIEW_REQUIRED");
  assert.deepEqual(pending.inputReview.items, []);
  assert.equal(pending.inputReview.token, out.inputReview.token);
  const sent = await send(f, out.draft, {
    token: pending.inputReview.token,
    decision: "continue",
  });
  assert.equal(sent.status, "sent");
  assert.equal(gateway.sent.length, 2);
  assert.equal(sent.receipts[0].recordId, out.receipts[0].recordId);
});

test("pagination cannot combine versions when a transcript changes the projection mid-read", async (t) => {
  const f = make(t);
  await f.runtime.ingest(
    "qq-0",
    raw(1, {
      message: [
        { type: "text", data: { text: "Long-".repeat(2500) } },
        { type: "record", data: { file: "synthetic-voice" } },
      ],
    }),
  );
  const source = f.mem.db
    .prepare("SELECT * FROM events WHERE message_id='1'")
    .get();
  const first = await blocked(f);
  assert.equal(first.missing, 1);
  const read = (offset) =>
    f.runtime.callTool(f.ctx, "memory_read", {
      id: source.id,
      offset,
      maxChars: 16000,
    });
  const page = await read(0);
  assert(page.nextOffset);

  storeTranscript(f, source, "Late machine transcript");
  const interrupted = await read(page.nextOffset);
  assert.deepEqual(interrupted.presentationRestart, {
    tool: "memory_read",
    id: source.id,
    offset: 0,
  });
  assert.equal((await blocked(f, first.draft)).token, undefined);

  let offset = 0;
  do {
    offset = (await read(offset)).nextOffset;
  } while (offset !== null);
  const ready = await blocked(f, first.draft);
  assert.equal(ready.missing, 0);
  assert.match(ready.token, /^[a-f0-9]{64}$/);
});

test("revising a draft rebinds the token and keeps the originals already presented in this context", async (t) => {
  const f = make(t);
  await f.runtime.ingest("qq-0", raw(1, { message: "首次展示原文" }));
  const original = await blocked(f);
  const revised = await f.runtime.callTool(f.ctx, "qq_draft", {
    action: "revise",
    draftId: original.draft.draftId,
    expectedVersion: original.draft.version,
    position: 0,
    input: { text: "改过的回复" },
  });
  const confirm = ({ token }) => ({ token, decision: "continue" });
  const stale = await blocked(f, revised, confirm(original));
  assert.deepEqual(stale.items, []);
  assert.equal(stale.missing, 0);
  assert.notEqual(stale.token, original.token);
  assert.equal(f.runtime.transports.get("qq-0").sent.length, 0);

  const replacement = { ...f, ctx: context(f.runtime) };
  const afterContextChange = await blocked(
    replacement,
    revised,
    confirm(stale),
  );
  assert.equal(afterContextChange.items[0].id, original.items[0].id);
  assert.notEqual(afterContextChange.token, stale.token);
  assert.equal(
    (await send(replacement, revised, confirm(afterContextChange))).status,
    "sent",
  );
  assert.equal(f.runtime.transports.get("qq-0").sent.length, 1);
});

test("a pending draft does not prevent a read checkpoint for a complete review receipt", async (t) => {
  const f = make(t);
  await f.runtime.ingest("qq-0", raw(1, { message: "完整回执原文" }));
  const review = await blocked(f);
  const seq = review.items[0].seq;
  assert.equal(review.completeThroughSeq, seq);
  assert.equal(f.ctx.requestEvents.size, 1);
  assert.equal(f.mem.state(f.ctx.conversation).replyInputSeq, seq);
  assert.equal(f.mem.state(f.ctx.conversation).readThroughSeq || 0, 0);
  const duplicate = await f.runtime.callTool(f.ctx, "qq_mark_read", {
    throughSeq: seq,
  });
  assert.equal(duplicate.readThroughSeq, seq);
  const draft = await f.runtime.callTool(f.ctx, "qq_draft", {
    action: "read",
    draftId: review.draft.draftId,
  });
  assert.equal(draft.items[0].status, "unsubmitted");
});

test("one burst owns the full draft while active and its used token cannot reclaim a stopped tail", async (t) => {
  const f = make(t);
  await f.runtime.ingest("qq-0", raw(1, { message: "先核对" }));
  const first = await f.runtime.callTool(f.ctx, "qq_send_burst", {
    requestId: "whole-manifest",
    messages: ["第一条", "尾条"],
    gapMs: 0,
  });
  assert.equal(first.error, "INPUT_REVIEW_REQUIRED");
  const review = { token: first.inputReview.token, decision: "continue" };
  const gateway = f.runtime.transports.get("qq-0");
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const deliver = gateway.send.bind(gateway);
  gateway.send = async (...args) => {
    if (gateway.sent.length === 0) {
      entered.resolve();
      await release.promise;
      await f.runtime.ingest("qq-0", raw(2, { message: "再补一条" }));
    }
    return deliver(...args);
  };
  const execution = send(f, first.draft, review);
  try {
    await Promise.race([
      entered.promise,
      execution.then(() =>
        assert.fail("submission completed before gateway entry"),
      ),
    ]);
    const progress = await send(f, first.draft, review);
    assert.equal(progress.status, "pending");
    assert.equal(progress.error, undefined);
    assert.equal(progress.hint, undefined);
    assert.equal(progress.draft.draftId, first.draft.draftId);
    const ref = {
      draftId: first.draft.draftId,
      expectedVersion: first.draft.version,
    };
    await assert.rejects(
      f.runtime.callTool(f.ctx, "qq_draft", {
        ...ref,
        action: "revise",
        position: 1,
        input: { text: "不能替换" },
      }),
      /DRAFT_EXECUTING/,
    );
    await assert.rejects(
      f.runtime.callTool(f.ctx, "qq_draft", {
        ...ref,
        action: "discard",
      }),
      /DRAFT_EXECUTING/,
    );
  } finally {
    release.resolve();
  }
  const stopped = await execution;
  assert.equal(stopped.error, "INPUT_REVIEW_REQUIRED");
  assert.deepEqual(
    stopped.draft.items.map(({ status }) => status),
    ["sent", "unsubmitted"],
  );
  const replay = await send(f, first.draft, review);
  assert.equal(replay.status, "stopped");
  assert.deepEqual(replay.draft.items, stopped.draft.items);
  assert.equal(gateway.sent.length, 1);
  assert.notEqual(stopped.inputReview.token, review.token);
  const sent = await send(f, stopped.draft, {
    token: stopped.inputReview.token,
    decision: "continue",
  });
  assert.equal(sent.status, "sent");
  assert.deepEqual(
    gateway.sent.map(({ segments }) => segments[0].data.text),
    ["第一条", "尾条"],
  );
});

test("creation IDs are scoped and an existing actual delivery ID cannot impersonate a creation", async (t) => {
  const f = make(t);
  const original = { requestId: "shared-creation", text: "同一句" };
  const first = await f.runtime.callTool(f.ctx, "qq_send", original);
  const other = context(f.runtime, f.ctx.agentId, "group:20001");
  const second = await f.runtime.callTool(other, "qq_send", original);
  assert.equal(first.status, "sent");
  assert.equal(second.status, "sent");
  assert.notEqual(first.requestId, original.requestId);
  assert.notEqual(first.requestId, second.requestId);
  const third = await f.runtime.callTool(f.ctx, "qq_send", {
    ...original,
    requestId: first.requestId,
  });
  assert.equal(third.status, "sent");
  assert.notEqual(third.requestId, first.requestId);
  assert.equal(f.runtime.transports.get("qq-0").sent.length, 3);
});
