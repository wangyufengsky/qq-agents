import test from "node:test";
import assert from "node:assert/strict";
import { config, fixture, context, raw, settle } from "./helpers.mjs";
import { validateConfig } from "../src/core/config.mjs";
import { OneBot, normalizeEvent } from "../src/transport/onebot.mjs";
import { dispatchTool } from "../src/tools/index.mjs";
import { scopedCatalog } from "../src/tools/catalog.mjs";
import { humanInput } from "../src/core/input-progress.mjs";
import { classifyError } from "../src/core/diagnostics.mjs";

function setup(t, options = {}) {
  const cfg = config(2);
  cfg.agents[0].behavior.actions = { react: true, reactMaxPerMinute: 3 };
  cfg.agents[0].tools.push("qq_react");
  const f = fixture(t, { cfg: validateConfig(cfg), ...options });
  const calls = [];
  f.runtime.transports.get("qq-0").react = async (messageId, faceId) => {
    calls.push({ messageId, faceId });
    return { confirmed: true };
  };
  return { ...f, calls, ctx: context(f.runtime), mem: f.store.bind("agent-0") };
}
function target(f, id = "50000", extra = {}) {
  return f.mem.append({
    dedupe: "target:" + id,
    connectionId: "qq-0",
    conversation: "group:20000",
    kind: "message.received",
    direction: "in",
    senderId: "30000",
    messageId: id,
    body: "一条已知消息",
    payload: { trustedInput: true, messageNamespace: "onebot" },
    ...extra,
  });
}
const call = (f, args, ctx = f.ctx) =>
  f.runtime.callTool(ctx, "qq_react", args);
const args = (requestId, messageRef = "50000", faceId = "28") => ({
  requestId,
  messageRef,
  faceId,
});
const reaction = (extra = {}) => ({
  post_type: "notice",
  notice_type: "group_msg_emoji_like",
  self_id: 10000,
  group_id: 20000,
  user_id: 30000,
  message_id: 50000,
  time: 1800000000,
  likes: [{ emoji_id: "28", count: 1 }],
  is_add: true,
  ...extra,
});

test("reaction config defaults off and hidden, execution rejects stale catalogues", async (t) => {
  const cfg = config(1);
  cfg.agents[0].tools.push("qq_react");
  const { runtime } = fixture(t, { cfg }),
    a = runtime.agent("agent-0"),
    ctx = context(runtime);
  assert.equal(a.behavior.actions.react, false);
  assert.equal(a.behavior.actions.reactMaxPerMinute, 3);
  assert(!runtime.toolsFor(a, ctx.conversation).includes("qq_react"));
  ctx.allowedTools = [...runtime.toolsFor(a, ctx.conversation), "qq_react"];
  assert.throws(
    () => scopedCatalog(runtime, ctx, { names: ["qq_react"] }),
    /TOOL_DISABLED/,
  );
  await assert.rejects(
    runtime.callTool(ctx, "qq_react", args("disabled")),
    /TOOL_DISABLED/,
  );
  await assert.rejects(
    dispatchTool(runtime, ctx, "qq_react", args("direct-disabled")),
    /TOOL_DISABLED/,
  );
  a.behavior.actions.react = true;
  assert(runtime.toolsFor(a, ctx.conversation).includes("qq_react"));
  assert(!runtime.toolsFor(a, "@subject").includes("qq_react"));
});

test("tool schema is strict and rejects caller-provided conversation or sender", async (t) => {
  const f = setup(t);
  target(f);
  for (const supplied of [
    { conversation: "group:20001" },
    { agentId: "agent-1" },
    { userId: "30001" },
  ])
    await assert.rejects(
      call(f, { ...args("invalid"), ...supplied }),
      /Unrecognized key/,
    );
  assert.equal(f.calls.length, 0);
});

test("only current-chat message records and wire IDs resolve, and only known standard faces send", async (t) => {
  const f = setup(t),
    current = target(f);
  const foreign = target(f, "50001", { conversation: "group:20001" });
  const otherRole = f.store.bind("agent-1").append({
    dedupe: "other",
    connectionId: "qq-1",
    conversation: "group:20000",
    kind: "message.received",
    messageId: "50002",
    body: "另一个角色",
  });
  for (const reference of [
    foreign.id,
    "50001",
    otherRole.id,
    "50002",
    "never-observed",
  ])
    await assert.rejects(
      call(f, args("foreign:" + reference, reference)),
      /REACT_UNKNOWN_MESSAGE/,
    );
  await assert.rejects(
    call(f, args("face", current.id, "999999")),
    /REACT_FACE_UNKNOWN/,
  );
  const first = await call(f, args("record", current.id, "028"));
  assert.equal(first.actionConfirmed, true);
  assert.equal((await call(f, args("wire", "50000", "5"))).status, "sent");
  assert.deepEqual(f.calls, [
    { messageId: "50000", faceId: "28" },
    { messageId: "50000", faceId: "5" },
  ]);
});

test("reaction has an action receipt and idempotency while exhausted text budget remains exhausted", async (t) => {
  const f = setup(t);
  target(f);
  const limit = f.runtime.agent("agent-0").maxConsecutiveSends;
  f.mem.setState(f.ctx.conversation, {
    replyBatchSends: limit,
    lastAiReplyAt: 1234,
  });
  const result = await call(f, args("once"));
  assert.equal(result.actionConfirmed, true);
  assert.equal(f.mem.delivery("once").status, "sent");
  const receipt = f.mem.readRecord({ id: result.recordId });
  assert.equal(receipt.type, "action.confirmed");
  assert.equal(
    JSON.parse(
      f.mem.db
        .prepare("SELECT payload FROM events WHERE id=?")
        .get(result.recordId).payload,
    ).actionKind,
    "react",
  );
  assert.equal(receipt.body, "[贴表情:憨笑]");
  assert.equal(f.ctx.sendCount, 0);
  assert.equal(f.ctx.confirmedSends, 0);
  assert.equal(f.mem.state(f.ctx.conversation).replyBatchSends, limit);
  assert.equal(f.mem.state(f.ctx.conversation).lastAiReplyAt, 1234);
  assert.equal((await call(f, args("once"))).duplicate, true);
  assert.equal(f.calls.length, 1);
  await assert.rejects(
    f.runtime.send(f.ctx, { requestId: "still-no-text", text: "一句话" }),
    /REPLY_BURST_LIMIT/,
  );
  await assert.rejects(
    call(f, args("once", "50000", "5")),
    /IDEMPOTENCY_CONFLICT/,
  );
});

test("reaction quota is shared across chats, counts failures, and expires without replenishing text", async (t) => {
  const f = setup(t);
  target(f);
  target(f, "50001", { conversation: "group:20001" });
  await call(f, args("a"));
  await call(
    f,
    args("b", "50001"),
    context(f.runtime, "agent-0", "group:20001"),
  );
  f.runtime.transports.get("qq-0").react = async () => {
    throw Error("ONEBOT_REJECTED");
  };
  await assert.rejects(call(f, args("c", "50000", "5")), /DELIVERY_FAILED/);
  await assert.rejects(
    call(f, args("limit", "50000", "4")),
    /REACT_RATE_LIMITED/,
  );
  assert.equal(f.mem.delivery("limit"), undefined);
  const at = Date.now() + 61000;
  f.runtime.clock = () => new Date(at);
  f.runtime.transports.get("qq-0").react = async () => ({ confirmed: true });
  assert.equal(
    (await call(f, args("next-minute", "50000", "4"))).status,
    "sent",
  );
});

test("reactions continue to obey role total limits, pause, silence and revoked switches", async (t) => {
  const f = setup(t);
  target(f);
  f.runtime.agent("agent-0").behavior.maxSendPerMinute = 1;
  await call(f, args("first"));
  await assert.rejects(
    call(f, args("global-limit", "50000", "5")),
    /SEND_RATE_LIMIT/,
  );
  const g = setup(t);
  target(g);
  g.mem.setState(g.ctx.conversation, { silenceUntil: g.runtime.now() + 60000 });
  await assert.rejects(call(g, args("silenced")), /CONVERSATION_SILENCED/);
  g.mem.setState(g.ctx.conversation, { silenceUntil: 0 });
  g.runtime.agent("agent-0").behavior.actions.react = false;
  await assert.rejects(call(g, args("revoked")), /TOOL_DISABLED/);
  g.runtime.agent("agent-0").behavior.actions.react = true;
  await g.runtime.pause("all", true);
  await assert.rejects(call(g, args("paused")), /PAUSED/);
  assert.equal(g.calls.length, 0);
});

test("queued reactions recheck permission before reserving an action", async (t) => {
  const f = setup(t);
  target(f);
  let finish;
  f.runtime.transports.get("qq-0").react = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const first = call(f, args("running"));
  const queued = call(f, args("queued", "50000", "5"));
  f.runtime.agent("agent-0").behavior.actions.react = false;
  finish({ confirmed: true });
  assert.equal((await first).status, "sent");
  await assert.rejects(queued, /TOOL_DISABLED/);
  assert.equal(f.mem.delivery("queued"), undefined);
});

test("unknown same-message same-face actions cannot be replayed under a fresh ID or context", async (t) => {
  const f = setup(t);
  const source = target(f);
  f.runtime.transports.get("qq-0").react = async () => {
    throw Object.assign(Error("ONEBOT_REJECTED"), {
      reason: "GATEWAY_TIMEOUT",
    });
  };
  await assert.rejects(call(f, args("unknown")), /DELIVERY_UNKNOWN/);
  assert.equal(f.mem.delivery("unknown").status, "unknown");
  await assert.rejects(
    call(f, args("unknown")),
    /DELIVERY_ALREADY_ATTEMPTED_UNKNOWN/,
  );
  await assert.rejects(
    call(f, args("new-id", source.id), context(f.runtime)),
    /REACT_ALREADY_ATTEMPTED/,
  );
  assert.equal(f.mem.delivery("new-id"), undefined);
  // Historical imports may retain two original observations of one wire ID.
  // An exact UUID must not turn that into permission to replay an unknown action.
  const duplicate = target(f, "50001", {
    dedupe: "same-wire-observation",
    kind: "message.sent",
    direction: "out",
    senderId: "10000",
  });
  f.mem.db
    .prepare("UPDATE events SET message_id=? WHERE id=?")
    .run("50000", duplicate.id);
  assert.notEqual(duplicate.id, source.id);
  await assert.rejects(
    call(f, args("another-observation", duplicate.id), context(f.runtime)),
    /REACT_ALREADY_ATTEMPTED/,
  );
});

test("unsupported gateway errors stay failed rather than unknown, without leaking provider text", async (t) => {
  const f = setup(t);
  target(f);
  f.runtime.transports.get("qq-0").react = async () => {
    throw Object.assign(Error("ONEBOT_REJECTED"), {
      reason: "ACTION_UNSUPPORTED",
    });
  };
  await assert.rejects(call(f, args("unsupported")), /REACT_UNSUPPORTED/);
  assert.equal(f.mem.delivery("unsupported").status, "failed");
  assert.equal(
    classifyError(Error("REACT_UNSUPPORTED")).code,
    "REACT_UNSUPPORTED",
  );
  const seen = [];
  const bot = new OneBot(config(1).connections[0], {
    fetchImpl: async (url, options) => {
      seen.push({ url: String(url), body: JSON.parse(options.body) });
      return Response.json({
        status: "ok",
        retcode: 0,
        data: { result: true },
      });
    },
  });
  assert.deepEqual(await bot.react("50000", "28"), { confirmed: true });
  assert.deepEqual(seen[0].body, {
    message_id: "50000",
    emoji_id: "28",
    set: true,
  });
  assert(seen[0].url.endsWith("/set_msg_emoji_like"));
  const rejected = new OneBot(config(1).connections[0], {
    fetchImpl: async () =>
      Response.json({ status: "ok", retcode: 0, data: { result: false } }),
  });
  await assert.rejects(rejected.react("50000", "28"), /ONEBOT_REJECTED/);
  const unavailable = new OneBot(config(1).connections[0], {
    fetchImpl: async () =>
      Response.json({
        status: "failed",
        retcode: 1404,
        message: "unsupported action; private provider data",
      }),
  });
  const error = await unavailable.react("50000", "28").catch((e) => e);
  assert.equal(error.reason, "ACTION_UNSUPPORTED");
  assert.doesNotMatch(JSON.stringify(error), /private provider data/);
});

test("NapCat reaction notices normalize added/removed facts without using the target as their identity", () => {
  const connection = config(1).connections[0];
  const e = normalizeEvent(reaction(), connection);
  assert.equal(e.kind, "notice.reaction");
  assert.equal(e.messageId, null);
  assert.equal(e.reaction.messageId, "50000");
  assert.equal(e.body, "[贴表情] QQ:30000 → 消息 50000：憨笑");
  assert.match(
    normalizeEvent(reaction({ is_add: false }), connection).body,
    /^\[取消贴表情\]/,
  );
  assert.match(
    normalizeEvent(reaction({ likes: [{ emoji_id: "999999" }] }), connection)
      .body,
    /未知表情 999999/,
  );
  for (const extra of [
    { is_add: "true" },
    { likes: [] },
    { likes: [{ emoji_id: "invalid" }] },
    { message_id: null },
  ])
    assert.equal(normalizeEvent(reaction(extra), connection), null);
});

test("only reactions on this role's own scoped messages are archived, without new input or wakeups", async (t) => {
  let runs = 0,
    latestPrompt = "";
  const f = setup(t, {
    run: async (p) => {
      runs++;
      latestPrompt = p.prompt;
    },
  });
  target(f, "50000", { direction: "out", senderId: "10000" });
  target(f, "50001");
  target(f, "50002", {
    conversation: "group:20001",
    direction: "out",
    senderId: "10000",
  });
  f.mem.setState("group:20000", {
    lastReceivedSeq: 2,
    lastIncomingAt: 1234,
    replyBatchSends: 3,
    readThroughSeq: 2,
  });
  f.mem.setState("@subject", { lastActivitySeq: 2 });
  const before = f.mem.state("group:20000");
  const subject = f.mem.state("@subject");
  let notifications = 0;
  f.runtime.conversations.notify = () => {
    notifications++;
  };
  await f.runtime.ingest("qq-0", reaction());
  await f.runtime.ingest("qq-0", reaction());
  await f.runtime.ingest(
    "qq-0",
    reaction({ likes: [{ emoji_id: "5", count: 1 }] }),
  );
  await f.runtime.ingest("qq-0", reaction({ is_add: false }));
  await f.runtime.ingest("qq-0", reaction({ message_id: 50001 }));
  await f.runtime.ingest("qq-0", reaction({ message_id: 50002 }));
  await f.runtime.ingest("qq-0", reaction({ message_id: 59999 }));
  await settle(f.runtime);
  assert.equal(runs, 0);
  assert.equal(notifications, 0);
  assert.deepEqual(f.mem.state("group:20000"), before);
  assert.deepEqual(f.mem.state("@subject"), subject);
  const observations = f.mem.search({ kind: "notice.reaction" }).items;
  assert.equal(observations.length, 3);
  assert.equal(humanInput(f.runtime, f.ctx, observations[0].id), null);
  const page = await f.runtime.callTool(f.ctx, "conversation_read", {
    afterSeq: Math.min(...observations.map((item) => item.seq)) - 1,
  });
  assert(page.items.some((item) => item.type === "notice.reaction"));
  assert.equal(f.mem.state("group:20000").replyBatchSends, 3);
  assert.equal(
    f.runtime.conversations.reason(
      f.runtime.agent("agent-0"),
      normalizeEvent(reaction(), config(1).connections[0]),
      "10000",
    ),
    null,
  );
  await f.runtime.ingest("qq-0", raw(60000));
  await settle(f.runtime);
  assert.equal(runs, 1);
  assert.match(latestPrompt, /贴表情/);
  assert.match(latestPrompt, /取消贴表情/);
});

test("reaction preserves selected intention state and retains intent-only and recovery fences", async (t) => {
  const f = setup(t);
  target(f);
  f.ctx.intentOnly = true;
  await assert.rejects(call(f, args("no-intent")), /INTENT_DECISION_REQUIRED/);
  f.ctx.intentOnly = false;
  f.ctx.recoveryDeliveryBlocked = true;
  await assert.rejects(call(f, args("recovery")), /RECOVERY_DELIVERY_BLOCKED/);
  f.ctx.recoveryDeliveryBlocked = false;
  let checked = 0,
    completed = 0,
    reserved = 0;
  f.runtime.subject.beforeDelivery = () => {
    checked++;
    return { id: "selected-intent" };
  };
  f.runtime.subject.delivered = () => {
    completed++;
  };
  f.runtime.subject.reserveContact = () => {
    reserved++;
  };
  const result = await call(f, args("reaction-only"));
  assert.equal(result.actionConfirmed, true);
  assert.equal(checked, 1);
  assert.equal(completed, 0);
  assert.equal(reserved, 0);
  assert.equal(f.mem.delivery("intent:selected-intent"), undefined);
  assert.equal(f.mem.delivery("reaction-only").status, "sent");
});

test("queued reaction uses the latest per-minute quota", async (t) => {
  const f = setup(t);
  target(f);
  let finish;
  f.runtime.transports.get("qq-0").react = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const first = call(f, args("first-quota"));
  const queued = call(f, args("queued-quota", "50000", "5"));
  f.runtime.agent("agent-0").behavior.actions.reactMaxPerMinute = 1;
  finish({ confirmed: true });
  await first;
  await assert.rejects(queued, /REACT_RATE_LIMITED/);
  assert.equal(f.mem.delivery("queued-quota"), undefined);
});

test("signed OneBot message IDs remain valid reaction targets and observations", async (t) => {
  const f = setup(t);
  target(f, "-50000", { direction: "out", senderId: "10000" });
  assert.equal((await call(f, args("negative-id", "-50000"))).status, "sent");
  assert.deepEqual(f.calls, [{ messageId: "-50000", faceId: "28" }]);
  const notice = reaction({ message_id: -50000 });
  assert.equal(
    normalizeEvent(notice, config(1).connections[0]).reaction.messageId,
    "-50000",
  );
  await f.runtime.ingest("qq-0", notice);
  const observations = f.mem.search({ kind: "notice.reaction" }).items;
  assert.equal(observations.length, 1);
  assert.match(observations[0].body, /消息 -50000/);
});
