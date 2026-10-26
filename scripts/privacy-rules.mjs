import { createHash } from "node:crypto";

const rules = [
  [
    "credential",
    /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9_-]{32,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/,
  ],
  ["personal-path", /\/(?:Users|home)\/[A-Za-z][A-Za-z0-9._-]+\//],
  [
    "access-url",
    /https?:\/\/[^\s"']+[?&](?:token|access_token|api_key)=[A-Za-z0-9_-]{16,}/,
  ],
];
export function textFindings(text, privateHashes = []) {
  const found = rules.filter(([, re]) => re.test(text)).map(([rule]) => rule);
  if (
    [...text.matchAll(/\b\d{6,12}\b/g)].some(([value]) =>
      privateHashes.includes(createHash("sha256").update(value).digest("hex")),
    )
  )
    found.push("private-identifier");
  return found;
}
export function identityFindings(identity) {
  const match = identity.match(/^.+ <([^<>\s]+)>/);
  if (!match) return ["commit-identity-missing"];
  const email = match[1];
  // Explicit non-personal service addresses; do not allow entire corporate domains.
  return /^[A-Za-z0-9+_.-]+@users\.noreply\.github\.com$/i.test(email) ||
    /^(?:noreply@github\.com|noreply@anthropic\.com)$/i.test(email)
    ? []
    : ["personal-commit-email"];
}
export function commitFindings(raw, privateHashes = []) {
  const split = raw.indexOf("\n\n");
  const headers = raw.slice(0, split);
  const findings = [];
  for (const field of ["author", "committer"]) {
    const line = headers.split("\n").find((s) => s.startsWith(field + " "));
    for (const rule of identityFindings(line?.slice(field.length + 1) || ""))
      findings.push({ field, rule });
  }
  const message = raw.slice(split + 2);
  for (const line of message.split("\n"))
    if (/^Co-authored-by:/i.test(line))
      for (const rule of identityFindings(
        line.replace(/^Co-authored-by:\s*/i, ""),
      ))
        findings.push({ field: "co-author", rule });
  for (const rule of textFindings(raw, privateHashes))
    findings.push({ field: "commit-metadata", rule });
  return findings;
}
