import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "js-yaml";
import { temp } from "./helpers.mjs";

test("DSH retained preset revisions have private compaction realms shared by engine and command", (t) => {
  const out = path.join(temp(t), "bundle");
  execFileSync(process.execPath, ["scripts/dsh-bundle.mjs", "--out", out]);
  const patch = YAML.load(
    fs.readFileSync(path.join(out, "unified.patch.yml"), "utf8"),
  );
  const preset = patch[0].insert.find((x) => x.id === "preset-qq-unified");
  const group = preset.config.plugins.find(
    (x) => x.group && x.isolate?.compaction === true,
  );
  assert.ok(
    group,
    "each retained revision needs a fresh boolean isolation realm, not a globally named realm",
  );
  const engine = group.config.find(
    (x) => x.name === "@deepseek-ai/dsh-compaction-basic",
  );
  const command = group.config.find(
    (x) => x.name === "@deepseek-ai/dsh-command-compact",
  );
  assert.ok(
    engine && command,
    "manual compact must consume the same isolated service",
  );
  assert.equal(engine.config.auto, false);
  assert.equal(engine.config.thresholdRatio, 0.75);
  assert.equal(engine.isolate, undefined);
  assert.equal(command.isolate, undefined);
});
