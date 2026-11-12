// @ts-check
import path from "node:path";
import { fileURLToPath } from "node:url";
import crossSpawn from "cross-spawn";
import { buildChildEnv } from "../core/child-env.mjs";
import { taskkillTree } from "../core/windows-process.mjs";
import { managedDesktopExecutable } from "./desktop-dependencies.mjs";

const release = fileURLToPath(new URL("../..", import.meta.url));

export class DesktopLauncher {
  /** @param {NodeJS.Platform} [platform] */
  static supports(platform = process.platform) {
    return platform === "darwin" || platform === "win32";
  }

  /** @type {import("node:child_process").ChildProcess | null} */
  child = null;
  /** @type {NodeJS.Timeout | undefined} */
  timer;

  /**
   * @param {string} root
   * @param {{ spawn?: typeof crossSpawn }} [options]
   */
  constructor(root, { spawn = crossSpawn } = {}) {
    this.root = root;
    this.spawn = spawn;
    this.state = "idle";
  }

  /** @param {number} port */
  open(port) {
    if (this.child) return;
    const env = buildChildEnv("desktop-home");
    env.PATH = [path.dirname(process.execPath), env.PATH]
      .filter(Boolean)
      .join(path.delimiter);
    const windows = process.platform === "win32";
    const executable = managedDesktopExecutable(this.root, "electron");
    const args = executable ? ["desktop/home"] : ["run", "desktop:home"];
    if (windows && !executable) {
      // npm runs the script through cmd.exe. Keep user paths out of the command.
      env.DESKTOP_HOME_DATA_ROOT = this.root;
      env.DESKTOP_HOME_PORT = String(port);
    } else {
      if (!executable) args.push("--");
      args.push("--data", this.root, "--port", String(port));
    }
    const child = this.spawn(executable || "npm", args, {
      cwd: release,
      env,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    this.child = child;
    this.state = "opening";
    const ended = () => {
      if (this.child !== child) return;
      clearTimeout(this.timer);
      this.child = null;
      if (this.state === "opening") this.state = "failed";
      else if (this.state === "open") this.state = "idle";
    };
    child.once("error", ended);
    child.once("exit", ended);
    child.unref();
    this.timer = setTimeout(() => this.cancel("failed"), 120_000);
    this.timer.unref();
  }

  connected() {
    if (this.state !== "opening") return;
    clearTimeout(this.timer);
    this.state = "open";
  }

  cancel(state = "idle") {
    const child = this.state === "opening" ? this.child : null;
    this.state = state;
    if (!child) return;
    clearTimeout(this.timer);
    if (!child.pid || child.exitCode !== null || child.signalCode !== null)
      return;
    try {
      // Stop only the tree owned by this pending launch. An attached client
      // sees the closed room via the client protocol and quits on its own.
      if (process.platform === "win32") taskkillTree(child.pid);
      else process.kill(-child.pid, "SIGTERM");
    } catch (error) {
      if (process.platform === "win32") {
        // The wrapper may already have exited. Never retry by process name.
        child.kill();
      } else if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ESRCH"
      )
        throw error;
    }
  }
}
