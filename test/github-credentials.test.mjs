import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fixture } from "./helpers.mjs";
import { createServer } from "../src/server.mjs";
import { loadGithubCredentials } from "../src/github/credentials.mjs";

test("admin-only GitHub credential entry preserves other secrets and never returns the token", async (t) => {
  const f = fixture(t),
    githubSecretFile = path.join(f.root, "secrets.json");
  const key = "QQ_GITHUB_TEST_SAVE";
  f.runtime.agent("agent-0").github.tokenEnv = key;
  const secret = "github_" + "pat_" + "s".repeat(70);
  fs.writeFileSync(
    githubSecretFile,
    JSON.stringify({ QQ_ONEBOT_FIXTURE: "keep-this-value" }),
    { mode: 0o600 },
  );
  const token = randomBytes(32).toString("hex"),
    server = createServer({ runtime: f.runtime, token, githubSecretFile });
  const port = await server.listen();
  t.after(async () => {
    await server.close();
    delete process.env[key];
  });
  const request = (auth, value = secret) =>
    fetch(`http://127.0.0.1:${port}/api/github/credential`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(auth ? { "x-admin-token": token } : {}),
      },
      body: JSON.stringify({ agentId: "agent-0", token: value }),
    });
  assert.equal((await request(false)).status, 401);
  assert.equal(process.env[key], undefined);
  const res = await request(true);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { configured: true });
  const values = JSON.parse(fs.readFileSync(githubSecretFile, "utf8"));
  assert.equal(values.QQ_ONEBOT_FIXTURE, "keep-this-value");
  assert.equal(values[key], secret);
  assert.equal(fs.statSync(githubSecretFile).mode & 0o777, 0o600);
  delete process.env[key];
  loadGithubCredentials(githubSecretFile);
  assert.equal(process.env[key], secret);
  const bad = await request(true, "not-a-fine-grained-token");
  assert.equal(bad.status, 400);
  assert.ok(!(await bad.text()).includes(secret));
  assert.equal(JSON.stringify(f.runtime.config).includes(secret), false);
});
