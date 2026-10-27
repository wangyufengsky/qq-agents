import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fixture } from "./helpers.mjs";
import { createServer } from "../src/server.mjs";
import { Diagnostics, classifyError } from "../src/core/diagnostics.mjs";

test("a disk failure returns a classified server error with a safe correlation ID", async (t) => {
  const f = fixture(t);
  const app = createServer({
    runtime: f.runtime,
    token: "synthetic-admin",
    allowLive: true,
  });
  const port = await app.listen();
  t.after(() => app.close());
  const next = structuredClone(f.runtime.config);
  next.agents[0].name = "changed";
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (source, target) => {
    if (target === f.configStore.file)
      throw Object.assign(
        Error(
          "Bearer SYNTHETIC_PRIVATE_CREDENTIAL_123 /private/synthetic/path",
        ),
        { code: "ENOSPC" },
      );
    return rename(source, target);
  });
  const response = await fetch(`http://127.0.0.1:${port}/api/config`, {
    method: "PUT",
    headers: {
      "x-admin-token": "synthetic-admin",
      "content-type": "application/json",
    },
    body: JSON.stringify({ config: next, revision: f.configStore.revision }),
  });
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.error, "CONFIG_SAVE_FAILED");
  assert.match(body.requestId, /^[a-f0-9-]{36}$/);
  assert.equal(response.headers.get("x-request-id"), body.requestId);
  assert.doesNotMatch(
    JSON.stringify(body),
    /SYNTHETIC_PRIVATE|private\/synthetic/,
  );
});

test("diagnostics omit untrusted error text and identifiers, aggregate repeats and tolerate a failed sink", () => {
  const lines = [],
    secret = "SYNTHETIC_SENSITIVE_VALUE_123456";
  const diagnostics = new Diagnostics({
    write: (line) => lines.push(line),
    clock: () => 100000,
  });
  const error = Object.assign(Error(secret), {
    cause: Error("private path " + secret),
    stack: secret,
  });
  for (let i = 0; i < 200; i++)
    diagnostics.report(error, {
      component: "http",
      agentId: secret,
      conversation: "private:" + secret,
      requestId: secret,
    });
  assert.equal(lines.length, 1);
  assert.equal(diagnostics.snapshot()[0].count, 200);
  assert.doesNotMatch(
    JSON.stringify([lines, diagnostics.snapshot()]),
    new RegExp(secret),
  );
  assert.equal(classifyError(error).status, 500);
  assert.equal(classifyError(Error("INVALID_ACTION")).status, 400);
  assert.equal(classifyError(Error("INVALID_BUDGET")).status, 400);
  assert.equal(classifyError(Error("CONFIG_CONFLICT")).status, 409);
  assert.equal(classifyError(Error("BODY_TOO_LARGE")).status, 413);
  assert.equal(classifyError(Error("SEND_RATE_LIMIT")).status, 429);
  assert.equal(classifyError(Error("RUNTIME_CLOSING")).status, 503);
  assert.doesNotThrow(() =>
    new Diagnostics({
      write() {
        throw Error(secret);
      },
    }).report(error),
  );
});

test("owner command failures retain safe diagnostics without exposing command text", async (t) => {
  const f = fixture(t);
  await f.runtime.operations.command(
    f.runtime.agent("agent-0"),
    { body: "/ops L1", conversation: "private:30000" },
    { id: "synthetic-ops" },
  );
  await f.runtime.scheduler.command(
    f.runtime.agent("agent-0"),
    { body: "/remind del 999", conversation: "private:30000" },
    { id: "synthetic-reminder" },
  );
  const recent = f.runtime.status().recentErrors;
  assert.equal(
    recent.some(
      (r) => r.component === "operations" && r.code === "OWNER_OPERATIONS_ONLY",
    ),
    true,
  );
  assert.equal(
    recent.some(
      (r) => r.component === "scheduler" && r.code === "TASK_NOT_FOUND",
    ),
    true,
  );
  assert.doesNotMatch(JSON.stringify(recent), /30000|\/ops|\/remind/);
});
