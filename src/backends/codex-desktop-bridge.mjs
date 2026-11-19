// @ts-check
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { mcpEntrySpecs, parseMcpEntry } from "../tools/catalog.mjs";
import { safeToolFailure } from "../tools/errors.mjs";
import { mcpResult } from "../tools/index.mjs";
import { finalizeMcpOutput, toolOutputText } from "./tool-output.mjs";
import { MAX_VIDEO_RELAY_FRAME } from "../video/policy.mjs";

export const codexDesktopBridgeName = "qq_desktop_session";
export const codexDesktopBridgeSignature = "desktop-mcp-bridge";

/** @typedef {import("./session-contract.mjs").RunParams} RunParams */
/** @typedef {{context: string, tools: RunParams["tools"], active: () => boolean, callTool: RunParams["callTool"], finalizeToolOutput: RunParams["finalizeToolOutput"], commitToolOutput: RunParams["commitToolOutput"]}} BridgeTurn */

export class CodexDesktopBridge {
  constructor() {
    this.path = "/" + randomBytes(24).toString("hex");
    /** @type {BridgeTurn | undefined} */
    this.turn = undefined;
    this.server = createServer((req, res) => {
      void this.request(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    this.ready = new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", reject);
        this.server.unref();
        const address = this.server.address();
        if (!address || typeof address === "string")
          return reject(Error("CODEX_DESKTOP_BRIDGE_UNAVAILABLE"));
        this.host = "127.0.0.1:" + address.port;
        resolve("http://" + this.host + this.path);
      });
    });
  }

  /** @param {import("node:http").IncomingMessage} req @param {import("node:http").ServerResponse} res */
  async request(req, res) {
    if (
      req.url !== this.path ||
      req.headers.host !== this.host ||
      req.headers.origin
    ) {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const server = new Server(
      { name: codexDesktopBridgeName, version: "1" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: mcpEntrySpecs(),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        const turn = this.turn;
        const { context, ...args } = parseMcpEntry(
          request.params.name,
          request.params.arguments || {},
        );
        if (!turn || turn.context !== context || !turn.active())
          throw Error("AGENT_PAUSED_OR_EXPIRED");
        if (request.params.name === "bridge_tools") {
          const { names, offset } =
            /** @type {{names?: string[], offset: number}} */ (
              /** @type {unknown} */ (args)
            );
          const specs = names
            ? names.map((name) => {
                const tool = turn.tools.find((item) => item.name === name);
                if (!tool) throw Error("TOOL_DISABLED");
                return tool;
              })
            : turn.tools
                .slice(offset, offset + 20)
                .map(({ name, description }) => ({
                  name,
                  description,
                }));
          return mcpResult({
            tools: specs,
            total: turn.tools.length,
            nextOffset:
              !names && offset + 20 < turn.tools.length ? offset + 20 : null,
          });
        }
        const { name, arguments: input } =
          /** @type {{name: string, arguments: object}} */ (
            /** @type {unknown} */ (args)
          );
        if (!turn.tools.some((tool) => tool.name === name))
          throw Error("TOOL_DISABLED");
        const result = await turn.callTool(name, input);
        const { wire, receipt } = await finalizeMcpOutput(
          turn,
          result,
          undefined,
          MAX_VIDEO_RELAY_FRAME - 512,
        );
        if (this.turn !== turn || !turn.active())
          throw Error("AGENT_PAUSED_OR_EXPIRED");
        if (receipt)
          res.once("finish", () => {
            if (this.turn === turn && turn.active())
              turn.commitToolOutput?.(receipt, toolOutputText(wire));
          });
        return wire;
      } catch (error) {
        return {
          isError: true,
          content: [
            { type: "text", text: JSON.stringify(safeToolFailure(error)) },
          ],
        };
      }
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.once("close", () => {
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  }

  close() {
    this.turn = undefined;
    this.server.close();
  }
}
