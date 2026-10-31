import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { parseArgs } from "node:util";
import { AntigravityBackend } from "../src/backends/antigravity.mjs";
import { ConfigStore, validateConfig } from "../src/core/config.mjs";
import { Runtime } from "../src/core/runtime.mjs";
import { MemoryStore } from "../src/memory/store.mjs";

const { values } = parseArgs({
  options: {
    "allow-real-models": { type: "boolean" },
    command: { type: "string", default: "agy" },
    model: { type: "string" },
    "max-first-send-ms": { type: "string", default: "120000" },
  },
});
if (!values["allow-real-models"] || !values.model)
  throw Error("ANTIGRAVITY_ACCEPTANCE_REQUIRES_OPT_IN_AND_MODEL");
const maxFirstSendMs = Number(values["max-first-send-ms"]);
assert(Number.isFinite(maxFirstSendMs) && maxFirstSendMs > 0);
const root = fs.mkdtempSync(
  path.join(os.tmpdir(), "qq-agy-memory-acceptance-"),
);
fs.chmodSync(root, 0o700);
const cliVersion = execFileSync(values.command, ["--version"], {
  encoding: "utf8",
  timeout: 30000,
}).trim();
const marker = "GROUP_" + randomBytes(8).toString("hex");
const protectedMarker = "PROTECTED_" + randomBytes(8).toString("hex");
const foreignMarker = "FOREIGN_" + randomBytes(8).toString("hex");
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
      ownerIds: ["30000", "30001", "30002"],
      allow: { groups: ["20000"], users: ["30000", "30001", "30002"] },
      persona: "你是一名友好的聊天伙伴，使用简洁中文回答。",
      subject: { enabled: false },
      wake: { cooldownMs: 0 },
      contextPolicy: { capacityTokens: 65536 },
      behavior: { turnTimeoutMs: 180000 },
    },
  ],
});
const store = new MemoryStore(path.join(root, "memory.sqlite"));
const configStore = new ConfigStore(path.join(root, "config.json"), cfg);
let active,
  serial = 0,
  groupEvent,
  groupSession;
const results = [];
class SyntheticTransport extends EventEmitter {
  connected = true;
  async send(conversation, segments) {
    active.sends.push({ conversation, segments, at: Date.now() });
    return { messageId: String(40000 + ++serial) };
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
    const backend = new AntigravityBackend(config, agent, { root });
    const run = backend.run.bind(backend);
    backend.run = (params) => {
      if (params.conversation.startsWith("private:")) {
        assert(
          !params.prompt.includes(marker),
          "GROUP_ANSWER_LEAKED_IN_PRIVATE_PROMPT",
        );
        assert(!params.session, "PRIVATE_SESSION_MUST_START_FRESH");
      }
      for (const secret of [protectedMarker, foreignMarker])
        assert(!params.prompt.includes(secret), "HIDDEN_SOURCE_IN_PROMPT");
      return run({
        ...params,
        callTool: async (name, args) => {
          if (
            ![
              "memory_search",
              "memory_read",
              "memory_related",
              "conversation_read",
              "qq_send",
              "qq_send_burst",
              "qq_mark_read",
            ].includes(name)
          ) {
            active.deniedTools++;
            active.calls.push({ name, denied: true });
            throw Error("ACCEPTANCE_ACTION_DENIED");
          }
          const call = {
            name,
            paginated: !!args.cursor,
            sourceKind: args.conversationType || null,
          };
          active.calls.push(call);
          try {
            const result = await params.callTool(name, args);
            const encoded = JSON.stringify(result);
            for (const secret of [protectedMarker, foreignMarker])
              assert(!encoded.includes(secret), "HIDDEN_SOURCE_IN_TOOL_RESULT");
            if (
              ["memory_search", "memory_read", "conversation_read"].includes(
                name,
              )
            ) {
              call.groupEvidence =
                encoded.includes(groupEvent.id) &&
                encoded.includes(marker) &&
                encoded.includes("group:20000");
              call.hasMore = !!result.nextCursor;
              call.returnedGroups = (result.items || []).filter((x) =>
                x.conversation?.startsWith("group:"),
              ).length;
            }
            return result;
          } catch (error) {
            call.error =
              error.message === "INVALID_MEMORY_SCOPE"
                ? error.message
                : "UNEXPECTED_TOOL_FAILURE";
            throw error;
          }
        },
      });
    };
    return backend;
  },
});
runtime.transports.set("synthetic", new SyntheticTransport());
const mem = store.bind("acceptance");
function append(memory, conversation, body, payload = {}) {
  return memory.append({
    dedupe: "synthetic-" + ++serial,
    connectionId: "synthetic",
    conversation,
    kind: "message.received",
    direction: "in",
    senderId: conversation.startsWith("private:")
      ? conversation.slice(8)
      : "30000",
    messageId: String(50000 + serial),
    body,
    origin: "live",
    occurredAt: new Date().toISOString(),
    payload: {
      trustedInput: true,
      segments: conversation.startsWith("group:")
        ? [{ type: "at", data: { qq: "10000" } }]
        : [],
      ...payload,
    },
  });
}
const scenarios = [
  {
    name: "group-learn",
    conversation: "group:20000",
    body: `@验收角色 记住本群的星桥游戏暗号是 ${marker}。请只回复“已记住”确认收到，不要复述暗号。`,
  },
  {
    name: "private-recall",
    conversation: "private:30000",
    body: "我们刚才在群里说的星桥游戏暗号是什么？从你自己的群聊记忆查出原始记录，完整回复暗号，别猜，也别让我重新转述。",
  },
  {
    name: "private-pagination",
    conversation: "private:30001",
    body: '请回查群里的星桥游戏暗号。先用 memory_search 参数 {"query":"星桥游戏","type":"event","limit":2,"contextBefore":0,"contextAfter":0}，如果本页没有群聊原始记录，按返回的 continueWith 继续翻页，保持筛选条件，直到查到群聊原文；不要用私聊转述代替原始群记录。最后只回复暗号。',
  },
  {
    name: "scope-error-recovery",
    conversation: "private:30002",
    body: '请用 memory_search 参数 {"conversation":"group","query":"星桥游戏"} 回查群聊暗号。如果工具指出来源参数有误，按工具提示修正后继续查；不要把参数错误当成记忆不存在。最后完整回复群聊原始记录中的暗号。',
  },
];
try {
  for (const [index, scenario] of scenarios.entries()) {
    if (index === 1) {
      append(mem, "group:20001", "星桥游戏 " + protectedMarker, {
        protectedOperations: true,
      });
      append(
        store.bind("other-agent"),
        "group:20000",
        "星桥游戏 " + foreignMarker,
      );
    }
    if (index === 1 || index === 2)
      for (let n = 0; n < 6; n++)
        append(
          mem,
          "private:30000",
          `星桥游戏的私聊干扰记录 ${index}-${n}，这里没有群聊的原始暗号。`,
        );
    const incoming = append(mem, scenario.conversation, scenario.body);
    if (index === 0) groupEvent = incoming;
    const groupReadBefore = mem.state("group:20000").readThroughSeq;
    active = { sends: [], calls: [], deniedTools: 0 };
    const start = Date.now();
    await runtime.wake("acceptance", scenario.conversation, {
      reasons: [{ reason: index === 0 ? "mention" : "private" }],
    });
    const state = mem.state(scenario.conversation),
      turn = mem.identity.get("model_turns", state.lastTurnId);
    const reply = active.sends
      .flatMap((x) => x.segments)
      .filter((x) => x.type === "text")
      .map((x) => x.data.text)
      .join(" ");
    if (index === 0) groupSession = state.session?.id;
    const row = {
      case: scenario.name,
      status: turn?.status,
      sends: active.sends.length,
      firstSendMs: active.sends[0] ? active.sends[0].at - start : null,
      totalMs: Date.now() - start,
      markerRecalled: reply.includes(marker),
      acknowledged: reply.includes("已记住"),
      groupEvidence: active.calls.some((c) => c.groupEvidence),
      paginated: active.calls.some((c) => c.paginated),
      deniedTools: active.deniedTools,
      separateSession:
        index === 0 || (!!state.session && state.session.id !== groupSession),
      currentInputRead: state.readThroughSeq >= incoming.seq,
      groupReadUnchanged:
        index === 0 ||
        mem.state("group:20000").readThroughSeq === groupReadBefore,
      calls: active.calls,
      failedTools:
        turn?.toolCalls
          ?.filter((c) => !c.ok)
          .map((c) => ({ name: c.name, code: c.code })) || [],
    };
    results.push(row);
    console.log(JSON.stringify(row));
    assert.equal(row.sends, 1, "ONE_SYNTHETIC_REPLY_REQUIRED");
    assert(
      index === 0 ? row.acknowledged : row.markerRecalled,
      "GROUP_MARKER_NOT_RECALLED",
    );
    assert(row.firstSendMs <= maxFirstSendMs, "FIRST_REPLY_TOO_SLOW");
    assert(
      row.currentInputRead && row.groupReadUnchanged && row.separateSession,
      "CROSS_CHAT_STATE_CORRUPTED",
    );
    assert.equal(row.deniedTools, 0, "UNRELATED_TOOL_ATTEMPTS");
    if (index > 0) assert(row.groupEvidence, "ORIGINAL_GROUP_SOURCE_NOT_READ");
    if (scenario.name === "private-pagination")
      assert(row.paginated, "PAGINATION_NOT_EXERCISED");
    if (scenario.name === "scope-error-recovery") {
      assert(
        row.failedTools.some((c) => c.code === "INVALID_MEMORY_SCOPE"),
        "SCOPE_ERROR_NOT_EXERCISED",
      );
      assert(
        row.failedTools.every((c) => c.code === "INVALID_MEMORY_SCOPE"),
        "UNEXPECTED_TOOL_FAILURE",
      );
    } else assert.equal(row.failedTools.length, 0, "UNEXPECTED_TOOL_FAILURE");
  }
} catch (error) {
  process.exitCode = 1;
  console.error(
    /^[A-Z][A-Z_]+$/.test(error.message || "")
      ? error.message
      : "ANTIGRAVITY_MEMORY_ACCEPTANCE_FAILED",
  );
} finally {
  await runtime.close();
  store.close();
  fs.writeFileSync(
    path.join(root, "acceptance-summary.json"),
    JSON.stringify(
      {
        passed: !process.exitCode,
        cliVersion,
        model: values.model,
        maxFirstSendMs,
        fixtureCapacity: 65536,
        realQQ: false,
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
