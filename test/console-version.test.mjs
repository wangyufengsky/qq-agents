import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { fixture } from "./helpers.mjs";
import { createServer } from "../src/server.mjs";

test("the sidebar's built-in text carries no version that could go stale", () => {
  const html = fs.readFileSync(
    new URL("../public/index.html", import.meta.url),
    "utf8",
  );
  const label = html.match(/class="version">([^<]*)</)?.[1];
  assert.equal(typeof label, "string");
  assert.doesNotMatch(label, /v?\d+\.\d+/);
});

// The full version comes from package.json through the status API.
test("the console status names the running release", async (t) => {
  const f = fixture(t),
    token = randomBytes(32).toString("hex"),
    app = createServer({ runtime: f.runtime, token });
  const port = await app.listen();
  t.after(() => app.close());
  const status = await (
    await fetch(`http://127.0.0.1:${port}/api/status`, {
      headers: { "x-admin-token": token },
    })
  ).json();
  const { version } = JSON.parse(
    fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(status.version, version);
  assert.match(version, /^\d+\.\d+\.\d+/);
});
