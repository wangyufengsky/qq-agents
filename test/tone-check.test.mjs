import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { config, fixture, context } from "./helpers.mjs";
import { checkTone, DEFAULT_TONE_PHRASES } from "../src/core/tone-check.mjs";
import { behaviorSchema } from "../src/core/policy.mjs";
import { safeToolFailure } from "../src/tools/errors.mjs";
import { classifyError } from "../src/core/diagnostics.mjs";
import { FileStore } from "../src/tools/files.mjs";

const warning = async (promise) => {
  const error = await promise.catch((e) => e);
  assert.equal(error.message, "TONE_REVIEW_SUGGESTED");
  return error;
};

test("old behavior config defaults to one tone reminder and validates bounded additions", () => {
  assert.deepEqual(behaviorSchema.parse({}).toneCheck, {
    mode: "warn",
    phrases: [],
    maxLinesCasual: 6,
  });
  for (const toneCheck of [
    { mode: "block" },
    { phrases: [""] },
    { phrases: ["x".repeat(101)] },
    { phrases: Array(51).fill("x") },
    { maxLinesCasual: 0 },
    { maxLinesCasual: 101 },
  ])
    assert.throws(() => behaviorSchema.parse({ toneCheck }));
  const a = config(1).agents[0];
  for (const phrase of DEFAULT_TONE_PHRASES)
    assert.throws(
      () => checkTone({ conversation: "group:20000" }, a, "x", phrase),
      /TONE_REVIEW_SUGGESTED/,
    );
});

test("plain-text review rejects before ledger, budget or network and exposes only matches", async (t) => {
  const cfg = config(1);
  cfg.agents[0].behavior.toneCheck.phrases = ["客套话", "没出现", "总结一下"];
  const { runtime, store } = fixture(t, { cfg }),
    ctx = context(runtime),
    mem = store.bind("agent-0");
  const before = {
    events: mem.export().tables.events,
    deliveries: mem.export().tables.deliveries,
    sendTimes: mem.state(ctx.conversation).sendTimes,
  };
  const error = await warning(
    runtime.send(ctx, {
      requestId: "first",
      text: "私人正文前缀。总**结**一下，客套话。私人正文后缀",
    }),
  );
  assert.deepEqual(safeToolFailure(error).matches, {
    phrases: ["总结一下", "客套话"],
    tooManyLines: false,
  });
  assert.equal(classifyError(error).code, "TONE_REVIEW_SUGGESTED");
  assert.doesNotMatch(
    JSON.stringify(safeToolFailure(error)),
    /私人正文|没出现/,
  );
  assert.equal(mem.delivery("first"), undefined);
  assert.deepEqual(
    {
      events: mem.export().tables.events,
      deliveries: mem.export().tables.deliveries,
      sendTimes: mem.state(ctx.conversation).sendTimes,
    },
    before,
  );
  assert.equal(ctx.pendingDeliveries, undefined);
  assert.equal(runtime.transports.get("qq-0").sent.length, 0);
  assert.doesNotMatch(
    JSON.stringify([...ctx.toneReviews.values()].map((s) => [...s])),
    /私人正文|总结一下/,
  );
  assert.equal(
    safeToolFailure(
      Object.assign(Error("TONE_REVIEW_SUGGESTED"), {
        matches: { phrases: ["forged private text"] },
      }),
    ).matches,
    undefined,
  );
});

test("confirmation needs the same turn, request ID and plain text; edits and other IDs are reviewed", async (t) => {
  const { runtime, store } = fixture(t),
    ctx = context(runtime);
  const args = { requestId: "review", text: "希望对你有帮助，原文" };
  await warning(runtime.send(ctx, args));
  await warning(runtime.send(ctx, { ...args, text: args.text + "改字" }));
  await warning(runtime.send(ctx, { ...args, requestId: "other" }));
  await warning(runtime.send(context(runtime), args));
  assert.equal((await runtime.send(ctx, args)).status, "sent");
  const duplicate = await runtime.send(context(runtime), args);
  assert.equal(duplicate.duplicate, true);
  assert.equal(runtime.transports.get("qq-0").sent.length, 1);
  assert.equal(store.bind("agent-0").delivery(args.requestId).status, "sent");
  await assert.rejects(
    runtime.send(context(runtime), { ...args, text: args.text + "变了" }),
    /IDEMPOTENCY_CONFLICT/,
  );
});

test("owner private chat exempts only line count; group owners and ordinary private chats are reviewed", async (t) => {
  const cfg = config(1);
  cfg.agents[0].ownerIds = ["30000"];
  cfg.agents[0].allow.users.push("30001");
  const { runtime } = fixture(t, { cfg });
  const text = Array.from({ length: 7 }, (_, i) => `第${i + 1}行`).join("\n");
  for (const conversation of ["group:20000", "private:30001"]) {
    const ctx = context(runtime, "agent-0", conversation);
    const e = await warning(
      runtime.send(ctx, { requestId: conversation, text }),
    );
    assert.deepEqual(safeToolFailure(e).matches, {
      phrases: [],
      tooManyLines: true,
    });
  }
  const owner = context(runtime, "agent-0", "private:30000");
  assert.equal(
    (await runtime.send(owner, { requestId: "owner-long", text })).status,
    "sent",
  );
  await warning(
    runtime.send(owner, { requestId: "owner-phrase", text: "作为一个AI" }),
  );
});

test("off and fixed internal deliveries skip review while permissions still apply", async (t) => {
  const cfg = config(1);
  cfg.agents[0].behavior.toneCheck.mode = "off";
  const { runtime } = fixture(t, { cfg }),
    ctx = context(runtime);
  const text = Array(7).fill("综上所述").join("\n");
  assert.equal(
    (await runtime.send(ctx, { requestId: "off", text })).status,
    "sent",
  );
  runtime.agent("agent-0").behavior.toneCheck.mode = "warn";
  const internal = context(runtime);
  internal.internalDelivery = true;
  assert.equal(
    (await runtime.send(internal, { requestId: "internal", text })).status,
    "sent",
  );
  const reviewed = context(runtime);
  await warning(runtime.send(reviewed, { requestId: "pause", text }));
  await runtime.pause("all", true);
  await assert.rejects(
    runtime.send(reviewed, { requestId: "pause", text }),
    /PAUSED/,
  );
  await assert.rejects(
    runtime.send(internal, { requestId: "internal-paused", text }),
    /PAUSED/,
  );
});

test("tone confirmation preserves unknown receipts and recovery fences", async (t) => {
  const { runtime, store } = fixture(t),
    ctx = context(runtime),
    args = { requestId: "unknown-tone", text: "总结一下" };
  await warning(runtime.send(ctx, args));
  runtime.transports.get("qq-0").failure = "TIMEOUT";
  await assert.rejects(runtime.send(ctx, args), /DELIVERY_UNKNOWN/);
  await assert.rejects(
    runtime.send(context(runtime), args),
    /DELIVERY_ALREADY_ATTEMPTED_UNKNOWN/,
  );
  assert.equal(
    store.bind("agent-0").delivery(args.requestId).status,
    "unknown",
  );
  const blocked = context(runtime),
    recovery = { requestId: "recovery", text: "总结一下" };
  blocked.recoveryDeliveryBlocked = true;
  await warning(runtime.send(blocked, recovery));
  await assert.rejects(
    runtime.send(blocked, recovery),
    /RECOVERY_DELIVERY_BLOCKED/,
  );
});

test("a stopped burst reports matches and can confirm unchanged without replaying earlier receipts", async (t) => {
  const cfg = config(1);
  cfg.agents[0].tools.push("qq_send_burst");
  const { runtime, store } = fixture(t, { cfg }),
    ctx = context(runtime);
  const args = {
    requestId: "burst",
    messages: ["先接一句", "我理解你的感受"],
    gapMs: 0,
  };
  const first = await runtime.callTool(ctx, "qq_send_burst", args);
  assert.equal(first.failedIndex, 1);
  assert.deepEqual(first.matches.phrases, ["我理解你的感受"]);
  assert.equal(first.doNotReplay, false);
  assert.equal(first.receipts.length, 1);
  assert.equal(store.bind("agent-0").delivery("burst:1"), undefined);
  const confirmed = await runtime.callTool(ctx, "qq_send_burst", args);
  assert.equal(confirmed.status, "sent");
  assert.equal(confirmed.receipts[0].duplicate, true);
  assert.equal(runtime.transports.get("qq-0").sent.length, 2);
});

test("forward and file tools keep quoted content outside wording review", async (t) => {
  const cfg = config(1);
  cfg.agents[0].tools.push("qq_forward_send", "file_create", "qq_send_file");
  cfg.agents[0].files.enabled = true;
  const { runtime, store, root } = fixture(t, { cfg }),
    ctx = context(runtime),
    mem = store.bind("agent-0"),
    transport = runtime.transports.get("qq-0");
  runtime.files = new FileStore(path.join(root, "files"));
  transport.sendFile = async () => ({ confirmed: true });
  transport.sendForward = async () => ({ messageId: "forward-receipt" });
  const e = mem.append({
    dedupe: "quoted",
    conversation: ctx.conversation,
    connectionId: "qq-0",
    kind: "message.received",
    messageId: "quoted-message",
    senderId: "30000",
    body: "综上所述",
  });
  assert.equal(
    (
      await runtime.callTool(ctx, "qq_forward_send", {
        requestId: "forward",
        eventIds: [e.id],
      })
    ).status,
    "sent",
  );
  const file = await runtime.callTool(ctx, "file_create", {
    name: "总结一下.txt",
    text: "希望对你有帮助",
  });
  assert.equal(
    (
      await runtime.callTool(ctx, "qq_send_file", {
        requestId: "file",
        fileId: file.fileId,
      })
    ).status,
    "sent",
  );
  assert.equal(ctx.toneReviews, undefined);
});
