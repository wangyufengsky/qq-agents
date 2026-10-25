import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { backupDatabase } from "./backup.mjs";
import { MemoryStore } from "./store.mjs";
import { importLegacy } from "./migrate.mjs";

export async function applyMigration(file, plan, { backupDestination } = {}) {
  if (plan.rejected.length) throw Error("MIGRATION_REJECTED_RECORDS");
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
