import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import {
  AntigravityBackend,
  antigravityShellQuote,
} from "../src/backends/antigravity.mjs";
import { validateConfig } from "../src/core/config.mjs";

const { values } = parseArgs({
  options: {
    "allow-real-models": { type: "boolean" },
    command: { type: "string", default: "agy" },
    model: { type: "string" },
  },
});
if (!values["allow-real-models"] || !values.model)
  throw Error("ANTIGRAVITY_ACCEPTANCE_REQUIRES_OPT_IN_AND_MODEL");

// Always create a fresh private tree. No QQ transport, production configuration,
// or user-selected existing data directory is loaded by this acceptance runner.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "qq-agy-acceptance-"));
fs.chmodSync(root, 0o700);
// An ancestor hook must never run, even when private data lives in a repository.
execFileSync("git", ["init", "--quiet", "--template=", root]);
fs.mkdirSync(path.join(root, ".agents"));
const canary = path.join(root, "ancestor-hook-ran");
const hook = path.join(root, "ancestor-hook.mjs");
fs.writeFileSync(
  hook,
  `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(canary)}, "loaded"); console.log(JSON.stringify({decision:"deny"}));`,
  { mode: 0o600 },
);
fs.writeFileSync(
  path.join(root, ".agents", "hooks.json"),
  JSON.stringify({
    ancestor: {
      PreToolUse: [
        {
          matcher: "*",
          hooks: [
            {
              type: "command",
              command: [process.execPath, hook]
                .map((v) => antigravityShellQuote(v))
                .join(" "),
              timeout: 5,
            },
          ],
        },
      ],
    },
  }),
  { mode: 0o600 },
);
const config = validateConfig({
  version: 1,
  mode: "isolated",
  connections: [],
  agents: [],
  backends: [
    {
      id: "acceptance",
      label: "Acceptance",
      type: "antigravity",
      command: values.command,
      model: values.model,
      effort: "",
    },
  ],
}).backends[0];
const backend = new AntigravityBackend(config, { id: "acceptance" }, { root });
const tools = [
  {
    name: "probe_echo",
    description: "Echo a synthetic marker.",
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
  },
  {
    name: "probe_wait",
    description: "Wait until this test is cancelled.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "probe_send",
    description: "Record a synthetic send in memory. No QQ connection exists.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];
const sessions = new Map(),
  results = [];
let sends = 0;
async function run(name, conversation, prompt, cancel = false) {
  const controller = new AbortController(),
    calls = [];
  const previous = sessions.get(conversation);
  let waitStarted = false,
    failure;
  const timer = setTimeout(() => controller.abort(), 180000);
  try {
    await backend.run({
      conversation,
      tools,
      prompt,
      instructions:
        "You are a protocol test agent. Follow the current prompt using only provided MCP tools.",
      session: previous,
      saveSession: (s) => sessions.set(conversation, s),
      signal: controller.signal,
      callTool: async (tool, args) => {
        if (
          tool === "probe_echo" &&
          (typeof args.value !== "string" ||
            Object.keys(args).some((k) => k !== "value"))
        )
          throw Error("INVALID_TOOL_ARGUMENTS");
        calls.push({ name: tool, value: args.value });
        if (tool === "probe_send") sends++;
        if (tool === "probe_wait") {
          waitStarted = true;
          if (cancel) setTimeout(() => controller.abort(), 50);
          await new Promise((resolve) =>
            controller.signal.addEventListener("abort", resolve, {
              once: true,
            }),
          );
          throw Error("ABORTED");
        }
        return { value: args.value || "ok" };
      },
    });
  } catch (error) {
    failure = error;
  } finally {
    clearTimeout(timer);
  }
  if (cancel) {
    if (!waitStarted && failure) throw failure;
    assert(waitStarted, "WAIT_TOOL_NOT_REACHED");
    assert.equal(failure?.message, "ABORTED");
    assert.equal(sessions.get(conversation), null);
  } else if (failure) throw failure;
  const continued = previous
    ? previous.id === sessions.get(conversation)?.id
    : false;
  results.push({ case: name, completed: true, continued });
  console.log(JSON.stringify(results.at(-1)));
  return calls;
}
try {
  await backend.health();
  const marker = "SYNTHETIC_MARKER_93AC";
  const first = await run(
    "initial",
    "private:synthetic-a",
    `Call probe_echo with value ${marker} and remember it for the next turn.`,
  );
  assert(first.some((c) => c.name === "probe_echo" && c.value === marker));
  const resumed = await run(
    "resume",
    "private:synthetic-a",
    "Call probe_echo with the exact marker from your previous turn.",
  );
  assert(results.at(-1).continued);
  assert(resumed.some((c) => c.name === "probe_echo" && c.value === marker));
  const isolated = await run(
    "separate-conversation",
    "private:synthetic-b",
    'If you remember a marker from a previous turn, call probe_echo with it in the value argument. Otherwise call probe_echo with arguments {"value":"NO_PREVIOUS_MARKER"}.',
  );
  assert(
    isolated.some(
      (c) => c.name === "probe_echo" && c.value === "NO_PREVIOUS_MARKER",
    ),
  );
  const oldId = sessions.get("private:synthetic-a").id;
  await run(
    "cancel",
    "private:synthetic-a",
    "Call probe_wait, then only if it succeeds call probe_send.",
    true,
  );
  const recovery = await run(
    "recovery",
    "private:synthetic-a",
    'Call probe_echo with arguments {"value":"RECOVERY_FRESH_ONLY"}. Do not send anything.',
  );
  assert(
    recovery.some(
      (c) => c.name === "probe_echo" && c.value === "RECOVERY_FRESH_ONLY",
    ),
  );
  assert.notEqual(sessions.get("private:synthetic-a").id, oldId);
  assert.equal(sends, 0);
  assert(!fs.existsSync(canary), "ANCESTOR_HOOK_LOADED");
  results.push({ case: "ancestor-configuration-isolation", passed: true });
  results.push({ case: "no-replay-or-send", passed: true });
} catch (error) {
  results.push({ case: "acceptance", passed: false });
  process.exitCode = 1;
  // A failed model assertion may contain private payloads: report only a fixed code.
  console.error(
    error?.category
      ? `ANTIGRAVITY_ACCEPTANCE_${error.category.toUpperCase().replaceAll("-", "_")}`
      : /^ANTIGRAVITY_[A-Z_]+$/.test(error?.message || "")
        ? error.message
        : "ANTIGRAVITY_ACCEPTANCE_FAILED",
  );
} finally {
  await backend.close();
  fs.writeFileSync(
    path.join(root, "acceptance-summary.json"),
    JSON.stringify(results, null, 2) + "\n",
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({ passed: !process.exitCode, privateEvidence: root }),
  );
}
