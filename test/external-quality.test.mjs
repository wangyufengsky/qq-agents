import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { ExternalTools } from "../src/backends/external.mjs";
import { MediaStore } from "../src/tools/media.mjs";
import { VoiceStore } from "../src/tools/voice.mjs";
import {
  externalResult,
  externalArguments,
} from "../src/tools/external-media.mjs";
import { toolSpecs } from "../src/tools/index.mjs";
import { temp, fixture, config } from "./helpers.mjs";
import { wav } from "./audio-fixture.mjs";
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC1lEQVR42mP8/x8AAwMCAO+a/pkAAAAASUVORK5CYII=";
test("MCP discovery returns only actual allowlisted names and schemas, rejects unknown server/tool", async (t) => {
  const e = new ExternalTools([
    {
      id: "fixture",
      command: process.execPath,
      args: [path.resolve("test/image-mcp-fixture.mjs")],
      allowedTools: ["image_generate", "missing"],
    },
  ]);
  t.after(() => e.close());
  const r = await e.list("fixture");
  assert.deepEqual(
    r.servers[0].tools.map((t) => t.name),
    ["image_generate"],
  );
  assert.equal(r.servers[0].tools[0].inputSchema.type, "object");
  assert.deepEqual(r.servers[0].unavailable, ["missing"]);
  await assert.rejects(e.call("fixture", "missing", {}), /UNAVAILABLE/);
  await assert.rejects(e.call("fixture", "shell", {}), /DISABLED/);
});
test("external media detects MIME mismatch, handles embedded blobs and does not register error payloads", async (t) => {
  const root = temp(t),
    media = new MediaStore(path.join(root, "media")),
    runtime = { media, assertActive() {} },
    ctx = { agentId: "agent-a", conversation: "group:20000" },
    args = { serverId: "fixture", tool: "generate" };
  await assert.rejects(
    externalResult(runtime, ctx, args, {
      content: [{ type: "image", data: png, mimeType: "image/jpeg" }],
    }),
    /MIME_MISMATCH/,
  );
  const r = await externalResult(runtime, ctx, args, {
    content: [
      {
        type: "resource",
        resource: { uri: "test:artifact", mimeType: "image/png", blob: png },
      },
    ],
    structuredContent: { status: "generated" },
  });
  const id = JSON.parse(
    r.content.find((c) => c.text?.includes("generatedMedia")).text,
  ).generatedMedia.id;
  assert.equal(media.metadata("agent-a", id).generatedBy, "fixture:generate");
  assert.throws(() => media.read("agent-b", id), /NOT_FOUND/);
  const err = await externalResult(runtime, ctx, args, {
    isError: true,
    content: [
      { type: "image", data: png, mimeType: "image/png" },
      { type: "text", text: "failure" },
    ],
  });
  assert.deepEqual(err, {
    isError: true,
    content: [{ type: "text", text: "failure" }],
  });
});
test("owned audio input binds bytes only after independent external disclosure checks", async (t) => {
  const { runtime } = fixture(t);
  runtime.voices = new VoiceStore(path.join(runtime.root || temp(t), "voices"));
  const a = runtime.agent("agent-0"),
    ctx = runtime.makeContext(a.id, "group:20000");
  const m = await runtime.voices.put(a.id, wav(), a.voice, {
    conversation: "private:30000",
  });
  assert.throws(
    () =>
      externalArguments(runtime, ctx, {
        arguments: {},
        audioInput: { audioId: m.id, dataArgument: "audio" },
      }),
    /EXTERNAL_CALL_BLOCKED/,
  );
  assert.throws(
    () =>
      externalArguments(runtime, ctx, {
        arguments: { audio: "x" },
        audioInput: { audioId: m.id, dataArgument: "audio" },
      }),
    /COLLISION/,
  );
  const other = runtime.makeContext("agent-1", "private:30000");
  assert.throws(
    () =>
      externalArguments(runtime, other, {
        arguments: {},
        audioInput: { audioId: m.id, dataArgument: "audio" },
      }),
    /NOT_FOUND/,
  );
});
test("local TTS disabled by default and capability schemas stay explicit", async (t) => {
  const cfg = config();
  cfg.agents[0].tools.push("voice_synthesize");
  const { runtime } = fixture(t, { cfg });
  const ctx = runtime.makeContext("agent-0", "group:20000");
  await assert.rejects(
    runtime.callTool(ctx, "voice_synthesize", { text: "合成验收" }),
    /TTS_DISABLED/,
  );
  const names = toolSpecs().map((s) => s.name);
  for (const name of [
    "memory_related",
    "external_tools",
    "voice_synthesize",
    "social_status",
  ])
    assert.ok(names.includes(name));
});

test("TTS origin and protected operations survive voice persistence and later tool access", async (t) => {
  const root = temp(t),
    store = new VoiceStore(path.join(root, "voice")),
    policy = config(1).agents[0].voice;
  const m = await store.put("agent-a", wav(), policy, {
    generatedBy: "macos-say",
    spokenText: "合成验收",
    conversation: "private:30000",
    protectedOperations: true,
  });
  const reopened = new VoiceStore(path.join(root, "voice")),
    r = reopened.metadata("agent-a", m.id);
  assert.equal(r.generatedBy, "macos-say");
  assert.equal(r.textSource, "tts-input-not-asr");
  assert.equal(r.protectedOperations, true);
  await reopened.put("agent-a", wav(), policy, { conversation: "group:20000" });
  assert.equal(reopened.metadata("agent-a", m.id).protectedOperations, true);
});

test("safe tool failures never reflect raw provider secrets or arbitrary validation values", async () => {
  const { safeToolFailure } = await import("../src/tools/errors.mjs");
  const { z } = await import("zod");
  const result = safeToolFailure(
    Error("provider rejected secret-content and local/path"),
  );
  assert.equal(result.code, "TOOL_FAILED");
  assert.ok(!JSON.stringify(result).includes("secret-content"));
  const err = z
    .object({ requestId: z.string() })
    .safeParse({ requestId: { sensitive: "private" } }).error;
  assert.ok(!JSON.stringify(safeToolFailure(err)).includes("private"));
});
