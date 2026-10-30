import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

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
  if (mode === "malformed") process.stdout.write("not JSON\n");
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
