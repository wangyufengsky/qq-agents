// @ts-check
import { createHash } from "node:crypto";
import { INPUT_VERSION_ALGORITHM } from "./input-state.mjs";

// The ordering is part of the v2 checksum contract and of restore dependencies.
const V2_TABLES = [
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
  "qzone_approvals",
  "qq_drafts",
  "qq_draft_items",
];
export const INPUT_EXPORT_TABLES = [
  "input_legacy_scopes",
  "input_scopes",
  "input_versions",
];
export const EXPORT_TABLES = [...V2_TABLES, ...INPUT_EXPORT_TABLES];
// Appended after v2 shipped. An older v2 export simply lacks them; their
// absence must not fail the checksum of the tables it does carry.
const ADDED_AFTER_V2 = new Set([
  "person_notes",
  "moods",
  "person_items",
  "projects",
  "memory_corrections",
  "activity_history",
  "qzone_approvals",
  "qq_drafts",
  "qq_draft_items",
]);

/** @param {string} agentId @param {string} exportedAt */
export function exportHeader(agentId, exportedAt) {
  return {
    version: 3,
    agentId,
    exportedAt,
    inputVersion: INPUT_VERSION_ALGORITHM,
  };
}

/** @param {{version: number, agentId: string, exportedAt: string, inputVersion?: string}} header */
export function exportDigest(header) {
  const fields = [header.version, header.agentId, header.exportedAt];
  if (header.version === 3) fields.push(header.inputVersion ?? "");
  return createHash("sha256").update(JSON.stringify(fields) + "\n");
}

/** @param {ReturnType<typeof exportHeader>} header @param {Record<string, any[]>} tables */
export function withExportManifest(header, tables) {
  const digest = exportDigest(header);
  const counts = Object.fromEntries(
    EXPORT_TABLES.map((name) => {
      digest.update(name + "\n");
      for (const row of tables[name]) digest.update(JSON.stringify(row) + "\n");
      return [name, tables[name].length];
    }),
  );
  return {
    ...header,
    tables,
    manifest: { algorithm: "sha256", counts, sha256: digest.digest("hex") },
  };
}

/** @param {any} data Parsed export file; validated here. */
export function validateExport(data) {
  if (data.version === 1) return; // Explicit compatibility with historical exports.
  if (
    (data.version !== 2 && data.version !== 3) ||
    data.manifest?.algorithm !== "sha256" ||
    (data.version === 3 && data.inputVersion !== INPUT_VERSION_ALGORITHM)
  )
    throw Error("EXPORT_INTEGRITY_FAILED");
  const digest = exportDigest(data);
  const tables =
    data.version === 3
      ? EXPORT_TABLES
      : V2_TABLES.filter(
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
