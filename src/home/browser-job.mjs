// @ts-check
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const compile = promisify(execFile);

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
  // Use the system .NET Framework compiler directly. A console host, PowerShell
  // startup and Add-Type consumed the admission budget before Chromium started.
  const deadline = Date.now() + 8000;
  const framework = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "Microsoft.NET",
  );
  const compiler = ["Framework64", "Framework"]
    .map((dir) => path.join(framework, dir, "v4.0.30319", "csc.exe"))
    .find((file) => fsSync.existsSync(file));
  if (!compiler) throw Error("HOME_SCENE_RENDER_FAILED");
  const executable = path.join(path.dirname(controlFile), "browser-job.exe");
  await compile(
    compiler,
    [
      "/nologo",
      "/target:winexe",
      "/optimize+",
      "/reference:System.Web.Extensions.dll",
      "/out:" + executable,
      fileURLToPath(new URL("./browser-job.cs", import.meta.url)),
    ],
    { timeout: Math.max(1, deadline - Date.now()), windowsHide: true },
  );
  if (JSON.parse(await fs.readFile(controlFile, "utf8")).stopping)
    throw Error("HOME_SCENE_RENDER_FAILED");
  // The private GUI-subsystem helper needs no console host. It stays outside
  // the wrapper's job so it can independently confirm descendant cleanup.
  record("starting", undefined);
  const helper = spawn(executable, [controlFile], {
    stdio: "ignore",
    windowsHide: true,
    detached: true,
  });
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
    failed = true;
  });
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
