import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildChildEnv } from "../src/core/child-env.mjs";
import { stopHomeBrowser } from "../src/home/browser-process.mjs";
import { chromium } from "playwright-core";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const endpoint = (root, label) =>
  process.platform === "win32"
    ? String.raw`\\.\pipe\qq-home-${label}-${randomUUID()}`
    : path.join(root, label + ".sock");
async function contact(pipe, nonce, action = "ping") {
  return new Promise((resolve) => {
    const socket = net.connect(pipe);
    let response = "";
    const finish = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(300, () => finish(false));
    socket.on("error", () => finish(false));
    socket.on("close", () => finish(false));
    socket.on("connect", () => socket.write(`${action}:${nonce}\n`));
    socket.on("data", (data) => {
      response += data;
      if (response.includes("alive")) finish(true);
    });
  });
}
function wrapper(marker, controlFile, root, executable = process.execPath) {
  return spawn(
    process.execPath,
    [
      fileURLToPath(
        new URL("../src/home/browser-launcher.mjs", import.meta.url),
      ),
      marker,
      executable,
      path.join(root, "profile"),
      controlFile,
    ],
    {
      detached: process.platform !== "win32",
      stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
      windowsHide: true,
      env: buildChildEnv("browser"),
    },
  );
}
async function exited(child, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (
    child.exitCode === null &&
    child.signalCode === null &&
    Date.now() < deadline
  )
    await pause(10);
  assert.ok(
    child.exitCode !== null || child.signalCode !== null,
    "owned wrapper did not exit",
  );
}

for (const termination of ["browser-exit", "wrapper-exit"])
  test(`native owned browser tree cleans descendants on ${termination}`, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "home-tree-test-"));
    const marker = path.join(root, "wrapper.pid"),
      controlFile = path.join(root, "control.json");
    const workerReady = path.join(root, "worker-ready"),
      workerEndpoint = endpoint(root, "worker"),
      workerNonce = randomUUID();
    const worker = `const net=require('node:net'),fs=require('node:fs');const server=net.createServer(s=>s.once('data',d=>{if(d.toString().trim()===${JSON.stringify("stop:" + workerNonce)})process.exit(0);else if(d.toString().trim()===${JSON.stringify("ping:" + workerNonce)})s.end('alive');else s.destroy();}));server.listen(${JSON.stringify(workerEndpoint)},()=>fs.writeFileSync(${JSON.stringify(workerReady)},String(process.pid)));`;
    const browser = `const fs=require('node:fs');const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(worker)}],{stdio:'ignore',detached:process.platform==='win32'});c.unref();const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(workerReady)})){clearInterval(timer);${termination === "browser-exit" ? "process.exit(0)" : "setInterval(()=>{},1000)"}}},10);`;
    const control = {
      nonce: randomUUID(),
      endpoint: endpoint(root, "control"),
      arguments: ["-e", browser],
    };
    await fs.writeFile(controlFile, JSON.stringify(control), { mode: 0o600 });
    const child = wrapper(marker, controlFile, root);
    t.after(async () => {
      await stopHomeBrowser(marker, control).catch(() => {});
      await contact(workerEndpoint, workerNonce, "stop");
      await fs.rm(root, { recursive: true, force: true });
    });
    if (termination === "wrapper-exit") {
      for (let i = 0; i < 1500; i++) {
        try {
          await fs.access(workerReady);
          break;
        } catch {
          // Readiness is written only after the worker binds its control pipe.
        }
        await pause(10);
      }
      await fs.access(workerReady);
      assert.equal(await contact(workerEndpoint, workerNonce), true);
      child.kill("SIGTERM");
    }
    await exited(child);
    await fs.access(workerReady);
    if (process.platform === "win32") {
      const ready = JSON.parse(
        await fs.readFile(controlFile + ".job-ready", "utf8"),
      );
      assert.equal(ready.parentPid, Number(await fs.readFile(marker, "utf8")));
      assert.ok(
        ready.created &&
          ready.helperPid &&
          ready.hostPid &&
          ready.helperPid !== ready.hostPid,
        "real native Job Object handshake did not run",
      );
    }
    await stopHomeBrowser(marker, control);
    if (process.platform === "win32") {
      const clean = JSON.parse(
        await fs.readFile(controlFile + ".job-clean", "utf8"),
      );
      assert.equal(clean.cleaned, true);
      assert.equal(clean.nonce, control.nonce);
      assert.throws(() => process.kill(clean.helperPid, 0), { code: "ESRCH" });
      assert.throws(() => process.kill(clean.hostPid, 0), { code: "ESRCH" });
      const workerPid = Number(await fs.readFile(workerReady, "utf8"));
      assert.throws(() => process.kill(workerPid, 0), { code: "ESRCH" });
    }
    assert.equal(await contact(workerEndpoint, workerNonce), false);
  });

test("a wrapper starting after cancellation cannot spawn its browser", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "home-late-test-"));
  const marker = path.join(root, "wrapper.pid"),
    controlFile = path.join(root, "control.json"),
    spawned = path.join(root, "spawned");
  const control = {
    nonce: randomUUID(),
    endpoint: endpoint(root, "control"),
    arguments: [
      "-e",
      `require('node:fs').writeFileSync(${JSON.stringify(spawned)},'unexpected')`,
    ],
  };
  await fs.writeFile(controlFile, JSON.stringify(control), { mode: 0o600 });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await stopHomeBrowser(marker, control);
  const child = wrapper(marker, controlFile, root);
  await exited(child);
  await assert.rejects(fs.access(spawned), { code: "ENOENT" });
});

test(
  "Windows native Job setup failure prevents the browser from spawning",
  { skip: process.platform !== "win32" },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "home-job-fail-"));
    const marker = path.join(root, "wrapper.pid"),
      controlFile = path.join(root, "control.json"),
      spawned = path.join(root, "spawned");
    const control = {
      nonce: randomUUID(),
      endpoint: endpoint(root, "control"),
      arguments: [
        "-e",
        `require('node:fs').writeFileSync(${JSON.stringify(spawned)},'unexpected')`,
      ],
    };
    await fs.writeFile(controlFile, JSON.stringify(control), { mode: 0o600 });
    await fs.mkdir(controlFile + ".job-ready");
    t.after(async () => {
      await stopHomeBrowser(marker, control).catch(() => {});
      await fs.rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    });
    const child = wrapper(marker, controlFile, root);
    await exited(child);
    await assert.rejects(fs.access(spawned), { code: "ENOENT" });
  },
);

test("packaged native Job helper participates in the release build identity", async (t) => {
  const { frameworkBuildDigest } =
    await import("../src/core/framework-knowledge.mjs");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "home-job-build-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "src", "home"), { recursive: true });
  const file = path.join(root, "src", "home", "browser-job.ps1");
  await fs.copyFile(
    new URL("../src/home/browser-job.ps1", import.meta.url),
    file,
  );
  const before = frameworkBuildDigest(root);
  await fs.appendFile(file, "\n# synthetic change\n");
  assert.notEqual(frameworkBuildDigest(root), before);
});

test(
  "Windows cancellation before native ready confirms the detached helper exits",
  { skip: process.platform !== "win32" },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "home-job-cancel-"));
    const marker = path.join(root, "wrapper.pid"),
      controlFile = path.join(root, "control.json"),
      spawned = path.join(root, "spawned");
    const control = {
      nonce: randomUUID(),
      endpoint: endpoint(root, "control"),
      arguments: [
        "-e",
        `require('node:fs').writeFileSync(${JSON.stringify(spawned)},'unexpected')`,
      ],
    };
    await fs.writeFile(controlFile, JSON.stringify(control), { mode: 0o600 });
    const child = wrapper(marker, controlFile, root);
    t.after(async () => {
      await stopHomeBrowser(marker, control).catch(() => {});
      await fs.rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    });
    let helper;
    for (let i = 0; i < 500 && !helper?.pid; i++) {
      try {
        helper = JSON.parse(
          await fs.readFile(controlFile + ".job-helper", "utf8"),
        );
      } catch {
        /* Wait for the actual spawn receipt, not a timing guess. */
      }
      if (!helper?.pid) await pause(1);
    }
    assert.ok(helper?.pid);
    assert.doesNotThrow(() => process.kill(helper.pid, 0));
    await assert.rejects(fs.access(controlFile + ".job-ready"), {
      code: "ENOENT",
    });
    await stopHomeBrowser(marker, control);
    await exited(child);
    assert.throws(() => process.kill(helper.pid, 0), { code: "ESRCH" });
    await assert.rejects(fs.access(spawned), { code: "ENOENT" });
  },
);

test("owned wrapper inherits bidirectional CDP pipes through native admission", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "home-cdp-test-"));
  const marker = path.join(root, "wrapper.pid"),
    controlFile = path.join(root, "control.json"),
    traceFile = path.join(root, "protocol-counts.json");
  // Unlike the tree-only helpers, this child must receive Playwright's actual
  // NUL-framed commands on fd 3 and return responses on fd 4. No TCP substitute.
  const protocol = String.raw`
const fs = require('node:fs');
const trace = [];
let pending = Buffer.alloc(0);
const chunk = Buffer.alloc(4096);
while (true) {
  const n = fs.readSync(3, chunk, 0, chunk.length, null);
  if (!n) process.exit(2);
  pending = Buffer.concat([pending, chunk.subarray(0, n)]);
  if (pending.length > 16384) process.exit(3);
  let end;
  while ((end = pending.indexOf(0)) >= 0) {
    const { id, method } = JSON.parse(pending.subarray(0, end).toString());
    pending = pending.subarray(end + 1);
    if (!Number.isSafeInteger(id) || !['Browser.getVersion', 'Target.setAutoAttach', 'Browser.close'].includes(method)) process.exit(4);
    trace.push({ id, method });
    fs.writeFileSync(${JSON.stringify(traceFile)}, JSON.stringify(trace));
    const result = method === 'Browser.getVersion'
      ? { protocolVersion: '1.3', product: 'Chrome/123.0.0.0', revision: 'synthetic', userAgent: 'HeadlessChrome/123.0.0.0', jsVersion: 'synthetic' }
      : {};
    fs.writeSync(4, JSON.stringify({ id, result }) + '\0');
    if (method === 'Browser.close') process.exit(0);
  }
}`;
  const control = {
    nonce: randomUUID(),
    endpoint: endpoint(root, "control"),
    arguments: ["-e", protocol],
  };
  await fs.writeFile(controlFile, JSON.stringify(control), { mode: 0o600 });
  let browser;
  t.after(async () => {
    try {
      await browser?.close();
    } finally {
      await stopHomeBrowser(marker, control);
      await fs.rm(root, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
    }
  });
  browser = await chromium.launch({
    executablePath: process.execPath,
    ignoreDefaultArgs: true,
    timeout: 15000,
    env: buildChildEnv("browser"),
    args: [
      fileURLToPath(
        new URL("../src/home/browser-launcher.mjs", import.meta.url),
      ),
      marker,
      process.execPath,
      path.join(root, "profile"),
      controlFile,
    ],
  });
  assert.equal(browser.version(), "123.0.0.0");
  if (process.platform === "win32") {
    const ready = JSON.parse(
      await fs.readFile(controlFile + ".job-ready", "utf8"),
    );
    assert.equal(ready.nonce, control.nonce);
    assert.equal(ready.parentPid, Number(await fs.readFile(marker, "utf8")));
  }
  await browser.close();
  await stopHomeBrowser(marker, control);
  const trace = JSON.parse(await fs.readFile(traceFile, "utf8"));
  assert.deepEqual(
    trace.map((entry) => entry.method),
    ["Browser.getVersion", "Target.setAutoAttach", "Browser.close"],
  );
  assert.equal(new Set(trace.map((entry) => entry.id)).size, 3);
  t.diagnostic(
    "CDP pipe challenge: 3 fixed requests, 3 matching responses; owned cleanup confirmed",
  );
});

test("owned CDP pipes preserve fragmented binary traffic, backpressure and EOF", async (t) => {
  const { createHash } = await import("node:crypto");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "home-cdp-bytes-"));
  const marker = path.join(root, "wrapper.pid"),
    controlFile = path.join(root, "control.json"),
    readyFile = path.join(root, "ready"),
    eofFile = path.join(root, "eof");
  const browser = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(readyFile)},'ready');const b=Buffer.alloc(8192);let n;while((n=fs.readSync(3,b,0,b.length,null))>0)fs.writeSync(4,b.subarray(0,n));fs.writeFileSync(${JSON.stringify(eofFile)},'eof');setInterval(()=>{},1000);`;
  const control = {
    nonce: randomUUID(),
    endpoint: endpoint(root, "control"),
    arguments: ["-e", browser],
  };
  await fs.writeFile(controlFile, JSON.stringify(control), { mode: 0o600 });
  const child = wrapper(marker, controlFile, root);
  t.after(async () => {
    await stopHomeBrowser(marker, control);
    await exited(child);
    await fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  });
  const input = child.stdio[3],
    output = child.stdio[4];
  const payload = Buffer.alloc(4 * 1024 * 1024);
  for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
  const hash = createHash("sha256"),
    complete = Promise.withResolvers();
  let bytes = 0;
  output.on("data", (chunk) => {
    bytes += chunk.length;
    hash.update(chunk);
    if (bytes >= payload.length) complete.resolve();
  });
  output.on("error", complete.reject);
  input.on("error", complete.reject);
  output.pause();
  for (let i = 0; i < 1500; i++) {
    try {
      await fs.access(readyFile);
      break;
    } catch {
      await pause(10);
    }
  }
  await fs.access(readyFile);
  // Fragment writes and temporarily stop reading to exercise both pipe buffers.
  for (let offset = 0; offset < payload.length; offset += 7919)
    input.write(payload.subarray(offset, offset + 7919));
  input.end();
  await pause(50);
  output.resume();
  await complete.promise;
  assert.equal(bytes, payload.length);
  assert.equal(
    hash.digest("hex"),
    createHash("sha256").update(payload).digest("hex"),
  );
  for (let i = 0; i < 500; i++) {
    try {
      await fs.access(eofFile);
      break;
    } catch {
      await pause(10);
    }
  }
  await fs.access(eofFile);
  await stopHomeBrowser(marker, control);
  await exited(child);
  if (process.platform === "win32") await assertOwnedPipeWriteFailure(t);
});

async function assertOwnedPipeWriteFailure(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "home-cdp-pipe-error-"));
  const marker = path.join(root, "wrapper.pid"),
    controlFile = path.join(root, "control.json"),
    readyFile = path.join(root, "ready");
  // The browser stays alive after closing its input. Only the wrapper's pipe
  // error handler may terminate this owned tree; no simulated child exit helps.
  const browser = `const fs=require('node:fs');fs.closeSync(3);fs.writeFileSync(${JSON.stringify(readyFile)},String(process.pid));setInterval(()=>{},1000);`;
  const control = {
    nonce: randomUUID(),
    endpoint: endpoint(root, "control"),
    arguments: ["-e", browser],
  };
  await fs.writeFile(controlFile, JSON.stringify(control), { mode: 0o600 });
  const child = wrapper(marker, controlFile, root);
  t.after(async () => {
    await stopHomeBrowser(marker, control);
    await exited(child);
    await fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  });
  for (let i = 0; i < 1500; i++) {
    try {
      await fs.access(readyFile);
      break;
    } catch {
      await pause(10);
    }
  }
  const browserPid = Number(await fs.readFile(readyFile, "utf8"));
  child.stdio[3].on("error", () => {});
  child.stdio[3].end(Buffer.alloc(1024 * 1024));
  await exited(child);
  await stopHomeBrowser(marker, control);
  assert.throws(() => process.kill(browserPid, 0), { code: "ESRCH" });
}

test("owned browser spawn failure retains its stable state and confirms cleanup", async (t) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "home-cdp-spawn-error-"),
  );
  const marker = path.join(root, "wrapper.pid"),
    controlFile = path.join(root, "control.json");
  const control = {
    nonce: randomUUID(),
    endpoint: endpoint(root, "control"),
    arguments: [],
  };
  await fs.writeFile(controlFile, JSON.stringify(control), { mode: 0o600 });
  const child = wrapper(
    marker,
    controlFile,
    root,
    path.join(root, "missing-browser.exe"),
  );
  t.after(async () => {
    await stopHomeBrowser(marker, control);
    await exited(child);
    await fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
  });
  await exited(child);
  const state = JSON.parse(
    await fs.readFile(controlFile + ".browser-state", "utf8"),
  );
  assert.equal(state.stage, "spawn-error");
  await stopHomeBrowser(marker, control);
});
