import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  CodexBackend,
  restrictions,
  windowsCodexSpawn,
} from "../src/backends/codex.mjs";
import { DshBackend } from "../src/backends/dsh.mjs";
import { apply as guard } from "../src/backends/dsh-guard.mjs";
import { toolSpecs } from "../src/tools/index.mjs";
import { temp, config } from "./helpers.mjs";
import { MediaStore } from "../src/tools/media.mjs";
import { gif } from "./gif-fixture.mjs";

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
test("Codex delivers every decoded animation frame and its time label in order", async (t) => {
  const root = temp(t),
    rpc = new Rpc(),
    cfg = config();
  const media = new MediaStore(root + "/media");
  const saved = media.put(
    "a",
    gif([{ color: 0 }, { color: 1 }, { color: 2 }]),
    "image/gif",
  );
  const result = await media.view("a", saved.id);
  const backend = new CodexBackend(cfg.backends[0], cfg.agents[0], {
    root,
    rpc,
  });
  t.after(() => backend.close());
  const run = backend.run({
    prompt: "Synthetic animation",
    signal: new AbortController().signal,
    tools: toolSpecs(["sticker_read"]),
    callTool: async () => result,
    saveSession() {},
  });
  await tick();
  await backend.request({
    id: 1,
    method: "item/tool/call",
    params: {
      threadId: "fixture-thread",
      turnId: "fixture-turn",
      tool: "sticker_read",
      arguments: { mediaId: saved.id },
    },
  });
  const response = rpc.responses[0].value;
  assert.equal(response.success, true);
  assert.deepEqual(
    response.contentItems.map((c) => c.type),
    [
      "inputText",
      "inputText",
      "inputImage",
      "inputText",
      "inputImage",
      "inputText",
      "inputImage",
    ],
  );
  assert(
    response.contentItems
      .filter((c) => c.type === "inputImage")
      .every((c) => c.imageUrl.startsWith("data:image/png;base64,")),
  );
  assert.match(response.contentItems[5].text, /200 ms/);
  rpc.complete();
  await run;
});
test("Codex confirms the final tool text only after a successful write for the active turn", async (t) => {
  const rpc = new Rpc();
  const cfg = config();
  const backend = new CodexBackend(cfg.backends[0], cfg.agents[0], {
    root: temp(t),
    rpc,
  });
  t.after(() => backend.close());
  const writes = [];
  rpc.respond = (id, value, acknowledge) => {
    writes.push({ id, value, acknowledge });
  };
  const commits = [];
  const run = backend.run({
    prompt: "Fixture input review",
    signal: new AbortController().signal,
    tools: toolSpecs(["memory_search"]),
    callTool: async (_name, args) => ({ fixture: args.fixture }),
    saveSession() {},
    finalizeToolOutput: async (original, { encode, maxBytes }) => {
      assert.equal(maxBytes, 65535);
      const { wire, text } = await encode({
        fixture: original.fixture,
        input: '甲 "乙"',
      });
      assert.equal(text, wire.result.contentItems[0].text);
      return { wire, receipt: original.fixture };
    },
    commitToolOutput: (receipt, text) => commits.push({ receipt, text }),
  });
  await tick();
  for (const fixture of ["failed", "delivered", "late"]) {
    await backend.request({
      id: fixture,
      method: "item/tool/call",
      params: {
        threadId: "fixture-thread",
        turnId: "fixture-turn",
        tool: "memory_search",
        arguments: { fixture },
      },
    });
  }
  assert.equal(writes.length, 3);
  assert.deepEqual(commits, []);
  writes[0].acknowledge(Error("fixture write failed"));
  assert.deepEqual(commits, []);
  writes[1].acknowledge();
  const text = writes[1].value.contentItems[0].text;
  assert.deepEqual(JSON.parse(text), {
    fixture: "delivered",
    input: '甲 "乙"',
  });
  assert.deepEqual(commits, [{ receipt: "delivered", text }]);
  rpc.complete();
  await run;
  writes[2].acknowledge();
  assert.deepEqual(commits, [{ receipt: "delivered", text }]);
});

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
        return ok({ sessionId: args.sessionId || "s" });
      },
      selectModel: async (args) => {
        calls.push({ name: "model", args });
        const { provider, model, reasoningEffort } = args;
        return ok({ selected: { provider, model, reasoningEffort } });
      },
      prompt: async (args) => {
        calls.push({ name: "prompt", args });
        push({
          payload: {
            type: "session/snapshot",
            sessionId: args.sessionId,
            snapshot: { records: [{ type: "turn/end" }] },
          },
        });
        push({
          payload: {
            type: "session/event",
            sessionId: args.sessionId,
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
test("DSH uses required preset, workspace, model selection and ignores historical completion", async (t) => {
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

test("DSH pins concurrent functional selections on separate fresh sessions", async (t) => {
  const { client, push } = dshFake();
  const original = {
    id: "dsh",
    preset: "qq-unified",
    provider: "default-provider",
    model: "default-model",
    effort: "high",
  };
  const root = temp(t),
    role = config().agents[0];
  const ordinary = new DshBackend(original, role, { root, client });
  t.after(() => ordinary.close());
  const backend = new DshBackend(
    { ...original, functionalAgentOnly: true },
    role,
    { root, client },
  );
  t.after(() => backend.close());
  const selection = {
    provider: "first-provider",
    model: "first-model",
    effort: "low",
  };
  const secondSelection = {
    provider: "second-provider",
    model: "second-model",
    effort: "medium",
  };
  const signal = new AbortController().signal;
  const signature = backend.sessionSignature([]);
  assert.notEqual(backend.sessionSignature([], selection), signature);
  await assert.rejects(
    ordinary.run({ signal, tools: [], modelSelection: selection }),
    /FUNCTIONAL_AGENT_BACKEND_UNSUPPORTED/,
  );
  await assert.rejects(
    backend.run({ signal, tools: [] }),
    /FUNCTIONAL_AGENT_BACKEND_UNSUPPORTED/,
  );
  await assert.rejects(
    backend.run({
      signal,
      tools: [],
      modelSelection: selection,
      session: { id: "chat", backend: "dsh", signature },
    }),
    /SESSION_REQUIRES_HANDOFF/,
  );
  assert.equal(client.calls.length, 0);
  const stopped = [];
  client.stopSessionWork = async (id) => stopped.push(id);
  const run = (modelSelection) =>
    backend.run({
      signal,
      tools: [],
      prompt: "child",
      modelSelection,
      saveSession: () => assert.fail("a child session must stay ephemeral"),
    });
  const first = run(selection);
  selection.model = "changed-after-start";
  const second = run(secondSelection);
  await tick();
  const selected = client.calls
    .filter((c) => c.name === "model")
    .map((c) => c.args);
  assert.deepEqual(
    selected.map(({ provider, model, reasoningEffort }) => ({
      provider,
      model,
      reasoningEffort,
    })),
    [
      {
        provider: "first-provider",
        model: "first-model",
        reasoningEffort: "low",
      },
      {
        provider: "second-provider",
        model: "second-model",
        reasoningEffort: "medium",
      },
    ],
  );
  const ids = selected.map(({ sessionId }) => sessionId);
  assert.equal(new Set(ids).size, 2);
  assert(ids.every((id) => id.startsWith("session-")));
  for (const sessionId of ids)
    push({
      payload: {
        type: "session/event",
        sessionId,
        event: {
          type: "turn/end",
          data: { turn: "t", reason: { kind: "completed" } },
        },
      },
    });
  await Promise.all([first, second]);
  assert.deepEqual(stopped.sort(), ids.sort());
  assert.equal(backend.sessionSignature([]), signature);
  assert.equal(backend.config.model, "default-model");
});

for (const receiptLost of [false, true])
  test(`DSH abort waits for child cleanup with a ${receiptLost ? "lost" : "confirmed"} receipt`, async (t) => {
    const { client, push } = dshFake();
    const backend = new DshBackend(
      { id: "dsh", preset: "qq-unified", functionalAgentOnly: true },
      config().agents[0],
      { root: temp(t), client },
    );
    t.after(() => backend.close());
    const sent = Promise.withResolvers();
    const submission = Promise.withResolvers();
    const stopped = Promise.withResolvers();
    let sessionId;
    const refresh = Promise.withResolvers();
    let follows = 0;
    client.events.follow = (id) => {
      if (++follows === 1) {
        sessionId = id;
        push({
          payload: {
            type: "session/snapshot",
            sessionId,
            snapshot: { records: [] },
          },
        });
      } else refresh.resolve();
    };
    const cleanup = Promise.withResolvers();
    client.sessions.prompt = () => {
      sent.resolve();
      return submission.promise;
    };
    let stopCalls = 0;
    client.stopSessionWork = (id) => {
      assert.equal(id, sessionId);
      stopCalls++;
      stopped.resolve();
      return cleanup.promise;
    };
    const controller = new AbortController();
    let settled = false;
    const rejected = assert
      .rejects(
        backend.run({
          signal: controller.signal,
          tools: [],
          prompt: "child",
          modelSelection: {
            provider: "fixture",
            model: "child",
            effort: "low",
          },
          saveSession: () => assert.fail("a child session must stay ephemeral"),
        }),
        receiptLost ? /FUNCTIONAL_AGENT_BACKEND_UNAVAILABLE/ : /ABORTED/,
      )
      .then(() => (settled = true));
    await sent.promise;
    controller.abort();
    await tick();
    assert.equal(settled, false);
    assert.equal(stopCalls, 0);
    assert.equal(
      client.calls.some((c) => c.name === "session.cancel"),
      false,
    );
    if (receiptLost) submission.reject(Error("fixture lost receipt"));
    else
      submission.resolve({ result: { ok: true, value: { accepted: true } } });
    await stopped.promise;
    assert.equal(settled, false);
    cleanup.resolve();
    await refresh.promise;
    assert.equal(settled, false);
    push({
      payload: {
        type: "session/snapshot",
        sessionId,
        snapshot: {
          records: [],
          projections: {
            values: { inbox: { "next-turn": [], "next-step": [] } },
          },
        },
      },
    });
    await rejected;
    assert.equal(stopCalls, 1);
    assert.equal(backend.functionalSessionUnverified, receiptLost);
  });

test("DSH resumes measured capacity from a fresh subscription snapshot", async (t) => {
  const { client, push } = dshFake();
  const backend = new DshBackend(
    { id: "dsh", preset: "qq-unified" },
    config(1).agents[0],
    { root: temp(t), client },
  );
  t.after(() => backend.close());
  client.events.follow = (sessionId) =>
    push({
      payload: {
        type: "session/snapshot",
        sessionId,
        snapshot: {
          projections: {
            values: { contextPressure: { contextWindow: 1000000 } },
          },
        },
      },
    });
  const usage = [];
  const run = backend.run({
    conversation: "private:30000",
    prompt: "continue",
    tools: [],
    session: {
      id: "s",
      backend: "dsh",
      signature: backend.sessionSignature([]),
    },
    signal: new AbortController().signal,
    saveSession() {},
    onUsage: (value) => usage.push(value),
  });
  await tick();
  const emit = (type, data) =>
    push({
      payload: {
        type: "session/event",
        sessionId: "s",
        event: { type, data },
      },
    });
  // No new request/context event after reconnect. Invalid metadata must not
  // replace the capacity recovered from the native snapshot.
  emit("request/context", { contextWindow: -1 });
  emit("assistant/message", {
    usage: { inputTokens: 60387, outputTokens: 1864 },
  });
  emit("turn/end", { turn: "t", reason: { kind: "completed" } });
  await run;
  assert.equal(usage[0].contextTokens, 62251);
  assert.equal(usage[0].capacityTokens, 1000000);
  assert.equal(
    client.calls.some((c) => c.name === "create"),
    false,
  );
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

test("the Windows Codex launcher ends the whole process tree, not just the cmd.exe wrapper", () => {
  const children = [],
    killed = [];
  const spawn = (command, args, options) => {
    const child = {
      command,
      args,
      options,
      pid: 4242 + children.length,
      exitCode: null,
      signalCode: null,
      kills: [],
      kill(signal) {
        this.kills.push(signal);
        return true;
      },
    };
    children.push(child);
    return child;
  };
  let failTree = false;
  const launch = windowsCodexSpawn({
    spawn,
    killTree: (pid) => {
      if (failTree) throw Error("taskkill unavailable");
      killed.push(pid);
    },
  });
  const running = launch("codex", ["app-server", "--stdio"], { cwd: "x" });
  assert.deepEqual(running.args, ["app-server", "--stdio"]);
  assert.equal(running.kill("SIGTERM"), true);
  assert.deepEqual(killed, [4242]);
  assert.deepEqual(running.kills, [], "the wrapper-only kill is not used");
  // An exited process is not looked up again by pid.
  const exited = launch("codex", [], {});
  exited.exitCode = 0;
  exited.kill("SIGTERM");
  assert.deepEqual(killed, [4242]);
  assert.deepEqual(exited.kills, ["SIGTERM"]);
  // If taskkill fails, the wrapper is still ended.
  failTree = true;
  const fallback = launch("codex", [], {});
  fallback.kill("SIGTERM");
  assert.deepEqual(fallback.kills, ["SIGTERM"]);
});

test("protected work disables native external tools in the Codex session policy", async (t) => {
  const rpc = new Rpc(),
    cfg = config(),
    backend = new CodexBackend(cfg.backends[0], cfg.agents[0], {
      root: temp(t),
      rpc,
    });
  t.after(() => backend.close());
  const run = backend.run({
    protectedWork: true,
    prompt: "work",
    signal: new AbortController().signal,
    tools: toolSpecs(["protected_work_submit"]),
    callTool: async () => ({}),
    saveSession: () => {},
  });
  await tick();
  const start = rpc.calls.find((c) => c.method === "thread/start").args;
  for (const feature of [
    "shell_tool",
    "image_generation",
    "browser_use",
    "computer_use",
    "in_app_browser",
    "apps",
  ])
    assert.equal(start.config["features." + feature], false, feature);
  assert.deepEqual(
    start.dynamicTools.map((t) => t.name),
    ["protected_work_submit"],
  );
  rpc.complete();
  await run;
});

test("Codex game terminal proof matches the native thread, turn and terminal status", async (t) => {
  const rpc = new Rpc(),
    cfg = config(),
    backend = new CodexBackend(cfg.backends[0], cfg.agents[0], {
      root: temp(t),
      rpc,
    });
  t.after(() => backend.close());
  const request = rpc.request.bind(rpc);
  let thread = {
    id: "game-thread",
    status: { type: "idle" },
    turns: [{ id: "game-turn", status: "interrupted" }],
  };
  rpc.request = async (method, args) =>
    method === "thread/read" ? { thread } : request(method, args);
  const run = { session: { id: "game-thread" }, backendTurn: "game-turn" };
  assert.equal((await backend.gameRunState(run)).terminal, true);
  thread.status.type = "active";
  assert.equal((await backend.gameRunState(run)).terminal, false);
  thread.status.type = "idle";
  assert.equal(
    (await backend.gameRunState({ ...run, backendTurn: "different-turn" }))
      .terminal,
    false,
  );
  thread.id = "different-thread";
  assert.equal((await backend.gameRunState(run)).terminal, false);
});

for (const kind of ["codex", "dsh"])
  test(`${kind} accepts labelled images on the initial prompt without invoking a tool`, async (t) => {
    const rpc = new Rpc();
    const dsh = dshFake();
    const backend =
      kind === "codex"
        ? new CodexBackend(config().backends[0], config().agents[0], {
            root: temp(t),
            rpc,
          })
        : new DshBackend(
            { id: "dsh", preset: "qq-unified" },
            config().agents[0],
            { root: temp(t), client: dsh.client },
          );
    t.after(() => backend.close());
    let toolCalls = 0;
    const inputImages = [
      {
        eventId: "fixture",
        index: 0,
        label: "picture one",
        mimeType: "image/png",
        data: "cGl4ZWxz",
      },
      { eventId: "fixture", index: 1, label: "unavailable" },
    ];
    const running = backend.run({
      prompt: "look",
      inputImages,
      tools: [],
      signal: new AbortController().signal,
      saveSession() {},
      callTool: async () => {
        toolCalls++;
      },
    });
    await tick();
    if (kind === "codex") {
      const input = rpc.calls.find((c) => c.method === "turn/start").args.input;
      assert.deepEqual(input.slice(1), [
        { type: "text", text: "picture one", text_elements: [] },
        { type: "image", url: "data:image/png;base64,cGl4ZWxz" },
        { type: "text", text: "unavailable", text_elements: [] },
      ]);
      rpc.complete();
    } else {
      const input = dsh.client.calls.find((c) => c.name === "prompt").args
        .content;
      assert.deepEqual(input.slice(1), [
        { type: "text", text: "picture one" },
        { type: "image", mediaType: "image/png", data: "cGl4ZWxz" },
        { type: "text", text: "unavailable" },
      ]);
      dsh.push({
        payload: {
          type: "session/event",
          sessionId: "s",
          event: {
            type: "turn/end",
            data: { turn: "t", reason: { kind: "completed" } },
          },
        },
      });
    }
    await running;
    assert.equal(toolCalls, 0);
  });
