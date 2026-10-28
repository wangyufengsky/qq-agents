import test from "node:test";
import assert from "node:assert/strict";
import { AutoResume } from "../src/core/auto-resume.mjs";
import { config, fixture, FakeTransport } from "./helpers.mjs";

function setup(t, { edit = () => {}, failures = 0, backend = true } = {}) {
  const cfg = config(2);
  cfg.globalPaused = true;
  cfg.agents[1].paused = true;
  edit(cfg);
  const f = fixture(t, { cfg });
  f.runtime.transports.clear();
  let left = failures;
  f.runtime.transportFactory = () => {
    const transport = new FakeTransport();
    transport.connected = false;
    transport.connect = async () => {
      if (left-- > 0) throw Error("QQ_OFFLINE");
      transport.connected = true;
    };
    return transport;
  };
  const probed = [];
  f.runtime.backendFactory = (_config, agent) => ({
    run: async () => {},
    models: async () => {
      probed.push(agent.id);
      if (!backend || agent.paused) throw Error("BACKEND_PROBE_FAILED");
      return [{ id: "fixture-model" }];
    },
    cancel: async () => {},
    close: async () => {},
  });
  const waits = [];
  const resume = (options = {}) =>
    (f.runtime.autoResume = new AutoResume(f.runtime, {
      enabled: true,
      wait: async (ms) => waits.push(ms),
      ...options,
    }));
  return { ...f, waits, resume, probed };
}

test("auto-resume connects QQ, checks backends and lifts only the global pause", async (t) => {
  const { runtime, resume } = setup(t);
  const result = await resume().run();
  assert.equal(result.state, "resumed");
  assert.equal(result.attempts, 1);
  assert.equal(runtime.config.globalPaused, false);
  assert.equal(runtime.config.agents[1].paused, true, "agent pause is kept");
  for (const c of runtime.config.connections)
    assert.equal(runtime.transports.get(c.id).connected, true);
  assert.equal(runtime.status().autoResume.state, "resumed");
});

test("a paused agent on a shared backend cannot hold the others back", async (t) => {
  // agent-1 is paused and its backend probe would fail; both use "fixture".
  const { runtime, resume, probed } = setup(t);
  assert.equal(runtime.config.agents[1].backendId, "fixture");
  const result = await resume().run();
  assert.equal(result.state, "resumed");
  assert.deepEqual(probed, ["agent-0"]);
  assert.equal(runtime.backends.has("agent-1"), false, "not initialised");
});

test("auto-resume retries with backoff until QQ is ready", async (t) => {
  const { runtime, resume, waits } = setup(t, { failures: 2 });
  const result = await resume().run();
  assert.equal(result.state, "resumed");
  assert.equal(result.attempts, 3);
  assert.deepEqual(waits, [5000, 10000]);
  assert.equal(runtime.config.globalPaused, false);
});

test("auto-resume gives up after its attempts and stays paused", async (t) => {
  const { runtime, resume, waits } = setup(t, { backend: false });
  const result = await resume({ maxAttempts: 3, maxDelayMs: 8000 }).run();
  assert.equal(result.state, "failed");
  assert.equal(result.attempts, 3);
  assert.equal(result.error, "BACKEND_PROBE_FAILED");
  assert.deepEqual(waits, [5000, 8000]);
  assert.equal(runtime.config.globalPaused, true);
});

test("an administrator's choice ends auto-resume", async (t) => {
  const { runtime, resume } = setup(t, { failures: 100 });
  const auto = resume({
    wait: async () => auto.cancel(),
  });
  const result = await auto.run();
  assert.equal(result.state, "cancelled");
  assert.equal(result.attempts, 1);
  assert.equal(runtime.config.globalPaused, true);
  // Cancelling again, or after the end, changes nothing.
  auto.cancel("stopped");
  assert.equal(auto.snapshot().state, "cancelled");
});

test("auto-resume is off by default and never runs in isolated mode", async (t) => {
  const { runtime } = setup(t, {
    edit: (cfg) => {
      cfg.mode = "isolated";
    },
  });
  assert.deepEqual(runtime.status().autoResume, {
    enabled: false,
    state: "off",
    attempts: 0,
    error: null,
    nextAttemptAt: null,
    resumedAt: null,
  });
  const auto = new AutoResume(runtime, { enabled: true });
  const result = await auto.run();
  assert.equal(result.state, "skipped");
  assert.equal(result.error, "ISOLATED_MODE");
  assert.equal(runtime.config.globalPaused, true);
  assert.equal(runtime.transports.size, 0);
});

test("auto-resume has nothing to do once the console already resumed", async (t) => {
  const { runtime, resume } = setup(t, {
    edit: (cfg) => {
      cfg.globalPaused = false;
    },
  });
  assert.equal((await resume().run()).state, "not-needed");
  assert.equal(runtime.transports.size, 0);
});
