import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { fixture, config, context } from "./helpers.mjs";
import { FileStore } from "../src/tools/files.mjs";
import { MediaStore } from "../src/tools/media.mjs";
import { screenshotRoutes } from "../src/tools/public-screenshot.mjs";
import { screenshotAppPage } from "../src/apps/screenshot-page.mjs";
import { AppBrowsing } from "../src/apps/service.mjs";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
function setup(t) {
  const cfg = config(2);
  for (const a of cfg.agents) {
    a.files.enabled = true;
    a.network.autonomous = true;
    a.apps.enabled = true;
    a.apps.platforms = ["bilibili"];
    a.apps.hours.enabled = false;
    a.tools.push(
      "file_download",
      "file_list",
      "file_import",
      "qq_send_file",
      "image_save",
      "media_list",
      "sticker_read",
      "web_screenshot",
      "app_screenshot",
    );
  }
  const f = fixture(t, { cfg });
  f.runtime.media = new MediaStore(path.join(f.root, "media"));
  f.runtime.files = new FileStore(path.join(f.root, "files"), {
    download: async () => ({ buffer: png, origin: "https://example.org" }),
  });
  return { ...f, ctx: context(f.runtime) };
}
test("a public image is retained as owned media and original file, discoverable and sendable after reload", async (t) => {
  const f = setup(t);
  const image = await f.runtime.callTool(f.ctx, "image_save", {
    url: "https://example.org/picture.png",
    title: "保存的图片",
  });
  assert.match(image.mediaId, /^[a-f0-9]{64}$/);
  assert.match(image.fileId, /^[a-f0-9]{64}$/);
  f.runtime.media = new MediaStore(path.join(f.root, "media"));
  f.runtime.files = new FileStore(path.join(f.root, "files"));
  const found = await f.runtime.callTool(f.ctx, "media_list", {
    query: "保存",
  });
  assert.equal(found.items[0].mediaId, image.mediaId);
  assert(!JSON.stringify(found).includes(f.root));
  assert.equal(
    (
      await f.runtime.callTool(f.ctx, "qq_send", {
        requestId: "image",
        mediaId: image.mediaId,
      })
    ).status,
    "sent",
  );
  let sentFile;
  f.runtime.transports.get("qq-0").sendFile = async (conversation, buffer) => {
    sentFile = buffer;
    return { confirmed: true, messageId: "fixture-file" };
  };
  assert.equal(
    (
      await f.runtime.callTool(f.ctx, "qq_send_file", {
        requestId: "file",
        fileId: image.fileId,
      })
    ).status,
    "sent",
  );
  assert.deepEqual(sentFile, png);
  const peer = context(f.runtime, "agent-1");
  assert.equal(
    (await f.runtime.callTool(peer, "media_list", {})).items.length,
    0,
  );
  await assert.rejects(
    f.runtime.callTool(peer, "image_save", { fileId: image.fileId }),
    /FILE_NOT_FOUND/,
  );
});
test("saved media respects file permission, quotas and invalid image bytes without opening local directories", async (t) => {
  const f = setup(t);
  for (const args of [
    { url: "file:///private/tmp/secret.png" },
    { path: "/private/tmp/secret.png" },
    { fileId: "../../secret" },
  ]) {
    if (args.url)
      f.runtime.files.download = async () => {
        throw Error("FILE_URL_DENIED");
      };
    await assert.rejects(f.runtime.callTool(f.ctx, "image_save", args));
  }
  await assert.rejects(
    f.runtime.callTool(f.ctx, "file_import", {
      rootIndex: 0,
      relativePath: "secret.png",
    }),
    /FILE_PATH_DENIED/,
  );
  f.runtime.files.download = async () => ({
    buffer: Buffer.from("<html>challenge</html>"),
  });
  await assert.rejects(
    f.runtime.callTool(f.ctx, "image_save", {
      url: "https://example.org/no.png",
    }),
    /INVALID_IMAGE/,
  );
  assert.equal(f.runtime.media.saved(f.ctx.agentId).items.length, 0);
  f.runtime.agent(f.ctx.agentId).files.download = false;
  await assert.rejects(
    f.runtime.callTool(f.ctx, "image_save", {
      url: "https://example.org/no.png",
    }),
    /FILE_PERMISSION_DISABLED/,
  );
});
test("screenshots write only to owned libraries and cancellation does not register late bytes", async (t) => {
  const f = setup(t);
  f.runtime.capturePublicPage = async (url, options) => {
    assert.equal(options.root, f.runtime.files.dir(f.ctx.agentId));
    return { buffer: png, url, scope: "public-page-viewport" };
  };
  const image = await f.runtime.callTool(f.ctx, "web_screenshot", {
    url: "https://example.org/page",
  });
  assert.equal(image.scope, "public-page-viewport");
  assert.equal(
    f.runtime.media.saved(f.ctx.agentId).items[0].kind,
    "screenshot",
  );
  assert(
    fs.existsSync(
      path.join(f.runtime.files.dir(f.ctx.agentId), image.fileId + ".bin"),
    ),
  );
  f.runtime.capturePublicPage = async () => {
    f.ctx.controller.abort();
    return { buffer: png };
  };
  await assert.rejects(
    f.runtime.callTool(f.ctx, "web_screenshot", {
      url: "https://example.org/late",
    }),
    /PAUSED|EXPIRED/,
  );
  assert.equal(f.runtime.files.list(f.ctx.agentId).total, 1);
});
test("public screenshot routing pins every resource and redirect, sends no browser credentials and blocks local or write requests", async () => {
  let calls = 0,
    fulfilled,
    aborted = 0;
  const page = {},
    frame = { page: () => page };
  page.mainFrame = () => frame;
  let url = "https://example.org/page",
    method = "GET";
  const route = {
    request: () => ({
      url: () => url,
      method: () => method,
      isNavigationRequest: () => true,
      frame: () => frame,
    }),
    fulfill: async (x) => {
      fulfilled = x;
    },
    abort: async () => {
      aborted++;
    },
  };
  const routes = screenshotRoutes({
    signal: new AbortController().signal,
    validate: async (raw) => {
      const u = new URL(raw);
      if (u.hostname !== "example.org" || u.protocol !== "https:")
        throw Error("private");
      return { url: u, addresses: ["93.184.216.34"] };
    },
    request: async (u, addresses, options) => {
      calls++;
      assert.deepEqual(addresses, ["93.184.216.34"]);
      assert.equal(options.headers, undefined);
      return u.pathname === "/redirect"
        ? { redirect: "http://127.0.0.1/private" }
        : { buffer: Buffer.from("<p>public</p>"), contentType: "text/html" };
    },
  });
  await routes.handle(route);
  assert.equal(fulfilled.status, 200);
  url = "https://example.org/redirect";
  await routes.handle(route);
  assert.equal(aborted, 1);
  url = "file:///private/tmp/secret";
  await routes.handle(route);
  method = "POST";
  url = "https://example.org/write";
  await routes.handle(route);
  assert.equal(calls, 2);
  assert.equal(aborted, 3);
  assert.equal(routes.documentError, "SCREENSHOT_PAGE_UNAVAILABLE");
});
test("App screenshots capture only their bound content page, never an unrelated tab or desktop", async () => {
  let location,
    captures = 0;
  const job = {
    platform: "bilibili",
    url: "https://www.bilibili.com/video/BV1xx411c7mD",
  };
  const page = {
    goto: async (url) => {
      location = url;
    },
    evaluate: async () => location,
    screenshot: async (opts) => {
      captures++;
      assert.deepEqual(opts, {
        format: "png",
        fullPage: false,
        width: 1280,
        height: 900,
      });
      return png.toString("base64");
    },
  };
  assert((await screenshotAppPage(page, job)).data);
  page.evaluate = async () => "https://www.bilibili.com/video/BV1yy411c7mD";
  await assert.rejects(
    screenshotAppPage(page, job),
    /APP_SCREENSHOT_TARGET_MISMATCH/,
  );
  assert.equal(captures, 1);
});
test("App screenshot ownership and platform permissions apply before any capture", async (t) => {
  const f = setup(t);
  let captures = 0;
  f.runtime.apps = new AppBrowsing(f.runtime, {
    resolve: async (url) => ({ platform: "bilibili", url }),
    adapter: {
      perform: async (job) => {
        captures++;
        assert.equal(job.operation, "screenshot");
        return { data: png.toString("base64") };
      },
    },
  });
  const record = f.runtime.apps.record(f.ctx, {
    platform: "bilibili",
    url: "https://www.bilibili.com/video/BV1xx411c7mD",
    title: "示例",
    ok: true,
    origin: "app-browser",
  });
  const result = await f.runtime.callTool(f.ctx, "app_screenshot", {
    recordId: record.recordId,
  });
  assert.equal(result.scope, "app-page-viewport");
  await assert.rejects(
    f.runtime.callTool(context(f.runtime, "agent-1"), "app_screenshot", {
      recordId: record.recordId,
    }),
    /APP_RECORD_NOT_FOUND/,
  );
  f.runtime.agent(f.ctx.agentId).apps.enabled = false;
  await assert.rejects(
    f.runtime.callTool(f.ctx, "app_screenshot", { recordId: record.recordId }),
    /TOOL_DISABLED|APP_PERMISSION_DISABLED/,
  );
  assert.equal(captures, 1);
});

test("App gallery retains ordered public images and saves any selected image as reusable media", async (t) => {
  const f = setup(t);
  const { normalizeRows } = await import("../src/apps/service.mjs");
  const [row] = normalizeRows(
    [
      {
        url: "https://www.bilibili.com/video/BV1xx411c7mD",
        cover: "https://example.org/cover.png",
        images: [
          "//example.org/second.png",
          "https://example.org/cover.png",
          "file:///private/tmp/private.png",
        ],
      },
    ],
    { platform: "bilibili", operation: "read" },
  );
  assert.deepEqual(row.images, [
    "https://example.org/cover.png",
    "https://example.org/second.png",
  ]);
  f.runtime.agent(f.ctx.agentId).tools.push("app_image");
  f.runtime.apps = new AppBrowsing(f.runtime);
  const record = f.runtime.apps.record(f.ctx, {
    ...row,
    platform: "bilibili",
    ok: true,
    origin: "app-browser",
  });
  let downloaded;
  f.runtime.files.download = async (url) => {
    downloaded = url;
    return { buffer: png };
  };
  const result = await f.runtime.callTool(f.ctx, "app_image", {
    recordId: record.recordId,
    index: 1,
  });
  assert.equal(downloaded, "https://example.org/second.png");
  assert.equal(result.id, result.mediaId);
  assert.equal(
    (await f.runtime.callTool(f.ctx, "media_list", {})).items[0].appRecordId,
    record.recordId,
  );
  await assert.rejects(
    f.runtime.callTool(f.ctx, "app_image", {
      recordId: record.recordId,
      index: 2,
    }),
    /APP_IMAGE_UNAVAILABLE/,
  );
});

test("autonomous browsing can retain assets when configured, without local import or direct QQ send", async (t) => {
  const f = setup(t),
    a = f.runtime.agent(f.ctx.agentId);
  a.subject.enabled = true;
  a.subject.readTools = [
    "image_save",
    "media_list",
    "file_download",
    "file_list",
    "sticker_read",
    "web_screenshot",
    "app_screenshot",
  ];
  const { validateConfig } = await import("../src/core/config.mjs");
  assert.doesNotThrow(() => validateConfig(f.runtime.config));
  const { SUBJECT } = await import("../src/core/lifecycle.mjs");
  const ctx = context(f.runtime, a.id, SUBJECT);
  const image = await f.runtime.callTool(ctx, "image_save", {
    url: "https://example.org/subject.png",
  });
  assert.equal(
    (await f.runtime.callTool(ctx, "media_list", {})).items[0].mediaId,
    image.mediaId,
  );
  assert(!f.runtime.toolsFor(a, SUBJECT).includes("file_import"));
  assert(!f.runtime.toolsFor(a, SUBJECT).includes("qq_send"));
  assert(!f.runtime.toolsFor(a, SUBJECT).includes("qq_send_file"));
  a.files.maxFiles = 1;
  f.runtime.files.download = async () => ({
    buffer: Buffer.concat([png, Buffer.from("new")]),
  });
  await assert.rejects(
    f.runtime.callTool(ctx, "image_save", {
      url: "https://example.org/other.png",
    }),
    /FILE_QUOTA_EXCEEDED/,
  );
});
