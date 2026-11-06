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

test("Antigravity social bypasses reusable workers, exposes no file tool, and removes native transcripts", async (t) => {
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
  assert.doesNotMatch(agent, /^ {2}- view_file$/m);
  assert.deepEqual(settings.permissions.allow, [
    "mcp(qq-agents/home_social_capabilities)",
  ]);
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
      create: async () =>
        ok({ workspace: { workspaceId: "social-workspace" } }),
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
