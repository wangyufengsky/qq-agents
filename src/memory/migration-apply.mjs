import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { backupDatabase } from "./backup.mjs";
import { MemoryStore } from "./store.mjs";
import { importLegacy } from "./migrate.mjs";

export async function applyMigration(file, plan, { backupDestination } = {}) {
  if (plan.rejected.length) throw Error("MIGRATION_REJECTED_RECORDS");
  // Refuse aliases of old sources, including dangling symlinks and hard links.
  for (const candidate of [file, file + "-wal", file + "-shm"]) {
    let stat;
    try {
      stat = fs.lstatSync(candidate);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1))
      throw Error("MIGRATION_TARGET_LINK_REFUSED");
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let before = null;
  // MemoryStore immediately upgrades schema. Only open it after read-only backup.
  if (fs.existsSync(file)) {
    const destination =
      backupDestination ||
      path.join(
        path.dirname(file),
        `memory-${Date.now()}-${randomUUID()}.backup.sqlite`,
      );
    before = { destination, ...(await backupDatabase(file, destination)) };
  }
  let store;
  try {
    store = new MemoryStore(file);
    return { before, ...importLegacy(store.bind(plan.agentId), plan) };
  } catch (error) {
    error.backup = before;
    throw error;
  } finally {
    store?.close();
  }
}
