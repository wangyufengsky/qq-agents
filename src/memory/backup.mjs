// @ts-check
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, backup } from "node:sqlite";

// SQLite's backup API includes committed WAL pages without copying a live file.
// Never opens a source through MemoryStore, so backup cannot upgrade its schema.
/** @param {string} source @param {string} destination */
export async function backupDatabase(source, destination) {
  if (path.resolve(source) === path.resolve(destination))
    throw Error("BACKUP_SAME_PATH");
  const db = new DatabaseSync(source, { readOnly: true });
  let owned = false;
  try {
    if (
      /** @type {Record<string, unknown>} */ (
        db.prepare("PRAGMA quick_check").get()
      ).quick_check !== "ok"
    )
      throw Error("BACKUP_SOURCE_CORRUPT");
    const fd = fs.openSync(destination, "wx", 0o600);
    fs.closeSync(fd);
    owned = true;
    await backup(db, destination);
    const check = new DatabaseSync(destination, { readOnly: true });
    try {
      if (
        /** @type {Record<string, unknown>} */ (
          check.prepare("PRAGMA integrity_check").get()
        ).integrity_check !== "ok" ||
        check.prepare("PRAGMA foreign_key_check").all().length
      )
        throw Error("BACKUP_INTEGRITY_FAILED");
      return {
        schemaVersion: /** @type {Record<string, unknown>} */ (
          check.prepare("PRAGMA user_version").get()
        ).user_version,
        bytes: fs.statSync(destination).size,
        integrity: "ok",
      };
    } finally {
      check.close();
    }
  } catch (e) {
    if (owned) fs.rmSync(destination, { force: true });
    throw e;
  } finally {
    db.close();
  }
}
