import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ConfigStore, validateConfig } from "../src/core/config.mjs";
import { defaultConfig } from "../src/core/default-config.mjs";
import { temp } from "./helpers.mjs";

test("new installations persist an enabled board while retaining isolation and home opt-in", (t) => {
  const file = path.join(temp(t), "config.json");
  const store = new ConfigStore(file, defaultConfig());
  assert.equal(store.value.board.enabled, true);
  assert.equal(store.value.mode, "isolated");
  assert.equal(store.value.globalPaused, true);
  assert.ok(store.value.agents.every((a) => a.paused && !a.home.enabled));
  assert.equal(
    new ConfigStore(file, defaultConfig()).value.board.enabled,
    true,
  );
});

for (const mode of [
  "missing-board",
  "missing-enabled",
  "enabled",
  "disabled",
]) {
  test(`persisted ${mode} retains its effective board policy across open and save`, (t) => {
    const file = path.join(temp(t), "config.json"),
      legacy = defaultConfig();
    if (mode === "missing-board") delete legacy.board;
    else if (mode === "missing-enabled") delete legacy.board.enabled;
    else legacy.board.enabled = mode === "enabled";
    fs.writeFileSync(file, JSON.stringify(legacy));
    const expected = mode === "enabled";
    assert.equal(validateConfig(legacy).board.enabled, expected);
    const store = new ConfigStore(file, defaultConfig());
    assert.equal(store.value.board.enabled, expected);
    store.save(store.value, store.revision);
    assert.equal(
      JSON.parse(fs.readFileSync(file, "utf8")).board.enabled,
      expected,
    );
    assert.equal(
      new ConfigStore(file, defaultConfig()).value.board.enabled,
      expected,
    );
  });
}
