// @ts-check
import fs from "node:fs";
import path from "node:path";
import { atomicJSON } from "./config.mjs";

const NAME = /^[A-Z][A-Z0-9_]{0,100}$/;

/**
 * `<data>/secrets.json` maps environment variable names to values, so a data
 * directory can carry its own OneBot token and API keys on every platform
 * (scripts/robots.mjs has always injected it). Values never appear in config.
 * @param {string} root data directory
 * @returns {Record<string, string>}
 */
export function readLocalSecrets(root) {
  const file = path.join(root, "secrets.json");
  if (!fs.existsSync(file)) return {};
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    value = null;
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.entries(value).some(
      ([name, secret]) => !NAME.test(name) || typeof secret !== "string",
    )
  )
    throw Error("INVALID_LOCAL_SECRETS");
  return value;
}

/**
 * Fill environment variables that are not already set; an explicit variable
 * in the launching shell wins. Returns the names that were applied.
 * @param {string} root
 * @param {Record<string, string | undefined>} [env]
 */
export function applyLocalSecrets(root, env = process.env) {
  const applied = [];
  for (const [name, value] of Object.entries(readLocalSecrets(root)))
    if (env[name] === undefined || env[name] === "") {
      env[name] = value;
      applied.push(name);
    }
  return applied;
}

/**
 * Add or replace one secret, keeping the file private (0600, atomic rename).
 * @param {string} root
 * @param {string} name
 * @param {string} value
 */
export function writeLocalSecret(root, name, value) {
  if (!NAME.test(name)) throw Error("INVALID_SECRET_NAME");
  if (typeof value !== "string" || !value) throw Error("EMPTY_SECRET");
  atomicJSON(path.join(root, "secrets.json"), {
    ...readLocalSecrets(root),
    [name]: value,
  });
}
