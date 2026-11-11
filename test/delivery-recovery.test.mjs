import { createHash } from "node:crypto";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { readGroupDeliveryEvidence } from "../src/transport/delivery-history.mjs";
import { MediaStore } from "../src/tools/media.mjs";
import { config, context, fixture, raw } from "./helpers.mjs";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);

function setup(t, caption = "") {
  const { runtime, store, root } = fixture(t, { cfg: config(1) });
  const transport = runtime.transports.get("qq-0");
  const memory = store.bind("agent-0");
  const ctx = context(runtime);
  runtime.media = new MediaStore(path.join(root, "media"));
  const { id: mediaId } = runtime.media.put("agent-0", png, "image/png");
  const file = createHash("md5").update(png).digest("hex") + ".png";
  const echo = (id, changes) =>
    raw(id, {
      post_type: "message_sent",
      message_type: "group",
      user_id: 10000,
      real_seq: String(id),
      time: Math.floor(Date.now() / 1000),
      message: [
        ...(caption ? [{ type: "text", data: { text: caption } }] : []),
        { type: "image", data: { file } },
      ],
      ...changes,
    });
  transport.failure = "GATEWAY_TIMEOUT";
  const send = () =>
    runtime.send(ctx, { requestId: "unknown-image", text: caption, mediaId });
  const verify = (scope = ctx) =>
    runtime.callTool(scope, "qq_delivery_status", {
      verifyRequestId: "unknown-image",
    });
  return { runtime, memory, transport, ctx, send, verify, echo };
}

test("a timed-out image is automatically reconciled from a unique QQ group receipt", async (t) => {
  const { runtime, memory, transport, send, echo } = setup(
    t,
    "fixture caption",
  );
  let reads = 0;
  transport.readGroupDeliveryEvidence = (groupId) =>
    readGroupDeliveryEvidence(transport, "10000", groupId);
  transport.call = async (action, args, timeout, opts) => {
    reads++;
    assert.equal(action, "get_group_msg_history");
    assert.equal(args.group_id, "20000");
    assert.equal(args.disable_get_url, true);
    assert.equal(args.parse_mult_msg, false);
    assert.equal(timeout, 4000);
    assert.equal(opts.maxBytes, 512 * 1024);
    return {
      messages: [
        echo(41001, { user_id: 30000 }),
        echo(41002, { group_id: 20001 }),
        echo(41003, { real_seq: "0" }),
        echo(41004),
        echo(41005, {
          message: [
            { type: "text", data: { text: "different caption" } },
            echo(41005).message.at(-1),
          ],
        }),
      ],
    };
  };
  await assert.rejects(send(), /DELIVERY_UNKNOWN/);
  await Promise.all([...runtime.work]);
  const receipt = memory.delivery("unknown-image");
  assert.equal(receipt.status, "sent");
  assert.equal(receipt.message_id, "41004");
  assert.equal(reads, 1);
  assert.equal(transport.sent.length, 1);
  assert.equal(memory.state("group:20000").readThroughSeq, 0);
});

test("AI can check its own receipt after an ambiguous history result", async (t) => {
  const { runtime, memory, transport, verify, send, echo } = setup(t);
  let messages = [echo(41001), echo(41002)];
  let reads = 0;
  transport.readGroupDeliveryEvidence = (groupId) =>
    readGroupDeliveryEvidence(transport, "10000", groupId);
  transport.call = async () => {
    reads++;
    return { messages };
  };
  await assert.rejects(send(), /DELIVERY_UNKNOWN/);
  await Promise.all([...runtime.work]);
  assert.equal(memory.delivery("unknown-image").status, "unknown");
  const clock = runtime.now();
  runtime.clock = () => new Date(clock + 61000);
  await assert.rejects(
    verify(context(runtime, "agent-0", "group:20001")),
    /DELIVERY_NOT_FOUND/,
  );
  assert.equal(reads, 1);
  messages = [echo(41001), echo(41002, { real_seq: "0" })];
  const ordinaryLookup = await runtime.callTool(
    context(runtime),
    "qq_delivery_status",
    {},
  );
  assert.equal(ordinaryLookup.latest.status, "sent");
  assert.equal(ordinaryLookup.latest.messageId, "41001");
  const result = await verify();
  assert.deepEqual(result.verification, {
    requestId: "unknown-image",
    status: "sent",
    messageId: "41001",
  });
  assert.equal(result.total, 0);
  assert.equal(transport.sent.length, 1);
  assert.equal(reads, 2);
});

test("a late own-account image echo settles the original receipt without replay", async (t) => {
  const { runtime, memory, transport, send, echo } = setup(t);
  await assert.rejects(send(), /DELIVERY_UNKNOWN/);
  const time = runtime.now();
  runtime.clock = () => new Date(time + 61000);
  await runtime.ingest(
    "qq-0",
    echo(41001, { time: Math.floor((time + 61000) / 1000) }),
  );
  assert.equal(memory.delivery("unknown-image").status, "sent");
  assert.equal(memory.delivery("unknown-image").message_id, "41001");
  assert.equal(transport.sent.length, 1);
});
