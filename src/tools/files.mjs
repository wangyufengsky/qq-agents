import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { atomicJSON } from "../core/config.mjs";
import { downloadFile } from "./file-download.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const validId = /^[a-f0-9]{64}$/;
export function fileName(value) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    Buffer.byteLength(value) > 200 ||
    /[\\/\x00-\x1f\x7f<>:"|?*\u202a-\u202e\u2066-\u2069]/.test(value) ||
    value.startsWith(".") ||
    /[. ]$/.test(value)
  )
    throw Error("INVALID_FILE_NAME");
  return value;
}
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return (
    relative &&
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
  );
};
function readRegular(file, maxBytes) {
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw Error("FILE_PATH_DENIED");
    if (stat.size > maxBytes) throw Error("FILE_TOO_LARGE");
    const chunks = [];
    let count = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(65536, maxBytes + 1 - count));
      const read = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!read) break;
      count += read;
      if (count > maxBytes) throw Error("FILE_TOO_LARGE");
      chunks.push(chunk.subarray(0, read));
    }
    return Buffer.concat(chunks);
  } finally {
    fs.closeSync(fd);
  }
}
export class FileStore {
  constructor(root, { download = downloadFile } = {}) {
    this.root = path.resolve(root);
    this.download = download;
    this.busy = new Set();
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }
  dir(agentId) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(agentId)) throw Error("INVALID_AGENT");
    const dir = path.join(this.root, agentId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (fs.realpathSync(dir) !== path.join(fs.realpathSync(this.root), agentId))
      throw Error("FILE_PATH_DENIED");
    return dir;
  }
  metadata(agentId, fileId) {
    if (!validId.test(fileId)) throw Error("INVALID_FILE_ID");
    try {
      const meta = JSON.parse(
        readRegular(path.join(this.dir(agentId), fileId + ".json"), 256 * 1024),
      );
      if (meta.fileId !== fileId) throw Error();
      return meta;
    } catch {
      throw Error("FILE_NOT_FOUND");
    }
  }
  list(agentId, { offset = 0, limit = 30, query = "" } = {}) {
    const items = fs
      .readdirSync(this.dir(agentId))
      .filter((f) => /^[a-f0-9]{64}\.json$/.test(f))
      .map((f) => this.metadata(agentId, f.slice(0, -5)))
      .sort(
        (a, b) =>
          b.createdAt.localeCompare(a.createdAt) ||
          a.fileId.localeCompare(b.fileId),
      );
    const filtered = items.filter((x) => x.name.includes(query));
    return {
      items: filtered.slice(offset, offset + limit),
      total: filtered.length,
      usedBytes: items.reduce((n, x) => n + x.bytes, 0),
      storedFiles: items.length,
      nextOffset: offset + limit < filtered.length ? offset + limit : null,
    };
  }
  put(
    agentId,
    buffer,
    name,
    policy,
    source = {},
    protectedOperations = false,
    protectedRepositories = [],
  ) {
    fileName(name);
    if (!Buffer.isBuffer(buffer) || buffer.length > policy.maxBytes)
      throw Error("FILE_TOO_LARGE");
    const fileId = hash(buffer),
      dir = this.dir(agentId);
    let old;
    try {
      old = this.metadata(agentId, fileId);
    } catch (e) {
      if (e.message !== "FILE_NOT_FOUND") throw e;
    }
    const usage = this.list(agentId);
    if (
      !old &&
      (usage.usedBytes + buffer.length > policy.maxTotalBytes ||
        usage.storedFiles >= policy.maxFiles)
    )
      throw Error("FILE_QUOTA_EXCEEDED");
    const sources = [...(old?.sources || [])];
    if (!sources.some((s) => JSON.stringify(s) === JSON.stringify(source)))
      sources.push(source);
    const meta = {
      fileId,
      name,
      bytes: buffer.length,
      sha256: fileId,
      createdAt: old?.createdAt || new Date().toISOString(),
      sources: sources.slice(-100),
      protectedOperations: old?.protectedOperations || protectedOperations,
      protectedRepositories: [
        ...new Set([
          ...(old?.protectedRepositories || []),
          ...protectedRepositories,
        ]),
      ],
      contentRead: false,
    };
    const destination = path.join(dir, fileId + ".bin"),
      temp = path.join(dir, randomUUID() + ".part");
    try {
      fs.writeFileSync(temp, buffer, { flag: "wx", mode: 0o600 });
      fs.renameSync(temp, destination);
      atomicJSON(path.join(dir, fileId + ".json"), meta);
    } catch (e) {
      if (!old) fs.rmSync(destination, { force: true });
      throw e;
    } finally {
      fs.rmSync(temp, { force: true });
    }
    return meta;
  }
  read(agentId, fileId, maxBytes) {
    const meta = this.metadata(agentId, fileId);
    const buffer = readRegular(
      path.join(this.dir(agentId), fileId + ".bin"),
      maxBytes,
    );
    if (buffer.length !== meta.bytes || hash(buffer) !== fileId)
      throw Error("FILE_INTEGRITY_FAILED");
    return { meta, buffer };
  }
  import(agentId, rootIndex, relativePath, policy) {
    const root = policy.localRoots[rootIndex];
    if (
      !root ||
      !relativePath ||
      path.isAbsolute(relativePath) ||
      /\\|\0/.test(relativePath) ||
      relativePath
        .split("/")
        .some(
          (s) =>
            !s ||
            s.startsWith(".") ||
            /^(?:auth|config|credentials|admin-token|secrets)(?:\.|$)/i.test(s),
        )
    )
      throw Error("FILE_PATH_DENIED");
    const realRoot = fs.realpathSync(root),
      target = path.resolve(realRoot, relativePath);
    if (
      [
        path.parse(realRoot).root,
        os.homedir(),
        path.dirname(os.homedir()),
      ].includes(realRoot)
    )
      throw Error("FILE_PATH_DENIED");
    if (!inside(realRoot, target)) throw Error("FILE_PATH_DENIED");
    let current = realRoot;
    for (const part of relativePath.split("/")) {
      current = path.join(current, part);
      if (fs.lstatSync(current).isSymbolicLink())
        throw Error("FILE_PATH_DENIED");
    }
    if (!inside(realRoot, fs.realpathSync(target)))
      throw Error("FILE_PATH_DENIED");
    // A directory grant cannot turn another agent's private library into an
    // import source. Files must enter each library through its own ingestion.
    const libraryRoot = fs.realpathSync(this.root);
    if (inside(libraryRoot, fs.realpathSync(target)))
      throw Error("FILE_PATH_DENIED");
    return this.put(
      agentId,
      readRegular(target, policy.maxBytes),
      path.basename(target),
      policy,
      { kind: "administrator-directory", rootIndex },
    );
  }
  async acquire(agentId, operation) {
    if (this.busy.has(agentId)) throw Error("FILE_TRANSFER_BUSY");
    this.busy.add(agentId);
    try {
      return await operation();
    } finally {
      this.busy.delete(agentId);
    }
  }
}
