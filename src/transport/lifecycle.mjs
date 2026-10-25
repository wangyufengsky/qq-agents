import fs from "node:fs";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);

/** Explicit lifecycle control. Never discover/stop unrelated QQ processes or delete Docker resources. */
export class Lifecycle {
  constructor(root, { spawnProcess = spawn, execCommand = exec } = {}) {
    this.root = root;
    this.spawn = spawnProcess;
    this.exec = execCommand;
    this.owned = new Map();
    this.failures = new Map();
  }
  status(id) {
    return {
      managed: this.owned.has(id),
      error: this.failures.get(id) || null,
    };
  }
  async inspectContainer(config) {
    if (!config.container) throw Error("CONTAINER_NOT_CONFIGURED");
    const result = await this.exec(
      "docker",
      ["inspect", "--format", "{{json .Config.Labels}}", config.container],
      { timeout: 10000, maxBuffer: 65536 },
    );
    const labels = JSON.parse(result.stdout);
    if (labels?.["qq-bridge-unified.instance"] !== config.id)
      throw Error("CONTAINER_OWNERSHIP_LABEL_REQUIRED");
  }
  async start(config) {
    if (this.owned.has(config.id)) throw Error("PROCESS_ALREADY_MANAGED");
    if (config.deployment === "external")
      throw Error("EXTERNAL_PROCESS_NOT_MANAGED");
    if (config.deployment === "docker") {
      await this.inspectContainer(config);
      await this.exec("docker", ["start", config.container], {
        timeout: 30000,
        maxBuffer: 65536,
      });
      this.owned.set(config.id, { type: "docker", config });
      return;
    }
    if (!config.process) throw Error("NATIVE_PROCESS_NOT_CONFIGURED");
    const cwd = path.join(this.root, "qq-processes", config.id);
    fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
    const env = { ...process.env };
    for (const [key, ref] of Object.entries(config.process.env)) {
      if (!process.env[ref]) throw Error("PROCESS_ENV_MISSING");
      env[key] = process.env[ref];
    }
    const fd = fs.openSync(path.join(cwd, "process.log"), "a", 0o600);
    let child;
    try {
      child = this.spawn(config.process.command, config.process.args, {
        cwd,
        env,
        stdio: ["ignore", fd, fd],
        shell: false,
      });
    } finally {
      fs.closeSync(fd);
    }
    const item = { type: "native", child };
    this.owned.set(config.id, item);
    const finish = () => {
      if (this.owned.get(config.id) === item) {
        this.owned.delete(config.id);
        this.failures.set(config.id, "PROCESS_EXITED");
      }
    };
    child.once("error", finish);
    child.once("exit", finish);
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", () => reject(Error("PROCESS_START_FAILED")));
    });
    this.failures.delete(config.id);
  }
  async stop(id) {
    const item = this.owned.get(id);
    if (!item) throw Error("PROCESS_NOT_OWNED_BY_THIS_MANAGER");
    if (item.type === "docker") {
      await this.inspectContainer(item.config);
      await this.exec("docker", ["stop", item.config.container], {
        timeout: 30000,
        maxBuffer: 65536,
      });
      this.owned.delete(id);
      return;
    }
    await new Promise((resolve) => {
      const child = item.child;
      if (child.exitCode !== null && child.exitCode !== undefined) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 5000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });
    this.owned.delete(id);
    this.failures.delete(id);
  }
  async close() {
    await Promise.allSettled([...this.owned.keys()].map((id) => this.stop(id)));
  }
}
