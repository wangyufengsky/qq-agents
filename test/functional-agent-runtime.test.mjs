import test from "node:test";
import assert from "node:assert/strict";
import { validateConfig } from "../src/core/config.mjs";
import { scopedCatalog } from "../src/tools/catalog.mjs";
import { config, fixture } from "./helpers.mjs";

test("ordinary contexts get stable functional identities and can narrow legacy permissions", async (t) => {
  const cfg = config(1);
  cfg.agents[0].functionalAgents = {
    qq: {
      kind: "qq-dialogue",
      tools: ["memory_read"],
      instructions: "只处理当前对话。",
    },
  };
  const { runtime } = fixture(t, { cfg: validateConfig(cfg) });
  const first = runtime.makeContext("agent-0", "group:20000");
  const next = runtime.makeContext("agent-0", "group:20000");
  const other = runtime.makeContext("agent-0", "group:20001");
  assert.equal(
    first.functionalAgent.instanceKey,
    next.functionalAgent.instanceKey,
  );
  assert.notEqual(
    first.functionalAgent.instanceKey,
    other.functionalAgent.instanceKey,
  );
  assert.notEqual(first.token, next.token);
  assert.deepEqual(
    scopedCatalog(runtime, first, {}).tools.map(({ name }) => name),
    ["memory_read"],
  );
  await assert.rejects(
    runtime.callTool(first, "memory_search", {}),
    /TOOL_DISABLED/,
  );
  await assert.rejects(
    runtime.callTool(first, "functional_agent_result", { evidenceIds: [] }),
    /TOOL_DISABLED/,
  );
});

test("native delegation uses same-scope evidence, isolated permissions and no chat input receipt", async (t) => {
  const cfg = config(1);
  cfg.backends.push({
    ...cfg.backends[0],
    id: "fixture-recall",
    type: "dsh",
    baseUrl: "http://127.0.0.1:9",
    preset: "qq-unified",
    provider: "fixture-provider",
    model: "fixture-default",
    functionalAgentOnly: true,
  });
  cfg.agents[0].functionalAgents = {
    qq: { kind: "qq-dialogue", delegatesTo: ["memory"] },
    memory: {
      kind: "memory",
      enabled: true,
      backendId: "fixture-recall",
      model: "fixture-child",
    },
  };
  const f = fixture(t, {
    cfg: validateConfig(cfg),
    run: async ({ prompt, modelSelection, callTool }) => {
      assert.equal(modelSelection.model, "fixture-child");
      const token = /context=([A-Za-z0-9_-]+)/.exec(prompt)?.[1];
      const child = f.runtime.capability(token);
      assert.notEqual(child.token, parent.token);
      assert.equal(child.functionalAgent.key, "memory");
      assert.equal(child.backendInputEpoch, child.inputEpoch);
      const available = scopedCatalog(f.runtime, child, {}).tools.map(
        ({ name }) => name,
      );
      assert.ok(available.includes("functional_agent_result"));
      assert.ok(!available.includes("qq_send"));
      const result = await callTool("memory_search", {
        conversation: "group:20001",
      });
      assert.deepEqual(
        result.items.map(({ id }) => id),
        [same.id],
      );
      await assert.rejects(
        callTool("memory_read", { id: other.id }),
        /RECALL_SOURCE_NOT_ALLOWED/,
      );
      await callTool("memory_read", { id: same.id });
      await assert.rejects(
        callTool("memory_read", { id: same.id }),
        /FUNCTIONAL_AGENT_TOOL_BUDGET/,
      );
      await assert.rejects(
        callTool("functional_agent_result", { evidenceIds: [other.id] }),
        /RECALL_SOURCE_NOT_ALLOWED/,
      );
      await callTool("functional_agent_result", { evidenceIds: [same.id] });
    },
  });
  const memory = f.store.bind("agent-0");
  const append = (group) =>
    memory.append({
      connectionId: "qq-0",
      conversation: "group:" + group,
      dedupe: "seed-" + group,
      kind: "message.received",
      direction: "in",
      status: "observed",
      senderId: "30000",
      body: "合成消息",
    });
  const same = append("20000");
  const other = append("20001");
  memory.append({
    connectionId: "qq-0",
    conversation: "group:20000",
    dedupe: "pending-send",
    kind: "message.sent",
    direction: "out",
    status: "pending",
    body: "未确认消息",
  });
  const parent = f.runtime.makeContext("agent-0", "group:20000");
  const before = memory.state("group:20000");
  const result = await f.runtime.functionalDelegation.run(parent, "memory", {
    prompt: "查证本轮相关原话",
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.evidenceIds, [same.id]);
  assert.deepEqual(memory.state("group:20000"), before);
  assert.equal(parent.privateRead.size, 0);
  assert.equal(f.runtime.transports.get("qq-0").sent.length, 0);
});
