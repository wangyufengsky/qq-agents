// @ts-check
import { randomUUID, randomBytes } from "node:crypto";
import { z } from "zod";
import { GameStore } from "./store.mjs";
import { limits, moduleOutput } from "./registry.mjs";
import {
  bounded,
  canonical,
  digest,
  fail,
  immutable,
  parse,
} from "./value.mjs";

const id = z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/);
const participant = z.strictObject({
  principalId: id,
  kind: z.enum(["human", "ai"]),
  agentId: id.optional(),
  label: z.string().min(1).max(64),
});
const creation = z.strictObject({
  requestId: z.uuid(),
  gameType: z.string(),
  moduleVersion: z.string(),
  options: z.unknown(),
  participants: z.array(participant).min(1).max(8),
});
export const actionSchema = z.strictObject({
  actionId: z.uuid(),
  expectedRevision: z
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER - 1),
  action: z.strictObject({ type: z.string().max(64), payload: z.unknown() }),
});
const outcomeSchema = z.strictObject({
  kind: z.enum(["win", "draw", "loss"]),
  winners: z.array(z.string()).max(8),
  reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
  details: z.unknown(),
});
const decisionSchema = z.string().nullable();
export const durations = Object.freeze({
  waiting: 15 * 60_000,
  active: 30 * 60_000,
  paused: 24 * 60 * 60_000,
  retained: 24 * 60 * 60_000,
});

export class GameKernel {
  /** @type {import("../framework/jobs.mjs").GameJobs | null} */
  ai = null;
  /** @type {WeakMap<object,string>} */
  #actors = new WeakMap();
  /** @param {{database:string,registry:import('./registry.mjs').GameRegistry,clock?:()=>number,allow?:(principal:string,roomId:string)=>boolean,maxRooms?:number,maxHistoryRooms?:number}} options */
  constructor({
    database,
    registry,
    clock = Date.now,
    allow = () => true,
    maxRooms = 64,
    maxHistoryRooms = 1024,
  }) {
    this.store = new GameStore(database, clock);
    this.registry = registry;
    this.clock = clock;
    this.allow = allow;
    this.maxHistoryRooms = parse(
      z.number().int().min(1).max(16384),
      maxHistoryRooms,
    );
    this.maxRooms = parse(z.number().int().min(1).max(4096), maxRooms);
  }
  /** Host-only authentication boundary: never expose this issuer as an HTTP endpoint.
   * @param {string} principalId */
  actor(principalId) {
    parse(id, principalId);
    const actor = Object.freeze({});
    this.#actors.set(actor, principalId);
    return actor;
  }
  /** @param {object} actor */
  principal(actor) {
    const principal = this.#actors.get(actor);
    if (!principal) fail("AUTH_REQUIRED", 401);
    return principal;
  }
  /** @param {any} room @param {object} actor */
  access(room, actor) {
    const principal = this.principal(actor);
    const member = room.participants.find(
      (/** @type {any} */ p) => p.principalId === principal,
    );
    if (
      !this.allow(principal, room.id) ||
      member?.revoked ||
      (!member && room.owner !== principal)
    )
      fail("ROOM_UNAVAILABLE", 403);
    return { principal, member, owner: room.owner === principal };
  }
  /** @param {any} room */
  roster(room) {
    return room.participants.map((/** @type {any} */ p) => ({
      participantId: p.participantId,
      seat: p.seat,
      kind: p.kind,
      label: p.label,
    }));
  }
  /** @param {any} room */
  moduleConfig(room) {
    return immutable({
      participants: this.roster(room),
      options: JSON.parse(canonical(room.options)),
    });
  }
  /** @param {object} actor @param {unknown} input */
  createRoom(actor, input) {
    const principal = this.principal(actor),
      request = parse(creation, input),
      fingerprint = digest(bounded(request, limits.action));
    return this.store.transaction(() => {
      this.store.db
        .prepare(
          "DELETE FROM game_creations WHERE (principal,request_id) IN (SELECT principal,request_id FROM game_creation_expiries WHERE expires_at<=?)",
        )
        .run(this.clock());
      const previous = this.store.db
        .prepare(
          "SELECT * FROM game_creations WHERE principal=? AND request_id=?",
        )
        .get(principal, request.requestId);
      if (previous) {
        if (previous.digest !== fingerprint) fail("IDEMPOTENCY_CONFLICT");
        const room = this.store.room(String(previous.room_id));
        this.access(room, actor);
        return { roomId: room.id };
      }
      if (
        Number(
          this.store.db
            .prepare(
              "SELECT count(*) AS n FROM game_rooms WHERE json_extract(data,'$.lifecycle') IN ('waiting','active','paused')",
            )
            .get()?.n,
        ) >= this.maxRooms ||
        Number(
          this.store.db
            .prepare("SELECT count(*) AS n FROM game_creations")
            .get()?.n,
        ) >= 4096
      )
        fail("ROOM_CAPACITY");
      const module = this.registry.select(
          request.gameType,
          request.moduleVersion,
        ),
        policy = module.manifest.participants;
      const members = request.participants;
      if (
        members.length < policy.min ||
        members.length > policy.max ||
        new Set(members.map((/** @type {any} */ p) => p.principalId)).size !==
          members.length
      )
        fail("INVALID_PARTICIPANTS", 400);
      const agents = new Set();
      for (const p of members) {
        if (
          !policy.kinds.includes(p.kind) ||
          (p.kind === "ai") !== !!p.agentId ||
          (p.agentId && agents.has(p.agentId))
        )
          fail("INVALID_PARTICIPANTS", 400);
        if (p.agentId) agents.add(p.agentId);
      }
      const now = this.clock(),
        room = {
          id: randomUUID(),
          owner: principal,
          moduleRef: module.ref,
          options: parse(module.schemas.options, request.options),
          participants: members.map(
            (/** @type {any} */ p, /** @type {number} */ seat) => ({
              ...p,
              participantId: randomUUID(),
              seat,
              confirmed: false,
              revoked: false,
            }),
          ),
          lifecycle: "waiting",
          revision: 0,
          eventSeq: 0,
          actionCount: 0,
          state: null,
          outcome: null,
          closeReason: null,
          decision: null,
          createdAt: now,
          deadline: now + durations.waiting,
          deleteAt: null,
        };
      bounded(room.options, limits.action);
      if (!this.allow(principal, room.id)) fail("GAME_BLOCKED", 403);
      this.store.db
        .prepare("INSERT INTO game_rooms VALUES(?,?)")
        .run(room.id, JSON.stringify(room));
      this.store.db
        .prepare("INSERT INTO game_creations VALUES(?,?,?,?)")
        .run(principal, request.requestId, fingerprint, room.id);
      this.store.db
        .prepare("INSERT INTO game_creation_expiries VALUES(?,?,?)")
        .run(principal, request.requestId, now + 7 * 86400000);
      return { roomId: room.id };
    });
  }
  /** @param {any} room @param {string} type */
  notify(room, type) {
    room.eventSeq++;
    this.store.db.prepare("INSERT INTO game_events VALUES(?,?,?)").run(
      room.id,
      room.eventSeq,
      JSON.stringify({
        type,
        eventSeq: room.eventSeq,
        revision: room.revision,
      }),
    );
    this.store.db
      .prepare("DELETE FROM game_events WHERE room_id=? AND seq<=?")
      .run(room.id, room.eventSeq - 256);
  }
  /** @param {any} room @param {string|null} next */
  decision(room, next) {
    this.store.db
      .prepare(
        "UPDATE game_decisions SET status='invalidated' WHERE room_id=? AND status IN ('blocked','queued')",
      )
      .run(room.id);
    room.decision = null;
    if (room.lifecycle !== "active" || next === null) return;
    const p = room.participants.find(
      (/** @type {any} */ p) => p.participantId === next,
    );
    room.decision = {
      decisionId: randomUUID(),
      participantId: next,
      sourceRevision: room.revision,
    };
    if (p.kind === "ai") {
      const job = {
        ...room.decision,
        roomId: room.id,
        agentId: p.agentId,
        moduleRef: room.moduleRef,
        reason: this.ai ? null : "P2_NOT_IMPLEMENTED",
      };
      this.store.db
        .prepare("INSERT INTO game_decisions VALUES(?,?,?,?)")
        .run(
          job.decisionId,
          room.id,
          this.ai ? "queued" : "blocked",
          JSON.stringify(job),
        );
      this.ai?.enqueue(job);
    }
  }
  /** @param {any} room @param {string} type */
  systemTransition(room, type) {
    room.revision++;
    room.lifecycle = type === "room.paused" ? "paused" : "expired";
    room.deadline = this.clock() + durations.paused;
    if (room.lifecycle === "expired") {
      room.closeReason = "EXPIRED";
      room.deleteAt = this.clock() + durations.retained;
    }
    this.decision(room, null);
    this.notify(room, type);
    this.store.save(room);
  }
  /** Expiry is an explicit durable system event, never a rule callback from view/poll.
   * @param {string} [roomId] */
  sweep(roomId) {
    return this.store.transaction(() => {
      this.store.db
        .prepare(
          "DELETE FROM game_creations WHERE (principal,request_id) IN (SELECT principal,request_id FROM game_creation_expiries WHERE expires_at<=?)",
        )
        .run(this.clock());
      const rows = roomId
        ? [{ id: roomId }]
        : this.store.db.prepare("SELECT id FROM game_rooms").all();
      for (const row of rows) {
        const room = this.store.room(String(row.id));
        if (room.deleteAt !== null && room.deleteAt <= this.clock()) {
          if (this.ai?.unresolved(room.id)) continue;
          this.store.db
            .prepare("DELETE FROM game_rooms WHERE id=?")
            .run(room.id);
          continue;
        }
        if (
          ["waiting", "active", "paused"].includes(room.lifecycle) &&
          room.deadline <= this.clock()
        )
          this.systemTransition(
            room,
            room.lifecycle === "active" ? "room.paused" : "room.expired",
          );
      }
      const history = this.store.db
        .prepare(
          "SELECT id FROM game_rooms WHERE json_extract(data,'$.lifecycle') IN ('finished','expired') ORDER BY json_extract(data,'$.deleteAt') DESC",
        )
        .all();
      for (const row of history.slice(this.maxHistoryRooms)) {
        if (!this.ai?.unresolved(String(row.id)))
          this.store.db
            .prepare("DELETE FROM game_rooms WHERE id=?")
            .run(row.id);
      }
    });
  }
  /** @param {any} room @param {boolean} [requireCurrent] */
  checkTime(room, requireCurrent = true) {
    if (room.deleteAt !== null && room.deleteAt <= this.clock())
      fail("ROOM_UNAVAILABLE", 410);
    if (
      requireCurrent &&
      ["waiting", "active", "paused"].includes(room.lifecycle) &&
      room.deadline <= this.clock()
    )
      fail("ROOM_DEADLINE_REACHED", 409);
  }
  /** @param {any} room @param {any} module */
  outputs(room, module) {
    const state = immutable(JSON.parse(canonical(room.state))),
      roster = immutable(this.roster(room));
    const next = moduleOutput(
      () => module.nextActor(state, roster),
      decisionSchema,
      1024,
    );
    const outcome = moduleOutput(
      () => module.outcome(state, roster),
      outcomeSchema.nullable(),
      module.manifest.limits.view,
    );
    if (
      next !== null &&
      !roster.some((/** @type {any} */ p) => p.participantId === next)
    )
      fail("GAME_MODULE_INVALID_RESULT", 500);
    if ((next === null) === (outcome === null))
      fail("GAME_MODULE_INVALID_RESULT", 500);
    if (outcome) {
      parse(module.schemas.outcome, outcome, "GAME_MODULE_INVALID_RESULT");
      if (
        new Set(outcome.winners).size !== outcome.winners.length ||
        outcome.winners.some(
          (/** @type {string} */ p) =>
            !roster.some((/** @type {any} */ r) => r.participantId === p),
        ) ||
        (outcome.kind === "win") !== outcome.winners.length > 0
      )
        fail("GAME_MODULE_INVALID_RESULT", 500);
    }
    // Validate every participant projection before committing, including hidden-state consumers.
    for (const p of roster) this.project(room, module, p.participantId);
    return { next, outcome };
  }
  /** @param {any} room @param {any} module */
  validateState(room, module) {
    if (room.state !== null)
      moduleOutput(
        () => room.state,
        module.schemas.state,
        module.manifest.limits.state,
      );
  }
  /** @param {any} room @param {any} module @param {string} participantId */
  project(room, module, participantId) {
    return moduleOutput(
      () =>
        module.projectView(
          immutable(JSON.parse(canonical(room.state))),
          immutable({ kind: "participant", participantId }),
          this.moduleConfig(room),
        ),
      module.schemas.view,
      module.manifest.limits.view,
    );
  }
  /** @param {string} roomId @param {object} actor */
  view(roomId, actor) {
    const room = this.store.room(roomId),
      access = this.access(room, actor);
    this.checkTime(room);
    const module = this.registry.resolve(room.moduleRef);
    this.validateState(room, module);
    if (access.member && !access.member.confirmed) fail("JOIN_REQUIRED", 403);
    return {
      roomId: room.id,
      moduleRef: room.moduleRef,
      lifecycle: room.lifecycle,
      revision: room.revision,
      eventSeq: room.eventSeq,
      participants: this.roster(room),
      viewer: access.member?.participantId ?? null,
      owner: access.owner,
      readyToStart:
        room.lifecycle === "waiting" &&
        room.participants.every(
          (/** @type {any} */ p) => p.confirmed && !p.revoked,
        ),
      decision: room.decision,
      closeReason: room.closeReason,
      snapshotAt: this.clock(),
      view:
        room.state !== null && access.member
          ? this.project(room, module, access.member.participantId)
          : null,
      ...(this.ai ? { execution: this.ai.publicStatus(roomId) } : {}),
    };
  }
  /** @param {string} roomId @param {object} actor @param {unknown} input @param {any} [execution] */
  act(roomId, actor, input, execution = null) {
    const request = parse(actionSchema, input),
      fingerprint = digest(bounded(request, limits.action));
    return this.store.transaction(() => {
      const room = this.store.room(roomId),
        access = this.access(room, actor);
      this.checkTime(room, false);
      const previous = this.store.db
        .prepare(
          "SELECT digest,receipt FROM game_receipts WHERE room_id=? AND principal=? AND action_id=?",
        )
        .get(roomId, access.principal, request.actionId);
      if (previous) {
        if (previous.digest !== fingerprint) fail("IDEMPOTENCY_CONFLICT");
        return JSON.parse(String(previous.receipt));
      }
      this.checkTime(room);
      if (access.member?.kind === "ai") {
        if (!this.ai) fail("P2_NOT_IMPLEMENTED", 403);
        this.ai.validate(room, access.member, execution);
        if (request.action.type.startsWith("room."))
          fail("AI_CONTROL_DENIED", 403);
      }
      if (room.lifecycle === "expired" || room.lifecycle === "finished")
        fail("ROOM_CLOSED");
      if (room.revision !== request.expectedRevision) fail("REVISION_CONFLICT");
      if (
        room.actionCount >= limits.actions &&
        request.action.type !== "room.close"
      )
        fail("GAME_ACTION_LIMIT");
      const module = this.registry.resolve(room.moduleRef),
        type = request.action.type;
      this.validateState(room, module);
      bounded(request, module.manifest.limits.action);
      const context = immutable({
        at: this.clock(),
        random: randomBytes(module.manifest.limits.random).toString("hex"),
      });
      let next = null;
      if (type.startsWith("room.")) {
        parse(z.strictObject({}), request.action.payload);
        if (!access.owner) fail("ROOM_CONTROL_DENIED", 403);
        if (type === "room.start") {
          if (
            room.lifecycle !== "waiting" ||
            room.participants.some(
              (/** @type {any} */ p) =>
                !p.confirmed || p.revoked || !this.allow(p.principalId, roomId),
            )
          )
            fail("ROOM_NOT_READY");
          room.state = moduleOutput(
            () =>
              module.create(
                immutable(JSON.parse(canonical(room.options))),
                immutable(this.roster(room)),
                context,
              ),
            module.schemas.state,
            module.manifest.limits.state,
          );
          room.lifecycle = "active";
        } else if (type === "room.pause") {
          if (room.lifecycle !== "active") fail("ROOM_STATE_CONFLICT");
          room.lifecycle = "paused";
        } else if (type === "room.resume") {
          if (
            room.lifecycle !== "paused" ||
            room.participants.some(
              (/** @type {any} */ p) =>
                p.revoked || !this.allow(p.principalId, roomId),
            )
          )
            fail("ROOM_NOT_READY");
          room.lifecycle = "active";
        } else if (type === "room.close") {
          room.lifecycle = "finished";
          room.closeReason = "CLOSED_BY_OWNER";
        } else fail("UNKNOWN_ACTION", 400);
      } else {
        if (room.lifecycle !== "active") fail("ROOM_NOT_ACTIVE");
        if (!access.member?.confirmed) fail("JOIN_REQUIRED", 403);
        if (room.decision?.participantId !== access.member.participantId)
          fail("NOT_YOUR_TURN");
        const schema = Object.hasOwn(module.schemas.actions, type)
          ? module.schemas.actions[type]
          : null;
        if (!schema) fail("UNKNOWN_ACTION", 400);
        const payload = parse(schema, request.action.payload);
        // Rule rejection is a fixed result, never an exception containing private state.
        const result = moduleOutput(
          () =>
            module.applyAction(
              immutable(JSON.parse(canonical(room.state))),
              access.member.participantId,
              immutable({ type, payload }),
              context,
            ),
          z.union([
            z.strictObject({ rejected: z.literal(true) }),
            z.strictObject({ state: module.schemas.state }),
          ]),
          module.manifest.limits.state + 64,
        );
        if (result.rejected) fail("GAME_ACTION_REJECTED");
        room.state = moduleOutput(
          () => result.state,
          module.schemas.state,
          module.manifest.limits.state,
        );
      }
      if (room.lifecycle === "active") {
        const output = this.outputs(room, module);
        next = output.next;
        room.outcome = output.outcome;
        if (room.outcome) room.lifecycle = "finished";
      }
      room.revision++;
      room.actionCount++;
      room.deadline =
        this.clock() +
        (room.lifecycle === "paused" ? durations.paused : durations.active);
      if (room.lifecycle === "finished")
        room.deleteAt = this.clock() + durations.retained;
      this.decision(room, next);
      this.notify(room, "view_changed");
      this.store.save(room);
      const receipt = {
        actionId: request.actionId,
        revision: room.revision,
        eventSeq: room.eventSeq,
        accepted: true,
      };
      this.store.db
        .prepare("INSERT INTO game_receipts VALUES(?,?,?,?,?,?)")
        .run(
          roomId,
          access.principal,
          request.actionId,
          fingerprint,
          JSON.stringify(receipt),
          JSON.stringify({ request, context }),
        );
      return receipt;
    });
  }
  /** @param {string} roomId @param {object} actor @param {string} actionId */
  receipt(roomId, actor, actionId) {
    const room = this.store.room(roomId),
      { principal } = this.access(room, actor);
    this.checkTime(room, false);
    const row = this.store.db
      .prepare(
        "SELECT receipt FROM game_receipts WHERE room_id=? AND principal=? AND action_id=?",
      )
      .get(roomId, principal, actionId);
    if (!row) fail("ACTION_UNCONFIRMED", 404);
    return JSON.parse(String(row.receipt));
  }
  /** @param {string} roomId @param {object} actor @param {number} after */
  events(roomId, actor, after) {
    const room = this.store.room(roomId),
      { member, owner } = this.access(room, actor);
    this.checkTime(room);
    if (!owner && !member?.confirmed) fail("JOIN_REQUIRED", 403);
    if (!Number.isSafeInteger(after) || after < 0 || after > room.eventSeq)
      fail("INVALID_CURSOR", 400);
    if (after < Math.max(0, room.eventSeq - 256))
      fail("SNAPSHOT_REQUIRED", 409);
    return this.store.db
      .prepare(
        "SELECT data FROM game_events WHERE room_id=? AND seq>? ORDER BY seq LIMIT 128",
      )
      .all(roomId, after)
      .map((r) => JSON.parse(String(r.data)));
  }
  /** @param {string} roomId @param {object} owner @param {string} participantId */
  revoke(roomId, owner, participantId) {
    return this.store.transaction(() => {
      const room = this.store.room(roomId);
      if (!this.access(room, owner).owner) fail("ROOM_CONTROL_DENIED", 403);
      const p = room.participants.find(
        (/** @type {any} */ p) => p.participantId === participantId,
      );
      if (!p) fail("INVALID_PARTICIPANT", 400);
      if (p.revoked) return;
      p.revoked = true;
      this.store.db
        .prepare(
          "DELETE FROM game_sessions WHERE room_id=? AND json_extract(data,'$.principalId')=?",
        )
        .run(roomId, p.principalId);
      this.store.db
        .prepare(
          "DELETE FROM game_bindings WHERE room_id=? AND json_extract(data,'$.principalId')=?",
        )
        .run(roomId, p.principalId);
      room.revision++;
      if (room.lifecycle === "active") {
        room.lifecycle = "paused";
        room.deadline = this.clock() + durations.paused;
      }
      this.decision(room, null);
      this.notify(room, "access_changed");
      this.store.save(room);
    });
  }
  close() {
    this.store.close();
  }
}
