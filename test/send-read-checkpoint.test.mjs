import test from "node:test";
import assert from "node:assert/strict";
import { fixture, config, context } from "./helpers.mjs";
import { TOOL_NAMES, toolSpecs } from "../src/tools/index.mjs";
import { stableInstructions } from "../src/core/prompts.mjs";

function setup(t) {
  const cfg = config(1);
  cfg.agents[0].tools = TOOL_NAMES;
  return fixture(t, { cfg, run: async () => {} });
}

async function showIncoming(runtime, mem, ctx, dedupe) {
  const row = mem.append({
    dedupe,
    conversation: ctx.conversation,
    direction: "in",
    senderId: "30000",
    kind: "message.received",
    body: "请继续。",
  });
  const page = await runtime.callTool(ctx, "conversation_read", {});
  assert.equal(page.readThroughSeq, row.seq);
  return row.seq;
}

test("qq_send accepts the optional continuous read checkpoint and teaches its safe use", (t) => {
  const { runtime, store } = setup(t),
    agent = runtime.agent("agent-0"),
    self = store.bind(agent.id).identity.current(),
    send = toolSpecs(["qq_send"])[0],
    instructions = stableInstructions(
      agent,
      self,
      false,
      {},
      {
        toolNames: ["qq_send", "qq_mark_read"],
      },
    ),
    sendOnlyInstructions = stableInstructions(
      agent,
      self,
      false,
      {},
      {
        toolNames: ["qq_send"],
      },
    );

  assert.equal(send.inputSchema.properties.readThroughSeq.type, "integer");
  assert(!send.inputSchema.required.includes("readThroughSeq"));
  assert.match(instructions, /qq_send\.readThroughSeq/);
  assert.match(instructions, /发送期间新到的消息顺带标为已读/);
  assert.doesNotMatch(sendOnlyInstructions, /qq_send\.readThroughSeq/);
});

test("qq_send validates unseen and non-integer checkpoints before delivery", async (t) => {
  const { runtime, store } = setup(t),
    ctx = context(runtime),
    mem = store.bind(ctx.agentId),
    shown = await showIncoming(runtime, mem, ctx, "initial");
  const transport = runtime.transports.get("qq-0");

  await assert.rejects(
    runtime.callTool(ctx, "qq_send", {
      requestId: "unseen",
      text: "收到。",
      readThroughSeq: shown + 1,
    }),
    /UNSEEN_WATERMARK/,
  );
  await assert.rejects(
    runtime.callTool(ctx, "qq_send", {
      requestId: "fractional",
      text: "收到。",
      readThroughSeq: shown + 0.5,
    }),
  );
  assert.equal(transport.sent.length, 0);
  assert.equal(mem.delivery("unseen"), undefined);
  assert.equal(mem.delivery("fractional"), undefined);
  assert.equal(mem.state(ctx.conversation).readThroughSeq || 0, 0);
  ctx.shownSeq = undefined;
  await assert.rejects(
    runtime.callTool(ctx, "qq_send", {
      requestId: "missing-visible-proof",
      text: "收到。",
      readThroughSeq: 0,
    }),
    /UNSEEN_WATERMARK/,
  );
  assert.equal(transport.sent.length, 0);
});

test("qq_send rejects a checkpoint before delivery when qq_mark_read is disabled", async (t) => {
  const { runtime, store } = setup(t),
    ctx = context(runtime),
    mem = store.bind(ctx.agentId),
    shown = await showIncoming(runtime, mem, ctx, "read-tool-disabled"),
    transport = runtime.transports.get("qq-0");

  runtime.config.agents[0].tools = runtime.config.agents[0].tools.filter(
    (name) => name !== "qq_mark_read",
  );
  await assert.rejects(
    runtime.callTool(ctx, "qq_send", {
      requestId: "denied-checkpoint",
      text: "收到。",
      readThroughSeq: shown,
    }),
    /TOOL_NOT_ALLOWED/,
  );
  assert.equal(transport.sent.length, 0);
  assert.equal(mem.delivery("denied-checkpoint"), undefined);
  assert.equal(mem.state(ctx.conversation).readThroughSeq || 0, 0);
  assert.equal(
    Object.hasOwn(
      mem.state(ctx.conversation).readCheckpointReceipts || {},
      "denied-checkpoint",
    ),
    false,
  );
});

test("omitting readThroughSeq preserves qq_send's existing read behavior", async (t) => {
  const { runtime, store } = setup(t),
    ctx = context(runtime),
    mem = store.bind(ctx.agentId);
  await showIncoming(runtime, mem, ctx, "without-checkpoint");

  const receipt = await runtime.callTool(ctx, "qq_send", {
    requestId: "legacy-send",
    text: "收到。",
  });
  assert.equal(receipt.status, "sent");
  assert.equal(receipt.readCheckpoint, undefined);
  assert.equal(mem.state(ctx.conversation).readThroughSeq || 0, 0);
  assert.equal(runtime.transports.get("qq-0").sent.length, 1);
});

test("a selected proactive intent cannot bind a checkpoint to its rewritten delivery request", async (t) => {
  const { runtime, store } = setup(t),
    ctx = context(runtime),
    mem = store.bind(ctx.agentId),
    shown = await showIncoming(runtime, mem, ctx, "intent-boundary");
  ctx.activeIntentId = "synthetic-selected-intent";
  await assert.rejects(
    runtime.callTool(ctx, "qq_send", {
      requestId: "model-request",
      text: "收到。",
      readThroughSeq: shown,
    }),
    /TOOL_NOT_ALLOWED/,
  );
  assert.equal(runtime.transports.get("qq-0").sent.length, 0);
  assert.equal(mem.state(ctx.conversation).readThroughSeq || 0, 0);
});

test("prototype-named request IDs without checkpoint history cannot acquire a watermark on retry", async (t) => {
  const { runtime, store } = setup(t),
    ctx = context(runtime),
    mem = store.bind(ctx.agentId),
    shown = await showIncoming(runtime, mem, ctx, "prototype-ids");

  for (const requestId of ["__proto__", "toString"]) {
    await runtime.send(ctx, { requestId, text: "收到。" });
    const duplicate = await runtime.callTool(ctx, "qq_send", {
      requestId,
      text: "收到。",
      readThroughSeq: shown,
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(
      Object.hasOwn(
        mem.state(ctx.conversation).readCheckpointReceipts || {},
        requestId,
      ),
      false,
    );
    assert.equal(mem.state(ctx.conversation).readThroughSeq || 0, 0);
  }
  assert.equal(runtime.transports.get("qq-0").sent.length, 2);
});

test("a sent receipt with no retained checkpoint cannot acquire one after receipt history is capped", async (t) => {
  const { runtime, store } = setup(t),
    ctx = context(runtime),
    mem = store.bind(ctx.agentId),
    shown = await showIncoming(runtime, mem, ctx, "capped-history"),
    requestId = "older-sent";
  await runtime.send(ctx, { requestId, text: "收到。" });
  const state = mem.state(ctx.conversation);
  state.readCheckpointReceipts = Object.fromEntries(
    Array.from({ length: 100 }, (_, index) => [
      "retained-" + index,
      { throughSeq: shown, shownSeq: shown },
    ]),
  );
  mem.setState(ctx.conversation, state);

  const duplicate = await runtime.callTool(ctx, "qq_send", {
    requestId,
    text: "收到。",
    readThroughSeq: shown,
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(
    Object.hasOwn(
      mem.state(ctx.conversation).readCheckpointReceipts,
      requestId,
    ),
    false,
  );
  assert.equal(mem.state(ctx.conversation).readThroughSeq || 0, 0);
  assert.equal(runtime.transports.get("qq-0").sent.length, 1);

  const fresh = await runtime.callTool(ctx, "qq_send", {
    requestId: "fresh-after-cap",
    text: "已读。",
    readThroughSeq: shown,
  });
  assert.equal(fresh.status, "sent");
  const receipts = mem.state(ctx.conversation).readCheckpointReceipts;
  assert.equal(Object.keys(receipts).length, 100);
  assert.equal(Object.hasOwn(receipts, "retained-0"), false);
  assert.equal(Object.hasOwn(receipts, "fresh-after-cap"), true);
});

test("qq_send saves only the supplied checkpoint after confirmation and never absorbs a later message", async (t) => {
  const { runtime, store } = setup(t),
    ctx = context(runtime),
    mem = store.bind(ctx.agentId),
    shown = await showIncoming(runtime, mem, ctx, "first");
  const transport = runtime.transports.get("qq-0"),
    started = Promise.withResolvers(),
    gate = Promise.withResolvers(),
    send = transport.send.bind(transport);
  transport.send = async (...args) => {
    started.resolve();
    await gate.promise;
    return send(...args);
  };

  const sending = runtime.callTool(ctx, "qq_send", {
    requestId: "checkpointed",
    text: "收到。",
    readThroughSeq: shown,
  });
  await started.promise;
  assert.equal(mem.state(ctx.conversation).readThroughSeq || 0, 0);
  const later = mem.append({
    dedupe: "later",
    conversation: ctx.conversation,
    direction: "in",
    senderId: "30000",
    kind: "message.received",
    body: "还有一条。",
  });
  gate.resolve();

  const receipt = await sending;
  assert.equal(receipt.status, "sent");
  assert.deepEqual(receipt.readCheckpoint, {
    throughSeq: shown,
    applied: true,
  });
  assert.equal(mem.state(ctx.conversation).readThroughSeq, shown);
  assert(later.seq > shown);
  assert.equal(transport.sent.length, 1);

  const duplicate = await runtime.callTool(ctx, "qq_send", {
    requestId: "checkpointed",
    text: "收到。",
    readThroughSeq: shown,
  });
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(duplicate.readCheckpoint, {
    throughSeq: shown,
    applied: true,
  });
  assert.equal(transport.sent.length, 1);
});

test("failed, unknown, and pending deliveries do not advance the read checkpoint", async (t) => {
  for (const [failure, expected] of [
    ["ONEBOT_REJECTED", /DELIVERY_FAILED/],
    ["GATEWAY_TIMEOUT", /DELIVERY_UNKNOWN/],
  ]) {
    const { runtime, store } = setup(t),
      ctx = context(runtime),
      mem = store.bind(ctx.agentId),
      shown = await showIncoming(runtime, mem, ctx, failure),
      transport = runtime.transports.get("qq-0");
    transport.failure = failure;
    await assert.rejects(
      runtime.callTool(ctx, "qq_send", {
        requestId: failure,
        text: "收到。",
        readThroughSeq: shown,
      }),
      expected,
    );
    assert.equal(mem.state(ctx.conversation).readThroughSeq || 0, 0);
  }

  const { runtime, store } = setup(t),
    ctx = context(runtime),
    mem = store.bind(ctx.agentId),
    shown = await showIncoming(runtime, mem, ctx, "pending"),
    transport = runtime.transports.get("qq-0"),
    started = Promise.withResolvers(),
    gate = Promise.withResolvers(),
    send = transport.send.bind(transport);
  transport.send = async (...args) => {
    started.resolve();
    await gate.promise;
    return send(...args);
  };
  const sending = runtime.callTool(ctx, "qq_send", {
    requestId: "pending",
    text: "收到。",
    readThroughSeq: shown,
  });
  await started.promise;
  assert.equal(mem.delivery("pending").status, "pending");
  assert.equal(mem.state(ctx.conversation).readThroughSeq || 0, 0);
  gate.resolve();
  const receipt = await sending;
  assert.equal(receipt.status, "sent");
  assert.deepEqual(receipt.readCheckpoint, {
    throughSeq: shown,
    applied: true,
  });
  assert.equal(mem.state(ctx.conversation).readThroughSeq, shown);
});

test("a paused sent receipt can only backfill its original checkpoint", async (t) => {
  const { runtime, store } = setup(t),
    ctx = context(runtime),
    mem = store.bind(ctx.agentId),
    original = await showIncoming(runtime, mem, ctx, "original"),
    transport = runtime.transports.get("qq-0"),
    started = Promise.withResolvers(),
    gate = Promise.withResolvers(),
    send = transport.send.bind(transport);
  transport.send = async (...args) => {
    started.resolve();
    await gate.promise;
    return send(...args);
  };

  const sending = runtime.callTool(ctx, "qq_send", {
    requestId: "paused-checkpoint",
    text: "收到。",
    readThroughSeq: original,
  });
  await started.promise;
  ctx.controller.abort();
  const later = mem.append({
    dedupe: "after-send-started",
    conversation: ctx.conversation,
    direction: "in",
    senderId: "30000",
    kind: "message.received",
    body: "后来补充。",
  });
  gate.resolve();

  const receipt = await sending;
  assert.equal(receipt.status, "sent");
  assert.deepEqual(receipt.readCheckpoint, {
    throughSeq: original,
    applied: false,
  });
  assert.equal(mem.state(ctx.conversation).readThroughSeq || 0, 0);

  const resumed = context(runtime);
  const shownAfterResume = await runtime.callTool(
    resumed,
    "conversation_read",
    {},
  );
  assert(shownAfterResume.readThroughSeq >= later.seq);
  const duplicate = await runtime.callTool(resumed, "qq_send", {
    requestId: "paused-checkpoint",
    text: "收到。",
    readThroughSeq: shownAfterResume.readThroughSeq,
  });
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(duplicate.readCheckpoint, {
    throughSeq: original,
    applied: true,
  });
  assert.equal(mem.state(ctx.conversation).readThroughSeq, original);
  assert(later.seq > original);
  assert.equal(transport.sent.length, 1);
});

test("a confirmed send stays successful and its original requestId repairs a failed receipt write", async (t) => {
  const { runtime, store } = setup(t),
    ctx = context(runtime),
    mem = store.bind(ctx.agentId),
    shown = await showIncoming(runtime, mem, ctx, "receipt-write-failure"),
    transport = runtime.transports.get("qq-0"),
    started = Promise.withResolvers(),
    gate = Promise.withResolvers(),
    send = transport.send.bind(transport);
  let failReceiptWrite = false;
  const bind = runtime.memory.bind.bind(runtime.memory);
  runtime.memory.bind = (agentId) => {
    const bound = bind(agentId),
      setState = bound.setState.bind(bound);
    bound.setState = (conversation, state) => {
      if (
        failReceiptWrite &&
        state.readCheckpointReceipts?.recoverable?.sentReceipt === true
      ) {
        failReceiptWrite = false;
        throw Error("SYNTHETIC_RECEIPT_WRITE_FAILURE");
      }
      return setState(conversation, state);
    };
    return bound;
  };
  transport.send = async (...args) => {
    started.resolve();
    await gate.promise;
    return send(...args);
  };

  const sending = runtime.callTool(ctx, "qq_send", {
    requestId: "recoverable",
    text: "收到。",
    readThroughSeq: shown,
  });
  await started.promise;
  failReceiptWrite = true;
  gate.resolve();

  const receipt = await sending;
  assert.equal(receipt.status, "sent");
  assert.deepEqual(receipt.readCheckpoint, {
    throughSeq: shown,
    applied: false,
  });
  assert.equal(mem.delivery("recoverable").status, "sent");
  assert.equal(mem.state(ctx.conversation).readThroughSeq || 0, 0);
  assert.equal(
    mem.state(ctx.conversation).readCheckpointReceipts.recoverable.sentReceipt,
    undefined,
  );

  runtime.config.agents[0].tools = runtime.config.agents[0].tools.filter(
    (name) => name !== "qq_mark_read",
  );
  const duplicate = await runtime.callTool(ctx, "qq_send", {
    requestId: "recoverable",
    text: "收到。",
  });
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(duplicate.readCheckpoint, {
    throughSeq: shown,
    applied: false,
  });
  assert.equal(mem.state(ctx.conversation).readThroughSeq || 0, 0);

  runtime.config.agents[0].tools.push("qq_mark_read");
  const recovered = await runtime.callTool(ctx, "qq_send", {
    requestId: "recoverable",
    text: "收到。",
  });
  assert.equal(recovered.duplicate, true);
  assert.deepEqual(recovered.readCheckpoint, {
    throughSeq: shown,
    applied: true,
  });
  assert.equal(mem.state(ctx.conversation).readThroughSeq, shown);
  assert.equal(
    mem.state(ctx.conversation).readCheckpointReceipts.recoverable.sentReceipt,
    true,
  );
  assert.equal(transport.sent.length, 1);
});

test("in-flight checkpoint intents are isolated between Runtime instances", async (t) => {
  const first = setup(t),
    second = setup(t),
    firstCtx = context(first.runtime),
    secondCtx = context(second.runtime),
    firstMem = first.store.bind(firstCtx.agentId),
    secondMem = second.store.bind(secondCtx.agentId);
  await showIncoming(first.runtime, firstMem, firstCtx, "first-one");
  const firstThrough = await showIncoming(
      first.runtime,
      firstMem,
      firstCtx,
      "first-two",
    ),
    secondThrough = await showIncoming(
      second.runtime,
      secondMem,
      secondCtx,
      "second-one",
    );
  const firstTransport = first.runtime.transports.get("qq-0"),
    secondTransport = second.runtime.transports.get("qq-0"),
    firstStarted = Promise.withResolvers(),
    secondStarted = Promise.withResolvers(),
    firstGate = Promise.withResolvers(),
    secondGate = Promise.withResolvers(),
    firstSend = firstTransport.send.bind(firstTransport),
    secondSend = secondTransport.send.bind(secondTransport);
  firstTransport.send = async (...args) => {
    firstStarted.resolve();
    await firstGate.promise;
    return firstSend(...args);
  };
  secondTransport.send = async (...args) => {
    secondStarted.resolve();
    await secondGate.promise;
    return secondSend(...args);
  };

  const firstSending = first.runtime.callTool(firstCtx, "qq_send", {
    requestId: "same-request",
    text: "收到。",
    readThroughSeq: firstThrough,
  });
  await firstStarted.promise;
  const secondSending = second.runtime.callTool(secondCtx, "qq_send", {
    requestId: "same-request",
    text: "收到。",
    readThroughSeq: secondThrough,
  });
  await secondStarted.promise;
  firstGate.resolve();
  secondGate.resolve();

  const [firstReceipt, secondReceipt] = await Promise.all([
    firstSending,
    secondSending,
  ]);
  assert.deepEqual(firstReceipt.readCheckpoint, {
    throughSeq: firstThrough,
    applied: true,
  });
  assert.deepEqual(secondReceipt.readCheckpoint, {
    throughSeq: secondThrough,
    applied: true,
  });
  assert.equal(
    firstMem.state(firstCtx.conversation).readThroughSeq,
    firstThrough,
  );
  assert.equal(
    secondMem.state(secondCtx.conversation).readThroughSeq,
    secondThrough,
  );
});

test("checkpoint intents require a safe shown sequence that covers the watermark", async (t) => {
  const { runtime, store } = setup(t),
    ctx = context(runtime),
    mem = store.bind(ctx.agentId),
    shown = await showIncoming(runtime, mem, ctx, "invalid-stored-intent");
  const invalidIntents = [
    ["missing-shown", { throughSeq: shown }],
    ["fractional-shown", { throughSeq: shown, shownSeq: shown + 0.5 }],
    ["short-shown", { throughSeq: shown, shownSeq: shown - 1 }],
  ];

  for (const [requestId, intent] of invalidIntents) {
    await runtime.send(ctx, { requestId, text: "收到。" });
    const state = mem.state(ctx.conversation);
    state.readCheckpointReceipts = {
      ...state.readCheckpointReceipts,
      [requestId]: intent,
    };
    mem.setState(ctx.conversation, state);
    const duplicate = await runtime.callTool(ctx, "qq_send", {
      requestId,
      text: "收到。",
      readThroughSeq: shown,
    });
    assert.equal(duplicate.duplicate, true);
    assert.deepEqual(duplicate.readCheckpoint, {
      throughSeq: shown,
      applied: false,
    });
    assert.equal(mem.state(ctx.conversation).readThroughSeq || 0, 0);
  }
});

test("qq_mark_read keeps the existing safe-watermark behavior", async (t) => {
  const { runtime, store } = setup(t),
    ctx = context(runtime),
    mem = store.bind(ctx.agentId),
    shown = await showIncoming(runtime, mem, ctx, "mark-read");

  const result = await runtime.callTool(ctx, "qq_mark_read", {
    throughSeq: shown,
  });
  assert.equal(result.readThroughSeq, shown);
  assert.equal(mem.state(ctx.conversation).readThroughSeq, shown);
  await assert.rejects(
    runtime.callTool(ctx, "qq_mark_read", { throughSeq: shown + 1 }),
    /UNSEEN_WATERMARK/,
  );
});
