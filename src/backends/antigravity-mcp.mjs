// @ts-check
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const endpoint = new URL(process.env.QQ_AGY_ENDPOINT || "http://invalid");
if (
  endpoint.protocol !== "http:" ||
  endpoint.hostname !== "127.0.0.1" ||
  endpoint.username ||
  endpoint.password ||
  endpoint.search ||
  endpoint.hash
)
  throw Error("ANTIGRAVITY_ENDPOINT_INVALID");
const token = process.env.QQ_AGY_TOKEN;
if (!token) throw Error("ANTIGRAVITY_TURN_INACTIVE");
/** @param {string} route @param {unknown} [body] */
async function request(route, body) {
  const response = await fetch(new URL(route, endpoint), {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(660000),
    redirect: "error",
  });
  if (!response.ok) throw Error("ANTIGRAVITY_TURN_INACTIVE");
  return response.json();
}
const server = new Server(
  { name: "qq-agents", version: "1.0.0" },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, () => request("/catalog"));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    return await request("/call", {
      name: req.params.name,
      arguments: req.params.arguments || {},
    });
  } catch {
    return {
      isError: true,
      content: [{ type: "text", text: "ANTIGRAVITY_TURN_INACTIVE" }],
    };
  }
});
await server.connect(new StdioServerTransport());

// Windows cannot kill a tree through an already exited root PID. A bridge-owned
// MCP helper therefore watches the bridge itself, including while its CLI is idle.
// Two failures tolerate brief event-loop stalls without leaving an orphan behind.
let checkingLease = false,
  leaseFailures = 0;
const leaseTimer = setInterval(async () => {
  if (checkingLease) return;
  checkingLease = true;
  try {
    const response = await fetch(new URL("/lease", endpoint), {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
    if (!response.ok || (await response.json()).alive !== true)
      throw Error("ANTIGRAVITY_TURN_INACTIVE");
    leaseFailures = 0;
  } catch {
    if (++leaseFailures >= 2) {
      clearInterval(leaseTimer);
      // This is the bridge helper only, never the CLI, a QQ process or another MCP.
      process.exit(0);
    }
  } finally {
    checkingLease = false;
  }
}, 1000);
leaseTimer.unref();
