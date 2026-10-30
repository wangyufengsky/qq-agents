import test from "node:test";
import assert from "node:assert/strict";
import { fixture, config, raw } from "./helpers.mjs";
import { createServer } from "../src/server.mjs";
import { Runtime } from "../src/core/runtime.mjs";
import { waitForDrain } from "../src/updates/drain.mjs";
import { ManagedHost } from "../src/updates/supervisor.mjs";
import {
  attachManagedUpdates,
  updateChannel,
} from "../src/updates/managed-client.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));

function managed(t, runtime) {
  const original = { send: process.send, connected: process.connected };
  const listeners = {
    message: new Set(process.listeners("message")),
    disconnect: new Set(process.listeners("disconnect")),
  };
  const replies = [];
  process.connected = true;
  process.send = (message, callback) => {
    replies.push(message);
    callback?.();
  };
  t.after(() => {
    for (const [event, before] of Object.entries(listeners))
      for (const listener of process.listeners(event))
        if (!before.has(listener)) process.removeListener(event, listener);
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process[key];
      else process[key] = value;
    }
  });
  const stops = [];
  attachManagedUpdates({
    runtime,
    lifecycle: { stop: async () => stops.push(await runtime.close()) },
    installed: {},
    port: 12345,
  });
  const handler = process
    .listeners("message")
    .find((listener) => !listeners.message.has(listener));
  return {
    replies,
    stops,
    command: (action) =>
      handler({ channel: updateChannel, type: "command", id: action, action }),
  };
}

test("managed upgrade waits for the active turn and retains its reusable session", async (t) => {
  const finish = Promise.withResolvers();
  let active;
  const f = fixture(t, {
    cfg: config(1),
    run: async (params) => {
      active = params;
      params.saveSession({ backend: "codex", id: "reusable-session" });
      await Promise.race([
        finish.promise,
        new Promise((_, reject) =>
          params.signal.addEventListener(
            "abort",
            () => reject(Error("ABORTED")),
            {
              once: true,
            },
          ),
        ),
      ]);
      params.onUsage({
        source: "measured",
        contextTokens: 1000,
        capacityTokens: 100000,
      });
    },
  });
  const bridge = managed(t, f.runtime);
  const turn = f.runtime.wake("agent-0", "group:20000");
  const stop = bridge.command("stop");
  try {
    await tick();
    assert.equal(
      active.signal.aborted,
      false,
      "upgrade must not cancel the active turn",
    );
    assert.equal(bridge.stops.length, 0);
    assert.equal(f.runtime.config.globalPaused, false);
  } finally {
    finish.resolve();
    await Promise.all([turn, stop]);
  }
  const memory = f.store.bind("agent-0");
  assert.equal(memory.state("group:20000").session.id, "reusable-session");
  assert.equal(memory.identity.list("session_history").length, 0);
  assert.equal(
    memory.identity.list("model_turns")[0].status,
    "completed-no-send",
  );
  assert.equal(bridge.stops.length, 1);
  assert.equal(f.runtime.config.globalPaused, true);
  const next = new Runtime({
    memory: f.store,
    configStore: f.configStore,
    backendFactory: () => {
      throw Error("NO_MODEL_DURING_RESTART");
    },
  });
  assert.equal(memory.state("group:20000").session.id, "reusable-session");
  assert.equal(memory.identity.list("session_history").length, 0);
  await next.close();
});

test("draining admits existing HTTP tools and receipts, queues new input, and blocks new work and edits", async (t) => {
  const finish = Promise.withResolvers(),
    sending = Promise.withResolvers(),
    receipt = Promise.withResolvers();
  let active;
  const f = fixture(t, {
    cfg: config(1),
    run: async (params) => {
      active = params;
      params.saveSession({ backend: "codex", id: "drained-tools" });
      await finish.promise;
      params.onUsage({
        source: "measured",
        contextTokens: 1000,
        capacityTokens: 100000,
      });
    },
  });
  const app = createServer({ runtime: f.runtime, token: "synthetic-admin" });
  const port = await app.listen();
  t.after(() => app.close());
  const request = async (route, body, capability) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method: "POST",
      headers: capability
        ? { "x-agent-capability": capability }
        : { "x-admin-token": "synthetic-admin" },
      body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  const turn = f.runtime.wake("agent-0", "group:20000");
  const ctx = [...f.runtime.running.values()][0];
  try {
    assert.equal(
      (await request("/api/maintenance", {}, ctx.token)).status,
      401,
    );
    const drain = await request("/api/maintenance", {});
    assert.equal(drain.data.active, true);
    assert.equal(drain.data.pending, 1);
    assert.equal(active.signal.aborted, false);
    assert.equal(
      (await request("/api/pause", { paused: false })).data.error,
      "UPDATE_IN_PROGRESS",
    );
    await assert.rejects(
      f.runtime.wake("agent-0", "private:30000"),
      /AGENT_PAUSED/,
    );
    assert.throws(
      () => f.runtime.makeContext("agent-0", "private:30000"),
      /UPDATE_IN_PROGRESS/,
    );
    await f.runtime.ingest(
      "qq-0",
      raw(999, {
        message: [
          {
            type: "text",
            data: { text: "@角色0 synthetic pending question?" },
          },
        ],
      }),
    );
    const state = f.store.bind("agent-0").state("group:20000");
    assert.ok(state.pendingWakes.length > 0);
    assert.equal(f.runtime.running.size, 1);
    f.runtime.transports.get("qq-0").send = async () => {
      sending.resolve();
      await receipt.promise;
      return { messageId: "drained-receipt" };
    };
    const tool = request(
      "/agent/tools",
      {
        name: "qq_send",
        arguments: { requestId: "drained-delivery", text: "synthetic" },
      },
      ctx.token,
    );
    await sending.promise;
    assert.ok(f.runtime.maintenance.snapshot().pending >= 2);
    receipt.resolve();
    assert.equal((await tool).data.isError, undefined);
    assert.equal(
      f.store.bind("agent-0").delivery("drained-delivery").status,
      "sent",
    );
  } finally {
    receipt.resolve();
    finish.resolve();
    await turn;
  }
  await f.runtime.maintenance.wait();
  assert.equal(f.runtime.maintenance.snapshot().pending, 0);
  assert.equal(f.runtime.running.size, 0);
  assert.ok(
    f.store.bind("agent-0").state("group:20000").pendingWakes.length > 0,
  );
});

test("drain waits for owner work; explicit stop still cancels immediately", async (t) => {
  const finish = Promise.withResolvers(),
    owner = Promise.withResolvers();
  let signal;
  const f = fixture(t, {
    cfg: config(1),
    run: async (p) => {
      signal = p.signal;
      await finish.promise;
    },
  });
  const bridge = managed(t, f.runtime);
  const control = f.runtime.withContext(
    "agent-0",
    "private:30000",
    () => owner.promise,
  );
  const turn = f.runtime.wake("agent-0", "group:20000");
  f.runtime.maintenance.begin();
  assert.equal(f.runtime.maintenance.snapshot().pending, 2);
  const stop = bridge.command("stop-now");
  await tick();
  assert.equal(signal.aborted, true);
  finish.resolve();
  owner.resolve();
  await Promise.all([turn, control, stop]);
});

test("drain timeout never falls through into stopping or discards the active session", async (t) => {
  const finish = Promise.withResolvers();
  const f = fixture(t, {
    cfg: config(1),
    run: async (p) => {
      p.saveSession({ backend: "codex", id: "still-running" });
      await finish.promise;
    },
  });
  const turn = f.runtime.wake("agent-0", "group:20000");
  try {
    f.runtime.maintenance.begin();
    f.runtime.maintenance.deadline = Date.now() - 1;
    await assert.rejects(f.runtime.maintenance.wait(), /UPDATE_DRAIN_TIMEOUT/);
    await assert.rejects(
      waitForDrain(async () => f.runtime.maintenance.snapshot()),
      /UPDATE_DRAIN_TIMEOUT/,
    );
    assert.equal(f.runtime.closed, false);
    assert.equal(
      [...f.runtime.running.values()][0].controller.signal.aborted,
      false,
    );
    assert.equal(
      f.store.bind("agent-0").state("group:20000").session.id,
      "still-running",
    );
  } finally {
    finish.resolve();
    await turn;
  }
});

test("supervisor waits before stop and an explicit shutdown interrupts waiting", async () => {
  const host = new ManagedHost({ root: "synthetic", args: [] }),
    calls = [];
  let polls = 0;
  host.request = async (action) => {
    calls.push(action);
    return action === "drain"
      ? {
          active: true,
          pending: polls++ === 0 ? 1 : 0,
          deadline: Date.now() + 1000,
        }
      : { globalPaused: false, connections: [] };
  };
  host.waitStopped = async () => calls.push("exited");
  await host.stop();
  assert.deepEqual(calls, ["drain", "drain", "stop", "exited"]);
  calls.length = 0;
  const controller = new AbortController();
  host.request = async (action) => {
    calls.push(action);
    controller.abort();
    return { active: true, pending: 1, deadline: Date.now() + 1000 };
  };
  await assert.rejects(host.stop({ signal: controller.signal }), {
    name: "AbortError",
  });
  assert.deepEqual(calls, ["drain"]);
});
