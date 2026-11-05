// @ts-check
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { spawn } from "node:child_process";
import { buildChildEnv } from "../src/core/child-env.mjs";
if (process.platform !== "win32") process.exit(0);
const system = process.env.SystemRoot || "C:\\Windows";
const executable = path.join(
  system,
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const filtered = buildChildEnv("browser");
console.log(
  JSON.stringify({
    envPresence: Object.fromEntries(
      [
        "SYSTEMROOT",
        "WINDIR",
        "COMSPEC",
        "TEMP",
        "USERPROFILE",
        "PSMODULEPATH",
      ].map((name) => [name, Boolean(filtered[name])]),
    ),
  }),
);
// Every probe writes a private file before using Console or loading modules.
// Headless hosts may consume stdout themselves; exit=0 is not execution proof.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "home-ps-probe-"));
try {
  for (const mode of [
    "direct-attached",
    "host-null-hidden",
    "host-pipe-hidden",
    "host-pipe-visible",
  ]) {
    const marker = path.join(root, mode + ".json");
    const started = Date.now();
    const command = `[IO.File]::WriteAllText('${marker.replaceAll("'", "''")}', 'entered');`;
    await new Promise((resolve) => {
      const hosted = mode !== "direct-attached";
      const child = spawn(
        hosted ? path.join(system, "System32", "conhost.exe") : executable,
        [
          ...(hosted ? ["--headless", executable] : []),
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          command,
        ],
        {
          env: filtered,
          detached: hosted,
          windowsHide: mode !== "host-pipe-visible",
          stdio: [mode.includes("pipe") ? "pipe" : "ignore", "pipe", "pipe"],
        },
      );
      let stderrBytes = 0;
      child.stdout?.resume();
      child.stderr?.on("data", (data) => {
        stderrBytes += data.length;
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), 12000);
      child.once("error", () => {
        clearTimeout(timer);
        resolve(undefined);
      });
      child.once("close", async (code) => {
        clearTimeout(timer);
        let entered = false;
        try {
          entered = (await fs.readFile(marker, "utf8")) === "entered";
        } catch {
          /* Missing marker proves no script execution. */
        }
        console.log(
          JSON.stringify({
            mode,
            code,
            entered,
            stderrBytes,
            elapsedMs: Date.now() - started,
          }),
        );
        resolve(undefined);
      });
    });
  }
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
