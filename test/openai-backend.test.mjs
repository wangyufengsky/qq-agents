import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  OpenAIBackend,
  FALLBACK_CONTEXT_WINDOW,
} from "../src/backends/openai.mjs";
import {
  BackendRegistry,
  backendCapabilities,
} from "../src/backends/index.mjs";
import {
  BackendTurnFailure,
  runWithRecovery,
} from "../src/backends/turn-failure.mjs";
import { validateConfig } from "../src/core/config.mjs";
import { fixture, config, raw, settle, temp } from "./helpers.mjs";

const reply = (
  message,
  usage = { prompt_tokens: 100, completion_tokens: 20 },
) =>
  new Response(JSON.stringify({ choices: [{ message }], usage }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
const status = (code, body = {}) =>
  new Response(JSON.stringify(body), { status: code });
const call = (id, name, args) => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});
// A scripted Chat Completions server; each entry answers one request.
function scripted(responses) {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({
      url,
      init,
      body: init.body ? JSON.parse(init.body) : undefined,
    });
    const next = responses.shift();
    if (!next) throw Error("unexpected request");
    return typeof next === "function" ? next(init) : next;
  };
  return { fetch, requests };
}
const backendConfig = (extra = {}) => ({
  id: "api",
  type: "openai",
  label: "API",
  baseUrl: "https://api.example.test/v1/",
  apiKeyEnv: "QQ_TEST_OPENAI_KEY",
  model: "fixture-model",
  effort: "high",
  contextWindow: 128000,
  toolServers: [],
  ...extra,
});
const tools = [
  {
    name: "qq_send",
    description: "send",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
  },
];
function params(overrides = {}) {
  const saved = [];
  return {
    saved,
    value: {
      prompt: "新消息",
      instructions: "你是角色 A",
      signal: new AbortController().signal,
      tools,
      callTool: async () => ({ ok: true }),
      session: null,
      saveSession: (s) => saved.push(s),
      ...overrides,
    },
  };
}

test("OpenAI-compatible backend runs the tool loop in process and keeps history locally", async (t) => {
  process.env.QQ_TEST_OPENAI_KEY = "fixture-key-value-0000";
  t.after(() => delete process.env.QQ_TEST_OPENAI_KEY);
  const root = temp(t);
  const server = scripted([
    reply({
      content: null,
      tool_calls: [call("c1", "qq_send", { text: "你好" })],
    }),
    reply({ content: "完成" }),
  ]);
  const backend = new OpenAIBackend(
    backendConfig(),
    { id: "agent-a" },
    {
      root,
      fetch: server.fetch,
    },
  );
  const toolCalls = [],
    usage = [],
    turns = [];
  const p = params({
    callTool: async (name, args) => {
      toolCalls.push({ name, args });
      return { delivered: true };
    },
    onUsage: (u) => usage.push(u),
    onBackendTurn: (r) => turns.push(r),
  });
  await backend.run(p.value);

  assert.deepEqual(toolCalls, [{ name: "qq_send", args: { text: "你好" } }]);
  assert.equal(server.requests.length, 2);
  const first = server.requests[0];
  assert.equal(first.url, "https://api.example.test/v1/chat/completions");
  assert.equal(
    first.init.headers.authorization,
    "Bearer fixture-key-value-0000",
  );
  assert.equal(first.init.redirect, "error");
  assert.equal(first.body.model, "fixture-model");
  assert.equal(first.body.reasoning_effort, undefined);
  assert.deepEqual(
    first.body.tools[0].function.parameters,
    tools[0].inputSchema,
  );
  assert.equal(first.body.messages[0].role, "system");
  assert.match(first.body.messages[0].content, /你是角色 A/);
  assert.deepEqual(first.body.messages[1], { role: "user", content: "新消息" });
  const second = server.requests[1].body.messages;
  assert.deepEqual(second.at(-1), {
    role: "tool",
    tool_call_id: "c1",
    content: JSON.stringify({ delivered: true }),
  });

  assert.equal(p.saved.length, 1);
  const session = p.saved[0];
  assert.equal(session.backend, "openai");
  assert.equal(session.signature, backend.sessionSignature(tools));
  const file = path.join(
    root,
    "openai",
    "agent-a",
    "sessions",
    session.id + ".json",
  );
  // Windows has no POSIX permission bits to check.
  if (process.platform !== "win32")
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const stored = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(
    stored.messages.map((m) => m.role),
    ["system", "user", "assistant", "tool", "assistant"],
  );
  assert.ok(!fs.readFileSync(file, "utf8").includes("fixture-key-value"));
  assert.equal(turns.length, 1);
  assert.equal(usage.at(-1).source, "measured");
  assert.equal(usage.at(-1).contextTokens, 120);
  assert.equal(usage.at(-1).capacityTokens, 128000);

  // The next turn continues the same local history without a new system prompt.
  server.requests.length = 0;
  const later = scripted([reply({ content: "收到" })]);
  backend.fetch = later.fetch;
  const q = params({ session, prompt: "第二条" });
  await backend.run(q.value);
  assert.equal(q.saved.length, 0);
  const messages = later.requests[0].body.messages;
  assert.equal(messages.filter((m) => m.role === "system").length, 1);
  assert.deepEqual(messages.at(-1), { role: "user", content: "第二条" });
});

test("tool results degrade images and audio unless the model accepts images", async (t) => {
  const image = {
    content: [
      { type: "text", text: "图片元数据" },
      { type: "image", mimeType: "image/png", data: "AAAA" },
      { type: "audio", mimeType: "audio/wav", data: "BBBB" },
    ],
  };
  for (const vision of [false, true]) {
    const server = scripted([
      reply({ content: null, tool_calls: [call("c1", "sticker_read", {})] }),
      reply({ content: "看完了" }),
    ]);
    const backend = new OpenAIBackend(
      backendConfig({ apiKeyEnv: undefined, vision }),
      { id: "agent-a" },
      { root: temp(t), fetch: server.fetch },
    );
    await backend.run(params({ callTool: async () => image }).value);
    const messages = server.requests[1].body.messages;
    const tool = messages.find((m) => m.role === "tool");
    assert.match(tool.content, /图片元数据/);
    assert.match(tool.content, /没有转录/);
    assert.equal(server.requests[0].init.headers.authorization, undefined);
    if (vision) {
      const last = messages.at(-1);
      assert.equal(last.role, "user");
      assert.equal(last.content[1].image_url.url, "data:image/png;base64,AAAA");
    } else {
      assert.match(tool.content, /没有看到画面/);
      assert.equal(messages.at(-1).role, "tool");
    }
  }
});

test("images from several tool calls follow every tool response", async (t) => {
  const server = scripted([
    reply({
      content: null,
      tool_calls: [
        call("a", "sticker_read", { n: 1 }),
        call("b", "sticker_read", { n: 2 }),
      ],
    }),
    reply({ content: "看完了" }),
  ]);
  const backend = new OpenAIBackend(
    backendConfig({ apiKeyEnv: undefined, vision: true }),
    { id: "agent-a" },
    { root: temp(t), fetch: server.fetch },
  );
  await backend.run(
    params({
      callTool: async (name, args) => ({
        content: [
          { type: "image", mimeType: "image/png", data: "IMG" + args.n },
        ],
      }),
    }).value,
  );
  const messages = server.requests[1].body.messages.slice(2);
  // Every pending call is answered before any user message.
  assert.deepEqual(
    messages.map((m) => m.role + (m.tool_call_id ? ":" + m.tool_call_id : "")),
    ["assistant", "tool:a", "tool:b", "user"],
  );
  assert.deepEqual(
    messages[3].content
      .filter((c) => c.type === "image_url")
      .map((c) => c.image_url.url),
    ["data:image/png;base64,IMG1", "data:image/png;base64,IMG2"],
  );
});

test("an image is sent once, then the history keeps only a note", async (t) => {
  const server = scripted([
    reply({ content: null, tool_calls: [call("a", "sticker_read", {})] }),
    reply({ content: null, tool_calls: [call("b", "qq_send", {})] }),
    reply({ content: "看完了" }),
  ]);
  const root = temp(t);
  const backend = new OpenAIBackend(
    backendConfig({ apiKeyEnv: undefined, vision: true }),
    { id: "agent-a" },
    { root, fetch: server.fetch },
  );
  const p = params({
    callTool: async (name) =>
      name === "sticker_read"
        ? { content: [{ type: "image", mimeType: "image/png", data: "IMG1" }] }
        : { ok: true },
  });
  await backend.run(p.value);
  const sent = (i) => JSON.stringify(server.requests[i].body.messages);
  assert.equal(sent(0).includes("IMG1"), false);
  assert.equal(sent(1).includes("data:image/png;base64,IMG1"), true);
  assert.equal(sent(2).includes("IMG1"), false, "not resent");
  assert.match(sent(2), /图片已在本会话中看过/);
  const file = path.join(
    root,
    "openai",
    "agent-a",
    "sessions",
    p.saved[0].id + ".json",
  );
  assert.equal(fs.readFileSync(file, "utf8").includes("IMG1"), false);
});

test("an unset context window comes from the model list, else a small fallback", async (t) => {
  const models = (data) =>
    new Response(JSON.stringify({ data }), { status: 200 });
  const run = async (first) => {
    const server = scripted([
      first,
      reply({ content: "好" }),
      reply({ content: "好" }),
    ]);
    const backend = new OpenAIBackend(
      backendConfig({ contextWindow: undefined }),
      { id: "agent-a" },
      { root: temp(t), fetch: server.fetch },
    );
    const usage = [];
    await backend.run(params({ onUsage: (u) => usage.push(u) }).value);
    // The lookup happens once per backend instance.
    await backend.run(params({ onUsage: (u) => usage.push(u) }).value);
    assert.deepEqual(
      server.requests.map((r) => new URL(r.url).pathname),
      ["/v1/models", "/v1/chat/completions", "/v1/chat/completions"],
    );
    return usage.map((u) => u.capacityTokens);
  };
  process.env.QQ_TEST_OPENAI_KEY = "fixture-key-value-0000";
  t.after(() => delete process.env.QQ_TEST_OPENAI_KEY);
  assert.deepEqual(
    await run(
      models([
        { id: "other", context_length: 1000000 },
        { id: "fixture-model", max_model_len: 8192 },
      ]),
    ),
    [8192, 8192],
  );
  assert.deepEqual(await run(models([{ id: "fixture-model" }])), [
    FALLBACK_CONTEXT_WINDOW,
    FALLBACK_CONTEXT_WINDOW,
  ]);
  assert.deepEqual(await run(status(404)), [
    FALLBACK_CONTEXT_WINDOW,
    FALLBACK_CONTEXT_WINDOW,
  ]);
});

test("tool failures are returned to the model as safe errors, not thrown", async (t) => {
  const server = scripted([
    reply({
      content: null,
      tool_calls: [call("c1", "qq_send", { text: "x" })],
    }),
    reply({ content: "好的" }),
  ]);
  const backend = new OpenAIBackend(
    backendConfig({ apiKeyEnv: undefined }),
    { id: "agent-a" },
    { root: temp(t), fetch: server.fetch },
  );
  await backend.run(
    params({
      callTool: async () => {
        throw Error("SEND_BUDGET_EXHAUSTED");
      },
    }).value,
  );
  const tool = server.requests[1].body.messages.at(-1);
  assert.equal(tool.role, "tool");
  assert.match(tool.content, /SEND_BUDGET_EXHAUSTED/);
});

test("transient failures keep complete steps for one continuation; provider text never leaks", async (t) => {
  const server = scripted([
    reply({
      content: null,
      tool_calls: [call("c1", "qq_send", { text: "一" })],
    }),
    status(503, {
      error: { message: "secret prompt echo sk-leak", code: "overloaded" },
    }),
    reply({ content: "继续完成" }),
  ]);
  const backend = new OpenAIBackend(
    backendConfig({ apiKeyEnv: undefined }),
    { id: "agent-a" },
    { root: temp(t), fetch: server.fetch },
  );
  let sends = 0,
    failure;
  const p = params({
    callTool: async () => {
      sends++;
      return { delivered: true };
    },
  });
  await runWithRecovery(backend, p.value, { onFailure: (e) => (failure = e) });
  assert.ok(failure instanceof BackendTurnFailure);
  assert.equal(failure.backend, "openai");
  assert.equal(failure.code, "serverError");
  assert.equal(failure.sessionReusable, true);
  assert.ok(!JSON.stringify(failure).includes("sk-leak"));
  assert.ok(!String(failure.message).includes("secret"));
  assert.equal(sends, 1, "the completed tool step is not replayed");
  const resumed = server.requests[2].body.messages;
  assert.equal(resumed.filter((m) => m.role === "tool").length, 1);
  assert.match(resumed.at(-1).content, /不要重做已经成功的工具操作/);
  assert.notEqual(p.saved.at(-1), null);
});

test("authentication and rate limits preserve history without retry; context overflow retires", async (t) => {
  for (const [response, code, category] of [
    [status(401), "unauthorized", "authentication"],
    [
      status(429, { error: { code: "rate_limit_exceeded" } }),
      "rateLimited",
      "rate-limit",
    ],
    [
      status(429, { error: { code: "insufficient_quota" } }),
      "insufficientQuota",
      "quota",
    ],
    [
      status(400, { error: { code: "context_length_exceeded" } }),
      "contextLengthExceeded",
      "context-limit",
    ],
  ]) {
    const server = scripted([response]);
    const backend = new OpenAIBackend(
      backendConfig({ apiKeyEnv: undefined }),
      { id: "agent-a" },
      { root: temp(t), fetch: server.fetch },
    );
    const p = params();
    const error = await runWithRecovery(backend, p.value).catch((e) => e);
    assert.ok(error instanceof BackendTurnFailure);
    assert.equal(error.code, code);
    assert.equal(error.category, category);
    const reusable = category !== "context-limit";
    assert.equal(error.sessionReusable, reusable);
    assert.equal(p.saved.at(-1) === null, !reusable);
    assert.equal(server.requests.length, 1);
  }
});

test("missing key, missing model and runaway tool loops fail closed", async (t) => {
  delete process.env.QQ_TEST_OPENAI_KEY;
  const noKey = new OpenAIBackend(
    backendConfig(),
    { id: "a" },
    {
      root: temp(t),
      fetch: async () => assert.fail("no request without a key"),
    },
  );
  const keyError = await noKey.run(params().value).catch((e) => e);
  assert.equal(keyError.message, "OPENAI_API_KEY_ENV_MISSING");
  await assert.rejects(noKey.health(), /OPENAI_API_KEY_ENV_MISSING/);

  const noModel = new OpenAIBackend(
    backendConfig({ apiKeyEnv: undefined, model: "" }),
    { id: "a" },
    { root: temp(t), fetch: async () => assert.fail() },
  );
  await assert.rejects(noModel.run(params().value), /OPENAI_MODEL_REQUIRED/);

  const loop = () =>
    reply({ content: null, tool_calls: [call("c", "qq_send", { text: "x" })] });
  const server = scripted([loop(), loop(), loop()]);
  const runaway = new OpenAIBackend(
    backendConfig({ apiKeyEnv: undefined, maxToolRounds: 2 }),
    { id: "a" },
    { root: temp(t), fetch: server.fetch },
  );
  const p = params();
  const error = await runaway.run(p.value).catch((e) => e);
  assert.equal(error.code, "TOOL_ROUND_LIMIT");
  assert.equal(server.requests.length, 2);
  assert.equal(p.saved.at(-1), null);
});

test("cancelling a turn aborts the request and drops the session", async (t) => {
  const controller = new AbortController();
  const backend = new OpenAIBackend(
    backendConfig({ apiKeyEnv: undefined }),
    { id: "a" },
    {
      root: temp(t),
      fetch: (url, init) =>
        new Promise((_, reject) => {
          init.signal.addEventListener("abort", () =>
            reject(init.signal.reason),
          );
          setImmediate(() => controller.abort());
        }),
    },
  );
  const p = params({ signal: controller.signal });
  await assert.rejects(backend.run(p.value), /ABORTED/);
  assert.equal(p.saved.at(-1), null);
  assert.equal(backend.active.size, 0);
});

test("a stored session is required to continue and must match the tool contract", async (t) => {
  const root = temp(t);
  const backend = new OpenAIBackend(
    backendConfig({ apiKeyEnv: undefined }),
    { id: "a" },
    { root, fetch: async () => reply({ content: "ok" }) },
  );
  const p = params();
  await backend.run(p.value);
  const session = p.saved[0];
  await assert.rejects(
    backend.run(params({ session, tools: [] }).value),
    /SESSION_REQUIRES_HANDOFF/,
  );
  await assert.rejects(
    backend.run(params({ session: { ...session, id: "../../escape" } }).value),
    /SESSION_REQUIRES_HANDOFF|OPENAI_SESSION_INVALID/,
  );
  fs.rmSync(path.join(root, "openai", "a", "sessions", session.id + ".json"));
  const missing = params({ session });
  await assert.rejects(backend.run(missing.value), /OPENAI_SESSION_MISSING/);
  assert.deepEqual(missing.saved, [null]);
  assert.throws(() => backend.file("../x"), /OPENAI_SESSION_INVALID/);
});

test("health lists models, tolerates servers without /models and maps auth failures", async (t) => {
  const make = (fetch, extra = {}) =>
    new OpenAIBackend(
      backendConfig({ apiKeyEnv: undefined, ...extra }),
      { id: "a" },
      {
        root: temp(t),
        fetch,
      },
    );
  const ok = await make(async (url) => {
    assert.equal(url, "https://api.example.test/v1/models");
    return new Response(JSON.stringify({ data: [{ id: "fixture-model" }] }));
  }).health();
  assert.deepEqual(ok, {
    models: [{ id: "fixture-model" }],
    endpoint: "https://api.example.test",
  });
  assert.deepEqual((await make(async () => status(404)).health()).models, [
    { id: "fixture-model" },
  ]);
  await assert.rejects(
    make(async () => status(404), { model: "" }).health(),
    /BACKEND_PROBE_FAILED/,
  );
  await assert.rejects(
    make(async () => status(401)).health(),
    /OPENAI_AUTH_FAILED/,
  );
  await assert.rejects(
    make(
      async () => new Response(JSON.stringify({ data: [{ id: "other" }] })),
    ).health(),
    /BACKEND_MODEL_UNAVAILABLE/,
  );
  await assert.rejects(
    make(async () => {
      throw TypeError("fetch failed");
    }).health(),
    /OPENAI_UNREACHABLE/,
  );
});

test("reasoning effort is only sent when explicitly enabled", async (t) => {
  const server = scripted([reply({ content: "ok" })]);
  const backend = new OpenAIBackend(
    backendConfig({ apiKeyEnv: undefined, sendEffort: true, effort: "low" }),
    { id: "a" },
    { root: temp(t), fetch: server.fetch },
  );
  await backend.run(params().value);
  assert.equal(server.requests[0].body.reasoning_effort, "low");
});

test("config accepts OpenAI-compatible backends and keeps DSH/Codex unchanged", () => {
  const base = config(1);
  const withBackend = (backend) =>
    validateConfig({
      ...base,
      backends: [backend],
      agents: base.agents.map((a) => ({ ...a, backendId: backend.id })),
    });
  const parsed = withBackend(backendConfig({ vision: true }));
  assert.equal(parsed.backends[0].type, "openai");
  assert.equal(parsed.backends[0].vision, true);
  // Loopback HTTP is fine for a local server such as Ollama.
  withBackend(backendConfig({ baseUrl: "http://127.0.0.1:11434/v1" }));
  for (const baseUrl of [
    "http://api.example.test/v1",
    "https://user:pass@api.example.test/v1",
    "https://api.example.test/v1?key=x",
  ])
    assert.throws(() => withBackend(backendConfig({ baseUrl })));
  assert.throws(() => withBackend(backendConfig({ baseUrl: undefined })));
  assert.throws(() => withBackend(backendConfig({ apiKeyEnv: "lower-case" })));
  // DSH still needs loopback, and OpenAI-only settings are rejected elsewhere.
  assert.throws(() =>
    withBackend({
      id: "d",
      type: "dsh",
      label: "D",
      baseUrl: "https://x.test",
    }),
  );
  assert.throws(() =>
    withBackend({ id: "c", type: "codex", label: "C", apiKeyEnv: "KEY" }),
  );
  const codex = withBackend({ id: "c", type: "codex", label: "C" }).backends[0];
  for (const key of ["contextWindow", "maxToolRounds", "vision", "sendEffort"])
    assert.equal(Object.hasOwn(codex, key), false);
});

test("registry creates the backend and capabilities hide native image generation", (t) => {
  const registry = new BackendRegistry();
  const backend = registry.create(
    backendConfig(),
    { id: "a" },
    { root: temp(t) },
  );
  assert.ok(backend instanceof OpenAIBackend);
  assert.deepEqual(backendCapabilities("openai"), {
    compaction: false,
    imageGeneration: false,
  });
  assert.equal(backendCapabilities("codex").imageGeneration, true);
  assert.equal(typeof backend.compact, "undefined");
  assert.equal(typeof backend.imageHistory, "undefined");
});

test("a real runtime turn delivers through the bridge send path", async (t) => {
  const cfg = config(1);
  cfg.backends = [
    validateConfig({
      ...cfg,
      backends: [backendConfig({ apiKeyEnv: undefined })],
      agents: cfg.agents.map((a) => ({ ...a, backendId: "api" })),
    }).backends[0],
  ];
  cfg.agents = cfg.agents.map((a) => ({ ...a, backendId: "api" }));
  const f = fixture(t, { cfg });
  assert.deepEqual(
    f.runtime
      .toolsFor(f.runtime.agent("agent-0"), "group:20000")
      .includes("generated_image_list"),
    false,
  );
  const server = scripted([
    reply({
      content: null,
      tool_calls: [call("c1", "conversation_read", { afterSeq: 0 })],
    }),
    reply({
      content: null,
      tool_calls: [
        call("c2", "qq_send", {
          requestId: "openai:1",
          text: "来自 API 的回复",
        }),
      ],
    }),
    reply({ content: "结束" }),
  ]);
  const backend = new OpenAIBackend(
    cfg.backends[0],
    f.runtime.agent("agent-0"),
    {
      root: f.root,
      fetch: server.fetch,
    },
  );
  f.runtime.backends.set("agent-0", backend);
  // Participation 1 wakes the agent on ingest.
  await f.runtime.ingest("qq-0", raw());
  await settle(f.runtime);
  assert.equal(server.requests.length, 3);
  assert.equal(f.runtime.faults.get("agent-0"), undefined);
  const sent = f.runtime.transports.get("qq-0").sent;
  assert.equal(sent.length, 1);
  assert.match(JSON.stringify(sent[0].segments), /来自 API 的回复/);
  // The direct-call prompt never asks the model to copy a capability token.
  const system = server.requests[0].body.messages[0].content;
  const user = server.requests[0].body.messages[1].content;
  assert.doesNotMatch(system + user, /bridge_call/);
  assert.doesNotMatch(user, /context=/);
});
