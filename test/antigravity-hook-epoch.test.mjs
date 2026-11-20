import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { antigravityHookAllowed } from "../src/backends/antigravity-guard.mjs";

const epoch = "a".repeat(32),
  oldEpoch = "b".repeat(32);
const catalogue = {
  turnEpoch: epoch,
  conversationId: "synthetic-conversation",
  minimumStep: 10,
  turnTools: [{ name: "qq_send" }],
  images: [],
};
const input = {
  conversationId: catalogue.conversationId,
  stepIdx: 11,
  lastUserInput: `Bridge routing for this input: epoch=${epoch}.\nSynthetic input.`,
  toolCall: { name: "finish", args: {} },
};

test("persistent native hooks require the current conversation and a newer native step", () => {
  assert.equal(antigravityHookAllowed(input, catalogue), true);
  for (const patch of [
    { conversationId: "another-conversation" },
    { stepIdx: 10 },
    { stepIdx: NaN },
    { stepIdx: undefined },
    { toolCall: { name: "command", args: {} } },
  ])
    assert.equal(
      antigravityHookAllowed({ ...input, ...patch }, catalogue),
      false,
    );
});

test("persistent MCP hooks reject old envelopes and logical tools outside the current catalogue", () => {
  const call = {
    name: "call_mcp_tool",
    args: {
      ServerName: "qq-agents",
      ToolName: "qq_turn_call",
      Arguments: { epoch, name: "qq_send", arguments: { text: "Synthetic" } },
    },
  };
  assert.equal(
    antigravityHookAllowed({ ...input, toolCall: call }, catalogue),
    true,
  );
  for (const patch of [
    { epoch: oldEpoch },
    { name: "terminal_open" },
    { arguments: [] },
    { arguments: null },
    { target: "private:other" },
  ])
    assert.equal(
      antigravityHookAllowed(
        {
          ...input,
          toolCall: {
            ...call,
            args: {
              ...call.args,
              Arguments: { ...call.args.Arguments, ...patch },
            },
          },
        },
        catalogue,
      ),
      false,
    );
});

test("the native hook reports only current-turn denials without exposing call details", async (t) => {
  const reports = [];
  const token = "synthetic-hook-report-token";
  let catalogStatus = 200;
  let availableCatalogue = catalogue;
  const server = http.createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(403).end("{}");
      return;
    }
    if (req.url === "/catalog") {
      if (catalogStatus === null) return;
      res.writeHead(catalogStatus).end(JSON.stringify(availableCatalogue));
      return;
    }
    let bytes = 0;
    for await (const chunk of req) bytes += chunk.length;
    reports.push({
      method: req.method,
      url: req.url,
      bytes,
      reason: req.headers["x-qq-hook-reason"],
    });
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const hook = fileURLToPath(
    new URL("../src/backends/antigravity-guard.mjs", import.meta.url),
  );
  const denied = {
    ...input,
    toolCall: {
      name: "view_file",
      args: { AbsolutePath: "SYNTHETIC_PRIVATE_PATH_DETAIL" },
    },
  };
  const invoke = async (value, reason) => {
    const child = spawn(process.execPath, [hook], {
      env: {
        ...process.env,
        QQ_AGY_ENDPOINT: endpoint,
        QQ_AGY_TOKEN: token,
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    let errors = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (errors += chunk));
    const closed = once(child, "close");
    child.stdin.end(JSON.stringify(value));
    const [code] = await closed;
    assert.equal(code, 0);
    assert.equal(errors, "");
    assert.deepEqual(JSON.parse(output), {
      decision: reason === "QQ_AGENTS_TOOL_ALLOWED" ? "auto_approve" : "deny",
      reason,
    });
  };
  await invoke(input, "QQ_AGENTS_TOOL_ALLOWED");
  await invoke(denied, "ANTIGRAVITY_HOOK_IMAGE_DENIED");
  await invoke(
    { ...denied, stepIdx: catalogue.minimumStep },
    "ANTIGRAVITY_HOOK_STALE_STEP",
  );
  await invoke(
    { ...denied, conversationId: "another-conversation" },
    "ANTIGRAVITY_HOOK_WRONG_CONVERSATION",
  );
  await invoke(
    { ...input, toolCall: { name: "list_resources" } },
    "ANTIGRAVITY_HOOK_TOOL_DENIED",
  );
  await invoke({ ...input, toolCall: null }, "ANTIGRAVITY_HOOK_INVALID_INPUT");
  availableCatalogue = { tools: null };
  await invoke(input, "ANTIGRAVITY_HOOK_CATALOG_INVALID");
  catalogStatus = 410;
  await invoke(input, "ANTIGRAVITY_TURN_INACTIVE");
  catalogStatus = 403;
  await invoke(input, "ANTIGRAVITY_HOOK_CATALOG_FORBIDDEN");
  catalogStatus = 503;
  await invoke(input, "ANTIGRAVITY_HOOK_CATALOG_UNAVAILABLE");
  catalogStatus = null;
  await invoke(input, "ANTIGRAVITY_HOOK_CATALOG_TIMEOUT");
  assert.deepEqual(
    reports,
    [
      "ANTIGRAVITY_HOOK_IMAGE_DENIED",
      "ANTIGRAVITY_HOOK_TOOL_DENIED",
      "ANTIGRAVITY_HOOK_INVALID_INPUT",
    ].map((reason) => ({
      method: "POST",
      url: `/hook-denied?epoch=${epoch}`,
      bytes: 0,
      reason,
    })),
  );
});
