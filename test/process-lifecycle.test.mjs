import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { temp, config } from "./helpers.mjs";
import { Diagnostics } from "../src/core/diagnostics.mjs";
import { MemoryStore } from "../src/memory/store.mjs";
import {
  acquireProcessLock,
  ProcessLifecycle,
} from "../src/core/process-lifecycle.mjs";

test("process shutdown releases its lock and closes the database even when a service close fails", async (t) => {
  const root = temp(t),
    lock = acquireProcessLock(root);
  let databaseClosed = false,
    exitCode;
  const lifecycle = new ProcessLifecycle({
    diagnostics: new Diagnostics({ write() {} }),
    exit: (code) => {
      exitCode = code;
    },
  });
  Object.assign(lifecycle, {
    lock,
    runtime: {
      close: async () => {
        throw Error("synthetic service failure");
      },
    },
    server: { close: async () => {} },
    memory: {
      close: () => {
        databaseClosed = true;
      },
    },
  });
  const first = lifecycle.stop();
  assert.equal(first, lifecycle.stop());
  await first;
  assert.equal(databaseClosed, true);
  assert.equal(exitCode, 1);
  assert.equal(fs.existsSync(path.join(root, "process.lock")), false);
});

test("locks reject another owner, preserve replaced locks and clean up failed acquisition", (t) => {
  const root = temp(t),
    file = path.join(root, "process.lock");
  const first = acquireProcessLock(root);
  const bytes = fs.readFileSync(file, "utf8");
  assert.throws(() => acquireProcessLock(root), /DATA_DIRECTORY_LOCKED/);
  assert.equal(fs.readFileSync(file, "utf8"), bytes);
  fs.writeFileSync(file, JSON.stringify({ owner: "different-owner" }));
  assert.throws(() => first.release(), /PROCESS_LOCK_RELEASE_FAILED/);
  assert.equal(JSON.parse(fs.readFileSync(file)).owner, "different-owner");
  fs.unlinkSync(file);
  const write = fs.writeFileSync;
  const fault = t.mock.method(fs, "writeFileSync", (target, ...args) => {
    if (typeof target === "number")
      throw Object.assign(Error("synthetic disk full"), { code: "ENOSPC" });
    return write(target, ...args);
  });
  assert.throws(() => acquireProcessLock(root), /PROCESS_LOCK_CREATE_FAILED/);
  assert.equal(fs.existsSync(file), false);
  fault.mock.restore();
  const next = acquireProcessLock(root);
  next.release();
  next.release();
});

function child(t, args) {
  const process = spawn(globalThis.process.execPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  process.stdout.on("data", (b) => {
    stdout += b;
  });
  process.stderr.on("data", (b) => {
    stderr += b;
  });
  const exited = once(process, "exit");
  const watchdog = setTimeout(() => process.kill("SIGKILL"), 10000);
  t.after(() => {
    clearTimeout(watchdog);
    if (process.exitCode === null) process.kill("SIGKILL");
  });
  return {
    process,
    exited,
    output: () => ({ stdout, stderr }),
    async ready(marker) {
      for (let i = 0; i < 1000; i++) {
        if (stdout.includes(marker)) return;
        if (process.exitCode !== null)
          throw Error("synthetic child exited before ready");
        await delay(5);
      }
      throw Error("synthetic child startup timeout");
    },
  };
}

for (const mode of ["timeout", "second-signal"])
  test(
    `a ${mode} forces a nonzero exit only after releasing the owned process lock`,
    { skip: process.platform === "win32" },
    async (t) => {
      const root = temp(t);
      const module = new URL(
        "../src/core/process-lifecycle.mjs",
        import.meta.url,
      ).href;
      const script = `import { acquireProcessLock, ProcessLifecycle } from ${JSON.stringify(module)};
      import { MemoryStore } from ${JSON.stringify(new URL("../src/memory/store.mjs", import.meta.url).href)};
      const lifecycle = new ProcessLifecycle({ timeoutMs: ${mode === "timeout" ? 50 : 5000} });
      lifecycle.lock = acquireProcessLock(${JSON.stringify(root)});
      lifecycle.memory = new MemoryStore(${JSON.stringify(path.join(root, "memory.sqlite"))});
      const memory = lifecycle.memory.bind("synthetic");
      memory.reserveDelivery("pending", "group:20000", []);
      memory.reserveDelivery("confirmed", "group:20000", []);
      memory.completeDelivery("confirmed", "sent", "synthetic-receipt");
      lifecycle.runtime = { close: () => { console.log("closing"); return new Promise(() => {}); } };
      process.on("SIGTERM", () => lifecycle.signal());
      setInterval(() => {}, 1000);
      console.log("ready");
      ${mode === "timeout" ? "void lifecycle.stop();" : ""}`;
      const c = child(t, ["--input-type=module", "-e", script]);
      await c.ready("ready");
      if (mode === "second-signal") {
        c.process.kill("SIGTERM");
        await c.ready("closing");
        c.process.kill("SIGTERM");
      }
      assert.equal((await c.exited)[0], 1);
      assert.equal(fs.existsSync(path.join(root, "process.lock")), false);
      const store = new MemoryStore(path.join(root, "memory.sqlite"));
      try {
        assert.equal(
          store.bind("synthetic").delivery("pending").status,
          "unknown",
        );
        assert.equal(
          store.bind("synthetic").delivery("confirmed").status,
          "sent",
        );
      } finally {
        store.close();
      }
      assert.match(
        c.output().stderr,
        new RegExp(
          mode === "timeout" ? "SHUTDOWN_TIMEOUT" : "SHUTDOWN_INTERRUPTED",
        ),
      );
    },
  );

test(
  "the executable rejects a second process and releases its own lock on SIGTERM",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = temp(t),
      cfg = config(1);
    cfg.mode = "isolated";
    cfg.globalPaused = true;
    fs.writeFileSync(path.join(root, "config.json"), JSON.stringify(cfg));
    const args = [
      fileURLToPath(new URL("../src/main.mjs", import.meta.url)),
      "--data",
      root,
      "--port",
      "0",
    ];
    const first = child(t, args);
    await first.ready("QQ Agents:");
    const lock = fs.readFileSync(path.join(root, "process.lock"), "utf8");
    const second = child(t, args);
    assert.equal((await second.exited)[0], 1);
    assert.match(second.output().stderr, /DATA_DIRECTORY_LOCKED/);
    assert.equal(
      fs.readFileSync(path.join(root, "process.lock"), "utf8"),
      lock,
    );
    first.process.kill("SIGTERM");
    assert.equal((await first.exited)[0], 0);
    assert.equal(fs.existsSync(path.join(root, "process.lock")), false);
  },
);
