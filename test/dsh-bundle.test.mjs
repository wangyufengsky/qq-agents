import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import * as YAML from "js-yaml";
import { temp, relayEnvironment } from "./helpers.mjs";
import { deriveRelayToken, readRelayToken } from "../src/core/relay-auth.mjs";

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

test("DSH bundle points only to the data directory's private derived relay credential", (t) => {
  const root = temp(t);
  const data = path.join(root, "isolated-data");
  const out = path.join(root, "bundle");
  execFileSync(process.execPath, [
    "scripts/dsh-bundle.mjs",
    "--out",
    out,
    "--data",
    data,
  ]);
  const patch = YAML.load(
    fs.readFileSync(path.join(out, "unified.patch.yml"), "utf8"),
  );
  const env = patch[0].insert.find((x) => x.id === "qq-unified-mcp").config.env;
  assert.equal(env.QQ_UNIFIED_RELAY_TOKEN_FILE, path.join(data, "relay-token"));
  assert.equal(fs.existsSync(env.QQ_UNIFIED_RELAY_TOKEN_FILE), false);

  const token = "fixture-administrator-key";
  fs.mkdirSync(data);
  assert.deepEqual(relayEnvironment(data, token), {
    QQ_UNIFIED_RELAY_TOKEN_FILE: env.QQ_UNIFIED_RELAY_TOKEN_FILE,
  });
  assert.equal(
    readRelayToken(env.QQ_UNIFIED_RELAY_TOKEN_FILE),
    deriveRelayToken(token),
  );
  assert.notEqual(readRelayToken(env.QQ_UNIFIED_RELAY_TOKEN_FILE), token);
  if (process.platform !== "win32")
    assert.equal(
      fs.statSync(env.QQ_UNIFIED_RELAY_TOKEN_FILE).mode & 0o777,
      0o600,
    );
});
