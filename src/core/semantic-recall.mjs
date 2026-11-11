import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { allowedGroups } from "./config.mjs";
import { memoryRecallPolicy } from "./functional-agents.mjs";
import { prepared, recallBoundary } from "./recall-boundary.mjs";

const SCRIPT = fileURLToPath(
  new URL("../memory/semantic-recall-worker.py", import.meta.url),
);
const BATCH = 24;
const MAX_ROWS = 100_000;
const MAX_SCOPE = 50_000;
const RETRY_MS = 30_000;

export function semanticDigest(body) {
  return createHash("sha256").update(body.slice(0, 600)).digest("hex");
}

function scopeKey(role, conversation) {
  return JSON.stringify([role.id, role.connectionId, conversation]);
}

function delay(ms, signal) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve({ status: signal?.aborted ? "cancelled" : "timeout" });
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
    if (signal?.aborted) done();
  });
}

function launch(root) {
  const python = join(
    root,
    "venv",
    ...(process.platform === "win32"
      ? ["Scripts", "python.exe"]
      : ["bin", "python"]),
  );
  // Only the worker's operating-system and numerical runtime settings are needed.
  const env = {
    ...(process.env.SystemRoot && { SystemRoot: process.env.SystemRoot }),
    OMP_NUM_THREADS: "1",
    OPENBLAS_NUM_THREADS: "1",
    VECLIB_MAXIMUM_THREADS: "1",
    TOKENIZERS_PARALLELISM: "false",
  };
  return spawn(python, ["-I", "-u", SCRIPT, root], {
    env,
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
}

export class SemanticRecall {
  constructor(runtime, start = launch) {
    this.runtime = runtime;
    this.start = start;
    this.root = join(dirname(runtime.memory.file), "semantic-recall");
    this.scopes = new Map();
    this.nextScope = 0;
    this.retryAt = 0;
  }

  refresh() {
    const config = this.runtime.config;
    if (this.config === config) return;
    this.config = config;
    const scopes = new Map();
    if (config.mode === "live") {
      for (const role of config.agents) {
        const pilot = role.functionalAgents?.memory?.pilot;
        if (!pilot?.semantic) continue;
        const conversations = [
          ...allowedGroups(role, config).map((group) => `group:${group}`),
          ...role.allow.users.map((user) => `private:${user}`),
        ];
        for (const conversation of conversations) {
          if (memoryRecallPolicy(role, conversation, config)?.semantic)
            scopes.set(scopeKey(role, conversation), { role, conversation });
        }
      }
    }
    if (
      scopes.size === this.scopes.size &&
      [...scopes.keys()].every((key) => this.scopes.has(key))
    ) {
      for (const [key, { role }] of scopes) this.scopes.get(key).role = role;
      return;
    }
    this.close();
    this.retryAt = 0;
    this.scopes = scopes;
  }

  close() {
    const child = this.child;
    this.child = undefined;
    this.pending?.finish({ status: "unavailable" });
    child?.kill();
    this.nextScope = 0;
    clearTimeout(this.background);
    this.background = undefined;
    for (const scope of this.scopes.values()) {
      delete scope.before;
      delete scope.after;
      delete scope.done;
      delete scope.count;
    }
  }

  connect() {
    if (this.child) return this.child;
    if (Date.now() < this.retryAt) return;
    let child;
    try {
      child = this.start(this.root);
    } catch {
      this.retryAt = Date.now() + RETRY_MS;
      return;
    }
    this.child = child;
    const failed = () => {
      if (this.child !== child) return;
      this.retryAt = Date.now() + RETRY_MS;
      this.close();
    };
    child.once("error", failed);
    child.once("exit", failed);
    child.stdin.on("error", failed);
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (this.child !== child || !this.pending) return;
      try {
        const hits = JSON.parse(line);
        if (!Array.isArray(hits)) return failed();
        this.pending.finish({ status: "ready", hits });
      } catch {
        failed();
      }
    });
    return child;
  }

  send(message) {
    const child = this.connect();
    if (!child) return Promise.resolve({ status: "unavailable" });
    let finish;
    const promise = new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.retryAt = Date.now() + RETRY_MS;
        this.close();
      }, 5000);
      timer.unref();
      finish = (result) => {
        clearTimeout(timer);
        this.pending = undefined;
        resolve(result);
      };
    });
    this.pending = { promise, finish };
    child.stdin.write(`${JSON.stringify(message)}\n`);
    return promise;
  }

  tick() {
    if (this.runtime.closed || this.runtime.maintenance.active) return;
    try {
      this.indexNextScope();
    } catch {
      this.retryAt = Date.now() + RETRY_MS;
      this.close();
    }
  }

  indexNextScope() {
    this.refresh();
    if (this.pending || this.background || Date.now() < this.retryAt) return;
    const scopes = [...this.scopes];
    const limit = Math.min(MAX_SCOPE, Math.floor(MAX_ROWS / scopes.length));
    for (let i = 0; i < scopes.length; i++) {
      const [key, scope] = scopes[this.nextScope++ % scopes.length];
      if (!this.runtime.writable(scope.role, scope.conversation)) continue;
      if (this.index(key, scope, limit)) return;
    }
  }

  index(key, scope, limit) {
    const { role, conversation } = scope;
    const memory = this.runtime.memory.bind(role.id);
    const prefix = `SELECT * FROM events
      WHERE agent_id=? AND connection_id=? AND conversation=?
      AND ((kind='message.received' AND status='observed')
        OR (kind='message.sent' AND status='confirmed'))`;
    const params = [role.id, role.connectionId, conversation];
    let newer = scope.after !== undefined;
    let rows = newer
      ? prepared(memory.db, `${prefix} AND seq>? ORDER BY seq ASC LIMIT ?`).all(
          ...params,
          scope.after,
          BATCH,
        )
      : [];
    if (!rows.length && !scope.done) {
      newer = false;
      rows = prepared(
        memory.db,
        `${prefix} AND seq<? ORDER BY seq DESC LIMIT ?`,
      ).all(...params, scope.before ?? Number.MAX_SAFE_INTEGER, BATCH);
    }
    if (!rows.length) {
      scope.after ??= 0;
      scope.done = true;
      return false;
    }
    const boundary = recallBoundary(this.runtime, {
      agentId: role.id,
      conversation,
      runtimeKind: "functional-agent",
    });
    const entries = rows.flatMap((row) => {
      const event = boundary.project(memory.event(row, conversation));
      const at = Date.parse(row.occurred_at);
      if (!event?.body?.trim() || !Number.isFinite(at)) return [];
      return [
        {
          id: row.id,
          seq: row.seq,
          at,
          body: event.body.slice(0, 600),
          digest: semanticDigest(event.body),
        },
      ];
    });
    const advance = () => {
      scope.count = (scope.count ?? 0) + entries.length;
      if (newer) scope.after = rows.at(-1).seq;
      else {
        scope.after ??= rows[0].seq;
        scope.before = rows.at(-1).seq;
        scope.done = scope.count >= limit || rows.length < BATCH;
      }
      this.background = setTimeout(() => {
        this.background = undefined;
        this.tick();
      }, 75);
      this.background.unref();
    };
    if (!entries.length) advance();
    else {
      this.send({ op: "index", scope: key, rows: entries, limit }).then(
        ({ status }) => {
          if (status === "ready") advance();
        },
      );
    }
    return true;
  }

  async search(
    role,
    conversation,
    query,
    { beforeSeq, to, known, signal, budget },
  ) {
    const start = performance.now();
    this.refresh();
    const key = scopeKey(role, conversation);
    const scope = this.scopes.get(key);
    const result = (status, hits = []) => ({
      status,
      hits,
      waitMs: Math.round(performance.now() - start),
    });
    if (!scope || !this.runtime.writable(role, conversation))
      return result("unavailable");
    if (Date.now() < this.retryAt) return result("unavailable");
    if (!scope.count && !this.pending) return result("warming");
    if (budget <= 0) return result("timeout");
    const deadline = new AbortController();
    const timeout = delay(budget, deadline.signal);
    const abort = () => deadline.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try {
      while (this.pending && !deadline.signal.aborted) {
        const state = await Promise.race([this.pending.promise, timeout]);
        if (state.status !== "ready")
          return result(signal.aborted ? "cancelled" : state.status);
      }
      if (signal.aborted) return result("cancelled");
      if (!scope.count || this.scopes.get(key) !== scope)
        return result("warming");
      const state = await Promise.race([
        this.send({ op: "query", scope: key, query, beforeSeq, to, known }),
        timeout,
      ]);
      return result(signal.aborted ? "cancelled" : state.status, state.hits);
    } finally {
      signal.removeEventListener("abort", abort);
      deadline.abort();
    }
  }
}
