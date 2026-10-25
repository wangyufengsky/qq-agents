import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export class ExternalTools {
  constructor(configs = []) {
    this.configs = configs;
    this.clients = new Map();
    this.starting = new Map();
  }
  async connect(id) {
    if (this.clients.has(id)) return this.clients.get(id);
    if (this.starting.has(id)) return this.starting.get(id);
    const config = this.configs.find((s) => s.id === id);
    if (!config) throw Error("EXTERNAL_SERVER_DISABLED");
    const pending = (async () => {
      const env = { PATH: process.env.PATH };
      for (const [key, ref] of Object.entries(config.env)) {
        if (!process.env[ref]) throw Error("EXTERNAL_SECRET_ENV_MISSING");
        env[key] = process.env[ref];
      }
      const client = new Client({
        name: "qq-unified-external",
        version: "0.1.0",
      });
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env,
        stderr: "pipe",
      });
      try {
        await client.connect(transport);
        const catalog = await client.listTools();
        const entry = {
          client,
          transport,
          names: new Set(catalog.tools.map((t) => t.name)),
          allowed: new Set(config.allowedTools),
        };
        this.clients.set(id, entry);
        return entry;
      } catch (e) {
        await transport.close();
        throw e;
      }
    })();
    this.starting.set(id, pending);
    try {
      return await pending;
    } finally {
      this.starting.delete(id);
    }
  }
  async call(id, name, args) {
    const config = this.configs.find((s) => s.id === id);
    if (!config?.allowedTools.includes(name))
      throw Error("EXTERNAL_TOOL_DISABLED");
    const entry = await this.connect(id);
    if (!entry.names.has(name)) throw Error("EXTERNAL_TOOL_UNAVAILABLE");
    return entry.client.callTool({ name, arguments: args }, undefined, {
      timeout: 120000,
    });
  }
  async close() {
    await Promise.allSettled([...this.starting.values()]);
    await Promise.allSettled(
      [...this.clients.values()].map((e) => e.client.close()),
    );
    this.clients.clear();
  }
}
