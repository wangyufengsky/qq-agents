import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { config, temp, FakeTransport } from "./helpers.mjs";
import { ConfigStore } from "../src/core/config.mjs";
import { MemoryStore } from "../src/memory/store.mjs";
import { Runtime } from "../src/core/runtime.mjs";
import { createServer } from "../src/server.mjs";

// Slang learning was removed in 0.5.3. Configs saved before that still give
// every agent a `slang` block and may list `slang_*` tools.
const SLANG_TOOLS = ["slang_query", "slang_submit", "slang_research"];
function legacyConfig() {
  const c = structuredClone(config(2));
  for (const a of c.agents) {
    a.slang = {
      enabled: false,
      autoResearch: false,
      minMessages: 10,
      cooldownMs: 300000,
      maxCandidates: 200,
      researchServerId: "",
      researchArguments: {},
      researchQueryField: "query",
      researchTool: "",
    };
    a.tools.push(...SLANG_TOOLS);
  }
  c.agents[1].slang.enabled = true;
  return c;
}
const writeLegacy = (t) => {
  const file = path.join(temp(t), "config.json");
  fs.writeFileSync(file, JSON.stringify(legacyConfig(), null, 2));
  return file;
};
const noSlang = (c) => {
  for (const a of c.agents) {
    assert.equal(Object.hasOwn(a, "slang"), false);
    assert.equal(
      a.tools.some((n) => n.startsWith("slang_")),
      false,
    );
  }
};

test("a pre-0.5.3 config loads without its slang settings and the next save stops writing them", (t) => {
  const file = writeLegacy(t);
  const store = new ConfigStore(file);
  noSlang(store.value);
  assert.deepEqual(store.migrationWarnings, []);
  // The other tools keep their order.
  assert.deepEqual(store.value.agents[0].tools, config(1).agents[0].tools);
  // Loading alone leaves the file as it was; only a save rewrites it.
  assert.match(fs.readFileSync(file, "utf8"), /slang/);
  store.save(structuredClone(store.value), store.revision);
  assert.doesNotMatch(fs.readFileSync(file, "utf8"), /slang/);
  noSlang(new ConfigStore(file).value);
});

test("a save that still carries slang settings is accepted and written without them", (t) => {
  const file = writeLegacy(t);
  const store = new ConfigStore(file);
  // For example a console page opened before the upgrade.
  store.save(legacyConfig(), store.revision);
  noSlang(store.value);
  assert.doesNotMatch(fs.readFileSync(file, "utf8"), /slang/);
});

test("the runtime and console start from a pre-0.5.3 config without offering slang", async (t) => {
  const file = writeLegacy(t),
    memory = new MemoryStore(path.join(path.dirname(file), "memory.sqlite")),
    configStore = new ConfigStore(file),
    runtime = new Runtime({
      memory,
      configStore,
      backendFactory: () => ({ close: async () => {} }),
      transportFactory: () => new FakeTransport(),
    });
  for (const c of configStore.value.connections)
    runtime.transports.set(c.id, new FakeTransport());
  const token = "synthetic-admin",
    app = createServer({ runtime, token, allowLive: true });
  const port = await app.listen();
  t.after(async () => {
    await app.close();
    await runtime.close();
    memory.close();
  });
  const request = (pathname, options = {}) =>
    fetch(`http://127.0.0.1:${port}${pathname}`, {
      ...options,
      headers: { "x-admin-token": token, "content-type": "application/json" },
    });
  for (const a of runtime.config.agents)
    for (const conversation of ["group:20000", "private:30000", "@subject"])
      assert.equal(
        runtime.toolsFor(a, conversation).some((n) => n.startsWith("slang_")),
        false,
      );
  const loaded = await (await request("/api/config")).json();
  noSlang(loaded.config);
  assert.equal(
    loaded.tools.some((n) => n.startsWith("slang_")),
    false,
  );
  assert.equal(Object.hasOwn(loaded, "features"), false);
  assert.equal((await request("/api/slang?agentId=agent-0")).status, 404);
  const saved = await request("/api/config", {
    method: "PUT",
    body: JSON.stringify({ config: legacyConfig(), revision: loaded.revision }),
  });
  assert.equal(saved.status, 200);
  noSlang(runtime.config);
  assert.doesNotMatch(fs.readFileSync(file, "utf8"), /slang/);
});
