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

test("unavailable inner resources remain incomplete and cross-conversation reads require disclosure", async (t) => {
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
  await assert.rejects(
    f.runtime.callTool(other, "qq_send", {
      requestId: "leak",
      text: "不可直接披露",
    }),
    /DISCLOSURE/,
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
