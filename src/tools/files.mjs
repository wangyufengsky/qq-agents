import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { atomicJSON } from "../core/config.mjs";
import { downloadFile } from "./file-download.mjs";
import { z } from "zod";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const validId = /^[a-f0-9]{64}$/;
const metadataSchema = z
  .object({
    fileId: z.string().regex(validId),
    sha256: z.string().regex(validId),
    name: z.string().refine((v) => {
      try {
        fileName(v);
        return true;
      } catch {
        return false;
      }
    }),
    bytes: z.number().int().min(0).max(52428800),
    createdAt: z.string().refine((v) => Number.isFinite(Date.parse(v))),
    sources: z
      .array(
        z
          .object({
            conversation: z.string().optional(),
            eventId: z.string().optional(),
          })
          .passthrough(),
      )
      .max(100),
    protectedOperations: z.boolean().optional(),
    protectedRepositories: z.array(z.string().min(1)).optional(),
    protectionUnknown: z.boolean().optional(),
    contentRead: z.literal(false),
  })
  .strict();
function fileError(error, missing) {
  if (error.code === "ENOENT") return Error(missing);
  if (["EACCES", "EPERM"].includes(error.code))
    return Error("FILE_ACCESS_DENIED");
  if (error.code === "ELOOP" || error.message === "FILE_PATH_DENIED")
    return Error("FILE_PATH_DENIED");
  return Error("FILE_IO_ERROR");
}
const corruptCodes = new Set([
  "FILE_METADATA_CORRUPT",
  "FILE_CONTENT_MISSING",
  "FILE_INTEGRITY_FAILED",
  "FILE_PATH_DENIED",
  "FILE_ACCESS_DENIED",
  "FILE_IO_ERROR",
  "FILE_REMOVED_PROTECTED",
]);
function hasEntry(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw fileError(error, "FILE_NOT_FOUND");
  }
}
export function fileName(value) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    Buffer.byteLength(value) > 200 ||
    // eslint-disable-next-line no-control-regex -- deliberately rejects control characters
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
    const dir = this.dir(agentId);
    if (hasEntry(path.join(dir, fileId + ".blocked")))
      throw Error("FILE_REMOVED_PROTECTED");
    let bytes;
    try {
      bytes = readRegular(path.join(dir, fileId + ".json"), 256 * 1024);
    } catch (error) {
      if (error.message === "FILE_TOO_LARGE")
        throw Error("FILE_METADATA_CORRUPT", { cause: error });
      throw fileError(error, "FILE_NOT_FOUND");
    }
    try {
      const meta = metadataSchema.parse(JSON.parse(bytes));
      if (meta.fileId !== fileId || meta.sha256 !== fileId) throw Error();
      if (
        meta.protectedOperations === undefined ||
        meta.protectedRepositories === undefined ||
        meta.protectionUnknown
      ) {
        meta.protectionUnknown = true;
        meta.protectedOperations = true;
      }
      return meta;
    } catch {
      throw Error("FILE_METADATA_CORRUPT");
    }
  }
  scan(agentId) {
    const dir = this.dir(agentId),
      ids = new Set(),
      stats = new Map();
    let usedBytes = 0,
      extraFiles = 0,
      usageComplete = true,
      blockedCount = 0;
    for (const name of fs.readdirSync(dir)) {
      const match = /^([a-f0-9]{64})\.(json|bin|blocked)$/.exec(name);
      if (match) ids.add(match[1]);
      else extraFiles++;
      try {
        const stat = fs.lstatSync(path.join(dir, name));
        usedBytes += stat.size;
        if (stat.isDirectory()) usageComplete = false;
        stats.set(name, stat);
      } catch {
        usageComplete = false;
      }
    }
    const items = [],
      corrupt = [];
    for (const fileId of ids) {
      if (stats.has(fileId + ".blocked")) {
        blockedCount++;
        if (stats.has(fileId + ".json") || stats.has(fileId + ".bin"))
          corrupt.push({ fileId, code: "FILE_REMOVAL_INCOMPLETE" });
        continue;
      }
      try {
        const meta = this.metadata(agentId, fileId),
          bin = stats.get(fileId + ".bin");
        if (!bin) throw Error("FILE_CONTENT_MISSING");
        if (!bin.isFile() || bin.nlink !== 1) throw Error("FILE_PATH_DENIED");
        if (bin.size !== meta.bytes) throw Error("FILE_INTEGRITY_FAILED");
        items.push(meta);
      } catch (error) {
        corrupt.push({
          fileId,
          code:
            error.message === "FILE_NOT_FOUND"
              ? "FILE_METADATA_MISSING"
              : corruptCodes.has(error.message)
                ? error.message
                : "FILE_IO_ERROR",
        });
      }
    }
    return {
      items,
      corrupt,
      corruptCount: corrupt.length,
      usedBytes,
      storedFiles: ids.size + extraFiles,
      usageComplete,
      blockedCount,
      orphanFiles: extraFiles,
    };
  }
  list(agentId, { offset = 0, limit = 30, query = "" } = {}) {
    const scanned = this.scan(agentId);
    const items = scanned.items.sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) ||
        a.fileId.localeCompare(b.fileId),
    );
    const filtered = items.filter((x) => x.name.includes(query));
    return {
      ...scanned,
      items: filtered.slice(offset, offset + limit),
      total: filtered.length,
      corrupt: scanned.corrupt.slice(offset, offset + limit),
      nextCorruptOffset:
        offset + limit < scanned.corrupt.length ? offset + limit : null,
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
      try {
        fs.lstatSync(path.join(dir, fileId + ".bin"));
        throw Error("FILE_METADATA_MISSING", { cause: e });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    if (old) this.read(agentId, fileId, policy.maxBytes);
    const usage = this.scan(agentId);
    if (!usage.usageComplete) throw Error("FILE_QUOTA_UNAVAILABLE");
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
      ...(old?.protectionUnknown ? { protectionUnknown: true } : {}),
      contentRead: false,
    };
    const metaBytes = Buffer.byteLength(JSON.stringify(meta, null, 2) + "\n");
    if (metaBytes > 256 * 1024) throw Error("FILE_METADATA_TOO_LARGE");
    if (!metadataSchema.safeParse(meta).success)
      throw Error("INVALID_FILE_METADATA");
    const replaced = old
      ? fs.lstatSync(path.join(dir, fileId + ".bin")).size +
        fs.lstatSync(path.join(dir, fileId + ".json")).size
      : 0;
    if (
      usage.usedBytes - replaced + buffer.length + metaBytes >
        policy.maxTotalBytes ||
      (!old && usage.storedFiles >= policy.maxFiles)
    )
      throw Error("FILE_QUOTA_EXCEEDED");
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
    let buffer;
    try {
      buffer = readRegular(
        path.join(this.dir(agentId), fileId + ".bin"),
        maxBytes,
      );
    } catch (error) {
      if (error.message === "FILE_TOO_LARGE") throw error;
      throw fileError(error, "FILE_CONTENT_MISSING");
    }
    if (buffer.length !== meta.bytes || hash(buffer) !== fileId)
      throw Error("FILE_INTEGRITY_FAILED");
    return { meta, buffer };
  }
  requireDamage(agentId, fileId) {
    try {
      this.read(agentId, fileId, 52428800);
    } catch (error) {
      if (
        [
          "FILE_METADATA_CORRUPT",
          "FILE_NOT_FOUND",
          "FILE_CONTENT_MISSING",
          "FILE_INTEGRITY_FAILED",
          "FILE_PATH_DENIED",
          "FILE_REMOVED_PROTECTED",
        ].includes(error.message)
      )
        return;
      throw error;
    }
    throw Error("FILE_REPAIR_NOT_NEEDED");
  }
  repair(agentId, fileId, name, policy) {
    if (!validId.test(fileId)) throw Error("INVALID_FILE_ID");
    fileName(name);
    this.requireDamage(agentId, fileId);
    const dir = this.dir(agentId);
    if (hasEntry(path.join(dir, fileId + ".blocked")))
      throw Error("FILE_REMOVED_PROTECTED");
    let buffer;
    try {
      buffer = readRegular(path.join(dir, fileId + ".bin"), policy.maxBytes);
    } catch (error) {
      if (error.message === "FILE_TOO_LARGE") throw error;
      throw fileError(error, "FILE_CONTENT_MISSING");
    }
    if (hash(buffer) !== fileId) throw Error("FILE_INTEGRITY_FAILED");
    const meta = {
      fileId,
      sha256: fileId,
      name,
      bytes: buffer.length,
      createdAt: new Date().toISOString(),
      sources: [{ kind: "administrator-recovery" }],
      protectedOperations: true,
      protectedRepositories: [],
      protectionUnknown: true,
      contentRead: false,
    };
    const usage = this.scan(agentId),
      target = path.join(dir, fileId + ".json");
    let previous = 0;
    try {
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.nlink !== 1) throw Error("FILE_PATH_DENIED");
      previous = stat.size;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const added =
      Buffer.byteLength(JSON.stringify(meta, null, 2) + "\n") - previous;
    if (!usage.usageComplete) throw Error("FILE_QUOTA_UNAVAILABLE");
    if (added > 0 && usage.usedBytes + added > policy.maxTotalBytes)
      throw Error("FILE_QUOTA_EXCEEDED");
    atomicJSON(target, meta);
    return meta;
  }
  removeDamaged(agentId, fileId) {
    if (!validId.test(fileId)) throw Error("INVALID_FILE_ID");
    this.requireDamage(agentId, fileId);
    const dir = this.dir(agentId),
      entries = ["json", "bin"].map((ext) =>
        path.join(dir, fileId + "." + ext),
      );
    let found = false;
    for (const file of entries) {
      try {
        const stat = fs.lstatSync(file);
        if (stat.isDirectory()) throw Error("FILE_PATH_DENIED");
        found = true;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    if (!found && !hasEntry(path.join(dir, fileId + ".blocked")))
      throw Error("FILE_NOT_FOUND");
    // Persist the provenance tombstone BEFORE removing either file. A crash or
    // same-content upload must not turn unknown protected data into public data.
    atomicJSON(path.join(dir, fileId + ".blocked"), {
      version: 1,
      protectionUnknown: true,
    });
    for (const file of entries) {
      try {
        fs.unlinkSync(file);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    return { removed: true, blockedForReimport: true };
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
