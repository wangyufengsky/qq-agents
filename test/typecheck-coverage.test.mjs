import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// tsconfig.json uses checkJs: false, so a file is type-checked only when it
// starts with `// @ts-check`. Keep that header and the include list in step.
const root = fileURLToPath(new URL("..", import.meta.url));
const headed = (file) =>
  fs
    .readFileSync(path.join(root, file), "utf8")
    .replace(/^#!.*\n/, "")
    .startsWith("// @ts-check\n");

test("every file in the tsconfig include list opts in with // @ts-check", () => {
  const { include } = JSON.parse(
    fs.readFileSync(path.join(root, "tsconfig.json"), "utf8"),
  );
  const included = fs.globSync(include, { cwd: root });
  assert.ok(included.length > 0);
  assert.deepEqual(
    included.filter((file) => !headed(file)),
    [],
    "add // @ts-check as the first line of these files",
  );
  const stray = fs
    .globSync(["src/**/*.mjs", "scripts/**/*.mjs"], { cwd: root })
    .filter((file) => headed(file) && !included.includes(file));
  assert.deepEqual(stray, [], "add these files to the tsconfig include list");
});
