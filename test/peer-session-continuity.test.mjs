import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fixture, config, FakeTransport } from "./helpers.mjs";
import { Runtime } from "../src/core/runtime.mjs";
import { stableInstructions, identityAnchors } from "../src/core/prompts.mjs";
import {
  sessionSignature,
  acceptsSession,
} from "../src/backends/session-contract.mjs";

function setup(t) {
  const cfg = config(1);
  cfg.agents[0].subject.enabled = true;
  cfg.agents[0].subject.sessionMode = "continuous";
  cfg.agents[0].contextPolicy.capacityTokens = 1000000;
  const f = fixture(t, { cfg });
  const prompts = [];
  let creates = 0;
  f.runtime.backendFactory = (config) => {
    const backend = {
      config,
      sessionSignature: (tools) => sessionSignature(backend, tools),
      acceptsSession: (session, tools) =>
        acceptsSession(backend, session, tools),
      run: async (p) => {
        prompts.push(p);
        p.saveSession(
          p.session || {
            id: "session-" + ++creates,
            backend: config.type,
            signature: sessionSignature(backend, p.tools),
          },
        );
      },
      cancel: async () => {},
      close: async () => {},
    };
    return backend;
  };
  return {
    ...f,
    prompts,
    memory: f.store.bind("agent-0"),
    creates: () => creates,
  };
}

for (const scope of ["@subject", "group:20000", "private:30000"]) {
  test(`peer additions, edits, ordering and removal reuse the ${scope} session`, async (t) => {
    const f = setup(t);
    await f.runtime.wake("agent-0", scope);
    const original = f.memory.state(scope).session.id;
    const instructions = f.prompts[0].instructions;
    const peer = config(2);
    const changes = [
      (cfg) => {
        cfg.agents.push(peer.agents[1]);
        cfg.connections.push(peer.connections[1]);
      },
      (cfg) => {
        cfg.agents[1].name = "同伴新名字";
        cfg.agents[1].aliases = ["新别名"];
      },
      (cfg) => {
        cfg.connections[1].accountId = "10002";
      },
      (cfg) => {
        cfg.agents.reverse();
        cfg.connections.reverse();
      },
      (cfg) => {
        cfg.agents = cfg.agents.filter((a) => a.id !== "agent-1");
        cfg.connections = cfg.connections.filter((c) => c.id !== "qq-1");
      },
    ];
    for (const change of changes) {
      const next = structuredClone(f.runtime.config);
      change(next);
      await f.runtime.changeConfig(next, f.configStore.revision);
      await f.runtime.wake("agent-0", scope);
      assert.equal(f.memory.state(scope).session.id, original);
      assert.equal(f.memory.identity.list("session_history").length, 0);
      const latest = f.prompts.at(-1);
      assert.equal(latest.instructions, instructions);
      assert.doesNotMatch(latest.instructions, /同伴新名字|新别名|10002/);
      const roster = latest.prompt
        .split("\n")
        .find((line) => line.startsWith("当前同伴配置"));
      assert(
        roster.includes(
          JSON.stringify(
            identityAnchors(
              next,
              next.agents.find((a) => a.id === "agent-0"),
            ).peers,
          ),
        ),
      );
    }
    assert.equal(f.creates(), 1);
  });
}

function markLegacy(f, scope = "group:20000") {
  const a = f.runtime.agent("agent-0");
  const instructions = stableInstructions(
    a,
    f.memory.identity.current(),
    scope === "@subject",
    f.memory.identity.anchors(a),
    {
      identity: identityAnchors(f.runtime.config, a),
      backendType: "codex",
      toolNames: f.runtime.toolsFor(a, scope),
    },
  );
  const state = f.memory.state(scope);
  f.memory.setState(scope, {
    ...state,
    loadedInstructionsHash: createHash("sha256")
      .update(instructions)
      .digest("hex"),
  });
}

async function reopen(f, run) {
  await f.runtime.close();
  const runtime = new Runtime({
    configStore: f.configStore,
    memory: f.store,
    backendFactory: f.runtime.backendFactory,
    transportFactory: () => new FakeTransport(),
  });
  for (const c of runtime.config.connections)
    runtime.transports.set(c.id, new FakeTransport());
  try {
    await run(runtime);
  } finally {
    await runtime.close();
  }
}

for (const scope of ["@subject", "group:20000", "private:30000"])
  test(`startup upgrades a matching legacy ${scope} session before any peer edit`, async (t) => {
    const f = setup(t);
    await f.runtime.wake("agent-0", scope);
    const newHash = f.memory.state(scope).loadedInstructionsHash;
    markLegacy(f, scope);
    const before = f.memory.state(scope);
    const turns = f.memory.identity.list("model_turns");
    const self = f.memory.identity.history();
    await reopen(f, async (runtime) => {
      assert.deepEqual(f.memory.state(scope), {
        ...before,
        loadedInstructionsHash: newHash,
      });
      assert.deepEqual(f.memory.identity.list("model_turns"), turns);
      assert.deepEqual(f.memory.identity.history(), self);
      assert.equal(f.prompts.length, 1);
      const next = structuredClone(runtime.config);
      next.agents.push(config(2).agents[1]);
      next.connections.push(config(2).connections[1]);
      await runtime.changeConfig(next, f.configStore.revision);
      await runtime.wake("agent-0", scope);
      assert.equal(f.memory.state(scope).session.id, before.session.id);
      assert.match(f.prompts.at(-1).prompt, /10001/);
      assert.equal(f.memory.identity.list("session_history").length, 0);
      assert.equal(f.creates(), 1);
    });
  });

for (const reason of ["unknown-hash", "own-account", "administrator", "Self"])
  test(`legacy compatibility never bypasses ${reason} changes`, async (t) => {
    const f = setup(t);
    await f.runtime.wake("agent-0", "group:20000");
    markLegacy(f);
    const original = f.memory.state("group:20000").session.id;
    if (reason === "unknown-hash")
      f.memory.setState("group:20000", {
        ...f.memory.state("group:20000"),
        loadedInstructionsHash: "unrecognized",
      });
    else if (reason === "Self")
      f.memory.identity.adminEdit(
        { body: "新的性格", reason: "管理员修改", expectedVersion: 1 },
        f.runtime.now(),
      );
    else {
      const next = structuredClone(f.runtime.config);
      if (reason === "own-account") next.connections[0].accountId = "10009";
      else next.agents[0].ownerIds = ["30000"];
      f.configStore.save(next, f.configStore.revision);
    }
    const oldHash = f.memory.state("group:20000").loadedInstructionsHash;
    await reopen(f, async (runtime) => {
      assert.equal(
        f.memory.state("group:20000").loadedInstructionsHash,
        oldHash,
      );
      await runtime.wake("agent-0", "group:20000");
      assert.notEqual(f.memory.state("group:20000").session.id, original);
      assert.equal(
        f.memory.identity.list("session_history")[0].reason,
        reason === "Self"
          ? "self-version-change"
          : "identity-or-protocol-change",
      );
    });
  });

test("legacy migration does not revive a turn interrupted by process exit", async (t) => {
  const f = setup(t);
  await f.runtime.wake("agent-0", "group:20000");
  markLegacy(f);
  const turn = f.memory.identity.list("model_turns")[0];
  f.memory.identity.put("model_turns", { ...turn, status: "running" });
  await reopen(f, async () => {
    assert.equal(f.memory.state("group:20000").session, null);
    assert.equal(
      f.memory.identity.list("session_history")[0].reason,
      "process-recovery",
    );
    assert.equal(
      f.memory.identity.list("model_turns")[0].status,
      "interrupted",
    );
    assert.equal(f.prompts.length, 1);
  });
});

test("peer configuration changes leave another role's active turn and capability intact", async (t) => {
  let finish;
  const f = fixture(t, {
    cfg: config(2),
    run: ({ signal, saveSession }) =>
      new Promise((resolve, reject) => {
        saveSession({ id: "active-session", backend: "codex" });
        finish = resolve;
        signal.addEventListener("abort", () => reject(Error("ABORTED")), {
          once: true,
        });
      }),
  });
  const job = f.runtime.wake("agent-0", "group:20000");
  const ctx = f.runtime.running.get("agent-0|group:20000");
  try {
    const next = structuredClone(f.runtime.config);
    next.agents[1].aliases = ["新别名"];
    await f.runtime.changeConfig(next, f.configStore.revision);
    assert.equal(ctx.controller.signal.aborted, false);
    assert.equal(f.runtime.capability(ctx.token), ctx);
    assert.equal(f.runtime.running.get("agent-0|group:20000"), ctx);
  } finally {
    finish();
    await job;
  }
  assert.equal(
    f.store.bind("agent-0").state("group:20000").session.id,
    "active-session",
  );
  assert.equal(
    f.store.bind("agent-0").identity.list("session_history").length,
    0,
  );
});
