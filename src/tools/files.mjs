import { mergeProtection } from "../memory/protection.mjs";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { atomicJSON } from "../core/config.mjs";
import { openNoFollow } from "../core/no-follow.mjs";
import { downloadFile } from "./file-download.mjs";
import { z } from "zod";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const validId = /^[a-f0-9]{64}$/;
const generatedDeletion = { version: 1, deletedByAgent: true };
const generatedDeletionBytes = Buffer.from(
  JSON.stringify(generatedDeletion, null, 2) + "\n",
);
function isGeneratedDeletion(marker) {
  try {
    return readRegular(marker, generatedDeletionBytes.length).equals(
      generatedDeletionBytes,
    );
  } catch {
    // Unknown markers keep the existing damaged-file rules.
    return false;
  }
}
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
    protectedPeerQzoneTargets: z
      .array(z.string().regex(/^[1-9]\d{4,19}$/))
      .optional(),
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
  const fd = openNoFollow(file);
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
export class FileRevisionConflict extends Error {
  constructor(code, latest) {
    super(code);
    this.latestFileId = latest.fileId;
    if (latest.version) this.latestVersion = latest.version;
  }
}
const revisionMarker = (meta) =>
  meta.sources.findLast(
    (s) => s.kind === "revision" && validId.test(s.revisionOf),
  );
// Lineage lives in a passthrough source entry, so metadata written here stays
// readable by earlier releases, which simply list each version as a file.
function versionIndex(items) {
  const byId = new Map(items.map((m) => [m.fileId, m])),
    children = new Map();
  const parent = (meta) => {
    const id = revisionMarker(meta)?.revisionOf;
    return id && id !== meta.fileId && byId.has(id) ? id : undefined;
  };
  for (const meta of items) {
    const id = parent(meta);
    if (id) children.set(id, [...(children.get(id) || []), meta]);
  }
  const version = (meta) => {
    const value = revisionMarker(meta)?.revision;
    return Number.isSafeInteger(value) && value > 1 ? value : 1;
  };
  const latest = (fileId) => {
    let current = byId.get(fileId);
    const seen = new Set([fileId]);
    for (;;) {
      // Branches only arise from damaged or hand-edited libraries; follow the
      // newest so a conflict always points somewhere readable.
      const next = (children.get(current.fileId) || [])
        .filter((m) => !seen.has(m.fileId))
        .sort(
          (a, b) =>
            b.createdAt.localeCompare(a.createdAt) ||
            a.fileId.localeCompare(b.fileId),
        )[0];
      if (!next) return current;
      seen.add(next.fileId);
      current = next;
    }
  };
  const chain = (fileId) => {
    let root = fileId;
    const seen = new Set([root]);
    for (let up = parent(byId.get(root)); up && !seen.has(up);) {
      seen.add(up);
      root = up;
      up = parent(byId.get(root));
    }
    const members = [root],
      visited = new Set(members);
    for (let i = 0; i < members.length; i++)
      for (const child of children.get(members[i]) || [])
        if (!visited.has(child.fileId)) {
          visited.add(child.fileId);
          members.push(child.fileId);
        }
    return members;
  };
  const annotate = (meta) => {
    const revisionOf = parent(meta) ?? revisionMarker(meta)?.revisionOf,
      newest = byId.has(meta.fileId) ? latest(meta.fileId) : meta;
    return {
      ...meta,
      version: version(meta),
      ...(revisionOf ? { revisionOf } : {}),
      latest: newest.fileId === meta.fileId,
      latestFileId: newest.fileId,
    };
  };
  return { byId, latest, chain, annotate, version };
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
      blockedCount = 0,
      deletedCount = 0;
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
        if (stats.has(fileId + ".json") || stats.has(fileId + ".bin")) {
          blockedCount++;
          corrupt.push({ fileId, code: "FILE_REMOVAL_INCOMPLETE" });
        } else if (isGeneratedDeletion(path.join(dir, fileId + ".blocked"))) {
          deletedCount++;
        } else {
          blockedCount++;
        }
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
      storedFiles: ids.size + extraFiles - deletedCount,
      usageComplete,
      blockedCount,
      orphanFiles: extraFiles,
    };
  }
  list(
    agentId,
    {
      offset = 0,
      limit = 30,
      query = "",
      latestOnly = false,
      versionsOf = undefined,
    } = {},
  ) {
    const scanned = this.scan(agentId);
    const versions = versionIndex(scanned.items);
    const items = scanned.items
      .map((meta) => versions.annotate(meta))
      .sort(
        (a, b) =>
          b.createdAt.localeCompare(a.createdAt) ||
          a.fileId.localeCompare(b.fileId),
      );
    let filtered = items.filter((x) => x.name.includes(query));
    if (latestOnly) filtered = filtered.filter((x) => x.latest);
    if (versionsOf !== undefined) {
      if (!validId.test(versionsOf)) throw Error("INVALID_FILE_ID");
      if (!versions.byId.has(versionsOf)) throw Error("FILE_NOT_FOUND");
      const chain = new Set(versions.chain(versionsOf));
      // A history view reads oldest first, like the drafts were written.
      filtered = filtered
        .filter((x) => chain.has(x.fileId))
        .sort(
          (a, b) =>
            a.version - b.version ||
            a.createdAt.localeCompare(b.createdAt) ||
            a.fileId.localeCompare(b.fileId),
        );
    }
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
    protectedPeerQzoneTargets = [],
    { inheritedSources = [], protectionUnknown = false } = {},
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
    for (const entry of [...inheritedSources, source])
      if (!sources.some((s) => JSON.stringify(s) === JSON.stringify(entry)))
        sources.push(entry);
    const meta = {
      fileId,
      name,
      bytes: buffer.length,
      sha256: fileId,
      createdAt: old?.createdAt || new Date().toISOString(),
      sources: sources.slice(-100),
      ...mergeProtection(old, { protectedPeerQzoneTargets }),
      protectedOperations: old?.protectedOperations || protectedOperations,
      protectedRepositories: [
        ...new Set([
          ...(old?.protectedRepositories || []),
          ...protectedRepositories,
        ]),
      ],
      ...(old?.protectionUnknown || protectionUnknown
        ? { protectionUnknown: true }
        : {}),
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
  // Content addressing keeps every earlier version intact; a revision is a new
  // file whose provenance names the version it was written from. The check
  // and write below are synchronous, so callers holding acquire() cannot race.
  revise(agentId, baseFileId, buffer, name, policy, source, protection = {}) {
    const base = this.metadata(agentId, baseFileId);
    if (!Buffer.isBuffer(buffer) || buffer.length > policy.maxBytes)
      throw Error("FILE_TOO_LARGE");
    const versions = versionIndex(this.scan(agentId).items);
    if (!versions.byId.has(baseFileId)) {
      // Surface the precise damage instead of revising an unreadable base.
      this.read(agentId, baseFileId, 52428800);
      throw Error("FILE_INTEGRITY_FAILED");
    }
    const fileId = hash(buffer),
      latest = versions.latest(baseFileId);
    if (fileId === baseFileId || fileId === latest.fileId)
      return {
        ...versions.annotate(fileId === baseFileId ? base : latest),
        unchanged: true,
      };
    if (latest.fileId !== baseFileId)
      throw new FileRevisionConflict(
        "FILE_REVISION_CONFLICT",
        versions.annotate(latest),
      );
    let existing;
    try {
      existing = this.metadata(agentId, fileId);
    } catch (error) {
      if (error.message !== "FILE_NOT_FOUND") throw error;
    }
    // Reusing another file's ID would rewrite its lineage or form a cycle.
    if (existing || hasEntry(path.join(this.dir(agentId), fileId + ".bin")))
      throw new FileRevisionConflict(
        "FILE_REVISION_CONTENT_EXISTS",
        existing ? versions.annotate(existing) : { fileId },
      );
    const marker = {
      ...source,
      kind: "revision",
      revisionOf: baseFileId,
      revision: versions.version(base) + 1,
    };
    // Each file carries one lineage marker. Inherited markers keep their
    // conversation as plain provenance, so protection never washes out.
    const inherited = [];
    for (const entry of base.sources) {
      const kept =
        entry.kind === "revision"
          ? { kind: "generated-text", conversation: entry.conversation }
          : entry;
      if (!inherited.some((s) => JSON.stringify(s) === JSON.stringify(kept)))
        inherited.push(kept);
    }
    if (inherited.length >= 100) throw Error("FILE_METADATA_TOO_LARGE");
    const saved = this.put(
      agentId,
      buffer,
      name,
      policy,
      marker,
      base.protectedOperations || protection.protectedOperations === true,
      [
        ...(base.protectedRepositories || []),
        ...(protection.protectedRepositories || []),
      ],
      [
        ...(base.protectedPeerQzoneTargets || []),
        ...(protection.protectedPeerQzoneTargets || []),
      ],
      {
        inheritedSources: inherited,
        protectionUnknown: base.protectionUnknown === true,
      },
    );
    return versionIndex([...versions.byId.values(), saved]).annotate(saved);
  }
  // Version facts for one file, computed from the current library.
  versionOf(agentId, fileId) {
    const versions = versionIndex(this.scan(agentId).items);
    const meta = versions.byId.get(fileId);
    if (!meta) return { version: 1, latest: true, latestFileId: fileId };
    const { version, revisionOf, latest, latestFileId } =
      versions.annotate(meta);
    return { version, revisionOf, latest, latestFileId };
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
  deleteGenerated(agentId, fileId, assertSource) {
    if (!validId.test(fileId)) throw Error("INVALID_FILE_ID");
    const marker = path.join(this.dir(agentId), fileId + ".blocked");
    if (!isGeneratedDeletion(marker)) {
      const { meta } = this.read(agentId, fileId, 52428800);
      assertSource(meta);
      // The source list is capped. A full list can have lost a prior import
      // through deduplication, so it cannot prove sole authorship.
      if (
        meta.sources.length === 0 ||
        meta.sources.length >= 100 ||
        meta.sources.some(
          (source) => !["generated-text", "revision"].includes(source.kind),
        )
      )
        throw Error("FILE_DELETE_SOURCE_DENIED");
      const { items, corruptCount, usageComplete } = this.scan(agentId);
      if (corruptCount || !usageComplete) throw Error("FILE_QUOTA_UNAVAILABLE");
      if (items.some((item) => revisionMarker(item)?.revisionOf === fileId))
        throw Error("FILE_DELETE_HAS_REVISIONS");
      // IDs are content hashes referenced by drafts and history. Prevent
      // reimport from reviving those IDs or replacing their provenance.
      try {
        atomicJSON(marker, generatedDeletion);
      } catch (error) {
        throw fileError(error, "FILE_IO_ERROR");
      }
    }
    return this.#removeEntries(agentId, fileId);
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
    const marker = path.join(dir, fileId + ".blocked");
    if (!isGeneratedDeletion(marker))
      atomicJSON(marker, { version: 1, protectionUnknown: true });
    return this.#removeEntries(agentId, fileId);
  }
  #removeEntries(agentId, fileId) {
    const dir = this.dir(agentId);
    for (const ext of ["bin", "json"]) {
      const file = path.join(dir, fileId + "." + ext);
      try {
        fs.unlinkSync(file);
      } catch (error) {
        if (error.code !== "ENOENT") throw fileError(error, "FILE_IO_ERROR");
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
            /^(?:auth|config|credentials|admin-token|relay-token|secrets)(?:\.|$)/i.test(
              s,
            ),
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
