import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { fixture, config, FakeTransport } from "./helpers.mjs";
import { createServer } from "../src/server.mjs";
import { Lifecycle } from "../src/transport/lifecycle.mjs";

test("shutdown waits for an in-flight HTTP tool receipt after its model turn cancels", async (t) => {
  const f = fixture(t, {
    cfg: config(1),
    run: ({ signal }) =>
      new Promise((resolve) =>
        signal.addEventListener("abort", resolve, { once: true }),
      ),
  });
  const app = createServer({ runtime: f.runtime, token: "synthetic-admin" });
  const port = await app.listen();
  t.after(() => app.close());
  f.runtime.conversations.request("agent-0", "group:20000", "message", {
    immediate: true,
  });
  const ctx = [...f.runtime.running.values()][0];
  const started = Promise.withResolvers();
  const receipt = Promise.withResolvers();
  f.runtime.transports.get("qq-0").send = async () => {
    started.resolve();
    await receipt.promise;
    return { messageId: "synthetic-confirmed-receipt" };
  };
  const request = fetch(`http://127.0.0.1:${port}/agent/tools`, {
    method: "POST",
    headers: {
      "x-agent-capability": ctx.token,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name: "qq_send",
      arguments: { requestId: "shutdown-receipt", text: "synthetic" },
    }),
  })
    .then((response) => response.json())
    .catch(() => null);
  await started.promise;
  let closed = false;
  const shutdown = f.runtime.close().then(() => {
    closed = true;
  });
  try {
    await delay(20);
    assert.equal(
      closed,
      false,
      "database owner must not observe a completed close before the receipt",
    );
    assert.throws(() => f.runtime.capability(ctx.token), /INVALID_CAPABILITY/);
  } finally {
    receipt.resolve();
    await request;
    await shutdown;
  }
  assert.equal(
    f.store.bind("agent-0").delivery("shutdown-receipt").status,
    "sent",
  );
  assert.equal(f.runtime.status().agents[0].activeTurns, 0);
});

test("shutdown rejects queued sends and preserves an unknown result for the already issued request", async (t) => {
  const f = fixture(t, { cfg: config(1) });
  const ctx = f.runtime.makeContext("agent-0", "group:20000");
  const receipt = Promise.withResolvers();
  let sends = 0;
  f.runtime.transports.get("qq-0").send = async () => {
    sends++;
    await receipt.promise;
    throw Error("synthetic missing gateway receipt");
  };
  const first = assert.rejects(
    f.runtime.callTool(ctx, "qq_send", {
      requestId: "issued",
      text: "synthetic first",
    }),
    /DELIVERY_UNKNOWN/,
  );
  const second = assert.rejects(
    f.runtime.callTool(ctx, "qq_send", {
      requestId: "queued",
      text: "synthetic second",
    }),
    /AGENT_PAUSED_OR_EXPIRED/,
  );
  const closing = f.runtime.close();
  receipt.resolve();
  await Promise.all([first, second, closing]);
  assert.equal(sends, 1);
  assert.equal(f.store.bind("agent-0").delivery("issued").status, "unknown");
  assert.equal(f.store.bind("agent-0").delivery("queued"), undefined);
});

test("direct turns and owner contexts finish before an idempotent shutdown completes", async (t) => {
  const turn = Promise.withResolvers();
  const owner = Promise.withResolvers();
  const f = fixture(t, { cfg: config(1), run: () => turn.promise });
  const running = f.runtime.wake("agent-0", "group:20000");
  const control = f.runtime.withContext(
    "agent-0",
    "private:30000",
    async () => {
      await owner.promise;
      return f.store
        .bind("agent-0")
        .diaryWrite({ title: "completed", body: "synthetic owner operation" });
    },
  );
  let closed = false;
  const first = f.runtime.close();
  const second = f.runtime.close();
  first.then(() => {
    closed = true;
  });
  try {
    await delay(20);
    assert.equal(closed, false);
    assert.equal(first, second);
  } finally {
    turn.resolve();
    owner.resolve();
    await Promise.all([running, control, first, second]);
  }
  assert.equal(f.runtime.status().agents[0].activeTurns, 0);
});

test("a transport cleanup failure still drains work and reports an unsuccessful shutdown", async (t) => {
  const f = fixture(t, { cfg: config(1) });
  f.runtime.transports.get("qq-0").close = () => {
    throw Error("synthetic transport close failure");
  };
  const pending = Promise.withResolvers();
  const task = f.runtime.withContext(
    "agent-0",
    "private:30000",
    () => pending.promise,
  );
  const closing = f.runtime.close();
  pending.resolve();
  const result = await closing;
  await task;
  assert.equal(result.ok, false);
  assert.equal(result.failures, 1);
  assert.equal(f.runtime.status().recentErrors.at(0).component, "shutdown");
});

test("late backend callbacks cannot access memory after shutdown has completed", async (t) => {
  let callbacks;
  const f = fixture(t, {
    cfg: config(1),
    run: async (p) => {
      callbacks = p;
    },
  });
  await f.runtime.wake("agent-0", "group:20000");
  await f.runtime.close();
  const prepare = t.mock.method(f.store.db, "prepare", () => {
    throw Error("database is already closed");
  });
  try {
    assert.doesNotThrow(() =>
      callbacks.saveSession({ backend: "codex", id: "late" }),
    );
    assert.doesNotThrow(() => callbacks.onBackendTurn({ id: "late" }));
    assert.doesNotThrow(() => callbacks.onUsage({ contextTokens: 42 }));
    assert.doesNotThrow(() => callbacks.onImageSession("late"));
    assert.doesNotThrow(() => callbacks.onGeneratedImage("late", {}));
    assert.throws(
      () => f.runtime.makeContext("agent-0", "group:20000"),
      /RUNTIME_CLOSING/,
    );
  } finally {
    prepare.mock.restore();
  }
});

test("learner and managed process cleanup failures remain visible and other resources still close", async (t) => {
  const f = fixture(t, { cfg: config(1) });
  let siblingClosed = false;
  f.runtime.learner.backends.set("bad", {
    close: async () => {
      throw Error("synthetic");
    },
  });
  f.runtime.learner.backends.set("good", {
    close: async () => {
      siblingClosed = true;
    },
  });
  const manager = new Lifecycle(f.root, {
    execCommand: async () => {
      throw Error("synthetic");
    },
  });
  manager.owned.set("synthetic", {
    type: "docker",
    config: { id: "synthetic", container: "synthetic" },
  });
  f.runtime.lifecycle = manager;
  const result = await f.runtime.close();
  assert.equal(result.ok, false);
  assert.equal(result.failures, 2);
  assert.equal(siblingClosed, true);
  assert.equal(f.runtime.transports.get("qq-0").connected, false);
});

test("shutdown cancels an unfinished connection before waiting for its request", async (t) => {
  const f = fixture(t, { cfg: config(1) });
  f.runtime.transports.clear();
  const pending = Promise.withResolvers();
  const transport = new FakeTransport();
  transport.connected = false;
  transport.connect = () => pending.promise;
  transport.close = () => pending.reject(Error("CONNECTION_CANCELLED"));
  f.runtime.transportFactory = () => transport;
  const connecting = assert.rejects(
    f.runtime.startConnection("qq-0"),
    /CONNECTION_CANCELLED/,
  );
  // A connection launched from HTTP remains an active request until connect settles.
  f.runtime.trackWork(connecting);
  try {
    const result = await Promise.race([
      f.runtime.close(),
      delay(100).then(() => {
        throw Error("shutdown did not cancel the handshake");
      }),
    ]);
    assert.equal(result.ok, true);
  } finally {
    pending.reject(Error("CONNECTION_CANCELLED"));
    await connecting;
  }
});
