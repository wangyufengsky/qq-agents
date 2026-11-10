import test from "node:test";
import assert from "node:assert/strict";
import { BackendConnections } from "../src/core/backend-connections.mjs";
import { config } from "./helpers.mjs";

function fixture() {
  const cfg = config(2);
  Object.assign(cfg.backends[0], {
    type: "dsh",
    baseUrl: "http://127.0.0.1:23230",
    provider: "role-provider",
    model: "default-role-model",
  });
  Object.assign(cfg.agents[0], { model: "role-model", effort: "medium" });
  cfg.backends.push(
    {
      ...cfg.backends[0],
      id: "alternate",
      functionalAgentOnly: true,
      baseUrl: "http://localhost:23231",
      provider: "alternate-provider",
      model: "alternate-model",
      toolServers: [{ id: "external-fixture" }],
    },
    { ...cfg.backends[0], id: "unsupported", type: "codex" },
  );
  const created = [];
  const runtime = {
    config: cfg,
    backends: new Map(),
    reconfiguringAgents: new Set(),
    now: () => Date.now(),
    backendFactory: (config, role) => {
      const backend = {
        config,
        role,
        run: async () => {},
        close: async () => {},
      };
      created.push(backend);
      return backend;
    },
  };
  return {
    runtime,
    created,
    connections: new BackendConnections(runtime),
    roles: cfg.agents,
  };
}

test("dedicated DSH leases isolate ordinary adapters and bound capacity per role", async () => {
  const { runtime, connections, roles, created } = fixture();
  const [role, peer] = roles;
  const backend = connections.adapter(role);
  backend.close = async () => assert.fail("an ordinary adapter must stay open");
  const lease = connections.acquireFunctionalBackend(role, {
    backendId: "alternate",
    model: "child-model",
  });
  const peerLease = connections.acquireFunctionalBackend(peer, {
    backendId: "alternate",
    model: "peer-model",
  });
  try {
    assert.notEqual(lease.backend, backend);
    assert.notEqual(peerLease.backend, lease.backend);
    assert.equal(Object.isFrozen(lease.modelSelection), true);
    assert.deepEqual(lease.modelSelection, {
      provider: "alternate-provider",
      model: "child-model",
      effort: "high",
    });
    assert.equal(peerLease.modelSelection.model, "peer-model");
    assert.equal(backend.config.model, "role-model");
    assert.equal(runtime.backends.get(role.id), backend);
    assert.equal(created.length, 3);
    assert.throws(
      () =>
        connections.acquireFunctionalBackend(role, { backendId: "alternate" }),
      /FUNCTIONAL_AGENT_BUSY/,
    );
  } finally {
    await Promise.all([lease.release(), peerLease.release()]);
  }
  await connections
    .acquireFunctionalBackend(role, { backendId: "alternate" })
    .release();
  assert.equal(created.length, 4);
});

test("an alternate DSH adapter is isolated and keeps its lease through close", async () => {
  const { runtime, connections, roles, created } = fixture();
  const role = roles[0];
  const retained = connections.adapter(role);
  const lease = connections.acquireFunctionalBackend(role, {
    backendId: "alternate",
  });
  const close = Promise.withResolvers();
  let closed = 0;
  lease.backend.close = async () => {
    closed++;
    await close.promise;
  };
  const release = lease.release();
  try {
    assert.equal(release, lease.release());
    assert.notEqual(lease.backend, retained);
    assert.equal(created.length, 2);
    assert.equal(lease.backend.role.backendId, "alternate");
    assert.deepEqual(lease.backend.config.toolServers, []);
    assert.equal(runtime.backends.get(role.id), retained);
    assert.deepEqual(lease.modelSelection, {
      provider: "alternate-provider",
      model: "alternate-model",
      effort: "high",
    });
    assert.throws(
      () =>
        connections.acquireFunctionalBackend(role, { backendId: "alternate" }),
      /FUNCTIONAL_AGENT_BUSY/,
    );
    assert.equal(connections.functionalBackendWork("alternate").length, 1);
    assert.equal(connections.functionalBackendWork("fixture").length, 1);
  } finally {
    close.resolve();
    await release;
  }
  assert.equal(closed, 1);
  assert.equal(connections.functionalBackendWork("alternate").length, 0);
  assert.equal(connections.functionalBackendWork("fixture").length, 0);
  assert.equal(runtime.backends.get(role.id), retained);
});

test("functional acquisition rejects missing, unsupported, and unavailable backend selections", () => {
  const { connections, roles, created } = fixture();
  const role = roles[0];
  const acquire = (backendId) =>
    connections.acquireFunctionalBackend(role, { backendId });
  assert.throws(
    () => acquire("missing"),
    /FUNCTIONAL_AGENT_BACKEND_UNAVAILABLE/,
  );
  assert.throws(
    () => acquire("unsupported"),
    /FUNCTIONAL_AGENT_BACKEND_UNSUPPORTED/,
  );
  for (const id of ["fixture", "alternate"]) {
    connections.operations.set(id, {});
    assert.throws(
      () => acquire("alternate"),
      /FUNCTIONAL_AGENT_BACKEND_UNAVAILABLE/,
    );
    connections.operations.delete(id);
  }
  connections.state("alternate").state = "recovering";
  assert.throws(
    () => acquire("alternate"),
    /FUNCTIONAL_AGENT_BACKEND_UNAVAILABLE/,
  );
  assert.equal(created.length, 0);
});

test("dedicated selection rejects shared aliases and unresolved ordinary DSH routes", () => {
  const { runtime, connections, roles, created } = fixture();
  const [ordinary, dedicated] = runtime.config.backends;
  const acquire = () =>
    connections.acquireFunctionalBackend(roles[0], { backendId: "alternate" });
  assert.throws(
    () =>
      connections.acquireFunctionalBackend(roles[0], { backendId: "fixture" }),
    /FUNCTIONAL_AGENT_BACKEND_UNSUPPORTED/,
  );
  for (const url of [
    undefined,
    "http://127.0.0.1:23231",
    "http://[::1]:23231",
  ]) {
    ordinary.baseUrl = url;
    assert.throws(acquire, /FUNCTIONAL_AGENT_BACKEND_UNAVAILABLE/);
  }
  ordinary.baseUrl = "http://127.0.0.1:23230";
  ordinary.recovery.dshInstance = "relay:fixture";
  assert.throws(acquire, /FUNCTIONAL_AGENT_BACKEND_UNAVAILABLE/);
  delete ordinary.recovery.dshInstance;
  dedicated.provider = "";
  assert.throws(acquire, /FUNCTIONAL_AGENT_BACKEND_UNAVAILABLE/);
  dedicated.provider = "alternate-provider";
  dedicated.baseUrl = "http://localhost";
  assert.throws(acquire, /FUNCTIONAL_AGENT_BACKEND_UNAVAILABLE/);
  assert.equal(created.length, 0);
});

test("unconfirmed native cleanup quarantines the dedicated endpoint and its aliases", async () => {
  const { runtime, connections, roles, created } = fixture();
  const [role, peer] = roles;
  const dedicated = runtime.config.backends.find(
    (item) => item.id === "alternate",
  );
  runtime.config.backends.push({
    ...dedicated,
    id: "alias",
    baseUrl: "http://127.0.0.1:23231",
  });
  const lease = connections.acquireFunctionalBackend(role, {
    backendId: "alternate",
  });
  lease.backend.functionalSessionUnverified = true;
  await lease.release();
  assert.equal(connections.functionalBackendWork("alternate").length, 0);
  assert.throws(
    () => connections.acquireFunctionalBackend(peer, { backendId: "alias" }),
    /FUNCTIONAL_AGENT_BACKEND_UNAVAILABLE/,
  );
  assert.equal(created.length, 1);
});

test("ordinary DSH recovery cannot select a dedicated endpoint", async () => {
  const { connections, created } = fixture();
  const selected = {
    id: "relay:fixture",
    url: "http://127.0.0.1:23231",
    followsRestart: true,
  };
  connections.discover = async () => [selected];
  const state = await connections.recover("fixture", {
    candidateId: selected.id,
  });
  assert.equal(state.state, "selection-required");
  assert.equal(state.error, "DSH_SELECTION_REQUIRED");
  assert.equal(created.length, 0);
});
