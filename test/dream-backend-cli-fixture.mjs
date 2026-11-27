import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [type, planPath, ...cliArgs] = process.argv.slice(2);
const { default: plan } = await import(planPath, { with: { type: "json" } });
const { tools, name, args, fail, evidence } = plan;
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n");

if (type === "codex") {
  const thread = randomUUID(),
    turn = randomUUID();
  const firstToolCallId = 10000;
  const toolCall = (id) => ({
    id,
    method: "item/tool/call",
    params: { threadId: thread, turnId: turn, tool: name, arguments: args },
  });
  for await (const line of createInterface({ input: process.stdin })) {
    const { id, method, params, result, error } = JSON.parse(line);
    const reply = (value) => emit({ id, result: value });
    if (method === "initialize") reply({});
    else if (method === "initialized") continue;
    else if (method === "account/read") reply({ account: { type: "fixture" } });
    else if (method === "model/list")
      reply({ data: [{ model: "fixture-model" }] });
    else if (method === "config/read")
      reply({ config: { mcp_servers: { unrelated: { command: "unused" } } } });
    else if (method === "thread/start") {
      assert.deepEqual(
        params.dynamicTools.map((tool) => tool.name).sort(),
        tools,
      );
      assert.deepEqual(params.config.mcp_servers, {
        unrelated: { enabled: false },
      });
      reply({ thread: { id: thread } });
    } else if (method === "turn/start") {
      assert.equal(params.threadId, thread);
      // A premature request must be rejected until turn/start admits input.
      emit(toolCall(firstToolCallId));
      reply({ turn: { id: turn } });
    } else if (id >= firstToolCallId && error) {
      // The RPC reader can parse both lines in one chunk before the receipt's
      // continuation runs. A rejected call has not executed the tool.
      assert.ok(id < firstToolCallId + 3);
      emit(toolCall(id + 1));
    } else if (id >= firstToolCallId) {
      assert.ok(id > firstToolCallId);
      assert.equal(result.success, true);
      const acknowledgement = JSON.parse(result.contentItems[0].text);
      writeFileSync(
        evidence,
        JSON.stringify({ session: thread, acknowledgement }),
      );
      emit({
        method: "turn/completed",
        params: {
          threadId: thread,
          turn: { id: turn, status: fail ? "failed" : "completed" },
        },
      });
    } else throw Error("UNEXPECTED_CODEX_METHOD: " + method);
  }
} else if (type === "antigravity") {
  assert.equal(cliArgs.includes("--conversation"), false);
  for await (const line of createInterface({ input: process.stdin }))
    JSON.parse(line);
  const session = randomUUID();
  emit({ event: "init", conversation_id: session });
  const client = new Client({ name: "dream-fixture", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      fileURLToPath(
        new URL("../src/backends/antigravity-mcp.mjs", import.meta.url),
      ),
    ],
    env: process.env,
  });
  try {
    await client.connect(transport);
    const catalogue = await client.listTools();
    assert.deepEqual(catalogue.tools.map((tool) => tool.name).sort(), tools);
    const reply = await client.callTool({ name, arguments: args });
    assert.equal(reply.isError, undefined);
    writeFileSync(
      evidence,
      JSON.stringify({
        session,
        acknowledgement: JSON.parse(reply.content[0].text),
      }),
    );
  } finally {
    await client.close();
  }
  emit({
    event: "step_update",
    step_update: {
      conversation_id: session,
      step_index: 1,
      step_type: "agent_response",
      state: "DONE",
    },
  });
  emit({
    event: "result",
    result: { conversation_id: session, status: fail ? "ERROR" : "SUCCESS" },
  });
} else throw Error("UNKNOWN_FIXTURE");
