import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { FileStore, fileName } from "../src/tools/files.mjs";
import { downloadFile, requestFile } from "../src/tools/file-download.mjs";
import { FILE_TOOL_NAMES } from "../src/tools/file-tools.mjs";
import { filesSchema } from "../src/core/policy.mjs";
import { OneBot, normalizeEvent } from "../src/transport/onebot.mjs";
import { createServer } from "../src/server.mjs";
import { ConfigStore } from "../src/core/config.mjs";
import { config, fixture, temp, raw } from "./helpers.mjs";

test("local directory grants cannot import another agent's library", (t) => {
  const root = temp(t),
    library = new FileStore(path.join(root, "files")),
    policy = filesSchema.parse({ localRoots: [root] });
  const file = library.put(
    "agent-b",
    Buffer.from("other agent"),
    "other.txt",
    policy,
  );
  assert.throws(
    () =>
      library.import("agent-a", 0, `files/agent-b/${file.fileId}.bin`, policy),
    /FILE_PATH_DENIED/,
  );
});

test("revocation prevents queued uploads while preserving an already confirmed in-flight receipt", async (t) => {
  const { runtime, ctx, store, configStore } = await setup(t);
  const file = await call(runtime, ctx, "file_create", {
    name: "a.txt",
    text: "bytes",
  });
  let finish,
    started,
    sends = 0;
  const ready = new Promise((r) => {
    started = r;
  });
  runtime.transports.get("qq-0").sendFile = () => {
    sends++;
    started();
    return new Promise((r) => {
      finish = r;
    });
  };
  const first = call(runtime, ctx, "qq_send_file", {
    requestId: "first",
    fileId: file.fileId,
  });
  await ready;
  const queued = call(runtime, ctx, "qq_send_file", {
    requestId: "queued",
    fileId: file.fileId,
  });
  const rejection = assert.rejects(queued, /PAUSED_OR_EXPIRED/);
  await runtime.changeFilePermissions(
    "agent-0",
    { enabled: false },
    configStore.revision,
  );
  finish({ confirmed: true, fileId: "receipt" });
  assert.equal((await first).status, "sent");
  await rejection;
  assert.equal(sends, 1);
  assert.equal(store.bind("agent-0").delivery("first").status, "sent");
  assert.equal(store.bind("agent-0").delivery("queued"), undefined);
});

async function setup(t, options = {}) {
  const cfg = config(2);
  for (const a of cfg.agents) {
    a.files.enabled = true;
    a.tools.push(...FILE_TOOL_NAMES);
  }
  const f = fixture(t, { cfg });
  f.runtime.files = new FileStore(path.join(f.root, "files"), options);
  return { ...f, ctx: f.runtime.makeContext("agent-0", "group:20000") };
}
const call = (r, c, name, args = {}) => r.callTool(c, name, args);

test("generated text files enforce the same credential filter as QQ text before registration", async (t) => {
  const { runtime, ctx } = await setup(t);
  for (const text of [
    ctx.token,
    "sk-" + "x".repeat(24),
    "Bearer " + "b".repeat(24),
    "ghp_" + "c".repeat(24),
  ]) {
    await assert.rejects(
      runtime.send(ctx, { requestId: "blocked-text", text }),
      /SENSITIVE_OUTPUT_BLOCKED/,
    );
    await assert.rejects(
      call(runtime, ctx, "file_create", { name: "notes.txt", text }),
      text === ctx.token
        ? /CAPABILITY_EXFILTRATION_BLOCKED/
        : /SENSITIVE_OUTPUT_BLOCKED/,
    );
  }
  assert.equal(runtime.files.list(ctx.agentId).total, 0);
  assert.equal(runtime.transports.get("qq-0").sent.length, 0);
  const safe = await call(runtime, ctx, "file_create", {
    name: "notes.txt",
    text: "普通文件内容",
  });
  assert.equal(
    runtime.files.read(ctx.agentId, safe.fileId, 1024).buffer.toString(),
    "普通文件内容",
  );
  assert.equal(runtime.operations.pending.size, 0);
});

test("file permissions default off; admin enables each agent independently without changing pauses or connections", async (t) => {
  const { runtime, configStore } = fixture(t);
  assert.equal(runtime.agent("agent-0").files.enabled, false);
  const connection = runtime.transports.get("qq-0");
  await runtime.pause("all", true);
  const before = configStore.revision;
  await runtime.changeFilePermissions("agent-0", { enabled: true }, before);
  assert.equal(runtime.config.globalPaused, true);
  assert.equal(runtime.agent("agent-1").files.enabled, false);
  assert.ok(
    FILE_TOOL_NAMES.every((name) =>
      runtime.agent("agent-0").tools.includes(name),
    ),
  );
  assert.equal(runtime.transports.get("qq-0"), connection);
  assert.equal(runtime.operations.pending.size, 0);
  await assert.rejects(
    runtime.changeFilePermissions("agent-0", {}, before),
    /CONFIG_CONFLICT/,
  );
  const reopened = new ConfigStore(configStore.file);
  assert.equal(reopened.value.agents[0].files.enabled, true);
});

test("independent persistent libraries, quota/dedup, filename and byte integrity", (t) => {
  const root = temp(t),
    store = new FileStore(root),
    policy = filesSchema.parse({
      maxBytes: 1024,
      maxTotalBytes: 1024,
      maxFiles: 1,
    });
  const first = store.put(
    "agent-a",
    Buffer.from("独立文件"),
    "资料.txt",
    policy,
  );
  assert.throws(
    () => store.read("agent-b", first.fileId, 1024),
    /FILE_NOT_FOUND/,
  );
  store.put("agent-a", Buffer.from("独立文件"), "改名.txt", policy);
  assert.equal(store.list("agent-a").storedFiles, 1);
  assert.throws(
    () => store.put("agent-a", Buffer.from("different"), "other.txt", policy),
    /QUOTA/,
  );
  assert.throws(
    () => store.put("agent-a", Buffer.alloc(1025), "large.bin", policy),
    /TOO_LARGE/,
  );
  for (const name of ["../x", "x/y", "x\\y", ".env", "a\r\nb", "a\u202eb"])
    assert.throws(() => fileName(name), /INVALID_FILE_NAME/);
  const reopened = new FileStore(root);
  assert.equal(
    reopened.read("agent-a", first.fileId, 1024).buffer.toString(),
    "独立文件",
  );
  fs.writeFileSync(
    path.join(root, "agent-a", first.fileId + ".bin"),
    "modified",
  );
  assert.throws(
    () => reopened.read("agent-a", first.fileId, 1024),
    /INTEGRITY/,
  );
});

test("local imports allow dedicated roots, reject traversal, symlinks, hardlinks and credentials", (t) => {
  const root = temp(t),
    exports = path.join(root, "exports"),
    store = new FileStore(path.join(root, "library"));
  fs.mkdirSync(exports);
  fs.writeFileSync(path.join(exports, "report.txt"), "report");
  fs.writeFileSync(path.join(root, "outside.txt"), "outside");
  fs.symlinkSync(
    path.join(root, "outside.txt"),
    path.join(exports, "link.txt"),
  );
  fs.linkSync(path.join(root, "outside.txt"), path.join(exports, "hard.txt"));
  fs.writeFileSync(path.join(exports, "credentials.json"), "private");
  const policy = filesSchema.parse({ localRoots: [exports] });
  assert.equal(
    store.import("agent-a", 0, "report.txt", policy).name,
    "report.txt",
  );
  for (const file of [
    "../outside.txt",
    path.join(root, "outside.txt"),
    "link.txt",
    "hard.txt",
    "credentials.json",
    ".env",
  ])
    assert.throws(
      () => store.import("agent-a", 0, file, policy),
      /PATH_DENIED/,
    );
  assert.throws(
    () => store.import("agent-a", 1, "report.txt", policy),
    /PATH_DENIED/,
  );
});

test("file creation and autonomous send use current conversation, receipts and existing idempotency", async (t) => {
  const { runtime, ctx, store } = await setup(t),
    sends = [];
  runtime.transports.get("qq-0").sendFile = async (
    conversation,
    buffer,
    name,
  ) => {
    sends.push({ conversation, text: buffer.toString(), name });
    return { confirmed: true, fileId: "qq-file-fixture" };
  };
  const meta = await call(runtime, ctx, "file_create", {
    name: "总结.md",
    text: "本周总结",
  });
  const input = { requestId: "send-once", fileId: meta.fileId };
  assert.equal(
    (await call(runtime, ctx, "qq_send_file", input)).gatewayFileId,
    "qq-file-fixture",
  );
  assert.equal(
    (await call(runtime, ctx, "qq_send_file", input)).duplicate,
    true,
  );
  assert.deepEqual(sends, [
    { conversation: "group:20000", text: "本周总结", name: "总结.md" },
  ]);
  assert.equal(runtime.operations.pending.size, 0);
  assert.equal(runtime.status().disclosureRequests.length, 0);
  assert.equal(store.bind("agent-0").delivery("send-once").status, "sent");
  const other = runtime.makeContext("agent-1", "group:20000");
  await assert.rejects(
    call(runtime, other, "qq_send_file", { ...input, requestId: "other" }),
    /FILE_NOT_FOUND/,
  );
  await assert.rejects(
    call(runtime, ctx, "qq_send_file", { ...input, userId: "30000" }),
  );
  await assert.rejects(
    call(runtime, ctx, "file_create", { name: "fake.pdf", text: "text" }),
    /EXTENSION/,
  );
});

test("unknown/rejected file sends are not retried and count against limits", async (t) => {
  const { runtime, ctx } = await setup(t);
  const file = await call(runtime, ctx, "file_create", {
    name: "a.txt",
    text: "data",
  });
  let count = 0;
  runtime.transports.get("qq-0").sendFile = async () => {
    count++;
    throw Error("timeout");
  };
  await assert.rejects(
    call(runtime, ctx, "qq_send_file", {
      fileId: file.fileId,
      requestId: "unknown",
    }),
    /DELIVERY_UNKNOWN/,
  );
  await assert.rejects(
    call(runtime, ctx, "qq_send_file", {
      fileId: file.fileId,
      requestId: "unknown",
    }),
    /ALREADY_ATTEMPTED_UNKNOWN/,
  );
  assert.equal(count, 1);
  runtime.agent("agent-0").maxSendsPerTurn = 1;
  await assert.rejects(
    call(runtime, ctx, "qq_send_file", {
      fileId: file.fileId,
      requestId: "later",
    }),
    /TURN_SEND_LIMIT/,
  );
});

test("permission revocation cancels in-flight download and cannot register bytes after returning", async (t) => {
  let finish, started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const { runtime, ctx, configStore } = await setup(t, {
    download: () => {
      started();
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  const pending = call(runtime, ctx, "file_download", {
    url: "https://example.org/file.txt",
  });
  await ready;
  await assert.rejects(
    call(runtime, ctx, "file_download", {
      url: "https://example.org/other.txt",
    }),
    /BUSY/,
  );
  await runtime.changeFilePermissions(
    "agent-0",
    { enabled: false },
    configStore.revision,
  );
  finish({ buffer: Buffer.from("late"), origin: "https://example.org" });
  await assert.rejects(pending, /PAUSED_OR_EXPIRED/);
  assert.equal(runtime.files.list("agent-0").storedFiles, 0);
  assert.equal(ctx.controller.signal.aborted, true);
});

test("each permission is enforced and normal cross-chat recollection does not demand download confirmation", async (t) => {
  const { runtime, ctx } = await setup(t, {
    download: async () => ({
      buffer: Buffer.from("downloaded"),
      origin: "https://example.org",
    }),
  });
  ctx.privateRead.add("ordinary-recollection");
  const result = await call(runtime, ctx, "file_download", {
    url: "https://example.org/report.txt",
  });
  assert.equal(result.contentRead, false);
  runtime.agent("agent-0").files.download = false;
  await assert.rejects(
    call(runtime, ctx, "file_download", {
      url: "https://example.org/report.txt",
    }),
    /PERMISSION_DISABLED/,
  );
  runtime.agent("agent-0").files.send = false;
  await assert.rejects(
    call(runtime, ctx, "qq_send_file", {
      fileId: result.fileId,
      requestId: "disabled",
    }),
    /PERMISSION_DISABLED/,
  );
  runtime.agent("agent-0").files.create = false;
  await assert.rejects(
    call(runtime, ctx, "file_create", { name: "a.txt", text: "x" }),
    /PERMISSION_DISABLED/,
  );
  await runtime.pause("agent-0", true);
  await assert.rejects(call(runtime, ctx, "file_list"), /PAUSED_OR_EXPIRED/);
});

test("received QQ files bind to observed source; expired URLs refresh without accepting arbitrary file IDs", async (t) => {
  const urls = [],
    gateway = [];
  const { runtime, ctx, store } = await setup(t, {
    download: async (url) => {
      urls.push(url);
      if (url.includes("expired")) throw Error("FILE_DOWNLOAD_HTTP_ERROR");
      return {
        buffer: Buffer.from("QQ document"),
        origin: "https://example.org",
      };
    },
  });
  runtime.transports.get("qq-0").call = async (action, args) => {
    gateway.push({ action, args });
    return { url: "https://example.org/fresh" };
  };
  const event = store.bind("agent-0").append({
    dedupe: "attachment",
    conversation: "group:20000",
    connectionId: "qq-0",
    kind: "message.received",
    body: "[文件]",
    payload: {
      segments: [
        {
          type: "file",
          data: {
            file_id: "observed-id",
            name: "文档.pdf",
            url: "https://example.org/expired",
          },
        },
      ],
    },
  });
  const result = await call(runtime, ctx, "file_download", {
    eventId: event.id,
  });
  assert.equal(result.name, "文档.pdf");
  assert.equal(result.sources[0].eventId, event.id);
  assert.equal(urls.length, 2);
  assert.deepEqual(gateway, [
    {
      action: "get_group_file_url",
      args: { file_id: "observed-id", group_id: "20000", busid: 102 },
    },
  ]);
  await assert.rejects(
    call(runtime, ctx, "file_download", {
      eventId: event.id,
      fileId: "guessed",
    }),
  );
  await assert.rejects(
    call(
      runtime,
      runtime.makeContext("agent-1", "group:20000"),
      "file_download",
      { eventId: event.id },
    ),
    /RECORD_NOT_FOUND/,
  );
});

test("group uploads and offline files become visible attachment events", () => {
  for (const notice of ["group_upload", "offline_file"]) {
    const input = raw(1, {
      post_type: "notice",
      notice_type: notice,
      message: undefined,
      file: { id: "fixture", name: "附件.txt" },
    });
    if (notice === "offline_file") {
      delete input.group_id;
      input.message_type = "private";
    }
    const event = normalizeEvent(input, { accountId: "10000" });
    assert.equal(event.kind, "notice.file");
    assert.equal(event.segments[0].type, "file");
    assert.match(event.body, /尚未下载或阅读/);
  }
});

test("operations-derived files retain disclosure restriction across persistence", async (t) => {
  const { runtime, ctx } = await setup(t);
  ctx.privateRead.add("operations:fixture");
  const file = await call(runtime, ctx, "file_create", {
    name: "ops.txt",
    text: "protected",
  });
  const fresh = runtime.makeContext("agent-0", "private:30000");
  await assert.rejects(
    call(runtime, fresh, "qq_send_file", {
      fileId: file.fileId,
      requestId: "ops",
    }),
    /DISCLOSURE_GRANT/,
  );
});

test("URL download blocks internal schemes, redirect to private hosts, and repeated redirects", async () => {
  for (const url of [
    "file:///tmp/a",
    "http://127.0.0.1/a",
    "http://[::1]/a",
    "http://10.0.0.1/a",
    "https://user:pass@example.org/a",
  ])
    await assert.rejects(downloadFile(url, { maxBytes: 1024 }), /URL_DENIED/);
  let calls = 0;
  await assert.rejects(
    downloadFile(
      "https://93.184.216.34/a",
      { maxBytes: 1024 },
      {
        request: async () => {
          calls++;
          return { redirect: "http://127.0.0.1/private" };
        },
      },
    ),
    /URL_DENIED/,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    downloadFile(
      "https://93.184.216.34/a",
      { maxBytes: 1024 },
      { request: async () => ({ redirect: "/again" }) },
    ),
    /REDIRECT_LIMIT/,
  );
});

test("real HTTP download bounds bytes, pins DNS and aborts cancellation", async (t) => {
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, undefined);
    if (req.url === "/chunked") {
      res.writeHead(200);
      res.end(Buffer.alloc(2048));
    } else if (req.url === "/length") {
      res.writeHead(200, { "content-length": 2048 });
      res.end(Buffer.alloc(2048));
    } else if (req.url === "/slow") {
      res.writeHead(200);
      res.write("start");
    } else res.end("pinned bytes");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://public-fixture.invalid:${server.address().port}`;
  const run = (suffix, signal = AbortSignal.timeout(2000)) =>
    requestFile(new URL(base + suffix), ["127.0.0.1"], {
      maxBytes: 1024,
      signal,
    });
  assert.equal((await run("/ok")).buffer.toString(), "pinned bytes");
  await assert.rejects(run("/chunked"), /TOO_LARGE/);
  await assert.rejects(run("/length"), /TOO_LARGE/);
  await assert.rejects(
    run("/slow", AbortSignal.timeout(30)),
    /CANCELLED|FAILED/,
  );
});

test("real isolated OneBot HTTP uploads exact bytes to group/private routes and requires file receipts", async (t) => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    requests.push({ action: req.url, data: JSON.parse(Buffer.concat(chunks)) });
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        status: "ok",
        retcode: 0,
        data: requests.length === 3 ? {} : { file_id: "confirmed" },
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const bot = new OneBot({
    httpUrl: `http://127.0.0.1:${server.address().port}`,
  });
  for (const conversation of ["group:20000", "private:30000"])
    assert.equal(
      (await bot.sendFile(conversation, Buffer.from("隔离附件"), "附件.txt"))
        .confirmed,
      true,
    );
  assert.deepEqual(
    requests.map((r) => r.action),
    ["/upload_group_file", "/upload_private_file"],
  );
  assert.equal(
    Buffer.from(requests[0].data.file.slice(9), "base64").toString(),
    "隔离附件",
  );
  assert.equal(requests[0].data.group_id, "20000");
  assert.equal(requests[1].data.user_id, "30000");
  await assert.rejects(
    bot.sendFile("group:20000", Buffer.from("x"), "a.txt"),
    /UNCONFIRMED/,
  );
});

test("admin HTTP permission API and uploads require authentication; both libraries remain distinct", async (t) => {
  const { runtime, configStore } = await setup(t),
    token = "test-admin-file-permissions";
  const app = createServer({ runtime, token }),
    port = await app.listen();
  t.after(() => app.close());
  const base = `http://127.0.0.1:${port}`;
  const request = (url, data, method = "POST", auth = true) =>
    fetch(base + url, {
      method,
      headers: auth ? { "x-admin-token": token } : {},
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
  const policy = {
    agentId: "agent-0",
    files: { enabled: true, send: false },
    revision: configStore.revision,
  };
  assert.equal(
    (await request("/api/permissions/files", policy, "PUT", false)).status,
    401,
  );
  assert.equal(
    (await request("/api/permissions/files", policy, "PUT")).status,
    200,
  );
  assert.equal(runtime.agent("agent-0").files.send, false);
  assert.equal(
    (await request("/api/permissions/files", policy, "PUT")).status,
    409,
  );
  const result = await request("/api/files/import", {
    agentId: "agent-0",
    name: "报告.txt",
    base64: Buffer.from("资料").toString("base64"),
  });
  assert.equal(result.status, 200);
  const file = await result.json();
  const download = await request(
    `/api/files/download?agentId=agent-0&fileId=${file.fileId}`,
    null,
    "GET",
  );
  assert.equal(await download.text(), "资料");
  assert.match(download.headers.get("content-disposition"), /attachment/);
  assert.equal(
    (
      await request(
        `/api/files/download?agentId=agent-1&fileId=${file.fileId}`,
        null,
        "GET",
      )
    ).status,
    400,
  );
  assert.equal(
    (await request("/api/files?agentId=agent-1", null, "GET")).status,
    200,
  );
  assert.equal(
    (
      await request("/api/files/import", {
        agentId: "agent-0",
        name: "bad.txt",
        base64: "%%%",
      })
    ).status,
    400,
  );
});
