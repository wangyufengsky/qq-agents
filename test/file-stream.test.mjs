import test from "node:test";
import assert from "node:assert/strict";
import { OneBot } from "../src/transport/onebot.mjs";
import { downloadFileStream } from "../src/transport/file-stream.mjs";
import { config } from "./helpers.mjs";

const packet = (data) => ({ status: "ok", retcode: 0, data });
const info = (size) =>
  packet({ type: "stream", data_type: "file_info", file_size: size });
const chunk = (text, index = 0) =>
  packet({
    type: "stream",
    data_type: "file_chunk",
    index,
    data: Buffer.from(text).toString("base64"),
    size: Buffer.byteLength(text),
  });
const complete = (size, count = 1) =>
  packet({
    type: "response",
    data_type: "file_complete",
    total_bytes: size,
    total_chunks: count,
  });
function botFor(packets, { status = 200, fragment = false, signal } = {}) {
  return new OneBot(config(1).connections[0], {
    fetchImpl: async (url, options) => {
      assert.equal(new URL(url).pathname, "/download_file_stream");
      assert.deepEqual(JSON.parse(options.body), {
        file_id: "observed-id",
        chunk_size: 65536,
      });
      assert.equal(options.redirect, "error");
      const bytes = Buffer.from(
        packets.map((p) => JSON.stringify(p)).join("\r\n\r\n") + "\r\n\r\n",
      );
      const stream = new ReadableStream({
        start(controller) {
          if (fragment) {
            for (let i = 0; i < bytes.length; i += 7)
              controller.enqueue(bytes.subarray(i, i + 7));
          } else controller.enqueue(bytes);
          signal?.abort();
          controller.close();
        },
      });
      return new Response(stream, { status });
    },
  });
}

test("attachment streaming assembles fragmented JSON frames and checks final byte counts", async () => {
  const bot = botFor([info(5), chunk("hello"), complete(5)], {
    fragment: true,
  });
  const result = await bot.downloadFile("observed-id", { maxBytes: 1024 });
  assert.equal(result.buffer.toString(), "hello");
});

test("native image streams accept a stale size hint but retain complete actual-byte validation", async () => {
  const packets = [info(2), chunk("hello"), complete(5)];
  const result = await downloadFileStream(botFor(packets), "observed-id", {
    maxBytes: 1024,
    sizeHintOnly: true,
  });
  assert.equal(result.buffer.toString(), "hello");
  await assert.rejects(
    botFor(packets).downloadFile("observed-id", { maxBytes: 1024 }),
    /FILE_DOWNLOAD_FAILED/,
  );
});

for (const [label, packets, error] of [
  ["oversized metadata", [info(2048)], /FILE_TOO_LARGE/],
  [
    "oversized content",
    [info(2), chunk("x".repeat(1025)), complete(1025)],
    /FILE_TOO_LARGE/,
  ],
  ["truncated transfer", [info(5), chunk("hello")], /FILE_DOWNLOAD_FAILED/],
  [
    "wrong total",
    [info(5), chunk("hello"), complete(4)],
    /FILE_DOWNLOAD_FAILED/,
  ],
  [
    "wrong sequence",
    [info(5), chunk("hello", 1), complete(5)],
    /FILE_DOWNLOAD_FAILED/,
  ],
  ["missing metadata", [chunk("hello"), complete(5)], /FILE_DOWNLOAD_FAILED/],
  [
    "gateway rejection",
    [{ status: "failed", retcode: 200, message: "secret path" }],
    /FILE_DOWNLOAD_FAILED/,
  ],
])
  test(`attachment streaming rejects ${label}`, async () => {
    for (const method of ["downloadFile", "downloadImage"])
      await assert.rejects(
        botFor(packets)[method]("observed-id", { maxBytes: 1024 }),
        error,
      );
  });

test("attachment streaming honors cancellation and HTTP errors", async () => {
  const controller = new AbortController();
  await assert.rejects(
    botFor([info(5), chunk("hello"), complete(5)], {
      signal: controller,
    }).downloadFile("observed-id", {
      maxBytes: 1024,
      signal: controller.signal,
    }),
    /FILE_DOWNLOAD_CANCELLED/,
  );
  await assert.rejects(
    botFor([], { status: 500 }).downloadFile("observed-id", { maxBytes: 1024 }),
    /FILE_DOWNLOAD_HTTP_ERROR/,
  );
});
