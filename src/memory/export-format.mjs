// @ts-check
import { createHash } from "node:crypto";

// The ordering is part of the v2 checksum contract and of restore dependencies.
export const EXPORT_TABLES = [
  "events",
  "diaries",
  "diary_revisions",
  "people",
  "deliveries",
  "runtime",
  "migrations",
  "self_versions",
  "self_candidates",
  "intentions",
  "work_notes",
  "model_turns",
  "session_history",
  "message_progress",
  "message_aliases",
  "message_observations",
  "person_notes",
  "moods",
  "person_items",
  "projects",
  "memory_corrections",
  "activity_history",
];
// Appended after v2 shipped. An older v2 export simply lacks them; their
// absence must not fail the checksum of the tables it does carry.
const ADDED_AFTER_V2 = new Set([
  "person_notes",
  "moods",
  "person_items",
  "projects",
  "memory_corrections",
  "activity_history",
]);

/** @param {{version: number, agentId: string, exportedAt: string}} header */
export function exportDigest(header) {
  return createHash("sha256").update(
    JSON.stringify([header.version, header.agentId, header.exportedAt]) + "\n",
  );
}

/** @param {any} data Parsed export file; validated here. */
export function validateExport(data) {
  if (data.version === 1) return; // Explicit compatibility with historical exports.
  if (data.version !== 2 || data.manifest?.algorithm !== "sha256")
    throw Error("EXPORT_INTEGRITY_FAILED");
  const digest = exportDigest(data);
  const tables = EXPORT_TABLES.filter(
    (name) =>
      !ADDED_AFTER_V2.has(name) || Object.hasOwn(data.tables || {}, name),
  );
  if (Object.keys(data.tables || {}).length !== tables.length)
    throw Error("EXPORT_INTEGRITY_FAILED");
  for (const name of tables) {
    const rows = data.tables[name];
    if (!Array.isArray(rows) || rows.length !== data.manifest.counts?.[name])
      throw Error("EXPORT_INTEGRITY_FAILED");
    digest.update(name + "\n");
    for (const row of rows) digest.update(JSON.stringify(row) + "\n");
  }
  if (digest.digest("hex") !== data.manifest.sha256)
    throw Error("EXPORT_INTEGRITY_FAILED");
}
