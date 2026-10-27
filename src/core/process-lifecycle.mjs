import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Diagnostics } from "./diagnostics.mjs";

export function acquireProcessLock(root) {
  const file = path.join(root, "process.lock");
  const owner = randomUUID();
  let fd, stat;
  try {
    fd = fs.openSync(file, "wx", 0o600);
    stat = fs.fstatSync(fd);
    fs.writeFileSync(
      fd,
      JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        owner,
      }),
    );
  } catch (cause) {
    if (stat) {
      try {
        const current = fs.lstatSync(file);
        if (current.dev === stat.dev && current.ino === stat.ino)
          fs.unlinkSync(file);
      } catch {
        // Best-effort cleanup; the original failure is thrown below.
      }
    }
    throw Error(
      cause.code === "EEXIST"
        ? "DATA_DIRECTORY_LOCKED"
        : "PROCESS_LOCK_CREATE_FAILED",
      { cause },
    );
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  let released = false;
  return {
    release() {
      if (released) return;
      try {
        const current = fs.lstatSync(file);
        if (
          current.isSymbolicLink() ||
          current.dev !== stat.dev ||
          current.ino !== stat.ino ||
          JSON.parse(fs.readFileSync(file, "utf8")).owner !== owner
        )
          throw Error("PROCESS_LOCK_RELEASE_FAILED");
        fs.unlinkSync(file);
        released = true;
      } catch (cause) {
        if (cause.code === "ENOENT") {
          released = true;
          return;
        }
        throw Error("PROCESS_LOCK_RELEASE_FAILED", { cause });
      }
    },
  };
}

// The final exit is synchronous. If graceful shutdown times out, no asynchronous
// callback may run between closing the database/releasing the lock and exiting.
export class ProcessLifecycle {
  constructor({
    diagnostics = new Diagnostics(),
    timeoutMs = 30000,
    exit = (code) => process.exit(code),
  } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000)
      throw Error("INVALID_BUDGET");
    Object.assign(this, { diagnostics, timeoutMs, exit });
    this.exitCode = 0;
  }
  stop(code = 0) {
    this.exitCode = Math.max(this.exitCode, code);
    if (this.stopping) return this.stopping;
    this.timer = setTimeout(
      () => this.force("SHUTDOWN_TIMEOUT"),
      this.timeoutMs,
    );
    this.stopping = this.drain();
    return this.stopping;
  }
  async drain() {
    // HTTP and runtime shutdown cooperate: stop sockets while aborting model work.
    const results = await Promise.allSettled([
      Promise.resolve().then(() => this.runtime?.close()),
      Promise.resolve().then(() => this.server?.close()),
    ]);
    for (const result of results) {
      if (result.status === "rejected") {
        this.exitCode = 1;
        this.diagnostics.report(result.reason, { component: "shutdown" });
      } else if (result.value?.ok === false) this.exitCode = 1;
    }
    this.finish();
  }
  signal() {
    if (this.stopping) this.force("SHUTDOWN_INTERRUPTED");
    else void this.stop();
  }
  force(code) {
    if (this.finished) return;
    this.exitCode = 1;
    this.diagnostics.report(Error(code), { component: "shutdown" });
    this.finish();
  }
  finish() {
    if (this.finished) return;
    this.finished = true;
    clearTimeout(this.timer);
    for (const close of [
      () => this.memory?.interruptDeliveries?.(),
      () => this.memory?.close(),
      () => this.lock?.release(),
    ]) {
      try {
        close();
      } catch (error) {
        this.exitCode = 1;
        this.diagnostics.report(error, { component: "shutdown" });
      }
    }
    this.exit(this.exitCode);
  }
}
