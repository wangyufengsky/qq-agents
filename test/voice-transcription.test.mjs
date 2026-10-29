import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fixture, config, raw, context } from "./helpers.mjs";
import { wav } from "./audio-fixture.mjs";
import { validateConfig } from "../src/core/config.mjs";
import { Diagnostics } from "../src/core/diagnostics.mjs";
import { ExternalTools } from "../src/backends/external.mjs";
import { VoiceStore } from "../src/tools/voice.mjs";
import { freezeEvidence } from "../src/memory/evidence.mjs";
import { liveInput } from "../src/core/live-input.mjs";
import { transcriptText } from "../src/core/voice-transcription.mjs";

const GROUP = "group:20000";
const PLACEHOLDER = "[record; 尚未识别内容]";
const record = (id) => ({
  type: "record",
  data: { file: `fixture-${id}.amr`, file_size: 2048 },
});
const voiceRaw = (id, extra = {}) =>
  raw(id, { message: [record(id)], ...extra });
const privateVoice = (id) =>
  voiceRaw(id, { message_type: "private", group_id: undefined });

function setup(
  t,
  {
    asr = {},
    enabled = true,
    paused = false,
    external,
    duration = 1.5,
    audio = wav(),
    onRecord,
  } = {},
) {
  const base = config(1),
    agent = base.agents[0];
  const cfg = validateConfig({
    ...base,
    backends: [
      {
        ...base.backends[0],
        toolServers: [
          {
            id: "asr",
            command: process.execPath,
            args: [path.resolve("test/asr-mcp-fixture.mjs")],
            allowedTools: ["transcribe"],
          },
        ],
      },
    ],
    agents: [
      {
        ...agent,
        paused,
        tools: [...agent.tools, "qq_voice_read"],
        voice: {
          ...agent.voice,
          asr: enabled
            ? {
                ...agent.voice.asr,
                enabled: true,
                serverId: "asr",
                tool: "transcribe",
                waitMs: 2000,
                ...asr,
              }
            : agent.voice.asr,
        },
      },
    ],
  });
  const f = fixture(t, { cfg }),
    prompts = [],
    calls = [],
    records = [];
  f.runtime.diagnostics = new Diagnostics({ write: () => {} });
  f.runtime.voices = new VoiceStore(path.join(f.root, "voices"), {
    probe: async () => ({ ok: true, codec: "pcm_s16le", duration }),
  });
  f.runtime.backends.set("agent-0", {
    run: async (p) => {
      prompts.push(p.prompt);
      p.saveSession({ id: "s", backend: "fixture" });
    },
    cancel: async () => {},
    close: async () => external?.close?.(),
    external: external || {
      call: async (serverId, tool, args, options) => {
        calls.push({ serverId, tool, args, options });
        return { content: [{ type: "text", text: "明天下午三点开会" }] };
      },
    },
  });
  f.runtime.transports.get("qq-0").call = async (action, params, ms, opts) => {
    records.push({ action, params, ms, opts });
    await onRecord?.(f);
    if (action !== "get_record") throw Error("ONEBOT_REJECTED");
    return { base64: audio.toString("base64") };
  };
  return { ...f, prompts, calls, records, m: f.store.bind("agent-0") };
}
async function drain(f) {
  while (f.runtime.jobs.size || f.runtime.work.size)
    await Promise.allSettled([...f.runtime.jobs, ...f.runtime.work]);
}
async function until(check) {
  for (let i = 0; i < 300 && !check(); i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check());
}
const rows = (f, kind) =>
  f.store.db
    .prepare(
      "SELECT * FROM events WHERE agent_id='agent-0' AND kind=? ORDER BY seq",
    )
    .all(kind);
const codes = (f) => f.runtime.diagnostics.snapshot().map((d) => d.code);

test("voice transcription is off by default: nothing is downloaded or sent", async (t) => {
  const f = setup(t, { enabled: false });
  assert.equal(f.runtime.agent("agent-0").voice.asr.enabled, false);
  await f.runtime.ingest("qq-0", voiceRaw(42));
  await drain(f);
  assert.deepEqual(f.records, []);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(rows(f, "voice.transcript"), []);
  assert.equal(f.prompts.length, 1);
  assert.ok(f.prompts[0].includes(PLACEHOLDER));
  assert.doesNotMatch(f.prompts[0], /voiceTranscript/);
  assert.deepEqual(codes(f), []);
});

test("a transcript is its own record: the model sees it marked, the message stays as it was", async (t) => {
  const f = setup(t);
  await f.runtime.ingest("qq-0", voiceRaw(42));
  await drain(f);
  const [message] = rows(f, "message.received"),
    [transcript] = rows(f, "voice.transcript");
  // The archived message keeps its placeholder body and original segments.
  assert.equal(message.body, PLACEHOLDER);
  assert.deepEqual(JSON.parse(message.payload).segments, [record(42)]);
  assert.equal(transcript.body, "明天下午三点开会");
  assert.equal(transcript.direction, "internal");
  assert.equal(transcript.sender_id, "30000");
  assert.equal(transcript.conversation, GROUP);
  const payload = JSON.parse(transcript.payload);
  assert.equal(payload.sourceEventId, message.id);
  assert.equal(payload.epistemic, "machine-transcription");
  assert.deepEqual(payload.service, { serverId: "asr", tool: "transcribe" });
  // The audio went through get_record into this agent's voice library.
  assert.deepEqual(
    f.records.map((r) => [r.action, r.params]),
    [["get_record", { file: "fixture-42.amr", out_format: "wav" }]],
  );
  assert.ok(f.records[0].opts.maxBytes < 12 * 1024 * 1024);
  const [stored] = f.runtime.voices.list("agent-0").items;
  assert.equal(stored.id, payload.audioId);
  assert.equal(stored.sources[0].eventId, message.id);
  // Only the configured tool got the bytes, with the configured names.
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].serverId, "asr");
  assert.equal(f.calls[0].tool, "transcribe");
  assert.deepEqual(Object.keys(f.calls[0].args).sort(), ["audio", "mimeType"]);
  assert.equal(f.calls[0].args.audio, wav().toString("base64"));
  assert.equal(f.calls[0].args.mimeType, "audio/wav");
  assert.equal(f.calls[0].options.timeoutMs, 60000);
  assert.ok(f.calls[0].options.signal instanceof AbortSignal);
  // The turn waited briefly, so it reads the text beside the placeholder,
  // marked as a machine transcription, once.
  assert.equal(f.prompts.length, 1);
  assert.ok(f.prompts[0].includes(PLACEHOLDER));
  assert.equal(f.prompts[0].split("明天下午三点开会").length - 1, 1);
  assert.match(f.prompts[0], /语音转写：机器识别，可能有误/);
  // Searchable, readable, and never human input authority.
  const found = f.m.search({ query: "三点开会" }, GROUP).items;
  assert.deepEqual(
    found.map((x) => [x.id, x.type]),
    [[transcript.id, "voice.transcript"]],
  );
  assert.match(found[0].epistemic, /Machine transcription/);
  assert.equal(found[0].sourceEventId, message.id);
  assert.equal(
    f.m.view({ id: message.id }).voiceTranscript.text,
    "明天下午三点开会",
  );
  assert.equal(f.m.view({ id: transcript.id }).sourceEventId, message.id);
  assert.equal(liveInput(f.runtime, "agent-0", GROUP, transcript.id), null);
  assert.deepEqual(codes(f), []);
});

test("transcripts serve as evidence marked as machine transcription", async (t) => {
  const f = setup(t);
  await f.runtime.ingest("qq-0", voiceRaw(42));
  await drain(f);
  const [transcript] = rows(f, "voice.transcript"),
    ctx = context(f.runtime);
  const proof = freezeEvidence(f.m, [transcript.id], f.runtime.now());
  assert.equal(proof.roots[0].epistemic, "machine-transcription");
  assert.equal(
    proof.references.find((r) => r.id === transcript.id).metadata.epistemic,
    "machine-transcription",
  );
  const card = await f.runtime.callTool(ctx, "person_note", {
    personId: "30000",
    body: "约了明天下午开会",
    evidence: [transcript.id],
  });
  assert.deepEqual(card.evidence, [transcript.id]);
  const mood = await f.runtime.callTool(ctx, "mood_set", {
    mood: "期待",
    intensity: 2,
    reason: "有人约开会",
    evidence: [transcript.id],
  });
  assert.deepEqual(f.m.identity.moodPeople([mood], "10000").get(mood.id), [
    "30000",
  ]);
  const read = await f.runtime.callTool(ctx, "qq_voice_read", {
    eventId: rows(f, "message.received")[0].id,
  });
  assert.deepEqual(JSON.parse(read.content[0].text).transcript, {
    id: transcript.id,
    text: "明天下午三点开会",
    epistemic: "machine-transcription",
  });
});

test("a failed, empty or timed-out transcription keeps the placeholder and leaves one diagnostic", async (t) => {
  const cases = [
    ["VOICE_TRANSCRIPTION_FAILED", async () => Promise.reject(Error("boom"))],
    [
      "VOICE_TRANSCRIPTION_FAILED",
      async () => ({ isError: true, content: [{ type: "text", text: "x" }] }),
    ],
    [
      "VOICE_TRANSCRIPTION_EMPTY",
      async () => ({ content: [{ type: "text", text: "  " }] }),
    ],
    [
      "VOICE_TRANSCRIPTION_TIMEOUT",
      (_s, _t, _a, { signal }) =>
        new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(Error("aborted"))),
        ),
    ],
  ];
  for (const [code, call] of cases) {
    const f = setup(t, {
      asr: { timeoutMs: 1000, waitMs: 100 },
      external: { call },
    });
    await f.runtime.ingest("qq-0", voiceRaw(42));
    await drain(f);
    assert.deepEqual(codes(f), [code]);
    assert.deepEqual(rows(f, "voice.transcript"), []);
    const [message] = rows(f, "message.received");
    assert.equal(message.body, PLACEHOLDER);
    assert.equal(f.m.view({ id: message.id }).voiceTranscript, undefined);
    assert.equal(f.prompts.length, 1, code);
    assert.ok(f.prompts[0].includes(PLACEHOLDER));
    assert.doesNotMatch(f.prompts[0], /语音转写：/);
    if (code === "VOICE_TRANSCRIPTION_TIMEOUT")
      assert.match(f.prompts[0], /语音转写中/);
  }
});

test("voice over the size or length limit, or of unknown length, is never sent", async (t) => {
  const cases = [
    ["AUDIO_TOO_LARGE", { asr: { maxBytes: 65536 }, audio: wav(5) }],
    ["AUDIO_TOO_LONG", { asr: { maxSeconds: 60 }, duration: 61 }],
    [
      "VOICE_TRANSCRIPTION_FORMAT_UNSUPPORTED",
      { audio: Buffer.from("\x02#!SILK_V3" + "x".repeat(200), "latin1") },
    ],
  ];
  for (const [code, options] of cases) {
    const f = setup(t, options);
    await f.runtime.ingest("qq-0", voiceRaw(42));
    await drain(f);
    assert.deepEqual(codes(f), [code]);
    assert.deepEqual(f.calls, [], code);
    assert.deepEqual(rows(f, "voice.transcript"), []);
  }
});

test("paused or protected conversations, other tools and an exhausted budget send nothing", async (t) => {
  // A paused agent or conversation is a deliberate stop: no diagnostic.
  const agent = setup(t, { paused: true });
  await agent.runtime.ingest("qq-0", voiceRaw(42));
  const conversation = setup(t);
  conversation.m.setState(GROUP, {
    ...conversation.m.state(GROUP),
    paused: true,
  });
  await conversation.runtime.ingest("qq-0", voiceRaw(42));
  for (const f of [agent, conversation]) {
    await drain(f);
    assert.deepEqual([f.records, f.calls, codes(f)], [[], [], []]);
  }
  // Paused while the audio was downloading: it still does not leave.
  const midway = setup(t, {
    onRecord: (f) =>
      f.store.bind("agent-0").setState(GROUP, {
        ...f.store.bind("agent-0").state(GROUP),
        paused: true,
      }),
  });
  await midway.runtime.ingest("qq-0", voiceRaw(42));
  await drain(midway);
  assert.equal(midway.records.length, 1);
  assert.deepEqual([midway.calls, codes(midway)], [[], []]);
  // A conversation that holds operations material sends nothing unprompted.
  const protectedChat = setup(t);
  protectedChat.m.setState(GROUP, {
    ...protectedChat.m.state(GROUP),
    disclosureTaint: ["operations:fixture-source"],
  });
  await protectedChat.runtime.ingest("qq-0", voiceRaw(42));
  await drain(protectedChat);
  assert.deepEqual([protectedChat.records, protectedChat.calls], [[], []]);
  assert.deepEqual(codes(protectedChat), ["VOICE_TRANSCRIPTION_DENIED"]);
  // Only a tool on the backend's allowlist is ever used.
  const other = setup(t, { asr: { tool: "shell" } });
  await other.runtime.ingest("qq-0", voiceRaw(42));
  await drain(other);
  assert.deepEqual([other.records, other.calls], [[], []]);
  assert.deepEqual(codes(other), ["EXTERNAL_TOOL_DISABLED"]);
  // The hourly cap counts calls per agent.
  const budget = setup(t, { asr: { maxPerHour: 1 } });
  await budget.runtime.ingest("qq-0", voiceRaw(42));
  await budget.runtime.ingest("qq-0", voiceRaw(43));
  await drain(budget);
  assert.equal(budget.calls.length, 1);
  assert.deepEqual(codes(budget), ["VOICE_TRANSCRIPTION_BUDGET"]);
});

test("a settings change during the download applies to the call that follows", async (t) => {
  // The administrator switches tools or lowers a limit while audio downloads.
  const edit = (change) => (f) => {
    const next = structuredClone(f.runtime.config);
    change(next);
    f.configStore.value = validateConfig(next);
  };
  const switched = setup(t, {
    onRecord: edit((c) => {
      c.backends[0].toolServers[0].allowedTools.push("whisper");
      Object.assign(c.agents[0].voice.asr, {
        tool: "whisper",
        mimeArgument: "",
      });
    }),
  });
  await switched.runtime.ingest("qq-0", voiceRaw(42));
  await drain(switched);
  assert.deepEqual(
    switched.calls.map((c) => [c.tool, Object.keys(c.args)]),
    [["whisper", ["audio"]]],
  );
  assert.deepEqual(
    JSON.parse(rows(switched, "voice.transcript")[0].payload).service,
    { serverId: "asr", tool: "whisper" },
  );
  const lowered = setup(t, {
    duration: 30,
    onRecord: edit((c) => (c.agents[0].voice.asr.maxSeconds = 10)),
  });
  await lowered.runtime.ingest("qq-0", voiceRaw(42));
  await drain(lowered);
  assert.deepEqual(lowered.calls, []);
  assert.deepEqual(codes(lowered), ["AUDIO_TOO_LONG"]);
});

test("a transcript that lands after the turn stopped waiting wakes the agent once more", async (t) => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const f = setup(t, {
    asr: { waitMs: 0 },
    external: {
      call: async () => {
        await gate;
        return { content: [{ type: "text", text: "晚点到的语音内容" }] };
      },
    },
  });
  await f.runtime.ingest("qq-0", privateVoice(42));
  await until(() => f.prompts.length === 1 && f.runtime.running.size === 0);
  assert.match(f.prompts[0], /语音转写中/);
  assert.doesNotMatch(f.prompts[0], /晚点到的语音内容/);
  release();
  await drain(f);
  assert.equal(f.prompts.length, 2);
  assert.match(f.prompts[1], /晚点到的语音内容/);
  assert.match(f.prompts[1], /Machine transcription/);
});

test("the synthetic MCP transcription server receives the audio and fixed arguments", async (t) => {
  const external = new ExternalTools([
    {
      id: "asr",
      transport: "stdio",
      command: process.execPath,
      args: [path.resolve("test/asr-mcp-fixture.mjs")],
      env: {},
      headers: {},
      allowedTools: ["transcribe"],
    },
  ]);
  t.after(() => external.close());
  const f = setup(t, { asr: { arguments: { language: "zh" } }, external });
  await f.runtime.ingest("qq-0", voiceRaw(42));
  await drain(f);
  assert.deepEqual(codes(f), []);
  assert.equal(
    rows(f, "voice.transcript")[0].body,
    "合成转写：RIFF audio/wav zh",
  );
});

test("transcript text is unwrapped from structured or JSON answers", () => {
  assert.equal(
    transcriptText({
      structuredContent: { transcript: " 你好 " },
      content: [],
    }),
    "你好",
  );
  assert.equal(
    transcriptText({ content: [{ type: "text", text: '{"text":"在吗"}' }] }),
    "在吗",
  );
  assert.equal(
    transcriptText({ content: [{ type: "text", text: "{不是 JSON" }] }),
    "{不是 JSON",
  );
  assert.equal(transcriptText({ content: [{ type: "image" }] }), "");
});

test("the transcription config is checked before it is saved", () => {
  const base = config(1),
    agent = base.agents[0];
  const save = (asr) =>
    validateConfig({
      ...base,
      agents: [{ ...agent, voice: { ...agent.voice, asr } }],
    });
  assert.throws(() => save({ enabled: true }), /ASR_TOOL_REQUIRED/);
  assert.throws(
    () => save({ audioArgument: "audio", mimeArgument: "audio" }),
    /ASR_ARGUMENT_COLLISION/,
  );
  assert.throws(
    () => save({ arguments: { audio: "x" } }),
    /ASR_ARGUMENT_COLLISION/,
  );
  assert.throws(() => save({ audioArgument: "__proto__" }));
  assert.equal(save({}).agents[0].voice.asr.enabled, false);
});

test("the role form saves transcription settings and keeps them when untouched", () => {
  const base = config(1),
    original = base.agents[0];
  const agentForm = vm.runInContext(
    fs.readFileSync(
      new URL("../public/agent-form.js", import.meta.url),
      "utf8",
    ) + "\n;agentForm",
    vm.createContext({
      tools: [],
      config: {
        backends: [
          {
            id: "fixture",
            toolServers: [{ id: "asr", allowedTools: ["transcribe", "other"] }],
          },
        ],
      },
    }),
  );
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(agentForm.asrToolOptions("fixture", {}).map(([v]) => v)),
    ),
    ["", '["asr","transcribe"]', '["asr","other"]'],
  );
  const shown = {
    id: original.id,
    silence: "[]",
    asrTool: "",
    asrAudioArgument: "audio",
    asrMimeArgument: "mimeType",
    asrMaxSeconds: "90",
    asrMaxMegabytes: "8",
    asrTimeoutSeconds: "60",
    asrWaitSeconds: "8",
    asrMaxPerHour: "60",
    asrArguments: "{}",
  };
  // Values made inside the VM carry its prototypes; compare plain copies.
  const plain = (x) => JSON.parse(JSON.stringify(x));
  const parse = (fields) =>
    plain(agentForm.parse(new Map(Object.entries(fields)), original).row.voice);
  assert.deepEqual(parse(shown), original.voice);
  const edited = parse({
    ...shown,
    asrEnabled: "on",
    asrTool: '["asr","transcribe"]',
    asrMaxMegabytes: "4",
    asrWaitSeconds: "2.5",
    asrArguments: '{"language":"zh"}',
  });
  const saved = validateConfig({
    ...base,
    backends: [
      {
        ...base.backends[0],
        toolServers: [
          { id: "asr", command: "asr", allowedTools: ["transcribe"] },
        ],
      },
    ],
    agents: [{ ...original, voice: edited }],
  }).agents[0].voice.asr;
  assert.deepEqual(
    [
      saved.enabled,
      saved.serverId,
      saved.tool,
      saved.maxBytes,
      saved.waitMs,
      saved.arguments,
      saved.maxSeconds,
    ],
    [true, "asr", "transcribe", 4194304, 2500, { language: "zh" }, 90],
  );
});
