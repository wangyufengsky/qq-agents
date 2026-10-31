import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("../scripts/game-p1b.mjs", import.meta.url),
);
test("P1b CLI refuses foreign directories and any public-origin flag", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p1b-refuse-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "config.json"), "{}");
  for (const args of [
    ["--data", dir],
    ["--data", dir, "--public-origin", "https://example.test"],
  ]) {
    const run = spawnSync(process.execPath, [script, ...args], {
      encoding: "utf8",
    });
    assert.notEqual(run.status, 0);
  }
  assert.equal(fs.existsSync(path.join(dir, "p1b.sqlite")), false);
  assert.equal(fs.readFileSync(path.join(dir, "config.json"), "utf8"), "{}");
});

test("P1b CLI starts only loopback, creates private invitations and reopens its database", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p1b-cli-"));
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  let child;
  const stop = async () => {
    if (child && child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  };
  t.after(async () => {
    await stop();
    fs.rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });
  const start = async () => {
    child = spawn(
      process.execPath,
      [script, "--data", dir, "--port", String(port)],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let text = "";
    await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => reject(Error(`EARLY_EXIT_${code}`)));
      child.stdout.on("data", (chunk) => {
        text += chunk;
        if (text.includes("\n")) resolve();
      });
    });
    const status = JSON.parse(text.trim());
    assert.equal(status.publicAccess, false);
    assert.equal(text.includes("invite="), false);
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    return JSON.parse(
      fs.readFileSync(path.join(dir, "invitations.json"), "utf8"),
    );
  };
  const first = await start();
  assert.equal(first.invitations.length, 2);
  await stop();
  const second = await start();
  assert.notEqual(second.roomId, first.roomId);
  const response = await fetch(first.invitations[0].url);
  assert.equal(response.status, 200);
});
