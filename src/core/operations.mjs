import fs from "node:fs";
import path from "node:path";
import { randomInt, randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { verifyTotp } from "../../vendor/legacy/totp.js";

const rank = (x) => ["L0", "L1", "L2", "L3"].indexOf(x),
  digest = (x) => createHash("sha256").update(x).digest("hex");
export class Operations {
  constructor(runtime) {
    this.runtime = runtime;
    this.levels = new Map();
    this.pending = new Map();
    this.results = new Map();
    this.executions = new Map();
    this.totpCounters = new Map();
    this.attempts = new Map();
  }
  owner(ctx) {
    const a = this.runtime.assertActive(ctx);
    if (
      !a.operations.enabled ||
      !this.runtime.protectedWork?.context(ctx)?.operations
    )
      throw Error("OWNER_OPERATIONS_ONLY");
    return a;
  }
  audit(id, kind, payload) {
    this.runtime.memory.bind(id).append({
      dedupe: "ops:" + randomUUID(),
      conversation: "@operations",
      kind: "operations." + kind,
      direction: "internal",
      body: kind,
      payload,
    });
  }
  key(ctx) {
    return ctx.agentId + "|" + ctx.conversation;
  }
  level(ctx, min = "L1") {
    const a = this.owner(ctx);
    this.expire();
    const grant = this.levels.get(this.key(ctx));
    if (!grant || rank(grant.level) < rank(min))
      throw Error("OPERATIONS_LEVEL_REQUIRED");
    grant.activeAt = this.runtime.now();
    return a;
  }
  request(ctx, { level }) {
    const a = this.owner(ctx);
    if (rank(level) < 0) throw Error("INVALID_LEVEL");
    if (level === "L0") {
      this.revoke(a.id);
      return { level: "L0" };
    }
    if (
      level === "L3" &&
      (!a.operations.allowL3 ||
        !a.operations.totpEnv ||
        !process.env[a.operations.totpEnv])
    )
      throw Error("L3_DISABLED_OR_TOTP_MISSING");
    return this.enqueue(ctx, { type: "level", level });
  }
  enqueue(ctx, operation) {
    if (
      [...this.pending.values()].filter((p) => p.agentId === ctx.agentId)
        .length >= 5
    )
      throw Error("APPROVAL_LIMIT");
    const request = {
      id: randomUUID(),
      agentId: ctx.agentId,
      conversation: ctx.conversation,
      operation,
      code: String(randomInt(100000, 1000000)),
      expiresAt: this.runtime.now() + 120000,
      attempts: 0,
    };
    this.pending.set(request.id, request);
    this.audit(ctx.agentId, "requested", {
      id: request.id,
      type: operation.type,
      level: operation.level,
    });
    // Only the authenticated console / deterministic owner-command channel sees the challenge.
    return {
      requestId: request.id,
      status: "awaiting-owner-confirmation",
      expiresAt: request.expiresAt,
    };
  }
  file(ctx, relative, { write = false } = {}) {
    const a = this.level(ctx, write ? "L2" : "L1"),
      root = a.operations.workspace;
    if (
      !root ||
      !path.isAbsolute(root) ||
      typeof relative !== "string" ||
      path.isAbsolute(relative) ||
      relative.includes("\0")
    )
      throw Error("OPERATIONS_PATH_DENIED");
    const parts = relative.replace(/\\/g, "/").split("/");
    if (
      parts.some(
        (p) =>
          p === ".." ||
          p.startsWith(".") ||
          /^(?:auth|config|credentials|admin-token|secrets)(?:\.|$)/i.test(p),
      )
    )
      throw Error("OPERATIONS_PATH_DENIED");
    const realRoot = fs.realpathSync(root),
      target = path.resolve(realRoot, relative);
    if (!target.startsWith(realRoot + path.sep))
      throw Error("OPERATIONS_PATH_DENIED");
    let check = target;
    while (!fs.existsSync(check) && check !== realRoot)
      check = path.dirname(check);
    const actual = fs.realpathSync(check);
    if (actual !== realRoot && !actual.startsWith(realRoot + path.sep))
      throw Error("OPERATIONS_SYMLINK_DENIED");
    return target;
  }
  read(ctx, { file, offset = 0, maxChars = 8000 }) {
    const full = this.file(ctx, file),
      stat = fs.statSync(full);
    if (!stat.isFile() || stat.size > 1024 * 1024)
      throw Error("OPERATIONS_FILE_TOO_LARGE");
    const text = fs.readFileSync(full, "utf8");
    ctx.privateRead.add("operations:" + digest(full));
    ctx.persistTaint?.();
    return {
      text: text.slice(offset, offset + maxChars),
      nextOffset: offset + maxChars < text.length ? offset + maxChars : null,
      disclosure: "private-recollection-do-not-disclose",
    };
  }
  propose(ctx, operation) {
    if (operation.type === "write") {
      const full = this.file(ctx, operation.file, { write: true });
      const prior = fs.existsSync(full) ? digest(fs.readFileSync(full)) : null;
      return this.enqueue(ctx, { ...operation, prior });
    }
    const a = this.level(ctx, "L3");
    if (!a.operations.allowedCommands.includes(operation.command))
      throw Error("COMMAND_NOT_ALLOWED");
    return this.enqueue(ctx, operation);
  }
  snapshot() {
    this.expire();
    return {
      pending: [...this.pending.values()].map(({ code, ...p }) => ({
        ...p,
        confirmationCode: code,
      })),
      levels: [...this.levels].map(([key, v]) => ({ key, ...v })),
    };
  }
  checkAttempts(key) {
    const entry = this.attempts.get(key);
    if (entry && entry.until > this.runtime.now() && entry.count >= 5)
      throw Error("CONFIRMATION_LOCKED");
    if (entry && entry.until <= this.runtime.now()) this.attempts.delete(key);
  }
  failedAttempt(key) {
    const now = this.runtime.now(),
      previous = this.attempts.get(key);
    this.attempts.set(key, {
      count: (previous?.until > now ? previous.count : 0) + 1,
      until: now + 300000,
    });
  }
  async confirm(agentId, conversation, requestId, code, otp) {
    const p = this.pending.get(requestId),
      a = this.runtime.agent(agentId),
      now = this.runtime.now();
    if (
      !a.operations.enabled ||
      !this.runtime.protectedWork?.task(agentId, conversation)?.operations ||
      !this.runtime.writable(a, conversation)
    )
      throw Error("OWNER_OPERATIONS_ONLY");
    const key = agentId + "|" + conversation;
    this.checkAttempts(key);
    if (
      !p ||
      p.agentId !== agentId ||
      p.conversation !== conversation ||
      p.expiresAt < now
    )
      throw Error("APPROVAL_EXPIRED");
    if (code !== p.code) {
      this.failedAttempt(key);
      p.attempts++;
      if (p.attempts >= 3) this.pending.delete(p.id);
      throw Error("INVALID_CONFIRMATION_CODE");
    }
    if (p.operation.level === "L3") {
      const store = this.runtime.memory.bind(agentId),
        previous = store.state("@operations");
      const verified = verifyTotp(process.env[a.operations.totpEnv], otp, {
        nowMs: now,
        lastUsedCounter: previous.totpCounter ?? -1,
      });
      if (!verified.ok) {
        this.failedAttempt(key);
        p.attempts++;
        if (p.attempts >= 3) this.pending.delete(p.id);
        throw Error("INVALID_TOTP");
      }
      this.totpCounters.set(key, verified.counter);
      store.setState("@operations", {
        ...previous,
        totpCounter: verified.counter,
      });
    }
    this.pending.delete(p.id);
    this.attempts.delete(key);
    const execution = this.runtime.withContext(
      agentId,
      conversation,
      async (ctx) => {
        if (p.operation.type === "level") {
          this.levels.set(key, {
            level: p.operation.level,
            grantedAt: now,
            activeAt: now,
          });
          return { level: p.operation.level };
        }
        if (p.operation.type === "write") {
          const full = this.file(ctx, p.operation.file, { write: true }),
            current = fs.existsSync(full)
              ? digest(fs.readFileSync(full))
              : null;
          if (current !== p.operation.prior)
            throw Error("OPERATIONS_FILE_CHANGED");
          fs.mkdirSync(path.dirname(full), { recursive: true, mode: 0o700 });
          // Check again after mkdir; symlink escapes are refused and writes replace only the approved target.
          this.file(ctx, p.operation.file, { write: true });
          const tmp = path.join(
            path.dirname(full),
            ".approved-" + randomUUID(),
          );
          try {
            fs.writeFileSync(tmp, p.operation.text, {
              mode: 0o600,
              flag: "wx",
            });
            fs.renameSync(tmp, full);
          } finally {
            fs.rmSync(tmp, { force: true });
          }
          return { written: p.operation.file };
        }
        this.level(ctx, "L3");
        if (!a.operations.allowedCommands.includes(p.operation.command))
          throw Error("COMMAND_NOT_ALLOWED");
        return new Promise((resolve) => {
          execFile(
            p.operation.command,
            p.operation.args || [],
            {
              cwd: fs.realpathSync(a.operations.workspace),
              shell: false,
              timeout: 30000,
              maxBuffer: 32768,
              env: { PATH: process.env.PATH, LANG: "en_US.UTF-8" },
              signal: ctx.controller.signal,
            },
            (error, stdout, stderr) =>
              resolve({
                exitCode: error ? error.code : 0,
                stdout: stdout.slice(0, 8000),
                stderr: stderr.slice(0, 2000),
              }),
          );
        });
      },
    );
    this.executions.set(requestId, {
      agentId,
      conversation,
      promise: execution,
    });
    let result;
    try {
      result = await execution;
    } finally {
      this.executions.delete(requestId);
    }
    if (!this.runtime.protectedWork.active(agentId, conversation))
      throw Error("PROTECTED_WORK_NOT_ACTIVE");
    this.results.set(requestId, {
      agentId,
      conversation,
      result,
      expiresAt: now + 600000,
    });
    this.audit(agentId, "completed", { id: requestId, type: p.operation.type });
    return result;
  }
  result(ctx, id) {
    this.owner(ctx);
    const row = this.results.get(id);
    if (
      !row ||
      row.agentId !== ctx.agentId ||
      row.conversation !== ctx.conversation
    )
      throw Error("RESULT_NOT_FOUND");
    ctx.privateRead.add("operations-result:" + id);
    ctx.persistTaint?.();
    return row.result;
  }
  revokeScope(agentId, conversation) {
    this.levels.delete(agentId + "|" + conversation);
    for (const [key, row] of this.pending)
      if (row.agentId === agentId && row.conversation === conversation)
        this.pending.delete(key);
    for (const [key, row] of this.results)
      if (row.agentId === agentId && row.conversation === conversation)
        this.results.delete(key);
  }
  revoke(agentId, audit = true) {
    for (const [key] of this.levels)
      if (key.startsWith(agentId + "|")) this.levels.delete(key);
    for (const [key, r] of this.pending)
      if (r.agentId === agentId) this.pending.delete(key);
    if (audit) this.audit(agentId, "revoked", {});
  }
  expire() {
    const now = this.runtime.now();
    for (const [key, r] of this.attempts)
      if (r.until <= now) this.attempts.delete(key);
    for (const [key, g] of this.levels) {
      const a = this.runtime.config.agents.find((a) =>
        key.startsWith(a.id + "|"),
      );
      if (
        !a ||
        now - g.activeAt > a.operations.idleMs ||
        now - g.grantedAt > a.operations.maxLevelMs
      )
        this.levels.delete(key);
    }
    for (const [key, r] of this.pending)
      if (r.expiresAt < now) this.pending.delete(key);
    for (const [key, r] of this.results)
      if (r.expiresAt < now) this.results.delete(key);
  }
  async command(a, e, archived) {
    const elevate = /^\/ops\s+(L[0-3])$/i.exec(e.body.trim()),
      confirm = /^确认\s+(\d{6})(?:\s+(\d{6}))?$/.exec(e.body.trim());
    if (!elevate && !confirm) return false;
    if (!this.runtime.writable(a, e.conversation))
      return this.runtime.skipOwnerCommand(a, e, archived, "operations");
    if (elevate?.[1].toUpperCase() === "L0") this.revoke(a.id);
    const text =
      elevate?.[1].toUpperCase() === "L0"
        ? "已回落到 L0，并撤销待确认运维操作。"
        : "运维已移至控制台的受保护工作区，请在那里创建任务和逐项确认；普通聊天不会读取运维内容。";
    await this.runtime.withContext(a.id, e.conversation, (ctx) =>
      this.runtime.send(
        ctx,
        { requestId: "ops-reply:" + archived.id, text },
        { archiveBody: "[管理员运维请求回应；确认码不进入记忆]" },
      ),
    );
    return true;
  }
}
