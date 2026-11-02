import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { config, fixture, context, disclosureApproval } from "./helpers.mjs";
import { MediaStore } from "../src/tools/media.mjs";
import { FileStore } from "../src/tools/files.mjs";
import { TOOL_NAMES } from "../src/tools/names.mjs";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
function setup(t) {
  const cfg = config(1);
  cfg.agents[0].tools = TOOL_NAMES;
  cfg.agents[0].files.enabled = true;
  const f = fixture(t, { cfg });
  f.runtime.media = new MediaStore(path.join(f.root, "media"));
  f.runtime.files = new FileStore(path.join(f.root, "files"));
  return { ...f, ctx: context(f.runtime, "agent-0", "private:30000") };
}

test("shared sticker title and tags cannot launder a peer-tainted context", async (t) => {
  const f = setup(t);
  const image = f.runtime.media.put("agent-0", png, "image/png", {
    sticker: true,
    title: "ordinary",
  });
  f.ctx.privateRead.add("peer-qzone:30000");
  await assert.rejects(
    f.runtime.callTool(f.ctx, "sticker_collect", {
      mediaId: image.id,
      title: "PEER_PRIVATE_TITLE",
      tags: ["PEER_PRIVATE_TAG"],
    }),
    /RESTRICTED_CONTEXT_MIND_WRITE_BLOCKED/,
  );
  const listed = await f.runtime.callTool(
    context(f.runtime),
    "sticker_list",
    {},
  );
  assert.doesNotMatch(JSON.stringify(listed), /PEER_PRIVATE/);
  assert.equal(f.runtime.media.metadata("agent-0", image.id).title, "ordinary");
});

test("saving an ordinary image with a private title inherits the entire context", async (t) => {
  const f = setup(t);
  const file = f.runtime.files.put(
    "agent-0",
    png,
    "ordinary.png",
    f.runtime.agent("agent-0").files,
  );
  f.ctx.privateRead.add("peer-qzone:30000");
  const image = await f.runtime.callTool(f.ctx, "image_save", {
    fileId: file.fileId,
    title: "PEER_PRIVATE_IMAGE_TITLE",
  });
  assert.deepEqual(
    f.runtime.media.metadata("agent-0", image.mediaId)
      .protectedPeerQzoneTargets,
    ["30000"],
  );
  const own = await f.runtime.callTool(f.ctx, "media_list", {});
  assert.match(JSON.stringify(own), /PEER_PRIVATE_IMAGE_TITLE/);
  const listed = await f.runtime.callTool(context(f.runtime), "media_list", {});
  assert.doesNotMatch(JSON.stringify(listed), /PEER_PRIVATE_IMAGE_TITLE/);
});

test("official sticker collect and remark reject protected context or protected input even after a grant", async (t) => {
  const f = setup(t),
    calls = [];
  f.runtime.transports.get("qq-0").call = async (action) => {
    calls.push(action);
    return {};
  };
  f.store.bind("agent-0").setState("@official-stickers", {
    entries: [{ id: "face1", url: "https://example.invalid/face.png" }],
  });
  const image = f.runtime.media.put("agent-0", png, "image/png");
  f.ctx.privateRead.add("peer-qzone:30000");
  assert.throws(
    () => f.runtime.assertDisclosure(f.ctx, { external: true }),
    /EXTERNAL_CALL_BLOCKED/,
  );
  f.runtime.grant(disclosureApproval(f.ctx));
  await assert.rejects(
    f.runtime.callTool(f.ctx, "qq_official_sticker_remark", {
      requestId: "remark",
      id: "face1",
      remark: "PEER_PRIVATE_REMARK",
    }),
    /RESTRICTED_CONTEXT_MIND_WRITE_BLOCKED/,
  );
  await assert.rejects(
    f.runtime.callTool(f.ctx, "qq_official_sticker_collect", {
      requestId: "collect",
      mediaId: image.id,
    }),
    /RESTRICTED_CONTEXT_MIND_WRITE_BLOCKED/,
  );
  f.runtime.media.put("agent-0", png, "image/png", {
    protectedPeerQzoneTargets: ["30000"],
  });
  const fresh = context(f.runtime, "agent-0", "private:30000");
  await assert.rejects(
    f.runtime.callTool(fresh, "qq_official_sticker_collect", {
      requestId: "protected-input",
      mediaId: image.id,
    }),
    /RESTRICTED_CONTEXT_MIND_WRITE_BLOCKED/,
  );
  assert.deepEqual(calls, []);
});

test("official sticker reads enforce retained image protection and restore owner taint", async (t) => {
  const f = setup(t);
  f.runtime.media.put("agent-0", png, "image/png", {
    protectedPeerQzoneTargets: ["30000"],
  });
  f.runtime.fetchOfficialStickerImage = async () => png;
  f.store.bind("agent-0").setState("@official-stickers", {
    entries: [{ id: "face1", url: "https://example.invalid/face.png" }],
  });
  await assert.rejects(
    f.runtime.callTool(context(f.runtime), "qq_official_sticker_read", {
      id: "face1",
    }),
    /RECALL_SOURCE_NOT_ALLOWED/,
  );
  assert(!f.ctx.privateRead.has("peer-qzone:30000"));
  const result = await f.runtime.callTool(f.ctx, "qq_official_sticker_read", {
    id: "face1",
  });
  assert(result.content.length);
  assert(f.ctx.privateRead.has("peer-qzone:30000"));
});
