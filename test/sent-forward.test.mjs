import test from "node:test";
import assert from "node:assert/strict";
import { fixture, config, context } from "./helpers.mjs";
import { TOOL_NAMES } from "../src/tools/index.mjs";

function setup(t) {
  const cfg = config(2);
  cfg.agents.forEach((a) => (a.tools = TOOL_NAMES));
  const f = fixture(t, { cfg }),
    ctx = context(f.runtime),
    mem = f.store.bind("agent-0");
  const source = mem.append({
    dedupe: "source",
    conversation: ctx.conversation,
    connectionId: "qq-0",
    kind: "message.received",
    messageId: "source-message",
    senderId: "30000",
    body: "[转发]",
    payload: { segments: [{ type: "forward", data: { id: "incoming-root" } }] },
  }).id;
  const transport = f.runtime.transports.get("qq-0"),
    calls = [];
  transport.sendForward = async (_, nodes) => {
    calls.push("send");
    assert.deepEqual(nodes, [{ type: "node", data: { id: "source-message" } }]);
    return { messageId: "confirmed-sent-message" };
  };
  transport.call = async (action, args) => {
    assert.equal(action, "get_forward_msg");
    calls.push(args.message_id);
    if (args.message_id === "sent-card-resource")
      throw Error("ONEBOT_REJECTED");
    assert.equal(args.message_id, "incoming-root");
    return {
      messages: [
        {
          sender: { user_id: "30000", nickname: "测试" },
          message: [
            { type: "text", data: { text: "外层蓝鲸" } },
            {
              type: "forward",
              data: {
                id: "inline-child",
                content: [
                  { message: [{ type: "text", data: { text: "内层松林" } }] },
                ],
              },
            },
          ],
        },
      ],
    };
  };
  const observe = () =>
    mem.append({
      dedupe: "observed-sent",
      conversation: ctx.conversation,
      connectionId: "qq-0",
      kind: "message.received",
      direction: "out",
      messageId: "confirmed-sent-message",
      payload: {
        segments: [
          {
            type: "json",
            data: {
              data: JSON.stringify({
                app: "com.tencent.multimsg",
                view: "contact",
                meta: { detail: { resid: "sent-card-resource" } },
              }),
            },
          },
        ],
      },
    }).id;
  return { ...f, ctx, mem, source, calls, observe, transport };
}

function interest(f, evidence) {
  return f.mem.identity.propose(
    {
      body: "探索新的兴趣",
      reason: "回顾来源",
      evidence,
      scope: "interest",
      expectedVersion: 1,
    },
    f.ctx,
    f.runtime.agent("agent-0").selfPolicy,
    100,
  );
}
function acceptInterest(f, candidate) {
  return f.mem.identity.review(
    {
      id: candidate.id,
      expectedVersion: 1,
      expectedRevision: 1,
      action: "accept",
      reason: "延后核对",
    },
    { conversation: "@subject", turnStartedAt: candidate.reviewAfter + 1 },
    f.runtime.agent("agent-0").selfPolicy,
    candidate.reviewAfter + 1,
  );
}

test("forward evidence: opaque gateway nodes cannot support a Self interest", async (t) => {
  const f = setup(t);
  const contents = [
    ...[
      "image",
      "video",
      "record",
      "json",
      "xml",
      "music",
      "file",
      "forward",
      "reply",
      "unknown-media",
      "face",
      "at",
    ].map((type) => [{ type, data: {} }]),
    "[CQ:image,file=opaque]",
    [],
  ];
  f.transport.call = async () => ({
    messages: contents.map((message) => ({ message })),
  });
  const read = await f.runtime.callTool(f.ctx, "qq_forward_read", {
    eventId: f.source,
  });
  assert.equal(read.total, contents.length);
  for (const item of read.items) {
    const candidate = interest(f, [item.id]);
    assert(
      ["unexpanded-reference", "forward-reference"].includes(
        candidate.roots[0].epistemic,
      ),
    );
    assert.throws(() => acceptInterest(f, candidate), /INSUFFICIENT/);
  }
});

test("forward evidence: confirmed copies inherit only the matching original source", async (t) => {
  const f = setup(t);
  const own = f.mem.append({
    dedupe: "own-text",
    conversation: f.ctx.conversation,
    kind: "message.sent",
    direction: "out",
    body: "我自己说我喜欢登山",
  }).id;
  const observed = f.mem.append({
    dedupe: "observed-text",
    conversation: f.ctx.conversation,
    kind: "message.received",
    direction: "in",
    body: "这次一起登山很开心",
    payload: {
      segments: [{ type: "text", data: { text: "这次一起登山很开心" } }],
    },
  }).id;
  f.transport.sendForward = async () => ({
    messageId: "confirmed-sent-message",
  });
  const sent = await f.runtime.callTool(f.ctx, "qq_forward_send", {
    requestId: "mixed-sources",
    eventIds: [own, observed],
  });
  const read = await f.runtime.callTool(f.ctx, "qq_forward_read", {
    eventId: sent.eventId,
  });
  const selfCopy = interest(f, [read.items[0].id]);
  assert.deepEqual(selfCopy.roots, []);
  assert.throws(() => acceptInterest(f, selfCopy), /INSUFFICIENT/);
  assert(selfCopy.evidenceSnapshot.references.some((r) => r.id === own));
  assert(!selfCopy.evidenceSnapshot.references.some((r) => r.id === observed));
  const externalCopy = interest(f, [read.items[1].id, observed]);
  assert.equal(externalCopy.roots.length, 1);
  assert.equal(externalCopy.roots[0].id, observed);

  // A successful gateway read of our reflected card is still a copy. Its text
  // cannot acquire observed status, even when the gateway changes that text.
  const payload = JSON.parse(
    f.mem.db.prepare("SELECT payload FROM events WHERE id=?").get(sent.eventId)
      .payload,
  );
  f.transport.call = async () => ({
    messages: payload.forwardSnapshot.messages,
  });
  const reflected = await f.runtime.callTool(f.ctx, "qq_forward_read", {
    eventId: f.observe(),
  });
  assert.deepEqual(interest(f, [reflected.items[0].id]).roots, []);
  const node = JSON.parse(
    f.mem.db
      .prepare("SELECT payload FROM events WHERE id=?")
      .get(reflected.items[1].id).payload,
  );
  node.segments = [{ type: "text", data: { text: "网关返回了不匹配的文字" } }];
  f.mem.db
    .prepare("UPDATE events SET payload=? WHERE id=?")
    .run(JSON.stringify(node), reflected.items[1].id);
  assert.deepEqual(interest(f, [reflected.items[1].id]).roots, []);
  assert.equal(acceptInterest(f, externalCopy).status, "accepted");
});

test("forward evidence: legacy confirmed copies preserve provenance and reject missing originals", async (t) => {
  const f = setup(t);
  const original = f.mem.append({
    dedupe: "legacy-original",
    conversation: f.ctx.conversation,
    kind: "message.sent",
    direction: "out",
    body: "这是我自己的文字",
  }).id;
  f.transport.sendForward = async () => ({
    messageId: "confirmed-sent-message",
  });
  const sent = await f.runtime.callTool(f.ctx, "qq_forward_send", {
    requestId: "legacy-copy",
    eventIds: [original],
  });
  const p = JSON.parse(
    f.mem.db.prepare("SELECT payload FROM events WHERE id=?").get(sent.eventId)
      .payload,
  );
  delete p.forwardSnapshot;
  f.mem.db
    .prepare("UPDATE events SET payload=? WHERE id=?")
    .run(JSON.stringify(p), sent.eventId);
  const read = await f.runtime.callTool(f.ctx, "qq_forward_read", {
    eventId: sent.eventId,
  });
  assert.deepEqual(interest(f, [read.items[0].id]).roots, []);
  f.mem.db.prepare("DELETE FROM events WHERE id=?").run(original);
  assert.throws(
    () => interest(f, [read.items[0].id]),
    /EVIDENCE_NOT_OWNED_OR_MISSING/,
  );
});

test("sent JSON forward reads confirmed sources when native gateway resource lookup fails", async (t) => {
  const f = setup(t);
  await f.runtime.callTool(f.ctx, "qq_forward_send", {
    requestId: "nested-send",
    eventIds: [f.source],
  });
  const observed = f.observe();
  const read = await f.runtime.callTool(f.ctx, "qq_forward_read", {
    eventId: observed,
    maxDepth: 5,
  });
  assert.equal(read.complete, true);
  assert.equal(read.total, 3);
  assert.deepEqual(
    read.items.map((x) => x.depth),
    [0, 1, 2],
  );
  assert.ok(read.items.some((x) => x.text === "内层松林"));
  assert.equal(read.items[0].source, "confirmed-send-sources");
  assert.equal(
    read.warnings[0].code,
    "GATEWAY_READ_FAILED_USING_CONFIRMED_SEND_SOURCES",
  );
  assert.deepEqual(f.calls, ["send", "sent-card-resource", "incoming-root"]);
  const cached = await f.runtime.callTool(f.ctx, "qq_forward_read", {
    eventId: observed,
    maxDepth: 5,
  });
  assert.equal(cached.complete, true);
  assert.equal(cached.warnings[0].code, read.warnings[0].code);
  assert.equal(f.calls.length, 3);
});
test("forward send returns a readable event ID and depth-limited continuation preserves nesting", async (t) => {
  const f = setup(t),
    sent = await f.runtime.callTool(f.ctx, "qq_forward_send", {
      requestId: "nested-send",
      eventIds: [f.source],
    });
  assert.ok(sent.eventId);
  const first = await f.runtime.callTool(f.ctx, "qq_forward_read", {
    eventId: sent.eventId,
    maxDepth: 0,
  });
  assert.equal(first.complete, false);
  assert.equal(first.total, 1);
  assert.deepEqual(first.deferred, ["incoming-root"]);
  const child = await f.runtime.callTool(f.ctx, "qq_forward_read", {
    eventId: sent.eventId,
    resourceId: first.deferred[0],
  });
  assert.equal(child.complete, true);
  assert.equal(child.total, 2);
  const repeat = await f.runtime.callTool(f.ctx, "qq_forward_send", {
    requestId: "nested-send",
    eventIds: [f.source],
  });
  assert.equal(repeat.eventId, sent.eventId);
  assert.equal(repeat.duplicate, true);
  assert.equal(f.calls.filter((x) => x === "send").length, 1);
  await assert.rejects(
    f.runtime.callTool(context(f.runtime, "agent-1"), "qq_forward_read", {
      eventId: sent.eventId,
    }),
    /RECORD_NOT_FOUND/,
  );
});

test("forward fallback requires a matching confirmed delivery, direction, connection and conversation", async (t) => {
  const f = setup(t);
  await f.runtime.callTool(f.ctx, "qq_forward_send", {
    requestId: "nested-send",
    eventIds: [f.source],
  });
  const observed = f.observe();
  const original = f.mem.db
    .prepare("SELECT * FROM events WHERE id=?")
    .get(observed);
  for (const [column, value] of [
    ["direction", "in"],
    ["connection_id", "qq-1"],
    ["conversation", "group:20001"],
  ]) {
    f.mem.db
      .prepare(`UPDATE events SET ${column}=? WHERE id=?`)
      .run(value, observed);
    const result = await f.runtime.callTool(f.ctx, "qq_forward_read", {
      eventId: observed,
    });
    assert.equal(result.complete, false);
    assert.equal(result.total, 0);
    f.mem.db
      .prepare(`UPDATE events SET ${column}=? WHERE id=?`)
      .run(original[column], observed);
  }
  for (const status of ["pending", "failed", "unknown"]) {
    f.mem.db
      .prepare("UPDATE deliveries SET status=? WHERE request_id='nested-send'")
      .run(status);
    const result = await f.runtime.callTool(f.ctx, "qq_forward_read", {
      eventId: observed,
    });
    assert.equal(result.complete, false);
    assert.equal(result.total, 0);
  }
  assert.equal(f.calls.includes("incoming-root"), false);
  assert.equal(f.calls.filter((x) => x === "send").length, 1);
});

test("legacy confirmed forwards recover append-only sources but refuse missing provenance", async (t) => {
  const f = setup(t),
    sent = await f.runtime.callTool(f.ctx, "qq_forward_send", {
      requestId: "nested-send",
      eventIds: [f.source],
    });
  const row = f.mem.db
    .prepare("SELECT payload FROM events WHERE id=?")
    .get(sent.eventId);
  const payload = JSON.parse(row.payload);
  delete payload.forwardSnapshot;
  f.mem.db
    .prepare("UPDATE events SET payload=? WHERE id=?")
    .run(JSON.stringify(payload), sent.eventId);
  const first = await f.runtime.callTool(f.ctx, "qq_forward_read", {
    eventId: sent.eventId,
  });
  assert.equal(first.complete, true);
  assert.equal(first.total, 3);
  f.mem.db.prepare("DELETE FROM events WHERE id=?").run(f.source);
  const failed = await f.runtime.callTool(f.ctx, "qq_forward_read", {
    eventId: f.observe(),
  });
  assert.equal(failed.complete, false);
  assert.equal(failed.total, 0);
});

test("new forwards persist their exact source snapshot and archived-node text wire payload", async (t) => {
  const f = setup(t),
    sent = await f.runtime.callTool(f.ctx, "qq_forward_send", {
      requestId: "nested-send",
      eventIds: [f.source],
    });
  f.mem.db.prepare("DELETE FROM events WHERE id=?").run(f.source);
  const read = await f.runtime.callTool(f.ctx, "qq_forward_read", {
    eventId: sent.eventId,
  });
  assert.equal(read.complete, true);
  assert.equal(read.total, 3);
  const archived = f.mem.append({
    dedupe: "archived-text",
    conversation: f.ctx.conversation,
    kind: "forward.node",
    senderId: "30000",
    body: "**实际发送文字**",
    payload: {
      segments: [{ type: "forward", data: { id: "must-not-fetch" } }],
    },
  }).id;
  let sentContent;
  f.transport.sendForward = async (_, nodes) => {
    sentContent = nodes[0].data.content;
    return { messageId: "text-forward-message" };
  };
  const plain = await f.runtime.callTool(f.ctx, "qq_forward_send", {
    requestId: "plain-send",
    eventIds: [archived],
  });
  const result = await f.runtime.callTool(f.ctx, "qq_forward_read", {
    eventId: plain.eventId,
  });
  assert.equal(result.complete, true);
  assert.equal(result.total, 1);
  assert.equal(result.items[0].text, sentContent[0].data.text);
  assert.deepEqual(result.items[0].nestedForwardIds, []);
});

test("unavailable inner resources remain incomplete while cross-conversation speech is agent-judged", async (t) => {
  const f = setup(t),
    sent = await f.runtime.callTool(f.ctx, "qq_forward_send", {
      requestId: "nested-send",
      eventIds: [f.source],
    });
  f.transport.call = async (action, args) => {
    assert.equal(action, "get_forward_msg");
    assert.equal(args.message_id, "incoming-root");
    throw Error("ONEBOT_REJECTED");
  };
  const result = await f.runtime.callTool(f.ctx, "qq_forward_read", {
    eventId: sent.eventId,
  });
  assert.equal(result.complete, false);
  assert.equal(result.total, 1);
  assert.equal(result.errors[0].error, "FORWARD_FETCH_FAILED");
  const other = context(f.runtime, "agent-0", "group:20001");
  await f.runtime.callTool(other, "qq_forward_read", {
    eventId: sent.eventId,
    maxDepth: 0,
  });
  assert.ok(other.privateRead.has(sent.eventId));
  assert.equal(
    (
      await f.runtime.callTool(other, "qq_send", {
        requestId: "recall-send",
        text: "我认为适合分享的回忆",
      })
    ).status,
    "sent",
  );
});

test("pausing during a rejected gateway read prevents confirmed-source fallback", async (t) => {
  const f = setup(t);
  await f.runtime.callTool(f.ctx, "qq_forward_send", {
    requestId: "nested-send",
    eventIds: [f.source],
  });
  f.transport.call = async () => {
    await f.runtime.pause("agent-0", true);
    throw Error("ONEBOT_REJECTED");
  };
  await assert.rejects(
    f.runtime.callTool(f.ctx, "qq_forward_read", { eventId: f.observe() }),
    /AGENT_PAUSED_OR_EXPIRED/,
  );
  assert.equal(
    f.mem.db
      .prepare("SELECT count(*) AS n FROM events WHERE kind='forward.archive'")
      .get().n,
    0,
  );
});

for (const gateway of ["rejected", "middle-online"])
  test(`nested confirmed-send lineage survives ${gateway} gateway resources`, async (t) => {
    const f = setup(t);
    let sends = 0;
    const snapshots = new Map();
    f.transport.sendForward = async () => ({
      messageId: "local-sent-" + ++sends,
    });
    f.transport.call = async (_, args) => {
      if (gateway === "middle-online" && args.message_id === "own-resource-1")
        return { messages: snapshots.get(1), gatewayExtra: true };
      throw Error("ONEBOT_REJECTED");
    };
    let source = f.mem.append({
      dedupe: "inner-text",
      conversation: f.ctx.conversation,
      connectionId: "qq-0",
      kind: "acceptance.fixture",
      body: "内层松林",
    }).id;
    let sent;
    for (let level = 0; level < 3; level++) {
      sent = await f.runtime.callTool(f.ctx, "qq_forward_send", {
        requestId: "own-nested-" + level,
        eventIds: [source],
      });
      const row = f.mem.db
        .prepare("SELECT payload FROM events WHERE id=?")
        .get(sent.eventId);
      snapshots.set(level, JSON.parse(row.payload).forwardSnapshot.messages);
      source = f.mem.append({
        dedupe: "own-card-" + level,
        conversation: f.ctx.conversation,
        connectionId: "qq-0",
        kind: "message.received",
        direction: "out",
        messageId: sent.messageId,
        payload: {
          segments: [
            {
              type: "json",
              data: {
                data: JSON.stringify({
                  app: "com.tencent.multimsg",
                  view: "contact",
                  meta: { detail: { resid: "own-resource-" + level } },
                }),
              },
            },
          ],
        },
      }).id;
    }
    const outer = source;
    const first = await f.runtime.callTool(f.ctx, "qq_forward_read", {
      eventId: outer,
      maxDepth: 0,
    });
    assert.equal(first.total, 1);
    assert.equal(first.complete, false);
    const middle = await f.runtime.callTool(f.ctx, "qq_forward_read", {
      eventId: outer,
      resourceId: first.deferred[0],
      maxDepth: 0,
    });
    assert.equal(middle.total, 1);
    assert.equal(middle.complete, false);
    const inner = await f.runtime.callTool(f.ctx, "qq_forward_read", {
      eventId: outer,
      resourceId: middle.deferred[0],
    });
    assert.equal(inner.complete, true);
    assert.equal(inner.items[0].text, "内层松林");
    const all = await f.runtime.callTool(f.ctx, "qq_forward_read", {
      eventId: outer,
      maxDepth: 5,
    });
    assert.equal(all.complete, true);
    assert.deepEqual(
      all.items.map((x) => x.depth),
      [0, 1, 2],
    );
    assert.equal(all.total, 3);
    assert.equal(sends, 3);
  });

test("nested fallback refuses changed, foreign or unconfirmed source cards", async (t) => {
  for (const mutation of ["inbound", "connection", "content", "receipt"]) {
    const f = setup(t);
    let sentCount = 0;
    f.transport.sendForward = async () => ({
      messageId: "nested-proof-" + ++sentCount,
    });
    f.transport.call = async () => {
      throw Error("ONEBOT_REJECTED");
    };
    const plain = f.mem.append({
      dedupe: "plain",
      conversation: f.ctx.conversation,
      kind: "fixture",
      body: "private inner",
    }).id;
    const inner = await f.runtime.callTool(f.ctx, "qq_forward_send", {
      requestId: "proof-inner",
      eventIds: [plain],
    });
    const payload = {
      segments: [
        {
          type: "json",
          data: {
            data: JSON.stringify({
              app: "com.tencent.multimsg",
              view: "contact",
              meta: { detail: { resid: "proof-resource" } },
            }),
          },
        },
      ],
    };
    const observed = f.mem.append({
      dedupe: "proof-card",
      conversation: f.ctx.conversation,
      connectionId: "qq-0",
      kind: "message.received",
      direction: "out",
      messageId: inner.messageId,
      payload,
    }).id;
    const outer = await f.runtime.callTool(f.ctx, "qq_forward_send", {
      requestId: "proof-outer",
      eventIds: [observed],
    });
    if (mutation === "inbound")
      f.mem.db
        .prepare("UPDATE events SET direction='in' WHERE id=?")
        .run(observed);
    if (mutation === "connection")
      f.mem.db
        .prepare("UPDATE events SET connection_id='qq-1' WHERE id=?")
        .run(observed);
    if (mutation === "content")
      f.mem.db
        .prepare("UPDATE events SET payload=? WHERE id=?")
        .run(JSON.stringify({ segments: [] }), observed);
    if (mutation === "receipt")
      f.mem.db
        .prepare(
          "UPDATE deliveries SET status='unknown' WHERE request_id='proof-inner'",
        )
        .run();
    const read = await f.runtime.callTool(f.ctx, "qq_forward_read", {
      eventId: outer.eventId,
    });
    assert.equal(read.complete, false, mutation);
    assert.equal(read.total, 1);
    assert.ok(!read.items.some((x) => x.text.includes("private inner")));
    assert.equal(sentCount, 2);
  }
});
