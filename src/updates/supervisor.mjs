import fs from "node:fs";
import path from "node:path";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { FrameworkKnowledge } from "../core/framework-knowledge.mjs";
import { UpgradeManager, finalPhases, safeUpdateError } from "./manager.mjs";
import { updateChannel } from "./managed-client.mjs";
import {
  readState,
  writeState,
  restoreData,
  updateDirectory,
} from "./installation.mjs";
import { compareVersions } from "./releases.mjs";

export class ManagedHost {
  constructor({ root, args, notify = () => {} }) {
    Object.assign(this, { root, args, notify });
    this.pending = new Map();
  }
  send(message) {
    if (!this.child?.connected) throw Error("UPDATE_MANAGER_OFFLINE");
    this.child.send({ channel: updateChannel, ...message });
  }
  async request(action, checkpoint, timeout = 90000) {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          Error(
            action === "stop" ? "UPDATE_STOP_FAILED" : "UPDATE_HEALTH_FAILED",
          ),
        );
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ type: "command", id, action, checkpoint });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  async start(installation, initial) {
    if (
      this.child &&
      this.child.exitCode === null &&
      this.child.signalCode === null
    )
      throw Error("UPDATE_PROCESS_STILL_RUNNING");
    const fd = fs.openSync(
      path.join(this.root, updateDirectory, "manager.log"),
      "a",
      0o600,
    );
    const args = initial
      ? this.args
      : [
          ...this.args.filter(
            (arg, i) =>
              arg !== "--resume" &&
              arg !== "--port" &&
              this.args[i - 1] !== "--port",
          ),
          "--port",
          String(this.port),
          "--upgrade-hold",
        ];
    try {
      this.child = fork(
        path.join(installation.codeRoot, "src/main.mjs"),
        [...args, "--data", this.root, "--managed-updates"],
        {
          cwd: installation.codeRoot,
          execArgv: [],
          stdio: ["ignore", fd, fd, "ipc"],
          windowsHide: true,
        },
      );
    } finally {
      fs.closeSync(fd);
    }
    const child = this.child;
    this.exited = new Promise((resolve) =>
      child.once("exit", (code) => {
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(Error("UPDATE_STOP_FAILED"));
          this.pending.delete(id);
        }
        resolve(code);
        this.notify("exit", code);
      }),
    );
    await new Promise((resolve, reject) => {
      let ready = false;
      const timer = setTimeout(
        () => reject(Error("UPDATE_START_FAILED")),
        60000,
      );
      child.once("error", () => {
        clearTimeout(timer);
        reject(Error("UPDATE_START_FAILED"));
      });
      child.once("exit", () => {
        clearTimeout(timer);
        if (!ready) reject(Error("UPDATE_START_FAILED"));
      });
      child.on("message", (message) => {
        if (message?.channel !== updateChannel) return;
        if (message.type === "ready") {
          if (
            message.protocol !== 1 ||
            message.installed.commit !== installation.commit ||
            message.installed.packageVersion !== installation.version
          ) {
            clearTimeout(timer);
            reject(Error("UPDATE_START_FAILED"));
            return;
          }
          ready = true;
          clearTimeout(timer);
          this.port = message.port;
          resolve();
        } else if (message.type === "reply") {
          const request = this.pending.get(message.id);
          if (!request) return;
          clearTimeout(request.timer);
          this.pending.delete(message.id);
          if (message.error) request.reject(Error(message.error));
          else request.resolve(message.value);
        } else if (message.type === "install") this.notify("install", message);
      });
    });
    this.notify("ready");
  }
  async waitStopped() {
    let timer;
    try {
      const code = await Promise.race([
        this.exited,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error("UPDATE_STOP_FAILED")), 40000);
        }),
      ]);
      if (code !== 0 || fs.existsSync(path.join(this.root, "process.lock")))
        throw Error("UPDATE_STOP_FAILED");
    } finally {
      clearTimeout(timer);
    }
  }
  async stop() {
    let checkpoint;
    try {
      checkpoint = await this.request("stop", undefined, 40000);
    } catch {
      throw Error("UPDATE_STOP_FAILED");
    }
    await this.waitStopped();
    return checkpoint;
  }
  async stopCandidate() {
    if (
      this.child &&
      this.child.exitCode === null &&
      this.child.signalCode === null
    )
      try {
        await this.stop();
      } catch {
        this.child.kill("SIGTERM");
        await this.waitStopped();
      }
    if (fs.existsSync(path.join(this.root, "process.lock")))
      throw Error("UPDATE_PROCESS_STILL_RUNNING");
  }
  health(checkpoint) {
    return this.request("health", checkpoint);
  }
  resume(checkpoint) {
    return this.request("resume", checkpoint);
  }
  async hold() {
    if (this.child?.connected) await this.request("hold");
  }
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}
function reclaim(file, home, recover) {
  if (!fs.existsSync(file)) return;
  if (!recover || alive(readState(file).pid))
    throw Error("UPDATE_PROCESS_STILL_RUNNING");
  fs.renameSync(file, path.join(home, `stale-lock-${randomUUID()}.json`));
}
export async function supervise(argv = process.argv.slice(2)) {
  const flags = new Set(["--live", "--resume", "--recover"]);
  const options = new Set([
    "--data",
    "--port",
    "--host",
    "--public-port",
    "--shutdown-timeout-ms",
  ]);
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    if (seen.has(name) || (!flags.has(name) && !options.has(name)))
      throw Error("UPDATE_START_OPTIONS_UNSUPPORTED");
    seen.add(name);
    if (options.has(name) && (!argv[++i] || argv[i].startsWith("--")))
      throw Error("UPDATE_START_OPTIONS_UNSUPPORTED");
  }
  const option = (name) =>
    argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
  if (argv.includes("--config") || argv.includes("--managed-updates"))
    throw Error("UPDATE_START_OPTIONS_UNSUPPORTED");
  const root = path.resolve(option("--data") || ".runtime");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(root).isSymbolicLink())
    throw Error("UPDATE_DATA_LINK_UNSUPPORTED");
  const home = path.join(root, updateDirectory);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(home).isSymbolicLink())
    throw Error("UPDATE_DATA_LINK_UNSUPPORTED");
  const recover = argv.includes("--recover");
  const lockFile = path.join(home, "supervisor.lock");
  reclaim(lockFile, home, recover);
  const lock = fs.openSync(lockFile, "wx", 0o600);
  const owner = randomUUID();
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, owner }));
  fs.closeSync(lock);
  let host,
    manager,
    ending = false;
  const release = () => {
    if (fs.existsSync(lockFile) && readState(lockFile).owner === owner)
      fs.unlinkSync(lockFile);
  };
  try {
    reclaim(path.join(root, "process.lock"), home, recover);
    const bundledRoot = fileURLToPath(new URL("../..", import.meta.url));
    const identity = new FrameworkKnowledge({ root: bundledRoot }).version;
    const bundled = {
      codeRoot: bundledRoot,
      commit: identity.commit,
      version: identity.packageVersion,
    };
    const validInstallation = (value, allowBundledReplacement = false) => {
      if (
        !value ||
        typeof value.codeRoot !== "string" ||
        !fs.existsSync(value.codeRoot)
      )
        throw Error("UPDATE_STATE_INVALID");
      const resolved = fs.realpathSync(value.codeRoot);
      if (
        resolved !== fs.realpathSync(bundledRoot) &&
        !resolved.startsWith(
          fs.realpathSync(home) + path.sep + "releases" + path.sep,
        )
      )
        throw Error("UPDATE_STATE_INVALID");
      // A replacement image can install newer files at the same bundled path.
      // Interrupted transactions must still use their exact recorded identity.
      if (
        allowBundledReplacement &&
        resolved === fs.realpathSync(bundledRoot) &&
        compareVersions(bundled.version, value.version) === 1
      )
        return bundled;
      const actual = new FrameworkKnowledge({ root: resolved }).version;
      if (
        actual.commit !== value.commit ||
        actual.packageVersion !== value.version
      )
        throw Error("UPDATE_STATE_INVALID");
      return { ...value, codeRoot: resolved };
    };
    const pointer = path.join(home, "current.json"),
      journal = path.join(home, "transaction.json");
    const previous = fs.existsSync(journal)
      ? readState(journal)
      : { phase: "idle" };
    const interrupted =
      !finalPhases.has(previous.phase) ||
      previous.phase === "recovery-required";
    let current = fs.existsSync(pointer)
      ? validInstallation(readState(pointer), !interrupted)
      : bundled;
    if (interrupted) {
      if (!recover) throw Error("UPDATE_RECOVERY_REQUIRED");
      if (previous.committing) current = validInstallation(previous.to);
      else {
        current = validInstallation(previous.from);
        if (previous.backupReady) {
          const expected = path.join(home, `backup-${previous.id}`);
          if (previous.backup !== expected) throw Error("UPDATE_STATE_INVALID");
          restoreData(
            root,
            expected,
            path.join(home, `interrupted-${randomUUID()}`),
          );
        }
      }
      writeState(pointer, current);
      writeState(journal, {
        ...previous,
        phase: previous.committing ? "failed" : "rolled-back",
        error: "UPDATE_RECOVERY_REQUIRED",
        finishedAt: Date.now(),
      });
    } else if (
      (current === bundled && fs.existsSync(pointer)) ||
      compareVersions(bundled.version, current.version) === 1
    ) {
      current = bundled;
      writeState(pointer, bundled);
    }
    const args = argv.filter(
      (arg, i) =>
        arg !== "--recover" &&
        arg !== "--data" &&
        argv[i - 1] !== "--data" &&
        !(recover && arg === "--resume"),
    );
    host = new ManagedHost({
      root,
      args,
      notify: (event, value) => {
        if (event === "ready")
          host.send({ type: "state", state: manager.snapshot() });
        if (event === "install") {
          try {
            host.send({
              type: "reply",
              id: value.id,
              value: manager.install(value.tag),
            });
          } catch (error) {
            host.send({
              type: "reply",
              id: value.id,
              error:
                error.message === "UPDATE_IN_PROGRESS"
                  ? error.message
                  : safeUpdateError(error),
            });
          }
        }
        if (event === "exit" && !manager?.job && !ending) {
          ending = true;
          release();
          process.exitCode = value || 1;
        }
      },
    });
    manager = new UpgradeManager({
      root,
      home,
      current,
      host,
      container: fs.existsSync("/.dockerenv"),
      notify: (state) => {
        if (host.child?.connected) host.send({ type: "state", state });
      },
    });
    if (fs.existsSync(journal)) manager.state = readState(journal);
    const stop = async () => {
      if (ending) return;
      ending = true;
      manager.cancel();
      await manager.job?.catch(() => {});
      await host.stopCandidate().catch(() => {
        process.exitCode = 1;
      });
      release();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    if (process.platform === "win32") {
      process.once("SIGHUP", stop);
      process.once("SIGBREAK", stop);
    }
    await host.start(current, true);
    console.log(
      `QQ Agents managed: http://127.0.0.1:${option("--public-port") || host.port}`,
    );
  } catch (error) {
    ending = true;
    await host?.stopCandidate().catch(() => {});
    release();
    throw error;
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  supervise().catch((error) => {
    console.error(
      error.message.startsWith("UPDATE_")
        ? error.message
        : "UPDATE_START_FAILED",
    );
    process.exitCode = 1;
  });
}
