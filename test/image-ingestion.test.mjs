import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { MediaStore } from "../src/tools/media.mjs";
import { downloadImage } from "../src/tools/image-download.mjs";
import { FileStore } from "../src/tools/files.mjs";
import { safeToolFailure } from "../src/tools/errors.mjs";
import { fixture, config, context, temp } from "./helpers.mjs";
import { gif } from "./gif-fixture.mjs";
import { normalizeEvent } from "../src/transport/onebot.mjs";
import { raw } from "./helpers.mjs";

function largeGif() {
  const data = gif([{}, { color: 1 }, { color: 2 }]);
  const blocks = Array.from({ length: 37000 }, () =>
    Buffer.concat([Buffer.from([255]), Buffer.alloc(255, 65)]),
  );
  return Buffer.concat([
    data.subarray(0, -1),
    Buffer.from([0x21, 0xfe]),
    ...blocks,
    Buffer.from([0, 0x3b]),
  ]);
}
const event = (id = "event", url = "https://example.com/image.gif") => ({
  id,
  conversation: "group:20000",
  payload: { segments: [{ type: "image", data: { url } }] },
});
const images = (result) => result.content.filter((c) => c.type === "image");

async function nativeImageFixture(t) {
  const cfg = config(2);
  cfg.agents[0].tools.push("qq_image_read");
  const f = fixture(t, { cfg });
  const bytes = gif([{}, { color: 1 }]),
    calls = [];
  f.runtime.media = new MediaStore(path.join(f.root, "media"), {
    fetchBuffer: async () => {
      throw Error("IMAGE_DOWNLOAD_HTTP_ERROR");
    },
  });
  f.runtime.transports.get("qq-0").downloadImage = async (file, options) => {
    calls.push({ file, options });
    return { buffer: bytes };
  };
  const ctx = context(f.runtime),
    e = f.store.bind("agent-0").append({
      dedupe: "native-image",
      connectionId: "qq-0",
      conversation: ctx.conversation,
      kind: "message.received",
      direction: "in",
      payload: {
        trustedInput: true,
        segments: [
          {
            type: "image",
            data: {
              file: "0123456789abcdef0123456789abcdef.jpg",
              file_size: bytes.length,
              url: "https://example.com/rejected-image",
            },
          },
        ],
      },
    });
  return { ...f, ctx, event: e, calls, bytes };
}

test("rejected QQ image URLs fall back to the same account's native stream and cache the original pixels", async (t) => {
  const f = await nativeImageFixture(t);
  const result = await f.runtime.callTool(f.ctx, "qq_image_read", {
    id: f.event.id,
  });
  assert.equal(images(result).length, 2);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].file, "0123456789abcdef0123456789abcdef.jpg");
  assert.equal(f.calls[0].options.maxBytes, 20 * 1024 * 1024);
  const id = JSON.parse(result.content[0].text).id;
  assert.deepEqual(
    Buffer.from(f.runtime.media.read("agent-0", id).data, "base64"),
    f.bytes,
  );
  await f.runtime.callTool(f.ctx, "qq_image_read", { id: f.event.id });
  assert.equal(f.calls.length, 1);
});

test("native image fallback rejects untrusted IDs, foreign connections and unavailable sources", async (t) => {
  for (const deny of [
    "path",
    "url",
    "connection",
    "untrusted",
    "imported",
    "recalled",
    "allowlist",
    "other-agent",
    "onebot",
  ]) {
    const f = await nativeImageFixture(t),
      mem = f.store.bind("agent-0");
    const row = mem.db
      .prepare("SELECT * FROM events WHERE id=?")
      .get(f.event.id);
    const payload = JSON.parse(row.payload);
    if (deny === "path") payload.segments[0].data.file = "/tmp/private.png";
    if (deny === "url")
      payload.segments[0].data.file = "https://example.com/private.png";
    if (deny === "untrusted") payload.trustedInput = false;
    mem.db
      .prepare(
        "UPDATE events SET payload=?,connection_id=?,origin=?,status=? WHERE id=?",
      )
      .run(
        JSON.stringify(payload),
        deny === "connection" ? "qq-1" : row.connection_id,
        deny === "imported" ? "imported" : row.origin,
        deny === "recalled" ? "recalled" : row.status,
        f.event.id,
      );
    if (deny === "allowlist") {
      f.runtime.agent("agent-0").allow.groups = ["20001"];
      f.ctx = context(f.runtime, "agent-0", "group:20001");
    }
    if (deny === "other-agent") {
      f.runtime.agent("agent-1").tools.push("qq_image_read");
      f.ctx = context(f.runtime, "agent-1");
    }
    if (deny === "onebot") f.runtime.connection("qq-0").gateway = "onebot";
    await assert.rejects(
      f.runtime.callTool(f.ctx, "qq_image_read", { id: f.event.id }),
    );
    assert.equal(f.calls.length, 0, deny);
  }
});

test("native image fallback does not bypass URL policy, declared size or download deadlines", async (t) => {
  for (const code of [
    "IMAGE_URL_DENIED",
    "IMAGE_TOO_LARGE",
    "IMAGE_DOWNLOAD_TIMEOUT",
    "IMAGE_REDIRECT_INVALID",
    "IMAGE_REDIRECT_LIMIT",
    "ABORTED",
  ]) {
    const f = await nativeImageFixture(t);
    f.runtime.media.fetchBuffer = async () => {
      throw Error(code);
    };
    await assert.rejects(
      f.runtime.callTool(f.ctx, "qq_image_read", { id: f.event.id }),
      new RegExp(code),
    );
    assert.equal(f.calls.length, 0, code);
  }
});

test("native image errors remain image-specific and invalid pixels never enter the cache", async (t) => {
  for (const [cause, code] of [
    ["FILE_TOO_LARGE", "IMAGE_TOO_LARGE"],
    ["FILE_DOWNLOAD_CANCELLED", "IMAGE_DOWNLOAD_TIMEOUT"],
    ["FILE_DOWNLOAD_FAILED", "IMAGE_DOWNLOAD_FAILED"],
    ["invalid", "INVALID_IMAGE"],
  ]) {
    const f = await nativeImageFixture(t);
    f.runtime.transports.get("qq-0").downloadImage = async () => {
      if (cause === "invalid") return { buffer: Buffer.from("not an image") };
      throw Error(cause);
    };
    await assert.rejects(
      f.runtime.callTool(f.ctx, "qq_image_read", { id: f.event.id }),
      new RegExp(code),
    );
    assert.equal(f.runtime.media.cachedSource("agent-0", f.event.id, 0), null);
  }
});

test("native image fallback retains the download admission limit and honors cancellation before caching", async (t) => {
  const f = await nativeImageFixture(t);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  f.runtime.transports.get("qq-0").downloadImage = async () => {
    await gate;
    return { buffer: f.bytes };
  };
  const first = f.runtime.callTool(f.ctx, "qq_image_read", { id: f.event.id });
  const secondCtx = context(f.runtime);
  const second = f.runtime.callTool(secondCtx, "qq_image_read", {
    id: f.event.id,
  });
  await assert.rejects(
    f.runtime.callTool(context(f.runtime), "qq_image_read", { id: f.event.id }),
    /IMAGE_DOWNLOAD_BUSY/,
  );
  const rejected = assert.rejects(first, /ABORTED|AGENT_PAUSED_OR_EXPIRED/);
  f.ctx.controller.abort();
  release();
  await rejected;
  await second;
  assert.equal(f.runtime.media.activeDownloads, 0);
});

test("GIF source larger than 8 MiB is retained and decoded into bounded frames", async (t) => {
  const data = largeGif();
  assert(data.length > 9 * 1024 * 1024);
  const media = new MediaStore(temp(t), {
    fetchBuffer: async () => data,
  });
  const saved = await media.fromMessage("a", event());
  const result = await media.view("a", saved.id);
  assert.equal(images(result).length, 3);
  assert.equal(JSON.parse(result.content[0].text).animation.complete, true);
  assert.deepEqual(Buffer.from(media.read("a", saved.id).data, "base64"), data);
});

test("image transport streams real HTTP bytes with bounded size, cancellation and deadline errors", async (t) => {
  const data = largeGif();
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers.cookie, undefined);
    if (req.url === "/slow") {
      res.writeHead(200);
      res.write(data.subarray(0, 10));
    } else if (req.url === "/expired") {
      res.writeHead(403);
      res.end();
    } else if (req.url === "/length") {
      res.writeHead(200, { "content-length": data.length });
      res.end();
    } else {
      res.writeHead(200);
      res.end(data);
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://image-fixture.invalid:${server.address().port}`;
  const transport = {
    validate: async (raw) => ({ url: new URL(raw), addresses: ["127.0.0.1"] }),
  };
  const fetchBuffer = (url, maxBytes, options) =>
    downloadImage(url, maxBytes, options, transport);
  const media = new MediaStore(temp(t), { fetchBuffer });
  const saved = await media.fromMessage("a", event("large", base + "/ok"));
  assert.equal(saved.bytes, data.length);
  assert.equal(images(await media.view("a", saved.id)).length, 3);
  for (const suffix of ["/length", "/chunked"])
    await assert.rejects(fetchBuffer(base + suffix, 1024), /IMAGE_TOO_LARGE/);
  await assert.rejects(
    fetchBuffer(base + "/expired", 1024),
    /IMAGE_DOWNLOAD_HTTP_ERROR/,
  );
  const controller = new AbortController();
  const abort = setTimeout(() => controller.abort(), 30);
  await assert.rejects(
    fetchBuffer(base + "/slow", 1024, { signal: controller.signal }),
    /ABORTED/,
  );
  clearTimeout(abort);
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, "timeout", (ms) => {
    assert.equal(ms, 60000);
    return timeout(30);
  });
  await assert.rejects(
    fetchBuffer(base + "/slow", 1024),
    /IMAGE_DOWNLOAD_TIMEOUT/,
  );
  await assert.rejects(
    downloadImage(
      base + "/slow-dns",
      1024,
      {},
      {
        validate: () => new Promise(() => {}),
        request: () => {
          throw Error("DNS_DEADLINE_MUST_PREVENT_REQUEST");
        },
      },
    ),
    /IMAGE_DOWNLOAD_TIMEOUT/,
  );
});

test("image transport rejects private destinations and revalidates redirects", async () => {
  for (const url of [
    "file:///tmp/image.gif",
    "http://127.0.0.1/a",
    "http://10.0.0.1/a",
    "https://user:secret@example.org/a",
  ])
    await assert.rejects(downloadImage(url, 1024), /IMAGE_URL_DENIED/);
  let requests = 0;
  await assert.rejects(
    downloadImage(
      "https://93.184.216.34/a",
      1024,
      {},
      {
        request: async () => {
          requests++;
          return { redirect: "http://127.0.0.1/private" };
        },
      },
    ),
    /IMAGE_URL_DENIED/,
  );
  assert.equal(requests, 1);
});

test("source cache is scoped to agent, event and image index and survives restart", async (t) => {
  const root = temp(t);
  let downloads = 0;
  const fetchBuffer = async (url) => {
    downloads++;
    return gif([{ color: url.endsWith("b") ? 1 : 0 }, {}]);
  };
  const media = new MediaStore(root, { fetchBuffer });
  const e = event();
  e.payload.segments.push({
    type: "image",
    data: { url: "https://example.com/b" },
  });
  const a = await media.fromMessage("a", e, 0);
  const b = await media.fromMessage("a", e, 1);
  assert.notEqual(a.id, b.id);
  assert.equal((await media.fromMessage("a", e, 0)).id, a.id);
  assert.equal(
    (await new MediaStore(root, { fetchBuffer }).fromMessage("a", e, 1)).id,
    b.id,
  );
  assert.equal(downloads, 2);
  await media.fromMessage("b", e, 0);
  await media.fromMessage("a", event("another-event"), 0);
  assert.equal(downloads, 4);
});

test("cancelled downloads never enter the media cache and admission is bounded", async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const root = temp(t),
    controller = new AbortController();
  const media = new MediaStore(root, {
    fetchBuffer: async () => {
      await gate;
      return gif([{}, {}]);
    },
  });
  const first = media.fromMessage("a", event("first"), 0, {
    signal: controller.signal,
  });
  const rejected = assert.rejects(first, /ABORTED/);
  const second = media.fromMessage("a", event("second"));
  await assert.rejects(
    media.fromMessage("b", event("third")),
    /IMAGE_DOWNLOAD_BUSY/,
  );
  controller.abort();
  release();
  await rejected;
  await second;
  assert.equal(
    fs.readdirSync(path.join(root, "a")).filter((f) => f.endsWith(".json"))
      .length,
    1,
  );
  await media.fromMessage("b", event("third"));
});

test("declared oversized originals fail before networking and static output stays bounded", async (t) => {
  let calls = 0;
  const media = new MediaStore(temp(t), {
    fetchBuffer: async () => {
      calls++;
      throw Error("UNEXPECTED");
    },
  });
  const e = event();
  e.payload.segments[0].data.file_size = 21 * 1024 * 1024;
  await assert.rejects(media.fromMessage("a", e), /IMAGE_TOO_LARGE/);
  assert.equal(calls, 0);
  const huge = Buffer.concat([gif([{}, {}]), Buffer.alloc(21 * 1024 * 1024)]);
  assert.throws(() => media.put("a", huge, "image/gif"), /IMAGE_TOO_LARGE/);
  const png = Buffer.alloc(9 * 1024 * 1024);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  assert.throws(() => media.put("a", png, "image/png"), /IMAGE_TOO_LARGE/);
  const one = largeGif();
  const saved = media.put("a", one, "image/gif");
  // The large-GIF allowance does not widen static image or decoder output limits.
  const staticGif = Buffer.concat([
    gif([{}]).subarray(0, -1),
    one.subarray(gif([{}, { color: 1 }, { color: 2 }]).length - 1),
  ]);
  const still = media.put("a", staticGif, "image/gif");
  await assert.rejects(media.view("a", still.id), /IMAGE_OUTPUT_LIMIT/);
  assert.equal(
    JSON.parse((await media.view("a", saved.id)).content[0].text).animation
      .frameCount,
    3,
  );
});

async function attachmentFixture(t, opts = {}) {
  const cfg = config(2);
  cfg.agents[0].tools.push("qq_image_read", "file_download", "sticker_read");
  cfg.agents[0].files.enabled = true;
  const f = fixture(t, { cfg });
  f.runtime.media = new MediaStore(path.join(f.root, "media"));
  f.runtime.files = new FileStore(path.join(f.root, "files"), {
    download:
      opts.download || (async () => ({ buffer: gif([{}, { color: 1 }]) })),
  });
  const ctx = context(f.runtime);
  const e = f.store.bind(ctx.agentId).append({
    dedupe: "file-gif",
    connectionId: "qq-0",
    conversation: ctx.conversation,
    kind: "notice.file",
    body: "[file]",
    payload: {
      segments: [
        {
          type: "file",
          data: { id: "synthetic-file", name: "animation.gif" },
        },
      ],
    },
  });
  const requests = [];
  f.runtime.transports.get("qq-0").call = async (action, args) => {
    requests.push({ action, args });
    return { url: "https://example.com/attachment.gif" };
  };
  return { ...f, ctx, event: e, requests };
}

test("GIF file notices use the authorized attachment URL route and return frames", async (t) => {
  const f = await attachmentFixture(t);
  const result = await f.runtime.callTool(f.ctx, "qq_image_read", {
    id: f.event.id,
  });
  assert.equal(images(result).length, 2);
  assert.equal(f.requests[0].action, "get_group_file_url");
  assert.equal(f.requests[0].args.file_id, "synthetic-file");
  assert.equal(f.requests[0].args.group_id, "20000");
  const id = JSON.parse(result.content[0].text).id;
  assert(
    f.runtime.media
      .metadata(f.ctx.agentId, id)
      .sources.some((s) => s.eventId === f.event.id),
  );
  assert.equal(
    images(await f.runtime.callTool(f.ctx, "sticker_read", { mediaId: id }))
      .length,
    2,
  );
});

test("NapCat file segments expose their filename and image pixels", async (t) => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=",
    "base64",
  );
  const f = await attachmentFixture(t, {
    download: async () => ({ buffer: png }),
  });
  const incoming = normalizeEvent(
    raw(9, {
      message_type: "private",
      group_id: undefined,
      message: [
        {
          type: "file",
          data: {
            file: "photo.png",
            file_id: "observed-file",
            file_size: "68",
          },
        },
      ],
    }),
    { accountId: "10000" },
  );
  const e = f.store.bind("agent-0").append({
    dedupe: "napcat-file",
    connectionId: "qq-0",
    conversation: incoming.conversation,
    kind: incoming.kind,
    body: incoming.body,
    payload: { segments: incoming.segments },
  });
  const ctx = context(f.runtime, "agent-0", incoming.conversation);
  const result = await f.runtime.callTool(ctx, "qq_image_read", { id: e.id });
  assert.equal(images(result).length, 1);
  assert.equal(images(result)[0].mimeType, "image/png");
  assert.deepEqual(Buffer.from(images(result)[0].data, "base64"), png);
  assert.match(incoming.body, /photo\.png/);
  assert.equal(f.runtime.files.list("agent-0").items[0].name, "photo.png");
});

test("attachment image reading cannot bypass file permissions, tool grants or source ownership", async (t) => {
  for (const deny of [
    "receive",
    "tool",
    "source",
    "connection",
    "other-agent",
  ]) {
    const f = await attachmentFixture(t);
    if (deny === "receive") f.runtime.agent("agent-0").files.receive = false;
    if (deny === "tool") f.runtime.agent("agent-0").tools = ["qq_image_read"];
    if (deny === "source") {
      f.ctx = context(f.runtime, "agent-0", "group:20001");
      f.runtime.agent("agent-0").allow.groups = ["20001"];
    }
    if (deny === "connection") f.runtime.agent("agent-0").connectionId = "qq-1";
    if (deny === "other-agent") {
      f.runtime.agent("agent-1").tools.push("qq_image_read");
      f.ctx = context(f.runtime, "agent-1");
    }
    await assert.rejects(
      f.runtime.callTool(f.ctx, "qq_image_read", { id: f.event.id }),
      /PERMISSION|DISABLED|DENIED|PAUSED|NOT_FOUND/,
    );
    assert.equal(f.requests.length, 0);
  }
});

test("file images retain prior private and operations provenance after content deduplication", async (t) => {
  const f = await attachmentFixture(t);
  f.runtime.files.put(
    "agent-0",
    gif([{}, { color: 1 }]),
    "old.gif",
    f.runtime.agent("agent-0").files,
    { conversation: "private:30000", eventId: "private-source" },
    true,
  );
  await assert.rejects(
    f.runtime.callTool(f.ctx, "qq_image_read", { id: f.event.id }),
    /RECALL_SOURCE_NOT_ALLOWED/,
  );
  assert(![...f.ctx.privateRead].some((id) => id.startsWith("operations:")));
});

test("image cache preserves origins and does not confuse old unindexed metadata with image zero", async (t) => {
  const f = await attachmentFixture(t);
  let calls = 0;
  const bytes = gif([{}, { color: 1 }]);
  f.runtime.media = new MediaStore(path.join(f.root, "images"), {
    fetchBuffer: async () => {
      calls++;
      return bytes;
    },
  });
  const e = f.store.bind("agent-0").append({
    dedupe: "image",
    kind: "message.received",
    conversation: f.ctx.conversation,
    payload: event().payload,
  });
  const media = f.runtime.media.put("agent-0", bytes, "image/gif", {
    conversation: "private:30000",
    sourceEventId: "old-private",
    protectedOperations: true,
  });
  f.runtime.media.put("agent-0", bytes, "image/gif", {
    conversation: f.ctx.conversation,
    sourceEventId: e.id,
  });
  for (let i = 0; i < 2; i++) {
    const ctx = context(f.runtime);
    await assert.rejects(
      f.runtime.callTool(ctx, "qq_image_read", { id: e.id }),
      /RECALL_SOURCE_NOT_ALLOWED/,
    );
    assert(!ctx.privateRead.has("old-private"));
    assert(!ctx.privateRead.has("operations:media:" + media.id));
  }
  assert.equal(calls, 1);
});

test("image and file segment selection is explicit and file size policy still applies", async (t) => {
  const f = await attachmentFixture(t);
  const e = f.store.bind("agent-0").append({
    dedupe: "mixed",
    connectionId: "qq-0",
    kind: "message.received",
    conversation: f.ctx.conversation,
    payload: {
      segments: [
        ...event().payload.segments,
        {
          type: "file",
          data: { id: "file", name: "animation.gif", size: 4096 },
        },
      ],
    },
  });
  f.runtime.media.fetchBuffer = async () => gif([{}]);
  assert.equal(
    images(await f.runtime.callTool(f.ctx, "qq_image_read", { id: e.id }))
      .length,
    1,
  );
  assert.equal(f.requests.length, 0);
  assert.equal(
    images(
      await f.runtime.callTool(f.ctx, "qq_image_read", {
        id: e.id,
        source: "file",
      }),
    ).length,
    2,
  );
  f.runtime.agent("agent-0").files.maxBytes = 1024;
  await assert.rejects(
    f.runtime.callTool(f.ctx, "qq_image_read", { id: e.id, source: "file" }),
    /IMAGE_TOO_LARGE/,
  );
  assert.equal(f.requests.length, 1);
});

test("late attachment downloads and fake GIF payloads cannot become readable media", async (t) => {
  const f = await attachmentFixture(t, {
    download: async () => ({ buffer: Buffer.from("not an image") }),
  });
  await assert.rejects(
    f.runtime.callTool(f.ctx, "qq_image_read", { id: f.event.id }),
    /INVALID_IMAGE/,
  );
  let started, release;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const g = await attachmentFixture(t, {
    download: async () => {
      started();
      await new Promise((resolve) => {
        release = resolve;
      });
      return { buffer: gif([{}, {}]) };
    },
  });
  const job = g.runtime.callTool(g.ctx, "qq_image_read", { id: g.event.id });
  const failure = assert.rejects(job, /PAUSED_OR_EXPIRED|ABORTED/);
  await ready;
  await g.runtime.pause("agent-0");
  release();
  await failure;
  assert.equal(g.runtime.files.list("agent-0").total, 0);
  assert(!fs.existsSync(path.join(g.root, "media", "agent-0")));
});

test("download failures give bounded actionable hints without URLs or credentials", () => {
  for (const code of [
    "IMAGE_DOWNLOAD_TIMEOUT",
    "IMAGE_TOO_LARGE",
    "IMAGE_DOWNLOAD_HTTP_ERROR",
    "IMAGE_NOT_FOUND",
    "IMAGE_ATTACHMENT_REQUIRED",
  ]) {
    const result = safeToolFailure(Error(code));
    assert.equal(result.code, code);
    assert(!result.hint.includes("unknown delivery"));
    assert(result.hint.length > 30);
  }
});
