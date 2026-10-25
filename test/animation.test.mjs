import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  inspectGif,
  selectFrames,
  decodeGif,
  hasOtherAnimation,
} from "../src/tools/animation.mjs";
import { MediaStore } from "../src/tools/media.mjs";
import { toolSpecs, mcpResult } from "../src/tools/index.mjs";
import { safeToolFailure } from "../src/tools/errors.mjs";
import { fixture, config, context, temp } from "./helpers.mjs";
import { gif } from "./gif-fixture.mjs";

const meta = (result) => JSON.parse(result.content[0].text);
const images = (result) => result.content.filter((c) => c.type === "image");
function rgba(image) {
  const r = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      "pipe:0",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "pipe:1",
    ],
    { input: Buffer.from(image.data, "base64"), timeout: 5000 },
  );
  assert.equal(r.status, 0);
  return [...r.stdout];
}
const red = [255, 0, 0, 255],
  green = [0, 255, 0, 255],
  blue = [0, 0, 255, 255];

test("variable GIF delays match FFprobe timestamps and time sampling includes the last frame", () => {
  const data = gif([
    { delay: 0 },
    { color: 1, delay: 1 },
    { color: 2, delay: 30 },
    { delay: 50 },
  ]);
  const info = inspectGif(data);
  assert.deepEqual(
    info.frames.map((f) => f.timeMs),
    [0, 100, 110, 410],
  );
  assert.equal(info.durationMs, 910);
  const probe = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-f",
      "gif",
      "-ignore_loop",
      "1",
      "-min_delay",
      "0",
      "-default_delay",
      "10",
      "-i",
      "pipe:0",
      "-show_frames",
      "-show_entries",
      "frame=pts_time,pkt_duration_time",
      "-of",
      "json",
    ],
    { input: data, encoding: "utf8", timeout: 5000 },
  );
  assert.equal(probe.status, 0);
  assert.deepEqual(
    JSON.parse(probe.stdout).frames.map((f) =>
      Math.round(Number(f.pts_time) * 1000),
    ),
    info.frames.map((f) => f.timeMs),
  );
  const selection = selectFrames(info, { limit: 3 });
  assert.deepEqual(
    selection.selected.map((f) => f.index),
    [0, 2, 3],
  );
  assert.equal(selection.sampled, true);
  assert.equal(selection.complete, false);
});

test("real decoder composites transparent patches and restore-previous disposal", async () => {
  const data = gif([
    { color: 0 },
    { width: 2, height: 1, pixels: [1, 3], disposal: 3 },
    { width: 1, height: 1, x: 1, color: 2 },
  ]);
  const info = inspectGif(data);
  const output = await decodeGif(data, info, info.frames);
  assert.equal(output.length, 3);
  assert.deepEqual(rgba(output[0]), Array(6).fill(red).flat());
  assert.deepEqual(rgba(output[1]), [green, red, red, red, red, red].flat());
  assert.deepEqual(rgba(output[2]), [red, blue, red, red, red, red].flat());
  const last = await decodeGif(data, info, [info.frames[2]]);
  assert.deepEqual(rgba(last[0]), rgba(output[2]));
});

test("default overview is bounded, chronological, and preserves original GIF send bytes", async (t) => {
  const media = new MediaStore(temp(t));
  const data = gif(
    Array.from({ length: 43 }, (_, i) => ({ color: i % 3, delay: 4 })),
  );
  const saved = media.put("a", data, "image/gif");
  media.collect("a", saved.id, { title: "Synthetic animation" });
  const result = await media.view("a", saved.id);
  const m = meta(result);
  assert.equal(m.animation.frameCount, 43);
  assert.equal(m.animation.durationMs, 1720);
  assert.equal(images(result).length, 10);
  assert.equal(m.animation.frames[0].index, 0);
  assert.equal(m.animation.frames.at(-1).index, 42);
  assert.equal(m.animation.sampled, true);
  assert.equal(m.animation.complete, false);
  assert(images(result).every((i) => i.mimeType === "image/png"));
  assert.deepEqual(
    Buffer.from(media.segment("a", saved.id).data.file.slice(9), "base64"),
    data,
  );
  assert.equal(media.list("a").length, 1);
  assert.equal(media.read("a", saved.id).mimeType, "image/gif");
  await assert.rejects(media.view("b", saved.id), /MEDIA_NOT_FOUND/);
});

test("frame pagination has no gaps or duplicates, and range pages include overlapping held frames", async (t) => {
  const media = new MediaStore(temp(t));
  const data = gif(
    Array.from({ length: 15 }, (_, i) => ({ color: i % 3, delay: 10 })),
  );
  const saved = media.put("a", data, "image/gif");
  let args = { mediaId: saved.id, animation: { mode: "frames", limit: 4 } };
  const seen = [];
  while (args) {
    const r = meta(await media.view("a", args.mediaId, args.animation));
    seen.push(...r.animation.frames.map((f) => f.index));
    args = r.animation.next;
  }
  assert.deepEqual(
    seen,
    Array.from({ length: 15 }, (_, i) => i),
  );
  const range = meta(
    await media.view("a", saved.id, {
      mode: "frames",
      startMs: 250,
      endMs: 510,
      limit: 2,
    }),
  );
  assert.deepEqual(
    range.animation.frames.map((f) => f.index),
    [2, 3],
  );
  assert.equal(range.animation.nextFrameOffset, 4);
  assert.equal(range.animation.complete, false);
  const info = inspectGif(data);
  for (const options of [
    { limit: 13 },
    { offset: 1 },
    { mode: "frames", offset: 15 },
    { startMs: 300, endMs: 200 },
    { endMs: 1501 },
  ])
    assert.throws(() => selectFrames(info, options), /ANIMATION/);
});

test("static image paths need no decoder and unsupported animations never silently lose frames", async (t) => {
  const media = new MediaStore(temp(t), {
    decode: () => {
      throw Error("UNEXPECTED_DECODER");
    },
  });
  const data = gif([{ color: 2 }]);
  const saved = media.put("a", data, "image/gif");
  assert.equal(meta(await media.view("a", saved.id)).animated, false);
  assert.equal(
    images(await media.view("a", saved.id))[0].data,
    data.toString("base64"),
  );
  const webp = Buffer.alloc(30);
  webp.write("RIFF");
  webp.writeUInt32LE(22, 4);
  webp.write("WEBPVP8X", 8);
  webp.writeUInt32LE(10, 16);
  webp[20] = 2;
  assert.equal(hasOtherAnimation(webp, "image/webp"), true);
  const w = media.put("a", webp, "image/webp");
  await assert.rejects(media.view("a", w.id), /ANIMATION_FORMAT_UNSUPPORTED/);
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    Buffer.from([0, 0, 0, 8]),
    Buffer.from("acTL"),
    Buffer.alloc(12),
  ]);
  assert.equal(hasOtherAnimation(png, "image/png"), true);
});

test("malformed and excessive animations are rejected before invoking a decoder", () => {
  const data = gif([{ color: 0 }, { color: 1 }]);
  for (const invalid of [
    Buffer.alloc(13),
    data.subarray(0, data.length - 1),
    data.subarray(0, 40),
  ])
    assert.throws(() => inspectGif(invalid), /INVALID_GIF/);
  const huge = Buffer.from(data);
  huge.writeUInt16LE(65535, 6);
  huge.writeUInt16LE(65535, 8);
  assert.throws(() => inspectGif(huge), /PIXEL_LIMIT/);
  assert.throws(() => inspectGif(gif([{ delay: 65535 }])), /LENGTH_LIMIT/);
  assert.throws(
    () => inspectGif(gif(Array(1001).fill({ delay: 2 }))),
    /LENGTH_LIMIT/,
  );
});

test("missing decoder, byte limit, timeout and cancellation return explicit failures without a first-frame fallback", async (t) => {
  const data = gif([{ color: 0 }, { color: 2 }]),
    info = inspectGif(data);
  await assert.rejects(
    decodeGif(data, info, info.frames, {
      command: path.join(temp(t), "missing"),
    }),
    /DECODER_UNAVAILABLE/,
  );
  await assert.rejects(
    decodeGif(data, info, info.frames, { maxOutputBytes: 1 }),
    /OUTPUT_LIMIT/,
  );
  const dir = temp(t),
    sleeper = path.join(dir, "sleep-decoder");
  fs.writeFileSync(
    sleeper,
    `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`,
    { mode: 0o700 },
  );
  await assert.rejects(
    decodeGif(data, info, info.frames, { command: sleeper, timeoutMs: 50 }),
    /TIMEOUT/,
  );
  const controller = new AbortController();
  const pending = decodeGif(data, info, info.frames, {
    command: sleeper,
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(pending, /ABORTED/);
  const safe = safeToolFailure(Error("ANIMATION_DECODER_UNAVAILABLE"));
  assert.equal(safe.code, "ANIMATION_DECODER_UNAVAILABLE");
  assert(!JSON.stringify(safe).includes(dir));
});

test("QQ and sticker tools expose the same frames via MCP and keep source provenance and original sending", async (t) => {
  const cfg = config(2);
  cfg.agents.forEach((a) =>
    a.tools.push("qq_image_read", "sticker_read", "sticker_collect"),
  );
  const { runtime, store, root } = fixture(t, { cfg });
  const data = gif([{ color: 0 }, { color: 1 }, { color: 2 }]);
  let downloads = 0;
  runtime.media = new MediaStore(path.join(root, "media"), {
    fetchBuffer: async () => {
      downloads++;
      return data;
    },
  });
  const ctx = context(runtime);
  const event = store.bind(ctx.agentId).append({
    dedupe: "gif",
    conversation: ctx.conversation,
    kind: "message.received",
    body: "[image]",
    payload: {
      segments: [
        { type: "image", data: { url: "https://example.com/synthetic.gif" } },
      ],
    },
  });
  const result = mcpResult(
    await runtime.callTool(ctx, "qq_image_read", { id: event.id }),
  );
  assert.equal(images(result).length, 3);
  assert.equal(meta(result).animation.complete, true);
  const mediaId = meta(result).id;
  await runtime.callTool(ctx, "sticker_collect", {
    mediaId,
    title: "Synthetic",
  });
  const page = await runtime.callTool(ctx, "sticker_read", {
    mediaId,
    animation: { mode: "frames", offset: 2, limit: 1 },
  });
  assert.deepEqual(rgba(images(page)[0]), Array(6).fill(blue).flat());
  assert.equal(downloads, 1);
  await assert.rejects(
    runtime.callTool(context(runtime, "agent-1"), "sticker_read", { mediaId }),
    /MEDIA_NOT_FOUND/,
  );
  await runtime.callTool(ctx, "qq_send", {
    requestId: "animation-send",
    mediaId,
  });
  const sent = runtime.transports
    .get("qq-0")
    .sent[0].segments.find((s) => s.type === "image");
  assert.deepEqual(Buffer.from(sent.data.file.slice(9), "base64"), data);
  for (const spec of toolSpecs(["qq_image_read", "sticker_read"]))
    assert.equal(
      spec.inputSchema.properties.animation.properties.limit.maximum,
      12,
    );
});

test("concurrent decode budget is released after errors and cancellation", async (t) => {
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const media = new MediaStore(temp(t), {
    decode: async () => {
      await gate;
      throw Error("ANIMATION_DECODE_FAILED");
    },
  });
  const saved = media.put("a", gif([{}, {}]), "image/gif");
  const first = assert.rejects(media.view("a", saved.id), /DECODE_FAILED/);
  const second = assert.rejects(media.view("a", saved.id), /DECODE_FAILED/);
  await assert.rejects(media.view("a", saved.id), /DECODER_BUSY/);
  release();
  await Promise.all([first, second]);
  assert.equal(media.activeAnimations, 0);
});
