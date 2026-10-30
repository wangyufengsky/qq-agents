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
