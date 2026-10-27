import { createHash, randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { knownErrorCodes } from "./error-codes.mjs";

const ioCodes = new Set([
  "ENOSPC",
  "EACCES",
  "EPERM",
  "EROFS",
  "EIO",
  "ENOENT",
  "EMFILE",
  "ENFILE",
  "EBUSY",
]);
const conflicts = new Set([
  "CONFIG_CONFLICT",
  "REVISION_CONFLICT",
  "SELF_VERSION_CONFLICT",
  "SELF_VERSION_CONFLICT_REPROPOSE",
  "IDEMPOTENCY_CONFLICT",
  "OPERATIONS_FILE_CHANGED",
  "BACKEND_OPERATION_IN_PROGRESS",
  "CONNECTION_IN_PROGRESS",
  "CONNECTION_ALREADY_STARTED",
  "SESSION_BUSY",
  "DATA_DIRECTORY_LOCKED",
]);
const components = new Set([
  "http",
  "runtime",
  "scheduler",
  "operations",
  "transport",
  "shutdown",
  "startup",
  "config",
]);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export function classifyError(error) {
  let code =
    error instanceof ZodError
      ? "INVALID_REQUEST"
      : knownErrorCodes.has(error?.message)
        ? error.message
        : "INTERNAL_ERROR";
  if (ioCodes.has(error?.code)) code = "SYSTEM_IO_ERROR";
  if (error?.code === "ERR_SQLITE_ERROR") code = "DATABASE_UNAVAILABLE";
  let status = 400;
  if (
    code === "INTERNAL_ERROR" ||
    /(?:_FAILED|_ERROR|_BROKEN|_CORRUPT|_INTEGRITY_FAILED)$/.test(code)
  )
    status = 500;
  if (
    /(?:_UNAVAILABLE|_NOT_CONNECTED|_OFFLINE|_DISCONNECTED|_TIMEOUT)$/.test(
      code,
    ) ||
    code === "RUNTIME_CLOSING"
  )
    status = 503;
  if (conflicts.has(code)) status = 409;
  if (code === "BODY_TOO_LARGE") status = 413;
  if (
    /(?:_RATE_LIMIT|_RATE_LIMITED|_BUDGET|_BUDGET_EXHAUSTED|_TRANSFER_BUSY|_DOWNLOAD_BUSY)$/.test(
      code,
    )
  )
    status = 429;
  if (code === "INVALID_CAPABILITY") status = 401;
  else if (code.startsWith("INVALID_")) status = 400;
  if (/(?:_DENIED|_NOT_ALLOWED|_PRIVATE_ONLY|_OPERATIONS_ONLY)$/.test(code))
    status = 403;
  return { code, status, retryable: status === 503 || status === 429 };
}

function safeCause(error) {
  for (let i = 0; error && i < 3; i++, error = error.cause) {
    if (ioCodes.has(error.code)) return error.code;
    if (error.code === "ERR_SQLITE_ERROR") return "SQLITE";
    if (error instanceof ZodError) return "VALIDATION";
    if (error instanceof SyntaxError) return "JSON_SYNTAX";
  }
  return undefined;
}

export class Diagnostics {
  constructor({
    write = (line) => process.stderr.write(line),
    clock = Date.now,
  } = {}) {
    this.write = write;
    this.clock = clock;
    this.recent = [];
    this.windowAt = 0;
    this.writes = 0;
  }
  report(
    error,
    {
      component = "runtime",
      requestId,
      agentId,
      conversation,
      durationMs,
    } = {},
  ) {
    const info = classifyError(error);
    const at = this.clock();
    const entry = {
      at: new Date(at).toISOString(),
      component: components.has(component) ? component : "runtime",
      code: info.code,
      status: info.status,
      requestId: uuid.test(requestId || "") ? requestId : randomUUID(),
      ...(agentId
        ? {
            scope: createHash("sha256")
              .update(String(agentId) + "|" + String(conversation || ""))
              .digest("hex")
              .slice(0, 16),
          }
        : {}),
      ...(Number.isFinite(durationMs)
        ? { durationMs: Math.max(0, Math.round(durationMs)) }
        : {}),
      ...(safeCause(error) ? { cause: safeCause(error) } : {}),
      count: 1,
    };
    const key = entry.component + "|" + entry.code + "|" + (entry.scope || "");
    const existing = this.recent.find((x) => x.key === key);
    const log = !existing || at - existing.loggedAt >= 5000;
    if (existing) {
      entry.count = existing.entry.count + 1;
      existing.entry = entry;
      this.recent.splice(this.recent.indexOf(existing), 1);
      this.recent.push(existing);
    } else {
      this.recent.push({ key, entry, loggedAt: at });
      if (this.recent.length > 50) this.recent.shift();
    }
    if (at - this.windowAt >= 60000) {
      this.windowAt = at;
      this.writes = 0;
    }
    if (log && this.writes < 100) {
      this.writes++;
      if (existing) existing.loggedAt = at;
      // A failing diagnostic sink must not mask the original operation or recurse.
      try {
        this.write(JSON.stringify(entry) + "\n");
      } catch {}
    }
    return { ...info, requestId: entry.requestId };
  }
  snapshot() {
    return this.recent.map((x) => ({ ...x.entry })).reverse();
  }
}
