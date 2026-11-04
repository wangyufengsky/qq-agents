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
  const server = http.createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(403).end("{}");
      return;
    }
    if (req.url === "/catalog") {
      res.end(JSON.stringify(catalogue));
      return;
    }
    let bytes = 0;
    for await (const chunk of req) bytes += chunk.length;
    reports.push({ method: req.method, url: req.url, bytes });
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
  for (const value of [
    input,
    denied,
    { ...denied, stepIdx: catalogue.minimumStep },
    { ...denied, conversationId: "another-conversation" },
  ]) {
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
      decision: value === input ? "auto_approve" : "deny",
      reason:
        value === input ? "QQ_AGENTS_TOOL_ALLOWED" : "QQ_AGENTS_TOOL_DENIED",
    });
  }
  assert.deepEqual(reports, [
    { method: "POST", url: `/hook-denied?epoch=${epoch}`, bytes: 0 },
  ]);
});
