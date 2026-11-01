import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { temp, fixture, context } from "./helpers.mjs";
import { MemoryStore } from "../src/memory/store.mjs";
import { UpgradeManager } from "../src/updates/manager.mjs";
import { ReleaseUpdates } from "../src/updates/releases.mjs";
import { createServer } from "../src/server.mjs";
import {
  backupData,
  restoreData,
  stageRelease,
  command,
  updateDirectory,
  readState,
} from "../src/updates/installation.mjs";

const release = () =>
  Response.json({
    tag_name: "v2.0.0",
    draft: false,
    prerelease: false,
    published_at: "2026-10-30T00:00:00Z",
    body: "Synthetic update",
  });
function transaction(t, extra = {}) {
  const root = temp(t),
    home = path.join(root, updateDirectory);
  fs.mkdirSync(home);
  const calls = [],
    checkpoint = { globalPaused: false, connections: ["fixture"] };
  const current = {
    codeRoot: "synthetic-old",
    version: "1.0.0",
    commit: "a".repeat(40),
  };
  const candidate = {
    codeRoot: "synthetic-new",
    version: "2.0.0",
    commit: "b".repeat(40),
  };
  const host = {
    async stop() {
      calls.push("stop");
      return checkpoint;
    },
    async start(value) {
      calls.push(`start:${value.version}`);
    },
    async health(value) {
      assert.deepEqual(value, checkpoint);
      calls.push("health");
    },
    async resume(value) {
      assert.deepEqual(value, checkpoint);
      calls.push("resume");
    },
    async stopCandidate() {
      calls.push("stop-candidate");
    },
    async hold() {
      calls.push("hold");
    },
  };
  const manager = new UpgradeManager({
    root,
    home,
    current,
    host,
    fetchImpl: async () => release(),
    stage: async () => {
      calls.push("stage");
      return candidate;
    },
    backup: async () => {
      calls.push("backup");
      return { bytes: 12 };
    },
    restore: async () => {
      calls.push("restore");
    },
    ...extra,
  });
  return { manager, host, calls, root, home, candidate };
}
test("upgrade persists its commit point before resume and keeps original pause choices", async (t) => {
  const { manager, calls, home, host } = transaction(t);
  const resume = host.resume;
  host.resume = async (value) => {
    assert.equal(
      readState(path.join(home, "transaction.json")).committing,
      true,
    );
    assert.equal(readState(path.join(home, "current.json")).version, "2.0.0");
    await resume(value);
  };
  manager.install("v2.0.0");
  assert.throws(() => manager.install("v2.0.0"), /UPDATE_IN_PROGRESS/);
  await manager.job;
  assert.equal(manager.snapshot().phase, "completed");
  assert.deepEqual(calls, [
    "stage",
    "stop",
    "backup",
    "start:2.0.0",
    "health",
    "resume",
  ]);
  assert.equal(
    JSON.stringify(manager.snapshot()).includes("synthetic-old"),
    false,
  );
});
for (const failure of ["stage", "stop", "backup", "start", "health", "resume"])
  test(`failure at ${failure} respects backup and rollback boundaries`, async (t) => {
    const f = transaction(t),
      { manager, host, calls, home } = f;
    const fail = () => {
      throw Error(
        failure === "stop" ? "UPDATE_STOP_FAILED" : "UPDATE_HEALTH_FAILED",
      );
    };
    if (failure === "stage") manager.stage = fail;
    else if (failure === "backup") manager.backup = fail;
    else if (failure === "start") {
      const original = host.start;
      host.start = (value) =>
        value.version === "2.0.0" ? fail() : original(value);
    } else host[failure] = fail;
    manager.install("v2.0.0");
    await manager.job;
    const phase = manager.snapshot().phase;
    if (failure === "stage") {
      assert.equal(phase, "failed");
      assert.equal(calls.length, 0);
    } else if (failure === "stop") {
      assert.equal(phase, "recovery-required");
      assert.equal(calls.includes("backup"), false);
    } else if (failure === "resume") {
      assert.equal(phase, "recovery-required");
      assert.equal(calls.includes("restore"), false);
      assert.equal(readState(path.join(home, "current.json")).version, "2.0.0");
      assert.equal(calls.at(-1), "hold");
    } else {
      assert.equal(phase, "rolled-back");
      assert.equal(calls.includes("restore"), failure !== "backup");
      assert.equal(calls.at(-2), "start:1.0.0");
      assert.equal(calls.at(-1), "hold");
      assert.equal(calls.includes("resume"), false);
    }
  });
test("metadata changes and unsafe failures never stop the current service or leak command output", async (t) => {
  const { manager, calls } = transaction(t);
  manager.install("v3.0.0");
  await manager.job;
  assert.equal(manager.snapshot().error, "UPDATE_RELEASE_CHANGED");
  assert.deepEqual(calls, []);
  manager.stage = () => {
    throw Error("synthetic credential text");
  };
  manager.install("v2.0.0");
  await manager.job;
  assert.equal(manager.snapshot().error, "UPDATE_INSTALL_FAILED");
  assert.equal(
    JSON.stringify(manager.snapshot()).includes("credential"),
    false,
  );
});
test("failed rollback is explicit, and journal write failure never resumes a candidate", async (t) => {
  const { manager, host, calls } = transaction(t);
  host.health = () => {
    throw Error("UPDATE_HEALTH_FAILED");
  };
  manager.restore = () => {
    throw Error("synthetic disk failure");
  };
  manager.install("v2.0.0");
  await manager.job;
  assert.equal(manager.snapshot().phase, "recovery-required");
  assert.equal(calls.includes("resume"), false);
  const other = transaction(t);
  const save = other.manager.save;
  other.manager.save = (file, value) => {
    if (file.endsWith("current.json")) throw Error("synthetic disk failure");
    save(file, value);
  };
  other.manager.install("v2.0.0");
  await other.manager.job;
  assert.equal(other.manager.snapshot().phase, "recovery-required");
  assert.equal(other.calls.includes("resume"), false);
});
test("a stopped-data backup restores compatible SQLite, config and media, preserving the failed candidate", (t) => {
  const root = temp(t),
    home = path.join(root, updateDirectory);
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(root, "files"));
  fs.writeFileSync(
    path.join(root, "config.json"),
    JSON.stringify({ globalPaused: true }),
  );
  fs.writeFileSync(path.join(root, "files", "draft.txt"), "before");
  const db = new MemoryStore(path.join(root, "memory.sqlite"));
  db.bind("fixture").reserveDelivery("confirmed", "group:20000", []);
  db.bind("fixture").completeDelivery("confirmed", "sent", "synthetic-receipt");
  db.close();
  const backup = path.join(home, "backup"),
    failed = path.join(home, "failed");
  const stats = backupData(root, backup);
  assert.ok(stats.bytes > 0);
  assert.equal(fs.existsSync(path.join(backup, updateDirectory)), false);
  const candidate = new MemoryStore(path.join(root, "memory.sqlite"));
  candidate.db.exec("PRAGMA user_version=7");
  candidate.close();
  fs.writeFileSync(path.join(root, "files", "draft.txt"), "after");
  fs.writeFileSync(path.join(root, "new-event.txt"), "preserved evidence");
  restoreData(root, backup, failed);
  const old = new MemoryStore(path.join(root, "memory.sqlite"));
  assert.equal(old.bind("fixture").delivery("confirmed").status, "sent");
  old.close();
  assert.equal(
    fs.readFileSync(path.join(root, "files", "draft.txt"), "utf8"),
    "before",
  );
  assert.equal(
    fs.readFileSync(path.join(failed, "new-event.txt"), "utf8"),
    "preserved evidence",
  );
  assert.equal(
    fs.readFileSync(path.join(failed, "files", "draft.txt"), "utf8"),
    "after",
  );
  assert.equal(fs.existsSync(path.join(root, "new-event.txt")), false);
});
test("backup and restore preserve read-only files and their permissions", (t) => {
  const root = temp(t),
    home = path.join(root, updateDirectory);
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(root, "workspace"));
  for (const name of ["readonly.txt", "workspace/object"]) {
    fs.writeFileSync(path.join(root, name), "read-only evidence", {
      mode: 0o444,
    });
  }
  const backup = path.join(home, "backup");
  backupData(root, backup);
  restoreData(root, backup, path.join(home, "failed"));
  for (const base of [root, backup, path.join(home, "failed")]) {
    for (const name of ["readonly.txt", "workspace/object"]) {
      const file = path.join(base, name);
      assert.equal(fs.readFileSync(file, "utf8"), "read-only evidence");
      assert.equal(fs.statSync(file).mode & 0o200, 0);
    }
  }
});
test("backups reject active processes and hardlinked data before copying", (t) => {
  const root = temp(t),
    home = path.join(root, updateDirectory);
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(root, "process.lock"), "synthetic");
  assert.throws(
    () => backupData(root, path.join(home, "backup")),
    /UPDATE_PROCESS_STILL_RUNNING/,
  );
  fs.unlinkSync(path.join(root, "process.lock"));
  fs.writeFileSync(path.join(root, "source"), "synthetic");
  fs.linkSync(path.join(root, "source"), path.join(root, "alias"));
  assert.throws(
    () => backupData(root, path.join(home, "backup")),
    /UPDATE_DATA_LINK_UNSUPPORTED/,
  );
  assert.equal(fs.existsSync(path.join(home, "backup")), false);
});

test(
  "backup preserves ordinary symlinks without following targets, but rejects linked critical data",
  { skip: process.platform === "win32" },
  (t) => {
    const root = temp(t),
      outside = temp(t),
      home = path.join(root, updateDirectory);
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(outside, "external"), "untouched");
    fs.symlinkSync(outside, path.join(root, "workspace"));
    fs.symlinkSync("missing-target", path.join(root, "dangling"));
    fs.symlinkSync(".", path.join(root, "cycle"));
    const backup = path.join(home, "backup");
    backupData(root, backup);
    assert.equal(
      fs.lstatSync(path.join(backup, "workspace")).isSymbolicLink(),
      true,
    );
    assert.equal(fs.readlinkSync(path.join(backup, "workspace")), outside);
    assert.equal(
      fs.readlinkSync(path.join(backup, "dangling")),
      "missing-target",
    );
    restoreData(root, backup, path.join(home, "failed"));
    assert.equal(fs.readlinkSync(path.join(root, "cycle")), ".");
    assert.equal(
      fs.readFileSync(path.join(outside, "external"), "utf8"),
      "untouched",
    );
    fs.symlinkSync(
      path.join(outside, "external"),
      path.join(root, "config.json"),
    );
    assert.throws(
      () => backupData(root, path.join(home, "rejected")),
      /UPDATE_DATA_LINK_UNSUPPORTED/,
    );
    assert.equal(fs.existsSync(path.join(home, "rejected")), false);
  },
);

for (const point of ["stage", "health"])
  test(`shutdown during ${point} cannot resume or restart the service`, async (t) => {
    const { manager, host, calls, candidate } = transaction(t);
    let proceed;
    const pending = new Promise((resolve) => {
      proceed = resolve;
    });
    const entered = Promise.withResolvers();
    if (point === "stage")
      manager.stage = async () => {
        entered.resolve();
        await pending;
        return candidate;
      };
    else
      host.health = async () => {
        entered.resolve();
        await pending;
      };
    manager.install("v2.0.0");
    await entered.promise;
    manager.cancel();
    proceed();
    await manager.job;
    assert.equal(calls.includes("resume"), false);
    assert.equal(calls.includes("start:1.0.0"), false);
    assert.equal(calls.includes("restore"), point === "health");
    assert.equal(calls.includes("stop"), point === "health");
    assert.throws(() => manager.install("v2.0.0"), /UPDATE_IN_PROGRESS/);
  });

function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function source(t, requiredNode = ">=24.0.0") {
  const root = temp(t),
    codeRoot = path.join(root, "source"),
    home = path.join(root, "home");
  fs.mkdirSync(codeRoot);
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(codeRoot, "src"));
  git(codeRoot, ["init", "-b", "main"]);
  git(codeRoot, ["config", "user.name", "Synthetic Fixture"]);
  git(codeRoot, ["config", "user.email", "fixture@users.noreply.github.com"]);
  git(codeRoot, [
    "remote",
    "add",
    "origin",
    "https://github.com/wangyufengsky/qq-agents.git",
  ]);
  fs.writeFileSync(
    path.join(codeRoot, "src/main.mjs"),
    "export const synthetic = true;\n",
  );
  fs.writeFileSync(path.join(codeRoot, "Dockerfile"), "FROM synthetic\n");
  const writePackage = (version) =>
    fs.writeFileSync(
      path.join(codeRoot, "package.json"),
      JSON.stringify({
        name: "qq-agents",
        version,
        engines: { node: version === "2.0.0" ? requiredNode : ">=24.0.0" },
        qqAgentsUpdateProtocol: 1,
      }),
    );
  writePackage("1.0.0");
  git(codeRoot, ["add", "."]);
  git(codeRoot, ["commit", "-m", "synthetic first"]);
  const before = git(codeRoot, ["rev-parse", "HEAD"]);
  writePackage("2.0.0");
  git(codeRoot, ["add", "."]);
  git(codeRoot, ["commit", "-m", "synthetic release"]);
  git(codeRoot, ["tag", "v2.0.0"]);
  git(codeRoot, ["checkout", "--detach", before]);
  const run = async (binary, args, options) => {
    if (args[0] === "clone") {
      assert.equal(
        args.at(-2),
        "https://github.com/wangyufengsky/qq-agents.git",
      );
      return command(
        binary,
        [...args.slice(0, -2), codeRoot, args.at(-1)],
        options,
      );
    }
    if (binary.startsWith("npm")) {
      assert.ok(args.includes("--ignore-scripts"));
      return "";
    }
    return command(binary, args, options);
  };
  return { home, codeRoot, run };
}
test("source staging pins an official tag and validates ancestry, version and runtime before installation", async (t) => {
  const f = source(t);
  const staged = await stageRelease({ ...f, tag: "v2.0.0" });
  assert.equal(staged.version, "2.0.0");
  assert.match(staged.commit, /^[a-f0-9]{40}$/);
  assert.notEqual(staged.codeRoot, f.codeRoot);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(f.codeRoot, "package.json"))).version,
    "1.0.0",
  );
  fs.writeFileSync(
    path.join(f.codeRoot, "src/main.mjs"),
    "export const modified = true;\n",
  );
  await assert.rejects(
    stageRelease({ ...f, tag: "v2.0.0" }),
    /UPDATE_LOCAL_CHANGES/,
  );
});
test("staging rejects a newer Node minor or patch before installing or stopping the old release", async (t) => {
  const [major, minor, patch] = process.versions.node.split(".").map(Number);
  for (const minimum of [
    `${major}.${minor + 1}.0`,
    `${major}.${minor}.${patch + 1}`,
  ]) {
    const f = source(t, `>=${minimum}`),
      phases = [];
    await assert.rejects(
      stageRelease({
        ...f,
        tag: "v2.0.0",
        progress: (phase) => phases.push(phase),
      }),
      /UPDATE_RUNTIME_UNSUPPORTED/,
    );
    assert.deepEqual(phases, ["downloading"]);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(f.codeRoot, "package.json")))
        .version,
      "1.0.0",
    );
  }
});
test("staging rejects divergent history, unsupported origin and changed container requirements", async (t) => {
  const f = source(t);
  fs.writeFileSync(path.join(f.codeRoot, "local.txt"), "synthetic divergence");
  git(f.codeRoot, ["add", "."]);
  git(f.codeRoot, ["commit", "-m", "synthetic divergence"]);
  await assert.rejects(
    stageRelease({ ...f, tag: "v2.0.0" }),
    /UPDATE_DIVERGED/,
  );
  const second = source(t);
  git(second.codeRoot, [
    "remote",
    "set-url",
    "origin",
    "https://untrusted.invalid/project.git",
  ]);
  await assert.rejects(
    stageRelease({ ...second, tag: "v2.0.0" }),
    /UPDATE_SOURCE_UNSUPPORTED/,
  );
  const third = source(t),
    before = git(third.codeRoot, ["rev-parse", "HEAD"]);
  git(third.codeRoot, ["checkout", "main"]);
  fs.writeFileSync(
    path.join(third.codeRoot, "Dockerfile"),
    "FROM different-runtime\n",
  );
  git(third.codeRoot, ["add", "."]);
  git(third.codeRoot, ["commit", "-m", "synthetic runtime change"]);
  git(third.codeRoot, ["tag", "-f", "v2.0.0"]);
  git(third.codeRoot, ["checkout", "--detach", before]);
  await assert.rejects(
    stageRelease({ ...third, tag: "v2.0.0", container: true }),
    /UPDATE_IMAGE_REBUILD_REQUIRED/,
  );
});
test("install is an authenticated admin action, bound to the displayed version; maintenance blocks edits", async (t) => {
  const f = fixture(t),
    calls = [],
    token = "synthetic-admin";
  f.runtime.updates = new ReleaseUpdates({
    root: temp(t),
    installed: { packageVersion: "1.0.0" },
    fetchImpl: async () => release(),
  });
  await f.runtime.updates.check();
  f.runtime.upgradeManager = {
    snapshot: () => ({ managed: true, phase: "idle" }),
    install: async (tag) => {
      calls.push(tag);
      return { phase: "preparing" };
    },
  };
  const app = createServer({ runtime: f.runtime, token });
  const port = await app.listen();
  t.after(() => app.close());
  const request = (tag, headers) =>
    fetch(`http://127.0.0.1:${port}/api/updates/install`, {
      method: "POST",
      headers,
      body: JSON.stringify({ tag }),
    });
  assert.equal(
    (
      await request("v2.0.0", {
        "x-agent-capability": context(f.runtime).token,
      })
    ).status,
    401,
  );
  assert.equal(
    (await request("v9.0.0", { "x-admin-token": token })).status,
    400,
  );
  assert.equal(
    (await request("v2.0.0", { "x-admin-token": token })).status,
    202,
  );
  assert.deepEqual(calls, ["v2.0.0"]);
  f.runtime.updateMaintenance = true;
  assert.equal(
    (await request("v2.0.0", { "x-admin-token": token })).status,
    400,
  );
  const pause = await fetch(`http://127.0.0.1:${port}/api/pause`, {
    method: "POST",
    headers: { "x-admin-token": token },
    body: JSON.stringify({ paused: false }),
  });
  assert.equal((await pause.json()).error, "UPDATE_IN_PROGRESS");
});

for (const savedBundle of [false, "normal", "recover"])
  test(
    `real managed launcher ${savedBundle ? `replaces an older bundled pointer (${savedBundle})` : "starts isolated"}, reports capability and shuts down with both locks released`,
    { skip: process.platform === "win32" },
    async (t) => {
      const root = temp(t),
        entry = fileURLToPath(
          new URL("../src/updates/supervisor.mjs", import.meta.url),
        );
      if (savedBundle) {
        const home = path.join(root, updateDirectory);
        fs.mkdirSync(home);
        fs.writeFileSync(
          path.join(home, "current.json"),
          JSON.stringify({
            codeRoot: fileURLToPath(new URL("..", import.meta.url)),
            version: "0.0.0",
            commit: "a".repeat(40),
          }),
        );
        fs.writeFileSync(
          path.join(home, "transaction.json"),
          JSON.stringify({ phase: "rolled-back" }),
        );
      }
      const child = spawn(
        process.execPath,
        [
          entry,
          "--data",
          root,
          "--port",
          "0",
          ...(savedBundle === "recover" ? ["--recover"] : []),
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let out = "",
        err = "";
      child.stdout.on("data", (b) => (out += b));
      child.stderr.on("data", (b) => (err += b));
      const exited = once(child, "exit");
      t.after(() => {
        if (child.exitCode === null) child.kill();
      });
      for (let n = 0; n < 200 && !out.includes("managed:"); n++) {
        if (child.exitCode !== null)
          throw Error(`synthetic launcher failed: ${err}`);
        await delay(50);
      }
      const port = /127\.0\.0\.1:(\d+)/.exec(out)?.[1];
      assert.ok(port);
      const token = fs.readFileSync(path.join(root, "admin-token"), "utf8");
      const state = await (
        await fetch(`http://127.0.0.1:${port}/api/updates`, {
          headers: { "x-admin-token": token },
        })
      ).json();
      assert.equal(state.upgrade.managed, true);
      assert.equal(state.upgrade.phase, savedBundle ? "rolled-back" : "idle");
      if (savedBundle) {
        const current = readState(
          path.join(root, updateDirectory, "current.json"),
        );
        assert.equal(current.version, state.installed.version);
        assert.equal(current.commit, state.installed.commit);
      } else {
        assert.equal(
          fs.existsSync(path.join(root, updateDirectory, "current.json")),
          false,
        );
      }
      child.kill("SIGTERM");
      assert.equal((await exited)[0], 0);
      assert.equal(fs.existsSync(path.join(root, "process.lock")), false);
      assert.equal(
        fs.existsSync(path.join(root, updateDirectory, "supervisor.lock")),
        false,
      );
    },
  );

for (const kind of ["staged", "same-version", "interrupted"])
  test(`bundled replacement keeps ${kind} identity validation strict`, (t) => {
    const root = temp(t),
      home = path.join(root, updateDirectory);
    fs.mkdirSync(home);
    let codeRoot = fileURLToPath(new URL("..", import.meta.url));
    const version = JSON.parse(
      fs.readFileSync(path.join(codeRoot, "package.json"), "utf8"),
    ).version;
    if (kind === "staged") {
      codeRoot = path.join(home, "releases", "synthetic");
      fs.mkdirSync(codeRoot, { recursive: true });
      fs.writeFileSync(
        path.join(codeRoot, "package.json"),
        JSON.stringify({ version }),
      );
    }
    const saved = {
      codeRoot,
      version: kind === "same-version" ? version : "0.0.0",
      commit: "a".repeat(40),
    };
    fs.writeFileSync(path.join(home, "current.json"), JSON.stringify(saved));
    if (kind === "interrupted")
      fs.writeFileSync(
        path.join(home, "transaction.json"),
        JSON.stringify({ phase: "checking", from: saved }),
      );
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [
            fileURLToPath(
              new URL("../src/updates/supervisor.mjs", import.meta.url),
            ),
            "--data",
            root,
            "--port",
            "0",
            "--recover",
          ],
          { stdio: "pipe" },
        ),
      (error) => error.stderr.toString().includes("UPDATE_STATE_INVALID"),
    );
    assert.deepEqual(readState(path.join(home, "current.json")), saved);
    assert.equal(fs.existsSync(path.join(root, "process.lock")), false);
    assert.equal(fs.existsSync(path.join(home, "supervisor.lock")), false);
  });

for (const healthy of [true, false])
  test(`real child transaction ${healthy ? "resumes" : "rolls back"} on the same port and protects maintenance`, async (t) => {
    const { ManagedHost } = await import("../src/updates/supervisor.mjs");
    const { FrameworkKnowledge } =
      await import("../src/core/framework-knowledge.mjs");
    const root = temp(t),
      home = path.join(root, updateDirectory);
    fs.mkdirSync(home);
    fs.writeFileSync(
      path.join(home, "supervisor.lock"),
      JSON.stringify({ pid: process.pid, owner: "synthetic" }),
    );
    const codeRoot = fileURLToPath(new URL("..", import.meta.url));
    const identity = new FrameworkKnowledge({ root: codeRoot }).version;
    const installed = {
      codeRoot,
      version: identity.packageVersion,
      commit: identity.commit,
    };
    const host = new ManagedHost({ root, args: ["--port", "0"] });
    await host.start(installed, true);
    const port = host.port,
      token = fs.readFileSync(path.join(root, "admin-token"), "utf8");
    const originalHealth = host.health.bind(host);
    host.health = async (checkpoint) => {
      assert.equal(host.port, port);
      const blocked = await fetch(
        `http://127.0.0.1:${port}/api/updates/settings`,
        {
          method: "PUT",
          headers: { "x-admin-token": token },
          body: JSON.stringify({ enabled: true }),
        },
      );
      assert.equal((await blocked.json()).error, "UPDATE_IN_PROGRESS");
      await originalHealth(checkpoint);
      if (!healthy) {
        fs.writeFileSync(
          path.join(root, "candidate-event.txt"),
          "preserved synthetic event",
        );
        throw Error("UPDATE_HEALTH_FAILED");
      }
    };
    const manager = new UpgradeManager({
      root,
      home,
      current: installed,
      host,
      fetchImpl: async () => release(),
      stage: async () => installed,
    });
    try {
      manager.install("v2.0.0");
      await manager.job;
      assert.equal(
        manager.snapshot().phase,
        healthy ? "completed" : "rolled-back",
      );
      assert.equal(host.port, port);
      const state = await (
        await fetch(`http://127.0.0.1:${port}/api/status`, {
          headers: { "x-admin-token": token },
        })
      ).json();
      assert.equal(state.globalPaused, true);
      const editable = await fetch(
        `http://127.0.0.1:${port}/api/updates/settings`,
        {
          method: "PUT",
          headers: { "x-admin-token": token },
          body: JSON.stringify({ enabled: false }),
        },
      );
      assert.equal(editable.status, 200);
      if (!healthy)
        assert.equal(
          fs.readFileSync(
            path.join(
              home,
              `failed-${manager.state.id}`,
              "candidate-event.txt",
            ),
            "utf8",
          ),
          "preserved synthetic event",
        );
    } finally {
      await host.stopCandidate();
    }
  });

for (const committing of [false, true])
  test(
    `interrupted upgrade recovery ${committing ? "preserves a possibly used ledger" : "restores the pre-upgrade database"}`,
    { skip: process.platform === "win32" },
    async (t) => {
      const { FrameworkKnowledge } =
        await import("../src/core/framework-knowledge.mjs");
      const { config } = await import("./helpers.mjs");
      const root = temp(t),
        home = path.join(root, updateDirectory),
        backup = path.join(home, "backup-synthetic");
      fs.mkdirSync(home);
      const cfg = config(1);
      cfg.mode = "isolated";
      cfg.globalPaused = true;
      fs.writeFileSync(path.join(root, "config.json"), JSON.stringify(cfg));
      const db = new MemoryStore(path.join(root, "memory.sqlite"));
      db.close();
      fs.writeFileSync(path.join(root, "marker.txt"), "before");
      backupData(root, backup);
      fs.writeFileSync(path.join(root, "marker.txt"), "after");
      if (!committing) {
        const candidate = new MemoryStore(path.join(root, "memory.sqlite"));
        candidate.db.exec("PRAGMA user_version=7");
        candidate.close();
      }
      const codeRoot = fileURLToPath(new URL("..", import.meta.url)),
        identity = new FrameworkKnowledge({ root: codeRoot }).version;
      const installed = {
        codeRoot,
        version: identity.packageVersion,
        commit: identity.commit,
      };
      fs.writeFileSync(
        path.join(home, "transaction.json"),
        JSON.stringify({
          phase: committing ? "resuming" : "checking",
          id: "synthetic",
          backupReady: true,
          backup,
          committing,
          from: installed,
          to: installed,
        }),
      );
      const entry = fileURLToPath(
        new URL("../src/updates/supervisor.mjs", import.meta.url),
      );
      const child = spawn(
        process.execPath,
        [entry, "--data", root, "--port", "0", "--recover", "--resume"],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let out = "",
        err = "";
      child.stdout.on("data", (b) => (out += b));
      child.stderr.on("data", (b) => (err += b));
      const exited = once(child, "exit");
      t.after(() => {
        if (child.exitCode === null) child.kill();
      });
      for (let i = 0; i < 200 && !out.includes("managed:"); i++) {
        if (child.exitCode !== null)
          throw Error(`synthetic recovery failed: ${err}`);
        await delay(50);
      }
      const port = /127\.0\.0\.1:(\d+)/.exec(out)?.[1];
      assert.ok(port);
      assert.equal(
        fs.readFileSync(path.join(root, "marker.txt"), "utf8"),
        committing ? "after" : "before",
      );
      const token = fs.readFileSync(path.join(root, "admin-token"), "utf8");
      const state = await (
        await fetch(`http://127.0.0.1:${port}/api/status`, {
          headers: { "x-admin-token": token },
        })
      ).json();
      assert.equal(state.globalPaused, true);
      assert.throws(
        () =>
          execFileSync(
            process.execPath,
            [
              fileURLToPath(new URL("../src/main.mjs", import.meta.url)),
              "--data",
              root,
              "--port",
              "0",
            ],
            { stdio: "pipe" },
          ),
        (error) =>
          error.stderr.toString().includes("UPDATE_MANAGED_START_REQUIRED"),
      );
      child.kill("SIGTERM");
      assert.equal((await exited)[0], 0);
    },
  );

test("staging with existing game rooms refuses a release without compatibility preflight", async (t) => {
  const f = source(t);
  const dataRoot = temp(t);
  fs.mkdirSync(path.join(dataRoot, "games"));
  fs.writeFileSync(path.join(dataRoot, "games", "rooms.sqlite"), "synthetic");
  await assert.rejects(
    stageRelease({ ...f, dataRoot, tag: "v2.0.0" }),
    /GAME_COMPATIBILITY_CHECK_UNAVAILABLE/,
  );
});
