import { randomUUID } from "node:crypto";
import { z } from "zod";
import { allowed } from "../core/config.mjs";
import { presentationVersion } from "../core/input-review.mjs";
import { rhythmStatus } from "../core/rhythm.mjs";
import { roleRest, subjectInboxEnabled } from "../core/role-rest.mjs";
import { gardenPauseReason, performGardenAction } from "./garden-console.mjs";
import { HOUR, PLOT_COUNT } from "./garden-rules.mjs";

const SUBJECT = "@subject";
const active = new Set(["queued", "processing", "partial"]);
const delegationRef = z.strictObject({ delegationId: z.uuid() });
const submitArgs = z.strictObject({
  eventId: z.uuid(),
  plot: z.number().int().min(1).max(PLOT_COUNT).optional(),
});

export function gardenDelegationScope(conversation) {
  return /^private:\d+$/.test(conversation || "");
}

function receipt(row) {
  return {
    id: row.id,
    status: row.status,
    revision: row.revision,
    ...(row.plot !== null && { plot: row.plot }),
    expiresAtGardenHour: row.expires_clock / HOUR,
    targets: (JSON.parse(row.targets) || []).map(
      ({ plot, status, water, reason }) => ({
        plot,
        status:
          status === "pending" && !active.has(row.status) ? row.status : status,
        ...(water !== undefined && { water }),
        ...(reason && { reason }),
      }),
    ),
  };
}

export class GardenDelegations {
  constructor(runtime, home) {
    this.runtime = runtime;
    this.garden = home.garden;
    this.db = runtime.memory.db;
  }

  isAdmin(agent, source) {
    return (
      gardenDelegationScope(source) &&
      agent.ownerIds.includes(source.slice(8)) &&
      allowed(agent, source, this.runtime.config)
    );
  }

  scope(ctx, subject) {
    const r = this.runtime;
    const agent = r.subjectInbox.assertScope(ctx, subject);
    if (
      ctx.runtimeKind ||
      ctx.desktopScreenObserved ||
      ctx.desktopPrivateObservation
    )
      throw Error("TOOL_DISABLED");
    r.subjectInbox.assertSource(agent, ctx);
    if (!subject && !this.isAdmin(agent, ctx.conversation))
      throw Error("GARDEN_DELEGATION_SOURCE_DENIED");
    if (!this.garden.initialized()) throw Error("GARDEN_NOT_INITIALIZED");
    if (
      subject &&
      (!ctx.turnId || r.running.get(agent.id + "|" + SUBJECT) !== ctx)
    )
      throw Error("GARDEN_TURN_REQUIRED");
    return { agent, generation: r.home.generation(agent.id), now: r.now() };
  }

  authority(agent, source, eventId) {
    if (!this.isAdmin(agent, source)) return null;
    const row = this.runtime.subject.reminderSource(agent, source, eventId);
    return row?.sender_id === source.slice(8) ? row : null;
  }

  state(now) {
    return this.garden.snapshot(now, !gardenPauseReason(this.runtime));
  }

  running(state) {
    return state.running && !gardenPauseReason(this.runtime);
  }

  canManage(agent, generation) {
    return (
      subjectInboxEnabled(agent) &&
      this.garden.allowsRole(agent.id, generation) &&
      this.runtime.toolsFor(agent, SUBJECT).includes("garden_act")
    );
  }

  read(generation, id) {
    const row = this.db
      .prepare("SELECT * FROM garden_delegations WHERE generation=? AND id=?")
      .get(generation, id);
    if (!row) throw Error("GARDEN_DELEGATION_NOT_FOUND");
    return row;
  }

  save(row, status, targets, now) {
    this.db
      .prepare(
        "UPDATE garden_delegations SET status=?,targets=?,updated_at=?,revision=revision+1 WHERE id=?",
      )
      .run(
        status,
        targets === null ? null : JSON.stringify(targets),
        now,
        row.id,
      );
    return this.read(row.generation, row.id);
  }

  refresh(agent, row, state, now) {
    if (!active.has(row.status)) return row;
    const status =
      state.clock >= row.expires_clock
        ? "expired"
        : !this.canManage(agent, row.generation) ||
            !this.authority(agent, row.source, row.event_id)
          ? "dropped"
          : row.status;
    return status === row.status
      ? row
      : this.save(row, status, JSON.parse(row.targets), now);
  }

  submit(ctx, requestId, input) {
    const { agent, generation, now } = this.scope(ctx, false);
    const { eventId, plot = null } = submitArgs.parse(input);
    const source = ctx.conversation,
      r = this.runtime;
    const event = this.authority(agent, source, eventId);
    if (!event) throw Error("GARDEN_DELEGATION_SOURCE_DENIED");
    return r.memory.transaction(() => {
      const state = this.state(now);
      const prior = this.db
        .prepare(
          `SELECT d.* FROM garden_delegation_requests q JOIN garden_delegations d ON d.id=q.delegation_id
         WHERE q.generation=? AND q.source=? AND q.request_id=?`,
        )
        .get(generation, source, requestId);
      const sameEvent =
        prior ||
        this.db
          .prepare(
            "SELECT * FROM garden_delegations WHERE generation=? AND source=? AND event_id=?",
          )
          .get(generation, source, eventId);
      if (
        sameEvent &&
        (sameEvent.event_id !== eventId || sameEvent.plot !== plot)
      )
        throw Error("GARDEN_REQUEST_CONFLICT");
      let row = sameEvent;
      if (!row) {
        const version = presentationVersion(r, ctx, eventId);
        if (!version || ctx.presentedInput?.get(eventId) !== version)
          throw Error("GARDEN_DELEGATION_SOURCE_DENIED");
        r.subjectInbox.assertSource(
          agent,
          ctx,
          r.memory.bind(agent.id).event(event, source),
        );
        if (!this.canManage(agent, generation))
          throw Error("GARDEN_ROLE_UNAVAILABLE");
        const open = this.activeRows(generation).filter((row) =>
          active.has(this.refresh(agent, row, state, now).status),
        );
        if (open.length >= 64) throw Error("SUBJECT_INBOX_FULL");
        const id = randomUUID();
        this.db
          .prepare(
            `INSERT INTO garden_delegations(id,generation,source,event_id,plot,created_at,expires_clock,updated_at)
           VALUES(?,?,?,?,?,?,?,?)`,
          )
          .run(
            id,
            generation,
            source,
            eventId,
            plot,
            now,
            state.clock + state.settings.delegationHours * HOUR,
            now,
          );
        row = this.read(generation, id);
      }
      if (!prior)
        this.db
          .prepare(
            "INSERT INTO garden_delegation_requests(generation,source,request_id,delegation_id) VALUES(?,?,?,?)",
          )
          .run(generation, source, requestId, row.id);
      return {
        ...receipt(this.refresh(agent, row, state, now)),
        duplicate: !!sameEvent,
        paused: !this.running(state),
      };
    });
  }

  origin(ctx, kind, input) {
    const { agent, generation, now } = this.scope(ctx, false);
    const { delegationId } = delegationRef.parse(input);
    return this.runtime.memory.transaction(() => {
      let row = this.read(generation, delegationId);
      if (row.source !== ctx.conversation)
        throw Error("GARDEN_DELEGATION_NOT_FOUND");
      row = this.refresh(agent, row, this.state(now), now);
      if (kind === "delegate_cancel" && active.has(row.status))
        row = this.save(row, "cancelled", JSON.parse(row.targets), now);
      return receipt(row);
    });
  }

  execute(ctx, kind, requestId, input) {
    const { agent, generation, now } = this.scope(ctx, true);
    const { delegationId } = delegationRef.parse(input);
    return this.runtime.memory.transaction(() => {
      const state = this.state(now);
      let row = this.refresh(
        agent,
        this.read(generation, delegationId),
        state,
        now,
      );
      const prior = this.db
        .prepare(
          "SELECT delegation_id,kind,result FROM garden_delegation_steps WHERE generation=? AND request_id=?",
        )
        .get(generation, requestId);
      if (prior) {
        if (prior.delegation_id !== row.id || prior.kind !== kind)
          throw Error("GARDEN_REQUEST_CONFLICT");
        // Show current status on retry, even if the origin withdrew in the meantime.
        return {
          ...receipt(row),
          step: JSON.parse(prior.result),
          duplicate: true,
        };
      }
      if (!active.has(row.status)) return receipt(row);
      const r = this.runtime;
      if (
        !this.running(state) ||
        !r.writable(agent, row.source) ||
        roleRest(r, agent) ||
        rhythmStatus(r, agent, true).state === "sleeping"
      )
        throw Error("GARDEN_PAUSED");
      const targets = JSON.parse(row.targets);
      let step;
      if (kind === "delegate_dismiss")
        row = this.save(row, "dropped", targets, now);
      else ({ row, step } = this.water(ctx, row, state, now, targets));
      this.db
        .prepare("INSERT INTO garden_delegation_steps VALUES(?,?,?,?,?)")
        .run(generation, requestId, row.id, kind, JSON.stringify(step ?? null));
      return { ...receipt(row), step };
    });
  }

  water(ctx, row, state, now, targets) {
    const first = targets === null;
    targets ??= this.targets(row, state);
    const wateredSinceLock = this.db.prepare(
      "SELECT 1 FROM garden_actions WHERE seq>? AND action='water' AND json_extract(result,'$.plantId')=? LIMIT 1",
    );
    let step;
    const lookup = new Map(state.plots.map(({ id, plant }) => [id, plant]));
    for (const target of targets) {
      if (target.status !== "pending") continue;
      const plant = lookup.get(target.plot);
      if (!plant || plant.id !== target.plantId || plant.status !== "growing") {
        Object.assign(target, { status: "skipped", reason: "plant_changed" });
      } else if (
        wateredSinceLock.get(target.lockSequence, target.plantId) ||
        plant.water >= (row.plot === null ? plant.rules.lowWater : 100)
      ) {
        Object.assign(target, { status: "skipped", reason: "already_watered" });
      } else if (
        step ||
        this.garden.turnUsed(ctx.agentId, ctx.turnId) >=
          state.settings.turnLimit
      ) {
        break;
      } else {
        const result = performGardenAction(
          this.runtime,
          { kind: "agent", id: ctx.agentId, turnId: ctx.turnId },
          {
            requestId: randomUUID(),
            action: {
              kind: "water",
              plot: target.plot,
              plantId: target.plantId,
            },
          },
        );
        Object.assign(target, { status: "watered", water: result.water });
        step = { plot: target.plot, water: result.water };
      }
    }
    const watered = targets.some((target) => target.status === "watered");
    const pending = targets.some((target) => target.status === "pending");
    const status = pending
      ? watered
        ? "partial"
        : "processing"
      : watered
        ? "completed"
        : "no_watering_needed";
    if (
      first ||
      status !== row.status ||
      JSON.stringify(targets) !== row.targets
    )
      row = this.save(row, status, targets, now);
    return { row, step };
  }

  targets(row, state) {
    const { sequence } = this.db
      .prepare("SELECT COALESCE(MAX(seq),0) AS sequence FROM garden_actions")
      .get();
    return state.plots
      .filter(
        ({ id, plant }) =>
          plant?.status === "growing" &&
          (row.plot === null
            ? plant.water < plant.rules.lowWater
            : id === row.plot),
      )
      .sort((a, b) => a.plant.water - b.plant.water || a.id - b.id)
      .map(({ id, plant }) => ({
        plot: id,
        plantId: plant.id,
        status: "pending",
        lockSequence: sequence,
      }));
  }

  activeRows(generation) {
    return this.db
      .prepare(
        "SELECT * FROM garden_delegations WHERE generation=? AND status IN ('queued','processing','partial') ORDER BY created_at,rowid",
      )
      .all(generation);
  }

  inbox(agent, now) {
    if (!this.garden.enabled) return [];
    const generation = this.runtime.home.generation(agent.id);
    const rows = this.activeRows(generation);
    if (!rows.length) return [];
    const state = this.state(now);
    const running =
      this.running(state) &&
      state.settings.turnLimit > 0 &&
      !roleRest(this.runtime, agent) &&
      rhythmStatus(this.runtime, agent, true).state !== "sleeping";
    return rows
      .map((row) => this.refresh(agent, row, state, now))
      .filter(
        (row) =>
          running &&
          active.has(row.status) &&
          this.runtime.writable(agent, row.source),
      )
      .map((row) => ({
        id: "garden:" + row.id,
        revision: row.revision,
        source: row.source,
        status: "pending",
        createdAt: row.created_at,
        reviewAt: row.viewed ? null : row.created_at,
        proposal: { kind: "garden-watering", ...receipt(row) },
      }));
  }

  feedback(agent, source, now) {
    if (!this.isAdmin(agent, source)) return [];
    const generation = this.runtime.home.generation(agent.id);
    const rows = this.db
      .prepare(
        "SELECT * FROM garden_delegations WHERE generation=? AND source=? ORDER BY updated_at DESC,rowid DESC LIMIT 64",
      )
      .all(generation, source);
    if (!rows.length) return [];
    const state = this.state(now);
    return rows
      .map((row) => this.refresh(agent, row, state, now))
      .map((row) => ({
        id: row.id,
        revision: row.revision,
        source,
        status: row.status,
        decidedAt: row.updated_at,
        proposal: { kind: "garden-watering" },
        gardenReceipt: receipt(row),
      }));
  }

  viewed(agent, id) {
    this.db
      .prepare(
        "UPDATE garden_delegations SET viewed=1 WHERE id=? AND generation=?",
      )
      .run(id, this.runtime.home.generation(agent.id));
  }
}
