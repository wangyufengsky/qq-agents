import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { parseArgs } from "node:util";
import crossSpawn from "cross-spawn";
import { AntigravityBackend } from "../src/backends/antigravity.mjs";
import { ConfigStore, validateConfig } from "../src/core/config.mjs";
import { Runtime } from "../src/core/runtime.mjs";
import { MemoryStore } from "../src/memory/store.mjs";

const { values } = parseArgs({
  options: {
    "allow-real-models": { type: "boolean" },
    command: { type: "string", default: "agy" },
    model: { type: "string" },
    "max-first-send-ms": { type: "string", default: "30000" },
  },
});
if (!values["allow-real-models"] || !values.model)
  throw Error("ANTIGRAVITY_ACCEPTANCE_REQUIRES_OPT_IN_AND_MODEL");
const maxFirstSendMs = Number(values["max-first-send-ms"]);
assert(Number.isFinite(maxFirstSendMs) && maxFirstSendMs > 0);
// No existing configuration, chat, login profile or QQ transport is opened.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "qq-agy-chat-acceptance-"));
fs.chmodSync(root, 0o700);
const cfg = validateConfig({
  version: 1,
  mode: "live",
  globalPaused: false,
  connections: [
    {
      id: "synthetic",
      label: "Synthetic",
      accountId: "10000",
      httpUrl: "http://127.0.0.1:9",
      wsUrl: "ws://127.0.0.1:9",
      enabled: true,
    },
  ],
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
  agents: [
    {
      id: "acceptance",
      name: "验收角色",
      connectionId: "synthetic",
      backendId: "acceptance",
      paused: false,
      ownerIds: ["30000"],
      persona: "你是一名友好的聊天伙伴，使用简洁中文回答。",
      allow: { groups: ["20000"], users: ["30000"] },
      subject: { enabled: false },
      wake: { cooldownMs: 0 },
      behavior: { turnTimeoutMs: 180000 },
    },
  ],
});
const store = new MemoryStore(path.join(root, "memory.sqlite"));
const configStore = new ConfigStore(path.join(root, "config.json"), cfg);
const results = [];
let active;
class SyntheticTransport extends EventEmitter {
  connected = true;
  async send(conversation, segments) {
    active.sends.push({ at: Date.now(), conversation, segments });
    return { messageId: String(40000 + active.sends.length) };
  }
  close() {
    this.connected = false;
  }
}
const runtime = new Runtime({
  memory: store,
  configStore,
  transportFactory: () => {
    throw Error("REAL_TRANSPORT_FORBIDDEN");
  },
  backendFactory: (config, agent) => {
    const backend = new AntigravityBackend(config, agent, {
      root,
      spawn(command, args, options) {
        const child = crossSpawn(command, args, options);
        let buffer = "";
        child.stdout?.on("data", (chunk) => {
          buffer += chunk;
          while (buffer.includes("\n")) {
            const end = buffer.indexOf("\n"),
              line = buffer.slice(0, end);
            buffer = buffer.slice(end + 1);
            try {
              const event = JSON.parse(line),
                step = event.step_update;
              if (step?.usage)
                active.steps.push({
                  type: step.step_type,
                  state: step.state,
                  usage: step.usage,
                });
            } catch {
              /* The adapter owns protocol validation. */
            }
          }
        });
        return child;
      },
    });
    const run = backend.run.bind(backend);
    backend.run = (params) =>
      run({
        ...params,
        callTool: (name, args) => {
          // Expose the normal catalogue, but only exercise local chat operations.
          // A model choosing any external action cannot escape this fixture.
          if (
            ![
              "qq_send",
              "qq_send_burst",
              "qq_mark_read",
              "conversation_read",
              "memory_search",
              "memory_read",
            ].includes(name)
          ) {
            active.deniedTools++;
            throw Error("ACCEPTANCE_ACTION_DENIED");
          }
          return params.callTool(name, args);
        },
      });
    return backend;
  },
});
runtime.transports.set("synthetic", new SyntheticTransport());
const mem = store.bind("acceptance");
try {
  for (const [index, body] of [
    "你好！请简短回复一句，带上标记 SYNTHETIC_CHAT_73AC。",
    "接着上句话，刚才的标记是什么？只用一句话回答就好。",
    "好的，再简短打个招呼，我们继续聊。",
  ].entries()) {
    const conversation = "private:30000";
    const incoming = mem.append({
      dedupe: `synthetic-${index}`,
      conversation,
      connectionId: "synthetic",
      kind: "message.received",
      direction: "in",
      senderId: "30000",
      body,
      occurredAt: new Date().toISOString(),
    });
    active = { sends: [], steps: [], deniedTools: 0 };
    const before = mem.state(conversation).session?.id,
      start = Date.now();
    await runtime.wake("acceptance", conversation, {
      reasons: [{ reason: "private" }],
    });
    const state = mem.state(conversation);
    const turn = mem.identity.get("model_turns", state.lastTurnId);
    const row = {
      case: `chat-${index + 1}`,
      toolsAvailable: runtime.toolsFor(cfg.agents[0], conversation).length,
      firstSendMs: active.sends[0] ? active.sends[0].at - start : null,
      totalMs: Date.now() - start,
      sends: active.sends.length,
      continued: !!before && before === state.session?.id,
      sessionKept: !!state.session,
      status: turn.status,
      failedTools: turn.toolCalls
        .filter((c) => !c.ok)
        .map((c) => ({ name: c.name, code: c.code })),
      toolCalls: turn.toolCalls.length,
      deniedTools: active.deniedTools,
      readThroughIncoming: state.readThroughSeq >= incoming.seq,
      usage: state.usage,
      retirementReason: state.lifecycle?.reason || null,
      markerRecalled:
        index !== 1 ||
        active.sends.some((s) =>
          JSON.stringify(s.segments).includes("SYNTHETIC_CHAT_73AC"),
        ),
      steps: active.steps,
    };
    results.push(row);
    console.log(JSON.stringify({ ...row, steps: undefined }));
  }
  for (const [index, r] of results.entries()) {
    assert.equal(r.sends, 1, "ONE_SYNTHETIC_REPLY_REQUIRED");
    assert(r.firstSendMs <= maxFirstSendMs, "FIRST_REPLY_TOO_SLOW");
    assert.equal(r.failedTools.length, 0, "TOOL_ARGUMENT_RETRIES");
    assert.equal(r.deniedTools, 0, "UNRELATED_TOOL_ATTEMPTS");
    assert(r.readThroughIncoming, "INCOMING_NOT_MARKED_READ");
    assert(r.sessionKept, "SESSION_RETIRED_AFTER_CHAT");
    assert(index === 0 || r.continued, "SESSION_NOT_CONTINUED");
    assert(r.markerRecalled, "MARKER_NOT_RECALLED");
  }
} catch {
  process.exitCode = 1;
  console.error("ANTIGRAVITY_CHAT_ACCEPTANCE_FAILED");
} finally {
  await runtime.close();
  store.close();
  fs.writeFileSync(
    path.join(root, "acceptance-summary.json"),
    JSON.stringify(
      {
        passed: !process.exitCode,
        maxFirstSendMs,
        results,
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({ passed: !process.exitCode, privateEvidence: root }),
  );
}
