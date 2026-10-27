// Offline subprocess peer. Report only booleans about synthetic canaries, never an environment dump.
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
const inspect = () => ({
  inheritedSecrets: [
    "GITHUB_TOKEN",
    "ONEBOT_TOKEN",
    "TOTP_SECRET",
    "OPENAI_API_KEY",
    "QQ_ROUND2_UNRELATED",
    "QQ_ROUND2_EXPLICIT",
  ].filter((key) => process.env[key]?.startsWith("synthetic-round2-")),
  explicitSecret: process.env.ROLE_SECRET === "synthetic-round2-explicit",
  hasPath: !!process.env.PATH,
  hasHome: !!(process.env.HOME || process.env.USERPROFILE),
  proxy: process.env.HTTPS_PROXY === "http://127.0.0.1:9",
  nodeOptions: !!process.env.NODE_OPTIONS,
  dedicatedHome:
    !!process.env.CODEX_HOME &&
    fs.existsSync(process.env.CODEX_HOME) &&
    fs.realpathSync(process.env.CODEX_HOME) ===
      path.join(process.cwd(), "home"),
});
if (process.argv[2] === "native") {
  fs.writeFileSync(process.argv[3], JSON.stringify(inspect()));
  setInterval(() => {}, 1000);
} else {
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    const m = JSON.parse(line);
    if (m.id === undefined) return;
    let result = {};
    if (m.method === "initialize")
      result = {
        protocolVersion: m.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "env-fixture", version: "1" },
      };
    if (m.method === "account/read")
      result = {
        account: fs.existsSync(
          path.join(process.env.CODEX_HOME || "/missing", "synthetic-login"),
        )
          ? { type: "fixture" }
          : null,
      };
    if (m.method === "model/list")
      result = { data: [{ model: "synthetic", environment: inspect() }] };
    if (m.method === "tools/list")
      result = {
        tools: [
          {
            name: "env_probe",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      };
    if (m.method === "tools/call")
      result = { content: [{ type: "text", text: JSON.stringify(inspect()) }] };
    process.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\n",
    );
  });
}
