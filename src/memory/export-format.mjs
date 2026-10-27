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
];

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
  if (Object.keys(data.tables || {}).length !== EXPORT_TABLES.length)
    throw Error("EXPORT_INTEGRITY_FAILED");
  for (const name of EXPORT_TABLES) {
    const rows = data.tables[name];
    if (!Array.isArray(rows) || rows.length !== data.manifest.counts?.[name])
      throw Error("EXPORT_INTEGRITY_FAILED");
    digest.update(name + "\n");
    for (const row of rows) digest.update(JSON.stringify(row) + "\n");
  }
  if (digest.digest("hex") !== data.manifest.sha256)
    throw Error("EXPORT_INTEGRITY_FAILED");
}
