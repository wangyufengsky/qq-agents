// @ts-check
import { createHash } from "node:crypto";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const MAX_FRAME_BYTES = 65536;

/** @param {any} result */
function resultText(result) {
  return result?.content?.[0]?.type === "text"
    ? result.content[0].text
    : undefined;
}

/** @param {unknown} text */
function textDigest(text) {
  return typeof text === "string"
    ? createHash("sha256").update(text).digest("hex")
    : undefined;
}

/** @param {any} result @param {string} digest */
function preparationFallback(result, digest) {
  const text = resultText(result);
  if (textDigest(text) !== digest) return;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return;
  }
  if (!value?.preparation || typeof value.actionResult !== "string") return;
  const {
    status,
    actionResult,
    attemptedThisCall,
    draft,
    revisionApplied,
    receipts,
    doNotReplay,
  } = value;
  return {
    ...(result.isError === true ? { isError: true } : {}),
    content: [
      {
        type: "text",
        text: JSON.stringify({
          status,
          actionResult,
          attemptedThisCall,
          draft,
          revisionApplied,
          receipts,
          doNotReplay,
          preparation: {
            state: "needs_input",
            reason: "TOOL_OUTPUT_INCOMPLETE",
          },
        }),
      },
    ],
  };
}

/** @param {string|number|undefined} id @param {any} fallback */
function incompleteFrame(id, fallback) {
  const frame = (/** @type {any} */ result) =>
    JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n";
  if (fallback) {
    const json = frame(fallback);
    if (Buffer.byteLength(json) <= MAX_FRAME_BYTES) return json;
  }
  return frame({
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({ code: "TOOL_OUTPUT_INCOMPLETE" }),
      },
    ],
  });
}

/** The SDK's drain event is not a write acknowledgement. Keep receipts private
 * until the exact final JSON-RPC result has reached the stdout write callback. */
export class ReceiptStdioTransport extends StdioServerTransport {
  pending = new Map();
  barriers = new Map();
  closed = false;
  writing = 0;
  /** @param {(context: string, body: any, signal: AbortSignal) => Promise<void>} acknowledge */
  constructor(acknowledge, stdin = process.stdin, stdout = process.stdout) {
    super(stdin, stdout);
    this.output = stdout;
    this.acknowledge = acknowledge;
    this.outputError = (/** @type {Error} */ error) => {
      if (!this.closed) this.onerror?.(error);
    };
    this.output.on("error", this.outputError);
  }
  async close() {
    this.closed = true;
    for (const pending of this.pending.values()) pending.cancel();
    if (!this.writing) this.output.off("error", this.outputError);
    await super.close();
  }
  /** @param {string} context */
  async beforeCall(context) {
    // The bridge revalidates each new call independently of an older ACK.
    await Promise.allSettled(this.barriers.get(context) ?? []);
  }
  /** @param {string | number} id @param {string} context @param {string} receipt @param {string} digest @param {AbortSignal} [signal] @param {any} [result] */
  stage(id, context, receipt, digest, signal, result) {
    if (this.closed || signal?.aborted) return;
    this.pending.get(id)?.cancel();
    const controller = new AbortController();
    /** @type {() => void} */
    let resolve;
    /** @type {(error: unknown) => void} */
    let reject;
    const barrier = new Promise((yes, no) => {
      resolve = () => yes(undefined);
      reject = no;
    });
    barrier.catch(() => {});
    const barriers = this.barriers.get(context) ?? new Set();
    barriers.add(barrier);
    this.barriers.set(context, barriers);
    const finish = (/** @type {unknown} */ error) => {
      if (this.pending.get(id) === pending) this.pending.delete(id);
      signal?.removeEventListener("abort", cancel);
      barriers.delete(barrier);
      if (!barriers.size && this.barriers.get(context) === barriers)
        this.barriers.delete(context);
      if (error) reject(error);
      else resolve();
    };
    const cancel = () => {
      controller.abort();
      finish(Error("ABORTED"));
    };
    const fallback = preparationFallback(result, digest);
    const pending = {
      context,
      receipt,
      digest,
      controller,
      finish,
      cancel,
      fallback,
    };
    this.pending.set(id, pending);
    signal?.addEventListener("abort", cancel, { once: true });
  }
  /** @param {import("@modelcontextprotocol/sdk/types.js").JSONRPCMessage} message */
  async send(message) {
    if (this.closed) throw Error("ABORTED");
    const id = "id" in message ? message.id : undefined;
    const pending = this.pending.get(id);
    this.writing++;
    try {
      let json = JSON.stringify(message) + "\n";
      const digest = pending && textDigest(resultText(JSON.parse(json).result));
      const incomplete =
        pending &&
        (Buffer.byteLength(json) > MAX_FRAME_BYTES ||
          digest !== pending.digest);
      if (incomplete) json = incompleteFrame(id, pending.fallback);
      await new Promise((resolve, reject) => {
        const fail = (/** @type {Error} */ error) => {
          this.output.off("error", fail);
          reject(error);
        };
        this.output.once("error", fail);
        try {
          this.output.write(json, (error) => {
            if (error) fail(error);
            else {
              this.output.off("error", fail);
              resolve(undefined);
            }
          });
        } catch (error) {
          this.output.off("error", fail);
          reject(error);
        }
      });
      if (!pending || pending.controller.signal.aborted) return;
      if (incomplete) {
        pending.finish(Error("TOOL_OUTPUT_INCOMPLETE"));
        return;
      }
      await this.acknowledge(
        pending.context,
        {
          receipt: pending.receipt,
          requestId: JSON.stringify(id),
          digest,
        },
        pending.controller.signal,
      );
      pending.finish(undefined);
    } catch (error) {
      pending?.finish(error);
      if (!pending?.controller.signal.aborted) throw error;
    } finally {
      this.writing--;
      if (this.closed && !this.writing) {
        // Writable can emit its error after invoking a failed write callback.
        setImmediate(() => this.output.off("error", this.outputError));
      }
    }
  }
}
