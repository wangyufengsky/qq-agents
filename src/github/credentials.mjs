// @ts-check
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** @param {string} file */
export function loadGithubCredentials(file) {
  if (!fs.existsSync(file)) return;
  const values = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const [key, value] of Object.entries(values))
    if (/^QQ_GITHUB_[A-Z0-9_]+$/.test(key) && typeof value === "string")
      process.env[key] = value;
}
/** @param {string} file @param {string} key @param {unknown} value */
export function saveGithubCredential(file, key, value) {
  if (
    !file ||
    !/^QQ_GITHUB_[A-Z0-9_]+$/.test(key) ||
    typeof value !== "string" ||
    !/^github_pat_[A-Za-z0-9_]{40,240}$/.test(value)
  )
    throw Error("GITHUB_FINE_GRAINED_TOKEN_REQUIRED");
  const values = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : {};
  if (
    !values ||
    Array.isArray(values) ||
    typeof values !== "object" ||
    Object.values(values).some((v) => typeof v !== "string")
  )
    throw Error("GITHUB_SECRET_STORE_INVALID");
  const temp = path.join(path.dirname(file), ".github-secret-" + randomUUID());
  try {
    fs.writeFileSync(
      temp,
      JSON.stringify({ ...values, [key]: value }, null, 2) + "\n",
      { mode: 0o600, flag: "wx" },
    );
    fs.renameSync(temp, file);
    process.env[key] = value;
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return { configured: true };
}
