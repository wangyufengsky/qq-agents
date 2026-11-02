import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { validateConfig } from "../src/core/config.mjs";
import { defaultConfig } from "../src/core/default-config.mjs";

const form = vm.runInNewContext(
  fs.readFileSync(new URL("../public/agent-form.js", import.meta.url), "utf8") +
    "\n;agentForm",
  { tools: [] },
);

test("peer qzone editor keeps its independent switch when omitted and supports explicit enable and disable", () => {
  const original = validateConfig(defaultConfig()).agents[0];
  original.behavior.actions.peerQzone = true;
  original.behavior.actions.qzone = false;
  const submitted = new FormData();
  let parsed = form.parse(submitted, original).row;
  assert.equal(parsed.behavior.actions.peerQzone, true);
  submitted.set("peerQzonePresent", "1");
  parsed = form.parse(submitted, original).row;
  assert.equal(parsed.behavior.actions.peerQzone, false);
  assert.equal(parsed.behavior.actions.qzone, false);
  submitted.set("peerQzoneEnabled", "on");
  parsed = form.parse(submitted, original).row;
  assert.equal(parsed.behavior.actions.peerQzone, true);
  assert.equal(parsed.behavior.actions.qzone, false);
});
