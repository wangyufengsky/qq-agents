import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { randomBytes } from "node:crypto";
import { fixture, config } from "./helpers.mjs";
import { createServer } from "../src/server.mjs";
import { ConfigStore } from "../src/core/config.mjs";

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

for (const phase of ["writeFileSync", "renameSync"])
  test(`failed configuration ${phase} leaves the current turn and permissions usable`, async (t) => {
    const f = pendingTurn(t);
    const before = fs.readFileSync(f.configStore.file, "utf8");
    const revision = f.configStore.revision;
    const next = structuredClone(f.runtime.config);
    next.agents[0].allow.groups = [];
    const original = fs[phase];
    const fault = t.mock.method(fs, phase, (source, ...args) => {
      const target = phase === "renameSync" ? args[0] : source;
      if (
        target === f.configStore.file ||
        (typeof target === "string" &&
          target.startsWith(f.configStore.file + ".") &&
          target.endsWith(".tmp"))
      )
        throw Object.assign(Error("synthetic disk failure"), {
          code: "ENOSPC",
        });
      return original(source, ...args);
    });
    try {
      await assert.rejects(f.runtime.changeConfig(next, revision));
      assert.equal(fs.readFileSync(f.configStore.file, "utf8"), before);
      assert.equal(f.configStore.revision, revision);
      assert.equal(f.runtime.capability(f.ctx.token), f.ctx);
      assert.equal(f.ctx.controller.signal.aborted, false);
      assert.equal(f.runtime.transports.get("qq-0").connected, true);
    } finally {
      fault.mock.restore();
      f.finish();
      await f.job;
    }
  });

test("a stale page cannot overwrite a changed configuration after restart", (t) => {
  const f = fixture(t);
  const old = structuredClone(f.configStore.value);
  const revision = f.configStore.revision;
  const next = structuredClone(old);
  next.agents[0].name = "Updated identity label";
  f.configStore.save(next, revision);
  const reopened = new ConfigStore(f.configStore.file, config());
  assert.throws(() => reopened.save(old, revision), /CONFIG_CONFLICT/);
  assert.equal(reopened.value.agents[0].name, "Updated identity label");
  assert.equal(reopened.revision, f.configStore.revision);
});

test("invalid persisted configuration reports a safe actionable code without replacing the file", (t) => {
  const f = fixture(t);
  for (const [content, code] of [
    ["{broken", "CONFIG_INVALID_JSON"],
    ["{}", "CONFIG_SCHEMA_INVALID"],
  ]) {
    fs.writeFileSync(f.configStore.file, content);
    assert.throws(
      () => new ConfigStore(f.configStore.file, config()),
      new RegExp(code),
    );
    assert.equal(fs.readFileSync(f.configStore.file, "utf8"), content);
  }
});

test("a successful disk commit is reported as saved even if backend cleanup fails", async (t) => {
  const f = pendingTurn(t);
  f.runtime.backends.get("agent-0").close = async () => {
    throw Error("synthetic backend teardown failure");
  };
  const next = structuredClone(f.runtime.config);
  next.agents[0].name = "Saved identity label";
  const result = await f.runtime.changeConfig(next, f.configStore.revision);
  f.finish();
  await f.job;
  assert.equal(result.saved, true);
  assert.equal(result.reconnectRequired, false);
  assert.deepEqual(result.warnings, ["CONFIG_RECONFIGURE_FAILED"]);
  assert.equal(
    new ConfigStore(f.configStore.file).value.agents[0].name,
    "Saved identity label",
  );
  assert.throws(() => f.runtime.capability(f.ctx.token), /INVALID_CAPABILITY/);
});

test("a committed interval change reports saved with a warning when state synchronization fails", async (t) => {
  const f = fixture(t);
  const next = structuredClone(f.runtime.config);
  next.agents[0].subject.intervalMs += 1000;
  const bind = f.store.bind.bind(f.store);
  const fault = t.mock.method(f.store, "bind", (id) => {
    const m = bind(id);
    m.setState = () => {
      throw Object.assign(Error("synthetic disk full"), { code: "ENOSPC" });
    };
    return m;
  });
  try {
    const result = await f.runtime.changeConfig(next, f.configStore.revision);
    assert.equal(result.saved, true);
    assert.deepEqual(result.warnings, ["CONFIG_RECONFIGURE_FAILED"]);
    assert.equal(
      new ConfigStore(f.configStore.file).value.agents[0].subject.intervalMs,
      next.agents[0].subject.intervalMs,
    );
  } finally {
    fault.mock.restore();
  }
});

test("a committed configuration blocks new work until old resources finish closing", async (t) => {
  const f = fixture(t);
  const closing = Promise.withResolvers();
  const started = Promise.withResolvers();
  f.runtime.backends.set("agent-0", {
    close: async () => {
      started.resolve();
      await closing.promise;
    },
  });
  const next = structuredClone(f.runtime.config);
  next.agents[0].name = "Updated";
  next.connections[0].httpUrl = "http://127.0.0.1:10";
  const save = f.runtime.changeConfig(next, f.configStore.revision);
  await started.promise;
  try {
    assert.throws(
      () => f.runtime.makeContext("agent-0", "group:20000"),
      /CONFIG_CONFLICT/,
    );
    await assert.rejects(
      f.runtime.wake("agent-0", "group:20000"),
      /AGENT_PAUSED/,
    );
    await assert.rejects(f.runtime.startConnection("qq-0"), /CONFIG_CONFLICT/);
    await assert.rejects(
      f.runtime.backendConnections.handle({
        id: "fixture",
        action: "settings",
        autoReconnect: true,
      }),
      /CONFIG_CONFLICT/,
    );
  } finally {
    closing.resolve();
    await save;
  }
});

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
  const endpointEdit = structuredClone(next);
  endpointEdit.connections[0].httpUrl = "http://127.0.0.1:10";
  await assert.rejects(
    f.runtime.changeConfig(endpointEdit, f.configStore.revision),
    /STOP_MANAGED_QQ_PROCESSES/,
  );
  const request = await httpConfig(t, f);
  const response = await request("/api/config", {
    method: "PUT",
    body: JSON.stringify({ config: next, revision: f.configStore.revision }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).reconnectRequired, false);
  await f.job;
  assert.equal(f.runtime.transports.size, 2);
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
      body: {
        classList: {
          remove: (name) => bodyClasses.delete(name),
          toggle() {},
        },
      },
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
  for (const file of ["app.js", "agent-form.js"])
    vm.runInContext(
      fs.readFileSync(new URL("../public/" + file, import.meta.url), "utf8"),
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
      cooldownSeconds: String(a.wake.cooldownMs / 1000),
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

test("real console backend form drops OpenAI-only fields on a type change and clears an emptied key", async (t) => {
  const cfg = config(1);
  cfg.backends = [
    {
      id: "fixture",
      type: "openai",
      label: "API",
      baseUrl: "https://api.example.test/v1",
      apiKeyEnv: "QQ_TEST_OPENAI_KEY",
      model: "m",
      contextWindow: 64000,
      maxToolRounds: 8,
      vision: true,
      sendEffort: false,
      provider: "",
      effort: "high",
      preset: "qq-unified",
      command: "codex",
      toolServers: [],
      recovery: { autoReconnect: false },
    },
  ];
  const f = fixture(t, { cfg });
  const request = await httpConfig(t, f);
  const node = (() => {
    const nodes = new Map();
    return (selector) => {
      if (!nodes.has(selector))
        nodes.set(selector, { close() {}, addEventListener() {} });
      return nodes.get(selector);
    };
  })();
  const sandbox = vm.createContext({
    document: {
      querySelector: node,
      querySelectorAll: () => [],
      body: { classList: { remove() {}, toggle() {} } },
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
    initial: { revision: f.configStore.revision },
  });
  for (const file of ["app.js", "agent-form.js"])
    vm.runInContext(
      fs.readFileSync(new URL("../public/" + file, import.meta.url), "utf8"),
      sandbox,
    );
  const submit = async (values) => {
    sandbox.current = structuredClone(f.runtime.config);
    sandbox.revision0 = f.configStore.revision;
    vm.runInContext(
      `config = current; revision = revision0;
      editing = { type: "backends", id: "fixture", row: config.backends[0] };
      render = () => {}; var submitted; action = fn => submitted = fn();`,
      sandbox,
    );
    node("#edit-form").onsubmit({
      preventDefault() {},
      target: new Map(
        Object.entries({ id: "fixture", toolServers: "[]", ...values }),
      ),
    });
    await vm.runInContext("submitted", sandbox);
    return JSON.parse(fs.readFileSync(f.configStore.file)).backends[0];
  };
  const common = {
    label: "API",
    provider: "",
    model: "m",
    effort: "high",
    preset: "qq-unified",
    command: "codex",
  };
  // Clearing the key field removes the stored reference for a keyless local server.
  const keyless = await submit({
    ...common,
    type: "openai",
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKeyEnv: "",
    contextWindow: "64000",
    vision: "on",
  });
  assert.equal(keyless.apiKeyEnv, undefined);
  assert.equal(keyless.maxToolRounds, 8, "unlisted OpenAI settings survive");
  assert.equal(keyless.vision, true);
  // Switching to Codex removes every OpenAI-only field so validation accepts it.
  const codex = await submit({ ...common, type: "codex", baseUrl: "" });
  assert.equal(codex.type, "codex");
  for (const key of [
    "apiKeyEnv",
    "contextWindow",
    "maxToolRounds",
    "requestTimeoutMs",
    "vision",
    "sendEffort",
  ])
    assert.equal(Object.hasOwn(codex, key), false, key);
  assert.equal(f.runtime.config.backends[0].type, "codex");
});

test("editing one agent revokes its capability but preserves unrelated work and both QQ transports", async (t) => {
  const f = pendingTurn(t);
  const other = f.runtime.makeContext("agent-1", "group:20000");
  const transports = [...f.runtime.transports];
  const otherBackend = f.runtime.backendConnections.adapter(
    f.runtime.agent("agent-1"),
  );
  const pending = { reason: "message" };
  f.runtime.pending.set("agent-1|group:20000", pending);
  const next = structuredClone(f.runtime.config);
  next.agents[0].allow.groups = [];
  const result = await f.runtime.changeConfig(next, f.configStore.revision);
  await f.job;
  assert.equal(result.reconnectRequired, false);
  assert.throws(() => f.runtime.capability(f.ctx.token), /INVALID_CAPABILITY/);
  assert.equal(f.runtime.capability(other.token), other);
  assert.equal(f.runtime.backends.get("agent-1"), otherBackend);
  assert.equal(f.runtime.pending.get("agent-1|group:20000"), pending);
  assert.deepEqual([...f.runtime.transports], transports);
  assert(transports.every(([, transport]) => transport.connected));
});

test("unaffected agents can run and send while another agent's resources are still closing", async (t) => {
  const f = fixture(t, { cfg: config(2) });
  const closing = Promise.withResolvers(),
    started = Promise.withResolvers();
  f.runtime.backends.set("agent-0", {
    close: async () => {
      started.resolve();
      await closing.promise;
    },
  });
  const next = structuredClone(f.runtime.config);
  next.agents[0].persona = "Changed identity";
  const saving = f.runtime.changeConfig(next, f.configStore.revision);
  await started.promise;
  try {
    assert.throws(
      () => f.runtime.makeContext("agent-0", "group:20000"),
      /CONFIG_CONFLICT/,
    );
    await f.runtime.wake("agent-1", "group:20000");
    const ctx = f.runtime.makeContext("agent-1", "group:20000");
    const result = await f.runtime.callTool(ctx, "qq_send", {
      requestId: "unaffected",
      text: "Synthetic output",
    });
    assert.equal(result.status, "sent");
    assert.equal(f.runtime.transports.get("qq-1").sent.length, 1);
  } finally {
    closing.resolve();
    await saving;
  }
});

for (const change of ["connection", "backend", "rebind", "remove"])
  test(`${change} changes invalidate only dependent agents and resources`, async (t) => {
    const cfg = config(3);
    cfg.backends.push({ ...cfg.backends[0], id: "other-backend" });
    cfg.agents[2].backendId = "other-backend";
    const f = fixture(t, { cfg });
    const contexts = cfg.agents.map((a) =>
      f.runtime.makeContext(a.id, "group:20000"),
    );
    const backends = cfg.agents.map((a) =>
      f.runtime.backendConnections.adapter(a),
    );
    const transports = cfg.connections.map((c) =>
      f.runtime.transports.get(c.id),
    );
    const next = structuredClone(f.runtime.config);
    if (change === "connection")
      next.connections[0].httpUrl = "http://127.0.0.1:10";
    if (change === "backend") next.backends[0].model = "synthetic-model";
    if (change === "rebind") next.agents[0].backendId = "other-backend";
    if (change === "remove") next.agents.splice(0, 1);
    const result = await f.runtime.changeConfig(next, f.configStore.revision);
    assert.equal(result.reconnectRequired, change === "connection");
    assert.deepEqual(
      result.affectedAgents.sort(),
      change === "backend" ? ["agent-0", "agent-1"] : ["agent-0"],
    );
    for (let i = 0; i < 3; i++) {
      const affected = i === 0 || (change === "backend" && i === 1);
      assert.equal(contexts[i].controller.signal.aborted, affected);
      assert.equal(
        f.runtime.backends.get("agent-" + i),
        affected ? undefined : backends[i],
      );
      assert.equal(
        transports[i].connected,
        !(change === "connection" && i === 0),
      );
      if (!affected)
        assert.equal(f.runtime.capability(contexts[i].token), contexts[i]);
    }
  });

test("an old QQ transport cannot inject events or faults after replacement", async (t) => {
  const f = fixture(t, { cfg: config(1) });
  await f.runtime.stopConnection("qq-0");
  await f.runtime.startConnection("qq-0");
  const old = f.runtime.transports.get("qq-0");
  const next = structuredClone(f.runtime.config);
  next.connections[0].httpUrl = "http://127.0.0.1:10";
  await f.runtime.changeConfig(next, f.configStore.revision);
  await f.runtime.startConnection("qq-0");
  old.emit("event", { post_type: "malformed-late-event" });
  old.emit("fault", "SYNTHETIC_STALE_FAULT");
  assert.equal(f.runtime.jobs.size, 0);
  assert.equal(f.runtime.faults.has("qq-0"), false);
});

test("labels and port changes preserve live contexts and report restart requirements", async (t) => {
  const f = fixture(t);
  const ctx = f.runtime.makeContext("agent-0", "group:20000");
  const next = structuredClone(f.runtime.config);
  next.connections[0].label = "Renamed";
  next.backends[0].label = "Renamed backend";
  next.port++;
  const result = await f.runtime.changeConfig(next, f.configStore.revision);
  assert.deepEqual(result.affectedAgents, []);
  assert.equal(result.restartRequired, true);
  assert.equal(result.reconnectRequired, false);
  assert.equal(f.runtime.capability(ctx.token), ctx);
});

test("queued work becomes eligible when a multi-agent config commit finishes", async (t) => {
  const f = fixture(t, { cfg: config(2) });
  const now = 1800000000000;
  f.runtime.clock = () => new Date(now);
  const closing = Promise.withResolvers(),
    started = Promise.withResolvers();
  f.runtime.backends.set("agent-1", {
    close: async () => {
      started.resolve();
      await closing.promise;
    },
  });
  f.store
    .bind("agent-0")
    .setState("group:20000", { wakeConfig: { sleepUntil: now - 1 } });
  const next = structuredClone(f.runtime.config);
  for (const agent of next.agents) agent.name += " changed";
  const saving = f.runtime.changeConfig(next, f.configStore.revision);
  await started.promise;
  assert.equal(f.runtime.conversations.tick().examined, 1);
  assert.equal(f.runtime.conversations.tick().examined, 0);
  closing.resolve();
  await saving;
  assert.equal(f.runtime.conversations.tick().examined, 1);
});
