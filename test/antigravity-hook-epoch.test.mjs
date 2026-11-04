import test from "node:test";
import assert from "node:assert/strict";
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
