import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CodexBackend } from "../src/backends/codex.mjs";
import { SessionUnavailableFailure } from "../src/backends/turn-failure.mjs";
import {
  codexDesktopBridgeName,
  codexDesktopBridgeSignature,
} from "../src/backends/codex-desktop-bridge.mjs";
import {
  sessionContract,
  sessionSignature,
} from "../src/backends/session-contract.mjs";

test("retained Codex desktop thread installs the bridge without replacing the ID", async (t) => {
  const threadId = "synthetic-existing-native-thread";
  let loaded = true;
  let bridgeUrl;
  const methods = [];
  const receiver = {
    active: new Map(),
    rpc: {
      async request(method, params) {
        methods.push(method);
        assert.equal(params.threadId, threadId);
        if (method === "thread/read")
          return { thread: { id: threadId, status: { type: "idle" } } };
        if (method === "thread/unsubscribe") {
          loaded = false;
          return { status: "unsubscribed" };
        }
        if (method === "thread/resume") {
          if (!loaded)
            bridgeUrl = params.config.mcp_servers[codexDesktopBridgeName].url;
          loaded = true;
          assert.deepEqual(params.config.mcp_servers.inherited, {
            enabled: false,
          });
          return { thread: { id: threadId } };
        }
        if (method === "mcpServerStatus/list")
          return {
            data: bridgeUrl
              ? [
                  {
                    name: codexDesktopBridgeName,
                    httpOrigin: new URL(bridgeUrl).origin,
                    tools: { bridge_tools: {}, bridge_call: {} },
                  },
                ]
              : [],
          };
        assert.fail(method);
      },
    },
  };
  t.after(() => receiver.desktopBridge?.close());
  await CodexBackend.prototype.resumeDesktopBridge.call(
    receiver,
    threadId,
    { mcp_servers: { inherited: { enabled: false } } },
    new AbortController().signal,
  );
  assert.deepEqual(methods, [
    "thread/resume",
    "mcpServerStatus/list",
    "thread/read",
    "thread/unsubscribe",
    "thread/resume",
    "mcpServerStatus/list",
  ]);
  const client = new Client({ name: "fake-native", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(bridgeUrl)));
  t.after(() => client.close());
  const context = "current-desktop-capability";
  const args = { context, name: "intent_list", arguments: {} };
  const call = (name, args) => client.callTool({ name, arguments: args });
  const decoded = (result) => JSON.parse(result.content[0].text);
  assert.equal(
    decoded(await call("bridge_call", args)).code,
    "AGENT_PAUSED_OR_EXPIRED",
  );
  const seen = [];
  const tools = [
    {
      name: "intent_list",
      description: "Intentions",
      inputSchema: { type: "object" },
    },
  ];
  receiver.desktopBridge.turn = {
    context,
    tools,
    active: () => true,
    async callTool(name, args) {
      seen.push([name, args]);
      return { items: [] };
    },
  };
  assert.deepEqual(
    decoded(await call("bridge_tools", { context, names: ["intent_list"] }))
      .tools,
    tools,
  );
  assert.equal(
    decoded(await call("bridge_call", { ...args, name: "qq_send" })).code,
    "TOOL_DISABLED",
  );
  assert.equal(
    decoded(
      await call("bridge_call", {
        ...args,
        context: "previous-desktop-capability",
      }),
    ).code,
    "AGENT_PAUSED_OR_EXPIRED",
  );
  assert.deepEqual(decoded(await call("bridge_call", args)), { items: [] });
  assert.deepEqual(seen, [["intent_list", {}]]);
});

test("Codex retains only authentic tool-contract bindings for the same model", () => {
  const backend = Object.create(CodexBackend.prototype);
  backend.config = {
    type: "codex",
    id: "codex",
    model: "original-model",
    toolServers: [],
  };
  const oldTools = [{ name: "desktop_room_decide" }];
  const newTools = [...oldTools, { name: "desktop_screen_view" }];
  const previous = sessionContract(backend, oldTools);
  const old = {
    backend: "codex",
    id: "existing-id",
    signature: sessionSignature(backend, oldTools),
  };
  assert.deepEqual(backend.upgradeDesktopSession(old, newTools, previous), {
    ...old,
    signature: backend.sessionSignature(newTools),
    nativeSignature: codexDesktopBridgeSignature,
  });
  assert.equal(
    backend.upgradeDesktopSession(
      { ...old, signature: "corrupt" },
      newTools,
      previous,
    ),
    undefined,
  );
  backend.config.model = "different-model";
  assert.equal(
    backend.upgradeDesktopSession(old, newTools, previous),
    undefined,
  );
});

test("an explicitly missing native rollout is classified without requesting another thread", async (t) => {
  const threadId = "missing-native-thread";
  const receiver = {
    active: new Map(),
    rpc: {
      async request(method, params) {
        assert.equal(method, "thread/resume");
        assert.equal(params.threadId, threadId);
        throw Object.assign(
          Error("no rollout found for thread id " + threadId),
          {
            rpcRejected: true,
            rpcCode: -32600,
          },
        );
      },
    },
  };
  t.after(() => receiver.desktopBridge?.close());
  await assert.rejects(
    CodexBackend.prototype.resumeDesktopBridge.call(
      receiver,
      threadId,
      {},
      new AbortController().signal,
    ),
    SessionUnavailableFailure,
  );
});
