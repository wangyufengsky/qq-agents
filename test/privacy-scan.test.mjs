import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { temp } from "./helpers.mjs";
import {
  commitFindings,
  identityFindings,
  textFindings,
} from "../scripts/privacy-rules.mjs";

const safe = "Example <42+example@users.noreply.github.com>";
const personal = "Example <" + "7654321" + "@qq.com>";
test("identity scan checks author, committer and co-authors without exposing values", () => {
  assert.deepEqual(identityFindings(safe), []);
  for (const field of ["author", "committer"]) {
    const raw = `tree abc\nauthor ${field === "author" ? personal : safe} 0 +0000\ncommitter ${field === "committer" ? personal : safe} 0 +0000\n\nmessage`;
    assert.deepEqual(commitFindings(raw), [
      { field, rule: "personal-commit-email" },
    ]);
    assert.ok(!JSON.stringify(commitFindings(raw)).includes("7654321"));
  }
  assert.deepEqual(
    commitFindings(
      `author ${safe}\ncommitter ${safe}\n\nCo-authored-by: ${personal}`,
    ),
    [{ field: "co-author", rule: "personal-commit-email" }],
  );
  assert.deepEqual(identityFindings("Example <name@github.com>"), [
    "personal-commit-email",
  ]);
});
test("commit messages and fine-grained GitHub tokens are covered", () => {
  const secret = "github_" + "pat_" + "x".repeat(50);
  const number = "7654321";
  const hashes = [createHash("sha256").update(number).digest("hex")];
  const result = commitFindings(
    `author ${safe}\ncommitter ${safe}\n\n${secret} ${number}`,
    hashes,
  );
  assert.deepEqual(
    result.map((x) => x.rule),
    ["credential", "private-identifier"],
  );
  assert.deepEqual(textFindings(secret), ["credential"]);
  assert.ok(!JSON.stringify(result).includes(secret));
});
test("CLI scans historical identities even after changing current Git config", (t) => {
  const cwd = temp(t),
    script = path.resolve("scripts/privacy-scan.mjs");
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Example",
    GIT_COMMITTER_NAME: "Example",
    GIT_AUTHOR_EMAIL: "7654321" + "@qq.com",
    GIT_COMMITTER_EMAIL: "7654321" + "@qq.com",
  };
  const git = (...args) =>
    execFileSync("git", args, { cwd, env, stdio: "pipe" });
  git("init", "-q");
  fs.writeFileSync(path.join(cwd, "readme.txt"), "public text");
  git("add", ".");
  git("commit", "-qm", "initial");
  env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL =
    "42+example@users.noreply.github.com";
  const run = (...args) =>
    spawnSync(process.execPath, [script, ...args], {
      cwd,
      env,
      encoding: "utf8",
    });
  assert.equal(run().status, 0);
  const history = run("--history");
  assert.equal(history.status, 1);
  assert.equal(JSON.parse(history.stdout).commitsScanned, 1);
  assert.ok(!history.stdout.includes("7654321"));
  git("commit", "--allow-empty", "-qm", "clean identity");
  assert.equal(run("--commits", "HEAD^..HEAD").status, 0);
  env.GIT_AUTHOR_EMAIL = "7654321" + "@qq.com";
  assert.equal(run("--staged").status, 1);
});
