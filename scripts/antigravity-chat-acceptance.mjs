import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { acceptanceMedia } from "./fixtures/antigravity-media.mjs";
import { EventEmitter } from "node:events";
import { parseArgs } from "node:util";
import crossSpawn from "cross-spawn";
import { AntigravityBackend } from "../src/backends/antigravity.mjs";
import { ConfigStore, validateConfig } from "../src/core/config.mjs";
import { Runtime } from "../src/core/runtime.mjs";
import { MediaStore } from "../src/tools/media.mjs";
import { MemoryStore } from "../src/memory/store.mjs";

const { values } = parseArgs({
  options: {
    "allow-real-models": { type: "boolean" },
    command: { type: "string", default: "agy" },
    model: { type: "string" },
    extended: { type: "boolean", default: false },
    "max-first-send-ms": { type: "string", default: "30000" },
  },
});
if (!values["allow-real-models"] || !values.model)
  throw Error("ANTIGRAVITY_ACCEPTANCE_REQUIRES_OPT_IN_AND_MODEL");
const maxFirstSendMs = Number(values["max-first-send-ms"]);
assert(Number.isFinite(maxFirstSendMs) && maxFirstSendMs > 0);
// No existing configuration, chat, login profile or QQ transport is opened.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "qq-agy-chat-acceptance-"));
fs.chmodSync(root, 0o700);
const cfg = validateConfig({
  version: 1,
  mode: "live",
  globalPaused: false,
  connections: [
    {
      id: "synthetic",
      label: "Synthetic",
      accountId: "10000",
      httpUrl: "http://127.0.0.1:9",
      wsUrl: "ws://127.0.0.1:9",
      enabled: true,
    },
  ],
  backends: [
    {
      id: "acceptance",
      label: "Acceptance",
      type: "antigravity",
      command: values.command,
      model: values.model,
      effort: "",
    },
  ],
  agents: [
    {
      id: "acceptance",
      name: "验收角色",
      connectionId: "synthetic",
      backendId: "acceptance",
      paused: false,
      ownerIds: ["30000"],
      persona: "你是一名友好的聊天伙伴，使用简洁中文回答。",
      allow: { groups: ["20000"], users: ["30000"] },
      subject: { enabled: false },
      wake: { cooldownMs: 0 },
      behavior: { turnTimeoutMs: 180000 },
    },
  ],
});
const store = new MemoryStore(path.join(root, "memory.sqlite"));
const configStore = new ConfigStore(path.join(root, "config.json"), cfg);
const results = [];
const marker = "SYNTHETIC_" + randomBytes(8).toString("hex");
const imageEvents = new Set(),
  mediaIds = new Set();
let sentCount = 0;
const cliVersion = execFileSync(values.command, ["--version"], {
  encoding: "utf8",
  timeout: 30000,
}).trim();
let active;
class SyntheticTransport extends EventEmitter {
  connected = true;
  async send(conversation, segments) {
    active.sends.push({ at: Date.now(), conversation, segments });
    return { messageId: String(40000 + ++sentCount) };
  }
  close() {
    this.connected = false;
  }
}
const runtime = new Runtime({
  memory: store,
  configStore,
  transportFactory: () => {
    throw Error("REAL_TRANSPORT_FORBIDDEN");
  },
  backendFactory: (config, agent) => {
    const backend = new AntigravityBackend(config, agent, {
      root,
      spawn(command, args, options) {
        const child = crossSpawn(command, args, options);
        let buffer = "";
        child.stdout?.on("data", (chunk) => {
          buffer += chunk;
          while (buffer.includes("\n")) {
            const end = buffer.indexOf("\n"),
              line = buffer.slice(0, end);
            buffer = buffer.slice(end + 1);
            try {
              const event = JSON.parse(line),
                step = event.step_update;
              if (step?.state === "DONE" && step?.tool_name === "view_file")
                active.nativeImageReads++;
              if (step?.usage)
                active.steps.push({
                  type: step.step_type,
                  state: step.state,
                  usage: step.usage,
                });
            } catch {
              /* The adapter owns protocol validation. */
            }
          }
        });
        return child;
      },
    });
    const run = backend.run.bind(backend);
    backend.run = (params) =>
      run({
        ...params,
        callTool: async (name, args) => {
          // Expose the normal catalogue, but only exercise local chat operations.
          // A model choosing any external action cannot escape this fixture.
          if (
            ![
              "qq_send",
              "qq_send_burst",
              "qq_mark_read",
              "conversation_read",
              "memory_search",
              "memory_read",
              ...(values.extended ? ["qq_image_read", "sticker_read"] : []),
            ].includes(name)
          ) {
            active.deniedTools++;
            throw Error("ACCEPTANCE_ACTION_DENIED");
          }
          if (
            (name === "qq_image_read" && !imageEvents.has(args.id)) ||
            (name === "sticker_read" && !mediaIds.has(args.mediaId))
          )
            throw Error("ACCEPTANCE_MEDIA_DENIED");
          const result = await params.callTool(name, args);
          if (name === "qq_image_read" || name === "sticker_read") {
            const images = result.content.filter((c) => c.type === "image");
            active.mediaReads.push({
              name,
              id: args.id || args.mediaId,
              images: images.map((c) => ({
                mimeType: c.mimeType,
                sha256: createHash("sha256")
                  .update(Buffer.from(c.data, "base64"))
                  .digest("hex"),
              })),
            });
          }
          return result;
        },
      });
    return backend;
  },
});
runtime.transports.set("synthetic", new SyntheticTransport());
const mem = store.bind("acceptance");
// Fixtures are pre-cached under their source event. No URL or native download is allowed.
runtime.media = new MediaStore(path.join(root, "media"), {
  fetchBuffer: async () => {
    throw Error("REAL_MEDIA_DOWNLOAD_FORBIDDEN");
  },
});
let retiredSession;
const cases = [
  { name: "chat-1", body: `你好！请简短回复一句，带上标记 ${marker}。` },
  {
    name: "chat-2",
    body: "接着上句话，刚才的标记是什么？只用一句话回答就好。",
    recall: true,
  },
  { name: "chat-3", body: "好的，再简短打个招呼，我们继续聊。" },
];
try {
  if (values.extended) {
    const media = acceptanceMedia(root);
    const instruction =
      "请用 qq_image_read 读取本条图片，按每帧左上、右上、左下、右下的顺序，仅回复英文小写颜色名，用逗号分隔。必须先读取像素，不猜测。";
    cases.push(
      {
        name: "static-image",
        body: instruction,
        media: media.still,
        imageCount: 1,
      },
      {
        name: "single-frame-gif",
        body: instruction,
        media: media.single,
        imageCount: 1,
      },
      {
        name: "gif-frames",
        body:
          "这是一张两帧动图。" +
          instruction +
          "按时间顺序报告两帧，共八个颜色。",
        media: media.animation,
        imageCount: 2,
      },
      {
        name: "missing-image",
        body: "请读取本条图片。如果无法拿到像素，只回复 NO_PIXELS，不要猜颜色或描述画面。",
        missingMedia: true,
      },
      {
        name: "pressure-retirement",
        body: "请再说出最初的合成标记。",
        recall: true,
        pressure: true,
      },
      {
        name: "handoff-and-media-recall",
        body: "请回忆最初的合成标记，并重新读取之前那张静态图片，报告四个颜色。先写标记，再写颜色。",
        recall: true,
        mediaRecall: true,
        expectedColors: media.still.colors,
      },
    );
  }
  for (const [index, scenario] of cases.entries()) {
    // A low limit exercises the real pressure guard without spending a model window.
    // Restore only the isolated fixture's capacity before the fresh-session handoff.
    if (index >= 3)
      runtime.config.agents[0].contextPolicy.capacityTokens = scenario.pressure
        ? 4096
        : 65536;
    const conversation = "private:30000";
    const incoming = mem.append({
      dedupe: `synthetic-${index}`,
      conversation,
      connectionId: "synthetic",
      kind: "message.received",
      direction: "in",
      senderId: "30000",
      body: scenario.body,
      origin: "live",
      // Synthetic gateway-authenticated input must renew reply authority like a real
      // incoming message. Bare archive rows intentionally do not reset reply budgets.
      payload: {
        trustedInput: true,
        segments:
          scenario.media || scenario.missingMedia
            ? [{ type: "image", data: { file: "synthetic" } }]
            : [],
      },
      occurredAt: new Date().toISOString(),
    });
    if (scenario.media || scenario.missingMedia) imageEvents.add(incoming.id);
    if (scenario.media) {
      const saved = runtime.media.put(
        "acceptance",
        scenario.media.buffer,
        scenario.media.mimeType,
        {
          conversation,
          sourceEventId: incoming.id,
          sourceType: "image",
          sourceIndex: 0,
        },
      );
      mediaIds.add(saved.id);
      scenario.eventId = incoming.id;
      scenario.mediaId = saved.id;
    }
    active = {
      sends: [],
      steps: [],
      deniedTools: 0,
      mediaReads: [],
      nativeImageReads: 0,
    };
    const before = mem.state(conversation).session?.id,
      start = Date.now();
    await runtime.wake("acceptance", conversation, {
      reasons: [{ reason: "private" }],
    });
    const state = mem.state(conversation);
    const turn = mem.identity.get("model_turns", state.lastTurnId);
    const replyText = active.sends
      .flatMap((s) => s.segments)
      .filter((s) => s.type === "text")
      .map((s) => s.data.text)
      .join(" ");
    const colors =
      replyText.toLowerCase().match(/\b(red|green|blue|yellow)\b/g) || [];
    const expectedColors = scenario.media?.colors || scenario.expectedColors;
    const row = {
      case: scenario.name,
      configuredCapacity: runtime.config.agents[0].contextPolicy.capacityTokens,
      freshAfterPressure:
        !!scenario.mediaRecall &&
        !before &&
        !!state.session &&
        state.session.id !== retiredSession,
      mediaReads: active.mediaReads,
      nativeImageReads: active.nativeImageReads,
      noPixelsAcknowledged:
        !!scenario.missingMedia &&
        replyText.includes("NO_PIXELS") &&
        colors.length === 0,
      colorsCorrect:
        !expectedColors ||
        JSON.stringify(colors) === JSON.stringify(expectedColors),
      toolsAvailable: runtime.toolsFor(cfg.agents[0], conversation).length,
      firstSendMs: active.sends[0] ? active.sends[0].at - start : null,
      totalMs: Date.now() - start,
      sends: active.sends.length,
      continued: !!before && before === state.session?.id,
      sessionKept: !!state.session,
      status: turn.status,
      failedTools: turn.toolCalls
        .filter((c) => !c.ok)
        .map((c) => ({ name: c.name, code: c.code })),
      toolCalls: turn.toolCalls.length,
      deniedTools: active.deniedTools,
      readThroughIncoming: state.readThroughSeq >= incoming.seq,
      usage: state.usage,
      retirementReason: state.lifecycle?.reason || null,
      markerRecalled: !scenario.recall || replyText.includes(marker),
      steps: active.steps,
    };
    if (scenario.pressure) retiredSession = before;
    results.push(row);
    console.log(JSON.stringify({ ...row, steps: undefined }));
  }
  for (const [index, r] of results.entries()) {
    assert.equal(r.sends, 1, "ONE_SYNTHETIC_REPLY_REQUIRED");
    assert(r.firstSendMs <= maxFirstSendMs, "FIRST_REPLY_TOO_SLOW");
    const scenario = cases[index];
    if (scenario.missingMedia) {
      assert(
        r.failedTools.length > 0 &&
          r.failedTools.every(
            (c) =>
              c.name === "qq_image_read" && c.code === "IMAGE_URL_UNAVAILABLE",
          ),
        "MISSING_IMAGE_FAILURE_REQUIRED",
      );
      assert(
        r.noPixelsAcknowledged && r.mediaReads.length === 0,
        "UNSEEN_IMAGE_DESCRIBED",
      );
    } else assert.equal(r.failedTools.length, 0, "TOOL_ARGUMENT_RETRIES");
    assert.equal(r.deniedTools, 0, "UNRELATED_TOOL_ATTEMPTS");
    assert(r.readThroughIncoming, "INCOMING_NOT_MARKED_READ");
    if (scenario.pressure) {
      assert(
        !r.sessionKept && r.retirementReason === "capacity-guard",
        "PRESSURE_RETIREMENT_REQUIRED",
      );
    } else if (scenario.mediaRecall) {
      assert(r.freshAfterPressure, "FRESH_HANDOFF_REQUIRED");
      assert(r.nativeImageReads >= 1, "NATIVE_PIXELS_NOT_REREAD");
      const still = cases.find((c) => c.name === "static-image");
      assert(
        r.mediaReads.some((m) => [still.eventId, still.mediaId].includes(m.id)),
        "MEDIA_NOT_REREAD",
      );
    } else {
      assert(r.sessionKept, "SESSION_RETIRED_AFTER_CHAT");
      assert(index === 0 || r.continued, "SESSION_NOT_CONTINUED");
    }
    if (scenario.media) {
      assert(
        r.nativeImageReads >= scenario.imageCount,
        "NATIVE_PIXELS_NOT_READ",
      );
      assert(
        r.mediaReads.some(
          (m) =>
            m.id === scenario.eventId &&
            m.images.length === scenario.imageCount,
        ),
        "MEDIA_PIXELS_NOT_RETURNED",
      );
    }
    assert(r.colorsCorrect, "PIXEL_ANSWER_MISMATCH");
    assert(r.markerRecalled, "MARKER_NOT_RECALLED");
  }
} catch {
  process.exitCode = 1;
  console.error("ANTIGRAVITY_CHAT_ACCEPTANCE_FAILED");
} finally {
  await runtime.close();
  store.close();
  fs.writeFileSync(
    path.join(root, "acceptance-summary.json"),
    JSON.stringify(
      {
        passed: !process.exitCode,
        maxFirstSendMs,
        extended: values.extended,
        cliVersion,
        model: values.model,
        realQQ: false,
        nativeCompactionVerified: false,
        results,
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({ passed: !process.exitCode, privateEvidence: root }),
  );
}
