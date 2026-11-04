import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { config, fixture, context, raw } from "./helpers.mjs";
import { MediaStore } from "../src/tools/media.mjs";

const faceInput = (id) => ({ type: "face", id });
const textInput = (text) => ({ type: "text", text });
const faceWire = (id) => ({ type: "face", data: { id: String(id) } });
const textWire = (text) => ({ type: "text", data: { text } });

function setup(t) {
  const cfg = config(1);
  cfg.agents[0].tools.push("qq_send_burst");
  const f = fixture(t, { cfg });
  return {
    ...f,
    ctx: context(f.runtime),
    mem: f.store.bind("agent-0"),
    transport: f.runtime.transports.get("qq-0"),
  };
}

function sentEvent(mem, requestId) {
  return mem.db
    .prepare("SELECT * FROM events WHERE agent_id=? AND dedupe=?")
    .get("agent-0", `send:${requestId}:sent`);
}

async function makeUnknown(f, name, args) {
  f.transport.failure = "GATEWAY_TIMEOUT";
  await assert.rejects(
    f.runtime.callTool(f.ctx, name, args),
    /DELIVERY_UNKNOWN/,
  );
  f.transport.failure = null;
  assert.equal(f.mem.delivery(args.requestId)?.status, "unknown");
}

async function echo(f, messageId, segments) {
  await f.runtime.ingest(
    "qq-0",
    raw(messageId, {
      post_type: "message_sent",
      user_id: 10000,
      message_id: String(messageId),
      message: segments,
    }),
  );
}

test("qq_send mixes repeated text and faces in order, normalizes IDs, and supports face-only delivery", async (t) => {
  const f = setup(t),
    input = [
      textInput("占位甲"),
      faceInput("5"),
      textInput("占位乙"),
      faceInput("00020"),
      faceInput("5"),
    ],
    wire = [
      textWire("占位甲"),
      faceWire("5"),
      textWire("占位乙"),
      faceWire("20"),
      faceWire("5"),
    ];

  assert.equal(
    (
      await f.runtime.callTool(f.ctx, "qq_send", {
        requestId: "mixed-faces",
        segments: input,
      })
    ).status,
    "sent",
  );
  assert.deepEqual(f.transport.sent[0].segments, wire);
  const mixed = sentEvent(f.mem, "mixed-faces"),
    mixedPayload = JSON.parse(mixed.payload);
  assert.equal(
    mixed.body,
    "占位甲[QQ表情：流泪]占位乙[QQ表情：偷笑][QQ表情：流泪]",
  );
  assert.deepEqual(mixedPayload.segments, wire);
  assert.equal(mixedPayload.segments[3].data.id, "20");

  assert.equal(
    (
      await f.runtime.callTool(f.ctx, "qq_send", {
        requestId: "face-only",
        segments: [faceInput("20")],
      })
    ).status,
    "sent",
  );
  assert.deepEqual(f.transport.sent[1].segments, [faceWire("20")]);
  const faceOnly = sentEvent(f.mem, "face-only");
  assert.equal(faceOnly.body, "[QQ表情：偷笑]");
  assert.deepEqual(JSON.parse(faceOnly.payload).segments, [faceWire("20")]);
});

test("legacy text keeps CQ and QQ-face-looking markers literal without structured metadata", async (t) => {
  const f = setup(t),
    text = "占位 [CQ:face,id=20] [QQ表情：偷笑]";
  await f.runtime.callTool(f.ctx, "qq_send", {
    requestId: "literal-text",
    text,
  });
  const row = sentEvent(f.mem, "literal-text"),
    payload = JSON.parse(row.payload);
  assert.equal(row.body, text);
  assert.equal(f.transport.sent[0].segments.length, 1);
  assert.deepEqual(f.transport.sent[0].segments[0], textWire(text));
  assert.equal(Object.hasOwn(payload, "segments"), false);
});

test("structured sends reject malformed, unknown, mixed-form, and over-limit content before reserving", async (t) => {
  const f = setup(t),
    cases = [
      ["empty-text-segment", { segments: [textInput("")] }],
      ["bad-segment-kind", { segments: [{ type: "image", id: "x" }] }],
      [
        "extra-segment-field",
        { segments: [{ ...faceInput("20"), name: "x" }] },
      ],
      [
        "too-many-segments",
        { segments: Array.from({ length: 33 }, () => faceInput("20")) },
      ],
      [
        "too-much-text",
        {
          segments: [
            textInput("甲".repeat(4001)),
            textInput("乙".repeat(4000)),
          ],
        },
      ],
      ["both-forms", { text: "占位文字", segments: [faceInput("20")] }],
    ];

  for (const [requestId, content] of cases) {
    await assert.rejects(
      f.runtime.send(f.ctx, { requestId, ...content }),
      /INVALID_MESSAGE/,
      requestId,
    );
    assert.equal(f.mem.delivery(requestId), undefined, requestId);
  }
  await assert.rejects(
    f.runtime.send(f.ctx, {
      requestId: "unknown-face",
      segments: [faceInput("999999")],
    }),
    /INVALID_QQ_FACE/,
  );
  assert.equal(f.mem.delivery("unknown-face"), undefined);
  assert.equal(f.transport.sent.length, 0);
});

test("credentials split across structured text segments are rejected before sending", async (t) => {
  const f = setup(t),
    tokenTail = "x".repeat(24);
  await assert.rejects(
    f.runtime.callTool(f.ctx, "qq_send", {
      requestId: "split-credential",
      segments: [textInput("占位 sk-"), textInput(tokenTail)],
    }),
    /SENSITIVE_OUTPUT_BLOCKED/,
  );
  await assert.rejects(
    f.runtime.callTool(f.ctx, "qq_send_burst", {
      requestId: "burst-split-credential",
      messages: [
        "占位首条",
        { segments: [textInput("sk-"), textInput(tokenTail)] },
      ],
      gapMs: 0,
    }),
    /SENSITIVE_OUTPUT_BLOCKED/,
  );
  assert.equal(f.transport.sent.length, 0);
  assert.equal(f.mem.delivery("split-credential"), undefined);
  assert.equal(f.mem.delivery("burst-split-credential:0"), undefined);
});

test("structured text aggregate boundary accepts 8000 characters", async (t) => {
  const f = setup(t),
    text = "占位".repeat(4000);
  const receipt = await f.runtime.send(f.ctx, {
    requestId: "text-boundary",
    segments: [textInput(text)],
  });
  assert.equal(receipt.status, "sent");
  assert.equal(f.transport.sent[0].segments[0].data.text.length, 8000);
});

test("same request ID is idempotent for the same face and conflicts when its face changes", async (t) => {
  const f = setup(t),
    args = { requestId: "same-face-request", segments: [faceInput("20")] };
  assert.equal(
    (await f.runtime.callTool(f.ctx, "qq_send", args)).status,
    "sent",
  );
  assert.equal(
    (await f.runtime.callTool(context(f.runtime), "qq_send", args)).duplicate,
    true,
  );
  await assert.rejects(
    f.runtime.callTool(f.ctx, "qq_send", {
      ...args,
      segments: [faceInput("5")],
    }),
    /IDEMPOTENCY_CONFLICT/,
  );
  assert.equal(f.transport.sent.length, 1);
});

test("an unknown structured send cannot be replayed with the same request ID", async (t) => {
  const f = setup(t),
    args = { requestId: "unknown-face-send", segments: [faceInput("20")] };
  await makeUnknown(f, "qq_send", args);
  await assert.rejects(
    f.runtime.callTool(f.ctx, "qq_send", args),
    /ALREADY_ATTEMPTED_UNKNOWN/,
  );
  assert.equal(f.transport.sent.length, 1);
});

test("burst keeps string messages and sends structured face segments as separate messages", async (t) => {
  const f = setup(t);
  f.ctx.internalDelivery = true;
  const result = await f.runtime.callTool(f.ctx, "qq_send_burst", {
    requestId: "mixed-burst",
    messages: [
      "占位首条",
      { segments: [textInput("占位中段"), faceInput("20"), faceInput("5")] },
      { segments: [faceInput("20")] },
    ],
  });
  assert.equal(result.status, "sent");
  assert.deepEqual(
    f.transport.sent.map((entry) => entry.segments),
    [
      [textWire("占位首条")],
      [textWire("占位中段"), faceWire("20"), faceWire("5")],
      [faceWire("20")],
    ],
  );
  assert.deepEqual(
    result.receipts.map((receipt) => receipt.status),
    ["sent", "sent", "sent"],
  );
});

test("burst prevalidates every item before sending any earlier valid message", async (t) => {
  const f = setup(t);
  await assert.rejects(
    f.runtime.callTool(f.ctx, "qq_send_burst", {
      requestId: "invalid-later-face",
      messages: ["占位有效", { segments: [faceInput("999999")] }],
      gapMs: 0,
    }),
    /INVALID_QQ_FACE/,
  );
  await assert.rejects(
    f.runtime.callTool(f.ctx, "qq_send_burst", {
      requestId: "invalid-later-length",
      messages: ["占位有效", { segments: [textInput("甲".repeat(2001))] }],
      gapMs: 0,
    }),
    /INVALID_MESSAGE/,
  );
  assert.equal(f.transport.sent.length, 0);
  assert.equal(f.mem.delivery("invalid-later-face:0"), undefined);
  assert.equal(f.mem.delivery("invalid-later-length:0"), undefined);
});

test("permission, pause, and per-turn budget still gate structured sends", async (t) => {
  const disabled = setup(t);
  disabled.runtime.config.agents[0].tools =
    disabled.runtime.config.agents[0].tools.filter(
      (name) => name !== "qq_send",
    );
  await assert.rejects(
    disabled.runtime.callTool(disabled.ctx, "qq_send", {
      requestId: "disabled-face",
      segments: [faceInput("20")],
    }),
    /TOOL_DISABLED/,
  );
  assert.equal(disabled.transport.sent.length, 0);

  const paused = setup(t);
  await paused.runtime.pause("all", true);
  await assert.rejects(
    paused.runtime.callTool(paused.ctx, "qq_send", {
      requestId: "paused-face",
      segments: [faceInput("20")],
    }),
    /PAUSED/,
  );
  assert.equal(paused.transport.sent.length, 0);

  const budgeted = setup(t);
  budgeted.runtime.agent("agent-0").maxConsecutiveSends = 1;
  await budgeted.runtime.callTool(budgeted.ctx, "qq_send", {
    requestId: "budget-first-face",
    segments: [faceInput("20")],
  });
  await assert.rejects(
    budgeted.runtime.callTool(budgeted.ctx, "qq_send", {
      requestId: "budget-second-face",
      segments: [faceInput("5")],
    }),
    /REPLY_BURST_LIMIT/,
  );
  assert.equal(budgeted.transport.sent.length, 1);
  assert.equal(budgeted.mem.delivery("budget-second-face"), undefined);
});

test("read-through checkpoint still advances after a pure-face send is confirmed", async (t) => {
  const f = setup(t),
    incoming = f.mem.append({
      dedupe: "synthetic-face-checkpoint-input",
      conversation: f.ctx.conversation,
      direction: "in",
      senderId: "30000",
      kind: "message.received",
      body: "占位输入",
    }),
    shown = await f.runtime.callTool(f.ctx, "conversation_read", {});
  assert.equal(shown.readThroughSeq, incoming.seq);

  const receipt = await f.runtime.callTool(f.ctx, "qq_send", {
    requestId: "face-checkpoint",
    segments: [faceInput("20")],
    readThroughSeq: shown.readThroughSeq,
  });
  assert.deepEqual(receipt.readCheckpoint, {
    throughSeq: incoming.seq,
    applied: true,
  });
  assert.equal(f.mem.state(f.ctx.conversation).readThroughSeq, incoming.seq);
});

test("a face echo cannot be replaced by its text marker or another face ID", async (t) => {
  const f = setup(t),
    args = { requestId: "echo-face-only", segments: [faceInput("20")] };
  await makeUnknown(f, "qq_send", args);

  await echo(f, "90001", [textWire("[QQ表情：偷笑]")]);
  assert.equal(f.mem.delivery(args.requestId).status, "unknown");
  await echo(f, "90002", [faceWire("21")]);
  assert.equal(f.mem.delivery(args.requestId).status, "unknown");
  await echo(f, "90003", [faceWire("20")]);
  assert.equal(f.mem.delivery(args.requestId).status, "sent");
  assert.equal(f.mem.delivery(args.requestId).message_id, "90003");
  assert.equal(f.transport.sent.length, 1);
});

test("a mixed face echo must match text, order, and every face ID exactly", async (t) => {
  const f = setup(t),
    args = {
      requestId: "echo-mixed-faces",
      segments: [
        textInput("占位"),
        faceInput("5"),
        textInput("补充"),
        faceInput("20"),
      ],
    };
  await makeUnknown(f, "qq_send", args);

  await echo(f, "90101", [
    faceWire("5"),
    textWire("占位"),
    textWire("补充"),
    faceWire("20"),
  ]);
  assert.equal(f.mem.delivery(args.requestId).status, "unknown");
  await echo(f, "90102", [
    textWire("占位"),
    faceWire("5"),
    textWire("补充"),
    faceWire("21"),
  ]);
  assert.equal(f.mem.delivery(args.requestId).status, "unknown");
  await echo(f, "90103", [
    textWire("占位"),
    faceWire("5"),
    textWire("补充"),
    faceWire("20"),
  ]);
  assert.equal(f.mem.delivery(args.requestId).status, "sent");
  assert.equal(f.mem.delivery(args.requestId).message_id, "90103");
});

test("structured face echo preserves exact text whitespace", async (t) => {
  const f = setup(t),
    args = {
      requestId: "echo-exact-whitespace",
      segments: [textInput("AB"), faceInput("20")],
    };
  await makeUnknown(f, "qq_send", args);

  await echo(f, "90111", [textWire("A B"), faceWire("20")]);
  assert.equal(f.mem.delivery(args.requestId).status, "unknown");
  await echo(f, "90112", [textWire("AB"), faceWire("20")]);
  assert.equal(f.mem.delivery(args.requestId).status, "sent");
  assert.equal(f.mem.delivery(args.requestId).message_id, "90112");
});

test("legacy text echo matching is unchanged", async (t) => {
  const f = setup(t),
    args = { requestId: "echo-legacy-text", text: "[QQ表情：偷笑]" };
  await makeUnknown(f, "qq_send", args);
  await echo(f, "90201", [textWire(args.text)]);
  assert.equal(f.mem.delivery(args.requestId).status, "sent");
  assert.equal(f.mem.delivery(args.requestId).message_id, "90201");
});

test("reply, at, and image segments remain part of echo matching and keep ambiguous receipts unknown", async (t) => {
  const f = setup(t),
    png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
      "base64",
    );
  f.runtime.media = new MediaStore(path.join(f.root, "media"));
  const mediaId = f.runtime.media.put("agent-0", png, "image/png").id,
    source = await f.runtime.callTool(f.ctx, "qq_send", {
      requestId: "reply-source",
      text: "占位引用源",
    });
  await makeUnknown(f, "qq_send", {
    requestId: "echo-with-controls",
    replyTo: source.messageId,
    atUserId: "30000",
    mediaId,
    segments: [faceInput("20")],
  });

  const actual = f.transport.sent[1].segments;
  assert.deepEqual(
    actual.map((segment) => segment.type),
    ["reply", "at", "face", "image"],
  );
  await echo(f, "90301", [faceWire("20")]);
  assert.equal(f.mem.delivery("echo-with-controls").status, "unknown");
  const attempt = f.mem.db
    .prepare("SELECT payload FROM events WHERE agent_id=? AND dedupe=?")
    .get("agent-0", "send:echo-with-controls:pending");
  const payload = JSON.parse(attempt.payload);
  assert.deepEqual(payload.segments, [
    ...actual.slice(0, 3),
    { type: "image", data: { mediaId } },
  ]);
  assert.equal(payload.mediaId, mediaId);
  assert.equal(
    JSON.stringify(payload.segments).includes(png.toString("base64")),
    false,
  );
  assert.equal(JSON.stringify(payload.segments).includes("base64://"), false);
});
