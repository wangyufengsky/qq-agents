import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

test("the bridge MCP helper exits after losing its lease even when stdin remains open", async (t) => {
  let leases = 0;
  const ready = Promise.withResolvers();
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer synthetic-lease-token");
    if (req.url === "/lease") {
      leases++;
      if (leases >= 2) ready.resolve();
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ alive: true }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(
        new URL("../src/backends/antigravity-mcp.mjs", import.meta.url),
      ),
    ],
    {
      env: {
        ...process.env,
        QQ_AGY_ENDPOINT: `http://127.0.0.1:${server.address().port}`,
        QQ_AGY_TOKEN: "synthetic-lease-token",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let diagnostic = "";
  child.stderr.on("data", (data) => {
    diagnostic += data;
  });
  t.after(() => {
    child.kill();
    server.closeAllConnections();
    server.close();
  });
  const deadline = new Promise((_, reject) => {
    const timer = setTimeout(
      () => reject(Error("MCP_LEASE_TEST_TIMEOUT")),
      15000,
    );
    timer.unref();
  });
  await Promise.race([ready.promise, deadline]);
  assert.equal(child.exitCode, null, diagnostic);
  assert.equal(child.stdin.destroyed, false);
  const exited = once(child, "exit");
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  const [code] = await Promise.race([exited, deadline]);
  assert.equal(code, 0, diagnostic);
  assert(leases >= 2);
});
