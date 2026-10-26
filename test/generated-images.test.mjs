import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { CodexBackend } from "../src/backends/codex.mjs";
import { MediaStore } from "../src/tools/media.mjs";
import { GeneratedImages } from "../src/core/generated-images.mjs";
import { config, fixture, context } from "./helpers.mjs";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
const tick = () => new Promise((r) => setImmediate(r));
class Rpc extends EventEmitter {
  constructor() {
    super();
    this.items = [];
    this.historyReads = 0;
  }
  async start() {}
  close() {}
  async request(method) {
    if (method === "account/read") return { account: { type: "fixture" } };
    if (method === "model/list") return { data: [{ model: "fixture" }] };
    if (method === "thread/start") return { thread: { id: "native-thread" } };
    if (method === "thread/read") {
      this.historyReads++;
      return {
        thread: { id: "native-thread", turns: [{ items: this.items }] },
      };
    }
    if (method === "turn/start") {
      this.emit("notification", {
        method: "turn/started",
        params: { threadId: "native-thread", turn: { id: "native-turn" } },
      });
      return { turn: { id: "native-turn" } };
    }
    return {};
  }
  image(item, threadId = "native-thread", turnId = "native-turn") {
    this.items.push(item);
    this.emit("notification", {
      method: "item/completed",
      params: { threadId, turnId, item },
    });
  }
  complete() {
    this.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: "native-thread",
        turn: { id: "native-turn", status: "completed" },
      },
    });
  }
}
async function setup(t) {
  const cfg = config(2);
  cfg.agents[0].tools.push("sticker_read");
  const f = fixture(t, { cfg }),
    rpc = new Rpc();
  f.runtime.media = new MediaStore(path.join(f.root, "media"));
  const backend = new CodexBackend(cfg.backends[0], cfg.agents[0], {
    root: f.root,
    rpc,
  });
  f.runtime.backendFactory = () => backend;
  const run = f.runtime.wake("agent-0", "group:20000");
  await tick();
  const ctx = f.runtime.running.get("agent-0|group:20000");
  const dir = path.join(
    f.root,
    "codex",
    "agent-0",
    "home",
    "generated_images",
    "native-thread",
  );
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "exec-fixture.png");
  fs.writeFileSync(file, png);
  const item = {
    type: "imageGeneration",
    id: "image-call",
    status: "completed",
    savedPath: file,
    result: "",
    failure: null,
  };
  t.after(async () => {
    rpc.complete();
    await run;
  });
  return { ...f, rpc, backend, ctx, run, item, file };
}
test("native generation is registered, listed and sent as identical QQ bytes with receipt", async (t) => {
  const f = await setup(t);
  f.rpc.image(f.item);
  await tick();
  const result = await f.runtime.callTool(f.ctx, "generated_image_list", {});
  assert.equal(result.items.length, 1);
  const image = result.items[0];
  assert.equal(image.status, "ready");
  assert.match(image.mediaId, /^[a-f0-9]{64}$/);
  assert.equal(image.delivery.status, "not-sent");
  assert(!JSON.stringify(result).includes(f.root));
  const receipt = await f.runtime.callTool(f.ctx, "qq_send", {
    requestId: "image-send",
    mediaId: image.mediaId,
  });
  assert.equal(receipt.status, "sent");
  const transport = f.runtime.transports.get("qq-0");
  assert.deepEqual(
    Buffer.from(transport.sent[0].segments[0].data.file.slice(9), "base64"),
    png,
  );
  assert.equal(
    (await f.runtime.callTool(f.ctx, "generated_image_list", {})).items[0]
      .delivery.status,
    "sent",
  );
  await f.runtime.callTool(f.ctx, "qq_send", {
    requestId: "image-send",
    mediaId: image.mediaId,
  });
  assert.equal(transport.sent.length, 1);
});
test("native image notification cannot cross a thread, turn, agent or conversation", async (t) => {
  const f = await setup(t);
  f.rpc.image(f.item, "another-thread");
  f.rpc.image(f.item, "native-thread", "another-turn");
  await tick();
  assert.equal(f.runtime.media.metadata("agent-0", "a".repeat(64)), null);
  assert.equal(f.runtime.generatedImages.list(f.ctx, {}).items.length, 0);
  f.rpc.items = [];
  f.rpc.image(f.item);
  await tick();
  const other = context(f.runtime, "agent-0", "group:20001");
  assert.equal(
    (await f.runtime.callTool(other, "generated_image_list", {})).items.length,
    0,
  );
  const peer = context(f.runtime, "agent-1", "group:20000");
  assert.equal(
    (await f.runtime.callTool(peer, "generated_image_list", {})).items.length,
    0,
  );
});
test("native image recovery reuses durable registered media after a lost notification or original file removal", async (t) => {
  const f = await setup(t);
  f.rpc.items.push(f.item); // Native file exists, but no completion notification reached the bridge.
  let result = await f.runtime.callTool(f.ctx, "generated_image_list", {});
  const id = result.items[0].mediaId;
  assert.equal(result.items[0].status, "ready");
  fs.unlinkSync(f.file);
  result = await f.runtime.callTool(f.ctx, "generated_image_list", {});
  assert.equal(result.items[0].mediaId, id);
  assert.equal(result.items[0].status, "ready");
  assert.equal(f.runtime.transports.get("qq-0").sent.length, 0);
});
test("native generation cannot import arbitrary files, symlinks or hardlinks", async (t) => {
  const f = await setup(t);
  const outside = path.join(f.root, "private.png");
  fs.writeFileSync(outside, png);
  f.rpc.image({ ...f.item, id: "outside", savedPath: outside });
  fs.unlinkSync(f.file);
  fs.symlinkSync(outside, f.file);
  f.rpc.image({ ...f.item, id: "symlink" });
  await tick();
  fs.unlinkSync(f.file);
  fs.linkSync(outside, f.file);
  f.rpc.image({ ...f.item, id: "hardlink" });
  await tick();
  const result = f.runtime.generatedImages.list(f.ctx, {});
  assert.equal(result.items.length, 3);
  assert(
    result.items.every((x) => x.status === "registration-failed" && !x.mediaId),
  );
  assert(!JSON.stringify(result).includes(outside));
  assert.equal(f.runtime.transports.get("qq-0").sent.length, 0);
});
test("failed or cancelled generation cannot mint media and known native quota failures stay distinct", async (t) => {
  const f = await setup(t);
  f.rpc.image({
    ...f.item,
    status: "failed",
    failure: {
      type: "usageLimitExceeded",
      limitId: "image",
      resetsAt: 1900000000,
    },
  });
  await tick();
  const failed = f.runtime.generatedImages.list(f.ctx, {}).items[0];
  assert.equal(failed.status, "generation-failed");
  assert.equal(failed.error.code, "IMAGE_GENERATION_USAGE_LIMIT");
  assert.equal(failed.mediaId, undefined);
  f.ctx.controller.abort();
  f.rpc.image({ ...f.item, id: "late" });
  await tick();
  assert.equal(
    f.runtime.memory.db
      .prepare("SELECT COUNT(*) AS n FROM image_generations")
      .get().n,
    1,
  );
});
test("unknown image delivery survives reload and blocks a new request ID without regenerating", async (t) => {
  const f = await setup(t);
  f.rpc.image(f.item);
  await tick();
  const image = f.runtime.generatedImages.list(f.ctx, {}).items[0];
  const transport = f.runtime.transports.get("qq-0");
  transport.failure = "fixture-timeout";
  await assert.rejects(
    f.runtime.callTool(f.ctx, "qq_send", {
      requestId: "unknown",
      mediaId: image.mediaId,
    }),
    /DELIVERY_UNKNOWN/,
  );
  f.runtime.generatedImages = new GeneratedImages(f.runtime);
  f.runtime.media = new MediaStore(path.join(f.root, "media"));
  const recovered = (
    await f.runtime.callTool(f.ctx, "generated_image_list", {})
  ).items[0];
  assert.equal(recovered.mediaId, image.mediaId);
  assert.equal(recovered.delivery.status, "unknown");
  assert.equal(recovered.delivery.requestId, "unknown");
  transport.failure = null;
  await assert.rejects(
    f.runtime.callTool(f.ctx, "qq_send", {
      requestId: "different",
      mediaId: image.mediaId,
    }),
    /GENERATED_IMAGE_DELIVERY_UNKNOWN/,
  );
  assert.equal(transport.sent.length, 1);
});
test("explicit QQ rejection leaves the same generated image available for a later send", async (t) => {
  const f = await setup(t);
  f.rpc.image(f.item);
  await tick();
  const image = f.runtime.generatedImages.list(f.ctx, {}).items[0];
  const transport = f.runtime.transports.get("qq-0");
  transport.failure = "ONEBOT_REJECTED";
  await assert.rejects(
    f.runtime.callTool(f.ctx, "qq_send", {
      requestId: "rejected",
      mediaId: image.mediaId,
    }),
    /DELIVERY_FAILED/,
  );
  assert.equal(
    f.runtime.generatedImages.list(f.ctx, {}).items[0].delivery.status,
    "failed",
  );
  transport.failure = null;
  assert.equal(
    (
      await f.runtime.callTool(f.ctx, "qq_send", {
        requestId: "later-send",
        mediaId: image.mediaId,
      })
    ).status,
    "sent",
  );
  assert.equal(f.runtime.generatedImages.list(f.ctx, {}).items.length, 1);
});
test("native image provenance retains restricted reads across recovery", async (t) => {
  const f = await setup(t);
  f.ctx.privateRead.add("operations:private-result");
  f.ctx.persistTaint();
  f.rpc.items.push(f.item);
  const image = (await f.runtime.callTool(f.ctx, "generated_image_list", {}))
    .items[0];
  assert.equal(
    f.runtime.media.metadata("agent-0", image.mediaId).protectedOperations,
    true,
  );
  const fresh = context(f.runtime);
  f.runtime.generatedImages.list(fresh, {});
  assert([...fresh.privateRead].some((x) => x.startsWith("operations:")));
  await assert.rejects(
    f.runtime.callTool(fresh, "qq_send", {
      requestId: "private-image",
      mediaId: image.mediaId,
    }),
    /PRIVATE_RECOLLECTION|DISCLOSURE/,
  );
});
test("generic native failures stay unknown and notification bookkeeping failures do not crash the RPC reader", async (t) => {
  const f = await setup(t);
  f.rpc.image({ ...f.item, status: "failed" });
  await tick();
  assert.equal(
    f.runtime.generatedImages.list(f.ctx, {}).items[0].error.code,
    "IMAGE_GENERATION_FAILED",
  );
  const capture = f.runtime.generatedImages.capture;
  f.runtime.generatedImages.capture = () => {
    throw Error("fixture disk error");
  };
  assert.doesNotThrow(() => f.rpc.image({ ...f.item, id: "later" }));
  assert.equal(
    f.runtime.faults.get("agent-0"),
    "GENERATED_IMAGE_REGISTRATION_FAILED",
  );
  f.runtime.generatedImages.capture = capture;
});
test("recovery cancellation and mismatched history cannot register a late image", async (t) => {
  const f = await setup(t);
  let release;
  f.backend.imageHistory = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const recovery = f.runtime.callTool(f.ctx, "generated_image_list", {});
  await tick();
  f.ctx.controller.abort();
  release([f.item]);
  await assert.rejects(recovery, /PAUSED|EXPIRED/);
  assert.equal(
    f.runtime.memory.db
      .prepare("SELECT COUNT(*) AS n FROM image_generations")
      .get().n,
    0,
  );
});
