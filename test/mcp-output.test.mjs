import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { createHash } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "../src/server.mjs";
import { deriveRelayToken } from "../src/core/relay-auth.mjs";
import { config, context, fixture as runtimeFixture, raw } from "./helpers.mjs";
import { ReceiptStdioTransport } from "../src/mcp-output.mjs";
const tick = () => new Promise((resolve) => setImmediate(resolve));
const digest = (text) => createHash("sha256").update(text).digest("hex");
const message = (id, text) => ({
  jsonrpc: "2.0",
  id,
  result: { content: [{ type: "text", text }] },
});
function fixture(acknowledge = async () => {}) {
  const writes = [];
  const output = new Writable({
    write(chunk, encoding, done) {
      writes.push({ text: chunk.toString(), done });
    },
  });
  const transport = new ReceiptStdioTransport(
    acknowledge,
    new PassThrough(),
    output,
  );
  return { transport, writes };
}

test("stdio receipt waits for actual write callback and hides metadata", async () => {
  const acks = [];
  const { transport, writes } = fixture(async (...args) => acks.push(args));
  const text = JSON.stringify({ preparation: { token: "review-token" } });
  transport.stage(1, "context", "private-receipt", digest(text));
  const sending = transport.send(message(1, text));
  let next = false;
  const waiting = transport.beforeCall("context").then(() => {
    next = true;
  });
  await tick();
  assert.equal(acks.length, 0);
  assert.equal(next, false);
  assert.ok(!writes[0].text.includes("private-receipt"));
  writes[0].done();
  await Promise.all([sending, waiting]);
  assert.equal(acks.length, 1);
  assert.equal(acks[0][1].requestId, "1");
  assert.equal(acks[0][1].digest, digest(text));
  await transport.close();
});

test("stdio failed write cannot acknowledge input", async () => {
  const acks = [];
  const { transport, writes } = fixture(async (...args) => acks.push(args));
  transport.stage(1, "context", "receipt", digest("{}"));
  const sending = transport.send(message(1, "{}"));
  const failed = assert.rejects(sending, /EPIPE/);
  writes[0].done(Error("EPIPE"));
  await failed;
  await tick();
  assert.equal(acks.length, 0);
  await transport.close();
});

for (const mode of ["changed", "oversized"]) {
  test(`stdio ${mode} result emits safe tokenless output without acknowledgement`, async () => {
    const acks = [];
    const { transport, writes } = fixture(async (...args) => acks.push(args));
    const expected = JSON.stringify({
      token: "grant",
      text: mode === "oversized" ? "字".repeat(30000) : "original",
    });
    transport.stage(1, "context", "receipt", digest(expected));
    const sending = transport.send(
      message(
        1,
        mode === "changed" ? expected.replace("original", "changed") : expected,
      ),
    );
    assert.ok(!writes[0].text.includes("grant"));
    assert.ok(writes[0].text.includes("TOOL_OUTPUT_INCOMPLETE"));
    writes[0].done();
    await sending;
    assert.equal(acks.length, 0);
    await transport.close();
  });
}

test("parallel output acknowledgements retain every same-context barrier", async () => {
  const releases = new Map();
  const { transport, writes } = fixture(
    (context, body) =>
      new Promise((resolve) => releases.set(body.receipt, resolve)),
  );
  transport.stage(1, "context", "a", digest("{}"));
  transport.stage(2, "context", "b", digest("{}"));
  const first = transport.send(message(1, "{}"));
  writes[0].done();
  const second = transport.send(message(2, "{}"));
  writes[1].done();
  await tick();
  releases.get("b")();
  await second;
  let unblocked = false;
  const wait = transport.beforeCall("context").then(() => {
    unblocked = true;
  });
  await transport.beforeCall("unrelated");
  await tick();
  assert.equal(unblocked, false);
  releases.get("a")();
  await Promise.all([first, wait]);
  assert.equal(unblocked, true);
  await transport.close();
});

test("ACK failure releases waiting tools without replaying output", async () => {
  const { transport, writes } = fixture(async () => {
    throw Error("ACK_FAILED");
  });
  transport.stage(1, "context", "receipt", digest("{}"));
  const sending = transport.send(message(1, "{}"));
  const rejectedSend = assert.rejects(sending, /ACK_FAILED/);
  const waiting = transport.beforeCall("context");
  writes[0].done();
  await Promise.all([rejectedSend, waiting]);
  assert.equal(writes.length, 1);
  assert.equal(transport.pending.size, 0);
  await transport.close();
});

test("cancelled MCP request releases its barrier when the SDK suppresses the response", async () => {
  const controller = new AbortController();
  const { transport, writes } = fixture();
  transport.stage(1, "context", "receipt", digest("{}"), controller.signal);
  const waiting = transport.beforeCall("context");
  controller.abort();
  await waiting;
  await transport.beforeCall("context");
  assert.equal(transport.pending.size, 0);
  assert.equal(writes.length, 0);
  await transport.close();
});

for (const writeError of [undefined, Error("EPIPE")]) {
  test(`closing stdio invalidates a receipt before a late ${writeError ? "failed" : "successful"} write callback`, async () => {
    const acks = [];
    const { transport, writes } = fixture(async (...args) => acks.push(args));
    transport.stage(1, "context", "receipt", digest("{}"));
    const sending = transport.send(message(1, "{}"));
    const waiting = transport.beforeCall("context");
    await transport.close();
    await waiting;
    writes[0].done(writeError);
    await sending;
    await tick();
    assert.equal(acks.length, 0);
    assert.equal(transport.pending.size, 0);
  });
}

test("cancelling an MCP request aborts an in-flight acknowledgement", async () => {
  const controller = new AbortController();
  let acknowledgement;
  const { transport, writes } = fixture(
    (_context, _body, signal) =>
      new Promise((_resolve, reject) => {
        acknowledgement = signal;
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
  );
  transport.stage(1, "context", "receipt", digest("{}"), controller.signal);
  const sending = transport.send(message(1, "{}"));
  const waiting = transport.beforeCall("context");
  writes[0].done();
  await tick();
  assert.equal(acknowledgement.aborted, false);
  controller.abort();
  await Promise.all([sending, waiting]);
  assert.equal(acknowledgement.aborted, true);
  await transport.beforeCall("context");
  await transport.close();
});

for (const mode of ["revise", "partial", "unknown"]) {
  test(`stdio output mismatch preserves ${mode} facts from the trusted HTTP response`, async () => {
    const acks = [];
    const { transport, writes } = fixture(async (...args) => acks.push(args));
    const facts =
      mode === "revise"
        ? {
            revisionApplied: true,
            actionResult: "not_sent",
            attemptedThisCall: false,
            receipts: [],
          }
        : {
            status: "stopped",
            actionResult: mode === "partial" ? "partially_sent" : "unknown",
            attemptedThisCall: true,
            receipts: [
              { status: "sent", requestId: "prefix", messageId: "message-1" },
            ],
            doNotReplay: true,
          };
    const draft = { id: "draft-1", version: 2 };
    const text = JSON.stringify({
      ...facts,
      draft,
      preparation: {
        state: "ready",
        token: "unconfirmed-token",
        items: [{ id: "input", body: "private review body" }],
      },
    });
    transport.stage(
      1,
      "context",
      "receipt",
      digest(text),
      undefined,
      message(1, text).result,
    );
    const sending = transport.send(
      message(1, text.replace("private review body", "changed text")),
    );
    const written = JSON.parse(writes[0].text);
    assert.deepEqual(JSON.parse(written.result.content[0].text), {
      ...facts,
      draft,
      preparation: { state: "needs_input", reason: "TOOL_OUTPUT_INCOMPLETE" },
    });
    writes[0].done();
    await sending;
    assert.deepEqual(acks, []);
    await transport.close();
  });
}

test("old epoch ACK rejects after stdout, while the recovery call reaches its current input gate", async (t) => {
  const cfg = config(1);
  Object.assign(cfg.agents[0].wake, {
    mentions: false,
    names: false,
    participation: 0,
  });
  const f = runtimeFixture(t, { cfg });
  await f.runtime.ingest("qq-0", raw(1));
  const opening = f.store
    .bind("agent-0")
    .db.prepare("SELECT id, seq FROM events WHERE agent_id=? AND message_id=?")
    .get("agent-0", "1");
  const ctx = context(f.runtime);
  ctx.requiresInputSubmission = true;
  ctx.backendInputEpoch = ctx.inputEpoch;

  const key = "synthetic-probe-admin-key";
  const app = createServer({ runtime: f.runtime, token: key });
  const port = await app.listen();
  const post = (path, body, extra = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agent-capability": ctx.token,
        "x-agent-relay-token": deriveRelayToken(key),
        ...extra,
      },
      body: JSON.stringify(body),
    });
  const stdin = new PassThrough();
  const frames = [];
  const frameWaiters = new Map();
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      const message = JSON.parse(chunk.toString());
      frames.push(message);
      frameWaiters.get(message.id)?.(message);
      callback();
    },
  });
  const firstAck = Promise.withResolvers();
  const releaseAck = Promise.withResolvers();
  const ackResult = Promise.withResolvers();
  const secondCall = Promise.withResolvers();
  const transport = new ReceiptStdioTransport(
    async (_context, ack) => {
      if (ack.requestId === "101") {
        firstAck.resolve();
        await releaseAck.promise;
      }
      const response = await post("/agent/output-ack", ack);
      const result = await response.json();
      if (ack.requestId === "101") ackResult.resolve(result.accepted);
      if (!response.ok || !result.accepted)
        throw Error("TOOL_OUTPUT_INCOMPLETE");
    },
    stdin,
    stdout,
  );
  const sdk = new Server(
    { name: "fixture", version: "1" },
    { capabilities: { tools: {} } },
  );
  const sdkErrors = [];
  sdk.onerror = (error) => sdkErrors.push(error.message);
  t.after(async () => {
    releaseAck.resolve();
    await sdk.close();
    await app.close();
  });

  sdk.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    try {
      if (extra.requestId === 102) secondCall.resolve();
      await transport.beforeCall(ctx.token);
      const response = await post("/agent/tools", req.params, {
        "x-agent-output-protocol": "stdio-v1",
        "x-agent-output-request": JSON.stringify(extra.requestId),
      });
      const result = await response.json();
      const receipt = response.headers.get("x-agent-output-receipt");
      if (receipt)
        transport.stage(
          extra.requestId,
          ctx.token,
          receipt,
          response.headers.get("x-agent-output-digest"),
          extra.signal,
          result,
        );
      return result;
    } catch (error) {
      return {
        isError: true,
        content: [
          { type: "text", text: JSON.stringify({ code: error.message }) },
        ],
      };
    }
  });
  await sdk.connect(transport);
  const invoke = (id, name, args = {}) =>
    new Promise((resolve) => {
      frameWaiters.set(id, resolve);
      stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name, arguments: args },
        }) + "\n",
      );
    });
  const payload = (frame) => JSON.parse(frame.result.content[0].text);
  const first = payload(await invoke(101, "conversation_read"));
  assert.equal(first.items[0].id, opening.id);
  await firstAck.promise;
  f.runtime.contexts.resetInputEvidence(ctx);
  ctx.backendInputEpoch = ctx.inputEpoch;
  const next = invoke(102, "qq_mark_read", { throughSeq: opening.seq });
  await secondCall.promise;
  assert.equal(frames.filter(({ id }) => id === 101).length, 1);
  assert.equal(
    frames.some(({ id }) => id === 102),
    false,
  );
  releaseAck.resolve();
  assert.equal(await ackResult.promise, false);
  const blocked = payload(await next);
  assert.equal(
    payload(await invoke(103, "conversation_read")).items[0].id,
    opening.id,
  );
  assert.equal(
    payload(await invoke(104, "qq_mark_read", { throughSeq: opening.seq }))
      .readThroughSeq,
    opening.seq,
  );
  await tick();
  assert.equal(
    frames.filter(({ id }) => id === 101).length,
    1,
    "the SDK must not emit a second result or error frame for an already written result",
  );
  assert.match(sdkErrors.join("\n"), /TOOL_OUTPUT_INCOMPLETE/);
  assert.equal(blocked.code, "UNSEEN_WATERMARK");
});
