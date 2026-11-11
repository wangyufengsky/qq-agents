import test from "node:test";
import assert from "node:assert/strict";
import { validateConfig } from "../src/core/config.mjs";
import { defaultConfig } from "../src/core/default-config.mjs";
import {
  memoryRecallPolicy,
  resolveFunctionalAgent,
} from "../src/core/functional-agents.mjs";

const dedicatedBackend = {
  id: "recall-backend",
  type: "dsh",
  label: "Recall backend",
  functionalAgentOnly: true,
  baseUrl: "http://127.0.0.1:24861",
  provider: "fixture-provider",
  model: "fixture-model",
};

test("legacy roles retain their config shape and resolve stable instances by role and scope", () => {
  const {
    agents: [role, other],
  } = validateConfig(defaultConfig());
  assert.equal(Object.hasOwn(role, "functionalAgents"), false);
  const subject = resolveFunctionalAgent(role, "@subject");
  assert.equal(subject.key, "subject");
  assert.equal(subject.kind, "subject");
  const group = resolveFunctionalAgent(role, "group:20000");
  assert.equal(group.key, "qq");
  assert.equal(group.kind, "qq-dialogue");
  assert.equal(
    group.instanceKey,
    resolveFunctionalAgent({ ...role, name: "新名称" }, "group:20000")
      .instanceKey,
  );
  for (const [agent, scope] of [
    [role, "group:20001"],
    [role, "private:20000"],
    [role, "@subject"],
    [other, "group:20000"],
  ]) {
    assert.notEqual(
      resolveFunctionalAgent(agent, scope).instanceKey,
      group.instanceKey,
    );
  }
  assert.equal(
    resolveFunctionalAgent(role, "group:20000", "memory"),
    undefined,
  );
  assert.equal(
    resolveFunctionalAgent(role, "group:20000", "subject"),
    undefined,
  );
  assert.equal(resolveFunctionalAgent(role, "@subject", "qq"), undefined);
  assert.equal(resolveFunctionalAgent(role, "group:bad"), undefined);
  assert.equal(resolveFunctionalAgent(role, "@memory"), undefined);
});

test("ordinary effort overrides require a configured DSH model", () => {
  const cfg = defaultConfig();
  const [role] = cfg.agents;
  role.functionalAgents = { qq: { kind: "qq-dialogue", effort: " low " } };
  assert.throws(() => validateConfig(cfg), /CONFIG_SCHEMA_INVALID/);
  role.model = "fixture-model";
  const parsed = validateConfig(cfg);
  assert.equal(parsed.agents[0].functionalAgents.qq.effort, "low");
  role.backendId = cfg.backends.find(({ type }) => type === "codex").id;
  assert.throws(() => validateConfig(cfg), /CONFIG_SCHEMA_INVALID/);
});

test("explicit definitions retain their configuration and memory has one internal instance per role", () => {
  const config = defaultConfig();
  config.backends.push(dedicatedBackend);
  const profiles = {
    qq: {
      kind: "qq-dialogue",
      instructions: "本功能的职责说明",
      tools: ["memory_search"],
      delegatesTo: ["memory"],
    },
    memory: { kind: "memory", enabled: true, backendId: "recall-backend" },
  };
  config.agents[0].functionalAgents = profiles;
  config.agents[1].functionalAgents = {
    memory: profiles.memory,
  };
  const {
    agents: [role, other],
  } = validateConfig(config);
  const qq = resolveFunctionalAgent(role, "group:20000");
  assert.strictEqual(qq.definition, role.functionalAgents.qq);
  assert.deepEqual(qq.definition, profiles.qq);
  const memory = resolveFunctionalAgent(role, "group:20000", "memory");
  assert.strictEqual(memory.definition, role.functionalAgents.memory);
  assert.deepEqual(memory.definition.tools, [
    "memory_search",
    "memory_read",
    "memory_related",
  ]);
  assert.deepEqual(memory.definition.onDemand, {
    timeoutMs: 10000,
    maxLookups: 3,
  });
  assert.equal(
    resolveFunctionalAgent(role, "@subject", "memory").instanceKey,
    memory.instanceKey,
  );
  assert.notEqual(
    resolveFunctionalAgent(other, "group:20000", "memory").instanceKey,
    memory.instanceKey,
  );
  assert.equal(resolveFunctionalAgent(role, "@memory", "memory"), undefined);
});

test("functional config rejects invalid routes, capabilities and lookup budgets", () => {
  const config = defaultConfig();
  const agent = config.agents[0];
  for (const profiles of [
    { unknown: { kind: "memory" } },
    { qq: { kind: "subject" } },
    { qq: { kind: "qq-dialogue", delegatesTo: ["qq"] } },
    { qq: { kind: "qq-dialogue", tools: ["made_up_tool"] } },
    { subject: { kind: "subject", model: "fixture" } },
    { memory: { kind: "memory", tools: ["qq_send"] } },
    { memory: { kind: "memory", delegatesTo: ["memory"] } },
    { memory: { kind: "memory", opening: {} } },
    { memory: { kind: "memory", onDemand: { timeoutMs: 0 } } },
    { memory: { kind: "memory", onDemand: { timeoutMs: 10001 } } },
    { memory: { kind: "memory", onDemand: { maxLookups: 4 } } },
  ]) {
    agent.functionalAgents = profiles;
    assert.throws(() => validateConfig(config));
  }
  agent.functionalAgents = { memory: { kind: "memory", backendId: "missing" } };
  assert.throws(() => validateConfig(config), { message: "INVALID_REFERENCE" });
  agent.functionalAgents.memory.backendId = "codex-cli";
  assert.throws(() => validateConfig(config), {
    message: "CONFIG_SCHEMA_INVALID",
  });
  delete agent.functionalAgents.memory.backendId;
  agent.backendId = "codex-cli";
  assert.equal(
    resolveFunctionalAgent(
      validateConfig(config).agents[0],
      "group:20000",
      "memory",
    ),
    undefined,
  );
  agent.functionalAgents.memory.enabled = true;
  assert.throws(() => validateConfig(config), {
    message: "CONFIG_SCHEMA_INVALID",
  });
});

test("memory execution requires a dedicated DSH origin and an effective model selection", () => {
  const config = defaultConfig();
  const [agent] = config.agents;
  const backend = { ...dedicatedBackend };
  config.backends.push(backend);
  const memory = { kind: "memory", enabled: true, backendId: backend.id };
  agent.functionalAgents = { memory };
  assert.doesNotThrow(() => validateConfig(config));

  agent.backendId = backend.id;
  assert.throws(() => validateConfig(config), {
    message: "CONFIG_SCHEMA_INVALID",
  });
  agent.backendId = "dsh-desktop";

  backend.model = "";
  assert.throws(() => validateConfig(config), {
    message: "CONFIG_SCHEMA_INVALID",
  });
  memory.model = "explicit-model";
  assert.doesNotThrow(() => validateConfig(config));
  backend.provider = " ";
  assert.throws(() => validateConfig(config), {
    message: "CONFIG_SCHEMA_INVALID",
  });
  backend.provider = dedicatedBackend.provider;

  const [ordinaryBackend] = config.backends;
  for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
    ordinaryBackend.baseUrl = `http://${host}:24861/`;
    assert.throws(() => validateConfig(config), {
      message: "CONFIG_SCHEMA_INVALID",
    });
  }
  ordinaryBackend.baseUrl = "http://localhost:24862";
  assert.doesNotThrow(() => validateConfig(config));
});

test("the dedicated backend marker accepts only a fixed managed DSH origin", () => {
  const config = defaultConfig();
  for (const fields of [
    { type: "codex" },
    { preset: "custom" },
    { baseUrl: undefined },
    { baseUrl: "ws://127.0.0.1:24861" },
    { baseUrl: "http://127.0.0.1:24861/subpath" },
    { baseUrl: "http://example.test:24861" },
    { recovery: { dshInstance: "relay:fixture" } },
  ]) {
    config.backends[2] = { ...dedicatedBackend, ...fields };
    assert.throws(() => validateConfig(config));
  }
});

test("memory recall follows the role backend by default and respects explicit overrides", () => {
  const raw = defaultConfig();
  raw.backends.push(dedicatedBackend);
  for (const agent of raw.agents)
    agent.allow = { groups: ["20000"], users: ["30000"] };
  raw.privateLikeGroups = ["20001"];
  const cfg = validateConfig(raw);
  const [dsh, codex] = cfg.agents;
  const policy = (role, scope) => memoryRecallPolicy(role, scope, cfg);
  assert.equal(policy(dsh, "group:20000").mode, "all");
  assert.equal(policy(dsh, "group:20001").opening, true);
  assert.equal(policy(dsh, "private:30000").opening, false);
  for (const scope of [
    "group:20002",
    "private:30001",
    "@subject",
    "@work:30000",
  ])
    assert.equal(policy(dsh, scope), undefined);
  assert.equal(policy(codex, "group:20000"), undefined);
  assert.equal(
    policy({ ...codex, memoryRecall: "enabled" }, "private:30000").mode,
    "all",
  );
  assert.equal(
    policy({ ...dsh, memoryRecall: "disabled" }, "group:20000"),
    undefined,
  );
  assert.equal(
    memoryRecallPolicy(dsh, "group:20000", {
      ...cfg,
      backends: cfg.backends.filter((b) => !b.functionalAgentOnly),
    }),
    undefined,
  );
  assert.equal(policy({ ...dsh, tools: [] }, "group:20000"), undefined);
});
