import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  AntigravityBackend,
  antigravityFailure,
  antigravityShellQuote,
  antigravitySchemaContract,
} from "../src/backends/antigravity.mjs";
import { antigravityToolAllowed } from "../src/backends/antigravity-guard.mjs";
import {
  BackendRegistry,
  backendCapabilities,
} from "../src/backends/index.mjs";
import { validateConfig } from "../src/core/config.mjs";
import { buildChildEnv } from "../src/core/child-env.mjs";
import { config, temp, fixture as runtimeFixture } from "./helpers.mjs";
import { toolSpecs } from "../src/tools/specs.mjs";
import { AntigravityMedia } from "../src/backends/antigravity-media.mjs";
import { mediaLease } from "../src/tools/media-lease.mjs";
import { colorGrid } from "../scripts/fixtures/antigravity-media.mjs";
import { registry } from "../src/tools/registry.mjs";
import { SessionPreparationFailure } from "../src/backends/turn-failure.mjs";

const fixture = fileURLToPath(
  new URL("./antigravity-fixture.mjs", import.meta.url),
);
const tool = {
  name: "probe",
  description: "Synthetic test",
  inputSchema: { type: "object", properties: {} },
};
function setup(
  t,
  mode = "success",
  root = temp(t),
  { fakeChild = false, cliProtocol } = {},
) {
  const cfg = config();
  const backendConfig = validateConfig({
    ...cfg,
    backends: [
      {
        id: "fixture",
        label: "Fixture",
        type: "antigravity",
        model: "fixture-model",
        effort: "",
        ...(cliProtocol ? { cliProtocol } : {}),
      },
    ],
  }).backends[0];
  const launches = [];
  const backend = new AntigravityBackend(backendConfig, cfg.agents[0], {
    root,
    spawn(command, args, options) {
      const child = fakeChild
        ? createFakeChild()
        : spawn(process.execPath, [fixture, ...args], {
            ...options,
            env: { ...options.env, AGY_FIXTURE_MODE: mode },
          });
      launches.push({ command, args, options, pid: child.pid });
      if (fakeChild) launches.at(-1).child = child;
      return child;
    },
    ...(fakeChild
      ? {
          stop(child, signal) {
            child.kill(signal);
          },
        }
      : {}),
  });
  t.after(() => backend.close());
  const controller = new AbortController();
  const sessions = [];
  const calls = [];
  const params = {
    conversation: "private:synthetic",
    prompt: "PRIVATE_SYNTHETIC_PROMPT",
    instructions: "Synthetic role.",
    tools: [tool],
    signal: controller.signal,
    saveSession: (s) => sessions.push(s),
    callTool: async (name, args) => {
      calls.push({ name, args });
      return { ok: true };
    },
  };
  return {
    backend,
    params,
    sessions,
    calls,
    launches,
    controller,
    root,
    backendConfig,
  };
}

function createFakeChild() {
  const child = new EventEmitter();
  child.pid = 5252;
  child.exitCode = null;
  child.signalCode = null;
  child.inputs = [];
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let inputBuffer = "";
  let resolveInput;
  child.inputReady = new Promise((resolve) => {
    resolveInput = resolve;
  });
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      inputBuffer += chunk.toString();
      while (inputBuffer.includes("\n")) {
        const end = inputBuffer.indexOf("\n");
        const line = inputBuffer.slice(0, end);
        inputBuffer = inputBuffer.slice(end + 1);
        if (line.trim()) {
          const input = JSON.parse(line);
          child.inputs.push(input);
          resolveInput(input);
          resolveInput = () => {};
        }
      }
      callback();
    },
  });
  child.kill = (signal) => {
    child.killedBy = signal;
    return true;
  };
  child.emitFrames = (...frames) =>
    child.stdout.write(
      `${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`,
    );
  child.closeWith = (code, signal = null) => {
    child.exitCode = signal ? null : code;
    child.signalCode = signal;
    child.emit("close", code, signal);
  };
  child.breakStdin = (code = "EPIPE") => {
    const error = Object.assign(Error("SYNTHETIC_PRIVATE_IO_DETAIL"), { code });
    child.stdin.emit("error", error);
  };
  return child;
}

function successfulFrames(id) {
  return [
    {
      event: "init",
      conversation_id: id,
      init: { agent: "qq-agents-fixture" },
    },
    {
      event: "step_update",
      step_update: {
        conversation_id: id,
        step_index: 1,
        step_type: "agent_response",
        state: "DONE",
        usage: { input_tokens: 10, output_tokens: 2, cache_read_tokens: 1 },
      },
    },
    {
      event: "result",
      result: {
        status: "SUCCESS",
        conversation_id: id,
        response: "Synthetic success.",
      },
    },
  ];
}

function assertSafeDiagnostics(entries) {
  const enums = {
    origin: ["terminal", "process-exit", "stdin", "protocol", "finalization"],
    phase: ["preparing", "running", "settling", "terminal-observed", "settled"],
    terminalStatus: ["SUCCESS", "ERROR", "CANCELLED", "unrecognized"],
    ioCode: [
      "EPIPE",
      "ECONNRESET",
      "ERR_STREAM_DESTROYED",
      "ERR_STREAM_WRITE_AFTER_END",
    ],
    signal: ["SIGINT", "SIGTERM", "SIGKILL", "SIGABRT", "SIGSEGV"],
    workerOutcome: ["recycled", "exit-warning", "healthy"],
    sessionDisposition: ["retained", "retiring", "retired"],
    backendOutcome: ["success", "failed", "cancelled"],
  };
  const allowedFields = new Set([
    ...Object.keys(enums),
    "trustedTerminal",
    "exitCode",
    "elapsedMs",
    "wrapperError",
  ]);
  for (const entry of entries) {
    assert.deepEqual(
      Object.keys(entry).filter((key) => !allowedFields.has(key)),
      [],
      "diagnostics expose only approved fields",
    );
    for (const [key, allowed] of Object.entries(enums))
      if (key in entry) assert(allowed.includes(entry[key]), `${key} is safe`);
    if ("trustedTerminal" in entry)
      assert.equal(typeof entry.trustedTerminal, "boolean");
    if ("exitCode" in entry)
      assert(
        Number.isSafeInteger(entry.exitCode) &&
          entry.exitCode >= -2147483648 &&
          entry.exitCode <= 2147483647,
      );
    if ("elapsedMs" in entry)
      assert(
        Number.isFinite(entry.elapsedMs) &&
          entry.elapsedMs >= 0 &&
          entry.elapsedMs <= 86400000,
      );
    if ("wrapperError" in entry)
      assert.equal(typeof entry.wrapperError, "boolean");
  }
  assert(!JSON.stringify(entries).includes("SYNTHETIC_PRIVATE_IO_DETAIL"));
}

function startFakeTurn(fixture, overrides = {}) {
  let markSubmitted;
  const inputSubmitted = new Promise((resolve) => {
    markSubmitted = resolve;
  });
  const run = fixture.backend.run({
    ...fixture.params,
    ...overrides,
    onInputSubmitted() {
      overrides.onInputSubmitted?.();
      markSubmitted();
    },
  });
  return { run, inputSubmitted };
}

test("ACP reply entry forwards original arguments only to permitted reply tools", async (t) => {
  const fixture = setup(t, "success", temp(t), {
    fakeChild: true,
    cliProtocol: "acp",
  });
  const { run, inputSubmitted } = startFakeTurn(fixture, {
    tools: toolSpecs(["qq_send", "board_read"]),
  });
  await inputSubmitted;
  const { child, options } = fixture.launches[0];
  await child.inputReady;
  const endpoint = options.env.QQ_AGY_ENDPOINT;
  const headers = {
    authorization: `Bearer ${options.env.QQ_AGY_TOKEN}`,
    "content-type": "application/json",
  };
  const call = (name, argumentsJson) =>
    fetch(`${endpoint}/call`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "qq_reply_call",
        arguments: { name, argumentsJson },
      }),
    });
  try {
    const { tools } = await (
      await fetch(`${endpoint}/catalog`, { headers })
    ).json();
    const dispatch = tools.find(({ name }) => name === "qq_reply_call");
    assert.deepEqual(dispatch.inputSchema.properties.name.enum, ["qq_send"]);
    assert.equal((await call("qq_draft", "{}")).status, 403);
    assert.equal((await call("board_read", "{}")).status, 403);
    const malformed = await (await call("qq_send", "[]")).json();
    assert.equal(
      JSON.parse(malformed.content[0].text).code,
      "INVALID_TOOL_ARGUMENTS",
    );
    const args = {
      requestId: "fixture",
      segments: [{ type: "text", text: "Synthetic reply" }],
    };
    const result = await (await call("qq_send", JSON.stringify(args))).json();
    assert.deepEqual(JSON.parse(result.content[0].text), { ok: true });
    assert.deepEqual(fixture.calls, [{ name: "qq_send", args }]);
  } finally {
    child.emitFrames(
      ...successfulFrames("00000000-0000-4000-8000-000000000238"),
    );
    child.closeWith(0);
    await run;
  }
});

test("ACP desktop exposes a strict action entry and a revocable current-turn screenshot", async (t) => {
  const fixture = setup(t, "success", temp(t), {
    fakeChild: true,
    cliProtocol: "acp",
  });
  const bytes = colorGrid(["red", "green", "blue", "yellow"]);
  let leased = true;
  const { run, inputSubmitted } = startFakeTurn(fixture, {
    desktop: true,
    social: true,
    conversation: "@desktop",
    tools: toolSpecs([
      "desktop_screen_view",
      "desktop_native_control",
      "desktop_browser_control",
    ]),
    async callTool(name, args) {
      fixture.calls.push({ name, args });
      return name === "desktop_screen_view"
        ? {
            [mediaLease]: () => leased,
            content: [
              {
                type: "image",
                mimeType: "image/png",
                data: bytes.toString("base64"),
              },
            ],
          }
        : { ok: true };
    },
  });
  await inputSubmitted;
  const { child, options } = fixture.launches[0];
  await child.inputReady;
  const endpoint = options.env.QQ_AGY_ENDPOINT;
  const headers = {
    authorization: `Bearer ${options.env.QQ_AGY_TOKEN}`,
    "content-type": "application/json",
  };
  const catalog = () =>
    fetch(`${endpoint}/catalog`, { headers }).then((response) =>
      response.json(),
    );
  const call = (name, args) =>
    fetch(`${endpoint}/call`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name, arguments: args }),
    });
  try {
    const { tools } = await catalog();
    const entry = tools.find(({ name }) => name === "qq_desktop_call");
    assert.deepEqual(entry?.inputSchema.properties.name.enum, [
      "desktop_native_control",
      "desktop_browser_control",
    ]);
    assert.equal(
      tools.some(({ name }) => name === "desktop_native_control"),
      false,
    );
    assert.equal(
      (await call("qq_desktop_call", { name: "qq_send", argumentsJson: "{}" }))
        .status,
      403,
    );
    const args = { type: "observe" };
    const result = await (
      await call("qq_desktop_call", {
        name: "desktop_native_control",
        argumentsJson: JSON.stringify(args),
      })
    ).json();
    assert.equal(JSON.parse(result.content[0].text).ok, true);
    assert.deepEqual(fixture.calls, [{ name: "desktop_native_control", args }]);
    const screenshot = await (await call("desktop_screen_view", {})).json();
    const current = await catalog();
    assert.equal(current.images.length, 1);
    const file = current.images[0].path;
    assert.match(screenshot.content[0].text, /native read_file/);
    assert.deepEqual(fs.readFileSync(file), bytes);
    const read = { name: "read_file", args: { Path: file } };
    assert.equal(antigravityToolAllowed(read, [], current.images), true);
    leased = false;
    assert.deepEqual((await catalog()).images, []);
    assert.equal(fs.existsSync(file), false);
  } finally {
    child.emitFrames(
      ...successfulFrames("00000000-0000-4000-8000-000000000239"),
    );
    child.closeWith(0);
    await run;
  }
});

test("Antigravity registers without changing existing backend defaults", async (t) => {
  const { backend, backendConfig, root } = setup(t);
  assert.equal(backendConfig.command, "agy");
  assert.equal(config().backends[0].command, "codex");
  const registered = new BackendRegistry().create(
    backendConfig,
    { id: "another" },
    { root },
  );
  t.after(() => registered.close());
  assert(registered instanceof AntigravityBackend);
  assert.deepEqual(backendCapabilities("antigravity"), {
    compaction: false,
    imageGeneration: false,
  });
  assert.deepEqual(await backend.models(), [
    { id: "fixture-model", name: "Fixture model" },
  ]);
  for (const extra of [
    { home: "custom" },
    { provider: "other" },
    { baseUrl: "http://127.0.0.1:9" },
    { effort: "invalid" },
    { env: { AGY_ACCOUNT: "EXAMPLE_ACCOUNT" } },
  ])
    assert.throws(() =>
      validateConfig({
        ...config(),
        backends: [{ ...backendConfig, ...extra }],
      }),
    );
});

test("Antigravity resumes only its bound conversation and keeps prompts off argv", async (t) => {
  const { backend, params, sessions, calls, launches } = setup(t);
  await backend.run(params);
  const session = sessions.at(-1);
  assert.equal(session.backend, "antigravity");
  await backend.run({ ...params, session, instructions: undefined });
  assert.equal(sessions.at(-1).id, session.id);
  assert.equal(calls.length, 2);
  assert(launches[1].args.includes(session.id));
  assert(launches.every((x) => !x.args.includes(params.prompt)));
  assert(!launches[0].args.includes("--continue"));
  assert(launches[0].args.includes("--disable-slash-commands"));
  assert(!launches[0].args.includes("--dangerously-skip-permissions"));
  assert.equal(
    fs
      .readFileSync(
        path.join(launches[1].options.cwd, ".agents", "agents", "qq-agents.md"),
        "utf8",
      )
      .includes(params.instructions),
    true,
  );
  await assert.rejects(
    backend.run({ ...params, conversation: "private:other", session }),
    /ANTIGRAVITY_SESSION_UNAVAILABLE/,
  );
  assert.equal(sessions.at(-1), null);
  assert.equal(launches.length, 2);
});

test("Antigravity keeps DONE+SUCCESS successful after a nonzero CLI exit and retires its session", async (t) => {
  const fixture = setup(t, "success-exit");
  const diagnostics = [];
  await fixture.backend.run({
    ...fixture.params,
    onDiagnostic: (event) => diagnostics.push(event),
  });

  assert(fixture.sessions[0]);
  assert.equal(fixture.sessions.at(-1), null);
  assert.equal(fixture.launches.length, 1);
  assert(
    diagnostics.some(
      (event) =>
        event.origin === "terminal" &&
        event.terminalStatus === "SUCCESS" &&
        event.trustedTerminal === true,
    ),
  );
  assert(
    diagnostics.some(
      (event) =>
        event.origin === "process-exit" &&
        event.exitCode === 7 &&
        event.trustedTerminal === true,
    ),
  );
  assert(
    diagnostics.some(
      (event) =>
        event.origin === "finalization" && event.backendOutcome === "success",
    ),
  );
  assert(
    diagnostics.some(
      (event) =>
        event.origin === "finalization" &&
        event.sessionDisposition === "retiring",
    ),
  );
  assert(
    diagnostics.some(
      (event) =>
        event.origin === "finalization" &&
        event.sessionDisposition === "retired",
    ),
  );
  assertSafeDiagnostics(diagnostics);
  assert(!JSON.stringify(diagnostics).includes("PRIVATE_SYNTHETIC_PROMPT"));
});

test("Antigravity rejects an explicit SUCCESS result with no completed response", async (t) => {
  const fixture = setup(t, "no-response");
  await assert.rejects(
    fixture.backend.run(fixture.params),
    /ANTIGRAVITY_PROTOCOL_ERROR/,
  );
  assert.equal(fixture.sessions.at(-1), null);
  assert.equal(fixture.launches.length, 1);
});

test("Antigravity keeps trusted success after stdin EPIPE and retires the session", async (t) => {
  const fixture = setup(t, "success", temp(t), { fakeChild: true });
  const diagnostics = [];
  const observed = [];
  const { run, inputSubmitted } = startFakeTurn(fixture, {
    onDiagnostic(event) {
      diagnostics.push(event);
      observed.push({ event, session: fixture.sessions.at(-1) });
    },
  });
  await inputSubmitted;
  const child = fixture.launches[0].child;
  await child.inputReady;
  const sessionId = "00000000-0000-4000-8000-000000000201";
  child.emitFrames(...successfulFrames(sessionId));
  child.breakStdin("EPIPE");
  child.closeWith(7);

  await run;
  assert.equal(fixture.sessions.at(-1), null);
  assert(diagnostics.some((event) => event.ioCode === "EPIPE"));
  assert(
    diagnostics.some(
      (event) => event.backendOutcome === "success" && event.trustedTerminal,
    ),
  );
  const retiring = observed.find(
    ({ event }) => event.sessionDisposition === "retiring",
  );
  const retired = observed.find(
    ({ event }) => event.sessionDisposition === "retired",
  );
  assert(retiring?.session);
  assert.equal(retired?.session, null);
  assertSafeDiagnostics(diagnostics);
});

test("Antigravity rejects stdin EPIPE before any terminal result", async (t) => {
  const fixture = setup(t, "success", temp(t), { fakeChild: true });
  const diagnostics = [];
  const { run, inputSubmitted } = startFakeTurn(fixture, {
    onDiagnostic: (event) => diagnostics.push(event),
  });
  const rejected = assert.rejects(run);
  await inputSubmitted;
  const child = fixture.launches[0].child;
  await child.inputReady;
  child.emitFrames({
    event: "init",
    conversation_id: "00000000-0000-4000-8000-000000000202",
    init: { agent: "qq-agents-fixture" },
  });
  child.breakStdin("EPIPE");

  await rejected;
  assert.equal(fixture.sessions.at(-1), null);
  assert(diagnostics.some((event) => event.ioCode === "EPIPE"));
  assert(diagnostics.some((event) => event.backendOutcome === "failed"));
  assert(!diagnostics.some((event) => event.backendOutcome === "success"));
  assertSafeDiagnostics(diagnostics);
});

test("Antigravity cancellation wins while an accepted terminal tool call is settling", async (t) => {
  const fixture = setup(t, "success", temp(t), { fakeChild: true });
  let enterTool;
  const toolEntered = new Promise((resolve) => {
    enterTool = resolve;
  });
  let settleTool;
  const toolGate = new Promise((resolve) => {
    settleTool = resolve;
  });
  let terminalSeen;
  const terminalObserved = new Promise((resolve) => {
    terminalSeen = resolve;
  });
  const diagnostics = [];
  const { run, inputSubmitted } = startFakeTurn(fixture, {
    async callTool() {
      enterTool();
      return toolGate;
    },
    onDiagnostic(event) {
      diagnostics.push(event);
      if (event.origin === "terminal") terminalSeen();
    },
  });
  await inputSubmitted;
  const child = fixture.launches[0].child;
  await child.inputReady;
  const sessionId = "00000000-0000-4000-8000-000000000203";
  child.emitFrames(successfulFrames(sessionId)[0]);
  const request = fetch(
    `${fixture.launches[0].options.env.QQ_AGY_ENDPOINT}/call`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${fixture.launches[0].options.env.QQ_AGY_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "probe", arguments: {} }),
    },
  ).catch(() => null);
  await toolEntered;
  child.emitFrames(...successfulFrames(sessionId).slice(1));
  await terminalObserved;
  child.closeWith(0);
  await new Promise((resolve) => setImmediate(resolve));
  fixture.controller.abort();

  await assert.rejects(run, /ABORTED/);
  settleTool({ content: [{ type: "text", text: "late fixture result" }] });
  await request;
  assert.equal(fixture.sessions.at(-1), null);
  assert(diagnostics.some((event) => event.backendOutcome === "cancelled"));
  assert(!diagnostics.some((event) => event.backendOutcome === "success"));
  assertSafeDiagnostics(diagnostics);
});

test("Antigravity keeps a bound session when per-turn preparation fails before input", async (t) => {
  const { backend, params, sessions, launches } = setup(t);
  await backend.run(params);
  const session = sessions.at(-1);
  assert(session);
  const bindingFile = path.join(launches[0].options.cwd, "session.json");
  const binding = fs.readFileSync(bindingFile, "utf8");
  const originalPrepare = backend.prepare;
  let inputSubmissions = 0;

  backend.prepare = () => {
    throw Error("SYNTHETIC_PREPARE_FAILURE");
  };
  try {
    await assert.rejects(
      backend.run({
        ...params,
        session,
        onInputSubmitted: () => inputSubmissions++,
      }),
      (error) => {
        assert(error instanceof SessionPreparationFailure);
        assert.equal(error.message, "SYNTHETIC_PREPARE_FAILURE");
        return true;
      },
    );
  } finally {
    backend.prepare = originalPrepare;
  }

  assert.equal(inputSubmissions, 0);
  assert.equal(launches.length, 1);
  assert.deepEqual(sessions.at(-1), session);
  assert.equal(fs.readFileSync(bindingFile, "utf8"), binding);

  await backend.run({
    ...params,
    session,
    onInputSubmitted: () => inputSubmissions++,
  });
  assert.equal(inputSubmissions, 1);
  assert.equal(launches.length, 2);
  assert(launches[1].args.includes(session.id));
  assert.equal(sessions.at(-1).id, session.id);
  assert.equal(JSON.parse(fs.readFileSync(bindingFile, "utf8")).id, session.id);
});

test("Antigravity keeps a per-turn session when the input callback throws before stdin", async (t) => {
  const { backend, params, sessions, calls, launches } = setup(t);
  await backend.run(params);
  const session = sessions.at(-1);
  assert(session);
  const bindingFile = path.join(launches[0].options.cwd, "session.json");
  const binding = fs.readFileSync(bindingFile, "utf8");
  const callCount = calls.length;
  let callbackCalls = 0;

  await assert.rejects(
    backend.run({
      ...params,
      session,
      beforeInputSubmitted() {
        callbackCalls++;
        throw Error("SYNTHETIC_INPUT_CALLBACK_FAILURE");
      },
    }),
    (error) =>
      error instanceof SessionPreparationFailure &&
      error.message === "SYNTHETIC_INPUT_CALLBACK_FAILURE",
  );

  assert.equal(callbackCalls, 1);
  assert.equal(launches.length, 2);
  assert.equal(calls.length, callCount);
  assert.equal(sessions.at(-1).id, session.id);
  assert.equal(fs.readFileSync(bindingFile, "utf8"), binding);

  await backend.run({ ...params, session });
  assert.equal(launches.length, 3);
  assert.equal(calls.length, callCount + 1);
  assert.equal(sessions.at(-1).id, session.id);
  assert.equal(JSON.parse(fs.readFileSync(bindingFile, "utf8")).id, session.id);
});

test("Antigravity makes only allowed parameter schemas visible before the first call", async (t) => {
  const { backend, params, launches } = setup(t, "usage");
  const tools = toolSpecs(["qq_send", "qq_mark_read"]);
  await backend.run({ ...params, tools });
  const instructions = fs.readFileSync(
    path.join(launches[0].options.cwd, ".agents", "agents", "qq-agents.md"),
    "utf8",
  );
  for (const { name, inputSchema } of tools) {
    assert(
      instructions.includes(
        `${JSON.stringify(name)}:${JSON.stringify(antigravitySchemaContract(inputSchema))}`,
      ),
    );
  }
  assert(!instructions.includes('"qq_send_burst":'));
  assert(!instructions.includes(launches[0].options.env.QQ_AGY_TOKEN));
});

test("Antigravity returns the called tool schema after argument validation fails", async (t) => {
  const { backend, params } = setup(t, "schema-error");
  const spec = { ...toolSpecs(["qq_send"])[0], name: "probe" };
  await backend.run({
    ...params,
    tools: [spec],
    callTool: async () => {
      registry.qq_send.schema.parse({
        text: "PRIVATE_ARGUMENT",
        chatId: "PRIVATE_ARGUMENT",
      });
    },
  });
});

test("Antigravity occupancy uses the last response and includes cached input, not cumulative or checkpoint usage", async (t) => {
  const { backend, params } = setup(t, "usage"),
    reports = [];
  await backend.run({ ...params, onUsage: (u) => reports.push(u) });
  assert.equal(reports.length, 1);
  assert.equal(reports[0].source, "measured");
  assert.equal(reports[0].contextTokens, 23100);
  assert.equal(reports[0].capacityTokens, undefined);
});

test("Antigravity falls back when the latest response has invalid usage", async (t) => {
  const { backend, params } = setup(t, "invalid-usage"),
    reports = [];
  await backend.run({ ...params, onUsage: (u) => reports.push(u) });
  assert.equal(reports.length, 0);
});

test("the runtime keeps a default-capacity Antigravity session with the complete tool catalogue", async (t) => {
  const { backend } = setup(t, "usage");
  const cfg = config(1);
  cfg.agents[0].tools = toolSpecs().map((s) => s.name);
  const f = runtimeFixture(t, { cfg });
  f.runtime.backends.set("agent-0", backend);
  const mem = f.store.bind("agent-0"),
    scope = "private:30000";
  await f.runtime.wake("agent-0", scope);
  const first = mem.state(scope);
  assert(first.session);
  assert.equal(first.usage.contextTokens, 23100);
  assert.equal(cfg.agents[0].contextPolicy.capacityTokens, 32768);
  assert(
    mem.identity.get("model_turns", first.lastTurnId).estimatedTextChars >
      32768,
  );
  await f.runtime.wake("agent-0", scope);
  assert.equal(mem.state(scope).session.id, first.session.id);
  assert.equal(
    mem.identity.get("model_turns", mem.state(scope).lastTurnId).initialSession,
    false,
  );
  // A deliberately smaller administrator limit still triggers the hard guard.
  f.runtime.config.agents[0].contextPolicy.capacityTokens = 24000;
  await f.runtime.wake("agent-0", scope);
  assert.equal(mem.state(scope).session, null);
  assert.equal(mem.state(scope).lifecycle.reason, "capacity-guard");
});

test("Antigravity rejects polluted profiles before spawning", async (t) => {
  const { backend, params, launches } = setup(t);
  fs.mkdirSync(path.join(backend.profile, "config"), { recursive: true });
  fs.writeFileSync(path.join(backend.profile, "config", "hooks.json"), "{}");
  await assert.rejects(backend.run(params), /ANTIGRAVITY_PROFILE_UNSAFE/);
  assert.equal(launches.length, 0);
});

test("Antigravity guards exact server/tool names and drops inherited credentials", () => {
  const call = (server, name) => ({
    name: "call_mcp_tool",
    args: { ServerName: server, ToolName: name },
  });
  assert.equal(
    antigravityToolAllowed(call("qq-agents", "probe"), ["probe"]),
    true,
  );
  assert.equal(
    antigravityToolAllowed(call("other", "probe"), ["probe"]),
    false,
  );
  assert.equal(
    antigravityToolAllowed(call("qq-agents", "unknown"), ["probe"]),
    false,
  );
  for (const name of [
    "run_command",
    "view_file",
    "schedule",
    "invoke_subagent",
    "manage_task",
    "call_mcp_tool",
  ])
    assert.equal(antigravityToolAllowed({ name }, ["probe"]), false);
  assert.equal(antigravityToolAllowed({ name: "finish" }, []), true);
  const env = buildChildEnv(
    "antigravity",
    {},
    {
      parent: {
        PATH: "fixture",
        HOME: "fixture-home",
        AGY_ACCOUNT: "private",
        GEMINI_API_KEY: "private",
        QQ_UNIFIED_TOKEN: "private",
        ANTIGRAVITY_GEMINI_DIR: "other",
      },
    },
  );
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "PATH"]);
});

test("Antigravity hook quoting handles Unix apostrophes and rejects Windows expansion", () => {
  assert.equal(antigravityShellQuote("a'b", "darwin"), "'a'\\''b'");
  assert.equal(
    antigravityShellQuote("C:\\Program Files\\node.exe", "win32"),
    '"C:\\Program Files\\node.exe"',
  );
  assert.throws(
    () => antigravityShellQuote("C:\\%PATH%\\node.exe", "win32"),
    /ANTIGRAVITY_COMMAND_UNSAFE/,
  );
});

test(
  "Antigravity Windows hook resolves its relative batch through CLI PATH outside the workspace",
  { skip: process.platform !== "win32" },
  async (t) => {
    const temporary = temp(t);
    const root = path.join(temporary, "Windows hook path with spaces");
    const { backend, params, launches } = setup(t, "success", root);
    let releaseTool;
    const toolGate = new Promise((resolve) => {
      releaseTool = resolve;
    });
    let enteredTool;
    const toolEntered = new Promise((resolve) => {
      enteredTool = resolve;
    });
    const run = backend.run({
      ...params,
      callTool: async (name, args) => {
        enteredTool({ name, args });
        await toolGate;
        return { ok: true };
      },
    });
    const runResult = run.then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error }),
    );

    try {
      const called = await Promise.race([
        toolEntered,
        runResult.then((result) => {
          if (!result.ok) throw result.error;
          throw Error("Fixture completed before the held tool call");
        }),
      ]);
      assert.equal(called.name, "probe");
      assert.match(launches[0].options.cwd, / /);

      const workspace = launches[0].options.cwd;
      const hooksFile = path.join(workspace, ".agents", "hooks.json");
      const hooks = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
      const command = hooks["qq-agents"].PreToolUse[0].hooks[0].command;
      assert.equal(command, "qq-agents-hook.cmd");
      assert.equal(command.includes('"'), false);

      const batchFile = path.join(workspace, command);
      const batch = fs.readFileSync(batchFile, "utf8");
      const guard = fileURLToPath(
        new URL("../src/backends/antigravity-guard.mjs", import.meta.url),
      );
      assert.ok(batch.startsWith("@echo off\r\nchcp 65001 >nul\r\n"));
      assert.ok(batch.includes(`"${process.execPath}" "${guard}"\r\n`));
      assert.ok(batch.endsWith("\r\nexit /b %errorlevel%\r\n"));

      const launchEnv = launches[0].options.env;
      const launchPath = launchEnv.PATH;
      assert.equal(typeof launchPath, "string");
      const pathEntries = launchPath.split(path.delimiter);
      assert.equal(
        path.resolve(pathEntries[0]).toLowerCase(),
        path.resolve(workspace).toLowerCase(),
      );
      const outside = path.join(temporary, "outside cli working directory");
      fs.mkdirSync(outside, { recursive: true });

      async function invoke(input, env = launchEnv) {
        const child = spawn("cmd.exe", ["/d", "/c", command], {
          cwd: outside,
          env,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
        let output = "",
          diagnostic = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          output += chunk;
        });
        child.stderr.on("data", (chunk) => {
          diagnostic += chunk;
        });
        const closed = new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("close", (code) => resolve({ code, diagnostic }));
        });
        child.stdin.end(JSON.stringify(input));
        const { code, diagnostic: stderr } = await closed;
        assert.equal(code, 0, stderr);
        return JSON.parse(output);
      }

      const legacyPath = pathEntries
        .slice(1)
        .filter(
          (entry) =>
            path.resolve(entry).toLowerCase() !==
            path.resolve(workspace).toLowerCase(),
        )
        .join(path.delimiter);
      const legacyCode = await new Promise((resolve, reject) => {
        const child = spawn("cmd.exe", ["/d", "/c", command], {
          cwd: outside,
          env: { ...launchEnv, PATH: legacyPath },
          stdio: "ignore",
          windowsHide: true,
        });
        child.once("error", reject);
        child.once("close", resolve);
      });
      assert.notEqual(
        legacyCode,
        0,
        "legacy PATH must not find the workspace hook",
      );

      assert.deepEqual(
        await invoke({
          toolCall: {
            name: "call_mcp_tool",
            args: { ServerName: "qq-agents", ToolName: "probe" },
          },
        }),
        { decision: "auto_approve", reason: "QQ_AGENTS_TOOL_ALLOWED" },
      );
      assert.deepEqual(
        await invoke({ toolCall: { name: "run_command", args: {} } }),
        { decision: "deny", reason: "QQ_AGENTS_TOOL_DENIED" },
      );
    } finally {
      releaseTool();
    }

    const result = await runResult;
    assert.equal(result.ok, true, result.ok ? "" : result.error.message);
  },
);

for (const mode of ["malformed", "wrong-result", "duplicate-result", "quota"])
  test(`Antigravity retires ${mode} sessions without replay`, async (t) => {
    const { backend, params, sessions, launches } = setup(t, mode);
    await assert.rejects(backend.run(params), (error) => {
      assert(!error.message.includes("fixture-private"));
      if (mode === "quota") {
        assert.equal(error.category, "quota");
        assert.equal(error.recoverable, false);
        assert.equal(error.sessionReusable, false);
      }
      return true;
    });
    assert.equal(sessions.at(-1), null);
    assert.equal(launches.length, 1);
  });

test("Antigravity cancellation revokes tools and cannot revive a session with late success", async (t) => {
  const { backend, params, sessions, controller, launches } = setup(
    t,
    "cancel",
  );
  let calls = 0;
  const run = backend.run({
    ...params,
    callTool: async () => {
      calls++;
      setImmediate(() => controller.abort());
      await new Promise((resolve) =>
        controller.signal.addEventListener("abort", resolve, { once: true }),
      );
      throw Error("ABORTED");
    },
  });
  await assert.rejects(run, /ABORTED/);
  assert.equal(calls, 1);
  assert.equal(sessions.at(-1), null);
  assert.equal(backend.active.size, 0);
  const url = launches[0].options.env.QQ_AGY_ENDPOINT;
  await assert.rejects(fetch(url + "/catalog"));
});

test("Antigravity close also terminates an in-flight model probe", async (t) => {
  const { backend } = setup(t, "probe-wait");
  const pending = backend.models();
  const rejected = assert.rejects(pending, /ANTIGRAVITY_PROBE_FAILED/);
  await backend.close();
  await rejected;
  assert.equal(backend.active.size, 0);
});

test(
  "POSIX cancellation kills descendants after the CLI group leader exits",
  { skip: process.platform === "win32" },
  async (t) => {
    const { backend, params, controller, sessions, launches } = setup(
      t,
      "orphan",
    );
    let deadline;
    const run = backend.run({
      ...params,
      callTool: async () => {
        setImmediate(() => controller.abort());
        await new Promise((resolve) =>
          controller.signal.addEventListener("abort", resolve, { once: true }),
        );
        throw Error("ABORTED");
      },
    });
    try {
      await Promise.race([
        assert.rejects(run, /ABORTED/),
        new Promise((_, reject) => {
          deadline = setTimeout(
            () => reject(Error("ORPHAN_NOT_TERMINATED")),
            8000,
          );
        }),
      ]);
      assert.equal(sessions.at(-1), null);
      assert.equal(backend.active.size, 0);
    } finally {
      clearTimeout(deadline);
      for (const launch of backend.active.size ? launches : []) {
        try {
          process.kill(-launch.pid, "SIGKILL");
        } catch {
          /* No test descendant survives a failed assertion. */
        }
      }
      await run.catch(() => {});
    }
  },
);

test("Antigravity failure classification never exposes provider diagnostics", () => {
  const error = antigravityFailure("UNAUTHENTICATED private-provider-detail");
  assert.equal(error.category, "authentication");
  assert.equal(error.message, "ANTIGRAVITY_TURN_FAILED");
  assert.equal(error.sessionReusable, false);
});

test("Antigravity hook process denies invalid, expired and unavailable policies", async (t) => {
  let active = true,
    leased = true,
    scope = {};
  const media = new AntigravityMedia();
  t.after(() => media.close());
  media.result({
    [mediaLease]: () => leased,
    content: [
      {
        type: "image",
        mimeType: "image/png",
        data: colorGrid(["red", "blue", "green", "yellow"]).toString("base64"),
      },
    ],
  });
  const imageCall = {
    name: "view_file",
    args: { AbsolutePath: media.catalog()[0].path },
  };
  const server = http.createServer((req, res) => {
    const valid = active && req.headers.authorization === "Bearer synthetic";
    res.writeHead(valid ? 200 : 403, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ tools: [tool], images: media.catalog(), ...scope }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const hook = fileURLToPath(
    new URL("../src/backends/antigravity-guard.mjs", import.meta.url),
  );
  async function guard(input, token = "synthetic", metadata = {}) {
    const child = spawn(process.execPath, [hook], {
      env: {
        ...buildChildEnv("antigravity"),
        QQ_AGY_ENDPOINT: endpoint,
        QQ_AGY_TOKEN: token,
      },
    });
    let output = "";
    child.stdout.on("data", (data) => {
      output += data;
    });
    const done = new Promise((resolve) => child.once("close", resolve));
    child.stdin.end(
      typeof input === "string"
        ? input
        : JSON.stringify({ ...metadata, toolCall: input }),
    );
    assert.equal(await done, 0);
    return JSON.parse(output).decision;
  }
  const call = {
    name: "call_mcp_tool",
    args: { ServerName: "qq-agents", ToolName: "probe" },
  };
  assert.equal(await guard(call), "auto_approve");
  assert.equal(await guard(imageCall), "auto_approve");
  const nativeImageCall = {
    name: "read_file",
    args: { Path: imageCall.args.AbsolutePath },
  };
  assert.equal(await guard(nativeImageCall), "auto_approve");
  for (const [name, key] of [
    ["read_file", "Path"],
    ["view_file", "AbsolutePath"],
  ]) {
    assert.equal(
      await guard({
        name,
        args: { [key]: imageCall.args.AbsolutePath, StartLine: 1 },
      }),
      "deny",
    );
    assert.equal(await guard({ name, args: { [key]: hook } }), "deny");
    assert.equal(
      await guard({
        name,
        args: {
          [key === "Path" ? "AbsolutePath" : "Path"]:
            imageCall.args.AbsolutePath,
        },
      }),
      "deny",
    );
  }
  const originalImage = fs.readFileSync(imageCall.args.AbsolutePath);
  const changedImage = Buffer.from(originalImage);
  changedImage[changedImage.length - 1] ^= 1;
  fs.writeFileSync(imageCall.args.AbsolutePath, changedImage);
  assert.equal(await guard(nativeImageCall), "deny");
  fs.writeFileSync(imageCall.args.AbsolutePath, originalImage);
  scope = {
    turnEpoch: "synthetic-current-epoch",
    conversationId: "synthetic-conversation",
    minimumStep: 4,
  };
  const currentStep = { conversationId: "synthetic-conversation", stepIdx: 5 };
  assert.equal(
    await guard(nativeImageCall, "synthetic", currentStep),
    "auto_approve",
  );
  assert.equal(
    await guard(imageCall, "synthetic", currentStep),
    "auto_approve",
  );
  for (const metadata of [
    { ...currentStep, stepIdx: 4 },
    { ...currentStep, conversationId: "previous-conversation" },
  ]) {
    assert.equal(await guard(nativeImageCall, "synthetic", metadata), "deny");
    assert.equal(await guard(imageCall, "synthetic", metadata), "deny");
  }
  scope = {};
  leased = false;
  assert.equal(await guard(nativeImageCall), "deny");
  assert.equal(await guard(imageCall), "deny");
  assert.equal(media.catalog().length, 0);
  assert.equal(
    await guard({ name: "view_file", args: { AbsolutePath: hook } }),
    "deny",
  );
  assert.equal(await guard({ name: "run_command" }), "deny");
  assert.equal(await guard("invalid json"), "deny");
  assert.equal(await guard(call, "invalid"), "deny");
  active = false;
  assert.equal(await guard(imageCall), "deny");
  assert.equal(await guard(call), "deny");
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await guard(call), "deny");
});

test("Antigravity refuses session contract changes before launching", async (t) => {
  const { backend, params, sessions, launches } = setup(t);
  await backend.run(params);
  await assert.rejects(
    backend.run({ ...params, session: sessions.at(-1), tools: [] }),
    /SESSION_REQUIRES_HANDOFF/,
  );
  assert.equal(launches.length, 1);
});

test("Antigravity creates Git boundaries even when data sits inside another repository", async (t) => {
  const { backend, root, params, launches } = setup(t);
  execFileSync("git", ["init", "--quiet", "--template=", root]);
  await backend.run(params);
  const launch = launches[0];
  for (const directory of [backend.root, launch.options.cwd]) {
    const actual = execFileSync(
      "git",
      ["-C", directory, "rev-parse", "--show-toplevel"],
      { encoding: "utf8" },
    ).trim();
    const expected = fs.statSync(directory, { bigint: true });
    const resolved = fs.statSync(actual, { bigint: true });
    assert.equal(resolved.dev, expected.dev);
    assert.equal(resolved.ino, expected.ino);
  }
  assert.equal(launch.options.env.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(
    launch.options.env.GIT_CONFIG_GLOBAL,
    process.platform === "win32" ? "NUL" : "/dev/null",
  );
});

test("Antigravity rejects an invalid Git boundary before CLI startup", async (t) => {
  const { backend, params, launches } = setup(t);
  fs.writeFileSync(path.join(backend.root, ".git"), "gitdir: unrelated");
  await assert.rejects(backend.run(params), /ANTIGRAVITY_WORKSPACE_UNSAFE/);
  assert.equal(launches.length, 0);
});

test("Antigravity rejects Git configuration redirecting its working tree to an ancestor", async (t) => {
  const { backend, root, params, launches } = setup(t);
  backend.checkProfile();
  execFileSync("git", ["-C", backend.root, "config", "core.worktree", root]);
  await assert.rejects(backend.run(params), /ANTIGRAVITY_WORKSPACE_UNSAFE/);
  assert.equal(launches.length, 0);
});

test("Antigravity registers exact image bytes through its real MCP subprocess", async (t) => {
  const { backend, params, launches } = setup(t, "media");
  const content = [
    { type: "text", text: "frame 0" },
    {
      type: "image",
      mimeType: "image/png",
      data: colorGrid(["red", "green", "blue", "yellow"]).toString("base64"),
    },
    { type: "text", text: "frame 1" },
    {
      type: "image",
      mimeType: "image/png",
      data: colorGrid(["blue", "yellow", "red", "green"]).toString("base64"),
    },
  ];
  await backend.run({ ...params, callTool: async () => ({ content }) });
  const result = JSON.parse(
    fs.readFileSync(
      path.join(launches[0].options.cwd, "media-result.json"),
      "utf8",
    ),
  );
  assert.equal(result.content.filter((c) => c.type === "image").length, 0);
  assert.equal(result.content[0].text, "frame 0");
  assert.match(result.content[1].text, /Image 1:.*read_file with Path=/);
  assert.match(result.content[1].text, /legacy view_file with AbsolutePath=/);
  assert.equal(result.content[2].text, "frame 1");
  assert.match(result.content[3].text, /Image 2:.*read_file with Path=/);
  assert.deepEqual(result.nativeImageApprovals, [
    ["auto_approve", "auto_approve"],
    ["auto_approve", "auto_approve"],
  ]);
  assert.deepEqual(result.observedImages, [content[1].data, content[3].data]);
  const target = JSON.parse(
    /Path=(".*?") to inspect/.exec(result.content[1].text)[1],
  );
  assert(!fs.existsSync(target));
});

test("Antigravity social adapter delivers only current registered pixels through MCP and native hooks", async (t) => {
  const { backend, params, launches } = setup(t, "media");
  const image = {
    type: "image",
    mimeType: "image/png",
    data: colorGrid(["red", "green", "blue", "yellow"]).toString("base64"),
  };
  await backend.run({
    ...params,
    social: true,
    callTool: async () => ({ content: [image] }),
  });
  const workspace = launches[0].options.cwd;
  const result = JSON.parse(
    fs.readFileSync(path.join(workspace, "media-result.json"), "utf8"),
  );
  assert.deepEqual(result.nativeImageApprovals, [
    ["auto_approve", "auto_approve"],
  ]);
  assert.deepEqual(result.observedImages, [image.data]);
  const target = JSON.parse(
    /Path=(".*?") to inspect/.exec(result.content[0].text)[1],
  );
  assert(!fs.existsSync(target));
  assert.equal(
    antigravityToolAllowed(
      { name: "read_file", args: { Path: target } },
      [],
      [],
    ),
    false,
  );
  assert.equal(
    antigravityToolAllowed(
      { name: "view_file", args: { AbsolutePath: target } },
      [],
      [],
    ),
    false,
  );
  const settings = JSON.parse(
    fs.readFileSync(path.join(workspace, "settings.json"), "utf8"),
  );
  assert.equal(settings.permissions.allow.length, 2);
  assert.equal(settings.permissions.allow[0], "mcp(qq-agents/probe)");
  assert.equal(
    settings.permissions.allow[1],
    `read_file(${path.dirname(target).replaceAll("\\", "/")}/*)`,
  );
});

test("Antigravity pressure handoff keeps original source evidence without acknowledging replay", async (t) => {
  const { backend } = setup(t, "usage");
  const cfg = config(1);
  const f = runtimeFixture(t, { cfg });
  f.runtime.backends.set("agent-0", backend);
  const mem = f.store.bind("agent-0"),
    scope = "private:30000";
  const incoming = mem.append({
    dedupe: "continuity-proof",
    conversation: scope,
    kind: "message.received",
    direction: "in",
    senderId: "30000",
    body: "SYNTHETIC_ORIGINAL_SOURCE_7F31",
  });
  await f.runtime.wake("agent-0", scope);
  const first = mem.state(scope).session.id;
  f.runtime.config.agents[0].contextPolicy.capacityTokens = 24000;
  await f.runtime.wake("agent-0", scope);
  const retired = mem.state(scope);
  assert.equal(retired.session, null);
  assert.equal(retired.lifecycle.reason, "capacity-guard");
  f.runtime.config.agents[0].contextPolicy.capacityTokens = 32768;
  let prompt;
  const run = backend.run.bind(backend);
  backend.run = (params) => {
    prompt = params.prompt;
    return run(params);
  };
  await f.runtime.wake("agent-0", scope);
  const restored = mem.state(scope);
  assert.notEqual(restored.session.id, first);
  assert(prompt.includes(incoming.id));
  assert(prompt.includes("SYNTHETIC_ORIGINAL_SOURCE_7F31"));
  assert.equal(restored.readThroughSeq, retired.readThroughSeq);
  assert.equal(
    mem.db.prepare("SELECT COUNT(*) AS n FROM deliveries").get().n,
    0,
  );
});

test("compact parameter guides retain a description argument and all structural validation", () => {
  const schema = {
    type: "object",
    description: "documentation",
    properties: {
      description: { type: "string", description: "field prose", minLength: 3 },
      options: {
        anyOf: [
          { type: "string", enum: ["a", "b"], description: "choice" },
          { type: "null" },
        ],
      },
    },
    required: ["description"],
    additionalProperties: false,
  };
  const compact = antigravitySchemaContract(schema);
  assert.deepEqual(compact, {
    type: "object",
    properties: {
      description: { type: "string", minLength: 3 },
      options: {
        anyOf: [{ type: "string", enum: ["a", "b"] }, { type: "null" }],
      },
    },
    required: ["description"],
    additionalProperties: false,
  });
  assert.equal(schema.description, "documentation");
  assert.equal(schema.properties.description.description, "field prose");
});

test("a failed spawn preserves the completed native session and its scope binding", async (t) => {
  const f = setup(t);
  await f.backend.run(f.params);
  const session = f.sessions.at(-1),
    spawn = f.backend.spawn;
  f.backend.spawn = () => {
    throw Error("SYNTHETIC_SPAWN_FAILURE");
  };
  await assert.rejects(
    f.backend.run({ ...f.params, session, instructions: undefined }),
    /SYNTHETIC_SPAWN_FAILURE/,
  );
  assert.equal(f.sessions.at(-1).id, session.id);
  f.backend.spawn = spawn;
  await f.backend.run({ ...f.params, session, instructions: undefined });
  assert.equal(f.sessions.at(-1).id, session.id);
  assert.equal(f.launches.length, 2);
});

test("Antigravity resumes a proven compatible binding and refreshes optional argument guidance", async (t) => {
  const { backend, params, sessions, launches } = setup(t, "usage");
  const tools = [
    {
      name: "probe",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  ];
  await backend.run({ ...params, tools });
  const original = sessions.at(-1),
    next = structuredClone(tools);
  next[0].inputSchema.properties.optional = { type: "string" };
  const binding = JSON.parse(
    fs.readFileSync(path.join(launches[0].options.cwd, "session.json"), "utf8"),
  );
  assert.equal(backend.acceptsSession(original, next, binding.contract), true);
  const migrated = { ...original, signature: backend.sessionSignature(next) };
  await backend.run({
    ...params,
    tools: next,
    session: migrated,
    instructions: undefined,
  });
  assert.equal(sessions.at(-1).id, original.id);
  const guide = fs.readFileSync(
    path.join(launches[1].options.cwd, ".agents", "agents", "qq-agents.md"),
    "utf8",
  );
  assert(guide.includes(params.instructions));
  assert(guide.includes('"optional":{"type":"string"}'));
  const changed = structuredClone(next);
  changed[0].inputSchema.required = ["optional"];
  await assert.rejects(
    backend.run({
      ...params,
      tools: changed,
      session: { ...original, signature: backend.sessionSignature(changed) },
    }),
    /ANTIGRAVITY_SESSION_UNAVAILABLE/,
  );
  assert.equal(launches.length, 2);
});

test("Antigravity refreshes legacy image guidance without replacing its native session", async (t) => {
  const { backend, params, sessions, launches } = setup(t, "usage");
  await backend.run(params);
  const session = sessions.at(-1),
    signature = backend.sessionSignature(params.tools);
  const agentFile = path.join(
    launches[0].options.cwd,
    ".agents",
    "agents",
    "qq-agents.md",
  );
  const old = fs
    .readFileSync(agentFile, "utf8")
    .replace("  - view_file\n", "  - read_file\n  - view_file\n")
    .replace(
      "Only native read_file (Path) or legacy view_file (AbsolutePath)",
      "Only native view_file",
    )
    .replace("Always call the native image reader", "Always call view_file");
  fs.writeFileSync(agentFile, old);
  for (let turn = 0; turn < 3; turn++) {
    if (turn === 2)
      fs.writeFileSync(
        agentFile,
        old.replace("  - read_file\n  - view_file\n", ""),
      );
    await backend.run({ ...params, session, instructions: undefined });
    const guide = fs.readFileSync(agentFile, "utf8");
    assert.equal(sessions.at(-1).id, session.id);
    assert.equal(backend.sessionSignature(params.tools), signature);
    assert.doesNotMatch(guide, /^ {2}- read_file$/m);
    assert.equal((guide.match(/ {2}- view_file\n/g) || []).length, 1);
    assert.match(
      guide,
      /Only native read_file \(Path\) or legacy view_file \(AbsolutePath\)/,
    );
    assert(guide.includes(params.instructions));
  }
});

test("Antigravity consumes a verified legacy binding after compatible request settings change", async (t) => {
  const { backend, params, sessions, launches } = setup(t, "usage");
  await backend.run(params);
  const { legacySessionSignature } =
    await import("../src/backends/session-contract.mjs");
  const { upgradeSessionReference, sessionReference } =
    await import("../src/core/session-records.mjs");
  const old = {
    ...sessions.at(-1),
    signature: legacySessionSignature(backend, params.tools),
  };
  fs.writeFileSync(
    path.join(launches[0].options.cwd, "session.json"),
    JSON.stringify({ id: old.id, signature: old.signature }),
  );
  assert(backend.acceptsSession(old, params.tools));
  const migrated = sessionReference(
    upgradeSessionReference(old, backend.sessionSignature(params.tools)),
  );
  backend.config.effort = "high";
  assert(backend.acceptsSession(migrated, params.tools));
  await backend.run({ ...params, session: migrated, instructions: undefined });
  assert.equal(sessions.at(-1).id, old.id);
  assert.equal(sessions.at(-1).nativeSignature, undefined);
  assert.equal(
    JSON.parse(
      fs.readFileSync(path.join(launches[1].options.cwd, "session.json")),
    ).signature,
    backend.sessionSignature(params.tools),
  );
});

test("Antigravity pins the auto-created swarm plugin off and rejects modified profile settings", (t) => {
  const { backend } = setup(t);
  backend.checkProfile();
  const file = path.join(backend.profile, "config", "config.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
    plugins: { swarm: { enabled: false } },
  });
  backend.checkProfile();
  for (const value of [
    { plugins: { swarm: { enabled: true } } },
    { plugins: { swarm: { enabled: false } }, permissions: "all" },
    {},
  ]) {
    fs.writeFileSync(file, JSON.stringify(value));
    assert.throws(() => backend.checkProfile(), /ANTIGRAVITY_PROFILE_UNSAFE/);
  }
});

test("a failed submitted-input observer retires the already-used native session", async (t) => {
  const { backend, params, sessions } = setup(t);
  await backend.run(params);
  const session = sessions.at(-1);
  await assert.rejects(
    backend.run({
      ...params,
      session,
      onInputSubmitted() {
        throw Error("SYNTHETIC_SUBMITTED_OBSERVER_FAILURE");
      },
    }),
    (error) =>
      error.message === "SYNTHETIC_SUBMITTED_OBSERVER_FAILURE" &&
      !(error instanceof SessionPreparationFailure),
  );
  assert.equal(sessions.at(-1), null);
  assert.equal(backend.active.size, 0);
});
