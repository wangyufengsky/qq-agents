import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { FileStore } from "../src/tools/files.mjs";
import { validateConfig } from "../src/core/config.mjs";
import {
  defaultConfig,
  defaultAgentCapabilities,
} from "../src/core/default-config.mjs";
import { TOOL_NAMES } from "../src/tools/specs.mjs";
import { APP_NAMES } from "../src/apps/urls.mjs";
import { config, fixture, context } from "./helpers.mjs";

test("new roles enable the complete tool catalog and capability switches while retaining setup requirements", () => {
  const cfg = validateConfig(defaultConfig());
  for (const agent of cfg.agents) {
    assert.deepEqual(agent.tools, TOOL_NAMES);
    for (const name of [
      "apps",
      "files",
      "github",
      "scheduler",
      "crossGroup",
      "operations",
    ])
      assert.equal(agent[name].enabled, true, name);
    assert.equal(agent.voice.tts.enabled, true);
    assert.equal(agent.network.autonomous, true);
    assert.equal(agent.apps.sharing, true);
    assert.deepEqual(agent.apps.platforms, APP_NAMES);
    assert.equal(agent.voice.asr.enabled, false);
    assert.equal(agent.voice.asr.serverId, "");
    assert.equal(agent.operations.workspace, "");
    assert.equal(agent.operations.allowL3, false);
    assert.deepEqual(agent.operations.allowedCommands, []);
    assert.deepEqual(agent.crossGroup.links, []);
    assert.deepEqual(agent.files.localRoots, []);
    assert.deepEqual(agent.github.privateRepositories, []);
    assert.equal(agent.paused, true);
    assert.deepEqual(agent.allow, { groups: [], users: [] });
  }
  assert.equal(cfg.globalPaused, true);
  assert.equal(cfg.mode, "isolated");
  assert(cfg.connections.every((c) => !c.enabled));
  const form = defaultAgentCapabilities();
  for (const [key, value] of Object.entries(form))
    assert.deepEqual(value, cfg.agents[0][key]);
  form.tools.pop();
  assert.deepEqual(defaultAgentCapabilities().tools, TOOL_NAMES);
});

test("saved opt-outs and a deliberately empty tool list survive validation", () => {
  const cfg = config(1);
  cfg.agents[0].tools = [];
  const agent = validateConfig(cfg).agents[0];
  assert.deepEqual(agent.tools, []);
  for (const name of [
    "apps",
    "files",
    "github",
    "scheduler",
    "crossGroup",
    "operations",
  ])
    assert.equal(agent[name].enabled, false, name);
  assert.equal(agent.voice.tts.enabled, false);
  assert.equal(agent.network.autonomous, false);
  assert.equal(agent.apps.sharing, false);
  assert.deepEqual(agent.apps.platforms, []);
});

test("enabled tools remain subject to conversation and directory boundaries", async (t) => {
  const cfg = config(1);
  Object.assign(cfg.agents[0], defaultAgentCapabilities());
  cfg.agents[0].ownerIds = ["30000"];
  const f = fixture(t, { cfg });
  f.runtime.files = new FileStore(path.join(f.root, "files"));
  const agent = f.runtime.agent("agent-0");
  const chat = f.runtime.toolsFor(agent, "group:20000");
  for (const name of [
    "qq_image_read",
    "voice_synthesize",
    "file_create",
    "app_search",
    "github_read",
  ])
    assert(chat.includes(name), name);
  assert(!chat.includes("ops_read"));
  assert(!chat.includes("protected_work_submit"));
  assert(!chat.includes("qq_schedule_create"));
  assert(
    f.runtime.toolsFor(agent, "private:30000").includes("qq_schedule_create"),
  );
  await assert.rejects(
    f.runtime.callTool(context(f.runtime), "file_import", {
      rootIndex: 0,
      relativePath: "fixture.txt",
    }),
    /FILE_PATH_DENIED/,
  );
  const ctx = context(f.runtime);
  const saved = await f.runtime.callTool(ctx, "file_create", {
    name: "fixture.txt",
    text: "独立文件库可正常读写",
  });
  const read = await f.runtime.callTool(ctx, "file_read", {
    fileId: saved.fileId,
  });
  assert.equal(read.text, "独立文件库可正常读写");
});

test("a complete default selection does not expose native image generation on an unsupported backend", (t) => {
  const cfg = config(1);
  cfg.backends[0] = {
    id: "fixture",
    type: "openai",
    label: "Fixture",
    baseUrl: "https://example.com/v1",
    model: "fixture",
  };
  Object.assign(cfg.agents[0], defaultAgentCapabilities());
  const f = fixture(t, { cfg });
  assert(
    !f.runtime
      .toolsFor(f.runtime.agent("agent-0"), "group:20000")
      .includes("generated_image_list"),
  );
});
