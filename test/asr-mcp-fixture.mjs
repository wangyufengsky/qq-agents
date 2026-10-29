// Synthetic transcription peer used only by offline tests. It does not call any model or network service.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
const server = new Server(
  { name: "synthetic-asr", version: "1" },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "transcribe",
      description: "Returns a fixed synthetic transcript describing the input",
      inputSchema: {
        type: "object",
        properties: {
          audio: { type: "string" },
          mimeType: { type: "string" },
          language: { type: "string" },
        },
        required: ["audio"],
      },
    },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { audio, mimeType, language } = request.params.arguments || {};
  const bytes = Buffer.from(String(audio || ""), "base64");
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          text: `合成转写：${bytes.subarray(0, 4).toString("ascii")} ${mimeType} ${language}`,
        }),
      },
    ],
  };
});
await server.connect(new StdioServerTransport());
