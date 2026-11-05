// @ts-check
import { prepareHomeBrowserJob } from "./browser-job.mjs";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";

// Playwright creates this wrapper's process group. Its browser inherits that
// group and the existing CDP pipes; no debugging port or personal profile opens.
const [marker, executablePath, _profile, controlFile] = process.argv.slice(2);
const control = JSON.parse(fs.readFileSync(controlFile, "utf8"));
// A cancelled launch may execute late. It must never spawn Chromium after its
// caller tombstones (or removes) the private control file.
if (control.stopping) process.exit(0);
if (
  !Array.isArray(control.arguments) ||
  control.arguments.some(
    (/** @type {unknown} */ arg) => typeof arg !== "string",
  )
)
  process.exit(1);
fs.writeFileSync(marker, String(process.pid), { mode: 0o600, flag: "wx" });
let stopping = false;
let jobEstablished = false;
function stopTree() {
  if (stopping) return;
  stopping = true;
  if (process.platform === "win32" && jobEstablished) process.exit(0);
  if (process.platform === "win32") {
    execFileSync(
      path.join(
        process.env.SystemRoot || "C:\\Windows",
        "System32",
        "taskkill.exe",
      ),
      ["/pid", String(process.pid), "/T", "/F"],
      { stdio: "ignore", windowsHide: true, timeout: 1000 },
    );
  } else process.kill(-process.pid, "SIGKILL");
}
process.on("uncaughtException", stopTree);
process.on("unhandledRejection", stopTree);
process.on("SIGTERM", stopTree);
process.on("SIGINT", stopTree);
const server = net.createServer((socket) => {
  let input = "";
  socket.setTimeout(1000, () => socket.destroy());
  socket.on("error", () => {});
  socket.on("data", (data) => {
    input += data;
    if (input.length > 1024) return socket.destroy();
    if (!input.includes("\n")) return;
    if (input.trim() === "job:" + control.nonce) {
      socket.end("authorized\n");
      return;
    }
    if (input.trim() !== control.nonce) return socket.destroy();
    socket.end("stopping\n", () => {
      // Only this living wrapper can authorize killing its own tree. A stale
      // PID file cannot authorize any action against a subsequently reused PID.
      stopTree();
    });
  });
});
server.on("error", stopTree);
server.listen(control.endpoint, async () => {
  try {
    await prepareHomeBrowserJob(controlFile, control);
    jobEstablished = process.platform === "win32";
  } catch {
    return stopTree();
  }
  if (JSON.parse(fs.readFileSync(controlFile, "utf8")).stopping)
    return stopTree();
  const child = spawn(
    executablePath,
    // Only the renderer owns this private record; bridge arguments cannot set it.
    control.arguments,
    { stdio: ["ignore", "inherit", "inherit", 3, 4], windowsHide: true },
  );
  // Main-browser exit does not prove its descendants have exited. While this
  // wrapper still owns its live group, close the whole tree on every exit path.
  const record = (
    /** @type {string} */ stage,
    /** @type {number | null} */ code = null,
  ) => {
    try {
      fs.writeFileSync(
        controlFile + ".browser-state",
        JSON.stringify({
          stage,
          code,
          at: Date.now(),
          wrapperUptimeMs: Math.round(process.uptime() * 1000),
        }),
        { mode: 0o600 },
      );
    } catch {
      /* Diagnostics cannot prevent cleanup. */
    }
  };
  child.on("spawn", () => record("spawned"));
  child.on("error", () => {
    record("spawn-error");
    stopTree();
  });
  child.on("exit", (code) => {
    record("exited", code);
    stopTree();
  });
});
