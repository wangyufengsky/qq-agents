// @ts-check
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { gameDatabase } from "./database.mjs";
import { GameWorker } from "./worker.mjs";
import { buildChildEnv } from "../../core/child-env.mjs";
import { digest, fail } from "../core/value.mjs";

/** The only bridge between authenticated QQ intake and the game database. */
export class GameHost {
  /** @param {any} runtime @param {{database?:string,launch?:boolean}} [options] */
  constructor(runtime, { database, launch = true } = {}) {
    this.runtime = runtime;
    this.launch = launch;
    this.database = database;
    this.ready = false;
    this.closed = false;
    this.pumping = false;
    /** @type {any} */ this.child = null;
    /** @type {any} */ this.kernel = null;
    /** @type {any} */ this.identity = null;
    /** @type {any} */ this.jobs = null;
    this.worker = new GameWorker(this);
  }
  get policy() {
    return this.runtime.config.games;
  }
  ensure() {
    if (!this.policy.enabled || this.closed) fail("GAMES_DISABLED", 403);
    if (this.kernel) return;
    const database =
      this.database ||
      path.join(
        path.dirname(this.runtime.memory.file),
        "games",
        "rooms.sqlite",
      );
    mkdirSync(path.dirname(database), { recursive: true, mode: 0o700 });
    const p = this.policy;
    Object.assign(
      this,
      gameDatabase({
        database,
        clock: () => this.runtime.now(),
        maxRooms: p.maxRooms,
        gate: (job) => this.gate(job),
        limits: {
          roomAttempts: p.maxAttemptsPerRoom,
          agentAttempts: p.maxAttemptsPerAgent,
          totalAttempts: p.maxAttemptsTotal,
          attemptTokens: p.reservedTokensPerAttempt,
          roomTokens: p.maxTokensPerRoom,
          agentTokens: p.maxTokensPerAgent,
          totalTokens: p.maxTokensTotal,
        },
      }),
    );
    this.jobs.recover();
    this.refreshAccess();
    this.settings = JSON.stringify(p);
    if (!this.launch) {
      this.ready = true;
      return;
    }
    this.child = fork(
      new URL("./service.mjs", import.meta.url),
      [database, String(p.port), p.publicOrigin],
      {
        env: buildChildEnv("game-service"),
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        execArgv: [],
      },
    );
    this.child.on("message", (/** @type {any} */ message) => {
      if (message?.ready === true) this.ready = true;
      if (message?.admission && typeof message.roomId === "string") {
        let allowed = false;
        try {
          this.refreshAccess();
          const source = this.source(message.roomId);
          allowed =
            source.access === true &&
            this.settings === JSON.stringify(this.policy);
        } catch {
          /* Unknown rooms fail closed. */
        }
        if (this.child.connected)
          this.child.send({ admission: message.admission, allowed });
      }
    });
    this.child.on("error", () => {
      this.ready = false;
    });
    this.child.on("exit", () => {
      this.ready = false;
    });
  }
  /** @param {string} roomId @returns {any} */
  source(roomId) {
    const row = this.kernel.store.db
      .prepare("SELECT data FROM game_host_rooms WHERE id=?")
      .get(roomId);
    if (!row) fail("ROOM_UNAVAILABLE", 404);
    return JSON.parse(row.data);
  }
  /** @param {any} source @param {any} [ctx] */
  permission(source, ctx) {
    const r = this.runtime,
      a = r.config.agents.find(
        (/** @type {any} */ a) => a.id === source.agentId,
      );
    if (
      !this.policy.enabled ||
      !a?.games.enabled ||
      a.connectionId !== source.connectionId ||
      (source.accountId &&
        this.runtime.connection(a.connectionId).accountId !==
          source.accountId) ||
      (source.backendId && a.backendId !== source.backendId)
    )
      return "GAMES_DISABLED";
    return r.blockers(a, source.conversation, ctx)[0] || null;
  }
  /** @param {any} job */
  gate(job) {
    const source = this.source(job.roomId),
      r = this.runtime,
      a = r.config.agents.find((/** @type {any} */ a) => a.id === job.agentId),
      ctx = this.worker.active.get(job.run?.runId);
    const permission = this.permission(source, ctx);
    if (permission) return permission;
    if (!this.ready || this.settings !== JSON.stringify(this.policy))
      return "GAME_SERVICE_UNAVAILABLE";
    if (!r.transports.get(a.connectionId)?.connected) return "QQ_NOT_CONNECTED";
    if (
      r.config.backends.find((/** @type {any} */ b) => b.id === a.backendId)
        ?.type !== "codex"
    )
      return "GAME_BACKEND_UNSUPPORTED";
    if (r.backendConnections.blocked.has(a.id)) return "BACKEND_UNAVAILABLE";
    for (const other of r.running.values())
      if (
        other !== ctx &&
        r.config.agents.find((/** @type {any} */ a) => a.id === other.agentId)
          ?.backendId === a.backendId
      )
        return "GAME_BACKEND_BUSY";
    for (const row of this.kernel.store.db
      .prepare("SELECT data FROM game_jobs WHERE status='outcome_unknown'")
      .all()) {
      const other = JSON.parse(row.data);
      if (
        r.config.agents.find((/** @type {any} */ a) => a.id === other.agentId)
          ?.backendId === a.backendId
      )
        return "GAME_OUTCOME_UNKNOWN";
    }
    return null;
  }
  refreshAccess() {
    if (!this.kernel) return;
    for (const row of this.kernel.store.db
      .prepare("SELECT id,data FROM game_host_rooms")
      .all()) {
      const source = JSON.parse(row.data);
      // Revocations fail closed even if the public child survives a bridge failure.
      source.access = !this.permission(
        source,
        [...this.worker.active.values()].find(
          (ctx) =>
            ctx.agentId === source.agentId &&
            ctx.source === source.conversation,
        ),
      );
      source.accessUntil = this.runtime.now() + 3000;
      this.kernel.store.db
        .prepare("UPDATE game_host_rooms SET data=? WHERE id=?")
        .run(JSON.stringify(source), row.id);
    }
  }
  status() {
    if (!this.kernel) return { enabled: this.policy.enabled, ready: false };
    const entry = this.kernel.store.db
      .prepare("SELECT data FROM game_entry WHERE id=1")
      .get();
    return {
      enabled: this.policy.enabled,
      ready: this.ready,
      origin:
        this.policy.publicOrigin || `http://127.0.0.1:${this.policy.port}`,
      externallyVerified: entry ? JSON.parse(entry.data).verified : false,
      jobs: this.kernel.store.db
        .prepare(
          "SELECT id,room_id,status,data FROM game_jobs ORDER BY rowid DESC LIMIT 100",
        )
        .all()
        .map((/** @type {any} */ row) => ({
          decisionId: row.id,
          roomId: row.room_id,
          status: row.status,
          reason: JSON.parse(row.data).reason,
        })),
      counts: this.kernel.store.db
        .prepare(
          "SELECT status,count(*) AS count FROM game_jobs GROUP BY status",
        )
        .all(),
    };
  }
  /** @param {string} challenge @param {boolean} external */
  verifyEntry(challenge, external) {
    this.ensure();
    const row = this.kernel.store.db
        .prepare("SELECT data FROM game_entry WHERE id=1")
        .get(),
      entry = row && JSON.parse(row.data);
    if (
      !this.policy.publicOrigin ||
      !entry ||
      !external ||
      entry.challenge !== challenge ||
      entry.publicOrigin !== this.policy.publicOrigin
    )
      fail("EXTERNAL_VERIFICATION_REQUIRED", 403);
    entry.verified = true;
    this.kernel.store.db
      .prepare("UPDATE game_entry SET data=? WHERE id=1")
      .run(JSON.stringify(entry));
    return { verified: true };
  }
  /** @param {any} ctx @param {string} eventId */
  authenticated(ctx, eventId) {
    const a = this.runtime.assertActive(ctx);
    const row = this.runtime.memory.db
      .prepare(
        "SELECT * FROM events WHERE id=? AND agent_id=? AND conversation=?",
      )
      .get(eventId, a.id, ctx.conversation);
    const payload = row && JSON.parse(row.payload);
    if (
      !row ||
      row.kind !== "message.received" ||
      row.direction === "out" ||
      !payload?.trustedInput ||
      !row.sender_id ||
      !(
        Array.isArray(payload.segments)
          ? payload.segments
              .filter((/** @type {any} */ s) => s.type === "text")
              .map((/** @type {any} */ s) => s.data.text || "")
              .join("")
              .trim()
          : row.body.trim()
      ).match(/^下五子棋[！!。]?$/)
    )
      fail("GAME_REQUEST_REQUIRED", 403);
    if (this.runtime.now() - Number(row.observed_at) > 600000)
      fail("GAME_REQUEST_EXPIRED", 403);
    return {
      agentId: a.id,
      connectionId: a.connectionId,
      accountId: this.runtime.connection(a.connectionId).accountId,
      backendId: a.backendId,
      conversation: ctx.conversation,
      senderId: row.sender_id,
      group: ctx.conversation.startsWith("group:"),
    };
  }
  /** @param {any} ctx @param {any} args */
  async create(ctx, args) {
    this.ensure();
    const source = this.authenticated(ctx, args.eventId),
      reason = this.permission(source, ctx);
    if (reason) fail(reason, 403);
    if (args.gameType !== "gomoku" || Object.keys(args.options || {}).length)
      fail("GAME_NOT_AVAILABLE", 400);
    if (!this.ready) fail("GAME_SERVICE_UNAVAILABLE", 503);
    if (
      (this.launch && !this.policy.publicOrigin) ||
      (this.policy.publicOrigin && !this.status().externallyVerified)
    )
      fail("EXTERNAL_VERIFICATION_REQUIRED", 403);
    const a = this.runtime.agent(source.agentId);
    if (
      this.runtime.config.backends.find(
        (/** @type {any} */ b) => b.id === a.backendId,
      )?.type !== "codex"
    )
      fail("GAME_BACKEND_UNSUPPORTED", 403);
    const principal =
      "qq:" +
      digest(
        JSON.stringify([
          source.connectionId,
          source.conversation,
          source.senderId,
        ]),
      );
    const requestKey = digest(JSON.stringify([source, args.requestId]));
    const previous = this.kernel.store.db
      .prepare("SELECT data FROM game_host_requests WHERE id=?")
      .get(requestKey);
    if (previous) return JSON.parse(previous.data).result;
    this.requestCapacity();
    const owner = this.kernel.actor(principal),
      { roomId } = this.kernel.createRoom(owner, {
        requestId: args.requestId,
        gameType: "gomoku",
        moduleVersion: "2",
        options: {},
        participants: [
          { principalId: principal, kind: "human", label: "玩家" },
          {
            principalId: "agent:" + a.id,
            kind: "ai",
            agentId: a.id,
            label: "AI 对手",
          },
        ],
      });
    this.kernel.store.db
      .prepare("INSERT OR IGNORE INTO game_host_rooms VALUES(?,?)")
      .run(
        roomId,
        JSON.stringify({
          ...source,
          access: true,
          accessUntil: this.runtime.now() + 3000,
        }),
      );
    const room = this.kernel.store.room(roomId);
    this.identity.confirmAgent(
      roomId,
      this.kernel.actor("agent:" + a.id),
      a.id,
    );
    let url =
      (this.policy.publicOrigin || `http://127.0.0.1:${this.policy.port}`) +
      "/rooms/" +
      roomId;
    if (!source.group) {
      const invitation = this.identity.invite(
        roomId,
        owner,
        room.participants[0].participantId,
      );
      url +=
        "?binding=" + invitation.bindingId + "&invite=" + invitation.invite;
    }
    const result = { roomId, delivery: "pending", requestId: args.requestId };
    // Persist before sending. A crash/unknown receipt never mints a replacement secret.
    this.kernel.store.db
      .prepare("INSERT INTO game_host_requests VALUES(?,?)")
      .run(
        requestKey,
        JSON.stringify({ createdAt: this.runtime.now(), result }),
      );
    try {
      const receipt = await this.runtime.send(
        ctx,
        {
          requestId: "game-invite:" + args.requestId,
          text:
            "五子棋邀请：" + url + "\n打开后在此会话发送网页显示的确认口令。",
        },
        { archiveBody: "[网页游戏邀请已投递；私密链接不进入聊天上下文]" },
      );
      result.delivery = "sent";
      Object.assign(result, { receipt });
    } catch {
      result.delivery = "unknown";
    }
    this.kernel.store.db
      .prepare("UPDATE game_host_requests SET data=? WHERE id=?")
      .run(
        JSON.stringify({ createdAt: this.runtime.now(), result }),
        requestKey,
      );
    return result;
  }
  /** @param {any} ctx @param {string} roomId */
  chatAccess(ctx, roomId) {
    this.ensure();
    const a = this.runtime.assertActive(ctx),
      source = this.source(roomId);
    if (source.agentId !== a.id || source.conversation !== ctx.conversation)
      fail("ROOM_UNAVAILABLE", 403);
    const reason = this.permission(source, ctx);
    if (reason) fail(reason, 403);
    return source;
  }
  /** @param {any} ctx @param {any} args */
  view(ctx, args) {
    this.chatAccess(ctx, args.roomId);
    return this.kernel.view(
      args.roomId,
      this.kernel.actor("agent:" + ctx.agentId),
    );
  }
  /** @param {any} ctx @param {any} args */
  closeRoom(ctx, args) {
    this.chatAccess(ctx, args.roomId);
    const room = this.kernel.store.room(args.roomId),
      key = "close:" + digest(JSON.stringify([args.roomId, args.requestId]));
    const old = this.kernel.store.db
      .prepare("SELECT data FROM game_host_requests WHERE id=?")
      .get(key);
    const action = old
      ? JSON.parse(old.data).action
      : {
          actionId: args.requestId,
          expectedRevision: room.revision,
          action: { type: "room.close", payload: {} },
        };
    if (!old) {
      this.requestCapacity();
    }
    if (!old)
      this.kernel.store.db
        .prepare("INSERT INTO game_host_requests VALUES(?,?)")
        .run(key, JSON.stringify({ createdAt: this.runtime.now(), action }));
    return this.kernel.act(room.id, this.kernel.actor(room.owner), action);
  }
  /** Trusted transport intake, before any model is woken. @param {any} a @param {any} e @param {any} archived */
  async command(a, e, archived) {
    const match =
      /确认游戏\s+([a-f0-9-]{36})\s+([a-f0-9-]{36})\s+([A-Za-z0-9_-]{43})/.exec(
        e.body,
      );
    const create = /^下五子棋[！!。]?$/.test(
      e.segments
        .filter((/** @type {any} */ s) => s.type === "text")
        .map((/** @type {any} */ s) => s.data?.text || "")
        .join("")
        .trim(),
    );
    if (!match && !create) return false;
    if (!this.policy.enabled || !a.games.enabled) return !!match;
    if (this.runtime.blockers(a, e.conversation).length) return true;
    this.ensure();
    if (match) {
      try {
        const source = this.source(match[1]);
        if (
          source.agentId !== a.id ||
          source.connectionId !== a.connectionId ||
          source.conversation !== e.conversation ||
          source.senderId !== e.senderId
        )
          return true;
        const room = this.kernel.store.room(match[1]);
        this.identity.confirm(
          match[1],
          match[2],
          match[3],
          this.kernel.actor(room.owner),
        );
      } catch {
        /* The browser retains an unconfirmed state for invalid QQ proofs. */
      }
      return true;
    }
    if (
      e.conversation.startsWith("group:") &&
      !this.runtime.conversations.addressed(
        a,
        e,
        this.runtime.connection(a.connectionId).accountId,
      )
    )
      return false;
    await this.runtime.withContext(
      a.id,
      e.conversation,
      async (/** @type {any} */ ctx) => {
        await this.create(ctx, {
          eventId: archived.id,
          requestId: randomUUID(),
          gameType: "gomoku",
          options: {},
        }).catch(async (/** @type {any} */ error) => {
          const code = /^[A-Z_]+$/.test(error.message)
            ? error.message
            : "GAME_CREATE_UNAVAILABLE";
          await this.runtime
            .send(ctx, {
              requestId: "game-unavailable:" + archived.id,
              text:
                "暂时无法创建游戏：" +
                code +
                "。请联系部署者检查游戏入口与角色设置。",
            })
            .catch(() => {});
        });
      },
    );
    return true;
  }
  requestCapacity() {
    // Tombstones outlive the short source ticket, so expiry cannot silently recreate a room.
    this.kernel.store.db
      .prepare(
        "DELETE FROM game_host_requests WHERE json_extract(data,'$.createdAt')<?",
      )
      .run(this.runtime.now() - 7 * 86400000);
    if (
      Number(
        this.kernel.store.db
          .prepare("SELECT count(*) AS n FROM game_host_requests")
          .get().n,
      ) >= 4096
    )
      fail("GAME_REQUEST_CAPACITY", 429);
  }
  /** @param {string} backendId */
  busy(backendId) {
    return (
      [...this.worker.active.values()].some(
        (ctx) => ctx.backendId === backendId,
      ) ||
      (this.kernel &&
        this.kernel.store.db
          .prepare("SELECT data FROM game_jobs WHERE status='outcome_unknown'")
          .all()
          .some(
            (/** @type {any} */ row) =>
              this.runtime.config.agents.find(
                (/** @type {any} */ a) => a.id === JSON.parse(row.data).agentId,
              )?.backendId === backendId,
          ))
    );
  }
  tick() {
    if (this.closed) return;
    if (!this.policy.enabled) {
      this.refreshAccess();
      for (const ctx of this.worker.active.values()) ctx.controller.abort();
      return;
    }
    this.ensure();
    this.refreshAccess();
    for (const [runId, ctx] of this.worker.active) {
      const row = this.kernel.store.db
        .prepare(
          "SELECT id FROM game_jobs WHERE json_extract(data,'$.run.runId')=?",
        )
        .get(runId);
      if (!row || this.gate(this.jobs.get(row.id))) ctx.controller.abort();
    }
    if (this.pumping) return;
    this.pumping = true;
    this.runtime.trackJob(
      this.pump().finally(() => {
        this.pumping = false;
      }),
      "games",
    );
  }
  /** An administrator may retry only after exact native terminal proof. @param {string} id */
  async retry(id) {
    this.ensure();
    const job = this.jobs.get(id);
    if (job.run && !job.run.terminal) {
      const backend = this.runtime.backendConnections.adapter(
        this.runtime.agent(job.agentId),
      );
      if ((await backend.gameRunState?.(job.run))?.terminal !== true)
        fail("GAME_OUTCOME_UNKNOWN", 409);
      this.jobs.settle(job.run, { terminal: true, code: "GAME_RUN_TERMINAL" });
    }
    if (!this.jobs.current(this.jobs.get(id))) return { status: "invalidated" };
    this.jobs.receive(id);
    const task = this.worker.run(id);
    this.runtime.trackWork(task);
    await task;
    return this.jobs.publicStatus(job.roomId);
  }
  async pump() {
    this.kernel.sweep();
    await this.jobs.dispatch(async (/** @type {string} */ id) =>
      this.jobs.receive(id),
    );
    for (const row of this.kernel.store.db
      .prepare("SELECT id FROM game_jobs WHERE status IN ('queued','blocked')")
      .all()) {
      const job = this.jobs.get(row.id);
      if (!this.jobs.current(job)) continue;
      const task = this.worker.run(row.id).catch(() => {});
      this.runtime.trackWork(task);
    }
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    if (this.child) {
      if (this.child.connected) this.child.disconnect();
      await new Promise((resolve) => {
        if (
          this.child.exitCode !== null ||
          this.child.signalCode !== null ||
          !this.child.pid
        )
          return resolve(null);
        this.child.once("exit", resolve);
      });
    }
    this.kernel?.close();
  }
}
/** Redact before persistence, including gateway echoes whose delivery outcome is unknown. @param {string} body */
export function sensitiveGameMessage(body) {
  return /确认游戏\s+[a-f0-9-]{36}|\/rooms\/[a-f0-9-]{36}\?[^\s]*invite=/.test(
    body,
  );
}
