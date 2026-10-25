import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fixture, config } from "./helpers.mjs";
import { ExternalTools } from "../src/backends/external.mjs";
import { ContextLifecycle } from "../src/core/lifecycle.mjs";
const chat = "group:20000";
const defer = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};

async function httpFixture(t) {
  let active,
    initialized = 0,
    calls = 0,
    mode = "ok";
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(req.method === "DELETE" ? 200 : 405);
      res.end();
      return;
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const msg = JSON.parse(Buffer.concat(chunks));
    if (
      msg.method !== "initialize" &&
      req.headers["mcp-session-id"] !== active
    ) {
      res.writeHead(404);
      res.end("Session not found");
      return;
    }
    if (msg.method === "notifications/initialized") {
      res.writeHead(202);
      res.end();
      return;
    }
    let result, error;
    if (msg.method === "initialize") {
      active = "session-" + ++initialized;
      res.setHeader("mcp-session-id", active);
      result = {
        protocolVersion: msg.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "local-fixture", version: "1" },
      };
    } else if (msg.method === "tools/list")
      result = { tools: [{ name: "ping", inputSchema: { type: "object" } }] };
    else if (msg.method === "tools/call") {
      calls++;
      if (mode === "http500") {
        res.writeHead(500);
        res.end("temporary error");
        return;
      }
      if (mode === "rpc404")
        error = { code: 404, message: "a tool error, not HTTP" };
      else
        result = {
          content: [{ type: "text", text: "ok" }],
          ...(mode === "tool-error" ? { isError: true } : {}),
        };
    }
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        ...(error ? { error } : { result }),
      }),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const ext = new ExternalTools([
    {
      id: "local",
      transport: "http",
      url: `http://127.0.0.1:${server.address().port}/mcp`,
      allowedTools: ["ping"],
    },
  ]);
  t.after(async () => {
    await ext.close();
    await new Promise((r) => server.close(r));
  });
  return {
    ext,
    expire() {
      active = "expired";
    },
    setMode(m) {
      mode = m;
    },
    stats: () => ({ initialized, calls }),
  };
}

test("N5 HTTP expired session fails once without replay, then next explicit call initializes once", async (t) => {
  const f = await httpFixture(t);
  await Promise.all([
    f.ext.call("local", "ping", {}),
    f.ext.call("local", "ping", {}),
  ]);
  assert.deepEqual(f.stats(), { initialized: 1, calls: 2 });
  f.expire();
  await assert.rejects(f.ext.call("local", "ping", {}), (e) => e.code === 404);
  assert.equal(f.ext.clients.size, 0);
  assert.deepEqual(f.stats(), { initialized: 1, calls: 2 });
  await Promise.all([
    f.ext.call("local", "ping", {}),
    f.ext.call("local", "ping", {}),
  ]);
  assert.deepEqual(f.stats(), { initialized: 2, calls: 4 });
});
test("N5 ordinary tool/RPC/HTTP errors retain healthy HTTP session", async (t) => {
  const f = await httpFixture(t);
  await f.ext.connect("local");
  const entry = f.ext.clients.get("local");
  for (const mode of ["tool-error", "rpc404", "http500"]) {
    f.setMode(mode);
    if (mode === "tool-error")
      assert.equal((await f.ext.call("local", "ping", {})).isError, true);
    else await assert.rejects(f.ext.call("local", "ping", {}));
    assert.equal(f.ext.clients.get("local"), entry);
  }
  f.setMode("ok");
  await f.ext.call("local", "ping", {});
  assert.equal(f.stats().initialized, 1);
});
test("N5 late old-entry close cannot evict a replacement; close blocks concurrent initialization", async (t) => {
  const f = await httpFixture(t);
  const old = await f.ext.connect("local"),
    closing = defer(),
    started = defer(),
    close = old.client.close.bind(old.client);
  old.client.close = async () => {
    started.resolve();
    await closing.promise;
    await close();
  };
  f.expire();
  const failed = assert.rejects(
    f.ext.call("local", "ping", {}),
    (e) => e.code === 404,
  );
  await started.promise;
  await f.ext.call("local", "ping", {});
  const fresh = f.ext.clients.get("local");
  assert.notEqual(fresh, old);
  closing.resolve();
  await failed;
  assert.equal(f.ext.clients.get("local"), fresh);
  const gate = defer(),
    freshClose = fresh.client.close.bind(fresh.client);
  fresh.client.close = async () => {
    await gate.promise;
    await freshClose();
  };
  const shutdown = f.ext.close();
  await assert.rejects(f.ext.connect("local"), /CANCELLED/);
  gate.resolve();
  await shutdown;
  assert.equal(f.ext.clients.size, 0);
  await f.ext.call("local", "ping", {});
  assert.equal(f.stats().initialized, 3);
});

for (const lane of ["chat", "subject", "learner"])
  for (const outcome of ["failed", "cancelled"])
    for (const recovery of ["next-turn", "restart"])
      test(`N3 archive failure ${lane} ${outcome} recovers on ${recovery} without session reuse or delivery replay`, async (t) => {
        const cfg = config(1);
        cfg.agents[0].slang.enabled = true;
        cfg.agents[0].subject.enabled = true;
        const f = fixture(t, { cfg }),
          m = f.store.bind("agent-0"),
          scope =
            lane === "subject"
              ? "@subject"
              : lane === "learner"
                ? "learner:" + chat
                : chat,
          calls = [];
        let late;
        f.runtime.backendFactory = () => ({
          async run(p) {
            calls.push(p.session);
            p.saveSession({ backend: "codex", id: "session-" + calls.length });
            late = p.saveSession;
            if (calls.length === 1) {
              if (outcome === "cancelled")
                for (const c of f.runtime.capabilities.values())
                  c.controller.abort();
              throw Error("synthetic failure");
            }
          },
          async close() {},
        });
        m.setState(chat, { slang: { entries: [], throughSeq: 0 } });
        m.reserveDelivery("unknown", chat, { text: "synthetic" });
        m.completeDelivery("unknown", "unknown");
        const learn = () =>
          f.runtime.learner.learn(f.runtime.agent("agent-0"), chat, [
            { id: "synthetic", body: "sample", seq: 1 },
          ]);
        const run = () =>
          lane === "learner" ? learn() : f.runtime.wake("agent-0", scope);
        f.store.db.exec(
          "CREATE TEMP TRIGGER reject_archive BEFORE INSERT ON session_history BEGIN SELECT RAISE(ABORT,'archive-fault'); END",
        );
        await assert.rejects(run(), /archive-fault/);
        assert.equal(m.identity.list("model_turns")[0].status, "running");
        assert.equal(m.identity.list("session_history").length, 0);
        assert.equal(f.runtime.capabilities.size, 0);
        assert.equal(f.runtime.running.size, 0);
        // Failed recovery must keep the durable marker and must not call the backend.
        if (lane === "learner") await assert.rejects(run());
        else assert.equal((await run()).status, "failed");
        assert.equal(calls.length, 1);
        f.store.db.exec("DROP TRIGGER reject_archive");
        if (recovery === "restart") new ContextLifecycle(f.runtime);
        const oldCallback = late;
        await run();
        assert.equal(calls.length, 2);
        assert(!calls[1]);
        oldCallback({ backend: "codex", id: "session-1" });
        const state = lane === "learner" ? m.state(chat).slang : m.state(scope);
        assert.equal(state.session.id, "session-2");
        new ContextLifecycle(f.runtime);
        assert.equal(
          m.identity
            .list("session_history")
            .filter((x) => x.session.id === "session-1").length,
          1,
        );
        assert.equal(m.delivery("unknown").status, "unknown");
        assert.equal(f.runtime.transports.get("qq-0").sent.length, 0);
      });

test("N3 learner committed progress survives terminal-write failure without repeating successful work", async (t) => {
  const cfg = config(1);
  cfg.agents[0].slang.enabled = true;
  let runs = 0;
  const f = fixture(t, {
      cfg,
      run: async (p) => {
        runs++;
        p.saveSession({ backend: "codex", id: "done" });
      },
    }),
    m = f.store.bind("agent-0");
  m.setState(chat, { slang: { entries: [], throughSeq: 0 } });
  f.store.db.exec(
    "CREATE TEMP TRIGGER reject_terminal BEFORE INSERT ON model_turns WHEN json_extract(new.value,'$.status')='completed' BEGIN SELECT RAISE(ABORT,'terminal-fault'); END",
  );
  const run = () =>
    f.runtime.learner.learn(f.runtime.agent("agent-0"), chat, [
      { id: "event", body: "sample", seq: 1 },
    ]);
  await assert.rejects(run(), /terminal-fault/);
  assert.equal(f.runtime.capabilities.size, 0);
  assert.equal(m.state(chat).slang.throughSeq, 1);
  f.store.db.exec("DROP TRIGGER reject_terminal");
  await run();
  assert.equal(runs, 1);
  assert.equal(m.state(chat).slang.session, null);
  assert.equal(m.identity.list("session_history").length, 1);
});
