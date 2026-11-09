import test from "node:test";
import assert from "node:assert/strict";
import { fixture, config, context, raw } from "./helpers.mjs";
import { safeToolFailure } from "../src/tools/errors.mjs";
import { recallBoundary } from "../src/core/recall-boundary.mjs";
import { processingPending } from "../src/core/input-review.mjs";

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
async function prepare(f, draft, inputReview) {
  const result = await send(f, draft, inputReview);
  assert.equal(result.actionResult, "not_sent");
  assert.equal(result.attemptedThisCall, false);
  assert(result.preparation);
  return { ...result.preparation, draft: result.draft };
}

test("an ordinary voice source does not expose the protected transcript in its review receipt", async (t) => {
  const f = make(t);
  await seedProtectedTranscript(f);
  const result = await prepare(f);
  assert.equal(result.state, "blocked");
  assert.equal(result.reason, "RESTRICTED_INPUT");
  assert.equal(result.items, undefined);
  assert(!JSON.stringify(result).includes(marker));
  assert.equal(f.ctx.requestEvents.size, 0);
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
  const result = await prepare(f);
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
  const out = await prepare(f);
  assert.equal(out.missing.length, 1);
  assert.equal(out.state, "needs_input");
  assert.equal(out.items[0].body, "Short fixture");
  assert.equal(out.token, undefined);
  assert.equal(f.ctx.requestEvents.size, 1);
  assert.equal(f.mem.state(f.ctx.conversation).readThroughSeq || 0, 0);
  const { id } = out.missing[0];
  let offset = 0;
  do {
    const page = await f.runtime.callTool(f.ctx, "memory_read", {
      id,
      offset,
      maxChars: 16000,
    });
    offset = page.nextOffset;
    if (offset !== null)
      assert.equal((await prepare(f, out.draft)).token, undefined);
  } while (offset !== null);
  const ready = await prepare(f, out.draft);
  assert.deepEqual(ready.missing, []);
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
  assert.equal(out.actionResult, "not_sent");
  assert.equal(out.attemptedThisCall, false);
  assert.equal(out.preparation.state, "ready");
  assert.equal(out.preparation.items[0].body, "Short review original");
  assert.equal(
    out.preparation.items[0].source.conversation,
    f.ctx.conversation,
  );
  assert.match(out.preparation.token, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    out.draft.items.map(({ status }) => status),
    ["unsubmitted", "unsubmitted"],
  );
  assert.deepEqual(out.receipts, []);
  assert.equal(f.ctx.requestEvents.size, 1);
  assert.equal(f.mem.state(f.ctx.conversation).readThroughSeq || 0, 0);
  const sent = await send(f, out.draft, {
    token: out.preparation.token,
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
  assert.equal(out.actionResult, "partially_sent");
  assert.equal(out.attemptedThisCall, true);
  assert.equal(out.preparation.reason, "NEW_INPUT");
  assert.equal(out.receipts.length, 1);
  assert.equal(out.receipts[0].status, "sent");
  assert(out.receipts[0].recordId);
  assert.equal(out.preparation.items[0].body, "等一下，有新的补充");
  assert.equal(
    out.preparation.items[0].source.conversation,
    f.ctx.conversation,
  );
  assert.match(out.preparation.token, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    out.draft.items.map(({ status }) => status),
    ["sent", "unsubmitted"],
  );
  assert.equal(gateway.sent.length, 1);
  assert.equal(f.ctx.requestEvents.size, 1);
  assert.equal(f.mem.state(f.ctx.conversation).replyBatchSends, 0);
  const pending = await send(f, out.draft);
  assert.equal(pending.actionResult, "not_sent");
  assert.deepEqual(pending.preparation.items, []);
  assert.equal(pending.preparation.state, "ready");
  const sent = await send(f, out.draft, {
    token: pending.preparation.token,
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
  const first = await prepare(f);
  assert.equal(first.missing.length, 1);
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
  assert.equal((await prepare(f, first.draft)).token, undefined);

  let offset = 0;
  do {
    offset = (await read(offset)).nextOffset;
  } while (offset !== null);
  const ready = await prepare(f, first.draft);
  assert.deepEqual(ready.missing, []);
  assert.match(ready.token, /^[a-f0-9]{64}$/);
});

test("revising a draft rebinds the token and keeps the originals already presented in this context", async (t) => {
  const f = make(t);
  await f.runtime.ingest("qq-0", raw(1, { message: "首次展示原文" }));
  const original = await prepare(f);
  const revised = await f.runtime.callTool(f.ctx, "qq_draft", {
    action: "revise",
    draftId: original.draft.draftId,
    expectedVersion: original.draft.version,
    position: 0,
    input: { text: "改过的回复" },
  });
  const confirm = ({ token }) => ({ token, decision: "continue" });
  assert.equal(revised.revisionApplied, true);
  assert.equal(revised.preparation.state, "ready");
  const stale = await prepare(f, revised.draft, confirm(original));
  assert.deepEqual(stale.items, []);
  assert.deepEqual(stale.missing, []);
  assert.notEqual(stale.token, original.token);
  assert.equal(f.runtime.transports.get("qq-0").sent.length, 0);

  const replacement = { ...f, ctx: context(f.runtime) };
  const afterContextChange = await prepare(
    replacement,
    revised.draft,
    confirm(stale),
  );
  assert.equal(afterContextChange.items[0].id, original.items[0].id);
  assert.notEqual(afterContextChange.token, stale.token);
  assert.equal(
    (await send(replacement, revised.draft, confirm(afterContextChange)))
      .status,
    "sent",
  );
  assert.equal(f.runtime.transports.get("qq-0").sent.length, 1);
});

test("a pending draft does not prevent a read checkpoint for a complete review receipt", async (t) => {
  const f = make(t);
  await f.runtime.ingest("qq-0", raw(1, { message: "完整回执原文" }));
  const review = await prepare(f);
  const seq = review.items[0].seq;
  assert.equal(review.state, "ready");
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

test("a new epoch must explicitly rebind the exact read checkpoint before committing", async (t) => {
  const f = make(t);
  await f.runtime.ingest("qq-0", raw(1, { message: "已处理的合成输入" }));
  await f.runtime.ingest("qq-0", raw(2, { message: "仍待处理的合成输入" }));
  const opening = await f.runtime.callTool(f.ctx, "conversation_read", {});
  const [{ seq: throughSeq }, { id: pendingId }] = opening.items;
  const started = await f.runtime.callTool(f.ctx, "qq_send", {
    requestId: "review-rebind",
    text: "只处理第一项",
    readThroughSeq: throughSeq,
  });
  assert.equal(started.preparation.state, "ready");
  f.runtime.contexts.resetInputEvidence(f.ctx);
  const ref = {
    draftId: started.draft.draftId,
    expectedVersion: started.draft.version,
  };
  const prepare = (readThroughSeq) =>
    f.runtime.callTool(f.ctx, "qq_draft", {
      ...ref,
      action: "prepare",
      readThroughSeq,
    });
  const notRead = await prepare(throughSeq);
  assert.equal(notRead.preparation.reason, "READ_GAP");
  await f.runtime.callTool(f.ctx, "conversation_read", {});
  const ready = await prepare(throughSeq);
  assert.notEqual(ready.preparation.token, started.preparation.token);
  assert.equal(f.mem.state(f.ctx.conversation).readThroughSeq || 0, 0);
  assert.equal(f.mem.delivery(started.draft.items[0].requestId), undefined);
  const revised = await f.runtime.callTool(f.ctx, "qq_draft", {
    ...ref,
    action: "revise",
    position: 0,
    input: { text: "仍只处理第一项" },
    readThroughSeq: throughSeq,
  });
  assert.equal(revised.revisionApplied, true);
  assert.equal(revised.draft.requestedReadThroughSeq, throughSeq);
  const prepared = await f.runtime.callTool(f.ctx, "qq_draft", {
    action: "prepare",
    draftId: revised.draft.draftId,
    expectedVersion: revised.draft.version,
  });
  const sent = await send(f, prepared.draft, {
    token: prepared.preparation.token,
    decision: "continue",
  });
  assert.equal(sent.actionResult, "sent");
  assert.deepEqual(sent.readCheckpoint, { throughSeq, applied: true });
  assert.deepEqual(
    processingPending(f.runtime, f.ctx).map(({ id }) => id),
    [pendingId],
  );
});

for (const modified of [false, true])
  test(
    "a frozen checkpoint rechecks input already processed in this turn, modified=" +
      modified,
    async (t) => {
      const f = make(t);
      await f.runtime.ingest("qq-0", raw(1, { message: "原始的合成输入" }));
      const [{ id, seq: throughSeq }] = (
        await f.runtime.callTool(f.ctx, "conversation_read", {})
      ).items;
      const started = await f.runtime.callTool(f.ctx, "qq_send", {
        requestId: "checkpoint-already-processed",
        text: "待核对的合成答复",
        readThroughSeq: throughSeq,
      });
      assert.equal(started.preparation.state, "ready");
      if (modified) {
        f.mem.db
          .prepare("UPDATE events SET body=? WHERE id=?")
          .run("同位置修改后的合成输入", id);
        await f.runtime.callTool(f.ctx, "conversation_read", {});
      }
      await f.runtime.callTool(f.ctx, "qq_mark_read", { throughSeq });
      const ref = {
        draftId: started.draft.draftId,
        expectedVersion: started.draft.version,
      };
      const prepared = await f.runtime.callTool(f.ctx, "qq_draft", {
        ...ref,
        action: "prepare",
      });
      if (modified) {
        assert.equal(prepared.preparation.state, "blocked");
        assert.equal(prepared.preparation.token, undefined);
        assert.equal(
          f.mem.delivery(started.draft.items[0].requestId),
          undefined,
        );
        const edited = await f.runtime.callTool(f.ctx, "qq_draft", {
          ...ref,
          action: "revise",
          position: 0,
          input: { text: "不再沿用旧水位" },
          readThroughSeq: throughSeq + 1,
        });
        assert.equal(edited.revisionApplied, true);
        assert.equal(edited.preparation.state, "blocked");
        assert.equal(edited.draft.requestedReadThroughSeq, undefined);
        const noCheckpoint = await prepare(f, edited.draft);
        assert.equal(noCheckpoint.state, "ready");
        assert.equal(noCheckpoint.readThroughSeq, undefined);
        assert.equal(f.runtime.transports.get("qq-0").sent.length, 0);
        return;
      }
      assert.equal(prepared.preparation.state, "ready");
      const sent = await send(f, prepared.draft, {
        token: prepared.preparation.token,
        decision: "continue",
      });
      assert.equal(sent.actionResult, "sent");
      assert.deepEqual(sent.readCheckpoint, { throughSeq, applied: true });
    },
  );

test("one burst owns the full draft while active and its used token cannot reclaim a stopped tail", async (t) => {
  const f = make(t);
  await f.runtime.ingest("qq-0", raw(1, { message: "先核对" }));
  const first = await f.runtime.callTool(f.ctx, "qq_send_burst", {
    requestId: "whole-manifest",
    messages: ["第一条", "尾条"],
    gapMs: 0,
  });
  assert.equal(first.actionResult, "not_sent");
  const sibling = await prepare(f, first.draft);
  assert.notEqual(sibling.token, first.preparation.token);
  const review = { token: first.preparation.token, decision: "continue" };
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
  assert.equal(stopped.actionResult, "partially_sent");
  assert.equal(stopped.preparation.reason, "NEW_INPUT");
  assert.deepEqual(
    stopped.draft.items.map(({ status }) => status),
    ["sent", "unsubmitted"],
  );
  const replay = await send(f, first.draft, review);
  assert.equal(replay.status, "stopped");
  assert.equal(replay.preparation, undefined);
  assert.equal(replay.attemptedThisCall, false);
  assert.deepEqual(replay.draft.items, stopped.draft.items);
  assert.equal(gateway.sent.length, 1);
  assert.notEqual(stopped.preparation.token, review.token);
  const staleSibling = await send(f, first.draft, {
    token: sibling.token,
    decision: "continue",
  });
  assert.equal(staleSibling.actionResult, "not_sent");
  assert.equal(staleSibling.preparation.reason, "DRAFT_CHANGED");
  assert.equal(gateway.sent.length, 1);
  const sent = await send(f, stopped.draft, {
    token: stopped.preparation.token,
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

test("draft results distinguish missing input, waiting for confirmation and a tone rejection", async (t) => {
  const f = make(t);
  const gateway = f.runtime.transports.get("qq-0");
  const call = (name, args) => f.runtime.callTool(f.ctx, name, args);
  await f.runtime.ingest("qq-0", raw(1, { message: "夹具来信" }));
  await assert.rejects(
    call("qq_send", {
      requestId: "unseen-watermark",
      text: "夹具回复",
      readThroughSeq: 1000000,
    }),
    (error) => {
      const result = safeToolFailure(error);
      assert.equal(result.code, "UNSEEN_WATERMARK");
      assert.equal(result.readCheckpoint.readThroughSeq, 0);
      assert.deepEqual(result.readCheckpoint.readGap, {
        tool: "conversation_read",
        afterSeq: 0,
      });
      return true;
    },
  );
  assert.equal((await call("qq_draft", { action: "list" })).items.length, 0);
  await call("conversation_read", {});
  const makeDraft = (requestId) =>
    call("qq_send", {
      requestId,
      text: "总结一下，夹具回复",
      inputReview: { token: "0".repeat(64), decision: "continue" },
    });
  const first = await makeDraft("first");
  const latest = await makeDraft("latest");
  assert.deepEqual(latest.draftRefs, [
    { draftId: first.draft.draftId, version: first.draft.version },
  ]);
  assert.equal(latest.preparation.state, "ready");
  assert.deepEqual(latest.preparation.items, []);
  assert.match(latest.preparation.hint, /没有新增待展示材料。待你决定/);
  assert.equal(gateway.sent.length, 0);
  const submit = ({ draft, preparation }) =>
    call("qq_draft", {
      action: "continue",
      draftId: draft.draftId,
      expectedVersion: draft.version,
      inputReview: { token: preparation.token, decision: "continue" },
    });
  const stopped = await submit(latest);
  assert.equal(stopped.error, "TONE_REVIEW_SUGGESTED");
  assert.equal(stopped.actionResult, "not_sent");
  assert.equal(stopped.draft.version, latest.draft.version);
  assert.match(stopped.hint, /qq_draft revise/);
  assert.equal(gateway.sent.length, 0);
  const revised = await call("qq_draft", {
    action: "revise",
    draftId: latest.draft.draftId,
    expectedVersion: latest.draft.version,
    position: 0,
    input: { text: "夹具回复，收到。" },
  });
  assert.equal(gateway.sent.length, 0);
  assert.equal((await submit(revised)).status, "sent");
  assert.equal(gateway.sent.length, 1);
  assert.deepEqual(
    (await call("qq_draft", { action: "list" })).items.map((x) => x.draftId),
    [first.draft.draftId],
  );
});
