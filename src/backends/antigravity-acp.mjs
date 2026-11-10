// @ts-check
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const LIMIT = 128 * 1024 * 1024;
/** Translate ACP into the existing supervisor's terminal protocol. The supervisor
 * still owns tool authorization, cancellation, session binding and send settlement.
 * @param {any} options @param {string} prompt
 * @param {(event: any) => void} emit @param {typeof spawn} [launch]
 * @param {import("./session-contract.mjs").InputImage[]} [inputImages] */
export async function runAcp(
  options,
  prompt,
  emit,
  launch = spawn,
  inputImages = [],
) {
  const child = launch(
    options.command,
    [
      "--settings",
      options.settings,
      "acp",
      "--agent",
      "qq-agents",
      "--gemini-dir",
      options.profile,
      "--app-data-dir",
      "cli",
      "--include-default-customizations=false",
      "--disable-telemetry",
    ],
    {
      cwd: options.workspace,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let serial = 0,
    buffer = "",
    bytes = 0,
    closed = false;
  /** @type {Map<number, {resolve: (value: any) => void, reject: (error: Error) => void}>} */
  const pending = new Map();
  const fail = () => {
    closed = true;
    for (const item of pending.values())
      item.reject(Error("ANTIGRAVITY_PROTOCOL_ERROR"));
    pending.clear();
    child.kill();
  };
  child.once("error", fail);
  child.once("close", fail);
  child.stdin?.on("error", fail);
  child.stderr?.on("data", () => {}); // Provider diagnostics may contain private inputs.
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (data) => {
    bytes += Buffer.byteLength(data);
    buffer += data;
    if (bytes > LIMIT) return fail();
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n"),
        line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line);
        if (message.jsonrpc !== "2.0") throw Error();
        if (message.method && message.id !== undefined) {
          // Allow rules and the PreToolUse hook authorize bridge tools. Any
          // additional interactive permission or client filesystem request is denied.
          child.stdin?.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              ...(message.method === "session/request_permission"
                ? { result: { outcome: { outcome: "cancelled" } } }
                : {
                    error: {
                      code: -32601,
                      message: "Client capability unavailable",
                    },
                  }),
            }) + "\n",
          );
        } else if (!message.method) {
          const item = pending.get(message.id);
          if (!item) throw Error();
          pending.delete(message.id);
          if (message.error) item.reject(Error("ANTIGRAVITY_PROTOCOL_ERROR"));
          else if (message.result && typeof message.result === "object")
            item.resolve(message.result);
          else {
            item.reject(Error("ANTIGRAVITY_PROTOCOL_ERROR"));
            fail();
          }
        }
      } catch {
        fail();
      }
    }
  });
  /** @param {string} method @param {any} params */
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      if (closed) return reject(Error("ANTIGRAVITY_PROTOCOL_ERROR"));
      const id = ++serial;
      pending.set(id, { resolve, reject });
      child.stdin?.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  const timer = setTimeout(fail, 660000);
  try {
    const init = await request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "qq-agents", version: "1" },
    });
    if (
      init.protocolVersion !== 1 ||
      init.agentCapabilities?.promptCapabilities?.image !== true ||
      (options.session && init.agentCapabilities?.loadSession !== true)
    )
      throw Error("ANTIGRAVITY_PROTOCOL_ERROR");
    const session = await request(
      options.session ? "session/load" : "session/new",
      {
        cwd: options.workspace,
        mcpServers: [
          {
            name: "qq-agents",
            command: process.execPath,
            args: [
              fileURLToPath(new URL("./antigravity-mcp.mjs", import.meta.url)),
            ],
            env: ["QQ_AGY_ENDPOINT", "QQ_AGY_TOKEN"].map((name) => ({
              name,
              value: process.env[name] || "",
            })),
          },
        ],
        ...(options.session ? { sessionId: options.session } : {}),
      },
    );
    const id = options.session || session.sessionId;
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id || ""))
      throw Error("ANTIGRAVITY_PROTOCOL_ERROR");
    if (options.model)
      await request("session/set_model", {
        sessionId: id,
        modelId: options.model,
      });
    if (options.effort)
      await request("session/set_config_option", {
        sessionId: id,
        configId: "thought_level",
        value: options.effort,
      });
    emit({ event: "init", conversation_id: id });
    const result = await request("session/prompt", {
      sessionId: id,
      prompt: [
        {
          type: "text",
          text: options.session
            ? 'ACP session resumed. For a bridge action, use the native MCP tool if it is listed for this turn. If the native name is absent or returns unknown tool before execution, use the available call_mcp_tool with ServerName="qq-agents", ToolName equal to the logical tool name (for example qq_send), and the same Arguments. Reuse the same requestId for the same send. A pending or unknown delivery is not a tool lookup error. Check its receipt before any further send. Tool errors from earlier turns do not determine the current catalogue. Only tools authorized by the current bridge may run.\n\n' +
              prompt
            : prompt,
        },
        ...inputImages.flatMap((image) => [
          { type: "text", text: image.label },
          ...(image.data
            ? [{ type: "image", mimeType: image.mimeType, data: image.data }]
            : []),
        ]),
      ],
    });
    if (closed || result.stopReason !== "end_turn")
      throw Error("ANTIGRAVITY_PROTOCOL_ERROR");
    // ACP turn usage can sum several inferences, so never claim it is the latest
    // context occupancy. The framework retains its conservative estimate.
    emit({
      event: "step_update",
      step_update: {
        conversation_id: id,
        step_index: 0,
        state: "DONE",
        step_type: "agent_response",
      },
    });
    emit({
      event: "result",
      result: { conversation_id: id, status: "SUCCESS" },
    });
  } finally {
    clearTimeout(timer);
    child.stdin?.end();
    child.kill();
  }
}

async function main() {
  let input = "";
  for await (const part of process.stdin) {
    input += part;
    if (Buffer.byteLength(input) > LIMIT)
      throw Error("ANTIGRAVITY_PROTOCOL_ERROR");
  }
  const message = JSON.parse(input);
  if (message.event !== "user" || typeof message.message?.content !== "string")
    throw Error("ANTIGRAVITY_PROTOCOL_ERROR");
  await runAcp(
    JSON.parse(process.argv[2]),
    message.message.content,
    (event) => process.stdout.write(JSON.stringify(event) + "\n"),
    undefined,
    message.message.inputImages || [],
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    process.stderr.write("ANTIGRAVITY_PROTOCOL_ERROR\n");
    process.exitCode = 1;
  });
