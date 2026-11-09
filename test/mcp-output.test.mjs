import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { createHash } from "node:crypto";
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

test("ACK failure rejects waiting tools without replaying output", async () => {
  const { transport, writes } = fixture(async () => {
    throw Error("ACK_FAILED");
  });
  transport.stage(1, "context", "receipt", digest("{}"));
  const sending = transport.send(message(1, "{}"));
  const rejectedSend = assert.rejects(sending, /ACK_FAILED/);
  const rejectedWait = assert.rejects(
    transport.beforeCall("context"),
    /ACK_FAILED/,
  );
  writes[0].done();
  await Promise.all([rejectedSend, rejectedWait]);
  assert.equal(writes.length, 1);
  assert.equal(transport.pending.size, 0);
  await transport.close();
});

test("cancelled MCP request releases its barrier when the SDK suppresses the response", async () => {
  const controller = new AbortController();
  const { transport, writes } = fixture();
  transport.stage(1, "context", "receipt", digest("{}"), controller.signal);
  const waiting = assert.rejects(transport.beforeCall("context"), /ABORTED/);
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
    const waiting = assert.rejects(transport.beforeCall("context"), /ABORTED/);
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
  const waiting = assert.rejects(transport.beforeCall("context"), /ABORTED/);
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
