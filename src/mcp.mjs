import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { mcpEntrySpecs, parseMcpEntry } from "./tools/catalog.mjs";
import { safeToolFailure } from "./tools/errors.mjs";

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
  tools: mcpEntrySpecs(),
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    const { context, ...args } = parseMcpEntry(
      req.params.name,
      req.params.arguments || {},
    );
    if (typeof context !== "string") throw Error();
    const response = await fetch(
      new URL(
        req.params.name === "bridge_tools" ? "/agent/catalog" : "/agent/tools",
        base,
      ),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agent-capability": context,
        },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(660000),
        redirect: "error",
      },
    );
    if (!response.ok) throw Error();
    return await response.json();
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify(safeToolFailure(error)) }],
    };
  }
});
await server.connect(new StdioServerTransport());
