// @ts-check
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildChildEnv } from "../core/child-env.mjs";

const release = fileURLToPath(new URL("../..", import.meta.url));

export class DesktopLauncher {
  /** @type {import("node:child_process").ChildProcess | null} */
  child = null;
  /** @type {NodeJS.Timeout | undefined} */
  timer;

  /** @param {string} root */
  constructor(root) {
    this.root = root;
    this.state = "idle";
  }

  /** @param {number} port */
  open(port) {
    if (this.child) return;
    const env = buildChildEnv("desktop-home");
    env.PATH = [path.dirname(process.execPath), env.PATH]
      .filter(Boolean)
      .join(path.delimiter);
    const child = spawn(
      "npm",
      [
        "run",
        "desktop:home",
        "--",
        "--data",
        this.root,
        "--port",
        String(port),
      ],
      {
        cwd: release,
        env,
        detached: true,
        stdio: "ignore",
      },
    );
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
    if (this.state === "opening") {
      clearTimeout(this.timer);
      const pid = this.child?.pid;
      if (pid) {
        try {
          // Cancel only the process group created for this pending launch.
          process.kill(-pid, "SIGTERM");
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !("code" in error) ||
            error.code !== "ESRCH"
          )
            throw error;
        }
      }
    }
    this.state = state;
  }
}
