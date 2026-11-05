// @ts-check
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

/** Establish a native kill-on-close job before the wrapper may spawn Chromium.
 * @param {string} controlFile @param {{nonce:string}} control */
export async function prepareHomeBrowserJob(controlFile, control) {
  if (process.platform !== "win32") return;
  if (JSON.parse(await fs.readFile(controlFile, "utf8")).stopping)
    throw Error("HOME_SCENE_RENDER_FAILED");
  const recordFile = controlFile + ".job-helper";
  const record = (
    /** @type {string} */ state,
    /** @type {number | undefined} */ pid,
  ) =>
    fsSync.writeFileSync(
      recordFile,
      JSON.stringify({ nonce: control.nonce, state, ...(pid ? { pid } : {}) }),
      { mode: 0o600 },
    );
  // An attempt receipt precedes spawn, so a missing receipt proves no helper was
  // ever created. An interrupted starting receipt remains an unknown, not success.
  record("starting", undefined);
  // DETACHED_PROCESS alone makes Windows PowerShell exit without executing.
  // The fixed system console host supplies a headless console while retaining
  // independence from the wrapper's libuv kill-on-close job.
  const helper = spawn(
    path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "conhost.exe",
    ),
    [
      "--headless",
      path.join(
        process.env.SystemRoot || "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      fileURLToPath(new URL("./browser-job.ps1", import.meta.url)),
      "-ControlFile",
      controlFile,
    ],
    { stdio: ["pipe", "ignore", "ignore"], windowsHide: true, detached: true },
  );
  helper.stdin?.on("error", () => {});
  record(helper.pid ? "spawned" : "not-started", helper.pid);
  // libuv assigns non-detached Windows children to the parent Node kill job.
  // This guardian must survive that parent long enough to verify its own job.
  helper.unref();
  let failed = false;
  helper.on("error", () => {
    try {
      record(helper.pid ? "spawned" : "not-started", helper.pid);
    } catch {
      /* Caller keeps unknown cleanup reserved. */
    }
    failed = true;
  });
  helper.on("exit", () => {
    try {
      record("exited", helper.pid);
    } catch {
      /* Exit can follow capture-directory cleanup. */
    }
    // The console host may exit after the authenticated guardian FreeConsole.
    // Only a ready receipt identifies the independent native Job owner.
  });
  const deadline = Date.now() + 8000;
  while (!failed && Date.now() < deadline) {
    try {
      const ready = JSON.parse(
        await fs.readFile(controlFile + ".job-ready", "utf8"),
      );
      if (
        ready.nonce !== control.nonce ||
        ready.parentPid !== process.pid ||
        !ready.created ||
        ready.hostPid !== helper.pid
      )
        throw Error("HOME_SCENE_RENDER_FAILED");
      return;
    } catch (error) {
      if (
        /** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT" &&
        !(error instanceof SyntaxError)
      )
        throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await fs.writeFile(
    controlFile + ".job-launch-state",
    JSON.stringify({ stage: failed ? "helper-exited" : "setup-timeout" }),
    { mode: 0o600 },
  );
  throw Error("HOME_SCENE_RENDER_FAILED");
}
