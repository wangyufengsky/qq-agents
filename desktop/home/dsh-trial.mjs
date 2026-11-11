import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  deriveRelayToken,
  writeRelayToken,
} from "../../src/core/relay-auth.mjs";
import { NodeApiClient, unwrap } from "../../vendor/dsh-qq/dsh-client.js";

const token = () => randomBytes(32).toString("hex");
const payload = (value) => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
});

export async function startDshTrial(root, settings, tool, signal) {
  const { command, home, hostPort, bridgePort } = settings;
  if (
    !isAbsolute(command) ||
    home !== join(root, "dsh-host") ||
    ![hostPort, bridgePort].every(
      (port) => Number.isInteger(port) && port >= 1024 && port <= 65535,
    ) ||
    hostPort === bridgePort
  )
    throw Error("DESKTOP_DSH_PROFILE_INVALID");

  // The SDK reads its signing credential from the current process environment.
  // Pin the private home before both readiness probes and the adapter connect.
  process.env.DSH_HOME = home;
  delete process.env.DSH_LAUNCH_TOKEN;
  const localSecret = token();
  const relay = deriveRelayToken(localSecret);
  const active = new Map();
  const subjectRoutes = new Set([
    "/agent/catalog",
    "/agent/tools",
    "/agent/output-ack",
  ]);
  let subject;
  const bridge = createServer(async (request, response) => {
    const send = (status, body) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    const supplied = Buffer.from(
      String(request.headers["x-agent-relay-token"] ?? ""),
    );
    const expected = Buffer.from(relay);
    const scope = active.get(request.headers["x-agent-capability"]);
    if (
      request.method !== "POST" ||
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected) ||
      scope?.signal.aborted
    ) {
      request.resume();
      send(403, {});
      return;
    }
    try {
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        if (Buffer.byteLength(body) > 8192)
          throw Error("DESKTOP_TOOL_TOO_LARGE");
      }
      if (!scope && subject && subjectRoutes.has(request.url)) {
        const headers = {
          "content-type": "application/json",
          "x-agent-relay-token": subject.token,
        };
        for (const key of [
          "x-agent-capability",
          "x-agent-output-protocol",
          "x-agent-output-request",
        ])
          if (typeof request.headers[key] === "string")
            headers[key] = request.headers[key];
        const result = await fetch(
          `http://127.0.0.1:${subject.port}${request.url}`,
          {
            method: "POST",
            headers,
            body,
            signal: AbortSignal.timeout(10_000),
            redirect: "error",
          },
        );
        const forwarded = { "content-type": "application/json" };
        for (const key of ["x-agent-output-receipt", "x-agent-output-digest"])
          if (result.headers.has(key)) forwarded[key] = result.headers.get(key);
        response.writeHead(result.status, forwarded);
        response.end(await result.text());
        return;
      }
      if (!scope) return send(403, {});
      const input = JSON.parse(body);
      scope.signal.throwIfAborted();
      if (request.url === "/agent/catalog") {
        const available =
          !input.names || input.names.every((name) => name === tool.name);
        if (!available) return send(400, {});
        const tools =
          input.offset > 0
            ? []
            : [
                {
                  name: tool.name,
                  description: tool.description,
                  ...(input.names ? { inputSchema: tool.parameters } : {}),
                },
              ];
        send(200, payload({ tools, total: 1, nextOffset: null }));
      } else if (request.url === "/agent/tools" && input.name === tool.name) {
        send(200, await scope.call(input.name, input.arguments));
      } else send(404, {});
    } catch {
      if (!response.headersSent) send(400, {});
    }
  });
  bridge.requestTimeout = 10_000;
  await new Promise((resolve, reject) => {
    bridge.once("error", reject);
    bridge.listen(bridgePort, "127.0.0.1", resolve);
  });
  let host;
  try {
    signal?.throwIfAborted();
    writeRelayToken(root, localSecret);
    const baseUrl = `http://127.0.0.1:${hostPort}`;
    // Check the address before starting and bind subsequent authentication to
    // the startup receipt from this exact child.
    const portCheck = createServer();
    await new Promise((resolve, reject) => {
      portCheck.once("error", reject);
      portCheck.listen(hostPort, "127.0.0.1", resolve);
    });
    await new Promise((resolve) => portCheck.close(resolve));
    host = spawn(
      command,
      [
        "--profile",
        "desktop-home-trial",
        "--host",
        "127.0.0.1",
        "--port",
        String(hostPort),
        "--no-open",
      ],
      {
        cwd: home,
        env: { ...process.env, DSH_HOME: home },
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    let dead = false;
    let startupOutput = "";
    let launchToken;
    host.once("error", () => {
      dead = true;
    });
    host.once("exit", () => {
      dead = true;
    });
    const observeStartup = (chunk) => {
      startupOutput = (startupOutput + String(chunk)).slice(-4096);
      const match = /dsh web:\s+(https?:\/\/[^\s]+)\s/.exec(startupOutput);
      if (!match) return;
      try {
        const url = new URL(match[1]);
        const value = url.searchParams.get("token");
        if (url.origin === baseUrl && /^[A-Za-z0-9_-]{16,}$/.test(value ?? ""))
          launchToken = value;
      } catch {
        // An incomplete or unexpected startup line grants no access.
      }
    };
    host.stdout.on("data", observeStartup);
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !dead && !launchToken) {
      signal?.throwIfAborted();
      await delay(100, undefined, { signal });
    }
    host.stdout.off("data", observeStartup);
    host.stdout.resume();
    startupOutput = "";
    signal?.throwIfAborted();
    if (dead || !launchToken) throw Error("DESKTOP_DSH_START_FAILED");
    const newClient = () =>
      new NodeApiClient(baseUrl, 30000, {
        token: launchToken,
        tokenExplicit: true,
      });
    const client = newClient();
    const result = unwrap(
      await client.agentPresets.list({}, signal),
      "presets",
    );
    const list = result.presets || result.items || [];
    if (
      !list.some(
        (item) => (item.id || item.name) === "qq-unified" && !item.broken,
      )
    )
      throw Error("DESKTOP_DSH_PRESET_UNAVAILABLE");
    return {
      baseUrl,
      client,
      newClient,
      attachSubject(port, token) {
        subject = { port, token };
      },
      scope(signal, call) {
        const id = token();
        active.set(id, { signal, call });
        return { id, close: () => active.delete(id) };
      },
      async close() {
        active.clear();
        bridge.closeAllConnections();
        await new Promise((resolve) => bridge.close(resolve));
        host.kill();
      },
    };
  } catch (error) {
    host?.kill();
    bridge.closeAllConnections();
    bridge.close();
    throw error;
  }
}
