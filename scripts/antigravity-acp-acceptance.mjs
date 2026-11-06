import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomInt, randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { AntigravityBackend } from "../src/backends/antigravity.mjs";
import { validateConfig } from "../src/core/config.mjs";
import { colorGrid } from "./fixtures/antigravity-media.mjs";
const { values } = parseArgs({
  options: {
    "allow-real-models": { type: "boolean" },
    command: { type: "string" },
    model: { type: "string" },
  },
});
if (!values["allow-real-models"] || !values.command || !values.model)
  throw Error("ANTIGRAVITY_ACCEPTANCE_REQUIRES_OPT_IN_AND_MODEL");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "qq-acp-acceptance-"));
fs.chmodSync(root, 0o700);
const config = validateConfig({
  version: 1,
  mode: "isolated",
  agents: [],
  connections: [],
  backends: [
    {
      id: "probe",
      label: "Probe",
      type: "antigravity",
      command: values.command,
      model: values.model,
      effort: "low",
      cliProtocol: "acp",
    },
  ],
}).backends[0];
const marker = randomUUID();
const tools = [
  {
    name: "probe_image",
    description: "Read the current synthetic image.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "probe_answer",
    description: "Record the four colors in reading order.",
    inputSchema: {
      type: "object",
      properties: {
        marker: { type: "string" },
        colors: {
          type: "array",
          items: { type: "string" },
          minItems: 4,
          maxItems: 4,
        },
      },
      required: ["colors", "marker"],
      additionalProperties: false,
    },
  },
];
let session = null;
const results = [];
try {
  for (let round = 0; round < 2; round++) {
    const backend = new AntigravityBackend(config, { id: "probe" }, { root });
    const colors = ["red", "green", "blue", "yellow"];
    for (let n = 3; n > 0; n--) {
      const j = randomInt(n + 1);
      [colors[n], colors[j]] = [colors[j], colors[n]];
    }
    const calls = [];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 180000);
    const prior = session?.id;
    try {
      await backend.run({
        conversation: "private:10000",
        tools,
        session,
        signal: controller.signal,
        instructions: round
          ? undefined
          : `You are a synthetic image test. Use only the provided tools. No QQ transport exists. The instruction marker is ${marker}. Always pass it as marker to probe_answer.`,
        prompt:
          "Call probe_image once. Inspect its NEW pixels and call probe_answer with the four colors in reading order: top-left, top-right, bottom-left, bottom-right. Do not read any files. Do not reuse previous colors. Include the instruction marker in probe_answer. Then finish.",
        saveSession: (value) => {
          session = value;
        },
        callTool: async (name, args) => {
          calls.push(name);
          if (name === "probe_image")
            return {
              content: [
                {
                  type: "image",
                  mimeType: "image/png",
                  data: colorGrid(colors).toString("base64"),
                },
              ],
            };
          assert.equal(name, "probe_answer");
          assert.deepEqual(args.colors, colors);
          assert.equal(args.marker, marker);
          return { ok: true };
        },
      });
      assert.deepEqual(calls, ["probe_image", "probe_answer"]);
      assert(session);
      if (prior) assert.equal(session.id, prior);
      results.push({ round, passed: true, sessionReused: !!prior, calls });
    } finally {
      clearTimeout(timer);
      await backend.close();
    }
  }
  console.log(JSON.stringify({ passed: true, rounds: results }));
} finally {
  fs.writeFileSync(path.join(root, "summary.json"), JSON.stringify(results));
  console.log("Evidence: " + root);
}
