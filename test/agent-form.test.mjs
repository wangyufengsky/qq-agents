import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { TOOL_NAMES } from "../src/tools/index.mjs";
import { FILE_TOOL_NAMES } from "../src/tools/file-tools.mjs";
import { appDefinitions } from "../src/apps/tools.mjs";

const agentForm = vm.runInNewContext(
  fs.readFileSync(new URL("../public/agent-form.js", import.meta.url), "utf8") +
    "\n;agentForm",
);

test("every tool belongs to exactly one agent editor group", () => {
  for (const name of TOOL_NAMES) {
    const owners = agentForm.groups.filter((g) => Object.hasOwn(g.tools, name));
    assert.equal(owners.length, 1, `${name} is in ${owners.length} groups`);
  }
  const listed = [...agentForm.groups].flatMap((g) => Object.keys(g.tools));
  assert.deepEqual(
    listed.filter((name) => !TOOL_NAMES.includes(name)),
    [],
    "groups list tools that no longer exist",
  );
  for (const g of agentForm.groups)
    for (const [name, label] of Object.entries(g.tools))
      assert.ok(label && label !== name, `${name} needs a Chinese label`);
  assert.equal(agentForm.groupOf("not_a_tool"), "other");
});

test("managed groups match the tools their pages rewrite", () => {
  const managed = (policy) =>
    Object.keys(
      agentForm.groups.find((g) => g.managedBy?.policy === policy).tools,
    ).sort();
  assert.deepEqual(managed("files"), [...FILE_TOOL_NAMES].sort());
  assert.deepEqual(managed("apps"), Object.keys(appDefinitions).sort());
});
