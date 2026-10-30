import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { toolSpecs } from "../src/tools/index.mjs";
import { fixture, config } from "../test/helpers.mjs";
import { CodexBackend } from "../src/backends/codex.mjs";
import { sessionSignature } from "../src/backends/session-contract.mjs";
class Rpc extends EventEmitter {
  constructor() {
    super();
    this.calls = [];
    this.n = 0;
    this.t = 0;
  }
  async start() {}
  async request(method, args) {
    this.calls.push({ method, args });
    if (method === "account/read") return { account: { type: "fixture" } };
    if (method === "model/list") return { data: [] };
    if (method === "thread/start")
      return { thread: { id: "thread-" + ++this.n } };
    if (method === "turn/start") {
      const id = "turn-" + ++this.t,
        threadId = args.threadId;
      this.emit("notification", {
        method: "turn/started",
        params: { threadId, turn: { id } },
      });
      this.emit("notification", {
        method: "thread/tokenUsage/updated",
        params: {
          threadId,
          tokenUsage: {
            last: { inputTokens: 1000, outputTokens: 100 },
            total: { totalTokens: 1100 },
            modelContextWindow: 100000,
          },
        },
      });
      queueMicrotask(() =>
        this.emit("notification", {
          method: "turn/completed",
          params: { threadId, turn: { id, status: "completed" } },
        }),
      );
      return { turn: { id } };
    }
    return {};
  }
  respond() {}
  reject() {}
  close() {}
}
test("backend display labels survive adapter recreation without replacing the session", async (t) => {
  const cfg = config(1),
    f = fixture(t, { cfg }),
    rpc = new Rpc();
  const adapter = () =>
    new CodexBackend(f.runtime.config.backends[0], cfg.agents[0], {
      root: f.root,
      rpc,
    });
  let backend = adapter();
  f.runtime.backends.set("agent-0", backend);
  await f.runtime.wake("agent-0", "group:20000");
  const memory = f.store.bind("agent-0"),
    original = memory.state("group:20000").session.id;
  const next = structuredClone(f.runtime.config);
  next.backends[0].label = "A different console label";
  await f.runtime.changeConfig(next, f.configStore.revision);
  await backend.close();
  backend = adapter();
  f.runtime.backends.set("agent-0", backend);
  await f.runtime.wake("agent-0", "group:20000");
  assert.equal(memory.state("group:20000").session.id, original);
  assert.equal(memory.identity.list("session_history").length, 0);
});

test("a connection preflight failure preserves a session before any new input was submitted", async (t) => {
  const cfg = config(1),
    f = fixture(t, { cfg }),
    rpc = new Rpc();
  const backend = new CodexBackend(cfg.backends[0], cfg.agents[0], {
    root: f.root,
    rpc,
  });
  f.runtime.backends.set("agent-0", backend);
  await f.runtime.wake("agent-0", "group:20000");
  const memory = f.store.bind("agent-0"),
    original = memory.state("group:20000").session;
  const calls = rpc.calls.length;
  backend.ready = async () => {
    throw Error("CODEX_DISCONNECTED");
  };
  await f.runtime.wake("agent-0", "group:20000");
  assert.deepEqual(memory.state("group:20000").session, original);
  assert.equal(rpc.calls.length, calls);
  assert.equal(memory.identity.list("session_history").length, 0);
  assert.equal(
    memory.identity.list("model_turns").filter((x) => x.status === "failed")
      .length,
    1,
  );
});

test("matching legacy contracts migrate in place while changed contracts still retire", async (t) => {
  const cfg = config(1),
    f = fixture(t, { cfg }),
    rpc = new Rpc();
  const backend = new CodexBackend(cfg.backends[0], cfg.agents[0], {
    root: f.root,
    rpc,
  });
  f.runtime.backends.set("agent-0", backend);
  await f.runtime.wake("agent-0", "group:20000");
  const memory = f.store.bind("agent-0"),
    original = memory.state("group:20000");
  const tools = toolSpecs(
    f.runtime.toolsFor(f.runtime.agent("agent-0"), "group:20000"),
  );
  const legacy = {
    ...original.session,
    signature: sessionSignature(backend, tools, true),
  };
  memory.setState("group:20000", { ...original, session: legacy });
  await f.runtime.wake("agent-0", "group:20000");
  assert.equal(memory.state("group:20000").session.id, original.session.id);
  assert.match(memory.state("group:20000").session.signature, /^contract-v3:/);
  assert.equal(memory.identity.list("session_history").length, 0);
  memory.setState("group:20000", {
    ...memory.state("group:20000"),
    session: legacy,
  });
  backend.config = { ...backend.config, model: "different-model" };
  await f.runtime.wake("agent-0", "group:20000");
  assert.notEqual(memory.state("group:20000").session.id, original.session.id);
  assert.equal(
    memory.identity.list("session_history")[0].reason,
    "backend-contract-change",
  );
});
test("full tool contracts rebuild with handoff, normalized objects reuse, and old metadata upgrades once", async (t) => {
  const cfg = config(1),
    { runtime, store, root } = fixture(t, { cfg }),
    m = store.bind("agent-0"),
    rpc = new Rpc();
  let backend = new CodexBackend(cfg.backends[0], cfg.agents[0], { root, rpc });
  const first = m.append({
    dedupe: "task",
    conversation: "group:20000",
    kind: "message.received",
    direction: "in",
    body: "旅行预算600元，三人杭州，尚未完成。",
  });
  async function go(tools) {
    const ctx = runtime.makeContext("agent-0", "group:20000");
    runtime.running.set("agent-0|group:20000", ctx);
    const p = runtime.contexts.prepare(ctx, backend, [], tools);
    try {
      await backend.run({
        ...p,
        tools,
        signal: ctx.controller.signal,
        callTool: async () => ({}),
        onUsage: (u) => runtime.contexts.usage(ctx, u),
        saveSession: (session) =>
          m.setState(ctx.conversation, {
            ...m.state(ctx.conversation),
            session,
          }),
      });
      await runtime.contexts.finish(ctx, "completed-no-send", backend);
    } finally {
      runtime.running.delete("agent-0|group:20000");
      runtime.capabilities.delete(ctx.token);
    }
    return ctx;
  }
  const old = [
    {
      name: "example",
      description: "old",
      inputSchema: {
        type: "object",
        properties: { oldField: { type: "string" } },
        required: ["oldField"],
      },
    },
  ];
  await go(old);
  m.setState("group:20000", {
    ...m.state("group:20000"),
    readThroughSeq: first.seq,
  });
  const changed = [
    {
      name: "example",
      description: "new",
      inputSchema: {
        type: "object",
        properties: { newField: { type: "string" } },
        required: ["newField"],
      },
    },
  ];
  assert.equal((await go(changed)).initialSession, true);
  assert.deepEqual(
    rpc.calls.filter((x) => x.method === "thread/start").at(-1).args
      .dynamicTools[0].inputSchema.required,
    ["newField"],
  );
  assert.match(
    rpc.calls.filter((x) => x.method === "turn/start").at(-1).args.input[0]
      .text,
    /600元/,
  );
  assert.equal(m.state("group:20000").readThroughSeq, first.seq);
  assert.equal(m.identity.notes("group:20000").length, 0);
  await backend.close();
  backend = new CodexBackend(cfg.backends[0], cfg.agents[0], { root, rpc });
  const reordered = [
    {
      inputSchema: {
        required: ["newField"],
        properties: { newField: { type: "string" } },
        type: "object",
      },
      description: "new",
      name: "example",
    },
  ];
  assert.equal((await go(reordered)).initialSession, false);
  assert.equal(rpc.calls.filter((x) => x.method === "thread/start").length, 2);
  await go([{ ...changed[0], description: "description-only-change" }]);
  assert.equal(rpc.calls.filter((x) => x.method === "thread/start").length, 3);
  const state = m.state("group:20000");
  m.setState("group:20000", {
    ...state,
    session: { ...state.session, signature: "legacy-name-only-metadata" },
  });
  assert.equal((await go(changed)).initialSession, true);
  assert.equal((await go(changed)).initialSession, false);
  assert.equal(m.identity.list("session_history").length, 3);
  assert.equal(m.db.prepare("SELECT COUNT(*) n FROM events").get().n, 1);
  await backend.close();
});

test("model/file/backend changes retire before prompting; aborted and busy preparation cannot retire another owner", async (t) => {
  const cfg = config(1),
    { runtime, store, root } = fixture(t, { cfg }),
    m = store.bind("agent-0"),
    rpc = new Rpc();
  const backend = new CodexBackend(cfg.backends[0], cfg.agents[0], {
    root,
    rpc,
  });
  runtime.backends.set("agent-0", backend);
  await runtime.wake("agent-0", "group:20000");
  const session = m.state("group:20000").session;
  backend.config = { ...backend.config, model: "changed-model" };
  const ctx = runtime.makeContext("agent-0", "group:20000");
  ctx.controller.abort();
  assert.throws(
    () => runtime.contexts.prepare(ctx, backend, [], []),
    /ABORTED/,
  );
  assert.deepEqual(m.state("group:20000").session, session);
  const owner = runtime.makeContext("agent-0", "group:20000");
  runtime.running.set("agent-0|group:20000", owner);
  const rival = runtime.makeContext("agent-0", "group:20000");
  assert.throws(
    () => runtime.contexts.prepare(rival, backend, [], []),
    /SESSION_BUSY/,
  );
  assert.equal(runtime.running.get("agent-0|group:20000"), owner);
  runtime.running.delete("agent-0|group:20000");
  await Promise.all([
    runtime.wake("agent-0", "group:20000"),
    runtime.wake("agent-0", "group:20000"),
  ]);
  assert.equal(rpc.calls.filter((x) => x.method === "thread/start").length, 2);
  assert.equal(m.identity.list("session_history").length, 1);
  const oldSignature = backend.sessionSignature(toolSpecs(["memory_read"]));
  assert.notEqual(
    backend.sessionSignature(toolSpecs(["memory_read", "file_create"])),
    oldSignature,
  );
  assert.equal(runtime.transports.get("qq-0").sent.length, 0);
});
test("Codex App tools change retires through lifecycle with ordinary task handoff", async (t) => {
  const cfg = config(1);
  // Readiness failures must not invoke unrelated context compaction.
  cfg.agents[0].contextPolicy.capacityTokens = 131072;
  cfg.agents[0].behavior.preSleepWaitMs = 0;
  const { runtime, store, root } = fixture(t, { cfg }),
    m = store.bind("agent-0"),
    rpc = new Rpc();
  const backend = new CodexBackend(cfg.backends[0], runtime.agent("agent-0"), {
    root,
    rpc,
  });
  const run = backend.run.bind(backend);
  backend.run = async (p) => {
    await run(p);
    const page = await p.callTool("conversation_read", {
      conversation: "group:20000",
    });
    await p.callTool("qq_mark_read", { throughSeq: page.items.at(-1).seq });
  };
  runtime.backends.set("agent-0", backend);
  const first = m.append({
    dedupe: "task-1",
    conversation: "group:20000",
    kind: "message.received",
    direction: "in",
    senderId: "30000",
    body: "杭州三人出行每晚住宿预算600元，记住这些条件继续制定旅行方案。",
  });
  await runtime.wake("agent-0", "group:20000");
  assert.equal(m.state("group:20000").readThroughSeq, first.seq);
  await runtime.changeAppPermissions(
    "agent-0",
    { enabled: true, sharing: true, platforms: ["bilibili"] },
    runtime.configStore.revision,
  );
  m.append({
    dedupe: "task-2",
    conversation: "group:20000",
    kind: "message.received",
    direction: "in",
    senderId: "30000",
    body: "继续刚才的方案。",
  });
  await runtime.wake("agent-0", "group:20000");
  const starts = rpc.calls.filter((x) => x.method === "thread/start"),
    turns = rpc.calls.filter((x) => x.method === "turn/start");
  assert.equal(starts.length, 2);
  assert.equal(turns.length, 2);
  assert(turns[1].args.input[0].text.includes("杭州"));
  assert(turns[1].args.input[0].text.includes("程序交接状态"));
  assert.equal(m.identity.list("model_turns")[0].initialSession, true);
  assert.equal(m.identity.list("session_history").length, 1);
  assert.equal(m.state("group:20000").readThroughSeq, 2);
  assert.equal(m.identity.notes("group:20000").length, 0);
});
import { DshBackend } from "../src/backends/dsh.mjs";
import { FakeTransport } from "../test/helpers.mjs";
test("DSH preset changes load Self and retain task handoff before prompting", async (t) => {
  const cfg = config(1);
  // Readiness failures must not invoke unrelated context compaction.
  cfg.agents[0].contextPolicy.capacityTokens = 131072;
  cfg.agents[0].behavior.preSleepWaitMs = 0;
  cfg.backends[0].type = "dsh";
  cfg.backends[0].preset = "qq-unified";
  const { runtime, store, root } = fixture(t, { cfg }),
    m = store.bind("agent-0"),
    calls = [];
  let sessions = 0;
  runtime.backendFactory = (c, a) => {
    let backend;
    const ok = (value) => ({ result: { ok: true, value } });
    const client = {
      agentPresets: { list: async () => ok({ presets: [{ id: c.preset }] }) },
      workspace: {
        create: async () => ok({ workspace: { workspaceId: "w" } }),
      },
      sessions: {
        create: async () => {
          sessions++;
          return ok({ sessionId: "session-" + sessions });
        },
        prompt: async (args) => {
          calls.push(args);
          const current = backend.turns.get(args.sessionId);
          current.onUsage?.({
            source: "measured",
            contextTokens: 1000,
            capacityTokens: 100000,
          });
          queueMicrotask(() => current.resolve());
          return ok({ accepted: true });
        },
      },
      events: {
        follow: (id) => backend.turns.get(id)?.followed(),
        forget() {},
      },
      callUnary: async () => ok({}),
    };
    backend = new DshBackend(c, a, { root, client });
    backend.stream = async () => {};
    const run = backend.run.bind(backend);
    backend.run = async (p) => {
      await run(p);
      const page = await p.callTool("conversation_read", {
        conversation: "group:20000",
      });
      await p.callTool("qq_mark_read", { throughSeq: page.items.at(-1).seq });
    };
    return backend;
  };
  m.append({
    dedupe: "dsh-first",
    conversation: "group:20000",
    kind: "message.received",
    direction: "in",
    senderId: "30000",
    body: "杭州三人住宿600元，继续制定旅行方案。",
  });
  await runtime.wake("agent-0", "group:20000");
  const updated = structuredClone(runtime.config);
  updated.backends[0].preset = "qq-unified-new";
  await runtime.changeConfig(updated, runtime.configStore.revision);
  runtime.transports.set("qq-0", new FakeTransport());
  m.append({
    dedupe: "dsh-second",
    conversation: "group:20000",
    kind: "message.received",
    direction: "in",
    senderId: "30000",
    body: "继续刚才的方案。",
  });
  await runtime.wake("agent-0", "group:20000");
  assert.equal(sessions, 2);
  assert.equal(calls.length, 2);
  assert(calls[1].content[0].text.includes("杭州"));
  assert(calls[1].content[0].text.includes("程序交接状态"));
  assert(calls[1].content[0].text.includes("当前 self"));
  assert.equal(m.identity.list("session_history").length, 1);
  assert.equal(m.identity.list("model_turns")[0].initialSession, true);
});
