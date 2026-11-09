// @ts-check
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ReceiptStdioTransport } from "./mcp-output.mjs";
import { readRelayToken } from "./core/relay-auth.mjs";
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
const transport = new ReceiptStdioTransport(async (context, body, signal) => {
  const response = await fetch(new URL("/agent/output-ack", base), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-agent-capability": context,
      "x-agent-relay-token": readRelayToken(
        process.env.QQ_UNIFIED_RELAY_TOKEN_FILE,
      ),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
    redirect: "error",
  });
  if (!response.ok || !(await response.json()).accepted)
    throw Error("TOOL_OUTPUT_INCOMPLETE");
});
server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
  try {
    const { context, ...args } = parseMcpEntry(
      req.params.name,
      req.params.arguments || {},
    );
    if (typeof context !== "string") throw Error();
    await transport.beforeCall(context);
    extra.signal.throwIfAborted();
    const requestId = JSON.stringify(extra.requestId);
    if (requestId.length > 256) throw Error("INVALID_TOOL_ARGUMENTS");
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
          "x-agent-relay-token": readRelayToken(
            process.env.QQ_UNIFIED_RELAY_TOKEN_FILE,
          ),
          "x-agent-output-protocol": "stdio-v1",
          "x-agent-output-request": requestId,
        },
        body: JSON.stringify(args),
        signal: AbortSignal.any([extra.signal, AbortSignal.timeout(660000)]),
        redirect: "error",
      },
    );
    if (!response.ok) throw Error();
    const result = await response.json();
    const receipt = response.headers.get("x-agent-output-receipt");
    if (receipt)
      transport.stage(
        extra.requestId,
        context,
        receipt,
        response.headers.get("x-agent-output-digest") ?? "",
        extra.signal,
        result,
      );
    return result;
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify(safeToolFailure(error)) }],
    };
  }
});
await server.connect(transport);
