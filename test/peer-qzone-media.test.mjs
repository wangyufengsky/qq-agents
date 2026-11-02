import { MemoryStore } from "../src/memory/store.mjs";
import { Runtime } from "../src/core/runtime.mjs";
import { ConfigStore } from "../src/core/config.mjs";
import fs from "node:fs";
import { exportToFile } from "../src/memory/export.mjs";
import { restoreExport } from "../src/memory/migrate.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { GeneratedImages } from "../src/core/generated-images.mjs";
import { MediaStore } from "../src/tools/media.mjs";
import { VoiceStore } from "../src/tools/voice.mjs";
import { FileStore } from "../src/tools/files.mjs";
import { filesSchema, voiceSchema } from "../src/core/policy.mjs";
import { taintMedia } from "../src/tools/legacy.mjs";
import { fileTool } from "../src/tools/file-tools.mjs";
import { saveFileImage } from "../src/tools/saved-media.mjs";
import { externalResult } from "../src/tools/external-media.mjs";
import { recallBoundary } from "../src/core/recall-boundary.mjs";
import { config, fixture, context, temp } from "./helpers.mjs";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
const protection = { protectedPeerQzoneTargets: ["30000"] };

test("content-addressed image, voice and file rewrites cannot erase peer-space protection", async (t) => {
  const root = temp(t),
    media = new MediaStore(path.join(root, "media"));
  const image = media.put("agent-0", png, "image/png", protection);
  assert.deepEqual(
    media.metadata("agent-0", media.put("agent-0", png, "image/png", {}).id)
      .protectedPeerQzoneTargets,
    ["30000"],
  );
  assert.deepEqual(
    new MediaStore(path.join(root, "media")).metadata("agent-0", image.id)
      .protectedPeerQzoneTargets,
    ["30000"],
  );
  const voices = new VoiceStore(path.join(root, "voice"), {
    probe: async () => ({ ok: true, codec: "pcm", duration: 1 }),
  });
  const wav = Buffer.alloc(44);
  wav.write("RIFF");
  wav.write("WAVE", 8);
  await voices.put("agent-0", wav, voiceSchema.parse({}), protection);
  assert.deepEqual(
    (await voices.put("agent-0", wav, voiceSchema.parse({}), {}))
      .protectedPeerQzoneTargets,
    ["30000"],
  );
  const files = new FileStore(path.join(root, "files")),
    policy = filesSchema.parse({});
  files.put("agent-0", png, "image.png", policy, {}, false, [], ["30000"]);
  assert.deepEqual(
    files.put("agent-0", png, "image.png", policy).protectedPeerQzoneTargets,
    ["30000"],
  );
});

test("file creation and file-to-image conversion retain scope and restore durable taint", async (t) => {
  const cfg = config(1);
  cfg.agents[0].files = filesSchema.parse({ enabled: true, create: true });
  const f = fixture(t, { cfg }),
    ctx = context(f.runtime, "agent-0", "private:30000");
  f.runtime.media = new MediaStore(path.join(f.root, "media"));
  f.runtime.files = new FileStore(path.join(f.root, "files"));
  ctx.privateRead.add("peer-qzone:30000");
  const created = await fileTool(f.runtime, ctx, "file_create", {
    name: "note.txt",
    text: "fixture",
  });
  assert.deepEqual(created.protectedPeerQzoneTargets, ["30000"]);
  const file = f.runtime.files.put(
    "agent-0",
    png,
    "image.png",
    cfg.agents[0].files,
    {},
    false,
    [],
    ["30000"],
  );
  const image = saveFileImage(f.runtime, ctx, file.fileId);
  const fresh = context(f.runtime, "agent-0", "private:30000"),
    meta = f.runtime.media.metadata("agent-0", image.mediaId);
  taintMedia(fresh, meta);
  assert(fresh.privateRead.has("peer-qzone:30000"));
  assert(recallBoundary(f.runtime, fresh).allowed(meta));
  const group = context(f.runtime, "agent-0", "group:20000");
  assert(!recallBoundary(f.runtime, group).allowed(meta));
  await assert.rejects(
    fileTool(f.runtime, group, "file_read", { fileId: created.fileId }),
    /RECALL_SOURCE_NOT_ALLOWED/,
  );
});

test("external generated media and native image-session recovery preserve peer-space restrictions", async (t) => {
  const f = fixture(t, { cfg: config(1) }),
    ctx = context(f.runtime, "agent-0", "group:20000");
  f.runtime.media = new MediaStore(path.join(f.root, "media"));
  ctx.privateRead.add("peer-qzone:30000");
  await assert.rejects(
    externalResult(
      f.runtime,
      ctx,
      { serverId: "fixture", tool: "image" },
      {
        content: [
          {
            type: "image",
            mimeType: "image/png",
            data: png.toString("base64"),
          },
        ],
      },
    ),
    /RECALL_SOURCE_NOT_ALLOWED/,
  );
  const saved = f.runtime.media.metadata(
    "agent-0",
    f.runtime.media.put("agent-0", png, "image/png").id,
  );
  assert.deepEqual(saved.protectedPeerQzoneTargets, ["30000"]);
  f.runtime.generatedImages.begin(ctx, "qzone-image-session");
  ctx.privateRead.clear();
  f.runtime.generatedImages = new GeneratedImages(f.runtime);
  const backend = {
    readGeneratedImage: () => ({ buffer: png, mimeType: "image/png" }),
  };
  const generated = f.runtime.generatedImages.capture(
    ctx,
    backend,
    "qzone-image-session",
    { type: "imageGeneration", id: "fixture-image", status: "completed" },
  );
  assert.deepEqual(
    f.runtime.media.metadata("agent-0", generated.mediaId)
      .protectedPeerQzoneTargets,
    ["30000"],
  );
  assert.equal(f.runtime.generatedImages.list(ctx, {}).items.length, 0);
  let reads = 0;
  f.runtime.backends.set("agent-0", {
    imageHistory: async () => {
      reads++;
      return [];
    },
  });
  await f.runtime.generatedImages.recover(ctx);
  assert.equal(reads, 0);
});

test("verified export restore reconstructs native image protection without copying session caches", async (t) => {
  const source = fixture(t, { cfg: config(1) });
  const ctx = context(source.runtime, "agent-0", "group:20000");
  ctx.privateRead.add("peer-qzone:30000");
  ctx.persistTaint();
  source.runtime.generatedImages.begin(ctx, "exported-native-session");
  const destination = path.join(source.root, "export.json");
  await exportToFile(source.store, "agent-0", destination);
  const data = JSON.parse(fs.readFileSync(destination, "utf8"));
  assert(!Object.hasOwn(data.tables, "image_session_peer_qzone"));
  assert(!Object.hasOwn(data.tables, "image_sessions"));
  const root = temp(t);
  const store = new MemoryStore(path.join(root, "memory.sqlite"));
  restoreExport(store.bind("agent-0"), data);
  const runtime = new Runtime({
    memory: store,
    configStore: new ConfigStore(path.join(root, "config.json"), config(1)),
  });
  t.after(async () => {
    await runtime.close();
    store.close();
  });
  const restored = { root, store, runtime };
  restored.runtime.media = new MediaStore(path.join(restored.root, "media"));
  const resumed = context(restored.runtime, "agent-0", "group:20000");
  assert.deepEqual(
    restored.runtime.generatedImages.sessionProtection(
      "agent-0",
      "exported-native-session",
    ).protectedPeerQzoneTargets,
    ["30000"],
  );
  const backend = {
    readGeneratedImage: () => ({ buffer: png, mimeType: "image/png" }),
  };
  const item = {
    type: "imageGeneration",
    id: "restored-image",
    status: "completed",
  };
  assert.throws(
    () =>
      restored.runtime.generatedImages.capture(
        resumed,
        backend,
        "exported-native-session",
        item,
      ),
    /GENERATED_IMAGE_SOURCE_DENIED/,
  );
  let historyReads = 0;
  restored.runtime.backends.set("agent-0", {
    imageHistory: async () => {
      historyReads++;
      return [item];
    },
  });
  await restored.runtime.generatedImages.recover(resumed);
  assert.equal(historyReads, 0);
  restored.runtime.generatedImages.begin(resumed, "exported-native-session");
  const image = restored.runtime.generatedImages.capture(
    resumed,
    backend,
    "exported-native-session",
    item,
  );
  const meta = restored.runtime.media.metadata("agent-0", image.mediaId);
  assert.deepEqual(meta.protectedPeerQzoneTargets, ["30000"]);
  assert(!meta.protectedOperations);
  assert(!recallBoundary(restored.runtime, resumed).allowed(meta));
  assert.equal(
    restored.runtime.generatedImages.list(resumed, {}).items.length,
    0,
  );
});
