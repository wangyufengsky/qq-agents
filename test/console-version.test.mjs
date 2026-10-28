import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("the console shows the package's major.minor version", () => {
  const { version } = JSON.parse(
    fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  const html = fs.readFileSync(
    new URL("../public/index.html", import.meta.url),
    "utf8",
  );
  const shown = html.match(/class="version">v(\d+\.\d+) ·/)?.[1];
  assert.equal(shown, version.split(".").slice(0, 2).join("."));
});
