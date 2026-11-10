// @ts-check
import { finalizeMcpOutput, toolOutputText } from "./tool-output.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { AntigravityMedia } from "./antigravity-media.mjs";
import {
  antigravityFailure,
  antigravityDiagnostic,
  responseOccupancy,
} from "./antigravity.mjs";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const maxOutput = 16 * 1024 * 1024;
const dispatch = {
  name: "qq_turn_call",
  description:
    "Call a permitted logical bridge tool using the routing epoch from the current input. The epoch grants no authority.",
  inputSchema: {
    type: "object",
    properties: {
      epoch: { type: "string", pattern: "^[a-f0-9]{32}$" },
      name: { type: "string" },
      arguments: { type: "object" },
    },
    required: ["epoch", "name", "arguments"],
    additionalProperties: false,
  },
};

/** One trusted CLI owns one native conversation. Tool authority belongs to a
 * separate, short-lived turn; a delayed MCP call carries its original epoch. */
export class AntigravityStreamWorker {
  /** @param {import("./antigravity.mjs").AntigravityBackend} owner
   * @param {ReturnType<import("./antigravity.mjs").AntigravityBackend["prepare"]>} details
   * @param {import("./session-contract.mjs").RunParams} params */
  constructor(owner, details, params) {
    this.owner = owner;
    this.details = details;
    this.signature = details.signature;
    this.effort = owner.config.effort;
    this.instructions = params.instructions;
    this.nativeId = "";
    this.token = randomBytes(32).toString("hex");
    this.mediaRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "qq-agy-worker-media-"),
    );
    fs.chmodSync(this.mediaRoot, 0o700);
    /** @type {import("node:child_process").ChildProcess | null} */
    this.child = null;
    /** @type {any} */
    this.turn = null;
    this.buffer = "";
    this.diagnostic = "";
    this.lastStep = -1;
    this.closed = false;
    this.used = false;
    this.inputSubmitted = false;
    this.lastUsed = 0;
    /** @type {NodeJS.Timeout | undefined} */
    this.idleTimer = undefined;
    /** @type {Promise<void> | undefined} */
    this.closePromise = undefined;
    this.server = http.createServer((req, res) => {
      // Capture ownership before reading a body or awaiting any tool.
      const turn = this.turn;
      void this.request(turn, req, res);
    });
  }
  get available() {
    return (
      !this.closed &&
      this.child?.exitCode === null &&
      this.child?.signalCode === null
    );
  }
  /** @param {import("./session-contract.mjs").RunParams} params @param {string} signature */
  matches(params, signature) {
    return (
      this.available &&
      this.signature === signature &&
      this.effort === this.owner.config.effort &&
      params.session?.id === this.nativeId &&
      (params.instructions === undefined ||
        params.instructions === this.instructions)
    );
  }
  /** @param {any} turn @param {string} phase */
  timing(turn, phase) {
    turn.params.onTiming?.({
      phase,
      elapsedMs: performance.now() - turn.start,
      processReused: turn.reused,
    });
  }
  /** @param {any} turn */
  live(turn) {
    return (
      turn &&
      this.turn === turn &&
      turn.live &&
      !this.closed &&
      !turn.params.signal.aborted
    );
  }
  /** Accepted calls keep their original authority while terminal settlement waits.
   * @param {any} turn */
  active(turn) {
    return (
      this.turn === turn &&
      !turn.settled &&
      !turn.failed &&
      !turn.params.signal.aborted
    );
  }
  /** @param {any} turn @param {Record<string, unknown>} event */
  report(turn, event) {
    if (this.turn !== turn || turn.settled) return;
    antigravityDiagnostic(turn.params, turn.start, {
      phase: turn.terminal ? "settling" : "running",
      trustedTerminal: Boolean(turn.terminal) && !turn.failed,
      ...event,
    });
  }
  /** Resource health cannot overwrite an already validated terminal.
   * @param {Record<string, unknown>} event */
  resourceFailure(event) {
    const turn = this.turn;
    if (turn && event.workerOutcome === "exit-warning")
      turn.resourceWarning = true;
    if (turn)
      this.report(turn, {
        ...event,
        ...(turn.resourceWarning ? { workerOutcome: "exit-warning" } : {}),
        wrapperError: this.diagnostic.includes("AGY_BACKGROUND_START_FAILED"),
      });
    this.closed = true;
    if (this.child) this.owner.stop(this.child, "SIGKILL");
    if (turn && !turn.settled && !turn.terminal) {
      this.fail(antigravityFailure(this.diagnostic));
    } else if (!turn || turn.settled) {
      void this.close().catch(() => {});
    }
  }
  /** @param {any} turn @param {http.IncomingMessage} req @param {http.ServerResponse} res */
  async request(turn, req, res) {
    const reply = (
      /** @type {number} */ status,
      /** @type {unknown} */ body,
    ) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (
      req.headers.origin ||
      req.headers.authorization !== `Bearer ${this.token}` ||
      this.closed
    )
      return reply(403, { error: "ANTIGRAVITY_TURN_INACTIVE" });
    if (req.method === "GET" && req.url === "/lease")
      return reply(200, { alive: true });
    if (!this.live(turn))
      return reply(403, { error: "ANTIGRAVITY_TURN_INACTIVE" });
    if (req.method === "POST" && req.url?.startsWith("/hook-denied")) {
      if (req.url !== `/hook-denied?epoch=${turn.epoch}`)
        return reply(403, { error: "ANTIGRAVITY_TURN_INACTIVE" });
      turn.hookDenied = true;
      return reply(200, {});
    }
    if (req.method === "GET" && req.url === "/catalog")
      return reply(200, {
        tools: [dispatch],
        turnTools: turn.params.tools,
        turnEpoch: turn.epoch,
        conversationId: this.nativeId,
        minimumStep: turn.minimumStep,
        images: turn.media.catalog(),
      });
    if (req.method !== "POST" || req.url !== "/call") return reply(404, {});
    /** @type {import("./session-contract.mjs").ToolSpec | undefined} */
    let spec;
    try {
      let body = "";
      for await (const part of req) {
        body += part;
        if (body.length > 1048576) return reply(413, {});
      }
      const value = JSON.parse(body),
        envelope = value.arguments;
      if (
        !this.live(turn) ||
        value.name !== dispatch.name ||
        !envelope ||
        envelope.epoch !== turn.epoch ||
        typeof envelope.name !== "string" ||
        !envelope.arguments ||
        typeof envelope.arguments !== "object" ||
        Array.isArray(envelope.arguments) ||
        Object.keys(envelope).some(
          (key) => !["epoch", "name", "arguments"].includes(key),
        )
      )
        return reply(403, { error: "ANTIGRAVITY_TURN_INACTIVE" });
      spec = turn.params.tools.find(
        (/** @type {any} */ tool) => tool.name === envelope.name,
      );
      if (!spec) return reply(403, { error: "ANTIGRAVITY_TURN_INACTIVE" });
      await turn.inputSubmission;
      const pending = Promise.resolve().then(async () => {
        if (!this.active(turn)) throw Error("ANTIGRAVITY_TURN_INACTIVE");
        const result = await turn.params.callTool(
          envelope.name,
          envelope.arguments,
        );
        if (!this.active(turn)) throw Error("ANTIGRAVITY_TURN_INACTIVE");
        return finalizeMcpOutput(turn.params, result, (value) =>
          turn.media.fromTool(value, turn.params.signal),
        );
      });
      turn.pending.add(pending);
      try {
        const { wire: content, receipt } = await pending;
        if (!this.live(turn))
          return reply(403, { error: "ANTIGRAVITY_TURN_INACTIVE" });
        res.once("finish", () => {
          if (this.live(turn))
            turn.params.commitToolOutput?.(receipt, toolOutputText(content));
        });
        reply(200, content);
      } finally {
        turn.pending.delete(pending);
      }
    } catch (error) {
      if (!this.live(turn))
        return reply(403, { error: "ANTIGRAVITY_TURN_INACTIVE" });
      const { wire: content, receipt } = await finalizeMcpOutput(
        turn.params,
        error,
        (value) => {
          if (spec && value.isError) {
            const failure = JSON.parse(value.content[0].text);
            if (failure.code === "INVALID_TOOL_ARGUMENTS")
              value.content[0].text = JSON.stringify({
                ...failure,
                tool: { name: spec.name, inputSchema: spec.inputSchema },
              });
          }
          return value;
        },
      );
      res.once("finish", () => {
        if (this.live(turn))
          turn.params.commitToolOutput?.(receipt, toolOutputText(content));
      });
      reply(200, content);
    }
  }
  /** @param {import("./session-contract.mjs").RunParams} params */
  async run(params) {
    if (this.closed) throw Error("ANTIGRAVITY_CLOSED");
    if (this.turn) throw Error("ANTIGRAVITY_CONVERSATION_BUSY");
    if (this.buffer.trim()) throw Error("ANTIGRAVITY_PROTOCOL_ERROR");
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.inputSubmitted = false;
    this.diagnostic = "";
    let resolveInput = () => {};
    let rejectInput = (/** @type {unknown} */ _error) => {};
    const inputSubmission = new Promise((resolve, reject) => {
      resolveInput = () => resolve(undefined);
      rejectInput = reject;
    });
    void inputSubmission.catch(() => {});
    const turn = {
      inputSubmission,
      params,
      start: performance.now(),
      epoch: randomBytes(16).toString("hex"),
      reused: this.used,
      live: true,
      initialized: Boolean(this.nativeId),
      seenInit: false,
      responseSeen: false,
      responseIndex: -1,
      minimumStep: this.lastStep,
      contextTokens: /** @type {number | null} */ (null),
      bytes: 0,
      terminal: null,
      settled: false,
      failed: false,
      resourceWarning: false,
      hookDenied: false,
      media: new AntigravityMedia(this.mediaRoot),
      pending: new Set(),
      inputSubmitted: false,
      resolve: () => {},
      reject: (/** @type {unknown} */ _error) => {},
    };
    const result = new Promise((resolve, reject) => {
      turn.resolve = () => resolve(undefined);
      turn.reject = reject;
    });
    // Startup can fail before the result is awaited; attach rejection ownership now.
    void result.catch(() => {});
    this.turn = turn;
    const abort = () => {
      this.report(turn, {
        origin: "finalization",
        backendOutcome: "cancelled",
      });
      turn.failed = true;
      turn.live = false;
      turn.reject(Error("ABORTED"));
      void this.close().catch(() => {});
    };
    params.signal.addEventListener("abort", abort, { once: true });
    try {
      if (params.signal.aborted) throw Error("ABORTED");
      if (!this.child) {
        await new Promise((resolve, reject) => {
          this.server.once("error", reject);
          this.server.listen(0, "127.0.0.1", () => {
            this.server.removeListener("error", reject);
            resolve(undefined);
          });
        });
        if (!this.live(turn)) throw Error("ABORTED");
        const endpoint = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (this.server.address()).port}`;
        const settings = this.owner.configure(
          params,
          this.details,
          turn.media,
          true,
          this.mediaRoot,
        );
        this.child = this.owner.spawnCli(
          params,
          this.details.workspace,
          settings,
          endpoint,
          this.token,
        );
        this.child.stdout?.setEncoding("utf8");
        this.child.stdout?.on("data", (chunk) => this.output(chunk));
        this.child.stderr?.on("data", (chunk) => {
          this.diagnostic = (this.diagnostic + chunk).slice(-65536);
        });
        this.child.once("error", () => {
          if (this.turn?.terminal)
            this.resourceFailure({
              origin: "process-exit",
              workerOutcome: "exit-warning",
            });
          else {
            if (this.turn)
              this.report(this.turn, {
                origin: "process-exit",
                trustedTerminal: false,
                workerOutcome: "exit-warning",
              });
            this.fail(Error("ANTIGRAVITY_NOT_FOUND"));
          }
        });
        this.child.once("close", (code, signal) =>
          this.resourceFailure({
            origin: "process-exit",
            exitCode: code,
            signal,
            workerOutcome: code === 0 && !signal ? "recycled" : "exit-warning",
          }),
        );
        this.child.stdin?.on("error", (error) =>
          this.resourceFailure({
            origin: "stdin",
            ioCode: /** @type {NodeJS.ErrnoException} */ (error).code,
            workerOutcome: "exit-warning",
          }),
        );
      }
      this.timing(turn, "prepared");
      if (!this.live(turn)) throw Error("ABORTED");
      if (turn.reused) this.timing(turn, "initialized");
      const content = `Bridge routing for this input: epoch=${turn.epoch}. For every bridge action call call_mcp_tool with ServerName="qq-agents", ToolName="qq_turn_call", Arguments={"epoch":"${turn.epoch}","name":logical tool name,"arguments":logical tool arguments}. This routing label grants no permission and is not user content.\n\n${params.prompt}`;
      await params.beforeInputSubmitted?.();
      if (!this.live(turn)) throw Error("ABORTED");
      turn.inputSubmitted = true;
      this.inputSubmitted = true;
      this.child.stdin?.write(
        JSON.stringify({
          event: "user",
          message: { content: content + (params.appendPrompt?.() || "") },
        }) + "\n",
        (error) => {
          if (error) return rejectInput(error);
          if (!this.active(turn)) return rejectInput(Error("ABORTED"));
          try {
            params.onInputSubmitted?.();
            this.timing(turn, "inputSubmitted");
            resolveInput();
          } catch (error) {
            rejectInput(error);
          }
        },
      );
      await inputSubmission;
      await result;
      this.used = true;
    } finally {
      turn.live = false;
      rejectInput(Error("ABORTED"));
      params.signal.removeEventListener("abort", abort);
      try {
        turn.media.close();
      } catch {
        // Finalization must release turn ownership even when Windows locks media.
        console.warn("Antigravity turn media cleanup failed");
      }
      // In-memory LRU order must survive wall-clock corrections.
      this.lastUsed = performance.now();
      if (this.turn === turn) this.turn = null;
      if (this.closed) {
        try {
          await this.close();
        } catch {
          console.warn("Antigravity worker cleanup failed");
        }
      }
      this.timing(turn, "complete");
    }
  }
  /** @param {string} chunk */
  output(chunk) {
    const turn = this.turn;
    if (turn) {
      turn.bytes += Buffer.byteLength(chunk);
      if (turn.bytes > maxOutput)
        return this.fail(Error("ANTIGRAVITY_PROTOCOL_ERROR"));
    }
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > maxOutput)
      return this.fail(Error("ANTIGRAVITY_PROTOCOL_ERROR"));
    while (this.buffer.includes("\n")) {
      const end = this.buffer.indexOf("\n"),
        line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (!line.trim()) continue;
      try {
        this.event(JSON.parse(line));
      } catch {
        return this.fail(Error("ANTIGRAVITY_PROTOCOL_ERROR"));
      }
    }
    // An idle worker has no input that could own a partial trailing frame.
    // Recycle it now so stale bytes cannot fail the next turn's preparation.
    if ((!turn || turn.terminal) && this.buffer.trim())
      this.fail(Error("ANTIGRAVITY_PROTOCOL_ERROR"));
  }
  /** @param {any} event */
  event(event) {
    const turn = this.turn;
    if (!turn) {
      if (event.event === "init" || event.event === "result")
        this.fail(Error("ANTIGRAVITY_PROTOCOL_ERROR"));
      return;
    }
    if (event.event === "init") {
      if (
        turn.terminal ||
        turn.seenInit ||
        !uuid.test(event.conversation_id) ||
        (this.nativeId && this.nativeId !== event.conversation_id) ||
        (turn.params.session &&
          turn.params.session.id !== event.conversation_id)
      )
        return this.fail(Error("ANTIGRAVITY_PROTOCOL_ERROR"));
      turn.seenInit = true;
      turn.initialized = true;
      this.nativeId = event.conversation_id;
      this.timing(turn, "initialized");
      if (this.live(turn))
        this.owner.bindSession(turn.params, this.details, this.nativeId);
    } else if (event.event === "step_update") {
      const step = event.step_update;
      if (
        !this.live(turn) ||
        !turn.initialized ||
        step?.conversation_id !== this.nativeId ||
        !Number.isSafeInteger(step.step_index) ||
        step.step_index <= turn.minimumStep
      )
        return;
      this.lastStep = Math.max(this.lastStep, step.step_index);
      if (
        step.step_type !== "agent_response" ||
        step.step_index < turn.responseIndex
      )
        return;
      if (step.step_index > turn.responseIndex) turn.contextTokens = null;
      turn.responseIndex = step.step_index;
      if (step.state === "DONE") {
        turn.contextTokens = responseOccupancy(step.usage);
        if (!turn.responseSeen) this.timing(turn, "firstResponse");
        turn.responseSeen = true;
        this.timing(turn, "lastResponse");
      }
    } else if (event.event === "result") {
      if (
        !turn.initialized ||
        turn.terminal ||
        event.result?.conversation_id !== this.nativeId ||
        (event.result?.status === "SUCCESS" && !turn.responseSeen)
      )
        return this.fail(Error("ANTIGRAVITY_PROTOCOL_ERROR"));
      turn.terminal = event.result;
      turn.live = false;
      this.timing(turn, "terminal");
      this.report(turn, {
        origin: "terminal",
        phase: "terminal-observed",
        terminalStatus: event.result.status,
      });
      // Parse the complete output chunk first, so duplicate terminal frames fail.
      setImmediate(() => {
        void this.finish(turn);
      });
    }
  }
  /** @param {any} turn */
  async finish(turn) {
    try {
      await Promise.allSettled([...turn.pending]);
      if (
        this.turn !== turn ||
        turn.failed ||
        turn.settled ||
        turn.params.signal.aborted
      )
        return;
      if (turn.terminal.status !== "SUCCESS")
        return this.fail(
          antigravityFailure(
            this.diagnostic + " " + (turn.terminal.error || ""),
            turn.terminal.status,
            turn.hookDenied,
          ),
        );
      if (turn.contextTokens !== null)
        turn.params.onUsage?.({
          source: "measured",
          contextTokens: turn.contextTokens,
          basis:
            "Antigravity latest completed agent_response input_tokens + cache_read_tokens + output_tokens; excludes cumulative result and auxiliary steps",
        });
      this.report(turn, {
        origin: "finalization",
        phase: "settled",
        backendOutcome: "success",
        ...(this.closed ? {} : { workerOutcome: "healthy" }),
      });
      turn.settled = true;
      turn.resolve();
    } catch {
      this.fail(Error("ANTIGRAVITY_PROTOCOL_ERROR"));
    }
  }
  /** @param {Error} error */
  fail(error) {
    if (this.turn && !this.turn.settled) {
      this.report(this.turn, {
        origin:
          error.message === "ANTIGRAVITY_PROTOCOL_ERROR"
            ? "protocol"
            : "finalization",
        backendOutcome: "failed",
        ...(error.message === "ANTIGRAVITY_PROTOCOL_ERROR"
          ? { trustedTerminal: false }
          : {}),
      });
      this.turn.failed = true;
      this.turn.live = false;
      this.turn.reject(error);
    }
    void this.close().catch(() => {});
  }
  /** @param {number} timeoutMs */
  idle(timeoutMs) {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      void this.close().catch(() => {});
    }, timeoutMs);
    this.idleTimer.unref();
  }
  async close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.turn && !this.turn.settled) {
      this.turn.failed = true;
      this.turn.live = false;
      this.turn.reject(Error("ABORTED"));
    }
    this.server.closeAllConnections();
    if (this.child) this.owner.stop(this.child, "SIGKILL");
    this.closePromise = new Promise((resolve, reject) =>
      this.server.close(() => {
        if (this.owner.workers.get(this.details.key) === this)
          this.owner.workers.delete(this.details.key);
        try {
          fs.rmSync(this.mediaRoot, {
            recursive: true,
            force: true,
            maxRetries: 3,
            retryDelay: 100,
          });
          resolve();
        } catch {
          // A Windows file lock must reject teardown, not throw from an event callback.
          reject(Error("ANTIGRAVITY_MEDIA_FAILED"));
        }
      }),
    );
    return this.closePromise;
  }
}
