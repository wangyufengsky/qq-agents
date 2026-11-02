import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fixture, config, context, disclosureApproval } from "./helpers.mjs";
import { FileStore } from "../src/tools/files.mjs";
import { MediaStore } from "../src/tools/media.mjs";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);

test("one exact external screenshot approval cannot remove peer-space protection from file and image", async (t) => {
  const cfg = config(1),
    a = cfg.agents[0];
  Object.assign(a.files, {
    enabled: true,
    create: true,
    download: true,
    send: true,
  });
  a.network.autonomous = true;
  a.tools.push(
    "web_screenshot",
    "file_list",
    "file_read",
    "qq_send_file",
    "image_save",
    "media_list",
    "sticker_read",
  );
  const f = fixture(t, { cfg }),
    ctx = context(f.runtime, "agent-0", "private:30000");
  f.runtime.files = new FileStore(path.join(f.root, "files"));
  f.runtime.media = new MediaStore(path.join(f.root, "media"));
  ctx.privateRead.add("peer-qzone:30000");
  ctx.persistTaint();
  let captures = 0;
  f.runtime.capturePublicPage = async (url) => {
    captures++;
    return { buffer: png, url, scope: "public-page-viewport" };
  };
  const args = { url: "https://example.org/page" };
  await assert.rejects(
    f.runtime.callTool(ctx, "web_screenshot", args),
    /PRIVATE_RECOLLECTION_EXTERNAL_CALL_BLOCKED/,
  );
  assert.equal(captures, 0);
  f.runtime.grant(disclosureApproval(ctx));
  const image = await f.runtime.callTool(ctx, "web_screenshot", args);
  assert.equal(captures, 1);
  assert.deepEqual(
    f.runtime.files.metadata("agent-0", image.fileId).protectedPeerQzoneTargets,
    ["30000"],
  );
  assert.deepEqual(
    f.runtime.media.metadata("agent-0", image.mediaId)
      .protectedPeerQzoneTargets,
    ["30000"],
  );
  assert.deepEqual([...ctx.grants], []);
  await assert.rejects(
    f.runtime.callTool(ctx, "web_screenshot", {
      url: "https://example.org/other",
    }),
    /PRIVATE_RECOLLECTION_EXTERNAL_CALL_BLOCKED/,
  );
  assert.equal(captures, 1);
  f.runtime.files = new FileStore(path.join(f.root, "files"));
  f.runtime.media = new MediaStore(path.join(f.root, "media"));
  const other = context(f.runtime, "agent-0", "group:20000");
  assert.equal(
    (await f.runtime.callTool(other, "file_list", {})).items.length,
    0,
  );
  assert.equal(
    (await f.runtime.callTool(other, "media_list", {})).items.length,
    0,
  );
  for (const [tool, input] of [
    ["file_read", { fileId: image.fileId }],
    ["image_save", { fileId: image.fileId }],
    ["sticker_read", { mediaId: image.mediaId }],
    ["qq_send", { requestId: "screenshot-leak", mediaId: image.mediaId }],
    [
      "qq_send_file",
      { requestId: "screenshot-file-leak", fileId: image.fileId },
    ],
  ])
    await assert.rejects(
      f.runtime.callTool(other, tool, input),
      /RECALL_SOURCE_NOT_ALLOWED/,
    );
  assert.equal(f.runtime.transports.get("qq-0").sent.length, 0);
});
