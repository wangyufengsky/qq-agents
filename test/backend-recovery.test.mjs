import test from "node:test";
import assert from "node:assert/strict";
import { fixture, config } from "./helpers.mjs";
import { createServer } from "../src/server.mjs";

async function setup(t, live = true) {
  const cfg = config(2);
  cfg.backends.push({ ...cfg.backends[0], id: "other" });
  cfg.agents[1].backendId = "other";
  const f = fixture(t, { cfg });
  const app = createServer({
    runtime: f.runtime,
    token: "test-admin",
    allowLive: live,
  });
  const port = await app.listen();
  t.after(() => app.close());
  const request = async (body, auth = true) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/backend`, {
      method: "POST",
      headers: {
        ...(auth ? { "x-admin-token": "test-admin" } : {}),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return { status: r.status, value: await r.json() };
  };
  return { ...f, request };
}
test("admin recovery replaces only the selected backend and preserves QQ and stored sessions", async (t) => {
  const f = await setup(t),
    transports = [...f.runtime.transports.values()];
  let created = 0,
    closed = 0;
  const old = {
    close: async () => {
      closed++;
    },
    cancel: async () => {},
  };
  const other = { close: async () => assert.fail("unrelated backend closed") };
  f.runtime.backends.set("agent-0", old);
  f.runtime.backends.set("agent-1", other);
  t.after(() => f.runtime.backends.delete("agent-1"));
  const mem = f.store.bind("agent-0");
  mem.setState("group:20000", {
    session: { id: "saved-session", backend: "codex" },
    readThroughSeq: 42,
  });
  f.runtime.backendFactory = () => {
    created++;
    return {
      models: async () => [{ model: "fixture-model" }],
      close: async () => {},
      cancel: async () => {},
    };
  };
  const r = await f.request({ id: "fixture", action: "recover" });
  assert.equal(r.status, 200);
  assert.equal(r.value.state, "ready");
  assert.equal(created, 1);
  assert.equal(closed, 1);
  assert.equal(f.runtime.backends.get("agent-1"), other);
  assert.deepEqual([...f.runtime.transports.values()], transports);
  assert(transports.every((x) => x.connected));
  assert.equal(mem.state("group:20000").session.id, "saved-session");
  assert.equal(mem.state("group:20000").readThroughSeq, 42);
  assert(transports.every((x) => x.sent.length === 0));
  assert.equal(
    f.runtime.status().backends.find((x) => x.id === "fixture").state,
    "ready",
  );
});
test("backend recovery is admin-only and unavailable to an isolated listener", async (t) => {
  const f = await setup(t, false);
  assert.equal(
    (await f.request({ id: "fixture", action: "recover" }, false)).status,
    401,
  );
  const r = await f.request({ id: "fixture", action: "recover" });
  assert.equal(r.status, 400);
  assert.equal(r.value.error, "ISOLATED_MODE");
});

test("recovery drains only affected turns without cancelling sessions or replaying prompts", async (t) => {
  const f = await setup(t);
  let runs = 0,
    newRuns = 0;
  const finishes = [];
  f.runtime.backendFactory = () => ({
    models: async () => [],
    close: async () => {},
    cancel: async () => {},
    run: async ({ signal, saveSession, onUsage }) => {
      runs++;
      saveSession({ backend: "codex", id: "preserved-" + runs });
      onUsage({
        source: "measured",
        contextTokens: 1000,
        capacityTokens: 1000000,
      });
      await new Promise((resolve) => {
        finishes.push(resolve);
        signal.addEventListener("abort", resolve, { once: true });
      });
    },
  });
  const first = f.runtime.wake("agent-0", "group:20000"),
    other = f.runtime.wake("agent-1", "group:20000");
  await new Promise((r) => setImmediate(r));
  const otherBackend = f.runtime.backends.get("agent-1");
  f.runtime.backendFactory = () => ({
    models: async () => [],
    close: async () => {},
    run: async () => {
      newRuns++;
    },
  });
  const recovery = f.runtime.backendConnections.recover("fixture");
  await new Promise((r) => setImmediate(r));
  const ctx = f.runtime.running.get("agent-0|group:20000");
  assert.equal(ctx.controller.signal.aborted, false);
  f.runtime.assertActive(ctx);
  assert.throws(
    () => f.runtime.makeContext("agent-0", "private:30000"),
    /BACKEND_UNAVAILABLE/,
  );
  assert.equal(f.runtime.backends.get("agent-0").run !== undefined, true);
  finishes[0]();
  const result = await recovery;
  assert.equal(result.state, "ready");
  await first;
  assert.equal(runs, 2);
  assert.equal(newRuns, 0);
  assert.equal(f.runtime.backends.get("agent-1"), otherBackend);
  assert.equal(f.runtime.running.size, 1);
  assert.equal(f.runtime.status().agents[0].error, null);
  assert.equal(
    f.store.bind("agent-0").identity.list("model_turns")[0].status,
    "completed-no-send",
  );
  assert.equal(
    f.store.bind("agent-0").state("group:20000").session.id,
    "preserved-1",
  );
  assert.equal(
    f.store.bind("agent-0").identity.list("session_history").length,
    0,
  );
  assert(
    [...f.runtime.transports.values()].every(
      (x) => x.connected && x.sent.length === 0,
    ),
  );
  await f.runtime.cancel("agent-1");
  await other;
});
test("simultaneous recovery joins one operation; settings and config changes cannot race it", async (t) => {
  const f = await setup(t);
  let finish,
    created = 0;
  f.runtime.backendFactory = () => {
    created++;
    return {
      close: async () => {},
      models: () =>
        new Promise((r) => {
          finish = r;
        }),
    };
  };
  const one = f.runtime.backendConnections.handle({
    id: "fixture",
    action: "recover",
  });
  const two = f.runtime.backendConnections.handle({
    id: "fixture",
    action: "recover",
  });
  await new Promise((r) => setImmediate(r));
  await assert.rejects(
    f.runtime.wake("agent-0", "group:20000"),
    /AGENT_PAUSED/,
  );
  const edited = structuredClone(f.runtime.config);
  edited.agents[0].name = "changed";
  await assert.rejects(
    f.runtime.changeConfig(edited, f.configStore.revision),
    /BACKEND_OPERATION_IN_PROGRESS/,
  );
  const rates = structuredClone(f.runtime.config);
  rates.agents[0].wake.participation = 0.4;
  assert.equal(
    (await f.runtime.changeConfig(rates, f.configStore.revision))
      .reconnectRequired,
    false,
  );
  await assert.rejects(
    f.runtime.backendConnections.handle({
      id: "fixture",
      action: "settings",
      autoReconnect: true,
    }),
    /BACKEND_OPERATION_IN_PROGRESS/,
  );
  finish([]);
  await Promise.all([one, two]);
  assert.equal(created, 1);
});
test("automatic recovery is bounded, respects pause, and does not run a model turn", async (t) => {
  const f = await setup(t);
  let now = 100000,
    created = 0;
  f.runtime.clock = () => new Date(now);
  f.runtime.backendFactory = () => {
    created++;
    return {
      models: async () => {
        throw Error("CODEX_NOT_CONNECTED");
      },
      close: async () => {},
      run: async () => assert.fail("replayed model turn"),
    };
  };
  const manager = f.runtime.backendConnections;
  await manager.handle({
    id: "fixture",
    action: "settings",
    autoReconnect: true,
  });
  const tick = async () => {
    manager.tick();
    await Promise.all([...f.runtime.jobs]);
  };
  await tick();
  assert.equal(created, 1);
  await f.runtime.pause("all", true);
  now += 60000;
  await tick();
  assert.equal(created, 1);
  await f.runtime.pause("all", false);
  for (let i = 0; i < 5; i++) {
    now += 60000;
    await tick();
  }
  assert.equal(created, 4);
  assert.equal(manager.snapshot("fixture").attempts, 3);
  assert.equal(manager.snapshot("fixture").state, "disconnected");
  await manager.handle({
    id: "fixture",
    action: "settings",
    autoReconnect: false,
  });
  now += 60000;
  await tick();
  assert.equal(created, 4);
  const { ConfigStore } = await import("../src/core/config.mjs");
  assert.equal(
    new ConfigStore(f.configStore.file).value.backends[0].recovery
      .autoReconnect,
    false,
  );
});
test("login failure is distinct and is not repeatedly restarted", async (t) => {
  const f = await setup(t);
  let created = 0;
  f.runtime.backendFactory = () => {
    created++;
    return {
      models: async () => {
        throw Error("CODEX_DEDICATED_LOGIN_REQUIRED");
      },
      close: async () => {},
    };
  };
  const m = f.runtime.backendConnections;
  await m.handle({ id: "fixture", action: "settings", autoReconnect: true });
  const result = await m.check("fixture");
  assert.equal(result.state, "login-required");
  for (let i = 0; i < 5; i++) {
    m.tick();
    await Promise.all([...f.runtime.jobs]);
  }
  assert.equal(created, 1);
});
test("DSH ambiguity and stale selection leave live connections and sessions untouched", async (t) => {
  const f = await setup(t),
    manager = f.runtime.backendConnections;
  f.runtime.config.backends[0].type = "dsh";
  f.runtime.config.backends[0].baseUrl = "http://127.0.0.1:9000";
  const old = {
    close: async () => assert.fail("closed before selecting instance"),
  };
  f.runtime.backends.set("agent-0", old);
  t.after(() => f.runtime.backends.delete("agent-0"));
  manager.discover = async () => [
    { id: "relay:web", url: "http://127.0.0.1:9001", followsRestart: true },
    { id: "endpoint:http://127.0.0.1:9002", url: "http://127.0.0.1:9002" },
  ];
  assert.equal(
    (await manager.handle({ id: "fixture", action: "recover" })).state,
    "selection-required",
  );
  assert.equal(
    (
      await manager.handle({
        id: "fixture",
        action: "recover",
        candidateId: "forged",
      })
    ).error,
    "DSH_INSTANCE_UNAVAILABLE",
  );
  assert.equal(f.runtime.backends.get("agent-0"), old);
  f.runtime.backends.delete("agent-0");
  f.runtime.backendFactory = (config) => ({
    models: async () => {
      assert.equal(config.recovery.dshInstance, "relay:web");
      return [];
    },
    close: async () => {},
  });
  assert.equal(
    (
      await manager.handle({
        id: "fixture",
        action: "recover",
        candidateId: "relay:web",
      })
    ).state,
    "ready",
  );
  assert.equal(
    f.configStore.value.backends[0].recovery.dshInstance,
    "relay:web",
  );
  assert.equal(f.configStore.value.backends[0].baseUrl, undefined);
});

test("automatic DSH discovery cannot interrupt a turn that starts while discovery is pending", async (t) => {
  const f = await setup(t),
    m = f.runtime.backendConnections;
  f.runtime.config.backends[0].type = "dsh";
  let resolveDiscovery,
    closed = 0;
  m.discover = () =>
    new Promise((resolve) => {
      resolveDiscovery = resolve;
    });
  f.runtime.backendFactory = () => ({
    close: async () => {
      closed++;
    },
    cancel: async () => {},
    models: async () => [],
    run: ({ signal }) =>
      new Promise((resolve) =>
        signal.addEventListener("abort", resolve, { once: true }),
      ),
  });
  m.state("fixture").attempts = 1;
  const recovery = m.recover("fixture", { automatic: true });
  await new Promise((r) => setImmediate(r));
  const turn = f.runtime.wake("agent-0", "group:20000");
  await new Promise((r) => setImmediate(r));
  resolveDiscovery([
    { id: "relay:web", url: "http://127.0.0.1:9001", followsRestart: true },
  ]);
  await recovery;
  assert.equal(closed, 0);
  assert.equal(f.runtime.running.size, 1);
  await f.runtime.cancel("agent-0");
  await turn;
});

test("a completed Codex session is resumed on the next real wake after recovery", async (t) => {
  const f = await setup(t),
    sessions = [];
  // This tests session continuity, independently of estimated capacity guards.
  f.runtime.agent("agent-0").contextPolicy.capacityTokens = 65536;
  f.runtime.backendFactory = () => ({
    models: async () => [{ model: "fixture" }],
    close: async () => {},
    run: async ({ session, saveSession }) => {
      sessions.push(session);
      saveSession({ id: "reusable-session", backend: "codex" });
    },
  });
  await f.runtime.wake("agent-0", "group:20000");
  await f.runtime.backendConnections.handle({
    id: "fixture",
    action: "recover",
  });
  assert.equal(sessions.length, 1);
  await f.runtime.wake("agent-0", "group:20000");
  assert.equal(sessions[1].id, "reusable-session");
  assert.equal(f.runtime.transports.get("qq-0").sent.length, 0);
});

test("pausing during automatic discovery prevents subsequent backend replacement", async (t) => {
  const f = await setup(t),
    m = f.runtime.backendConnections;
  f.runtime.config.backends[0].type = "dsh";
  let resolveDiscovery,
    created = 0;
  m.discover = () =>
    new Promise((resolve) => {
      resolveDiscovery = resolve;
    });
  f.runtime.backendFactory = () => {
    created++;
    return { models: async () => [], close: async () => {} };
  };
  const pending = m.recover("fixture", { automatic: true });
  await new Promise((r) => setImmediate(r));
  await f.runtime.pause("all", true);
  resolveDiscovery([
    { id: "relay:web", url: "http://127.0.0.1:9001", followsRestart: true },
  ]);
  await pending;
  assert.equal(created, 0);
  assert.equal(f.runtime.config.globalPaused, true);
});

for (const mode of ["timeout", "pause", "shutdown"])
  test(`manual recovery ${mode} preserves its drain boundary`, async (t) => {
    const f = await setup(t),
      r = f.runtime;
    let release,
      closed = 0;
    r.backendFactory = () => ({
      models: async () => [],
      close: async () => {
        closed++;
      },
      run: async ({ signal, saveSession, onInputSubmitted, onUsage }) => {
        saveSession({ backend: "codex", id: "drain-boundary" });
        onInputSubmitted();
        onUsage({
          source: "measured",
          contextTokens: 1000,
          capacityTokens: 1000000,
        });
        await new Promise((resolve) => {
          release = resolve;
          signal.addEventListener("abort", resolve, { once: true });
        });
      },
    });
    const job = r.wake("agent-0", "group:20000");
    await new Promise((resolve) => setImmediate(resolve));
    const context = r.running.get("agent-0|group:20000"),
      original = r.backends.get("agent-0");
    const pending = r.backendConnections.recover("fixture");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(r.backendConnections.snapshot("fixture").waitingForTurns, 1);
    assert.equal(context.controller.signal.aborted, false);
    assert.equal(closed, 0);
    if (mode === "timeout") {
      r.backendConnections.state("fixture").drainDeadline = 0;
      assert.equal((await pending).error, "BACKEND_DRAIN_TIMEOUT");
      assert.equal(r.backends.get("agent-0"), original);
      assert.equal(context.controller.signal.aborted, false);
      assert.equal(closed, 0);
      release();
      await job;
      assert.equal(
        f.store.bind("agent-0").state("group:20000").session.id,
        "drain-boundary",
      );
    } else if (mode === "pause") {
      await r.pause("agent-0", true);
      await job;
      await pending;
      assert.equal(r.agent("agent-0").paused, true);
      const retired = f.store.bind("agent-0").identity.list("session_history");
      assert.equal(retired[0].details.source, "agent-pause");
      assert.equal(retired[0].details.inputStage, "submission-attempted");
    } else {
      await r.close();
      await job;
      assert.equal((await pending).error, "BACKEND_RECOVERY_FAILED");
      assert.equal(closed, 1);
    }
    assert.equal(r.backendConnections.blocked.size, 0);
    assert.equal(r.backendConnections.drainingContexts.size, 0);
  });

test("manual recovery waits for finalization after the model capability is gone", async (t) => {
  const f = await setup(t),
    r = f.runtime;
  let release,
    entered,
    closed = 0;
  const ready = new Promise((resolve) => (entered = resolve)),
    gate = new Promise((resolve) => (release = resolve));
  r.backendFactory = () => ({
    models: async () => [],
    close: async () => {
      closed++;
    },
    run: async (p) => {
      p.saveSession({ backend: "codex", id: "finalizing-session" });
      p.onUsage({
        source: "measured",
        contextTokens: 1000,
        capacityTokens: 1000000,
      });
    },
  });
  const finish = r.contexts.finish.bind(r.contexts);
  r.contexts.finish = async (...args) => {
    entered();
    await gate;
    return finish(...args);
  };
  const job = r.wake("agent-0", "group:20000");
  await ready;
  assert.equal(r.capabilities.size, 0);
  assert.equal(r.running.size, 1);
  const recovery = r.backendConnections.recover("fixture");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, 0);
  assert.equal(r.backendConnections.snapshot("fixture").waitingForTurns, 1);
  release();
  await job;
  await recovery;
  assert.equal(closed, 1);
  assert.equal(
    f.store.bind("agent-0").state("group:20000").session.id,
    "finalizing-session",
  );
});
