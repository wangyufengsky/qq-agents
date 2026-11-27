import test from "node:test";
import assert from "node:assert/strict";
import { TOOL_NAMES, toolSpecs, dispatchTool } from "../src/tools/index.mjs";
import {
  DESKTOP_ACTIVITY_DECISION,
  DESKTOP_DECISION,
  FUNCTIONAL_AGENT_RESULT,
  DREAM_LIST,
  DREAM_SUBMIT,
} from "../src/tools/names.mjs";
import { registry } from "../src/tools/registry.mjs";
import { fixture } from "./helpers.mjs";

test("every advertised tool has exactly one schema and handler, and unknown/prototype names fail closed", async (t) => {
  assert.deepEqual(
    toolSpecs().map((tool) => tool.name),
    Object.keys(registry).filter(
      (name) =>
        ![
          FUNCTIONAL_AGENT_RESULT,
          DREAM_LIST,
          DREAM_SUBMIT,
          DESKTOP_ACTIVITY_DECISION,
          DESKTOP_DECISION,
        ].includes(name),
    ),
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

test("discovery describes accepted input before defaults and preserves source constraints", () => {
  const names = [
    "media_list",
    "github_read",
    "board_read",
    "qq_voice_read",
    "file_download",
    "image_save",
    "qq_profile_update",
  ];
  const specs = Object.fromEntries(
    toolSpecs(names).map((t) => [t.name, t.inputSchema]),
  );
  for (const name of ["media_list", "board_read"]) {
    assert.equal(registry[name].schema.safeParse({}).success, true);
    assert.deepEqual(specs[name].required ?? [], []);
  }
  assert.deepEqual(specs.github_read.required, ["repository"]);
  for (const [name, fields] of Object.entries({
    qq_voice_read: ["audioId", "eventId"],
    file_download: ["url", "eventId"],
    image_save: ["url", "fileId"],
    qq_profile_update: ["nickname", "signature", "mediaId"],
  }))
    assert.deepEqual(
      specs[name].oneOf.map((option) => option.required),
      fields.map((field) => [field]),
    );
});
