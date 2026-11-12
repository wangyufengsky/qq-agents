import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { runNativeSocial } from "../src/backends/native-social.mjs";
import { CodexBackend } from "../src/backends/codex.mjs";
import { DshBackend } from "../src/backends/dsh.mjs";
import { AntigravityBackend } from "../src/backends/antigravity.mjs";
import { config, temp } from "./helpers.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const socialParams = () => ({
  binding: { runId: "synthetic-social-run" },
  budget: null,
  outputCap: null,
  maxInferences: null,
  prompt: "Synthetic social input",
  instructions: "Synthetic identity",
  tools: [
    {
      type: "function",
      function: {
        name: "home_social_capabilities",
        parameters: { type: "object" },
      },
    },
  ],
  signal: new AbortController().signal,
  beforeInput: async () => {},
  onRunStarted: async () => {},
  callTool: async () => ({ ok: true }),
  maxToolResultBytes: 32000,
});

test("native social freezes only submitted input, confirms before tools, and never retains sessions", async () => {
  const params = socialParams(),
    order = [],
    tickets = [],
    pending = ["initial"];
  let registered, disposed, native;
  params.captureInputConsumption = () => pending.slice();
  params.onInputConsumed = async (ticket) => {
    order.push("consume");
    tickets.push(ticket);
  };
  params.onRunStarted = async () => order.push("start");
  params.registerInputConsumer = (consumer) => {
    registered = consumer;
  };
  params.callTool = async () => {
    order.push("tool");
    pending.push("unconsumed-tool-result");
    return {};
  };
  await runNativeSocial(
    {
      async run(value) {
        native = value;
        assert.equal(value.session, null);
        assert.equal(value.conversation, "@social:synthetic-social-run");
        value.saveSession({ id: "native-social-only" });
        await value.beforeInputSubmitted();
        order.push("submit");
        await registered();
        await value.callTool("home_social_capabilities", {});
      },
    },
    params,
    async (session) => {
      disposed = session;
    },
  );
  assert.deepEqual(order, ["start", "submit", "consume", "tool"]);
  assert.deepEqual(tickets, [["initial"]]);
  assert.equal(disposed.id, "native-social-only");
  assert.equal(registered, null);
  assert.equal(native.signal.aborted, true);
});

test("native social denies QQ, filesystem and unknown tools before running", async () => {
  for (const name of [
    "qq_send",
    "file_read",
    "external_tool",
    "shell",
    "unknown",
  ]) {
    const params = socialParams();
    params.tools[0].function.name = name;
    let ran = false;
    await assert.rejects(
      runNativeSocial(
        {
          run: async () => {
            ran = true;
          },
        },
        params,
        async () => {},
      ),
      /SOCIAL_TOOL_DENIED/,
    );
    assert.equal(ran, false);
  }
  await assert.rejects(
    runNativeSocial({}, { ...socialParams(), budget: {} }, async () => {}),
    /SOCIAL_BACKEND_UNSUPPORTED/,
  );
});

test("desktop and web social native tools cannot cross surfaces", async () => {
  const backend = {
    async run(params) {
      assert.equal(params.social, true);
      assert.deepEqual(
        params.tools.map(({ name }) => name),
        ["desktop_room_decide"],
      );
      await params.beforeInputSubmitted();
    },
  };
  const dispose = async () => {};
  const params = socialParams();
  await assert.rejects(
    runNativeSocial(backend, params, dispose, "desktop"),
    /SOCIAL_TOOL_DENIED/,
  );
  params.tools[0].function.name = "desktop_room_decide";
  await assert.rejects(
    runNativeSocial(backend, params, dispose),
    /SOCIAL_TOOL_DENIED/,
  );
  await runNativeSocial(backend, params, dispose, "desktop");
});

test("setup refusal is uncounted; submitted failure stays failed without replay or consumption", async () => {
  for (const failAfterSubmit of [false, true]) {
    let started = 0,
      consumed = 0,
      attempts = 0,
      disposed = 0;
    const params = socialParams();
    params.onRunStarted = async () => {
      started++;
    };
    params.onInputConsumed = async () => {
      consumed++;
    };
    await assert.rejects(
      runNativeSocial(
        {
          async run(value) {
            attempts++;
            value.saveSession({ id: "temporary" });
            if (failAfterSubmit) await value.beforeInputSubmitted();
            throw Error("SYNTHETIC_FAILURE");
          },
        },
        params,
        async () => {
          disposed++;
        },
      ),
      /SYNTHETIC_FAILURE/,
    );
    assert.equal(started, Number(failAfterSubmit));
    assert.equal(consumed, 0);
    assert.equal(attempts, 1);
    assert.equal(disposed, 1);
  }
});

test("native social rechecks ACL before tools and treats cleanup failure as a failure", async () => {
  const params = socialParams();
  let checks = 0,
    tools = 0;
  params.beforeInput = async () => {
    if (++checks === 4) throw Error("AUDIENCE_DENIED");
  };
  params.callTool = async () => {
    tools++;
  };
  await assert.rejects(
    runNativeSocial(
      {
        async run(value) {
          await value.beforeInputSubmitted();
          await value.callTool("home_social_capabilities", {});
        },
      },
      params,
      async () => {},
    ),
    /AUDIENCE_DENIED/,
  );
  assert.equal(tools, 0);
  await assert.rejects(
    runNativeSocial({ run: async () => {} }, socialParams(), async () => {
      throw Error("SOCIAL_CONTEXT_FINALIZATION_FAILED");
    }),
    /SOCIAL_CONTEXT_FINALIZATION_FAILED/,
  );
});

class Rpc extends EventEmitter {
  calls = [];
  async start() {}
  async request(method, args) {
    this.calls.push({ method, args });
    if (method === "account/read") return { account: { type: "fixture" } };
    if (method === "model/list") return { data: [{ model: "fixture-model" }] };
    if (method === "config/read")
      return {
        config: { mcp_servers: { unrelated: { command: "never-run" } } },
      };
    if (method === "thread/start")
      return { thread: { id: "isolated-social-thread" } };
    if (method === "turn/start")
      return { turn: { id: "isolated-social-turn" } };
    return {};
  }
  reject() {}
  respond() {}
  close() {}
}

test("Codex social starts a fresh thread, explicitly disables inherited MCP and archives it", async (t) => {
  const cfg = config(),
    rpc = new Rpc();
  const backend = new CodexBackend(cfg.backends[0], cfg.agents[0], {
    root: temp(t),
    rpc,
  });
  t.after(() => backend.close());
  let count = 0;
  const params = socialParams();
  params.onRunStarted = async () => {
    count++;
  };
  const run = backend.runSocial({
    ...params,
    session: { id: "ordinary-session" },
  });
  await tick();
  const start = rpc.calls.find((call) => call.method === "thread/start").args;
  assert.equal(start.config["features.shell_tool"], false);
  assert.equal(start.config["tools.view_image"], false);
  assert.equal(start.config["features.image_generation"], false);
  assert.equal(start.config["features.browser_use"], false);
  assert.deepEqual(start.config.mcp_servers, { unrelated: { enabled: false } });
  assert.deepEqual(
    start.dynamicTools.map((tool) => tool.name),
    ["home_social_capabilities"],
  );
  assert.equal(
    rpc.calls.some((call) => call.method === "thread/resume"),
    false,
  );
  assert.equal(count, 1);
  rpc.emit("notification", {
    method: "turn/completed",
    params: {
      threadId: "isolated-social-thread",
      turn: { id: "isolated-social-turn", status: "completed" },
    },
  });
  await run;
  assert.equal(rpc.calls.at(-1).method, "thread/archive");
  assert.equal(backend.active.size, 0);
});

test("DSH social requires guarded preset, freezes a current capability and drains its private session", async (t) => {
  const cfg = config(),
    stopped = [];
  const backend = new DshBackend(
    { ...cfg.backends[0], preset: "qq-unified" },
    cfg.agents[0],
    {
      root: temp(t),
      client: { stopSessionWork: async (id) => stopped.push(id) },
    },
  );
  const params = {
    ...socialParams(),
    socialContextToken: "synthetic-social-capability",
  };
  let native;
  backend.run = async (value) => {
    native = value;
    value.saveSession({ id: "social-session" });
    await value.beforeInputSubmitted();
  };
  await backend.runSocial({ ...params, session: { id: "ordinary-session" } });
  assert.equal(native.session, null);
  assert.match(native.prompt, /context=synthetic-social-capability/);
  assert.deepEqual(stopped, ["social-session"]);
  backend.config.preset = "unrestricted";
  await assert.rejects(backend.runSocial(params), /SOCIAL_BACKEND_UNSUPPORTED/);
});

test("Antigravity social bypasses workers, scopes image readers, and removes native transcripts", async (t) => {
  const cfg = config(),
    root = temp(t);
  let settings,
    agent,
    spawned = 0;
  const backend = new AntigravityBackend(
    { ...cfg.backends[0], cliReuse: { enabled: true } },
    cfg.agents[0],
    {
      root,
      spawn(_command, args, options) {
        spawned++;
        settings = JSON.parse(
          fs.readFileSync(args[args.indexOf("--settings") + 1], "utf8"),
        );
        agent = fs.readFileSync(
          path.join(options.cwd, ".agents", "agents", "qq-agents.md"),
          "utf8",
        );
        const child = new EventEmitter();
        child.pid = 10000;
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => true;
        child.stdin = new Writable({
          write(_chunk, _encoding, callback) {
            const id = "00000000-0000-4000-8000-000000000001";
            const dir = path.join(backend.profile, "cli", "conversations");
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(
              path.join(dir, id + ".db"),
              "synthetic transcript",
            );
            const frames = [
              { event: "init", conversation_id: id },
              {
                event: "step_update",
                step_update: {
                  conversation_id: id,
                  step_index: 1,
                  step_type: "agent_response",
                  state: "DONE",
                },
              },
              {
                event: "result",
                result: { conversation_id: id, status: "SUCCESS" },
              },
            ];
            child.stdout.write(
              frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n",
            );
            callback();
            setImmediate(() => child.emit("close", 0, null));
          },
        });
        return child;
      },
      stop() {},
    },
  );
  t.after(() => backend.close());
  await backend.runSocial(socialParams());
  assert.equal(spawned, 1);
  assert.equal(backend.workers.size, 0);
  assert.match(agent, /^ {2}- view_file$/m);
  assert.doesNotMatch(agent, /^ {2}- read_file$/m);
  assert.equal(
    settings.permissions.allow[0],
    "mcp(qq-agents/home_social_capabilities)",
  );
  assert.equal(settings.permissions.allow.length, 2);
  assert.match(
    settings.permissions.allow[1],
    /^read_file\(.+qq-agy-media-[^/]+\/\*\)$/,
  );
  assert.deepEqual(fs.readdirSync(path.join(backend.root, "workspaces")), []);
  assert.deepEqual(
    fs.readdirSync(path.join(backend.profile, "cli", "conversations")),
    [],
  );
});

test("Codex social cancellation archives its private thread and never acknowledges unknown input", async (t) => {
  const cfg = config(),
    rpc = new Rpc(),
    controller = new AbortController();
  const backend = new CodexBackend(cfg.backends[0], cfg.agents[0], {
    root: temp(t),
    rpc,
  });
  t.after(() => backend.close());
  let consumed = 0;
  const run = backend.runSocial({
    ...socialParams(),
    signal: controller.signal,
    onInputConsumed: async () => {
      consumed++;
    },
  });
  await tick();
  controller.abort();
  await assert.rejects(run, /ABORTED/);
  assert.equal(consumed, 0);
  assert.equal(
    rpc.calls.filter((call) => call.method === "thread/archive").length,
    1,
  );
  assert.equal(
    rpc.calls.filter((call) => call.method === "turn/start").length,
    1,
  );
  assert.equal(backend.active.size, 0);
});

test("Codex social uses a new thread each run and cleanup refusal cannot become a successful handoff", async (t) => {
  const cfg = config(),
    rpc = new Rpc();
  const backend = new CodexBackend(cfg.backends[0], cfg.agents[0], {
    root: temp(t),
    rpc,
  });
  t.after(() => backend.close());
  for (let round = 0; round < 2; round++) {
    const run = backend.runSocial({
      ...socialParams(),
      session: { id: "ordinary-session" },
    });
    await tick();
    rpc.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: "isolated-social-thread",
        turn: { id: "isolated-social-turn", status: "completed" },
      },
    });
    await run;
  }
  assert.equal(
    rpc.calls.filter((call) => call.method === "thread/start").length,
    2,
  );
  assert.equal(
    rpc.calls.filter((call) => call.method === "thread/resume").length,
    0,
  );
  const request = rpc.request.bind(rpc);
  rpc.request = async (method, args) => {
    if (method === "thread/archive") throw Error("PRIVATE_PROVIDER_DETAIL");
    return request(method, args);
  };
  const run = backend.runSocial(socialParams());
  await tick();
  rpc.emit("notification", {
    method: "turn/completed",
    params: {
      threadId: "isolated-social-thread",
      turn: { id: "isolated-social-turn", status: "completed" },
    },
  });
  await assert.rejects(run, /^Error: SOCIAL_CONTEXT_FINALIZATION_FAILED$/);
});

test("Codex social cannot start when effective MCP configuration is unverifiable", async (t) => {
  const cfg = config(),
    rpc = new Rpc();
  const request = rpc.request.bind(rpc);
  rpc.request = async (method, args) =>
    method === "config/read" ? {} : request(method, args);
  const backend = new CodexBackend(cfg.backends[0], cfg.agents[0], {
    root: temp(t),
    rpc,
  });
  t.after(() => backend.close());
  let count = 0;
  await assert.rejects(
    backend.runSocial({
      ...socialParams(),
      onRunStarted: async () => {
        count++;
      },
    }),
    /SOCIAL_BACKEND_UNSUPPORTED/,
  );
  assert.equal(count, 0);
  assert.equal(
    rpc.calls.some((call) => call.method === "thread/start"),
    false,
  );
});

function dshSocialFixture(t, { hold = false } = {}) {
  const queue = [],
    calls = [];
  let waiting;
  const push = (payload) => {
    queue.push({ payload });
    waiting?.();
    waiting = null;
  };
  const ok = (value) => ({ result: { ok: true, value } });
  const client = {
    agentPresets: { list: async () => ok({ presets: [{ id: "qq-unified" }] }) },
    workspace: {
      create: async (args) => {
        calls.push({ name: "workspace", args });
        return ok({ workspace: { workspaceId: "social-workspace" } });
      },
    },
    sessions: {
      create: async (args) => {
        calls.push({ name: "create", args });
        return ok({ sessionId: "fresh-social-session" });
      },
      selectModel: async () => ok({}),
      prompt: async (args) => {
        calls.push({ name: "prompt", args });
        push({
          type: "session/event",
          sessionId: args.sessionId,
          event: { type: "turn/start", data: { turn: "social-turn" } },
        });
        if (!hold)
          push({
            type: "session/event",
            sessionId: args.sessionId,
            event: {
              type: "turn/end",
              data: { turn: "social-turn", reason: { kind: "completed" } },
            },
          });
        return ok({ accepted: true });
      },
    },
    events: {
      follow: (sessionId) =>
        push({
          type: "session/snapshot",
          sessionId,
          snapshot: { records: [] },
        }),
      forget() {},
      async *mux(_params, signal, onOpen) {
        onOpen();
        signal.addEventListener("abort", () => waiting?.(), { once: true });
        while (!signal.aborted) {
          while (queue.length) yield queue.shift();
          if (!signal.aborted)
            await new Promise((resolve) => {
              waiting = resolve;
            });
        }
      },
    },
    callUnary: async (name) => {
      calls.push({ name });
      return ok({});
    },
    stopSessionWork: async (id) => {
      calls.push({ name: "drain", id });
    },
  };
  const backend = new DshBackend(
    { id: "dsh-social", preset: "qq-unified", model: "fixture-model" },
    config().agents[0],
    { root: temp(t), client },
  );
  t.after(() => backend.close());
  return { backend, calls };
}

test("DSH social actual adapter creates a fresh session and counts immediately before prompt submission", async (t) => {
  const { backend, calls } = dshSocialFixture(t);
  const params = socialParams();
  let consumed = 0;
  params.onRunStarted = async () => {
    calls.push({ name: "count" });
  };
  params.onInputConsumed = async () => {
    consumed++;
  };
  await backend.runSocial({
    ...params,
    socialContextToken: "synthetic-social-capability",
    session: { id: "ordinary-session" },
  });
  assert.deepEqual(
    calls
      .filter((call) =>
        ["create", "count", "prompt", "drain"].includes(call.name),
      )
      .map((call) => call.name),
    ["create", "count", "prompt", "drain"],
  );
  assert.equal(
    calls.find((call) => call.name === "create").args.agentPreset,
    "qq-unified",
  );
  assert.equal(
    calls.find((call) => call.name === "prompt").args.sessionId,
    "fresh-social-session",
  );
  assert.match(
    calls.find((call) => call.name === "prompt").args.content[0].text,
    /context=synthetic-social-capability/,
  );
  assert.equal(consumed, 1);
  assert.equal(backend.turns.size, 0);
});

test("DSH social actual adapter submits no prompt when the durable start is refused and drains setup", async (t) => {
  const { backend, calls } = dshSocialFixture(t);
  let consumed = 0;
  await assert.rejects(
    backend.runSocial({
      ...socialParams(),
      socialContextToken: "synthetic-social-capability",
      onRunStarted: async () => {
        throw Error("SOCIAL_TURN_CLOSED");
      },
      onInputConsumed: async () => {
        consumed++;
      },
    }),
    /SOCIAL_TURN_CLOSED/,
  );
  assert.equal(calls.filter((call) => call.name === "create").length, 1);
  assert.equal(
    calls.some((call) => call.name === "prompt"),
    false,
  );
  assert.equal(
    calls.find((call) => call.name === "drain").id,
    "fresh-social-session",
  );
  assert.equal(consumed, 0);
});

test("DSH social actual adapter cancellation cancels and drains the submitted run without replay", async (t) => {
  const { backend, calls } = dshSocialFixture(t, { hold: true });
  const controller = new AbortController();
  let count = 0,
    consumed = 0;
  const run = backend.runSocial({
    ...socialParams(),
    signal: controller.signal,
    socialContextToken: "synthetic-social-capability",
    onRunStarted: async () => {
      count++;
    },
    onInputConsumed: async () => {
      consumed++;
    },
  });
  await tick();
  assert.equal(calls.filter((call) => call.name === "prompt").length, 1);
  controller.abort();
  await assert.rejects(run, /ABORTED/);
  assert.equal(count, 1);
  assert.equal(consumed, 0);
  assert.equal(calls.filter((call) => call.name === "create").length, 1);
  assert.equal(
    calls.filter((call) => call.name === "session.cancel").length,
    1,
  );
  assert.equal(
    calls.find((call) => call.name === "drain").id,
    "fresh-social-session",
  );
  assert.equal(backend.turns.size, 0);
});

function windowParams(runId, windowId = "window-one", actor = "host") {
  return {
    ...socialParams(),
    binding: {
      runId,
      windowId,
      actorIdentity: { agentId: `agent-${actor}`, generation: actor },
      target: { kind: "visit", id: `visit-${windowId}` },
      targetHostGeneration: "host",
      targetGuestGeneration: "guest",
      epoch: "synthetic-epoch",
      backendContract: "synthetic-backend-contract",
    },
  };
}

test("native capsules reuse only the same window and actor, with fresh per-run callbacks", async () => {
  const sessions = [],
    disposed = [],
    calls = [],
    instructions = [];
  let sequence = 0;
  const backend = {
    async run(value) {
      sessions.push(value.session?.id || null);
      instructions.push(value.instructions);
      if (!value.session) value.saveSession({ id: `session-${++sequence}` });
      await value.beforeInputSubmitted();
      await value.callTool("home_social_capabilities", {});
    },
  };
  const dispose = async (session) => {
    disposed.push(session.id);
  };
  for (const [runId, windowId, actor] of [
    ["r1", "w1", "host"],
    ["r2", "w1", "host"],
    ["r3", "w1", "guest"],
    ["r4", "w2", "host"],
  ]) {
    const params = windowParams(runId, windowId, actor);
    params.callTool = async () => {
      calls.push(runId);
      return {};
    };
    params.session = { id: "ordinary-chat-session" };
    await runNativeSocial(backend, params, dispose);
  }
  assert.deepEqual(sessions, [null, "session-1", null, null]);
  assert.deepEqual(calls, ["r1", "r2", "r3", "r4"]);
  assert.deepEqual(instructions, [
    "Synthetic identity",
    undefined,
    "Synthetic identity",
    "Synthetic identity",
  ]);
  assert.deepEqual(disposed, []);
  await backend.socialSessionPool.close({ windowId: "w1" });
  assert.deepEqual(disposed.sort(), ["session-1", "session-2"]);
  assert.equal(backend.socialSessionPool.capsules.size, 1);
  await assert.rejects(
    runNativeSocial(backend, windowParams("r5", "w1", "host"), dispose),
    /SOCIAL_TURN_CLOSED/,
  );
  await backend.socialSessionPool.close();
  assert.equal(disposed.length, 3);
});

test("native window yield waits for a normal terminal before retaining its session", async () => {
  let yielded = false,
    reachedTerminal = false,
    disposed = 0;
  const params = windowParams("yield-run");
  params.tools = [
    {
      type: "function",
      function: { name: "home_exchange_yield", parameters: { type: "object" } },
    },
  ];
  params.beforeInput = async () => {
    if (yielded) throw Error("SOCIAL_TURN_CLOSED");
  };
  params.shouldStop = () => yielded;
  params.callTool = async () => {
    yielded = true;
    return { batchSealed: true };
  };
  const backend = {
    async run(value) {
      value.saveSession({ id: "continuing-social-session" });
      await value.beforeInputSubmitted();
      await value.callTool("home_exchange_yield", {});
      assert.equal(value.signal.aborted, false);
      await tick();
      reachedTerminal = true;
    },
  };
  await runNativeSocial(backend, params, async () => {
    disposed++;
  });
  assert.equal(reachedTerminal, true);
  assert.equal(disposed, 0);
  assert.equal(
    [...backend.socialSessionPool.capsules.values()][0].state,
    "idle",
  );
  await backend.socialSessionPool.close();
  assert.equal(disposed, 1);
});

test("failed native continuation closes the capsule and cannot start a replacement in that window", async () => {
  let attempts = 0,
    disposed = 0;
  const backend = {
    async run(value) {
      attempts++;
      if (!value.session) value.saveSession({ id: "window-session" });
      await value.beforeInputSubmitted();
      if (attempts === 2) throw Error("SYNTHETIC_UNKNOWN_RESULT");
    },
  };
  const dispose = async () => {
    disposed++;
  };
  await runNativeSocial(backend, windowParams("first-run"), dispose);
  await assert.rejects(
    runNativeSocial(backend, windowParams("second-run"), dispose),
    /SYNTHETIC_UNKNOWN_RESULT/,
  );
  assert.equal(disposed, 1);
  assert.equal(attempts, 2);
  await assert.rejects(
    runNativeSocial(backend, windowParams("third-run"), dispose),
    /SOCIAL_TURN_CLOSED/,
  );
  assert.equal(attempts, 2);
});

test("closing an active native capsule waits for cancellation and cleanup", async () => {
  let ready,
    cleaned = false;
  const started = new Promise((resolve) => {
    ready = resolve;
  });
  const backend = {
    async run(value) {
      value.saveSession({ id: "active-session" });
      await value.beforeInputSubmitted();
      ready();
      await new Promise((_resolve, reject) => {
        value.signal.addEventListener("abort", () => reject(Error("ABORTED")), {
          once: true,
        });
      });
    },
  };
  const run = runNativeSocial(backend, windowParams("active-run"), async () => {
    await tick();
    cleaned = true;
  });
  await started;
  const failed = assert.rejects(run, /ABORTED/);
  await backend.socialSessionPool.close({ windowId: "window-one" });
  await failed;
  assert.equal(cleaned, true);
  assert.equal(backend.socialSessionPool.capsules.size, 0);
});

test("DSH window continuation uses its existing native session with only the current capability", async (t) => {
  const { backend, calls } = dshSocialFixture(t);
  for (const [runId, token] of [
    ["dsh-first", "synthetic-first-social-capability"],
    ["dsh-second", "synthetic-second-social-capability"],
  ]) {
    await backend.runSocial({
      ...windowParams(runId),
      socialContextToken: token,
    });
  }
  assert.equal(calls.filter((call) => call.name === "create").length, 1);
  const prompts = calls.filter((call) => call.name === "prompt");
  assert.equal(prompts.length, 2);
  assert.equal(prompts[0].args.sessionId, prompts[1].args.sessionId);
  assert.match(
    prompts[1].args.content[0].text,
    /context=synthetic-second-social-capability/,
  );
  assert.doesNotMatch(
    prompts[1].args.content[0].text,
    /synthetic-first-social-capability/,
  );
  assert.match(prompts[1].args.content[0].text, /历史中的context均已失效/);
  assert.equal(
    calls.some((call) => call.name === "drain"),
    false,
  );
  await backend.closeSocialSessions({ windowId: "window-one" });
  assert.equal(calls.filter((call) => call.name === "drain").length, 1);
});

test("DSH desktop invitation and chat share one native session in a desktop workspace", async (t) => {
  const { backend, calls } = dshSocialFixture(t);
  for (const runId of ["invitation", "chat"]) {
    const params = windowParams(runId);
    params.tools[0].function.name = "desktop_room_decide";
    await backend.runDesktop({
      ...params,
      socialContextToken: "synthetic-desktop-capability-" + runId,
    });
  }
  const workspaces = calls.filter(({ name }) => name === "workspace");
  assert.equal(workspaces.length, 1);
  assert.equal(
    path.basename(path.dirname(workspaces[0].args.path)),
    "dsh-desktop-workspaces",
  );
  assert.equal(path.basename(workspaces[0].args.path), "agent-0-desktop");
  const created = calls.filter(({ name }) => name === "create");
  assert.equal(created.length, 1);
  assert.match(created[0].args.sessionId, /^session-/);
  const prompts = calls.filter(({ name }) => name === "prompt");
  assert.equal(prompts.length, 2);
  assert.equal(prompts[0].args.sessionId, prompts[1].args.sessionId);
});

test("Codex window continuation resumes only its own thread and installs the latest tool closure", async (t) => {
  const cfg = config(),
    rpc = new Rpc();
  const backend = new CodexBackend(cfg.backends[0], cfg.agents[0], {
    root: temp(t),
    rpc,
  });
  t.after(() => backend.close());
  const observed = [];
  for (const runId of ["codex-first", "codex-second"]) {
    const params = windowParams(runId);
    params.callTool = async () => {
      observed.push(runId);
      return {};
    };
    const run = backend.runSocial({
      ...params,
      session: { id: "ordinary-chat-session" },
    });
    await tick();
    await backend.request({
      id: runId,
      method: "item/tool/call",
      params: {
        threadId: "isolated-social-thread",
        turnId: "isolated-social-turn",
        tool: "home_social_capabilities",
        arguments: {},
      },
    });
    rpc.emit("notification", {
      method: "turn/completed",
      params: {
        threadId: "isolated-social-thread",
        turn: { id: "isolated-social-turn", status: "completed" },
      },
    });
    await run;
  }
  assert.deepEqual(observed, ["codex-first", "codex-second"]);
  assert.equal(
    rpc.calls.filter((call) => call.method === "thread/start").length,
    1,
  );
  const resumes = rpc.calls.filter((call) => call.method === "thread/resume");
  assert.equal(resumes.length, 1);
  assert.equal(resumes[0].args.threadId, "isolated-social-thread");
  assert.equal(
    rpc.calls.some((call) => call.method === "thread/archive"),
    false,
  );
  await backend.closeSocialSessions({ windowId: "window-one" });
  assert.equal(
    rpc.calls.filter((call) => call.method === "thread/archive").length,
    1,
  );
});

test("Antigravity window continuation resumes its bound native database in a new restricted process", async (t) => {
  const cfg = config(),
    launches = [],
    agentFiles = [];
  const id = "00000000-0000-4000-8000-000000000002";
  const backend = new AntigravityBackend(
    { ...cfg.backends[0], cliReuse: { enabled: true } },
    cfg.agents[0],
    {
      root: temp(t),
      spawn(_command, args, options) {
        launches.push({ args, cwd: options.cwd });
        agentFiles.push(
          fs.readFileSync(
            path.join(options.cwd, ".agents", "agents", "qq-agents.md"),
            "utf8",
          ),
        );
        const child = new EventEmitter();
        child.pid = 10000;
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => true;
        child.stdin = new Writable({
          write(_chunk, _encoding, callback) {
            const dir = path.join(backend.profile, "cli", "conversations");
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(
              path.join(dir, id + ".db"),
              "synthetic continuing transcript",
            );
            child.stdout.write(
              [
                { event: "init", conversation_id: id },
                {
                  event: "step_update",
                  step_update: {
                    conversation_id: id,
                    step_index: launches.length,
                    step_type: "agent_response",
                    state: "DONE",
                  },
                },
                {
                  event: "result",
                  result: { conversation_id: id, status: "SUCCESS" },
                },
              ]
                .map((frame) => JSON.stringify(frame))
                .join("\n") + "\n",
            );
            callback();
            setImmediate(() => child.emit("close", 0, null));
          },
        });
        return child;
      },
      stop() {},
    },
  );
  t.after(() => backend.close());
  await backend.runSocial(windowParams("agy-first"));
  assert.equal(
    fs.existsSync(
      path.join(backend.profile, "cli", "conversations", id + ".db"),
    ),
    true,
  );
  await backend.runSocial({
    ...windowParams("agy-second"),
    instructions: "must not replace the window identity",
  });
  assert.equal(launches.length, 2);
  assert.equal(launches[0].cwd, launches[1].cwd);
  assert.equal(launches[0].args.includes("--conversation"), false);
  assert.equal(
    launches[1].args[launches[1].args.indexOf("--conversation") + 1],
    id,
  );
  assert.match(agentFiles[1], /Synthetic identity/);
  assert.doesNotMatch(agentFiles[1], /must not replace the window identity/);
  assert.equal(backend.workers.size, 0);
  await backend.closeSocialSessions({ windowId: "window-one" });
  assert.equal(fs.existsSync(launches[0].cwd), false);
  assert.equal(
    fs.existsSync(
      path.join(backend.profile, "cli", "conversations", id + ".db"),
    ),
    false,
  );
});

test("native capsules reject a changed window fence without replacing the session", async () => {
  let runs = 0,
    disposed = 0;
  const backend = {
    async run(value) {
      runs++;
      if (!value.session) value.saveSession({ id: "fenced-window-session" });
      await value.beforeInputSubmitted();
    },
  };
  const dispose = async () => {
    disposed++;
  };
  const first = windowParams("fence-first");
  first.binding.windowFence = 1;
  await runNativeSocial(backend, first, dispose);
  const next = windowParams("fence-next");
  next.binding.windowFence = 2;
  await assert.rejects(
    runNativeSocial(backend, next, dispose),
    /SOCIAL_TURN_CLOSED/,
  );
  assert.equal(runs, 1);
  assert.equal(disposed, 1);
  assert.equal(backend.socialSessionPool.capsules.size, 0);
});
