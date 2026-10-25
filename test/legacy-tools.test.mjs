import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fixture, config, context, raw, settle } from "./helpers.mjs";
import { TOOL_NAMES } from "../src/tools/index.mjs";
import { VoiceStore } from "../src/tools/voice.mjs";
import { MediaStore } from "../src/tools/media.mjs";

import { wav } from "./audio-fixture.mjs";

function setup(t) {
  const c = config(2);
  c.agents.forEach((a) => (a.tools = TOOL_NAMES));
  const f = fixture(t, { cfg: c });
  f.runtime.voices = new VoiceStore(path.join(f.root, "voices"));
  f.runtime.media = new MediaStore(path.join(f.root, "media"));
  return f;
}
function event(f, segments, conversation = "group:20000", body = "附件") {
  return f.store.bind("agent-0").append({
    dedupe: Math.random().toString(),
    conversation,
    kind: "message.received",
    body,
    payload: { segments },
    senderId: "30000",
  }).id;
}
test("real ffprobe and ffmpeg validate and process an isolated WAV without changing the source", async (t) => {
  const f = setup(t),
    policy = f.runtime.agent("agent-0").voice,
    bytes = wav();
  const m = await f.runtime.voices.put("agent-0", bytes, policy, {
    title: "本地合成音",
  });
  assert.equal(m.codec, "pcm_s16le");
  assert.ok(m.duration > 0);
  const segment = await f.runtime.voices.segment("agent-0", m.id, policy, {
    volume: 2,
  });
  assert.equal(segment.type, "record");
  assert.match(segment.data.file, /^base64:\/\//);
  const original = Buffer.from(
    f.runtime.voices.read("agent-0", m.id).data,
    "base64",
  );
  assert.deepEqual(original, bytes);
  assert.equal(
    fs
      .readdirSync(f.runtime.voices.dir("agent-0"))
      .filter((x) => x.startsWith("vol-")).length,
    0,
  );
});
test("gateway get_record converts observed native voice without opening arbitrary local files", async (t) => {
  const f = setup(t),
    a = f.runtime.agent("agent-0"),
    ctx = context(f.runtime);
  const eventId = event(f, [
    {
      type: "record",
      data: {
        file: "observed-record.amr",
        url: path.join(f.root, "gateway-only.amr"),
      },
    },
  ]);
  const calls = [];
  f.runtime.transports.get(a.connectionId).call = async (action, args) => {
    calls.push({ action, args });
    return { base64: wav().toString("base64") };
  };
  const result = await f.runtime.callTool(ctx, "qq_voice_read", { eventId });
  assert.ok(
    result.content.some(
      (c) => c.type === "audio" && c.mimeType === "audio/wav",
    ),
  );
  assert.deepEqual(calls, [
    {
      action: "get_record",
      args: { file: "observed-record.amr", out_format: "wav" },
    },
  ]);
  const m = f.runtime.voices.list(a.id).items[0];
  assert.ok(m.duration > 0);
  assert.equal(m.sources[0].eventId, eventId);
});
test("voice import refuses invalid bytes, excessive duration, and another agent's asset", async (t) => {
  const f = setup(t),
    a = f.runtime.agent("agent-0");
  await assert.rejects(
    f.runtime.voices.put(a.id, Buffer.from("not an audio"), a.voice),
    /INVALID_AUDIO/,
  );
  await assert.rejects(
    f.runtime.voices.put(a.id, wav(1.2), { ...a.voice, maxSeconds: 1 }),
    /AUDIO_TOO_LONG/,
  );
  const m = await f.runtime.voices.put(a.id, wav(), a.voice);
  assert.throws(() => f.runtime.voices.read("agent-1", m.id), /NOT_FOUND/);
});
test("voice sending uses shared outbox receipts and ambiguous send is never retried", async (t) => {
  const f = setup(t),
    a = f.runtime.agent("agent-0"),
    ctx = context(f.runtime),
    m = await f.runtime.voices.put(a.id, wav(), a.voice);
  const r = await f.runtime.callTool(ctx, "qq_send_voice", {
    requestId: "voice-once",
    audioId: m.id,
  });
  assert.equal(r.status, "sent");
  const again = await f.runtime.callTool(ctx, "qq_send_voice", {
    requestId: "voice-once",
    audioId: m.id,
  });
  assert.equal(again.duplicate, true);
  const transport = f.runtime.transports.get(a.connectionId);
  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0].segments[0].type, "record");
  transport.failure = "TIMEOUT";
  await assert.rejects(
    f.runtime.callTool(ctx, "qq_send_voice", {
      requestId: "voice-unknown",
      audioId: m.id,
    }),
    /UNKNOWN/,
  );
  await assert.rejects(
    f.runtime.callTool(ctx, "qq_send_voice", {
      requestId: "voice-unknown",
      audioId: m.id,
    }),
    /ALREADY_ATTEMPTED/,
  );
  assert.equal(transport.sent.length, 2);
});
test("private voice origins remain restricted across reads and shared content hashes", async (t) => {
  const f = setup(t),
    a = f.runtime.agent("agent-0"),
    m = await f.runtime.voices.put(a.id, wav(), a.voice, {
      conversation: "private:30000",
      sourceEventId: "private-source",
    });
  await f.runtime.voices.put(a.id, wav(), a.voice, {
    conversation: "group:20000",
  });
  const ctx = context(f.runtime);
  await f.runtime.callTool(ctx, "qq_voice_read", { audioId: m.id });
  await assert.rejects(
    f.runtime.callTool(ctx, "qq_send_voice", {
      requestId: "private-voice",
      audioId: m.id,
    }),
    /DISCLOSURE/,
  );
  assert.ok(
    f.store
      .bind(a.id)
      .state(ctx.conversation)
      .disclosureTaint.includes("private-source"),
  );
});
test("pausing during audio processing prevents the eventual network request", async (t) => {
  const f = setup(t),
    a = f.runtime.agent("agent-0"),
    m = await f.runtime.voices.put(a.id, wav(), a.voice),
    ctx = context(f.runtime);
  let release;
  f.runtime.voices.segment = () => new Promise((r) => (release = r));
  const sending = f.runtime.callTool(ctx, "qq_send_voice", {
    requestId: "late-voice",
    audioId: m.id,
  });
  await f.runtime.pause("agent-0", true);
  release({ type: "record", data: { file: "base64://fixture" } });
  await assert.rejects(sending, /UNKNOWN/);
  assert.equal(f.runtime.transports.get(a.connectionId).sent.length, 0);
});
test("forward traversal handles nesting, cycles, raw archive, images and paginated long text", async (t) => {
  const f = setup(t),
    ctx = context(f.runtime),
    id = event(f, [{ type: "forward", data: { id: "root" } }]);
  let calls = 0;
  f.runtime.transports.get("qq-0").call = async (action, args) => {
    assert.equal(action, "get_forward_msg");
    calls++;
    return {
      messages:
        args.message_id === "root"
          ? [
              {
                sender: { user_id: 30000, nickname: "甲" },
                message: [
                  { type: "text", data: { text: "长".repeat(5000) } },
                  { type: "forward", data: { id: "child" } },
                ],
              },
            ]
          : [
              {
                sender: { user_id: 30001, nickname: "乙" },
                message: [
                  { type: "text", data: { text: "嵌套内容" } },
                  {
                    type: "image",
                    data: { url: "https://example.com/image.png" },
                  },
                  { type: "forward", data: { id: "root" } },
                ],
              },
            ],
    };
  };
  const first = await f.runtime.callTool(ctx, "qq_forward_read", {
    eventId: id,
    limit: 1,
    maxChars: 2000,
  });
  assert.equal(first.total, 2);
  assert.equal(first.nextOffset, 1);
  assert.equal(calls, 2);
  const full = f.store
    .bind("agent-0")
    .read({ id: first.items[0].id, maxChars: 10000 });
  assert.ok(full.chunk.includes("长".repeat(5000)));
  const second = await f.runtime.callTool(ctx, "qq_forward_read", {
    eventId: id,
    offset: 1,
  });
  assert.equal(second.items[0].text, "嵌套内容[图片][转发]");
  assert.ok(second.items[0].attachmentTypes.includes("image"));
  assert.equal(calls, 2);
});
test("nested resources require observed parent provenance and cannot cross agent identity", async (t) => {
  const f = setup(t),
    ctx = context(f.runtime),
    id = event(f, [{ type: "forward", data: { id: "root" } }]);
  let calls = 0;
  f.runtime.transports.get("qq-0").call = async () => {
    calls++;
    return { messages: [] };
  };
  await assert.rejects(
    f.runtime.callTool(ctx, "qq_forward_read", {
      eventId: id,
      resourceId: "unseen",
    }),
    /NOT_OBSERVED/,
  );
  await assert.rejects(
    f.runtime.callTool(context(f.runtime, "agent-1"), "qq_forward_read", {
      eventId: id,
    }),
    /NOT_FOUND/,
  );
  assert.equal(calls, 0);
});
test("forward depth limits expose deferred resources which can be expanded later", async (t) => {
  const f = setup(t),
    ctx = context(f.runtime),
    id = event(f, [{ type: "forward", data: { id: "root" } }]);
  f.runtime.transports.get("qq-0").call = async (_action, args) => ({
    messages: [
      {
        message:
          args.message_id === "root"
            ? [{ type: "forward", data: { id: "child" } }]
            : [{ type: "text", data: { text: "内层" } }],
      },
    ],
  });
  const r = await f.runtime.callTool(ctx, "qq_forward_read", {
    eventId: id,
    maxDepth: 0,
  });
  assert.equal(r.complete, false);
  assert.deepEqual(r.deferred, ["child"]);
  const next = await f.runtime.callTool(ctx, "qq_forward_read", {
    eventId: id,
    resourceId: "child",
  });
  assert.equal(next.items[0].text, "内层");
});
test("forward send preserves provenance and requires cross-conversation disclosure", async (t) => {
  const f = setup(t),
    ctx = context(f.runtime),
    id = event(f, [], "private:30000", "私聊内容");
  let calls = 0;
  f.runtime.transports.get("qq-0").sendForward = async () => {
    calls++;
    return { messageId: "forward-sent" };
  };
  await assert.rejects(
    f.runtime.callTool(ctx, "qq_forward_send", {
      requestId: "forward-one",
      eventIds: [id],
    }),
    /DISCLOSURE/,
  );
  assert.equal(calls, 0);
  f.runtime.grant(ctx.token, [id]);
  const r = await f.runtime.callTool(ctx, "qq_forward_send", {
    requestId: "forward-one",
    eventIds: [id],
  });
  assert.equal(r.messageId, "forward-sent");
});
test("poke requires current membership and stores action confirmation without a fake message ID", async (t) => {
  const f = setup(t),
    ctx = context(f.runtime),
    actions = [];
  f.runtime.transports.get("qq-0").call = async (action, args) => {
    actions.push(action);
    return action === "get_group_member_info"
      ? { user_id: args.user_id }
      : null;
  };
  const r = await f.runtime.callTool(ctx, "qq_send_poke", {
    requestId: "poke-one",
    userId: "30000",
  });
  assert.equal(r.messageId, null);
  assert.equal(r.actionConfirmed, true);
  assert.deepEqual(actions, ["get_group_member_info", "group_poke"]);
  assert.equal(
    f.store.bind("agent-0").search({ kind: "action.confirmed" }).items.length,
    1,
  );
});
test("burst records successful prefixes and stops on an unknown result", async (t) => {
  const f = setup(t),
    ctx = context(f.runtime),
    transport = f.runtime.transports.get("qq-0");
  let n = 0;
  transport.send = async () => {
    if (++n === 2) throw Error("timeout");
    return { messageId: String(n) };
  };
  const r = await f.runtime.callTool(ctx, "qq_send_burst", {
    requestId: "burst",
    messages: ["一", "二", "三"],
    gapMs: 0,
  });
  assert.equal(r.receipts.length, 1);
  assert.equal(r.failedIndex, 1);
  assert.equal(n, 2);
});
test("shared send rate limits apply across distinct tools and contexts", async (t) => {
  const f = setup(t),
    a = f.runtime.agent("agent-0");
  a.behavior.maxSendPerMinute = 1;
  await f.runtime.send(context(f.runtime), {
    requestId: "first",
    text: "第一条",
  });
  await assert.rejects(
    f.runtime.callTool(context(f.runtime), "qq_send_poke", {
      requestId: "second",
      userId: "30000",
    }),
    /SEND_RATE_LIMIT/,
  );
});
test("cross-group links are directed, activity is aggregated and contains no original text", async (t) => {
  const f = setup(t),
    a = f.runtime.agent("agent-0"),
    ctx = context(f.runtime);
  a.crossGroup = {
    enabled: true,
    links: [{ from: "20000", to: "20001", allow: ["activity"] }],
  };
  event(f, [], "group:20001", "不可外泄原文");
  const r = await f.runtime.callTool(ctx, "qq_cross_group_query", {
    groupId: "20001",
    capability: "activity",
  });
  assert.equal(r.messagesLast24h, 1);
  assert.ok(!JSON.stringify(r).includes("不可外泄"));
  await assert.rejects(
    f.runtime.callTool(
      context(f.runtime, "agent-0", "group:20001"),
      "qq_cross_group_query",
      { groupId: "20000", capability: "activity" },
    ),
    /NOT_ALLOWED/,
  );
});
test("official sticker mutations only accept a listed identity and go through the same action ledger", async (t) => {
  const f = setup(t),
    ctx = context(f.runtime),
    calls = [];
  f.runtime.transports.get("qq-0").call = async (action, args) => {
    calls.push({ action, args });
    return action === "fetch_custom_face"
      ? [{ emoji_id: "face1", url: "https://example.com/1.png" }]
      : {};
  };
  await assert.rejects(
    f.runtime.callTool(ctx, "qq_official_sticker_remark", {
      requestId: "no",
      id: "absent",
      remark: "笑",
    }),
    /NOT_LISTED/,
  );
  await f.runtime.callTool(ctx, "qq_official_stickers", {});
  const result = await f.runtime.callTool(ctx, "qq_official_sticker_remark", {
    requestId: "remark",
    id: "face1",
    remark: "笑",
  });
  assert.equal(result.actionConfirmed, true);
  await f.runtime.callTool(ctx, "qq_official_sticker_remark", {
    requestId: "remark",
    id: "face1",
    remark: "笑",
  });
  assert.equal(
    calls.filter((x) => x.action === "modify_custom_face").length,
    1,
  );
});
test("poke and join notices archive distinct observations without inventing speech", async (t) => {
  const f = setup(t);
  await f.runtime.pause("all", true);
  await f.runtime.ingest(
    "qq-0",
    raw(1, {
      post_type: "notice",
      notice_type: "notify",
      sub_type: "poke",
      target_id: 10000,
      message: undefined,
    }),
  );
  await f.runtime.ingest(
    "qq-0",
    raw(2, {
      post_type: "notice",
      notice_type: "group_increase",
      message: undefined,
    }),
  );
  const items = f.store.bind("agent-0").search({ type: "event" }).items;
  assert.ok(items.some((x) => x.type === "notice.poke"));
  assert.ok(items.some((x) => x.type === "notice.join"));
});

test("URL-only official stickers receive bounded IDs and refuse invented editable identities", async (t) => {
  const f = setup(t),
    ctx = context(f.runtime);
  f.runtime.transports.get("qq-0").call = async () => [
    "https://example.com/" + "x".repeat(300) + ".png",
  ];
  const r = await f.runtime.callTool(ctx, "qq_official_stickers", {});
  assert.ok(r.items[0].id.length < 200);
  await assert.rejects(
    f.runtime.callTool(ctx, "qq_official_sticker_remark", {
      requestId: "url-only",
      id: r.items[0].id,
      remark: "测试",
    }),
    /DID_NOT_PROVIDE_EDITABLE/,
  );
});

test("received local voice is confined to administrator media roots and retains provenance", async (t) => {
  const f = setup(t),
    a = f.runtime.agent("agent-0"),
    dir = path.join(f.root, "gateway-audio");
  fs.mkdirSync(dir);
  const file = path.join(dir, "received.wav");
  fs.writeFileSync(file, wav());
  const eventId = event(f, [{ type: "record", data: { url: file } }]);
  const ctx = context(f.runtime);
  await assert.rejects(
    f.runtime.callTool(ctx, "qq_voice_read", { eventId }),
    /VOICE_LOCAL_PATH_DENIED/,
  );
  a.voice.localRoots = [dir];
  const result = await f.runtime.callTool(ctx, "qq_voice_read", { eventId });
  assert.ok(result.content.some((c) => c.type === "audio"));
  const imported = f.runtime.voices.list(a.id).items[0];
  assert.equal(imported.sources[0].eventId, eventId);
  const outside = path.join(f.root, "outside.wav");
  fs.writeFileSync(outside, wav());
  fs.symlinkSync(outside, path.join(dir, "escape.wav"));
  for (const candidate of [outside, path.join(dir, "escape.wav")]) {
    const id = event(f, [{ type: "record", data: { url: candidate } }]);
    await assert.rejects(
      f.runtime.callTool(ctx, "qq_voice_read", { eventId: id }),
      /VOICE_LOCAL_PATH_DENIED/,
    );
  }
  fs.writeFileSync(
    path.join(dir, "large.wav"),
    Buffer.alloc(a.voice.maxBytes + 1),
  );
  const large = event(f, [
    { type: "record", data: { url: path.join(dir, "large.wav") } },
  ]);
  await assert.rejects(
    f.runtime.callTool(ctx, "qq_voice_read", { eventId: large }),
    /AUDIO_TOO_LARGE/,
  );
});

test("NapCat inline nested forwards remain readable when child IDs cannot be fetched", async (t) => {
  const f = setup(t),
    ctx = context(f.runtime),
    root = event(f, [{ type: "forward", data: { id: "root-inline" } }]);
  let calls = 0;
  f.runtime.transports.get("qq-0").call = async (_, args) => {
    calls++;
    if (args.message_id !== "root-inline")
      throw Error("INNER_MESSAGE_NOT_FETCHABLE");
    return {
      messages: [
        {
          sender: { user_id: 30000, nickname: "外层" },
          message: [
            { type: "text", data: { text: "外层蓝鲸" } },
            {
              type: "forward",
              data: {
                id: "nested-message-id",
                content: [
                  {
                    sender: { user_id: 30001, nickname: "内层" },
                    message: [{ type: "text", data: { text: "内层松林" } }],
                  },
                ],
              },
            },
          ],
        },
      ],
    };
  };
  const first = await f.runtime.callTool(ctx, "qq_forward_read", {
    eventId: root,
    maxDepth: 0,
  });
  assert.equal(first.total, 1);
  assert.deepEqual(first.deferred, ["nested-message-id"]);
  const child = await f.runtime.callTool(ctx, "qq_forward_read", {
    eventId: root,
    resourceId: "nested-message-id",
  });
  assert.equal(child.complete, true);
  assert.equal(child.items[0].text, "内层松林");
  assert.equal(calls, 1);
  const all = await f.runtime.callTool(ctx, "qq_forward_read", {
    eventId: root,
  });
  assert.equal(all.total, 2);
  assert.equal(all.items[1].depth, 1);
  assert.equal(all.complete, true);
  assert.equal(calls, 1);
});

test("QQ JSON merged-forward cards expose only their observed forward resource", async (t) => {
  const f = setup(t),
    ctx = context(f.runtime);
  let calls = 0;
  f.runtime.transports.get("qq-0").call = async (action, args) => {
    calls++;
    assert.equal(action, "get_forward_msg");
    assert.equal(args.message_id, "observed-card-resource");
    return {
      messages: [
        {
          sender: { user_id: 30000, nickname: "测试" },
          message: [{ type: "text", data: { text: "卡片原文" } }],
        },
      ],
    };
  };
  const card = {
    app: "com.tencent.multimsg",
    view: "contact",
    meta: { detail: { resid: "observed-card-resource" } },
  };
  const segment = (data) => ({
    type: "json",
    data: { data: typeof data === "string" ? data : JSON.stringify(data) },
  });
  const id = event(f, [segment(card)]),
    read = await f.runtime.callTool(ctx, "qq_forward_read", { eventId: id });
  assert.equal(read.complete, true);
  assert.equal(read.items[0].text, "卡片原文");
  assert.equal(calls, 1);
  for (const invalid of [
    { ...card, app: "unrelated.app" },
    { ...card, view: "unrelated-view" },
    "{invalid JSON}",
    JSON.stringify(card) + " ".repeat(65536),
    { ...card, meta: { detail: { resid: "bad resource\n" } } },
  ]) {
    const denied = event(f, [segment(invalid)]);
    await assert.rejects(
      f.runtime.callTool(ctx, "qq_forward_read", { eventId: denied }),
      /FORWARD_NOT_FOUND/,
    );
  }
  assert.equal(calls, 1);
  await assert.rejects(
    f.runtime.callTool(ctx, "qq_forward_read", {
      eventId: id,
      resourceId: "unobserved-resource",
    }),
    /FORWARD_RESOURCE_NOT_OBSERVED/,
  );
  f.runtime.transports.get("qq-0").call = async (action, args) => {
    calls++;
    assert.equal(action, "get_forward_msg");
    assert.equal(args.message_id, "unavailable-card-resource");
    throw Error("ONEBOT_REJECTED");
  };
  const unavailable = event(f, [
    segment({
      ...card,
      meta: { detail: { resid: "unavailable-card-resource" } },
    }),
  ]);
  const rejected = await f.runtime.callTool(ctx, "qq_forward_read", {
    eventId: unavailable,
  });
  assert.equal(rejected.complete, false);
  assert.equal(rejected.total, 0);
  assert.deepEqual(rejected.errors, [
    { resourceId: "unavailable-card-resource", error: "FORWARD_FETCH_FAILED" },
  ]);
  assert.equal(calls, 2);
});
