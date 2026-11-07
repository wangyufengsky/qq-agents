import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fixture, config, context, raw } from "./helpers.mjs";
import { prepareMessageImages } from "../src/core/message-images.mjs";
import { imagePreview } from "../src/tools/image-preview.mjs";
import { colorGrid } from "../scripts/fixtures/antigravity-media.mjs";
import { MediaStore } from "../src/tools/media.mjs";
import { gif } from "./gif-fixture.mjs";

async function setup(
  t,
  {
    count = 1,
    bytes = colorGrid(["red", "blue", "green", "yellow"]),
    enabled = true,
    maxImages = 4,
  } = {},
) {
  const cfg = config(1);
  cfg.agents[0].wake.participation = 0;
  cfg.agents[0].tools.push("qq_image_read");
  cfg.agents[0].behavior.imageInput = {
    ...cfg.agents[0].behavior.imageInput,
    enabled,
    maxImages,
  };
  const f = fixture(t, { cfg });
  f.runtime.media = new MediaStore(f.root + "/media");
  let downloads = 0;
  f.runtime.media.fetchBuffer = async () => {
    downloads++;
    return bytes;
  };
  await f.runtime.ingest(
    "qq-0",
    raw(42, {
      message: Array.from({ length: count }, () => ({
        type: "image",
        data: { url: "https://example.com/synthetic.png" },
      })),
    }),
  );
  const row = f.store.db
    .prepare(
      "SELECT * FROM events WHERE agent_id='agent-0' AND kind='message.received'",
    )
    .get();
  const ctx = context(f.runtime);
  ctx.allowedTools = f.runtime.toolsFor(
    f.runtime.agent(ctx.agentId),
    ctx.conversation,
  );
  ctx.estimatedAdded = 1000;
  ctx.turnId = "synthetic-turn";
  f.store
    .bind(ctx.agentId)
    .identity.put("model_turns", { id: ctx.turnId, status: "running" });
  const prepared = {
    prompt: "synthetic",
    newMessages: [f.store.bind(ctx.agentId).event(row, ctx.conversation)],
  };
  return {
    ...f,
    ctx,
    prepared,
    row,
    downloads: () => downloads,
    prepare: () =>
      prepareMessageImages(f.runtime, ctx, { type: "codex" }, prepared),
  };
}

test("new live images carry preview pixels and source labels without model tool calls; submission deduplicates across session retirement", async (t) => {
  const f = await setup(t);
  const p = await f.prepare();
  assert.equal(p.images.length, 1);
  assert.equal(p.images[0].mimeType, "image/jpeg");
  assert(p.images[0].data.length > 100);
  assert.match(p.images[0].label, new RegExp(f.row.id));
  assert.match(f.prepared.prompt, /不必再调用/);
  assert.equal(f.ctx.estimatedImageTokens, 4096);
  assert.deepEqual(f.ctx.toolCalls || [], []);
  p.beforeSubmit();
  p.submitted();
  assert.equal((await f.prepare()).images.length, 0);
  assert.equal(f.downloads(), 1);
  assert.equal(
    f.store.bind(f.ctx.agentId).state(f.ctx.conversation).readThroughSeq || 0,
    0,
  );
});

test("preview generation bounds dimensions and preserves the original cache", async (t) => {
  const f = await setup(t);
  const p = await f.prepare();
  const data = Buffer.from(p.images[0].data, "base64");
  const dimensions = JSON.parse(
    execFileSync(
      process.env.FFPROBE_PATH || "ffprobe",
      [
        "-v",
        "error",
        "-f",
        "image2pipe",
        "-show_entries",
        "stream=width,height",
        "-of",
        "json",
        "pipe:0",
      ],
      { input: data },
    ),
  );
  assert.equal(dimensions.streams[0].width, 320);
  assert.equal(
    f.runtime.media.read(f.ctx.agentId, p.images[0].mediaId).mimeType,
    "image/png",
  );
  const bigger = execFileSync(
    process.env.FFMPEG_PATH || "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "image2pipe",
      "-i",
      "pipe:0",
      "-vf",
      "scale=2400:800",
      "-frames:v",
      "1",
      "-f",
      "image2pipe",
      "-c:v",
      "png",
      "pipe:1",
    ],
    { input: data, maxBuffer: 4000000 },
  );
  const preview = await imagePreview(bigger, {
    maxEdge: 1280,
    signal: new AbortController().signal,
  });
  const sized = JSON.parse(
    execFileSync(
      process.env.FFPROBE_PATH || "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "stream=width,height",
        "-of",
        "json",
        "pipe:0",
      ],
      { input: Buffer.from(preview.data, "base64") },
    ),
  );
  assert.equal(sized.streams[0].width, 1280);
  assert(sized.streams[0].height < 1280);
});

test("limits mark unpictured images and GIF preview remains sampled", async (t) => {
  const f = await setup(t, { count: 3, maxImages: 2 });
  const p = await f.prepare();
  assert.equal(p.images.filter((i) => i.data).length, 2);
  assert.match(p.images[2].label, /未附上.*预算/);
  assert.equal(f.downloads(), 2);
  const g = await setup(t, { bytes: gif([{}, { color: 1 }, { color: 2 }]) });
  const animated = await g.prepare();
  assert.equal(animated.images.length, 2);
  assert.match(animated.images[0].label, /"sampled":true/);
  assert.match(animated.images[0].label, /"complete":false/);
  assert(animated.images.every((i) => i.mimeType === "image/jpeg"));
});

for (const deny of [
  "disabled",
  "tool",
  "historical",
  "foreign",
  "untrusted",
  "protected",
  "headless",
  "budget",
])
  test(`automatic input does not bypass ${deny}`, async (t) => {
    const f = await setup(t, { enabled: deny !== "disabled" });
    if (deny === "tool") f.ctx.allowedTools = [];
    if (deny === "historical")
      f.store
        .bind(f.ctx.agentId)
        .setState(f.ctx.conversation, { feedThroughSeq: f.row.seq });
    if (deny === "foreign") f.prepared.newMessages[0].id = "foreign";
    if (deny === "untrusted")
      f.store.db
        .prepare(
          "UPDATE events SET payload=json_set(payload,'$.trustedInput',0) WHERE id=?",
        )
        .run(f.row.id);
    if (deny === "protected")
      f.store.db
        .prepare(
          "UPDATE events SET payload=json_set(payload,'$.protectedOperations',json('true')) WHERE id=?",
        )
        .run(f.row.id);
    if (deny === "budget")
      f.store
        .bind(f.ctx.agentId)
        .setState(f.ctx.conversation, { usage: { contextTokens: 1000000 } });
    const p =
      deny === "headless"
        ? await prepareMessageImages(
            f.runtime,
            f.ctx,
            { type: "antigravity" },
            f.prepared,
          )
        : await f.prepare();
    assert.equal(p.images.filter((i) => i.data).length, 0);
    assert.equal(f.downloads(), 0);
  });

test("failed image downloads leave a usable text turn without private errors", async (t) => {
  const f = await setup(t);
  f.runtime.media.fetchBuffer = async () => {
    throw Error("PRIVATE_URL_AND_CREDENTIAL");
  };
  const p = await f.prepare();
  assert.equal(p.images.filter((i) => i.data).length, 0);
  assert.match(p.images[0].label, /未附上/);
  assert(!JSON.stringify(p.images).includes("PRIVATE"));
});

test("preparation deadline cancels its IO without cancelling the text turn", async (t) => {
  const f = await setup(t);
  f.runtime.agent(f.ctx.agentId).behavior.imageInput.timeoutMs = 30;
  f.runtime.media.fetchBuffer = (_url, _limit, { signal }) =>
    new Promise((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(Error("ABORTED")), {
        once: true,
      }),
    );
  const p = await f.prepare();
  assert.match(p.images[0].label, /超时/);
  assert.equal(f.ctx.controller.signal.aborted, false);
  assert.equal(f.runtime.media.activeDownloads, 0);
});

for (const revoke of ["tool", "source", "switch"])
  test(`rechecks ${revoke} immediately before native submission`, async (t) => {
    const f = await setup(t);
    const p = await f.prepare();
    assert(p.images[0].data);
    if (revoke === "tool") f.runtime.agent(f.ctx.agentId).tools = [];
    if (revoke === "source")
      f.store.db
        .prepare("UPDATE events SET status='recalled' WHERE id=?")
        .run(f.row.id);
    if (revoke === "switch")
      f.runtime.agent(f.ctx.agentId).behavior.imageInput.enabled = false;
    p.beforeSubmit();
    assert.equal(p.images[0].data, undefined);
    assert.match(p.images[0].label, /来源或权限已变化/);
  });

test("cancellation stops preparation and never submits pixels", async (t) => {
  const f = await setup(t);
  f.runtime.media.fetchBuffer = async () => {
    f.ctx.controller.abort();
    return colorGrid(["red", "green", "blue", "yellow"]);
  };
  await assert.rejects(f.prepare(), /AGENT_PAUSED_OR_EXPIRED/);
});

test("ordinary Runtime turn attaches new images and the next turn omits history", async (t) => {
  const f = await setup(t);
  const inputs = [];
  f.runtime.backends.clear();
  const errors = [];
  f.runtime.diagnostics.report = (error) =>
    errors.push(error.cause?.stack || error.stack);
  f.runtime.backendFactory = () => ({
    run: async (params) => {
      await params.beforeInputSubmitted?.();
      params.onInputSubmitted?.();
      inputs.push(params);
    },
    close: async () => {},
  });
  await f.runtime.runTurn("agent-0", "group:20000");
  assert.equal(inputs.length, 1, JSON.stringify(errors));
  assert.equal(
    inputs[0].inputImages.filter((i) => i.data).length,
    1,
    JSON.stringify(inputs[0].inputImages),
  );
  assert.match(inputs[0].prompt, /本轮图片附件/);
  await f.runtime.runTurn("agent-0", "group:20000");
  assert.equal(inputs[1].inputImages.length, 0);
});

test("recoverable continuation never replays the submitted image payload", async () => {
  const { runWithRecovery, BackendTurnFailure } =
    await import("../src/backends/turn-failure.mjs");
  const calls = [];
  const backend = {
    run: async (params) => {
      calls.push(params);
      if (calls.length === 1) {
        const failure = new BackendTurnFailure(
          "codex",
          "stream",
          "response-stream",
          "one",
          true,
        );
        failure.sessionReusable = true;
        throw failure;
      }
    },
  };
  await runWithRecovery(backend, {
    prompt: "new",
    inputImages: [{ label: "pixel", data: "cGl4ZWxz" }],
    session: { backend: "codex", id: "one", signature: "fixture" },
    signal: new AbortController().signal,
    tools: [],
    callTool() {},
    saveSession() {},
  });
  assert.equal(calls[0].inputImages.length, 1);
  assert.deepEqual(calls[1].inputImages, []);
});

test("disabling automatic images cancels an admitted turn and preserves other policies", async (t) => {
  const f = await setup(t);
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  f.runtime.backends.clear();
  f.runtime.backendFactory = () => ({
    run: ({ signal }) =>
      new Promise((resolve) => {
        started();
        signal.addEventListener("abort", resolve, { once: true });
      }),
    close: async () => {},
  });
  const job = f.runtime.runTurn("agent-0", "group:20000");
  await ready;
  const next = structuredClone(f.runtime.config);
  next.agents[0].behavior.imageInput.enabled = false;
  await f.runtime.changeConfig(next, f.configStore.revision);
  assert.equal((await job).status, "cancelled");
  assert.equal(
    f.runtime.config.agents[0].tools.includes("qq_image_read"),
    true,
  );
});

test("a large album has bounded omission labels and does not trigger excess downloads", async (t) => {
  const f = await setup(t, { count: 100, maxImages: 1 });
  const p = await f.prepare();
  assert.equal(p.images.length, 33);
  assert.equal(f.downloads(), 1);
  assert.match(p.images.at(-1).label, /33 至 100.*未附上/);
});
