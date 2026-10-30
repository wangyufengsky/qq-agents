import test from "node:test";
import assert from "node:assert/strict";
import { config, fixture } from "./helpers.mjs";

for (const scope of ["group:20000", "private:30000", "@subject"])
  test(`${scope} retains measured capacity when a later usage report omits it`, async (t) => {
    const cfg = config(1);
    cfg.agents[0].subject.enabled = true;
    cfg.agents[0].subject.sessionMode = "continuous";
    let calls = 0,
      compactions = 0;
    const f = fixture(t, {
      cfg,
      run: async (p) => {
        calls++;
        p.saveSession(p.session || { id: "kept", backend: "fixture" });
        p.onUsage({
          source: "measured",
          contextTokens: calls === 1 ? 60387 : 62251,
          ...(calls === 1 ? { capacityTokens: 1000000 } : {}),
        });
      },
    });
    await f.runtime.wake("agent-0", scope);
    f.runtime.backends.get("agent-0").compact = async () => {
      compactions++;
      return { requiresReinitialize: true };
    };
    await f.runtime.wake("agent-0", scope);
    const state = f.store.bind("agent-0").state(scope);
    assert.equal(compactions, 0);
    assert.equal(state.session?.id, "kept");
    assert.equal(state.usage.capacityTokens, 1000000);
    assert.equal(state.lifecycle.status, "active");
  });

test("continuous free time uses the same pressure thresholds as a chat", async (t) => {
  const cfg = config(1);
  cfg.agents[0].subject.enabled = true;
  cfg.agents[0].subject.sessionMode = "continuous";
  const f = fixture(t, {
    cfg,
    run: async (p) => {
      p.saveSession({ id: "organizing", backend: "fixture" });
      p.onUsage({
        source: "measured",
        contextTokens: 76000,
        capacityTokens: 100000,
      });
    },
  });
  await f.runtime.wake("agent-0", "@subject");
  const state = f.store.bind("agent-0").state("@subject");
  assert.equal(state.lifecycle.status, "organizing");
  assert.equal(state.session?.id, "organizing");
});

test("an unmeasured turn keeps capacity, but a smaller reported window takes effect", async (t) => {
  let calls = 0;
  const f = fixture(t, {
    cfg: config(1),
    run: async (p) => {
      calls++;
      p.saveSession(p.session || { id: "kept", backend: "fixture" });
      if (calls !== 2)
        p.onUsage({
          source: "measured",
          contextTokens: 62000,
          capacityTokens: calls === 1 ? 1000000 : 65536,
        });
    },
  });
  let now = Date.now();
  f.runtime.clock = () => new Date(now);
  const m = f.store.bind("agent-0"),
    scope = "private:30000";
  await f.runtime.wake("agent-0", scope);
  now += 1000;
  await f.runtime.wake("agent-0", scope);
  assert.equal(m.state(scope).usage.source, "estimated");
  assert.equal(m.state(scope).usage.capacityTokens, 1000000);
  assert.equal(m.state(scope).session?.id, "kept");
  now += 1000;
  await f.runtime.wake("agent-0", scope);
  assert.equal(m.state(scope).session, null);
  assert.equal(m.state(scope).lifecycle.reason, "capacity-guard");
  assert.equal(m.state(scope).usage, null);
});

test("free time retains its normal idle and hard pressure retirement guards", async (t) => {
  const cfg = config(1);
  cfg.agents[0].subject.enabled = true;
  let tokens = 76000,
    now = Date.now();
  const f = fixture(t, {
    cfg,
    run: async (p) => {
      p.saveSession({ id: "subject-context", backend: "fixture" });
      p.onUsage({
        source: "measured",
        contextTokens: tokens,
        capacityTokens: 100000,
      });
    },
  });
  f.runtime.clock = () => new Date(now);
  const m = f.store.bind("agent-0");
  await f.runtime.wake("agent-0", "@subject");
  now += cfg.agents[0].contextPolicy.idleMs + 1;
  f.runtime.contexts.tick();
  assert.equal(m.state("@subject").lifecycle.reason, "idle-after-pressure");
  tokens = 90000;
  await f.runtime.wake("agent-0", "@subject");
  assert.equal(m.state("@subject").lifecycle.reason, "capacity-guard");
});
