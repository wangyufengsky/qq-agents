// @ts-check
import { createHash } from "node:crypto";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

/** @param {unknown} value @param {string[]} names
 * @param {{path: string, sha256: string, bytes: number}[]} [images] */
export function antigravityToolAllowed(value, names, images = []) {
  const call = /** @type {any} */ (value);
  if (call?.name === "view_file") {
    const file = images.find((image) => image.path === call.args?.AbsolutePath);
    if (!file || Object.keys(call.args).some((key) => key !== "AbsolutePath"))
      return false;
    try {
      const stat = fs.lstatSync(file.path);
      return (
        stat.isFile() &&
        !stat.isSymbolicLink() &&
        stat.size === file.bytes &&
        stat.size <= 8 * 1024 * 1024 &&
        createHash("sha256")
          .update(fs.readFileSync(file.path))
          .digest("hex") === file.sha256
      );
    } catch {
      return false;
    }
  }
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
      catalogue.images || [],
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
