import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createHash } from "node:crypto";
const args = process.argv.slice(2),
  git = (...a) =>
    execFileSync("git", a, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
const rules = [
  [
    "credential",
    /(?:gh[pousr]_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9_-]{32,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/,
  ],
  ["personal-path", /\/(?:Users|home)\/[A-Za-z][A-Za-z0-9._-]+\//],
  [
    "access-url",
    /https?:\/\/[^\s"']+[?&](?:token|access_token|api_key)=[A-Za-z0-9_-]{16,}/,
  ],
  ["runtime-data", /^(?:\.runtime|instances|state|data)\//],
];
const privateHashes = (process.env.QQ_PRIVATE_IDENTIFIER_HASHES || "")
  .split(",")
  .filter(Boolean);
const failures = [];
let scanned = 0;
function scan(name, text) {
  scanned++;
  if (
    /(?:^|\/)(?:auth\.json|config\.json|launcher\.json|multi-bot\.json|social-v2\.json)$|\.(?:sqlite|db|jsonl|log)(?:-|$)/.test(
      name,
    )
  )
    failures.push({ name, rule: "private-file" });
  for (const [code, re] of rules) {
    if (re.test(code === "runtime-data" ? name : text))
      failures.push({ name, rule: code });
  }
  if (privateHashes.length)
    for (const m of text.matchAll(/\b\d{6,12}\b/g))
      if (
        privateHashes.includes(createHash("sha256").update(m[0]).digest("hex"))
      )
        failures.push({ name, rule: "private-identifier" });
}
if (args.includes("--history")) {
  for (const line of git("rev-list", "--objects", "--all").trim().split("\n")) {
    const [object, ...rest] = line.split(" ");
    if (!rest.length) continue;
    const name = rest.join(" ");
    if (git("cat-file", "-t", object).trim() !== "blob") continue;
    scan(name, git("cat-file", "blob", object));
  }
} else if (args.includes("--staged")) {
  for (const name of git(
    "diff",
    "--cached",
    "--name-only",
    "--diff-filter=ACMR",
    "-z",
  )
    .split("\0")
    .filter(Boolean))
    scan(name, git("show", ":" + name));
} else
  for (const name of new Set(
    git("ls-files", "--cached", "--others", "--exclude-standard", "-z")
      .split("\0")
      .filter(Boolean),
  ))
    if (fs.existsSync(name) && fs.statSync(name).isFile())
      scan(name, fs.readFileSync(name, "utf8"));
console.log(JSON.stringify({ scanned, failures }, null, 2));
if (failures.length) process.exitCode = 1;
