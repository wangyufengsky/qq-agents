import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { config, fixture } from "./helpers.mjs";
import { OneBot } from "../src/transport/onebot.mjs";
import { createServer } from "../src/server.mjs";
import { Diagnostics, classifyError } from "../src/core/diagnostics.mjs";

test("image download diagnostics preserve safe specific causes instead of INTERNAL_ERROR", () => {
  for (const code of [
    "IMAGE_DOWNLOAD_HTTP_ERROR",
    "IMAGE_DOWNLOAD_FAILED",
    "IMAGE_DOWNLOAD_TIMEOUT",
    "IMAGE_URL_DENIED",
    "IMAGE_REDIRECT_INVALID",
    "IMAGE_REDIRECT_LIMIT",
  ])
    assert.equal(classifyError(Error(code)).code, code);
});

test("native image diagnostics retain a safe URL cause without leaking provider text", () => {
  const d = new Diagnostics({ write: () => {} });
  d.report(
    Error("IMAGE_DOWNLOAD_FAILED", {
      cause: Error("IMAGE_DOWNLOAD_HTTP_ERROR"),
    }),
  );
  assert.equal(d.snapshot()[0].cause, "IMAGE_DOWNLOAD_HTTP_ERROR");
  d.report(
    Error("IMAGE_DOWNLOAD_FAILED", {
      cause: Error("https://example.com/?rkey=PRIVATE_VALUE"),
    }),
  );
  assert.equal(d.snapshot()[0].cause, undefined);
  assert.doesNotMatch(
    JSON.stringify(d.snapshot()),
    /PRIVATE_VALUE|example.com/,
  );
});

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
    false,
  );
  assert.equal(
    recent.some(
      (r) => r.component === "scheduler" && r.code === "TASK_NOT_FOUND",
    ),
    true,
  );
  assert.doesNotMatch(JSON.stringify(recent), /30000|\/ops|\/remind/);
});

test("an unreachable OneBot gateway is a retryable outage, while timeouts and cancellations keep their names", async () => {
  const refused = () =>
    Promise.reject(
      new TypeError("fetch failed", {
        cause: Object.assign(Error("connect ECONNREFUSED 127.0.0.1:3000"), {
          code: "ECONNREFUSED",
        }),
      }),
    );
  const bot = new OneBot(config(1).connections[0], { fetchImpl: refused });
  const error = await bot.call("get_login_info").catch((e) => e);
  assert.equal(error.message, "ONEBOT_UNREACHABLE");
  assert.equal(error.cause.cause.code, "ECONNREFUSED");
  assert.deepEqual(classifyError(error), {
    code: "ONEBOT_UNREACHABLE",
    status: 503,
    retryable: true,
  });
  // Callers map TimeoutError (image downloads) and treat aborts as cancellation.
  const hang = (_url, { signal }) =>
    new Promise((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason)),
    );
  const slow = new OneBot(config(1).connections[0], { fetchImpl: hang });
  assert.equal(
    (await slow.call("get_status", {}, 5).catch((e) => e)).name,
    "TimeoutError",
  );
  const stop = new AbortController();
  const cancelled = slow.call("get_status", {}, 10000, { signal: stop.signal });
  stop.abort();
  assert.equal((await cancelled.catch((e) => e)).name, "AbortError");
});

test("admin connect against a down gateway answers 503 ONEBOT_UNREACHABLE instead of INTERNAL_ERROR", async (t) => {
  const f = fixture(t);
  f.runtime.transports.get("qq-0")?.close?.();
  f.runtime.transports.delete("qq-0");
  f.runtime.transportFactory = (c) =>
    new OneBot(c, {
      fetchImpl: () => Promise.reject(new TypeError("fetch failed")),
    });
  const app = createServer({
    runtime: f.runtime,
    token: "synthetic-admin",
    allowLive: true,
  });
  const port = await app.listen();
  t.after(() => app.close());
  const post = (route, body) =>
    fetch(`http://127.0.0.1:${port}${route}`, {
      method: "POST",
      headers: {
        "x-admin-token": "synthetic-admin",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  const connect = await post("/api/connection", {
    id: "qq-0",
    action: "connect",
  });
  assert.equal(connect.status, 503);
  const body = await connect.json();
  assert.equal(body.error, "ONEBOT_UNREACHABLE");
  assert.equal(body.retryable, true);
  // A malformed maintenance request is the caller's mistake, not a crash.
  const drain = await post("/api/maintenance", { unexpected: true });
  assert.equal(drain.status, 400);
  assert.equal((await drain.json()).error, "INVALID_REQUEST");
  // A timeline read with neither source nor anchor is rejected up front.
  const timeline = await fetch(
    `http://127.0.0.1:${port}/api/memory/conversation?agentId=agent-0`,
    { headers: { "x-admin-token": "synthetic-admin" } },
  );
  assert.equal(timeline.status, 400);
  assert.equal((await timeline.json()).error, "INVALID_MEMORY_SCOPE");
});

test("backend error codes the OpenAI adapter throws leave the process as themselves", () => {
  for (const code of [
    "OPENAI_API_KEY_ENV_MISSING",
    "OPENAI_UNREACHABLE",
    "OPENAI_HTTP_ERROR",
    "OPENAI_MALFORMED_RESPONSE",
    "OPENAI_AUTH_FAILED",
    "OPENAI_SESSION_INVALID",
    "OPENAI_SESSION_MISSING",
    "OPENAI_MODEL_REQUIRED",
    "OPENAI_RECOVERY_STATE_UNVERIFIED",
  ])
    assert.equal(classifyError(Error(code)).code, code);
  assert.equal(classifyError(Error("OPENAI_UNREACHABLE")).status, 503);
});
