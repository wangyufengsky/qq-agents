import test from "node:test";
import assert from "node:assert/strict";
import { configImpact } from "../src/core/config-impact.mjs";
import { config, fixture, context } from "./helpers.mjs";

const adapter = (close = async () => {}) => {
  const b = { closed: 0, cancel: async () => {} };
  b.close = async () => {
    b.closed++;
    await close();
  };
  return b;
};

test("pause flags are controls and per-turn fields keep the backend adapter", () => {
  const before = config(2);
  const pause = structuredClone(before);
  pause.globalPaused = true;
  pause.agents[0].paused = true;
  let impact = configImpact(before, pause);
  assert.equal(impact.agentIds.size, 0);
  assert.deepEqual([...impact.paused].sort(), ["agent-0", "agent-1"]);
  impact = configImpact(pause, before);
  assert.deepEqual([...impact.resumed].sort(), ["agent-0", "agent-1"]);

  const tools = structuredClone(before);
  tools.agents[0].tools = tools.agents[0].tools.filter((n) => n !== "qq_send");
  impact = configImpact(before, tools);
  assert.deepEqual([...impact.agentIds], ["agent-0"]);
  assert.equal(impact.backendAgentIds.size, 0);

  const model = structuredClone(before);
  model.agents[0].model = "other-model";
  impact = configImpact(before, model);
  assert.deepEqual([...impact.backendAgentIds], ["agent-0"]);
});

test("pausing cancels turns without closing backends; resuming refreshes due work", async (t) => {
  const { runtime } = fixture(t);
  const backend = adapter();
  runtime.backends.set("agent-0", backend);
  const ctx = context(runtime);
  const revision = runtime.configStore.revision;
  await runtime.pause("agent-0", true);
  assert.equal(ctx.controller.signal.aborted, true);
  assert.equal(runtime.capabilities.has(ctx.token), false);
  assert.equal(backend.closed, 0);
  assert.equal(runtime.backends.get("agent-0"), backend);
  assert.notEqual(runtime.configStore.revision, revision);
  const rebuilt = [];
  const rebuild = runtime.memory.due.rebuild.bind(runtime.memory.due);
  runtime.memory.due.rebuild = (id) => {
    rebuilt.push(id);
    return rebuild(id);
  };
  await runtime.pause("agent-0", false);
  assert.deepEqual(rebuilt, ["agent-0"]);
  const other = context(runtime, "agent-1", "group:20000");
  await runtime.pause("all", true);
  assert.equal(other.controller.signal.aborted, true);
  assert.equal(backend.closed, 0);
});

test("pause waits out an in-flight config edit and keeps that edit", async (t) => {
  const { runtime } = fixture(t);
  let release;
  runtime.backends.set(
    "agent-0",
    adapter(() => new Promise((resolve) => (release = resolve))),
  );
  const next = structuredClone(runtime.config);
  next.agents[0].model = "edited-model";
  const edit = runtime.changeConfig(next, runtime.configStore.revision);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.configChanging, true);
  const pausing = runtime.pause("agent-1", true);
  // A non-control edit still fails fast during the commit.
  await assert.rejects(
    runtime.changeFilePermissions(
      "agent-1",
      { enabled: true },
      runtime.configStore.revision,
    ),
    /CONFIG_CONFLICT/,
  );
  release();
  await edit;
  assert.deepEqual(await pausing, { paused: true });
  assert.equal(runtime.agent("agent-0").model, "edited-model");
  assert.equal(runtime.agent("agent-1").paused, true);
});

test("permission changes are validated, gated and revoke turns but keep the adapter", async (t) => {
  const { runtime } = fixture(t);
  const backend = adapter();
  runtime.backends.set("agent-0", backend);
  const ctx = context(runtime);
  const result = await runtime.changeFilePermissions(
    "agent-0",
    { enabled: true },
    runtime.configStore.revision,
  );
  assert.equal(result.files.enabled, true);
  assert.equal(ctx.controller.signal.aborted, true);
  assert.equal(backend.closed, 0);
  await assert.rejects(
    runtime.changeAppPermissions("agent-0", { enabled: true }, 0),
    /CONFIG_CONFLICT/,
  );
  await assert.rejects(
    runtime.changeAppPermissions(
      "missing",
      { enabled: true },
      runtime.configStore.revision,
    ),
    /UNKNOWN_AGENT/,
  );
});

test("saving unchanged app or file permissions keeps the tool order and the turn", async (t) => {
  const { runtime } = fixture(t);
  await runtime.changeAppPermissions(
    "agent-0",
    { enabled: true },
    runtime.configStore.revision,
  );
  await runtime.changeFilePermissions(
    "agent-0",
    { enabled: true },
    runtime.configStore.revision,
  );
  // Put an existing tool after the feature tools, as older configs may have.
  const next = structuredClone(runtime.config);
  const tools = next.agents[0].tools;
  tools.push(tools.splice(tools.indexOf("memory_search"), 1)[0]);
  await runtime.changeConfig(next, runtime.configStore.revision);
  const before = [...runtime.agent("agent-0").tools];
  const ctx = context(runtime);
  await runtime.changeAppPermissions(
    "agent-0",
    runtime.agent("agent-0").apps,
    runtime.configStore.revision,
  );
  await runtime.changeFilePermissions(
    "agent-0",
    runtime.agent("agent-0").files,
    runtime.configStore.revision,
  );
  assert.deepEqual(runtime.agent("agent-0").tools, before);
  assert.equal(ctx.controller.signal.aborted, false);
});
