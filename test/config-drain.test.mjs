import test from "node:test";
import assert from "node:assert/strict";
import { fixture, config, raw } from "./helpers.mjs";
const tick = () => new Promise((resolve) => setImmediate(resolve));
for (const action of ["complete", "timeout", "pause", "isolated", "shutdown"])
  test(`same-account transport replacement ${action} respects admitted work`, async (t) => {
    const cfg = config(2);
    let release,
      hold = false;
    const f = fixture(t, {
        cfg,
        run: async (p) => {
          p.saveSession(
            p.session || { backend: "codex", id: "retained-session" },
          );
          p.onUsage({
            source: "measured",
            contextTokens: 1000,
            capacityTokens: 1000000,
          });
          if (hold)
            await new Promise((resolve) => {
              release = resolve;
              p.signal.addEventListener("abort", resolve, { once: true });
            });
        },
      }),
      r = f.runtime;
    await r.stopConnection("qq-0");
    await r.startConnection("qq-0");
    await r.wake("agent-0", "group:20000");
    hold = true;
    const job = r.wake("agent-0", "group:20000");
    await tick();
    const ctx = r.running.get("agent-0|group:20000"),
      transport = r.transports.get("qq-0"),
      backend = r.backends.get("agent-0"),
      before = r.config,
      revision = f.configStore.revision;
    const next = structuredClone(before);
    next.connections[0].httpUrl = "http://127.0.0.1:12345";
    const change = r.changeConfig(next, revision);
    change.catch(() => {});
    await tick();
    assert.equal(r.config, before);
    assert.equal(ctx.controller.signal.aborted, false);
    r.assertActive(ctx);
    assert.throws(
      () => r.makeContext("agent-0", "private:30000"),
      /CONFIG_CONFLICT/,
    );
    assert.equal(r.backends.get("agent-0"), backend);
    assert(transport.connected);
    const memory = f.store.bind("agent-0");
    const count = () =>
      memory.db
        .prepare(
          "SELECT COUNT(*) AS n FROM events WHERE agent_id=? AND direction='in'",
        )
        .get("agent-0").n;
    const beforeEvents = count();
    transport.emit("event", raw(700001));
    await tick();
    assert.equal(
      count(),
      beforeEvents + 1,
      "old socket must still archive arrivals during drain",
    );
    if (action === "complete") {
      release();
      await job;
      await change;
      assert.equal(
        r.config.connections[0].httpUrl,
        next.connections[0].httpUrl,
      );
      assert.equal(r.backends.get("agent-0"), backend);
      assert.equal(transport.connected, false);
      assert.equal(
        f.store.bind("agent-0").state("group:20000").session.id,
        "retained-session",
      );
    } else if (action === "timeout") {
      r.configDrain.deadline = 0;
      await assert.rejects(change, /CONFIG_DRAIN_TIMEOUT/);
      assert.equal(r.config, before);
      assert(transport.connected);
      r.assertActive(ctx);
      release();
      await job;
    } else {
      if (action === "pause") await r.pause("agent-0", true);
      else if (action === "isolated") await r.setMode("isolated", revision);
      else await r.close();
      await assert.rejects(change, /CONFIG_DRAIN_CANCELLED|RUNTIME_CLOSING/);
      await job;
      assert.equal(ctx.controller.signal.aborted, true);
      assert.equal(
        r.config.connections[0].httpUrl,
        before.connections[0].httpUrl,
      );
    }
    assert.equal(r.configDrain, null);
    assert.equal(r.configChanging, false);
  });
