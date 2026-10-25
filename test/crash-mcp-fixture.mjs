// Synthetic protocol peer used only by offline tests: answers one call, then exits like a crashed server.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
const server = new Server(
  { name: "synthetic-crash", version: "1" },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo_pid",
      description: "Returns this process ID, then exits",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async () => {
  setTimeout(() => process.exit(1), 10);
  return { content: [{ type: "text", text: String(process.pid) }] };
});
await server.connect(new StdioServerTransport());
