import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { toolSpecs } from "./tools/index.mjs";

const base = process.env.QQ_UNIFIED_URL || "http://127.0.0.1:3210";
const url = new URL(base);
if (
  url.protocol !== "http:" ||
  !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
  url.username ||
  url.password
)
  throw Error("LOOPBACK_REQUIRED");
const server = new Server(
  { name: "qq-unified", version: "0.1.0" },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: toolSpecs(undefined, { context: true }),
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    const { context, ...args } = req.params.arguments || {};
    if (typeof context !== "string") throw Error();
    const response = await fetch(new URL("/agent/tools", base), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agent-capability": context,
      },
      body: JSON.stringify({ name: req.params.name, arguments: args }),
      signal: AbortSignal.timeout(660000),
      redirect: "error",
    });
    if (!response.ok) throw Error();
    return await response.json();
  } catch {
    return {
      isError: true,
      content: [
        { type: "text", text: "工具调用被拒绝或未确认；不得假称发送成功。" },
      ],
    };
  }
});
await server.connect(new StdioServerTransport());
