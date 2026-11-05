// @ts-check
import {
  socialRecordSources,
  parseSocialMarker,
} from "../core/social-protection.mjs";
// Protection is monotonic: editing text or removing evidence cannot declassify
// information already incorporated into a saved record.
/** @param {...any} records */
export function mergeProtection(...records) {
  const targets = new Set();
  for (const record of records) {
    const values = record?.protectedPeerQzoneTargets;
    if (values === undefined) continue;
    if (
      !Array.isArray(values) ||
      values.some((v) => typeof v !== "string" || !/^[1-9]\d{4,19}$/.test(v))
    )
      throw Error("INVALID_PROTECTION_METADATA");
    for (const id of values) targets.add(id);
  }
  const repositories = new Set();
  for (const record of records) {
    const values = record?.protectedRepositories;
    if (values === undefined) continue;
    if (
      !Array.isArray(values) ||
      values.some((v) => typeof v !== "string" || !v)
    )
      throw Error("INVALID_PROTECTION_METADATA");
    for (const repo of values) repositories.add(repo.toLowerCase());
  }
  const social = [...new Set(records.flatMap(socialRecordSources))].sort();
  return {
    ...(social.length ? { protectedSocialSources: social } : {}),
    ...(targets.size ? { protectedPeerQzoneTargets: [...targets].sort() } : {}),
    ...(records.some((r) => r?.protectedOperations === true)
      ? { protectedOperations: true }
      : {}),
    ...(repositories.size
      ? { protectedRepositories: [...repositories].sort() }
      : {}),
  };
}

// Personal exports are not a private social transcript export. Keep durable taint
// while removing text, including nested frozen evidence and old diary revisions.
/** @param {any} value @returns {boolean} */
function hasSocial(value) {
  if (typeof value === "string") return parseSocialMarker(value) !== null;
  if (!value || typeof value !== "object") return false;
  if (socialRecordSources(value).length) return true;
  return Object.values(value).some(hasSocial);
}
/** @param {any} value @param {string} [key] @returns {any} */
function redactSocial(value, key = "") {
  if (key === "protectedSocialSources")
    return socialRecordSources({ protectedSocialSources: value });
  // Other audience labels remain authoritative after restoring redacted prose.
  if (key === "protectedPeerQzoneTargets" || key === "protectedRepositories")
    return mergeProtection({ [key]: value })[key] || [];
  if (typeof value === "string" && parseSocialMarker(value) !== null)
    return value;
  if (typeof value === "string")
    return [
      "id",
      "agentId",
      "agent_id",
      "conversation",
      "status",
      "state",
      "kind",
      "direction",
      "origin",
      "requestId",
    ].includes(key)
      ? value
      : "";
  if (Array.isArray(value)) return value.map((item) => redactSocial(item));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [
        name,
        redactSocial(item, name),
      ]),
    );
  return value;
}
/** @param {string} table @param {any} original @returns {any} */
export function socialSafeExportRow(table, original) {
  const row = { ...original };
  /** @type {Record<string, any>} */
  const parsed = {};
  for (const key of ["payload", "metadata", "value"])
    if (typeof row[key] === "string") {
      try {
        parsed[key] = JSON.parse(row[key]);
      } catch {
        /* Other fields are ordinary text. */
      }
    }
  if (!Object.values(parsed).some(hasSocial)) return row;
  for (const [key, value] of Object.entries(parsed))
    row[key] = JSON.stringify(redactSocial(value));
  for (const key of ["body", "title", "summary"]) if (key in row) row[key] = "";
  return row;
}
