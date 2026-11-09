import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
const repo = fileURLToPath(new URL("..", import.meta.url));
const { fixture, config, raw, relayEnvironment } = await import(
  pathToFileURL(repo + "/test/helpers.mjs")
);
const { createServer } = await import(pathToFileURL(repo + "/src/server.mjs"));

function outputFixture(t, options) {
  // Close resources using the fixture before its database and directory.
  const cleanup = new AsyncDisposableStack();
  t.after(() => cleanup.disposeAsync());
  return { ...fixture({ after: (fn) => cleanup.defer(fn) }, options), cleanup };
}

function spawnFixture(...args) {
  const child = spawn(...args);
  const closed = new Promise((resolve) => child.once("close", resolve));
  return {
    child,
    async close() {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
    },
  };
}

for (const altered of [false, true])
  test(`HTTP final output ${altered ? "missing" : "retains"} original material`, async (t) => {
    const cfg = config(1);
    Object.assign(cfg.agents[0].wake, {
      names: false,
      mentions: false,
      private: false,
      participation: 0,
    });
    const f = outputFixture(t, { cfg });
    const ctx = f.runtime.makeContext("agent-0", "group:20000");
    await f.runtime.ingest(
      "qq-0",
      raw(101, {
        message: [{ type: "text", data: { text: "synthetic final material" } }],
      }),
    );
    const row = f.store.db
      .prepare(
        "SELECT id,seq FROM events WHERE agent_id='agent-0' AND message_id='101'",
      )
      .get();
    const call = f.runtime.callTool.bind(f.runtime);
    if (altered)
      t.mock.method(f.runtime, "callTool", async (...args) => {
        const result = await call(...args);
        if (args[1] === "memory_read")
          Object.defineProperty(result, "toJSON", {
            value: () => ({ truncated: true }),
          });
        return result;
      });
    const app = createServer({ runtime: f.runtime, token: "synthetic-admin" });
    f.cleanup.defer(() => app.close());
    const port = await app.listen();
    const response = await fetch(`http://127.0.0.1:${port}/agent/tools`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agent-capability": ctx.token,
      },
      body: JSON.stringify({ name: "memory_read", arguments: { id: row.id } }),
    });
    const wire = await response.json();
    assert.equal(response.status, 200);
    if (altered) {
      assert(!JSON.stringify(wire).includes("synthetic final material"));
      await assert.rejects(
        () => call(ctx, "qq_mark_read", { throughSeq: row.seq }),
        /UNSEEN_WATERMARK/,
      );
    } else {
      assert(JSON.stringify(wire).includes("synthetic final material"));
      assert.equal(
        (await call(ctx, "qq_mark_read", { throughSeq: row.seq }))
          .readThroughSeq,
        row.seq,
      );
    }
  });

const { EventEmitter } = await import("node:events");
const { CodexBackend } = await import(
  pathToFileURL(repo + "/src/backends/codex.mjs")
);
for (const altered of [false, true])
  test(`Codex dynamic frame ${altered ? "missing" : "retains"} original material`, async (t) => {
    const cfg = config(1);
    Object.assign(cfg.agents[0].wake, {
      names: false,
      mentions: false,
      private: false,
      participation: 0,
    });
    const f = outputFixture(t, { cfg });
    const ctx = f.runtime.makeContext("agent-0", "group:20000");
    await f.runtime.ingest(
      "qq-0",
      raw(102, {
        message: [{ type: "text", data: { text: "synthetic dynamic frame" } }],
      }),
    );
    const row = f.store.db
      .prepare(
        "SELECT id,seq FROM events WHERE agent_id='agent-0' AND message_id='102'",
      )
      .get();
    class Rpc extends EventEmitter {
      frames = [];
      respond(id, wire, callback) {
        this.frames.push(wire);
        callback?.();
      }
      reject() {
        throw Error("unexpected rejection");
      }
      close() {}
    }
    const rpc = new Rpc();
    const backend = new CodexBackend(cfg.backends[0], cfg.agents[0], {
      root: f.root,
      rpc,
    });
    f.cleanup.defer(() => {
      backend.active.clear();
      return backend.close();
    });
    const originalCall = f.runtime.callTool.bind(f.runtime);
    backend.active.set("synthetic-thread", {
      turnId: "synthetic-turn",
      signal: ctx.controller.signal,
      callTool: async (name, args) => {
        const result = await originalCall(ctx, name, args, {
          deferInput: true,
        });
        if (altered)
          Object.defineProperty(result, "toJSON", {
            value: () => ({ truncated: true }),
          });
        return result;
      },
      finalizeToolOutput: (result, options) =>
        f.runtime.finalizeToolOutput(ctx, result, options),
      commitToolOutput: (receipt, text) =>
        f.runtime.commitToolOutput(ctx, receipt, text),
    });
    await backend.request({
      id: 1,
      method: "item/tool/call",
      params: {
        threadId: "synthetic-thread",
        turnId: "synthetic-turn",
        tool: "memory_read",
        arguments: { id: row.id },
      },
    });
    assert.equal(rpc.frames.length, 1);
    if (altered) {
      assert(!JSON.stringify(rpc.frames).includes("synthetic dynamic frame"));
      await assert.rejects(
        () => originalCall(ctx, "qq_mark_read", { throughSeq: row.seq }),
        /UNSEEN_WATERMARK/,
      );
    } else {
      assert(JSON.stringify(rpc.frames).includes("synthetic dynamic frame"));
      assert.equal(
        (await originalCall(ctx, "qq_mark_read", { throughSeq: row.seq }))
          .readThroughSeq,
        row.seq,
      );
    }
  });

const { OpenAIBackend } = await import(
  pathToFileURL(repo + "/src/backends/openai.mjs")
);
for (const altered of [false, true])
  test(`OpenAI next-request text ${altered ? "missing" : "retains"} original material`, async (t) => {
    const cfg = config(1);
    Object.assign(cfg.agents[0].wake, {
      names: false,
      mentions: false,
      private: false,
      participation: 0,
    });
    const f = outputFixture(t, { cfg });
    const key = "QQ_SYNTHETIC_OUTPUT_TEST_KEY";
    const before = process.env[key];
    process.env[key] = "synthetic";
    t.after(() => {
      if (before === undefined) delete process.env[key];
      else process.env[key] = before;
    });
    const bodies = [];
    let row;
    const call = (id, name, args) => ({
      id,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    });
    const backend = new OpenAIBackend(
      {
        id: "synthetic",
        type: "openai",
        baseUrl: "https://synthetic.invalid/v1",
        apiKeyEnv: key,
        model: "synthetic",
        contextWindow: 128000,
        toolServers: [],
      },
      { id: "agent-0" },
      {
        root: f.root,
        fetch: async (_url, req) => {
          bodies.push(JSON.parse(req.body));
          if (bodies.length === 1) {
            await f.runtime.ingest(
              "qq-0",
              raw(103, {
                message: [
                  {
                    type: "text",
                    data: { text: "synthetic openai final text" },
                  },
                ],
              }),
            );
            row = f.store.db
              .prepare(
                "SELECT id,seq FROM events WHERE agent_id='agent-0' AND message_id='103'",
              )
              .get();
            return Response.json({
              choices: [
                {
                  message: {
                    tool_calls: [call("read", "memory_read", { id: row.id })],
                  },
                },
              ],
            });
          }
          if (bodies.length === 2)
            return Response.json({
              choices: [
                {
                  message: {
                    tool_calls: [
                      call("mark", "qq_mark_read", { throughSeq: row.seq }),
                    ],
                  },
                },
              ],
            });
          return Response.json({ choices: [{ message: { content: "done" } }] });
        },
      },
    );
    f.runtime.backends.set("agent-0", {
      run: (params) =>
        backend.run({
          ...params,
          callTool: async (name, args) => {
            const result = await params.callTool(name, args);
            if (altered && name === "memory_read")
              Object.defineProperty(result, "toJSON", {
                value: () => ({ truncated: true }),
              });
            return result;
          },
        }),
      close: () => backend.close(),
      cancel: async () => {},
    });
    await f.runtime.ingest(
      "qq-0",
      raw(100, {
        message: [{ type: "text", data: { text: "synthetic opening" } }],
      }),
    );
    await f.runtime.wake("agent-0", "group:20000");
    assert.equal(bodies.length, 3);
    const read = bodies[1].messages.find((m) => m.tool_call_id === "read");
    const marked = JSON.parse(
      bodies[2].messages.find((m) => m.tool_call_id === "mark").content,
    );
    if (altered) {
      assert(!read.content.includes("synthetic openai final text"));
      assert.equal(marked.code, "UNSEEN_WATERMARK");
    } else {
      assert(read.content.includes("synthetic openai final text"));
      assert.equal(marked.readThroughSeq, row.seq);
    }
  });

test(
  "DSH relay HTTP success cannot substitute for failed stdio output",
  { timeout: 10000 },
  async (t) => {
    const cfg = config(1);
    Object.assign(cfg.agents[0].wake, {
      names: false,
      mentions: false,
      private: false,
      participation: 0,
    });
    const f = outputFixture(t, { cfg });
    const ctx = f.runtime.makeContext("agent-0", "group:20000");
    await f.runtime.ingest(
      "qq-0",
      raw(104, {
        message: [
          { type: "text", data: { text: "synthetic last-hop material" } },
        ],
      }),
    );
    const row = f.store.db
      .prepare(
        "SELECT id,seq FROM events WHERE agent_id='agent-0' AND message_id='104'",
      )
      .get();
    const original = f.runtime.callTool.bind(f.runtime);
    const app = createServer({ runtime: f.runtime, token: "synthetic-admin" });
    f.cleanup.defer(() => app.close());
    const port = await app.listen();
    const inject = `const write=process.stdout.write.bind(process.stdout);
 process.stdout.write=(frame, callback)=>{
  if(JSON.parse(String(frame)).id!==2) return write(frame,callback);
  process.stderr.write("SYNTHETIC_STDOUT_FAILURE\\n");
  queueMicrotask(()=>callback(new Error("SYNTHETIC_STDOUT_FAILURE")));
  return true;
 };`;
    const preload =
      "data:text/javascript;base64," + Buffer.from(inject).toString("base64");
    const relay = spawnFixture(
      process.execPath,
      ["--import", preload, repo + "/src/mcp.mjs"],
      {
        env: {
          ...process.env,
          QQ_UNIFIED_URL: `http://127.0.0.1:${port}`,
          ...relayEnvironment(f.root, "synthetic-admin"),
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    f.cleanup.defer(() => relay.close());
    const { child } = relay;
    const failed = Promise.withResolvers();
    child.stderr.on("data", (chunk) => {
      if (String(chunk).includes("SYNTHETIC_STDOUT_FAILURE")) failed.resolve();
    });
    let buffer = "";
    const initialized = Promise.withResolvers();
    child.stdout.on("data", (data) => {
      buffer += data;
      let split;
      while ((split = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, split);
        buffer = buffer.slice(split + 1);
        const value = JSON.parse(line);
        if (value.id === 1) initialized.resolve(value);
      }
    });
    const send = (value) => child.stdin.write(JSON.stringify(value) + "\n");
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "synthetic", version: "1" },
      },
    });
    assert((await initialized.promise).result);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "bridge_call",
        arguments: {
          context: ctx.token,
          name: "memory_read",
          arguments: { id: row.id },
        },
      },
    });
    await failed.promise;
    await assert.rejects(
      () => original(ctx, "qq_mark_read", { throughSeq: row.seq }),
      /UNSEEN_WATERMARK/,
    );
  },
);

test(
  "DSH relay complete stdio result precedes the next tool decision",
  { timeout: 10000 },
  async (t) => {
    const cfg = config(1);
    Object.assign(cfg.agents[0].wake, {
      names: false,
      mentions: false,
      private: false,
      participation: 0,
    });
    const f = outputFixture(t, { cfg });
    const ctx = f.runtime.makeContext("agent-0", "group:20000");
    await f.runtime.ingest(
      "qq-0",
      raw(105, {
        message: [
          { type: "text", data: { text: "synthetic complete relay material" } },
        ],
      }),
    );
    const row = f.store.db
      .prepare(
        "SELECT id,seq FROM events WHERE agent_id='agent-0' AND message_id='105'",
      )
      .get();
    const app = createServer({ runtime: f.runtime, token: "synthetic-admin" });
    f.cleanup.defer(() => app.close());
    const port = await app.listen();
    const relay = spawnFixture(process.execPath, [repo + "/src/mcp.mjs"], {
      env: {
        ...process.env,
        QQ_UNIFIED_URL: `http://127.0.0.1:${port}`,
        ...relayEnvironment(f.root, "synthetic-admin"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    f.cleanup.defer(() => relay.close());
    const { child } = relay;
    child.stderr.resume();
    let buffer = "";
    const pending = new Map();
    child.stdout.on("data", (data) => {
      buffer += data;
      let split;
      while ((split = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, split);
        buffer = buffer.slice(split + 1);
        const value = JSON.parse(line);
        pending.get(value.id)?.resolve(value);
      }
    });
    const send = (value) => child.stdin.write(JSON.stringify(value) + "\n");
    const ask = (value) => {
      const result = Promise.withResolvers();
      pending.set(value.id, result);
      send(value);
      return result.promise;
    };
    assert(
      (
        await ask({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "synthetic", version: "1" },
          },
        })
      ).result,
    );
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const read = await ask({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "bridge_call",
        arguments: {
          context: ctx.token,
          name: "memory_read",
          arguments: { id: row.id },
        },
      },
    });
    assert(JSON.stringify(read).includes("synthetic complete relay material"));
    const mark = await ask({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "bridge_call",
        arguments: {
          context: ctx.token,
          name: "qq_mark_read",
          arguments: { throughSeq: row.seq },
        },
      },
    });
    assert.equal(
      JSON.parse(mark.result.content[0].text).readThroughSeq,
      row.seq,
    );
  },
);

const { AntigravityBackend } = await import(
  pathToFileURL(repo + "/src/backends/antigravity.mjs")
);
const { AntigravityMedia } = await import(
  pathToFileURL(repo + "/src/backends/antigravity-media.mjs")
);
const { validateConfig } = await import(
  pathToFileURL(repo + "/src/core/config.mjs")
);
for (const reuse of [false, true])
  for (const altered of [false, true, "failure"])
    test(
      `Antigravity ${reuse ? "stream" : "oneshot"} final projection ${altered === "failure" ? "encoding failure" : altered ? "missing" : "retains"} original material`,
      { timeout: 15000 },
      async (t) => {
        const cfg = config(1);
        Object.assign(cfg.agents[0].wake, {
          names: false,
          mentions: false,
          private: false,
          participation: 0,
        });
        const f = outputFixture(t, { cfg });
        const ctx = f.runtime.makeContext("agent-0", "group:20000");
        await f.runtime.ingest(
          "qq-0",
          raw(106, {
            message: [
              {
                type: "text",
                data: { text: "synthetic antigravity material" },
              },
            ],
          }),
        );
        const row = f.store.db
          .prepare(
            "SELECT id,seq FROM events WHERE agent_id='agent-0' AND message_id='106'",
          )
          .get();
        const agy = validateConfig({
          ...cfg,
          backends: [
            {
              id: "fixture",
              label: "Fixture",
              type: "antigravity",
              model: "fixture-model",
              effort: "",
              cliReuse: { enabled: reuse },
            },
          ],
        }).backends[0];
        const output = [];
        const fromTool = AntigravityMedia.prototype.fromTool;
        t.mock.method(
          AntigravityMedia.prototype,
          "fromTool",
          async function (...args) {
            const value = await fromTool.apply(this, args);
            output.push(value);
            return value;
          },
        );
        const children = [];
        const backend = new AntigravityBackend(agy, cfg.agents[0], {
          root: f.root,
          spawn: (_command, args, options) => {
            const fixture = spawnFixture(
              process.execPath,
              [
                repo +
                  (reuse
                    ? "/test/antigravity-stream-fixture.mjs"
                    : "/test/antigravity-fixture.mjs"),
                ...args,
              ],
              {
                ...options,
                env: {
                  ...options.env,
                  AGY_FIXTURE_MODE: "success",
                  AGY_STREAM_FIXTURE_LOG: f.root + "/stream.jsonl",
                  AGY_STREAM_FIXTURE_CONTROL: f.root + "/control.json",
                },
              },
            );
            children.push(fixture);
            return fixture.child;
          },
        });
        f.cleanup.defer(async () => {
          try {
            await backend.close();
          } finally {
            // The backend stops its workers, but the test owns their process lifetime.
            await Promise.all(children.map((child) => child.close()));
          }
        });
        await backend.run({
          conversation: "group:20000",
          prompt: "synthetic prompt",
          instructions: "synthetic role",
          tools: [
            {
              name: "probe",
              description: "synthetic",
              inputSchema: { type: "object", properties: {} },
            },
          ],
          signal: ctx.controller.signal,
          saveSession: () => {},
          callTool: async () => {
            const result = await f.runtime.callTool(
              ctx,
              "memory_read",
              { id: row.id },
              { deferInput: true },
            );
            if (altered)
              Object.defineProperty(result, "toJSON", {
                value: () => ({ truncated: true }),
              });
            return result;
          },
          finalizeToolOutput: (result, options) => {
            if (altered === "failure") throw Error("TOOL_OUTPUT_INCOMPLETE");
            return f.runtime.finalizeToolOutput(ctx, result, options);
          },
          commitToolOutput: (receipt, text) =>
            f.runtime.commitToolOutput(ctx, receipt, text),
        });
        if (!reuse) assert.equal(children[0].child.exitCode, 0);
        assert.equal(output.length, altered === "failure" ? 0 : 1);
        if (altered) {
          assert(
            !JSON.stringify(output).includes("synthetic antigravity material"),
          );
          await assert.rejects(
            () =>
              f.runtime.callTool(ctx, "qq_mark_read", { throughSeq: row.seq }),
            /UNSEEN_WATERMARK/,
          );
        } else {
          assert(
            JSON.stringify(output).includes("synthetic antigravity material"),
          );
          assert.equal(
            (
              await f.runtime.callTool(ctx, "qq_mark_read", {
                throughSeq: row.seq,
              })
            ).readThroughSeq,
            row.seq,
          );
        }
      },
    );

const { assertInputReviewed } = await import(
  pathToFileURL(repo + "/src/core/input-review.mjs")
);
for (const kind of ["codex", "openai"])
  test(`${kind} non-draft review preserves expanded error code, material and grant`, async (t) => {
    const cfg = config(1);
    Object.assign(cfg.agents[0].wake, {
      names: false,
      mentions: false,
      private: false,
      participation: 0,
    });
    const f = outputFixture(t, { cfg });
    const ctx = f.runtime.makeContext("agent-0", "group:20000");
    await f.runtime.ingest(
      "qq-0",
      raw(108, {
        message: [{ type: "text", data: { text: "synthetic legacy review" } }],
      }),
    );
    const attempt = (review) =>
      assertInputReviewed(
        f.runtime,
        ctx,
        "legacy-request",
        { action: "poke" },
        review,
      );
    const callbacks = {
      finalizeToolOutput: (original, options) =>
        f.runtime.finalizeToolOutput(ctx, original, options),
      commitToolOutput: (receipt, text) =>
        f.runtime.commitToolOutput(ctx, receipt, text),
    };
    let actual;
    if (kind === "codex") {
      class Rpc extends EventEmitter {
        respond(id, result, callback) {
          actual = JSON.parse(result.contentItems[0].text);
          assert.equal(result.success, false);
          callback();
        }
        reject() {
          throw Error("unexpected rejection");
        }
        close() {}
      }
      const backend = new CodexBackend(cfg.backends[0], cfg.agents[0], {
        root: f.root,
        rpc: new Rpc(),
      });
      f.cleanup.defer(() => {
        backend.active.clear();
        return backend.close();
      });
      backend.active.set("thread", {
        turnId: "turn",
        signal: ctx.controller.signal,
        callTool: async () => attempt(),
        ...callbacks,
      });
      await backend.request({
        id: 1,
        method: "item/tool/call",
        params: {
          threadId: "thread",
          turnId: "turn",
          tool: "synthetic-poke",
          arguments: {},
        },
      });
    } else {
      const backend = new OpenAIBackend(
        { ...cfg.backends[0], vision: false },
        cfg.agents[0],
        { root: f.root },
      );
      f.cleanup.defer(() => backend.close());
      const answer = await backend.toolMessages(
        { id: "call", function: { name: "synthetic-poke", arguments: "{}" } },
        async () => attempt(),
        ctx.controller.signal,
        callbacks.finalizeToolOutput,
      );
      actual = JSON.parse(answer.tool.content);
      assert.throws(
        () =>
          attempt({ token: actual.inputReview.token, decision: "continue" }),
        /INPUT_REVIEW_REQUIRED/,
      );
      callbacks.commitToolOutput(answer.receipt, answer.tool.content);
    }
    assert.equal(actual.code, "INPUT_REVIEW_REQUIRED");
    assert(
      actual.inputReview.items.some(
        (item) => item.body === "synthetic legacy review",
      ),
    );
    assert(actual.inputReview.token);
    assert.doesNotThrow(() =>
      attempt({ token: actual.inputReview.token, decision: "continue" }),
    );
  });
