import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stopHomeBrowser } from "../src/home/browser-process.mjs";
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
function wrapper(marker, controlFile, root) {
  return spawn(
    process.execPath,
    [
      fileURLToPath(
        new URL("../src/home/browser-launcher.mjs", import.meta.url),
      ),
      marker,
      process.execPath,
      path.join(root, "profile"),
      controlFile,
    ],
    {
      detached: process.platform !== "win32",
      stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
      windowsHide: true,
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
        ready.created && ready.helperPid,
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
