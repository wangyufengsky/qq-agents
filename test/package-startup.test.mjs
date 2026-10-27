import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { temp } from "./helpers.mjs";

test(
  "the packed application starts without examples, preserves existing config, and shuts down cleanly",
  { timeout: 30000 },
  async (t) => {
    const root = temp(t);
    const source = fileURLToPath(new URL("..", import.meta.url));
    const [packed] = JSON.parse(
      execFileSync(
        "npm",
        [
          "pack",
          "--ignore-scripts",
          "--json",
          "--pack-destination",
          root,
          "--cache",
          path.join(root, "npm-cache"),
        ],
        { cwd: source, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ),
    );
    assert(
      packed.files.every(
        (entry) => !/^(examples|outputs|\.runtime|test)\//.test(entry.path),
      ),
    );
    execFileSync("tar", ["-xzf", path.join(root, packed.filename), "-C", root]);
    const app = path.join(root, "package"),
      data = path.join(root, "data");
    fs.symlinkSync(
      path.join(source, "node_modules"),
      path.join(app, "node_modules"),
      "dir",
    );
    for (let boot = 0; boot < 2; boot++) {
      const child = spawn(
        process.execPath,
        ["src/main.mjs", "--data", data, "--port", "0"],
        { cwd: app, stdio: ["ignore", "pipe", "pipe"] },
      );
      const exited = once(child, "exit");
      let output = "",
        errors = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        errors += chunk;
      });
      t.after(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      });
      let url;
      for (let i = 0; i < 1000; i++) {
        url = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
        if (url || child.exitCode !== null) break;
        await delay(5);
      }
      assert(url, "package startup failed: " + errors);
      const token = fs
        .readFileSync(path.join(data, "admin-token"), "utf8")
        .trim();
      const response = await fetch(url + "/api/status", {
        headers: { "x-admin-token": token },
      });
      assert.equal(response.status, 200);
      const status = await response.json();
      assert.equal(status.mode, "isolated");
      assert.equal(status.globalPaused, true);
      assert(status.connections.every((c) => !c.connected));
      assert.equal((await fetch(url)).status, 200);
      child.kill("SIGTERM");
      assert.equal((await exited)[0], 0);
      assert(!fs.existsSync(path.join(data, "process.lock")));
      const file = path.join(data, "config.json"),
        config = JSON.parse(fs.readFileSync(file));
      if (boot === 0) {
        config.agents[0].name = "Synthetic persisted identity";
        fs.writeFileSync(file, JSON.stringify(config));
      } else
        assert.equal(config.agents[0].name, "Synthetic persisted identity");
    }
  },
);
