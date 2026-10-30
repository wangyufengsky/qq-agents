import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import spawn from "cross-spawn";
import { DatabaseSync } from "node:sqlite";
import { FrameworkKnowledge } from "../core/framework-knowledge.mjs";
import { compareVersions, releaseTag, UPDATE_REPOSITORY } from "./releases.mjs";

export const updateDirectory = "updates-runtime";
function syncDirectory(directory) {
  let fd;
  try {
    fd = fs.openSync(directory, "r");
    fs.fsyncSync(fd);
  } catch (error) {
    // Windows does not expose directory fsync through Node. File contents are
    // still flushed before replacement; unknown failures stop the transaction.
    if (
      process.platform !== "win32" ||
      !["EPERM", "EACCES", "EINVAL", "EISDIR", "EBADF"].includes(error.code)
    )
      throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
export function writeState(file, value) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    const fd = fs.openSync(tmp, "r+");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
    syncDirectory(path.dirname(file));
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
export function readState(file) {
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > 65536)
    throw Error("UPDATE_STATE_INVALID");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
export async function command(
  binary,
  args,
  { cwd, signal, timeout = 600000 } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      signal,
    });
    let output = "",
      length = 0,
      timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeout);
    const collect = (chunk) => {
      length += chunk.length;
      if (length < 1024 * 1024) output += chunk.toString();
      else child.kill();
    };
    child.stdout.on("data", collect);
    // Never surface command output: npm/git can echo private environment paths.
    child.stderr.on("data", () => {});
    child.once("error", () => {
      clearTimeout(timer);
      reject(Error("UPDATE_COMMAND_FAILED"));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (timedOut || signal?.aborted || code !== 0 || length >= 1024 * 1024)
        reject(Error("UPDATE_COMMAND_FAILED"));
      else resolve(output.trim());
    });
  });
}

export async function stageRelease({
  home,
  codeRoot,
  tag,
  container = false,
  signal,
  progress = () => {},
  run = command,
}) {
  if (typeof tag !== "string" || tag.length > 80 || !releaseTag.test(tag))
    throw Error("UPDATE_RELEASE_CHANGED");
  const installed = new FrameworkKnowledge({ root: codeRoot }).version;
  if (!installed.commit || installed.modified !== false)
    throw Error("UPDATE_LOCAL_CHANGES");
  if (compareVersions(installed.packageVersion, tag) !== -1)
    throw Error("UPDATE_NOT_NEWER");
  if (fs.existsSync(path.join(codeRoot, ".git"))) {
    const remote = await run("git", ["config", "--get", "remote.origin.url"], {
      cwd: codeRoot,
      signal,
    });
    if (
      ![
        `https://github.com/${UPDATE_REPOSITORY}`,
        `https://github.com/${UPDATE_REPOSITORY}.git`,
        `git@github.com:${UPDATE_REPOSITORY}.git`,
      ].includes(remote)
    )
      throw Error("UPDATE_SOURCE_UNSUPPORTED");
  }
  const destination = path.join(home, "releases", randomUUID());
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  progress("downloading");
  await run(
    "git",
    [
      "clone",
      "--no-checkout",
      "--",
      `https://github.com/${UPDATE_REPOSITORY}.git`,
      destination,
    ],
    { signal },
  );
  const git = (args) => run("git", args, { cwd: destination, signal });
  const commit = await git(["rev-parse", `refs/tags/${tag}^{commit}`]);
  if (!/^[a-f0-9]{40}$/.test(commit)) throw Error("UPDATE_SOURCE_UNSUPPORTED");
  // A clean but divergent local/development history must never be overwritten.
  try {
    await git(["merge-base", "--is-ancestor", installed.commit, commit]);
  } catch {
    throw Error("UPDATE_DIVERGED");
  }
  if (container) {
    const before = await git(["show", `${installed.commit}:Dockerfile`]);
    const after = await git(["show", `${commit}:Dockerfile`]);
    if (before !== after) throw Error("UPDATE_IMAGE_REBUILD_REQUIRED");
  }
  await git(["checkout", "--detach", commit]);
  const pkg = JSON.parse(
    fs.readFileSync(path.join(destination, "package.json"), "utf8"),
  );
  const requiredNode = /^>=(\d+\.\d+\.\d+)$/.exec(pkg.engines?.node || "");
  const runtimeComparison = compareVersions(
    process.versions.node,
    requiredNode?.[1],
  );
  if (
    pkg.name !== "qq-agents" ||
    compareVersions(pkg.version, tag) !== 0 ||
    pkg.qqAgentsUpdateProtocol !== 1 ||
    runtimeComparison === null ||
    runtimeComparison < 0
  )
    throw Error("UPDATE_RUNTIME_UNSUPPORTED");
  progress("installing");
  await run(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["ci", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund"],
    { cwd: destination, signal },
  );
  await run(process.execPath, ["--check", "src/main.mjs"], {
    cwd: destination,
    signal,
  });
  const check = new FrameworkKnowledge({ root: codeRoot }).version;
  if (check.commit !== installed.commit || check.modified !== false)
    throw Error("UPDATE_LOCAL_CHANGES");
  return { codeRoot: destination, commit, version: pkg.version };
}

function entries(root) {
  return fs
    .readdirSync(root)
    .filter((name) => name !== updateDirectory && name !== "process.lock");
}
function audit(file) {
  const st = fs.lstatSync(file);
  if (st.isSymbolicLink()) return Buffer.byteLength(fs.readlinkSync(file));
  if ((!st.isDirectory() && !st.isFile()) || (st.isFile() && st.nlink !== 1))
    throw Error("UPDATE_DATA_LINK_UNSUPPORTED");
  return st.isDirectory()
    ? fs
        .readdirSync(file)
        .reduce((sum, name) => sum + audit(path.join(file, name)), 0)
    : st.size;
}
function syncFile(file) {
  const mode = fs.lstatSync(file).mode;
  let fd,
    restored = !!(mode & 0o200);
  try {
    // Only the copy is touched. Retain its permissions before flushing metadata.
    if (!restored) fs.chmodSync(file, mode | 0o200);
    fd = fs.openSync(file, "r+");
    if (!restored) {
      fs.fchmodSync(fd, mode);
      restored = true;
    }
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (!restored) fs.chmodSync(file, mode);
  }
}
function syncSnapshot(root) {
  for (const name of fs.readdirSync(root)) {
    const file = path.join(root, name);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) syncSnapshot(file);
    else syncFile(file);
  }
  syncDirectory(root);
}
function copySnapshot(source, destination) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) {
    // Copy the link itself, including broken and cyclic links. Never walk its target.
    const type =
      process.platform === "win32" &&
      fs.statSync(source, { throwIfNoEntry: false })?.isDirectory()
        ? "dir"
        : "file";
    fs.symlinkSync(fs.readlinkSync(source), destination, type);
  } else if (stat.isDirectory()) {
    fs.mkdirSync(destination, { mode: 0o700 });
    for (const name of fs.readdirSync(source))
      copySnapshot(path.join(source, name), path.join(destination, name));
    fs.chmodSync(destination, stat.mode);
  } else {
    fs.cpSync(source, destination, {
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
    });
  }
}
function validateSnapshot(root) {
  for (const name of [
    "config.json",
    "admin-token",
    "secrets.json",
    "memory.sqlite",
    "memory.sqlite-wal",
    "memory.sqlite-shm",
  ]) {
    try {
      const stat = fs.lstatSync(path.join(root, name));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
        throw Error("UPDATE_DATA_LINK_UNSUPPORTED");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const file = path.join(root, "memory.sqlite");
  if (!fs.existsSync(file)) return;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (
      db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok" ||
      db.prepare("PRAGMA foreign_key_check").all().length
    )
      throw Error("UPDATE_BACKUP_INVALID");
  } finally {
    db.close();
  }
}
export function backupData(root, destination) {
  if (fs.existsSync(path.join(root, "process.lock")))
    throw Error("UPDATE_PROCESS_STILL_RUNNING");
  validateSnapshot(root);
  const names = entries(root);
  const bytes = names.reduce(
    (sum, name) => sum + audit(path.join(root, name)),
    0,
  );
  const disk = fs.statfsSync(root);
  if (disk.bavail * disk.bsize < bytes * 2 + 100 * 1024 * 1024)
    throw Error("UPDATE_DISK_SPACE");
  fs.mkdirSync(destination, { mode: 0o700 });
  for (const name of names)
    copySnapshot(path.join(root, name), path.join(destination, name));
  validateSnapshot(destination);
  syncSnapshot(destination);
  syncDirectory(path.dirname(destination));
  return { bytes, entries: names.length };
}
export function restoreData(root, backup, failed) {
  if (fs.existsSync(path.join(root, "process.lock")))
    throw Error("UPDATE_PROCESS_STILL_RUNNING");
  audit(backup);
  validateSnapshot(backup);
  fs.mkdirSync(failed, { mode: 0o700 });
  // Preserve every post-backup file (including incoming records) for recovery.
  // Never delete or merge a failed candidate's delivery ledger into the backup.
  for (const name of entries(root))
    fs.renameSync(path.join(root, name), path.join(failed, name));
  for (const name of fs.readdirSync(backup)) {
    if (name === updateDirectory || name === "process.lock")
      throw Error("UPDATE_STATE_INVALID");
    copySnapshot(path.join(backup, name), path.join(root, name));
  }
  for (const name of fs.readdirSync(backup)) {
    const file = path.join(root, name);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) syncSnapshot(file);
    else syncFile(file);
  }
  syncDirectory(root);
  syncDirectory(failed);
}
