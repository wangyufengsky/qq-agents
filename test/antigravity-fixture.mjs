import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";

const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
const mode = process.env.AGY_FIXTURE_MODE || "success";
if (args.includes("models")) {
  if (mode === "probe-wait") setInterval(() => {}, 1000);
  else console.log("fixture-model\tFixture model");
} else {
  const endpoint = process.env.QQ_AGY_ENDPOINT;
  const token = process.env.QQ_AGY_TOKEN;
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  const call = async (name, extra = {}) =>
    fetch(endpoint + "/call", {
      method: "POST",
      headers: { ...headers, ...extra },
      body: JSON.stringify({ name, arguments: { value: "synthetic" } }),
    });
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  JSON.parse(input);
  const id = args.includes("--conversation")
    ? flag("--conversation")
    : randomUUID();
  const native = path.join(flag("--gemini_dir"), "cli", "conversations");
  fs.mkdirSync(native, { recursive: true });
  fs.writeFileSync(path.join(native, id + ".db"), "synthetic native session");
  const event = (value) => process.stdout.write(JSON.stringify(value) + "\n");
  event({ event: "init", conversation_id: id, init: { agent: "qq-agents" } });
  const result = {
    event: "result",
    result: {
      status: "SUCCESS",
      conversation_id: id,
      response: "Assistant text is never a delivery.",
    },
  };
  if (mode === "usage" || mode === "invalid-usage") {
    const step = (step_index, usage, extra = {}) =>
      event({
        event: "step_update",
        step_update: {
          conversation_id: id,
          step_index,
          step_type: "agent_response",
          state: "DONE",
          usage,
          ...extra,
        },
      });
    step(1, { input_tokens: 22000, output_tokens: 500, cache_read_tokens: 0 });
    step(3, {
      input_tokens: 1000,
      output_tokens: 100,
      cache_read_tokens: 22000,
    });
    step(2, { input_tokens: 99000, output_tokens: 500, cache_read_tokens: 0 });
    step(
      4,
      { input_tokens: 50, output_tokens: 5 },
      { step_type: "checkpoint" },
    );
    step(
      5,
      { input_tokens: 1, output_tokens: 1 },
      { conversation_id: randomUUID() },
    );
    if (mode === "invalid-usage")
      step(6, { input_tokens: -1, output_tokens: 3 });
    result.result.usage = {
      input_tokens: 900000,
      output_tokens: 5000,
      total_tokens: 905000,
    };
    event(result);
    step(7, { input_tokens: 999999, output_tokens: 1 });
  } else if (mode === "schema-error") {
    const response = await call("probe");
    const error = JSON.parse((await response.json()).content[0].text);
    if (
      error.code !== "INVALID_TOOL_ARGUMENTS" ||
      error.tool?.name !== "probe" ||
      !error.tool?.inputSchema?.properties?.requestId ||
      JSON.stringify(error).includes("PRIVATE_ARGUMENT")
    )
      throw Error("TOOL_SCHEMA_RECOVERY_MISSING");
    event(result);
  } else if (mode === "malformed") process.stdout.write("not JSON\n");
  else if (mode === "wrong-result") {
    result.result.conversation_id = randomUUID();
    event(result);
  } else if (mode === "duplicate-result") {
    event(result);
    event(result);
  } else if (mode === "quota") {
    process.stderr.write("RESOURCE_EXHAUSTED fixture-private-provider-detail");
    event({
      ...result,
      result: {
        ...result.result,
        status: "ERROR",
        error: "429 fixture-private-provider-detail",
      },
    });
    process.exitCode = 3;
  } else if (mode === "orphan") {
    const descendant = spawn(
      process.execPath,
      [
        "-e",
        "process.on('SIGINT', () => {}); process.send('ready'); setInterval(() => {}, 1000);",
      ],
      {
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      },
    );
    await once(descendant, "message");
    descendant.disconnect();
    process.once("SIGINT", () => process.exit(0));
    await call("probe").catch(() => {});
  } else if (mode === "cancel") {
    process.once("SIGINT", async () => {
      const stale = await call("probe").catch(() => null);
      if (stale && stale.status !== 403) process.exitCode = 10;
      event(result);
      process.exit(process.exitCode || 0);
    });
    await call("probe").catch(() => {});
  } else {
    const catalogue = await fetch(endpoint + "/catalog", { headers });
    const tools = await catalogue.json();
    if (tools.tools.length !== 1 || tools.tools[0].name !== "probe")
      throw Error("CATALOGUE_MISMATCH");
    if ((await call("unknown")).status !== 403)
      throw Error("UNKNOWN_TOOL_ALLOWED");
    if (
      (await call("probe", { authorization: "Bearer invalid" })).status !== 403
    )
      throw Error("INVALID_TOKEN_ALLOWED");
    if (
      (await call("probe", { origin: "https://example.invalid" })).status !==
      403
    )
      throw Error("ORIGIN_ALLOWED");
    if (!(await call("probe")).ok) throw Error("TOOL_FAILED");
    event(result);
    await new Promise((resolve) => setTimeout(resolve, 30));
    if ((await call("probe")).status !== 403)
      throw Error("COMPLETED_TURN_ALLOWED");
  }
}
