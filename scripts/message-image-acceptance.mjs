// Real-model opt-in; only synthetic pixels and isolated native sessions are used.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { parseArgs } from "node:util";
import { BackendRegistry } from "../src/backends/index.mjs";
import { validateConfig } from "../src/core/config.mjs";
import { imagePreview } from "../src/tools/image-preview.mjs";
import { colorGrid } from "./fixtures/antigravity-media.mjs";
const { values } = parseArgs({
  options: {
    "allow-real-models": { type: "boolean" },
    "backend-config": { type: "string" },
    "codex-auth": { type: "string" },
  },
});
if (!values["allow-real-models"] || !values["backend-config"])
  throw Error("EXPLICIT_REAL_MODEL_OPT_IN_REQUIRED");
const supplied = JSON.parse(fs.readFileSync(values["backend-config"], "utf8"));
const cfg = validateConfig({
  version: 1,
  mode: "isolated",
  connections: [],
  agents: [],
  backends: [supplied],
}).backends[0];
assert(["dsh", "codex", "antigravity"].includes(cfg.type));
if (cfg.type === "antigravity") assert.equal(cfg.cliProtocol, "acp");
const root = fs.mkdtempSync(
  path.join(os.tmpdir(), "qq-message-image-acceptance-"),
);
fs.chmodSync(root, 0o700);
const backend = new BackendRegistry().create(
  cfg,
  { id: "synthetic" },
  { root },
);
if (cfg.type === "codex") {
  assert(values["codex-auth"], "DEDICATED_AUTH_SOURCE_REQUIRED");
  fs.copyFileSync(values["codex-auth"], path.join(backend.home, "auth.json"));
  fs.chmodSync(path.join(backend.home, "auth.json"), 0o600);
}
const tools = [
  {
    name: "probe_answer",
    description:
      "Record the colours of the currently attached images, in image order and top-left, top-right, bottom-left, bottom-right order within each image. Empty colours when no image is attached.",
    inputSchema: {
      type: "object",
      properties: {
        colors: {
          type: "array",
          items: { type: "string", enum: ["red", "green", "blue", "yellow"] },
          maxItems: 8,
        },
      },
      required: ["colors"],
      additionalProperties: false,
    },
  },
];
let session = null,
  active;
const results = [];
if (cfg.type === "dsh") {
  const client = await backend.ready();
  const mux = client.events.mux.bind(client.events);
  client.events.mux = async function* (...args) {
    for await (const frame of mux(...args)) {
      const p = frame.payload;
      if (
        active &&
        p?.type === "session/event" &&
        backend.turns.has(p.sessionId)
      ) {
        // Only this isolated session's synthetic answer is inspected.
        if (p.event.type === "assistant/message")
          active.messages.push(p.event.data);
        if (p.event.type === "tool/call") active.nativeTools++;
      }
      yield frame;
    }
  };
}
try {
  for (let round = 0; round < 3; round++) {
    active = {
      round,
      messages: [],
      nativeTools: 0,
      answers: [],
      toolCalls: [],
    };
    const expected = [],
      inputImages = [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 180000);
    const started = Date.now();
    try {
      if (round < 2)
        for (let index = 0; index < 2; index++) {
          const colors = ["red", "green", "blue", "yellow"];
          for (let n = 3; n > 0; n--) {
            const j = randomInt(n + 1);
            [colors[n], colors[j]] = [colors[j], colors[n]];
          }
          expected.push(...colors);
          const preview = await imagePreview(colorGrid(colors), {
            maxEdge: 1280,
            signal: controller.signal,
          });
          inputImages.push({
            ...preview,
            eventId: `synthetic-${round}`,
            index,
            label: `Current image ${index + 1}. Inspect only these new pixels, not prior images.`,
          });
        }
      active.expected = expected;
      await backend.run({
        prompt: `This is an isolated visual input test. ${round < 2 ? "Two NEW images are attached directly after this message. Read their colours in image order and top-left, top-right, bottom-left, bottom-right order. Do not use earlier pictures." : "There are NO images attached to this message. Do not report earlier image colours. Return an empty colours array."} ${cfg.type === "dsh" ? 'Do not use ANY tools. Reply only with JSON containing one flat colors array (eight strings for two images, empty for no image): {"colors":[...]}. Use English colour names red, green, blue, yellow.' : "Call probe_answer exactly once with the colours, then finish. No other action is allowed."}`,
        instructions:
          "You are a synthetic visual test. Inspect supplied pixels. No filesystem, network, QQ or image-reading tools are authorized. Missing pixels must not be guessed.",
        inputImages,
        tools: cfg.type === "dsh" ? [] : tools,
        signal: controller.signal,
        session,
        saveSession: (s) => {
          session = s;
        },
        callTool: async (name, args) => {
          active.toolCalls.push(name);
          assert.equal(name, "probe_answer");
          active.answers.push(args.colors);
          return { ok: true };
        },
      });
      if (cfg.type === "dsh") {
        const content = active.messages.flatMap(
          (m) => m.message?.content || m.content || [],
        );
        assert(
          !content.some((p) => p.type === "tool_use" || p.type === "tool-call"),
        );
        const text = content
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("\n");
        const match = /\{\s*"colors"\s*:\s*\[[\s\S]*?\]\s*\}/.exec(text);
        assert(match, "SYNTHETIC_ANSWER_MISSING");
        active.answers.push(JSON.parse(match[0]).colors.flat());
        assert.equal(active.nativeTools, 0);
      }
      assert.equal(active.answers.length, 1);
      assert.deepEqual(active.answers[0], expected);
      results.push({
        round,
        passed: true,
        images: inputImages.length,
        toolCalls: active.toolCalls,
        nativeTools: active.nativeTools,
        elapsedMs: Date.now() - started,
      });
      console.log(JSON.stringify(results.at(-1)));
    } finally {
      clearTimeout(timer);
    }
  }
} finally {
  fs.writeFileSync(
    path.join(root, "acceptance.json"),
    JSON.stringify(
      { backend: cfg.type, model: cfg.model, results, lastRound: active },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  await backend.close();
  console.log(JSON.stringify({ evidence: root, passed: results.length === 3 }));
}
