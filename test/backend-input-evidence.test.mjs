import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CodexBackend } from "../src/backends/codex.mjs";
import { OpenAIBackend } from "../src/backends/openai.mjs";
import { BackendTurnFailure } from "../src/backends/turn-failure.mjs";
import { createServer } from "../src/server.mjs";
import { toolSpecs } from "../src/tools/specs.mjs";
import { config, fixture, raw, temp, relayEnvironment } from "./helpers.mjs";

const conversation = "group:20000";

function setup(t, run) {
  const cfg = config(1);
  cfg.agents[0].wake = {
    ...cfg.agents[0].wake,
    mentions: false,
    names: false,
    private: false,
    participation: 0,
  };
  const f = fixture(t, { cfg });
  if (run)
    f.runtime.backends.set("agent-0", {
      run,
      close: async () => {},
      cancel: async () => {},
    });
  return { ...f, mem: f.store.bind("agent-0") };
}

async function ingest(f, id, body) {
  await f.runtime.ingest(
    "qq-0",
    raw(id, { message: [{ type: "text", data: { text: body } }] }),
  );
  return f.mem.db
    .prepare("SELECT id, seq FROM events WHERE agent_id=? AND message_id=?")
    .get(f.mem.agentId, String(id));
}

test("opening failure does not consume request or budget facts", async (t) => {
  const attempts = [];
  const f = setup(t, async (params) => {
    assert.match(params.prompt, /synthetic-open/);
    const ctx = [...f.runtime.running.values()][0];
    const opened = {
      before: !!ctx.requestEvents?.has(a.id),
      budgetBefore: f.mem.state(conversation).replyInputSeq ?? 0,
    };
    attempts.push(opened);
    if (attempts.length === 1) throw Error("SYNTHETIC_PRE_SUBMIT_FAILURE");
    await params.onInputSubmitted?.();
    opened.after = !!ctx.requestEvents?.has(a.id);
    opened.budgetAfter = f.mem.state(conversation).replyInputSeq ?? 0;
  });
  const a = await ingest(f, 1, "synthetic-open");
  await f.runtime.wake("agent-0", conversation);
  await f.runtime.wake("agent-0", conversation);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].before, false, "open assembly admitted request");
  assert.equal(attempts[0].budgetBefore, 0, "open assembly consumed budget");
  assert.equal(attempts[1].before, false, "unsubmitted opening escaped epoch");
  assert.equal(attempts[1].after, true, "confirmed redelivery lost authority");
  assert.equal(attempts[1].budgetAfter, a.seq);
});

test("OpenAI same response batch cannot mark unread result, next response can", async (t) => {
  const keyName = "QQ_MESSAGE_PROBE_OPENAI_KEY";
  const previousKey = process.env[keyName];
  process.env[keyName] = "synthetic-probe-key";
  t.after(() => {
    if (previousKey === undefined) delete process.env[keyName];
    else process.env[keyName] = previousKey;
  });
  const calls = [];
  let injected;
  const completion = (message) => Response.json({ choices: [{ message }] });
  const toolCall = (id, name, args) => ({
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  });
  const backend = new OpenAIBackend(
    {
      id: "fixture",
      type: "openai",
      baseUrl: "https://message-probe.invalid/v1",
      apiKeyEnv: keyName,
      model: "fixture-model",
      contextWindow: 128000,
      toolServers: [],
    },
    { id: "agent-0" },
    {
      root: temp(t),
      fetch: async (_url, req) => {
        calls.push(JSON.parse(req.body));
        if (calls.length === 1) {
          injected = await ingest(f, 2, "合成迟到消息");
          return completion({
            tool_calls: [
              toolCall("read", "memory_read", { id: injected.id }),
              toolCall("same-batch", "qq_mark_read", {
                throughSeq: injected.seq,
              }),
            ],
          });
        }
        if (calls.length === 2)
          return completion({
            tool_calls: [
              toolCall("next-batch", "qq_mark_read", {
                throughSeq: injected.seq,
              }),
            ],
          });
        return completion({ content: "done" });
      },
    },
  );
  const f = setup(t, (params) => backend.run(params));
  await ingest(f, 1, "合成开场消息");
  await f.runtime.wake("agent-0", conversation);
  assert.equal(calls.length, 3);
  const result = (request, id) =>
    JSON.parse(
      request.messages.find((message) => message.tool_call_id === id).content,
    );
  assert.equal(result(calls[1], "same-batch").code, "UNSEEN_WATERMARK");
  assert.equal(result(calls[2], "next-batch").readThroughSeq, injected.seq);
});

class SyntheticRpc extends EventEmitter {
  threads = new Map();
  calls = [];
  turn = 0;

  async start() {}

  async request(method, args) {
    this.calls.push({ method, args });
    if (method === "account/read") return { account: { type: "fixture" } };
    if (method === "model/list") return { data: [] };
    if (method === "thread/start") {
      const id = "synthetic-thread-" + (this.threads.size + 1);
      this.threads.set(id, args.dynamicTools);
      return { thread: { id } };
    }
    if (method === "thread/resume" && args.dynamicTools)
      this.threads.set(args.threadId, args.dynamicTools);
    if (method === "turn/start") {
      const id = "synthetic-turn-" + ++this.turn;
      const { threadId } = args;
      this.emit("notification", {
        method: "turn/started",
        params: { threadId, turn: { id } },
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

test("active Codex native registration receives noReply while preserving Self and event", async (t) => {
  const cfg = config(1);
  const f = fixture(t, { cfg });
  const rpc = new SyntheticRpc();
  const backend = new CodexBackend(cfg.backends[0], cfg.agents[0], {
    root: f.root,
    rpc,
  });
  t.after(() => backend.close());
  const mem = f.store.bind("agent-0");
  const event = mem.append({
    dedupe: "synthetic-identity-record",
    connectionId: "qq-0",
    conversation,
    kind: "message.received",
    direction: "in",
    body: "合成连续性记录",
  });

  async function run(tools) {
    const ctx = f.runtime.makeContext("agent-0", conversation);
    const runKey = "agent-0|" + conversation;
    f.runtime.running.set(runKey, ctx);
    try {
      const prepared = f.runtime.contexts.prepare(ctx, backend, [], tools);
      await backend.run({
        ...prepared,
        tools,
        signal: ctx.controller.signal,
        callTool: async () => ({}),
        saveSession: (session) =>
          mem.setState(conversation, { ...mem.state(conversation), session }),
      });
      await f.runtime.contexts.finish(ctx, "completed-no-send", backend);
    } finally {
      f.runtime.running.delete(runKey);
      f.runtime.capabilities.delete(ctx.token);
    }
  }

  const names = ["qq_mark_read"];
  const [old] = toolSpecs(names);
  delete old.inputSchema.properties.noReply;
  await run([old]);
  const originalThread = mem.state(conversation).session.id;
  const originalSelf = mem.identity.current();
  const originalSchema = rpc.threads.get(originalThread)[0].inputSchema;
  assert(!originalSchema.properties.noReply);

  await run(toolSpecs(names));
  const currentThread = mem.state(conversation).session.id;
  const schema = rpc.threads.get(currentThread)[0].inputSchema;
  const noReply = schema.properties.noReply;
  assert(noReply, "native thread still has the old mark_read schema");
  assert(!schema.required.includes("noReply"));
  assert.equal(noReply.maxItems, 50);
  assert.equal(noReply.items.additionalProperties, false);
  assert.deepEqual([...noReply.items.required].sort(), ["id", "version"]);
  assert.deepEqual(mem.identity.current(), originalSelf);
  assert.equal(mem.readRecord({ id: event.id }, conversation).id, event.id);
  const handoffs = mem.identity.list("session_history").length;
  await run(toolSpecs(names));
  assert.equal(mem.state(conversation).session.id, currentThread);
  assert.equal(mem.identity.list("session_history").length, handoffs);
});

test("a delayed prior Codex turn notification cannot confirm an unsent opening", async (t) => {
  const cfg = config(1);
  const f = fixture(t, { cfg });
  const rpc = new SyntheticRpc();
  const backend = new CodexBackend(cfg.backends[0], cfg.agents[0], {
    root: f.root,
    rpc,
  });
  t.after(() => backend.close());
  const tools = toolSpecs(["qq_mark_read"]);
  let session;
  const params = {
    prompt: "合成开场",
    signal: new AbortController().signal,
    tools,
    callTool: async () => ({}),
    saveSession: (value) => (session = value),
  };
  await backend.run(params);
  let admitted = 0;
  await assert.rejects(
    backend.run({
      ...params,
      session,
      onInputSubmitted: () => admitted++,
      beforeInputSubmitted: async () => {
        rpc.emit("notification", {
          method: "turn/started",
          params: { threadId: session.id, turn: { id: "synthetic-turn-1" } },
        });
        throw Error("SYNTHETIC_PRE_SUBMIT_FAILURE");
      },
    }),
    /SYNTHETIC_PRE_SUBMIT_FAILURE/,
  );
  assert.equal(
    rpc.calls.filter(({ method }) => method === "turn/start").length,
    1,
  );
  assert.equal(
    admitted,
    0,
    "old notification admitted an input before turn/start",
  );
});

test("DSH HTTP tools need submission in each epoch and can reread after recovery", async (t) => {
  const adminToken = "synthetic-admin-token";
  let capability, previousSubmission, opening, port, client;
  const results = [];
  const call = async (name, args = {}, direct = false) => {
    const result = direct
      ? await fetch(`http://127.0.0.1:${port}/agent/tools`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-agent-capability": capability,
            "x-agent-output-protocol": "stdio-v1",
            "x-agent-output-request": "1",
          },
          body: JSON.stringify({ name, arguments: args }),
        }).then((response) => response.json())
      : await client.callTool({
          name: "bridge_call",
          arguments: { context: capability, name, arguments: args },
        });
    results.push(JSON.parse(result.content[0].text));
  };
  const f = setup(t, async (params) => {
    if (!params.recovery) {
      capability = /context=([A-Za-z0-9_-]+)/.exec(params.prompt)[1];
      await call("conversation_read", {}, true);
      params.onInputSubmitted();
      await call("conversation_read", {}, true);
      await call("conversation_read");
      previousSubmission = params.onInputSubmitted;
      params.saveSession({
        backend: "dsh",
        id: "synthetic-session",
        signature: "synthetic-contract",
      });
      const failure = new BackendTurnFailure(
        "dsh",
        "MALFORMED_RESPONSE",
        "malformed-response",
        "synthetic-turn",
        true,
      );
      failure.sessionReusable = true;
      throw failure;
    }

    // The old attempt's late submission must not open the replacement epoch.
    previousSubmission();
    await call("conversation_read", {}, true);
    params.onInputSubmitted();
    await call("qq_mark_read", { throughSeq: opening.seq });
    await call("conversation_read");
    await call("qq_mark_read", { throughSeq: opening.seq });
  });
  f.runtime.config.backends[0].type = "dsh";
  const app = createServer({
    runtime: f.runtime,
    token: adminToken,
  });
  port = await app.listen();
  client = new Client({ name: "synthetic", version: "1" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("../src/mcp.mjs", import.meta.url))],
      env: {
        QQ_UNIFIED_URL: `http://127.0.0.1:${port}`,
        ...relayEnvironment(f.root, adminToken),
      },
    }),
  );
  t.after(async () => {
    await client.close();
    await app.close();
  });
  opening = await ingest(f, 1, "合成待处理输入");
  assert.equal(
    (await f.runtime.wake("agent-0", conversation)).status,
    "completed-no-send",
  );
  assert.equal(results.length, 7);
  assert.equal(results[0].code, "BACKEND_INPUT_NOT_SUBMITTED");
  assert.equal(results[1].code, "MCP_RELAY_AUTH_REQUIRED");
  assert.equal(results[2].items[0].id, opening.id);
  assert.equal(results[3].code, "BACKEND_INPUT_NOT_SUBMITTED");
  assert.equal(results[4].code, "UNSEEN_WATERMARK");
  assert.equal(results[5].items[0].id, opening.id);
  assert.equal(results[6].readThroughSeq, opening.seq);
});
