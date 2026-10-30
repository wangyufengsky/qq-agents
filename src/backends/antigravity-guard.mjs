// @ts-check
import fs from "node:fs";
import { pathToFileURL } from "node:url";

/** @param {unknown} value @param {string[]} names */
export function antigravityToolAllowed(value, names) {
  const call = /** @type {any} */ (value);
  return (
    call?.name === "finish" ||
    (call?.name === "call_mcp_tool" &&
      call.args?.ServerName === "qq-agents" &&
      names.includes(call.args?.ToolName))
  );
}

/** The hook and MCP child share a turn-scoped endpoint, never a model-visible token. */
export async function guardMain() {
  let allowed = false;
  try {
    const input = fs.readFileSync(0, "utf8");
    if (input.length > 1048576) throw Error();
    const endpoint = new URL(process.env.QQ_AGY_ENDPOINT || "");
    if (
      endpoint.protocol !== "http:" ||
      endpoint.hostname !== "127.0.0.1" ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      throw Error();
    const response = await fetch(new URL("/catalog", endpoint), {
      headers: { authorization: `Bearer ${process.env.QQ_AGY_TOKEN || ""}` },
      signal: AbortSignal.timeout(2000),
      redirect: "error",
    });
    if (!response.ok) throw Error();
    const catalogue = /** @type {any} */ (await response.json());
    allowed = antigravityToolAllowed(
      JSON.parse(input).toolCall,
      catalogue.tools.map((/** @type {any} */ tool) => tool.name),
    );
  } catch {
    // Failure to read policy or validate the active turn always denies execution.
  }
  process.stdout.write(
    JSON.stringify({
      decision: allowed ? "auto_approve" : "deny",
      reason: allowed ? "QQ_AGENTS_TOOL_ALLOWED" : "QQ_AGENTS_TOOL_DENIED",
    }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await guardMain();
