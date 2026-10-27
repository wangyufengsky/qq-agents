import test from "node:test";
import assert from "node:assert/strict";
import { TOOL_NAMES, toolSpecs, dispatchTool } from "../src/tools/index.mjs";
import { registry } from "../src/tools/registry.mjs";
import { fixture } from "./helpers.mjs";

test("every advertised tool has exactly one schema and handler, and unknown/prototype names fail closed", async (t) => {
  assert.deepEqual(
    toolSpecs().map((tool) => tool.name),
    Object.keys(registry),
  );
  for (const name of TOOL_NAMES) {
    assert.equal(typeof registry[name].handler, "function");
    assert.equal(typeof registry[name].schema.parse, "function");
  }
  assert.deepEqual(toolSpecs(["toString", "__proto__", "unknown"]), []);
  const f = fixture(t),
    ctx = f.runtime.makeContext("agent-0", "group:20000");
  for (const name of ["toString", "__proto__", "unknown"])
    await assert.rejects(
      dispatchTool(f.runtime, ctx, name, {}),
      /UNKNOWN_TOOL/,
    );
  await assert.rejects(
    dispatchTool(f.runtime, ctx, "qq_send", { text: "missing request id" }),
  );
  await assert.rejects(
    dispatchTool(f.runtime, ctx, "qq_send", {
      requestId: "synthetic",
      text: ctx.token,
    }),
    /CAPABILITY_EXFILTRATION_BLOCKED/,
  );
  assert.equal(f.runtime.transports.get("qq-0").sent.length, 0);
});
