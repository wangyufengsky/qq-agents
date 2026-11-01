// @ts-check
import { randomUUID } from "node:crypto";
import { canonical, fail } from "../core/value.mjs";

/** Durable decisions, attempt reservations and fencing share the room transaction. */
export class GameJobs {
  /** @param {import('../core/kernel.mjs').GameKernel} kernel @param {any} options */
  constructor(kernel, { gate = () => null, limits = {} } = {}) {
    this.kernel = kernel;
    this.gate = gate;
    this.limits = {
      roomAttempts: 128,
      agentAttempts: 256,
      totalAttempts: 512,
      attemptTokens: 32768,
      roomTokens: 4194304,
      agentTokens: 8388608,
      totalTokens: 16777216,
      ...limits,
    };
    kernel.store.db.exec(`
      CREATE TABLE IF NOT EXISTS game_jobs(id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES game_rooms(id) ON DELETE CASCADE, status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS game_outbox(id TEXT PRIMARY KEY, attempts INTEGER NOT NULL, next_at INTEGER NOT NULL, status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS game_inbox(id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS game_budgets(scope TEXT PRIMARY KEY, attempts INTEGER NOT NULL, tokens INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS game_attempts(run_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, data TEXT NOT NULL);
    `);
    // Charge existing lifetime totals to the upgrade day rather than silently resetting them.
    const day = Math.floor(kernel.clock() / 86400000);
    kernel.store.transaction(() => {
      for (const row of kernel.store.db
        .prepare(
          "SELECT * FROM game_budgets WHERE scope='framework' OR scope LIKE 'agent:%' AND scope NOT LIKE '%:day:%'",
        )
        .all()) {
        kernel.store.db
          .prepare(
            "INSERT INTO game_budgets VALUES(?,?,?) ON CONFLICT(scope) DO UPDATE SET attempts=attempts+excluded.attempts,tokens=tokens+excluded.tokens",
          )
          .run(String(row.scope) + ":day:" + day, row.attempts, row.tokens);
        kernel.store.db
          .prepare("DELETE FROM game_budgets WHERE scope=?")
          .run(row.scope);
      }
      for (const row of kernel.store.db
        .prepare(
          "SELECT id,data FROM game_jobs WHERE json_extract(data,'$.run.runId') IS NOT NULL AND json_extract(data,'$.run.budgetScopes') IS NULL",
        )
        .all()) {
        const job = JSON.parse(String(row.data));
        job.run.budgetScopes = [
          "room:" + job.roomId,
          "agent:" + job.agentId + ":day:" + day,
          "framework:day:" + day,
        ];
        kernel.store.db
          .prepare("UPDATE game_jobs SET data=? WHERE id=?")
          .run(JSON.stringify(job), row.id);
        kernel.store.db
          .prepare("UPDATE game_attempts SET data=? WHERE run_id=?")
          .run(JSON.stringify(job.run), job.run.runId);
      }
    });
    kernel.ai = this;
  }
  /** The UTC day is persisted in scope keys; restarting never refreshes a reservation.
   * @param {string} [agentId] @param {string} [roomId] */
  budgetStatus(agentId, roomId) {
    const day = Math.floor(this.kernel.clock() / 86400000);
    const scopes = [
      {
        scope: "framework:day:" + day,
        attempts: this.limits.totalAttempts,
        tokens: this.limits.totalTokens,
        resetAt: (day + 1) * 86400000,
      },
      ...(agentId
        ? [
            {
              scope: "agent:" + agentId + ":day:" + day,
              attempts: this.limits.agentAttempts,
              tokens: this.limits.agentTokens,
              resetAt: (day + 1) * 86400000,
            },
          ]
        : []),
      ...(roomId
        ? [
            {
              scope: "room:" + roomId,
              attempts: this.limits.roomAttempts,
              tokens: this.limits.roomTokens,
              resetAt: null,
            },
          ]
        : []),
    ];
    return scopes.map((limit) => {
      const used = this.kernel.store.db
        .prepare("SELECT attempts,tokens FROM game_budgets WHERE scope=?")
        .get(limit.scope);
      return {
        ...limit,
        remainingAttempts: Math.max(
          0,
          limit.attempts - Number(used?.attempts || 0),
        ),
        remainingTokens: Math.max(0, limit.tokens - Number(used?.tokens || 0)),
      };
    });
  }
  /** @param {any} job */
  enqueue(job) {
    this.kernel.store.db
      .prepare("INSERT INTO game_jobs VALUES(?,?,?,?)")
      .run(
        job.decisionId,
        job.roomId,
        "queued",
        JSON.stringify({ ...job, fence: 0, run: null, reason: null }),
      );
    this.kernel.store.db
      .prepare("INSERT INTO game_outbox VALUES(?,0,?,'pending')")
      .run(job.decisionId, this.kernel.clock());
  }
  /** @param {string} id @returns {any} */
  get(id) {
    const row = this.kernel.store.db
      .prepare("SELECT status,data FROM game_jobs WHERE id=?")
      .get(id);
    if (!row) fail("GAME_JOB_UNAVAILABLE", 404);
    return { ...JSON.parse(String(row.data)), status: String(row.status) };
  }
  /** @param {any} job */
  save(job) {
    this.kernel.store.db
      .prepare("UPDATE game_jobs SET status=?,data=? WHERE id=?")
      .run(job.status, JSON.stringify(job), job.decisionId);
  }
  /** The inbox acknowledgement means registration, never model completion. @param {string} id */
  receive(id) {
    return this.kernel.store.transaction(() => {
      this.get(id);
      this.kernel.store.db
        .prepare("INSERT OR IGNORE INTO game_inbox VALUES(?)")
        .run(id);
      return { registered: true };
    });
  }
  /** @param {(id:string)=>Promise<unknown>} send @param {()=>number} random */
  async dispatch(send, random = Math.random) {
    const rows = this.kernel.store.db
      .prepare(
        "SELECT id FROM game_outbox WHERE status='pending' AND next_at<=? ORDER BY next_at LIMIT 16",
      )
      .all(this.kernel.clock());
    for (const row of rows) {
      const id = String(row.id);
      const attempt = this.kernel.store.transaction(() => {
        const current = this.kernel.store.db
          .prepare("SELECT * FROM game_outbox WHERE id=?")
          .get(id);
        if (
          !current ||
          current.status !== "pending" ||
          Number(current.next_at) > this.kernel.clock()
        )
          return null;
        const n = Number(current.attempts) + 1;
        this.kernel.store.db
          .prepare(
            "UPDATE game_outbox SET attempts=?,next_at=?,status=? WHERE id=?",
          )
          .run(
            n,
            this.kernel.clock() +
              5000 +
              1000 * 2 ** (n - 1) * (0.8 + random() * 0.4),
            n >= 6 ? "delivery_failed" : "pending",
            id,
          );
        return n;
      });
      if (!attempt) continue;
      let timer;
      try {
        await Promise.race([
          send(id),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(Error("DELIVERY_TIMEOUT")), 5000);
          }),
        ]);
        this.kernel.store.transaction(() =>
          this.kernel.store.db
            .prepare("UPDATE game_outbox SET status='registered' WHERE id=?")
            .run(id),
        );
      } catch {
        if (attempt < 6)
          this.kernel.store.db
            .prepare(
              "UPDATE game_outbox SET next_at=? WHERE id=? AND status='pending'",
            )
            .run(
              this.kernel.clock() +
                1000 * 2 ** (attempt - 1) * (0.8 + random() * 0.4),
              id,
            );
        if (attempt >= 6)
          this.kernel.store.transaction(() => {
            const job = this.get(id);
            if (job.status === "queued") {
              job.status = "delivery_failed";
              job.reason = "DELIVERY_FAILED";
              this.save(job);
            }
          });
      } finally {
        clearTimeout(timer);
      }
    }
  }
  /** @param {any} job */
  current(job) {
    try {
      const room = this.kernel.store.room(job.roomId);
      return (
        room.lifecycle === "active" &&
        room.deadline > this.kernel.clock() &&
        room.decision?.decisionId === job.decisionId &&
        room.revision === job.sourceRevision &&
        canonical(room.moduleRef) === canonical(job.moduleRef)
      );
    } catch {
      return false;
    }
  }
  /** @param {string} id @param {string} workerId @param {string} claimRequestId */
  claim(id, workerId, claimRequestId) {
    return this.kernel.store.transaction(() => {
      const job = this.get(id);
      const previous = this.kernel.store.db
        .prepare(
          "SELECT data FROM game_attempts WHERE job_id=? AND json_extract(data,'$.workerId')=? AND json_extract(data,'$.claimRequestId')=?",
        )
        .get(id, workerId, claimRequestId);
      if (previous) return JSON.parse(String(previous.data));
      if (!this.current(job)) fail("GAME_DECISION_STALE");
      if (job.run && !job.run.terminal) fail("GAME_OUTCOME_UNKNOWN");
      if (
        !["queued", "blocked", "model_failed", "delivery_failed"].includes(
          job.status,
        )
      )
        fail("GAME_JOB_NOT_RUNNABLE");
      if (
        !this.kernel.store.db
          .prepare("SELECT 1 FROM game_inbox WHERE id=?")
          .get(id)
      )
        fail("GAME_JOB_NOT_REGISTERED");
      const reason = this.gate(job);
      if (reason) {
        job.status = "blocked";
        job.reason = reason;
        this.save(job);
        return null;
      }
      // A new decision cannot evade an earlier unproven run in this room.
      const active = this.kernel.store.db
        .prepare("SELECT data FROM game_jobs WHERE room_id=? AND id!=?")
        .all(job.roomId, id)
        .map((row) => JSON.parse(String(row.data)));
      if (active.some((j) => j.run && !j.run.terminal))
        fail("GAME_OUTCOME_UNKNOWN");
      const now = this.kernel.clock(),
        day = Math.floor(now / 86400000);
      const scopes = [
        [
          "room:" + job.roomId,
          this.limits.roomAttempts,
          this.limits.roomTokens,
        ],
        [
          "agent:" + job.agentId + ":day:" + day,
          this.limits.agentAttempts,
          this.limits.agentTokens,
        ],
        [
          "framework:day:" + day,
          this.limits.totalAttempts,
          this.limits.totalTokens,
        ],
      ];
      for (const [scope, attempts, tokens] of scopes) {
        const used = this.kernel.store.db
          .prepare("SELECT attempts,tokens FROM game_budgets WHERE scope=?")
          .get(scope);
        if (
          Number(used?.attempts || 0) >= attempts ||
          Number(used?.tokens || 0) + this.limits.attemptTokens > tokens
        )
          fail("GAME_BUDGET_EXHAUSTED");
      }
      for (const [scope] of scopes)
        this.kernel.store.db
          .prepare(
            "INSERT INTO game_budgets VALUES(?,1,?) ON CONFLICT(scope) DO UPDATE SET attempts=attempts+1,tokens=tokens+excluded.tokens",
          )
          .run(scope, this.limits.attemptTokens);
      job.fence++;
      job.run = {
        jobKey: id,
        runId: randomUUID(),
        fencingToken: job.fence,
        workerId,
        claimRequestId,
        leaseUntil: now + 60000,
        startedAt: now,
        terminal: false,
        submitted: false,
        session: null,
        backendTurn: null,
        reservedTokens: this.limits.attemptTokens,
        budgetScopes: scopes.map(([scope]) => scope),
      };
      job.status = "running";
      job.reason = null;
      this.save(job);
      this.kernel.store.db
        .prepare("INSERT INTO game_attempts VALUES(?,?,?)")
        .run(job.run.runId, id, JSON.stringify(job.run));
      return structuredClone(job.run);
    });
  }
  /** @param {any} execution @returns {any} */
  match(execution) {
    if (!execution) fail("GAME_EXECUTION_REQUIRED", 403);
    const job = this.get(execution.jobKey),
      run = job.run;
    if (
      !run ||
      run.runId !== execution.runId ||
      run.fencingToken !== execution.fencingToken
    )
      fail("GAME_EXECUTION_STALE", 403);
    return job;
  }
  /** Called by the kernel inside its action transaction. @param {any} room @param {any} member @param {any} execution */
  validate(room, member, execution) {
    const job = this.match(execution);
    if (
      job.status !== "running" ||
      job.run.terminal ||
      job.run.leaseUntil <= this.kernel.clock() ||
      !this.current(job) ||
      job.participantId !== member.participantId ||
      job.agentId !== member.agentId ||
      job.roomId !== room.id
    )
      fail("GAME_EXECUTION_STALE", 403);
    const reason = this.gate(job);
    if (reason) fail(reason, 403);
  }
  /** @param {any} execution */
  renew(execution) {
    return this.kernel.store.transaction(() => {
      const job = this.match(execution);
      if (
        job.status !== "running" ||
        job.run.terminal ||
        job.run.leaseUntil <= this.kernel.clock() ||
        !this.current(job) ||
        this.gate(job)
      )
        fail("GAME_LEASE_LOST", 403);
      job.run.leaseUntil = this.kernel.clock() + 60000;
      this.save(job);
      return job.run.leaseUntil;
    });
  }
  /** Native references remain private, and cannot be replaced by model tool arguments. @param {any} execution @param {any} patch */
  observe(execution, patch) {
    this.kernel.store.transaction(() => {
      const job = this.match(execution);
      Object.assign(job.run, patch);
      this.save(job);
      this.kernel.store.db
        .prepare("UPDATE game_attempts SET data=? WHERE run_id=?")
        .run(JSON.stringify(job.run), job.run.runId);
    });
  }
  /** Only the backend adapter supplies terminal proof. Unknown usage retains its whole reservation.
   * @param {any} execution @param {{terminal:boolean,completed?:boolean,code?:string,tokens?:number}} result */
  settle(execution, result) {
    this.kernel.store.transaction(() => {
      const job = this.match(execution);
      if (job.run.terminal) return;
      job.run.terminal = result.terminal;
      job.status = !result.terminal
        ? "outcome_unknown"
        : !this.current(job)
          ? "completed"
          : "model_failed";
      job.reason = !result.terminal
        ? "OUTCOME_UNKNOWN"
        : this.current(job)
          ? result.code || "NO_GAME_ACTION"
          : null;
      // A turn's context usage is not a measured bill; only an adapter's explicit charge can release reservation.
      if (
        result.terminal &&
        Number.isSafeInteger(result.tokens) &&
        Number(result.tokens) >= 0
      ) {
        const delta = Number(result.tokens) - job.run.reservedTokens;
        for (const scope of job.run.budgetScopes || [
          "room:" + job.roomId,
          "agent:" + job.agentId,
          "framework",
        ])
          this.kernel.store.db
            .prepare("UPDATE game_budgets SET tokens=tokens+? WHERE scope=?")
            .run(delta, scope);
        job.run.measuredTokens = result.tokens;
      }
      this.save(job);
      this.kernel.store.db
        .prepare("UPDATE game_attempts SET data=? WHERE run_id=?")
        .run(JSON.stringify(job.run), job.run.runId);
    });
  }
  /** A crash or lease expiry does not prove that the remote model stopped. */
  recover() {
    for (const row of this.kernel.store.db
      .prepare("SELECT id FROM game_jobs WHERE status='running'")
      .all())
      this.kernel.store.transaction(() => {
        const job = this.get(String(row.id));
        job.status = "outcome_unknown";
        job.reason = "OUTCOME_UNKNOWN";
        this.save(job);
      });
  }
  /** Never delete the only evidence of an unresolved remote attempt. @param {string} roomId */
  unresolved(roomId) {
    return (
      this.kernel.store.db
        .prepare(
          "SELECT 1 FROM game_jobs WHERE room_id=? AND json_extract(data,'$.run.runId') IS NOT NULL AND json_extract(data,'$.run.terminal')=0 LIMIT 1",
        )
        .get(roomId) !== undefined
    );
  }
  /** @param {string} roomId */
  publicStatus(roomId) {
    const room = this.kernel.store.room(roomId),
      id = room.decision?.decisionId;
    if (!id) return null;
    const row = this.kernel.store.db
      .prepare("SELECT status,data FROM game_jobs WHERE id=?")
      .get(id);
    if (!row) return null;
    const job = JSON.parse(String(row.data));
    return { status: String(row.status), reason: job.reason || null };
  }
}
