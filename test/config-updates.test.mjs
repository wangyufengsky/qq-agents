import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { randomBytes } from "node:crypto";
import { fixture, config } from "./helpers.mjs";
import { createServer } from "../src/server.mjs";

function pendingTurn(t) {
  let finish;
  const f = fixture(t, {
    cfg: config(2),
    run: ({ signal, saveSession }) =>
      new Promise((resolve, reject) => {
        saveSession({ backend: "codex", id: "synthetic-session" });
        finish = resolve;
        signal.addEventListener("abort", () => reject(Error("ABORTED")), {
          once: true,
        });
      }),
  });
  const job = f.runtime.wake("agent-0", "group:20000");
  const ctx = f.runtime.running.get("agent-0|group:20000");
  return { ...f, job, ctx, finish: () => finish() };
}

async function httpConfig(t, f) {
  const token = randomBytes(32).toString("hex");
  const server = createServer({ runtime: f.runtime, token, allowLive: true });
  const port = await server.listen();
  t.after(() => server.close());
  return (url, options = {}) =>
    fetch(`http://127.0.0.1:${port}${url}`, {
      ...options,
      headers: { "x-admin-token": token, "content-type": "application/json" },
    });
}

test("participation saves retain transports, active capabilities and sessions, including managed QQ", async (t) => {
  const f = pendingTurn(t);
  const request = await httpConfig(t, f);
  const transports = [...f.runtime.transports.values()];
  const backend = f.runtime.backends.get("agent-0");
  const pending = { reason: "message" };
  f.runtime.pending.set("agent-1|group:20000", pending);
  f.runtime.lifecycle = {
    owned: new Set(["qq-0"]),
    status: () => ({ managed: true }),
    close: async () => {},
  };
  for (const participation of [0, 1, 0.4, 0.4]) {
    const next = structuredClone(f.runtime.config);
    next.agents[0].wake.participation = participation;
    const response = await request("/api/config", {
      method: "PUT",
      body: JSON.stringify({ config: next, revision: f.configStore.revision }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).reconnectRequired, false);
    assert.deepEqual([...f.runtime.transports.values()], transports);
    assert(transports.every((x) => x.connected));
    assert.equal(f.runtime.backends.get("agent-0"), backend);
    assert.equal(f.runtime.capability(f.ctx.token), f.ctx);
    assert.equal(
      f.store.bind("agent-0").state("group:20000").session.id,
      "synthetic-session",
    );
    assert.equal(f.ctx.controller.signal.aborted, false);
    assert.equal(f.runtime.pending.get("agent-1|group:20000"), pending);
    assert.equal(
      JSON.parse(fs.readFileSync(f.configStore.file)).agents[0].wake
        .participation,
      participation,
    );
    f.runtime.random = () => 0.5;
    assert.equal(
      f.runtime.conversations.reason(
        f.runtime.agent("agent-0"),
        {
          kind: "message.received",
          conversation: "group:20000",
          segments: [],
          body: "ordinary text",
          senderId: "30000",
        },
        "10000",
      ),
      participation > 0.5 ? "message" : null,
    );
  }
  f.finish();
  await f.job;
  assert.equal(f.runtime.status().agents[0].error, null);
});

test("participation fast path rejects stale/invalid saves and never bypasses other config changes", async (t) => {
  const f = pendingTurn(t);
  const next = structuredClone(f.runtime.config);
  next.agents[0].wake.participation = 0.4;
  await assert.rejects(f.runtime.changeConfig(next, -1), /CONFIG_CONFLICT/);
  next.agents[0].wake.participation = 2;
  await assert.rejects(f.runtime.changeConfig(next, f.configStore.revision));
  assert.equal(f.ctx.controller.signal.aborted, false);
  next.agents[0].wake.participation = 0.4;
  next.agents[0].allow.groups = [];
  f.runtime.lifecycle = {
    owned: new Set(["qq-0"]),
    status: () => ({ managed: true }),
    close: async () => {},
  };
  await assert.rejects(
    f.runtime.changeConfig(next, f.configStore.revision),
    /STOP_MANAGED_QQ_PROCESSES/,
  );
  f.runtime.lifecycle.owned.clear();
  const request = await httpConfig(t, f);
  const response = await request("/api/config", {
    method: "PUT",
    body: JSON.stringify({ config: next, revision: f.configStore.revision }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).reconnectRequired, true);
  await f.job;
  assert.equal(f.runtime.transports.size, 0);
  assert.equal(f.ctx.controller.signal.aborted, true);
  assert.throws(() => f.runtime.capability(f.ctx.token), /INVALID_CAPABILITY/);
  assert.equal(f.runtime.status().agents[0].error, null);
});

for (const action of ["pause", "pause-all", "reset", "disconnect", "shutdown"])
  test(`normal ${action} cancellation retires the turn without a backend failure`, async (t) => {
    const f = pendingTurn(t);
    if (action === "pause") await f.runtime.pause("agent-0");
    if (action === "pause-all") await f.runtime.pause("all");
    if (action === "reset")
      await f.runtime.resetSession("agent-0", "group:20000");
    if (action === "disconnect") await f.runtime.stopConnection("qq-0");
    if (action === "shutdown") await f.runtime.close();
    await f.job;
    assert.equal(
      f.store.bind("agent-0").identity.list("model_turns")[0].status,
      "cancelled",
    );
    assert.equal(f.runtime.status().agents[0].error, null);
  });

test("normal cancellation does not erase an earlier genuine failure", async (t) => {
  const f = pendingTurn(t);
  f.runtime.faults.set("agent-0", "DSH_STREAM_ENDED");
  await f.runtime.pause("agent-0");
  await f.job;
  assert.equal(f.runtime.status().agents[0].error, "DSH_STREAM_ENDED");
});

test("turn timeout remains visible even when the backend resolves on abort", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const rejects of [false, true]) {
    const cfg = config(1);
    cfg.agents[0].behavior.turnTimeoutMs = 60000;
    const f = fixture(t, {
      cfg,
      run: ({ signal }) =>
        new Promise((resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => (rejects ? reject(Error("ABORTED")) : resolve()),
            { once: true },
          );
        }),
    });
    const job = f.runtime.wake("agent-0", "group:20000");
    t.mock.timers.tick(60001);
    await job;
    assert.equal(f.runtime.status().agents[0].error, "BACKEND_TURN_TIMEOUT");
  }
});

test("actual backend failures remain visible", async (t) => {
  for (const code of ["CODEX_TURN_FAILED", "DSH_TURN_FAILED"]) {
    const f = fixture(t, {
      run: async () => {
        throw Error(code);
      },
    });
    await f.runtime.wake("agent-0", "group:20000");
    assert.equal(
      f.runtime.status().agents[0].error,
      code.startsWith("DSH_") ? code : "BACKEND_TURN_FAILED",
    );
  }
});

test("real console role form changes only participation and shows the server's reconnect result", async (t) => {
  const f = fixture(t, { cfg: config(1) });
  const request = await httpConfig(t, f);
  const original = structuredClone(f.runtime.config);
  const a = original.agents[0];
  const nodes = new Map();
  const bodyClasses = new Set(["locked"]);
  const node = (selector) => {
    if (!nodes.has(selector))
      nodes.set(selector, { close() {}, addEventListener() {} });
    return nodes.get(selector);
  };
  const sandbox = vm.createContext({
    document: {
      querySelector: node,
      querySelectorAll: () => [],
      body: { classList: { remove: (name) => bodyClasses.delete(name) } },
    },
    sessionStorage: { getItem: () => "" },
    setInterval() {},
    setTimeout() {},
    clearTimeout() {},
    structuredClone,
    FormData: class {
      constructor(fields) {
        return fields;
      }
    },
    fetch: request,
    initial: {
      config: original,
      revision: f.configStore.revision,
      tools: [...a.tools].reverse(),
    },
  });
  vm.runInContext(
    fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8"),
    sandbox,
  );
  vm.runInContext(
    `config = initial.config; revision = initial.revision; tools = initial.tools;
    editing = { type: "agents", id: config.agents[0].id, row: config.agents[0] };
    render = () => {}; var submitted; action = fn => submitted = fn();`,
    sandbox,
  );
  const fields = new Map(
    Object.entries({
      id: a.id,
      name: a.name,
      connectionId: a.connectionId,
      backendId: a.backendId,
      model: a.model,
      effort: a.effort,
      persona: a.persona,
      appearance: a.appearance,
      maxConsecutiveSends: String(a.maxConsecutiveSends ?? a.maxSendsPerTurn),
      publicUrls: "",
      githubAuth: a.github.auth,
      githubTokenEnv: a.github.tokenEnv,
      githubPrivateRepositories: a.github.privateRepositories.join("\n"),
      aliases: a.aliases.join(","),
      ownerIds: a.ownerIds.join(","),
      groups: a.allow.groups.join(","),
      users: a.allow.users.join(","),
      participation: "0.4",
      cooldownMs: String(a.wake.cooldownMs),
      silence: JSON.stringify(a.silence),
    }),
  );
  for (const key of ["mentions", "names", "private", "questions", "peers"])
    if (a.wake[key]) fields.set(key, "on");
  for (const tool of a.tools) fields.set("tool:" + tool, "on");
  if (a.paused) fields.set("paused", "on");
  node("#edit-form").onsubmit({ preventDefault() {}, target: fields });
  await vm.runInContext("submitted", sandbox);
  original.agents[0].wake.participation = 0.4;
  assert.deepEqual(f.runtime.config, original);
  assert.equal(f.runtime.status().connections[0].connected, true);
  assert.match(node("#notice").textContent, /保持/);
  assert.equal(bodyClasses.has("locked"), false);
  // The same real form persists the per-agent autonomy grant in both directions.
  for (const enabled of [true, false]) {
    vm.runInContext(
      'editing = { type: "agents", id: config.agents[0].id, row: config.agents[0] };',
      sandbox,
    );
    if (enabled) fields.set("autonomousNetwork", "on");
    else fields.delete("autonomousNetwork");
    node("#edit-form").onsubmit({ preventDefault() {}, target: fields });
    await vm.runInContext("submitted", sandbox);
    assert.equal(f.runtime.agent(a.id).network.autonomous, enabled);
    assert.equal(
      JSON.parse(fs.readFileSync(f.configStore.file)).agents[0].network
        .autonomous,
      enabled,
    );
    assert.equal(f.runtime.agent(a.id).wake.participation, 0.4);
  }
});
