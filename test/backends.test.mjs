import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { CodexBackend, restrictions } from "../src/backends/codex.mjs";
import { DshBackend } from "../src/backends/dsh.mjs";
import { apply as guard } from "../src/backends/dsh-guard.mjs";
import { toolSpecs } from "../src/tools/index.mjs";
import { temp, config } from "./helpers.mjs";

class Rpc extends EventEmitter {
  constructor() {
    super();
    this.calls = [];
    this.responses = [];
    this.rejections = [];
  }
  async start() {}
  async request(method, args) {
    this.calls.push({ method, args });
    if (method === "account/read") return { account: { type: "fixture" } };
    if (method === "model/list") return { data: [{ model: "fixture-model" }] };
    if (method === "thread/start") return { thread: { id: "fixture-thread" } };
    if (method === "turn/start") {
      this.emit("notification", {
        method: "turn/started",
        params: { threadId: "fixture-thread", turn: { id: "fixture-turn" } },
      });
      return { turn: { id: "fixture-turn" } };
    }
    return {};
  }
  respond(id, value) {
    this.responses.push({ id, value });
  }
  reject(id) {
    this.rejections.push(id);
  }
  close() {}
  complete() {
    this.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: "fixture-thread",
        turn: { id: "fixture-turn", status: "completed" },
      },
    });
  }
}
const tick = () => new Promise((r) => setImmediate(r));
test("Codex protocol uses restricted dynamic tools and isolated session state", async (t) => {
  const root = temp(t),
    rpc = new Rpc(),
    cfg = config(),
    backend = new CodexBackend(
      { ...cfg.backends[0], model: "fixture-model" },
      cfg.agents[0],
      { root, rpc },
    );
  t.after(() => backend.close());
  let session;
  const run = backend.run({
    prompt: "fixture prompt",
    signal: new AbortController().signal,
    tools: toolSpecs(["memory_search"]),
    callTool: async () => ({ answer: "fixture" }),
    saveSession: (s) => (session = s),
  });
  await tick();
  assert.equal(session.backend, "codex");
  const start = rpc.calls.find((c) => c.method === "thread/start").args;
  assert.equal(start.sandbox, "read-only");
  assert.equal(start.config["features.shell_tool"], false);
  assert.deepEqual(
    start.dynamicTools.map((t) => t.name),
    ["memory_search"],
  );
  rpc.complete();
  await run;
});
test("Codex server requests execute only current thread/turn tools", async (t) => {
  const root = temp(t),
    rpc = new Rpc(),
    cfg = config(),
    backend = new CodexBackend(cfg.backends[0], cfg.agents[0], { root, rpc });
  t.after(() => backend.close());
  let count = 0;
  const run = backend.run({
    prompt: "x",
    signal: new AbortController().signal,
    tools: toolSpecs(),
    callTool: async () => {
      count++;
      return { ok: true };
    },
    saveSession: () => {},
  });
  await tick();
  await backend.request({
    id: 1,
    method: "item/tool/call",
    params: {
      threadId: "other",
      turnId: "fixture-turn",
      tool: "memory_search",
      arguments: {},
    },
  });
  await backend.request({
    id: 2,
    method: "item/tool/call",
    params: {
      threadId: "fixture-thread",
      turnId: "fixture-turn",
      tool: "memory_search",
      arguments: {},
    },
  });
  assert.deepEqual(rpc.rejections, [1]);
  assert.equal(count, 1);
  assert.equal(rpc.responses[0].value.success, true);
  rpc.complete();
  await run;
});
test("Codex abort interrupts turn and invalidates session receipt", async (t) => {
  const root = temp(t),
    rpc = new Rpc(),
    cfg = config(),
    backend = new CodexBackend(cfg.backends[0], cfg.agents[0], { root, rpc });
  t.after(() => backend.close());
  const c = new AbortController();
  let session;
  const run = backend.run({
    prompt: "x",
    signal: c.signal,
    tools: [],
    callTool: async () => {},
    saveSession: (s) => (session = s),
  });
  await tick();
  c.abort();
  await assert.rejects(run, /ABORTED/);
  assert.equal(session, null);
  assert.ok(rpc.calls.some((c) => c.method === "turn/interrupt"));
});
test("Codex refuses incompatible sessions until the caller prepares a handoff", async (t) => {
  const root = temp(t),
    rpc = new Rpc(),
    cfg = config(),
    backend = new CodexBackend(
      { ...cfg.backends[0], model: "new-model" },
      cfg.agents[0],
      { root, rpc },
    );
  t.after(() => backend.close());
  const run = backend.run({
    prompt: "x",
    signal: new AbortController().signal,
    tools: [],
    callTool: async () => {},
    session: { backend: "codex", id: "old", signature: "different" },
    saveSession: () => {},
  });
  await assert.rejects(run, /SESSION_REQUIRES_HANDOFF/);
  assert.equal(rpc.calls.length, 0);
  assert.equal(backend.agent.id, "agent-0");
});

function dshFake() {
  const calls = [],
    queue = [];
  let waiting;
  const push = (frame) => {
    queue.push(frame);
    waiting?.();
    waiting = null;
  };
  const ok = (v) => ({ result: { ok: true, value: v } });
  const client = {
    calls,
    agentPresets: { list: async () => ok({ presets: [{ id: "qq-unified" }] }) },
    workspace: {
      create: async (args) => {
        calls.push({ name: "workspace", args });
        return ok({ workspace: { workspaceId: "w" } });
      },
    },
    sessions: {
      create: async (args) => {
        calls.push({ name: "create", args });
        return ok({ sessionId: "s" });
      },
      selectModel: async (args) => {
        calls.push({ name: "model", args });
        return ok({});
      },
      prompt: async (args) => {
        calls.push({ name: "prompt", args });
        push({
          payload: {
            type: "session/snapshot",
            sessionId: "s",
            snapshot: { records: [{ type: "turn/end" }] },
          },
        });
        push({
          payload: {
            type: "session/event",
            sessionId: "s",
            event: { type: "turn/start", data: { turn: "t" } },
          },
        });
        return ok({ accepted: true });
      },
    },
    events: {
      follow: (id) => {
        calls.push({ name: "follow", id });
        push({
          payload: {
            type: "session/snapshot",
            sessionId: id,
            snapshot: { records: [] },
          },
        });
      },
      forget: () => {},
      async *mux(_, signal, onOpen) {
        onOpen();
        signal.addEventListener(
          "abort",
          () => {
            waiting?.();
          },
          { once: true },
        );
        while (!signal.aborted) {
          while (queue.length) yield queue.shift();
          if (!signal.aborted) await new Promise((r) => (waiting = r));
        }
      },
    },
    callUnary: async (name, args) => {
      calls.push({ name, args });
      return ok({});
    },
  };
  return { client, push };
}
test("DSH uses required preset, workspace, model selection, followed event stream and ignores snapshots", async (t) => {
  const root = temp(t),
    { client, push } = dshFake(),
    cfg = config(),
    backend = new DshBackend(
      {
        id: "dsh",
        preset: "qq-unified",
        provider: "fixture",
        model: "fixture-model",
        effort: "high",
      },
      cfg.agents[0],
      { root, client },
    );
  t.after(() => backend.close());
  let completed = false,
    session;
  const run = backend
    .run({
      conversation: "group:20000",
      prompt: "context fixture",
      signal: new AbortController().signal,
      saveSession: (s) => (session = s),
    })
    .then(() => (completed = true));
  await tick();
  assert.equal(completed, false);
  assert.equal(session.backend, "dsh");
  assert.equal(
    client.calls.find((c) => c.name === "create").args.agentPreset,
    "qq-unified",
  );
  assert.equal(
    client.calls.find((c) => c.name === "model").args.reasoningEffort,
    "high",
  );
  push({
    payload: {
      type: "session/event",
      sessionId: "s",
      event: {
        type: "turn/end",
        data: { turn: "t", reason: { kind: "completed" } },
      },
    },
  });
  await run;
  assert.equal(completed, true);
});
test("DSH rejects a broken installed preset before creating a workspace", async (t) => {
  const { client } = dshFake();
  client.agentPresets.list = async () => ({
    result: {
      ok: true,
      value: {
        presets: [{ id: "qq-unified", broken: "private provider detail" }],
      },
    },
  });
  const b = new DshBackend(
    { id: "dsh", preset: "qq-unified" },
    config().agents[0],
    { root: temp(t), client },
  );
  t.after(() => b.close());
  await assert.rejects(
    b.run({
      prompt: "x",
      signal: new AbortController().signal,
      tools: [],
      saveSession() {},
    }),
    /^Error: DSH_UNIFIED_PRESET_BROKEN$/,
  );
  assert.equal(
    client.calls.some((x) => x.name === "workspace"),
    false,
  );
});

test("DSH never falls back to a default unrestricted preset", async (t) => {
  const root = temp(t),
    { client } = dshFake(),
    cfg = config();
  client.agentPresets.list = async () => ({
    result: { ok: true, value: { presets: [] } },
  });
  const b = new DshBackend({ id: "dsh", preset: "qq-unified" }, cfg.agents[0], {
    root,
    client,
  });
  t.after(() => b.close());
  await assert.rejects(
    b.run({
      prompt: "x",
      signal: new AbortController().signal,
      saveSession: () => {},
    }),
    /PRESET_NOT_INSTALLED/,
  );
  assert.ok(!client.calls.some((c) => c.name === "create"));
});
test("DSH guard only permits new capability-bound tools, leaving global application configuration alone", () => {
  const denied = [];
  let gate;
  guard({
    tools: {
      restrict: (v) => denied.push(...v.deny),
      guard: (fn) => (gate = fn),
    },
  });
  assert.ok(denied.includes("bash"));
  assert.equal(gate({ name: "mcp__qq-unified__bridge_call" }), undefined);
  assert.ok(gate({ name: "mcp__qq-unified__memory_search" }));
  assert.equal(gate({ name: "mcp__qq-unified__bridge_tools" }), undefined);
  assert.ok(gate({ name: "mcp__snowluma__qq_send_message" }));
  assert.ok(gate({ name: "bash" }));
  assert.ok(gate({ name: "mcp__unknown__read_file" }));
});
test("Codex restrictions apply only to the dedicated spawned instance", () => {
  assert.equal(restrictions["features.memories"], false);
  assert.equal(restrictions["apps._default.enabled"], false);
  assert.ok(!Object.hasOwn(process.env, "QQ_UNIFIED_MODIFIED_DAILY_CODEX"));
});

test("Codex returns safe actionable validation bounds so failed reads can be corrected", async (t) => {
  const root = temp(t),
    rpc = new Rpc(),
    cfg = config(),
    backend = new CodexBackend(cfg.backends[0], cfg.agents[0], { root, rpc });
  t.after(() => backend.close());
  const { z } = await import("zod");
  const run = backend.run({
    prompt: "x",
    signal: new AbortController().signal,
    tools: toolSpecs(),
    callTool: async () =>
      z.object({ maxChars: z.number().max(16000) }).parse({ maxChars: 30000 }),
    saveSession: () => {},
  });
  await tick();
  await backend.request({
    id: 77,
    method: "item/tool/call",
    params: {
      threadId: "fixture-thread",
      turnId: "fixture-turn",
      tool: "qq_forward_read",
      arguments: {},
    },
  });
  const answer = rpc.responses.find((x) => x.id === 77).value;
  assert.equal(answer.success, false);
  const error = JSON.parse(answer.contentItems[0].text);
  assert.equal(error.code, "INVALID_TOOL_ARGUMENTS");
  assert.deepEqual(error.issues, [
    { field: "maxChars", code: "too_big", maximum: 16000 },
  ]);
  rpc.complete();
  await run;
});

test("Codex occupancy uses last request, ignores compaction reset zero, and waits for completion", async (t) => {
  const cfg = config(),
    rpc = new Rpc(),
    b = new CodexBackend(cfg.backends[0], cfg.agents[0], {
      root: temp(t),
      rpc,
    });
  t.after(() => b.close());
  const usage = [];
  b.active.set("fixture-thread", { onUsage: (u) => usage.push(u) });
  const emit = (last) =>
    rpc.emit("notification", {
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "fixture-thread",
        tokenUsage: {
          last,
          total: { totalTokens: 999999 },
          modelContextWindow: 10000,
        },
      },
    });
  emit({ inputTokens: 4000, outputTokens: 100 });
  emit({ inputTokens: 0, outputTokens: 0 });
  assert.equal(usage.length, 1);
  assert.equal(usage[0].contextTokens, 4100);
  assert.equal(usage[0].cumulativeTokens, 999999);
  b.active.delete("fixture-thread");
  let finished = false;
  const compact = b
    .compact({
      session: { id: "fixture-thread" },
      signal: new AbortController().signal,
    })
    .then((r) => {
      finished = true;
      return r;
    });
  await tick();
  assert(!finished);
  emit({ inputTokens: 0, outputTokens: 0 });
  rpc.complete();
  assert.equal((await compact).usage, undefined);
  assert(rpc.calls.some((c) => c.method === "thread/compact/start"));
});

test("DSH manual compaction distinguishes unsupported, no-op and committed summary", async () => {
  const cfg = config();
  let result;
  const client = {
    commands: {
      execute: async () => ({ result: { ok: true, value: result } }),
    },
    callUnary: async () => ({
      result: {
        ok: true,
        value: {
          values: {
            contextPressure: { projectedTokens: 2000, contextWindow: 10000 },
          },
        },
      },
    }),
  };
  const b = new DshBackend(cfg.backends[0], cfg.agents[0], { client }),
    p = { session: { id: "fixture" }, signal: new AbortController().signal };
  await assert.rejects(b.compact(p), /UNSUPPORTED_OR_FAILED/);
  result = { result: { kind: "success", text: "No compactable history yet." } };
  assert.equal((await b.compact(p)).requiresReinitialize, false);
  result = { result: { kind: "success", sourceEventSeq: 12 } };
  const r = await b.compact(p);
  assert.equal(r.compacted, true);
  assert.equal(r.requiresReinitialize, true);
  assert.equal(r.usage.source, "estimated");
});
