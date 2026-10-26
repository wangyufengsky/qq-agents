import { execFileSync } from "node:child_process";
import fs from "node:fs";
import {
  textFindings,
  identityFindings,
  commitFindings,
} from "./privacy-rules.mjs";
const args = process.argv.slice(2),
  git = (...a) =>
    execFileSync("git", a, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
const privateHashes = (process.env.QQ_PRIVATE_IDENTIFIER_HASHES || "")
  .split(",")
  .filter(Boolean);
const failures = [];
let scanned = 0;
let commitsScanned = 0;
function scan(name, text) {
  scanned++;
  if (
    /(?:^|\/)(?:auth\.json|config\.json|launcher\.json|multi-bot\.json|social-v2\.json)$|\.(?:sqlite|db|jsonl|log)(?:-|$)/.test(
      name,
    )
  )
    failures.push({ name, rule: "private-file" });
  if (/^(?:\.runtime|instances|state|data)\//.test(name))
    failures.push({ name, rule: "runtime-data" });
  for (const rule of textFindings(text, privateHashes))
    failures.push({ name, rule });
}
const commitIndex = args.indexOf("--commits");
const revision = commitIndex < 0 ? null : args[commitIndex + 1];
if (commitIndex >= 0 && (!revision || revision.startsWith("-")))
  throw Error("--commits requires a revision or revision range");
if (args.includes("--history") || revision) {
  for (const sha of git(
    "rev-list",
    ...(revision ? [revision, "--"] : ["--all"]),
  )
    .trim()
    .split("\n")
    .filter(Boolean)) {
    commitsScanned++;
    for (const finding of commitFindings(
      git("cat-file", "commit", sha),
      privateHashes,
    ))
      failures.push({ commit: sha, ...finding });
  }
} else {
  // Check the effective identity, including environment overrides, before committing.
  for (const field of ["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"]) {
    let identity = "";
    try {
      identity = git("var", field).trim();
    } catch {
      /* Report a redacted finding. */
    }
    for (const rule of identityFindings(identity))
      failures.push({ field, rule });
    for (const rule of textFindings(identity, privateHashes))
      failures.push({ field, rule });
  }
}
if (args.includes("--history")) {
  for (const line of git("rev-list", "--objects", "--all").trim().split("\n")) {
    const [object, ...rest] = line.split(" ");
    if (!rest.length) continue;
    const name = rest.join(" ");
    if (git("cat-file", "-t", object).trim() !== "blob") continue;
    scan(name, git("cat-file", "blob", object));
  }
} else if (revision) {
  // Commit ranges intentionally scan metadata only; file scans run separately in verify.
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
console.log(JSON.stringify({ scanned, commitsScanned, failures }, null, 2));
if (failures.length) process.exitCode = 1;
