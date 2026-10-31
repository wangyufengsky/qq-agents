import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { CodexBackend } from "../src/backends/codex.mjs";
import { DshBackend } from "../src/backends/dsh.mjs";
import { CodexRpc } from "../vendor/local-bridge/codex-rpc.mjs";
import { sessionSignature } from "../src/backends/session-contract.mjs";
import { config, temp } from "./helpers.mjs";

test("Codex health probes fresh account and models instead of reporting a cached catalog", async (t) => {
  const cfg = config(1),
    rpc = new EventEmitter();
  let loggedIn = true,
    reads = 0;
  rpc.start = async () => {};
  rpc.close = () => {};
  rpc.request = async (method) => {
    if (method === "account/read") {
      reads++;
      return { account: loggedIn ? { type: "fixture" } : null };
    }
    if (method === "model/list") return { data: [{ model: "fixture" }] };
    throw Error("unexpected method");
  };
  const backend = new CodexBackend(
    { ...cfg.backends[0], model: "fixture" },
    cfg.agents[0],
    { root: temp(t), rpc },
  );
  t.after(() => backend.close());
  assert.equal((await backend.health()).models.length, 1);
  loggedIn = false;
  await assert.rejects(backend.health(), /CODEX_DEDICATED_LOGIN_REQUIRED/);
  assert(reads >= 3);
});
test("changing automatic recovery does not discard a valid session contract", () => {
  const cfg = config(1).backends[0];
  const initial = sessionSignature({ config: cfg });
  const next = structuredClone(cfg);
  next.recovery.autoReconnect = true;
  assert.equal(sessionSignature({ config: next }), initial);
  next.recovery.dshInstance = "relay:web";
  assert.equal(sessionSignature({ config: next }), initial);
  cfg.type = "dsh";
  next.type = "dsh";
  assert.notEqual(
    sessionSignature({ config: next }),
    sessionSignature({ config: cfg }),
  );
});
test("late exit and output from an old Codex child cannot disconnect its replacement", async () => {
  const children = [];
  const rpc = new CodexRpc({
    timeoutMs: 500,
    spawnProcess: () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      child.stdin = new Writable({
        write(chunk, encoding, done) {
          const message = JSON.parse(String(chunk));
          if (message.id !== undefined)
            queueMicrotask(() =>
              child.stdout.write(
                JSON.stringify({ id: message.id, result: { ok: true } }) + "\n",
              ),
            );
          done();
        },
      });
      children.push(child);
      return child;
    },
  });
  await rpc.start();
  const old = children[0];
  rpc.close();
  await rpc.start();
  const current = children[1];
  old.emit("exit");
  old.emit("error", Error("stale error"));
  assert.equal(rpc.child, current);
  assert.deepEqual(await rpc.request("fixture/read"), { ok: true });
  rpc.close();
});

test("DSH health reads grouped provider catalog and verifies configured model availability", async (t) => {
  const cfg = config(1),
    client = {
      callUnary: async () => ({
        result: {
          ok: true,
          value: {
            groups: [{ id: "deepseek", models: [{ id: "fish-model" }] }],
            failures: [],
          },
        },
      }),
    };
  const backend = new DshBackend(
    { ...cfg.backends[0], provider: "deepseek", model: "fish-model" },
    cfg.agents[0],
    { root: temp(t), client },
  );
  t.after(() => backend.close());
  assert.equal((await backend.health()).models.length, 1);
  backend.config.model = "missing";
  await assert.rejects(backend.health(), /BACKEND_MODEL_UNAVAILABLE/);
});

test("Codex RPC retains protocol codes needed to distinguish temporary resume rejection", async () => {
  const rpc = new CodexRpc({
    spawnProcess: () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      child.stdin = new Writable({
        write(chunk, encoding, done) {
          const request = JSON.parse(String(chunk));
          if (request.id !== undefined)
            queueMicrotask(() =>
              child.stdout.write(
                JSON.stringify({
                  id: request.id,
                  ...(request.method === "thread/resume"
                    ? {
                        error: {
                          code: -32600,
                          message: `thread ${request.params.threadId} is closing; retry thread/resume after the thread is closed`,
                        },
                      }
                    : { result: {} }),
                }) + "\n",
              ),
            );
          done();
        },
      });
      return child;
    },
  });
  try {
    await rpc.start();
    await assert.rejects(
      rpc.request("thread/resume", { threadId: "synthetic-thread" }),
      (error) => error.rpcRejected === true && error.rpcCode === -32600,
    );
  } finally {
    rpc.close();
  }
});
