// @ts-check
import { randomUUID, createHash } from "node:crypto";

const parse = (/** @type {string} */ value) => JSON.parse(value);
const digest = (/** @type {unknown} */ value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Persistent windows and dispatch: all mutations share the domain write lock. */
export class SocialExchange {
  /** @param {any} runtime */
  constructor(runtime) {
    this.runtime = runtime;
  }
  get service() {
    return this.runtime.homeSocial;
  }
  get store() {
    return this.service.store;
  }
  get db() {
    return this.store.db;
  }
  /** @param {any} ctx */
  binding(ctx) {
    this.service.assertBinding(ctx);
    return ctx.socialBinding;
  }
  /** @param {any} ctx @param {any} args */
  propose(ctx, args) {
    const b = this.binding(ctx);
    if (b.target.kind !== "visit" || b.target.id !== args.visitId)
      throw Error("IDENTITY_DENIED");
    return this.store.execute({
      actorIdentity: b.actorIdentity,
      requestId: args.requestId,
      kind: "exchange_propose",
      payload: args,
      authorize: () => this.binding(ctx),
      apply: (/** @type {any} */ { now }) => {
        const config = this.runtime.config.homeSocial;
        if (!config?.exchangeEnabled || !config.resourceBudget)
          throw Error("SOCIAL_EXCHANGE_DISABLED");
        const visit = this.service.assertVisit(b.actorIdentity, args.visitId, {
          active: true,
        });
        // Reject simultaneous engagements across visits, not only per visit.
        if (
          this.db
            .prepare(
              "SELECT 1 FROM home_social_windows w JOIN home_social_visits v ON v.id=w.visit_id WHERE w.status IN ('proposed','active') AND (v.host_generation IN (?,?) OR v.guest_generation IN (?,?))",
            )
            .get(
              visit.host_generation,
              visit.guest_generation,
              visit.host_generation,
              visit.guest_generation,
            )
        )
          throw Error("SOCIAL_WINDOW_BUSY");
        const terms = {
          visitId: visit.id,
          hostIdentity: {
            agentId: visit.host_agent_id,
            generation: visit.host_generation,
          },
          guestIdentity: {
            agentId: visit.guest_agent_id,
            generation: visit.guest_generation,
          },
          notBefore: args.notBefore ?? now,
          latestStartAt:
            args.latestStartAt ??
            Math.min(
              visit.expires_at - 1,
              now + config.durationMinutes * 60000,
            ),
          consentExpiresAt: args.consentExpiresAt ?? visit.expires_at,
          firstSpeakerIdentity:
            args.firstSpeakerAgentId === visit.host_agent_id
              ? {
                  agentId: visit.host_agent_id,
                  generation: visit.host_generation,
                }
              : args.firstSpeakerAgentId === visit.guest_agent_id
                ? {
                    agentId: visit.guest_agent_id,
                    generation: visit.guest_generation,
                  }
                : !args.firstSpeakerAgentId
                  ? b.actorIdentity
                  : null,
          durationMinutes: config.durationMinutes,
          maxTurns: config.maxTurns,
          maxMessagesPerTurn: config.maxMessagesPerTurn,
          resourceBudget: config.resourceBudget,
        };
        if (
          !terms.firstSpeakerIdentity ||
          terms.notBefore < now ||
          terms.latestStartAt < terms.notBefore ||
          terms.latestStartAt >= visit.expires_at ||
          terms.consentExpiresAt <= terms.latestStartAt ||
          terms.consentExpiresAt > visit.expires_at
        )
          throw Error("SOCIAL_WINDOW_TERMS_INVALID");
        const id = randomUUID(),
          revision = digest(terms),
          expiresAt = terms.consentExpiresAt;
        this.db
          .prepare(
            "INSERT INTO home_social_windows(id,visit_id,proposer_generation,status,terms_revision,terms,consent,effective_limits,policy_revision,created_at,expires_at) VALUES(?,?,?,'proposed',?,?,?,?,?,?,?)",
          )
          .run(
            id,
            args.visitId,
            b.actorIdentity.generation,
            revision,
            JSON.stringify(terms),
            JSON.stringify([b.actorIdentity.generation]),
            JSON.stringify(terms),
            b.policyRevision,
            now,
            expiresAt,
          );
        return {
          windowId: id,
          windowRevision: 1,
          termsRevision: revision,
          effectiveLimits: terms,
          expiresAt,
        };
      },
    });
  }
  /** @param {any} ctx @param {string} id @param {boolean} [active] */
  window(ctx, id, active = false) {
    const b = this.binding(ctx),
      w = this.db
        .prepare("SELECT * FROM home_social_windows WHERE id=?")
        .get(id);
    if (!w || b.target.kind !== "visit" || w.visit_id !== b.target.id)
      throw Error("IDENTITY_DENIED");
    this.service.assertVisit(b.actorIdentity, w.visit_id, { active });
    return w;
  }
  /** @param {any} ctx @param {any} args */
  decide(ctx, args) {
    const b = this.binding(ctx);
    return this.store.execute({
      actorIdentity: b.actorIdentity,
      requestId: args.requestId,
      kind: "exchange_decide",
      payload: args,
      authorize: () => this.window(ctx, args.windowId, true),
      apply: (/** @type {any} */ { now }) => {
        const w = this.window(ctx, args.windowId, true);
        if (
          w.status !== "proposed" ||
          now >= w.expires_at ||
          now > parse(w.terms).latestStartAt
        )
          throw Error("SOCIAL_WINDOW_CLOSED");
        if (
          w.revision !== args.expectedWindowRevision ||
          w.terms_revision !== args.termsRevision
        )
          throw Error("REVISION_CONFLICT");
        if (!args.accept) {
          this.closeRow(w, now, "declined");
          return { windowId: w.id, changed: true, status: "closed" };
        }
        const consent = [
          ...new Set([...parse(w.consent), b.actorIdentity.generation]),
        ];
        if (consent.length !== 2)
          return {
            windowId: w.id,
            changed: false,
            status: "proposed",
            windowRevision: w.revision,
          };
        this.db
          .prepare(
            "UPDATE home_social_windows SET consent=?,revision=revision+1 WHERE id=?",
          )
          .run(JSON.stringify(consent), w.id);
        return this.activate(
          this.db
            .prepare("SELECT * FROM home_social_windows WHERE id=?")
            .get(w.id),
          now,
        );
      },
    });
  }
  /** At most one transaction can transition this exact proposed window.
   * @param {any} w @param {number} now */
  activate(w, now) {
    if (!this.db.isTransaction) throw Error("SOCIAL_TRANSACTION_REQUIRED");
    const terms = parse(w.terms);
    if (w.status !== "proposed" || parse(w.consent).length !== 2)
      return { windowId: w.id, status: w.status, changed: false };
    if (now < terms.notBefore)
      return {
        windowId: w.id,
        status: "proposed",
        changed: true,
        windowRevision: w.revision,
        notBefore: terms.notBefore,
        latestStartAt: terms.latestStartAt,
      };
    if (now > terms.latestStartAt || now >= w.expires_at) {
      this.closeRow(w, now, "expired");
      return { windowId: w.id, status: "expired", changed: true };
    }
    const identity = terms.firstSpeakerIdentity,
      visit = this.service.assertVisit(identity, w.visit_id, { active: true }),
      limits = this.effective(w);
    const deadline = Math.min(
      visit.expires_at,
      w.expires_at,
      now + limits.durationMinutes * 60000,
    );
    this.db
      .prepare(
        "UPDATE home_social_windows SET status='active',revision=revision+1,started_at=?,deadline=?,effective_limits=? WHERE id=? AND status='proposed'",
      )
      .run(now, deadline, JSON.stringify(limits), w.id);
    const active = this.db
      .prepare("SELECT * FROM home_social_windows WHERE id=?")
      .get(w.id);
    this.enqueue(
      identity,
      { kind: "visit", id: w.visit_id },
      "window",
      active,
      now,
      `window:${w.id}:first`,
    );
    return {
      windowId: w.id,
      status: "active",
      changed: true,
      windowRevision: active.revision,
      deadline,
      effectiveLimits: limits,
    };
  }
  /** Tightening affects active windows; relaxation never extends accepted terms.
   * @param {any} w */
  effective(w) {
    const old = parse(w.effective_limits),
      c = this.runtime.config.homeSocial;
    if (!c?.exchangeEnabled || !c.resourceBudget)
      throw Error("SOCIAL_EXCHANGE_DISABLED");
    const budget = { ...old.resourceBudget };
    for (const key of Object.keys(budget))
      if (typeof budget[key] === "number")
        budget[key] = Math.min(budget[key], c.resourceBudget[key]);
    return {
      ...old,
      durationMinutes: Math.min(old.durationMinutes, c.durationMinutes),
      maxTurns: Math.min(old.maxTurns, c.maxTurns),
      maxMessagesPerTurn: Math.min(
        old.maxMessagesPerTurn,
        c.maxMessagesPerTurn,
      ),
      resourceBudget: budget,
    };
  }
  /** Called while the enclosing transaction holds the write lock.
   * @param {any} identity @param {any} target @param {string} mode @param {any} w @param {number} now @param {string} dedupe */
  enqueue(identity, target, mode, w, now, dedupe) {
    if (!this.db.isTransaction) throw Error("SOCIAL_TRANSACTION_REQUIRED");
    const prior = this.db
      .prepare("SELECT turn_id FROM home_social_dispatches WHERE dedupe_key=?")
      .get(dedupe);
    if (prior) return { turnId: prior.turn_id, historicalReplay: true };
    const b = this.service.targetBinding(identity, target),
      turnId = randomUUID(),
      id = randomUUID();
    target = b.target;
    const epoch = w?.epoch || 0,
      fence = w?.fence || 0,
      deadline = Math.min(b.deadline, w?.deadline || b.deadline);
    this.db
      .prepare(
        "INSERT INTO home_social_turns(id,visit_id,window_id,target_kind,target_id,target_host_generation,target_guest_generation,actor_generation,mode,status,epoch,fence,policy_revision,config_revision,created_at) VALUES(?,?,?,?,?,?,?,?,?,'queued',?,?,?,?,?)",
      )
      .run(
        turnId,
        target.kind === "visit" ? target.id : null,
        w?.id || null,
        target.kind,
        target.id,
        b.targetHostGeneration,
        b.targetGuestGeneration,
        identity.generation,
        mode,
        epoch,
        fence,
        b.policyRevision,
        b.configRevision,
        now,
      );
    this.db
      .prepare(
        "INSERT INTO home_social_dispatches(id,dedupe_key,turn_id,visit_id,window_id,actor_generation,target_kind,target_id,target_host_generation,target_guest_generation,mode,status,epoch,fence,not_before,deadline,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'queued',?,?,?,?,?)",
      )
      .run(
        id,
        dedupe,
        turnId,
        target.kind === "visit" ? target.id : null,
        w?.id || null,
        identity.generation,
        target.kind,
        target.id,
        b.targetHostGeneration,
        b.targetGuestGeneration,
        mode,
        epoch,
        fence,
        now,
        deadline,
        now,
      );
    this.db
      .prepare(
        "INSERT INTO home_social_outbox(id,dedupe_key,entity_id,type,metadata,status,epoch,fence,created_at) VALUES(?,?,?,'social-dispatch',?,'pending',?,?,?)",
      )
      .run(
        randomUUID(),
        dedupe,
        target.id,
        JSON.stringify({ dispatchId: id, turnId }),
        epoch,
        fence,
        now,
      );
    return { turnId, queued: true };
  }
  /** @param {any} ctx @param {any} args */
  status(ctx, args) {
    const w = this.window(ctx, args.windowId);
    return {
      windowId: w.id,
      status: w.status,
      windowRevision: w.revision,
      termsRevision: w.terms_revision,
      effectiveLimits:
        this.runtime.config.homeSocial?.resourceBudget &&
        this.runtime.config.homeSocial?.exchangeEnabled
          ? this.effective(w)
          : parse(w.effective_limits),
      resourcesUsed: parse(w.resources_used),
      resourcesReserved: parse(w.resources_reserved),
      turnsUsed: w.turns_used,
      turnsReserved: w.turns_reserved,
      deadline: w.deadline,
    };
  }
  /** @param {any} w @param {number} now @param {string} reason */
  closeRow(w, now, reason) {
    if (!["active", "proposed"].includes(w.status)) return false;
    this.db
      .prepare(
        "UPDATE home_social_windows SET status=?,revision=revision+1,fence=fence+1,closed_at=?,closed_reason=? WHERE id=?",
      )
      .run(
        reason === "expired"
          ? "expired"
          : reason === "declined"
            ? "declined"
            : "closed",
        now,
        reason,
        w.id,
      );
    this.db
      .prepare(
        "UPDATE home_social_turns SET status='cancelled',fence=fence+1,finished_at=? WHERE window_id=? AND status IN ('queued','running','reserved')",
      )
      .run(now, w.id);
    this.db
      .prepare(
        "UPDATE home_social_dispatches SET status='cancelled',fence=fence+1,finished_at=? WHERE window_id=? AND status IN ('queued','claimed')",
      )
      .run(now, w.id);
    this.db
      .prepare(
        "UPDATE home_social_outbox SET status='cancelled',fence=fence+1,finished_at=? WHERE entity_id=? AND status IN ('pending','claimed')",
      )
      .run(now, w.visit_id);
    return true;
  }
  /** @param {any} ctx @param {any} args */
  close(ctx, args) {
    const b = this.binding(ctx);
    const result = this.store.execute({
      actorIdentity: b.actorIdentity,
      requestId: args.requestId,
      kind: "exchange_close",
      payload: args,
      authorize: () => this.window(ctx, args.windowId),
      apply: (/** @type {any} */ { now }) => {
        const w = this.window(ctx, args.windowId);
        if (!["active", "proposed"].includes(w.status))
          return {
            changed: false,
            alreadyClosed: true,
            windowId: w.id,
            status: w.status,
          };
        if (w.revision !== args.expectedWindowRevision)
          throw Error("REVISION_CONFLICT");
        this.closeRow(w, now, "participant_closed");
        return { changed: true, windowId: w.id, status: "closed" };
      },
    });
    this.runtime.socialRuntime?.cancelStale();
    return result;
  }
  /** A yielded batch creates at most one reply, and only after actual messages.
   * @param {any} ctx @param {any} args */
  yield(ctx, args) {
    const b = this.binding(ctx);
    if (b.runMode !== "window" || b.windowId !== args.windowId)
      throw Error("IDENTITY_DENIED");
    return this.store.execute({
      actorIdentity: b.actorIdentity,
      requestId: args.requestId,
      kind: "exchange_yield",
      payload: args,
      authorize: () => this.window(ctx, args.windowId, true),
      apply: (/** @type {any} */ { now }) => {
        const w = this.window(ctx, args.windowId, true),
          turn = this.db
            .prepare("SELECT * FROM home_social_turns WHERE id=?")
            .get(b.turnId);
        if (
          w.status !== "active" ||
          now >= w.deadline ||
          turn.status !== "running" ||
          turn.fence !== b.fence ||
          turn.batch_sealed
        )
          throw Error("SOCIAL_WINDOW_CLOSED");
        if (w.revision !== args.expectedWindowRevision)
          throw Error("REVISION_CONFLICT");
        this.db
          .prepare("UPDATE home_social_turns SET batch_sealed=1 WHERE id=?")
          .run(turn.id);
        ctx.socialYielded = true;
        // Scheduling waits until the current physical model context is disposed.
        return {
          windowId: w.id,
          turnId: turn.id,
          batchSealed: true,
          messageCount: turn.message_count,
        };
      },
    });
  }
  /** @param {any} turn @param {number} now */
  finishBatch(turn, now) {
    const w = this.db
      .prepare("SELECT * FROM home_social_windows WHERE id=?")
      .get(turn.window_id);
    if (!w || w.status !== "active") return;
    const limits = this.effective(w);
    const visit = this.db
      .prepare("SELECT * FROM home_social_visits WHERE id=?")
      .get(w.visit_id);
    const next =
      turn.actor_generation === visit.host_generation
        ? { agentId: visit.guest_agent_id, generation: visit.guest_generation }
        : { agentId: visit.host_agent_id, generation: visit.host_generation };
    this.service.assertVisit(next, w.visit_id, { active: true });
    const descriptor = {
      runtimeKind: "subject-social",
      agentId: next.agentId,
      token: "social-preflight-placeholder",
      socialBinding: {
        actorIdentity: next,
        target: { kind: "visit", id: w.visit_id },
      },
    };
    const candidates = this.db
      .prepare(
        "SELECT m.source_labels FROM home_social_events e JOIN home_social_messages m ON m.id=json_extract(e.metadata,'$.messageId') WHERE e.type='message_committed' AND json_extract(e.metadata,'$.turnId')=? AND m.visit_id=? AND m.retracted_at IS NULL AND m.hidden_at IS NULL AND m.body_cleared_at IS NULL",
      )
      .all(turn.id, w.visit_id);
    const readable = candidates.some((/** @type {any} */ row) => {
      try {
        return (
          this.runtime.socialSourceAllowed?.(
            this.runtime,
            descriptor,
            parse(row.source_labels),
          ) === true
        );
      } catch {
        return false;
      }
    });
    if (
      !turn.batch_sealed ||
      !turn.message_count ||
      !readable ||
      now >=
        Math.min(w.deadline, w.started_at + limits.durationMinutes * 60000) ||
      w.turns_used + w.turns_reserved >= limits.maxTurns
    ) {
      this.closeRow(w, now, "batch_complete");
      return;
    }
    this.enqueue(
      next,
      { kind: "visit", id: w.visit_id },
      "window",
      w,
      now,
      `window:${w.id}:after:${turn.id}`,
    );
  }
}
