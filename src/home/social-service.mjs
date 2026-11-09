// @ts-check
import {
  admitSocialWindowMessage,
  socialWindowHistoryAllowed,
  socialInputLeaseAllowed,
} from "../core/social-protection.mjs";
import {
  effectiveSocialResourceBudget,
  socialBackendContract,
} from "./social-policy.mjs";
import {
  createHash,
  createHmac,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { SocialStore } from "./social-store.mjs";
import { homeTemplate } from "./layout.mjs";
import {
  socialToolSchemas,
  adminOverviewSchema,
  adminReadSchema,
  moderateSchema,
  SOCIAL_ADMIN_PRINCIPAL,
  socialTargetSchema,
} from "./social-policy.mjs";
const parse = (/** @type {string} */ value) => JSON.parse(value);
const same = (/** @type {any} */ a, /** @type {any} */ b) =>
  JSON.stringify(a) === JSON.stringify(b);
const day = (/** @type {number} */ now) =>
  new Date(now).toISOString().slice(0, 10);
// The persisted legacy policy kept the full backend array. Normalize it
// before comparing so upgrading does not itself revoke any participant.
function participantPolicies(
  /** @type {any[]} */ agents,
  /** @type {any[]} */ backends,
) {
  return Object.fromEntries(
    agents.map(({ id, backendId, model, ...policy }) => [
      id,
      {
        ...policy,
        backend: socialBackendContract(
          backends.find((b) => b.id === backendId),
          model,
        ),
      },
    ]),
  );
}
const HOUR = 3600000;
const safeFailures = new Set([
  "SOURCE_RESTRICTED",
  "SOCIAL_SOURCE_DENIED",
  "AUDIENCE_DENIED",
  "REVISION_CONFLICT",
  "INVITATION_EXPIRED",
  "VISIT_CLOSED",
  "PAUSED",
  "RATE_LIMITED",
  "SOCIAL_TURN_CLOSED",
]);
/** Private social domain. Model-facing callers use registered contexts, never request identities. */
export class HomeSocialService {
  /** @param {any} runtime @param {any} home @param {any} [sources] */
  constructor(runtime, home, sources = {}) {
    this.runtime = runtime;
    this.home = home;
    this.store = new SocialStore(runtime.memory.db, {
      clock: () => runtime.now(),
    });
    /** @type {any} */
    this.db = this.store.db;
    this.cursorSecret = randomBytes(32);
    this.inboxCursorSecret = randomBytes(32);
    this.sources = sources;
  }
  policy() {
    return this.db
      .prepare("SELECT * FROM home_social_policy WHERE singleton=1")
      .get();
  }
  /** @param {any} identity @param {{write?:boolean}} [options] */
  assertActor(identity, { write = true } = {}) {
    this.store.assertIdentity(identity);
    const r = this.runtime,
      a = r.agent(identity.agentId),
      p = this.policy();
    if (
      !this.home.identityReady ||
      !r.config.homeSocial?.enabled ||
      !p.enabled ||
      !a.home?.enabled ||
      !a.home?.social?.enabled
    )
      throw Error("AUDIENCE_DENIED");
    if (
      r.closed ||
      r.configChanging ||
      r.updateMaintenance ||
      r.maintenance.active
    )
      throw Error("PAUSED");
    if (write && !r.subject.internalAllowed(a)) throw Error("PAUSED");
    return a;
  }
  /** @param {string} agentId */
  identity(agentId) {
    return { agentId, generation: this.home.generation(agentId) };
  }
  /** @param {string} generation */
  identityGeneration(generation) {
    const row = this.db
      .prepare(
        "SELECT agent_id FROM home_identities WHERE generation=? AND active=1",
      )
      .get(generation);
    if (!row) throw Error("IDENTITY_DENIED");
    return { agentId: row.agent_id, generation };
  }
  /** @param {string} a @param {string} b */
  assertPair(a, b) {
    if (
      a === b ||
      this.db
        .prepare(
          "SELECT 1 FROM home_social_blocks WHERE active=1 AND ((actor_generation=? AND target_generation=?) OR (actor_generation=? AND target_generation=?))",
        )
        .get(a, b, b, a)
    )
      throw Error("AUDIENCE_DENIED");
    this.assertActor(this.identityGeneration(a), { write: false });
    this.assertActor(this.identityGeneration(b), { write: false });
  }
  /** @param {any} identity @param {string} visitId @param {{active?:boolean,now?:number}} [options] */
  assertVisit(
    identity,
    visitId,
    { active = false, now = this.runtime.now() } = {},
  ) {
    this.assertActor(identity, { write: active });
    const row = this.db
      .prepare(
        "SELECT * FROM home_social_visits WHERE id=? AND (host_generation=? OR guest_generation=?)",
      )
      .get(visitId, identity.generation, identity.generation);
    if (!row) throw Error("AUDIENCE_DENIED");
    this.assertPair(row.host_generation, row.guest_generation);
    if (active && (row.status !== "active" || now >= row.expires_at))
      throw Error("VISIT_CLOSED");
    return row;
  }
  /** @param {any} identity @param {string} invitationId */
  assertInvitation(identity, invitationId) {
    this.assertActor(identity, { write: false });
    const row = this.db
      .prepare(
        "SELECT * FROM home_social_invitations WHERE id=? AND (host_generation=? OR guest_generation=?)",
      )
      .get(invitationId, identity.generation, identity.generation);
    if (!row) throw Error("AUDIENCE_DENIED");
    this.assertPair(row.host_generation, row.guest_generation);
    if (row.status === "invalidated") throw Error("AUDIENCE_DENIED");
    if (row.status === "accepted") {
      const visit = this.db
        .prepare("SELECT * FROM home_social_visits WHERE invitation_id=?")
        .get(row.id);
      if (
        !visit ||
        visit.status === "invalidated" ||
        visit.host_generation !== row.host_generation ||
        visit.guest_generation !== row.guest_generation
      )
        throw Error("AUDIENCE_DENIED");
    }
    return row;
  }
  /** @param {any} invitation @param {number} [now] */
  invitationReadOnly(invitation, now = this.runtime.now()) {
    return invitation.status !== "pending" || now >= invitation.expires_at;
  }
  /** Returns a server-owned target for a queue; it never opens a model session.
   * @param {any} identity @param {any} input */
  targetBinding(identity, input) {
    this.assertActor(identity);
    const target = socialTargetSchema.parse(input),
      now = this.runtime.now();
    let host,
      guest,
      deadline,
      readOnly = false;
    if (target.kind === "compose") {
      const other = this.identity(target.id);
      if (identity.generation === other.generation)
        throw Error("AUDIENCE_DENIED");
      this.assertActor(other, { write: false });
      host = other.generation;
      guest = identity.generation;
      deadline = now + this.runtime.config.homeSocial.durationMinutes * 60000;
      target.id = identity.generation;
    } else {
      const row =
        target.kind === "invitation"
          ? this.assertInvitation(identity, target.id)
          : this.assertVisit(identity, target.id, { now });
      if (target.kind === "invitation")
        readOnly = this.invitationReadOnly(row, now);
      if (target.kind === "visit" && row.status === "invalidated")
        throw Error("AUDIENCE_DENIED");
      host = row.host_generation;
      guest = row.guest_generation;
      deadline =
        !readOnly &&
        ["active", "pending"].includes(row.status) &&
        now < row.expires_at
          ? row.expires_at
          : now + this.runtime.config.homeSocial.durationMinutes * 60000;
    }
    return {
      target,
      actorIdentity: identity,
      targetHostGeneration: host,
      targetGuestGeneration: guest,
      policyRevision: this.policy().revision,
      configRevision: this.runtime.configStore.revision,
      readOnly,
      deadline,
    };
  }
  /** Read-only fence check, safe within another domain's transaction.
   * @param {any} ctx @param {{allowExpired?:boolean,allowClosedEnd?:boolean}} [options] */
  assertBinding(ctx, { allowExpired = false, allowClosedEnd = false } = {}) {
    const r = this.runtime,
      b = ctx?.socialBinding;
    if (
      !ctx ||
      r.capabilities.get(ctx.token) !== ctx ||
      ctx.runtimeKind !== "subject-social" ||
      !b ||
      b.actorIdentity?.agentId !== ctx.agentId ||
      b.actorIdentity.generation !== this.home.generation(ctx.agentId) ||
      ctx.controller?.signal.aborted ||
      ctx.expires <= Date.now()
    )
      throw Error("IDENTITY_DENIED");
    const identity = b.actorIdentity;
    this.assertActor(identity);
    if (!allowExpired && this.runtime.now() >= b.deadline)
      throw Error(
        b.target.kind === "invitation"
          ? "INVITATION_EXPIRED"
          : b.target.kind === "visit"
            ? "VISIT_CLOSED"
            : "SOCIAL_TURN_CLOSED",
      );
    if (b.target.kind !== "compose")
      this.assertPair(b.targetHostGeneration, b.targetGuestGeneration);
    else {
      this.assertActor(this.identityGeneration(b.targetHostGeneration), {
        write: false,
      });
      this.assertActor(this.identityGeneration(b.targetGuestGeneration), {
        write: false,
      });
    }
    if (
      ![b.targetHostGeneration, b.targetGuestGeneration].includes(
        identity.generation,
      )
    )
      throw Error("IDENTITY_DENIED");
    let terminalVisit;
    if (b.target.kind === "compose") {
      if (b.target.id !== identity.generation) throw Error("IDENTITY_DENIED");
    } else {
      const row =
        b.target.kind === "invitation"
          ? this.assertInvitation(identity, b.target.id)
          : this.assertVisit(identity, b.target.id);
      if (b.target.kind === "visit") terminalVisit = row;
      if (
        row.host_generation !== b.targetHostGeneration ||
        row.guest_generation !== b.targetGuestGeneration
      )
        throw Error("IDENTITY_DENIED");
    }
    const turn = this.db
      .prepare("SELECT * FROM home_social_turns WHERE id=?")
      .get(b.turnId);
    if (
      !turn ||
      turn.actor_generation !== identity.generation ||
      turn.target_kind !== b.target.kind ||
      turn.target_id !== b.target.id ||
      turn.target_host_generation !== b.targetHostGeneration ||
      turn.target_guest_generation !== b.targetGuestGeneration ||
      turn.epoch !== b.epoch ||
      turn.mode !== b.runMode ||
      turn.window_id !== (b.windowId ?? null)
    )
      throw Error("SOCIAL_TURN_CLOSED");
    const live = turn.status === "running" && turn.fence === b.fence;
    // Only an already-entered end may converge after this visit's normal close.
    // Capability, policy, identity, participants and every immutable binding above still apply.
    const converging =
      allowClosedEnd &&
      terminalVisit &&
      ["ended", "expired"].includes(terminalVisit.status) &&
      turn.status === "cancelled" &&
      turn.fence === b.fence + 1 &&
      turn.safe_error === "VISIT_CLOSED";
    if (!live && !converging) throw Error("SOCIAL_TURN_CLOSED");
    return identity;
  }
  /** @param {any} ctx @param {string} kind @param {string} id @param {boolean} [allowExpired] */
  bound(ctx, kind, id, allowExpired = false) {
    const identity = this.assertBinding(ctx, { allowExpired });
    if (
      ctx.socialBinding.target.kind !== kind ||
      ctx.socialBinding.target.id !== id
    )
      throw Error("AUDIENCE_DENIED");
    return identity;
  }
  /** Source adapters are mandatory: absent integration fails closed.
   * @param {any} ctx @param {any} target @param {string} value */
  share(ctx, target, value) {
    this.runtime.assertSafeOutput(ctx, value);
    const gate =
      this.sources.assertSend || this.runtime.homeSocialSources?.assertSend;
    if (!gate) {
      ctx.socialSendingClosed = true;
      throw Error("SOURCE_RESTRICTED");
    }
    gate(this.runtime, ctx, target);
    if (ctx.socialSendingClosed) throw Error("SOURCE_RESTRICTED");
    const sources =
      this.sources.sources || this.runtime.homeSocialSources?.sources;
    if (!sources) throw Error("SOURCE_RESTRICTED");
    return sources(this.runtime, ctx);
  }
  /** @param {any} ctx @param {string[]} labels */
  track(ctx, labels, historicalMessage = false) {
    const track =
      this.sources.trackSource || this.runtime.homeSocialSources?.trackSource;
    if (!track) throw Error("SOURCE_RESTRICTED");
    const fresh = { ...ctx, privateRead: new Set(labels) };
    const sources =
        this.sources.sources || this.runtime.homeSocialSources?.sources,
      allowed = this.sources.allowed || this.runtime.homeSocialSources?.allowed;
    if (
      !sources ||
      !allowed ||
      !(historicalMessage
        ? socialWindowHistoryAllowed(
            this.runtime,
            ctx,
            sources(this.runtime, fresh),
          )
        : allowed(this.runtime, fresh, sources(this.runtime, fresh)))
    )
      throw Error("SOURCE_RESTRICTED");
    track(ctx, { protectedSocialSources: labels });
  }
  /** @param {string} kind @param {string} id @param {string} actor @param {number} now @param {any} [metadata] */
  event(kind, id, actor, now, metadata = {}) {
    this.db
      .prepare(
        "INSERT INTO home_social_events(id,entity_id,actor_generation,type,created_at,metadata) VALUES(?,?,?,?,?,?)",
      )
      .run(randomUUID(), id, actor, kind, now, JSON.stringify(metadata));
  }
  /** @param {string} generation @param {string} scope @param {string} kind @param {number} now */
  usage(generation, scope, kind, now) {
    return (
      this.db
        .prepare(
          "SELECT used FROM home_social_usage WHERE actor_generation=? AND day=? AND scope=? AND kind=?",
        )
        .get(generation, day(now), scope, kind)?.used || 0
    );
  }
  /** @param {string} generation @param {string} scope @param {string} kind @param {number} now */
  charge(generation, scope, kind, now) {
    this.db
      .prepare(
        "INSERT INTO home_social_usage VALUES(?,?,?,?,1,0) ON CONFLICT(actor_generation,day,scope,kind) DO UPDATE SET used=used+1",
      )
      .run(generation, day(now), scope, kind);
  }
  /** Opaque cursors bind the reader, target and current authorization version.
   * @param {any} binding @param {number|{createdAt:number,id:string}} after */
  cursor(binding, after) {
    const value = Buffer.from(JSON.stringify({ binding, after })).toString(
      "base64url",
    );
    return (
      value +
      "." +
      createHmac("sha256", this.cursorSecret).update(value).digest("base64url")
    );
  }
  /** @param {string|undefined} cursor @param {any} binding */
  after(cursor, binding) {
    if (!cursor) return 0;
    const [value, signature, ...rest] = cursor.split(".");
    if (
      rest.length ||
      !value ||
      createHmac("sha256", this.cursorSecret)
        .update(value)
        .digest("base64url") !== signature
    )
      throw Error("INVALID_CURSOR");
    let result;
    try {
      result = parse(Buffer.from(value, "base64url").toString());
    } catch {
      throw Error("INVALID_CURSOR");
    }
    const positionValid =
      binding.kind === "admin-overview" && binding.recordKind === "visit"
        ? Number.isSafeInteger(result.after?.createdAt) &&
          typeof result.after?.id === "string" &&
          result.after.id.length > 0
        : Number.isSafeInteger(result.after) && result.after >= 0;
    if (!same(result.binding, binding) || !positionValid)
      throw Error("INVALID_CURSOR");
    return result.after;
  }
  /** Scan positions are private: skipped rows must not expose global row IDs.
   * @param {any} binding @param {number} after */
  inboxCursor(binding, after) {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.inboxCursorSecret, iv);
    cipher.setAAD(Buffer.from("home-social-inbox-v1"));
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify({ binding, after }), "utf8"),
      cipher.final(),
    ]);
    return (
      "in1." +
      Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url")
    );
  }
  /** @param {string|undefined} token @param {any} binding */
  inboxAfter(token, binding) {
    if (token === undefined) return 0;
    try {
      if (token.length > 512 || !/^in1\.[A-Za-z0-9_-]+$/.test(token))
        throw Error("INVALID_CURSOR");
      const data = Buffer.from(token.slice(4), "base64url");
      if (data.length < 29) throw Error("INVALID_CURSOR");
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.inboxCursorSecret,
        data.subarray(0, 12),
      );
      decipher.setAAD(Buffer.from("home-social-inbox-v1"));
      decipher.setAuthTag(data.subarray(12, 28));
      const value = parse(
        Buffer.concat([
          decipher.update(data.subarray(28)),
          decipher.final(),
        ]).toString("utf8"),
      );
      if (
        !same(value.binding, binding) ||
        !Number.isSafeInteger(value.after) ||
        value.after < 0
      )
        throw Error("INVALID_CURSOR");
      return value.after;
    } catch {
      throw Error("INVALID_CURSOR");
    }
  }
  /** @param {any} visit @param {number} [now] */
  retained(visit, now = this.runtime.now()) {
    const terminalAt =
      visit.status === "active" ? visit.expires_at : visit.ended_at;
    return (
      now < terminalAt + this.runtime.config.homeSocial.retentionDays * 86400000
    );
  }
  /** @param {any} invitation */
  invitationRetained(invitation) {
    if (invitation.body_cleared_at) return false;
    if (invitation.status === "accepted") {
      const visit = this.db
        .prepare("SELECT * FROM home_social_visits WHERE invitation_id=?")
        .get(invitation.id);
      return !!visit && this.retained(visit);
    }
    return (
      (invitation.status === "pending" &&
        this.runtime.now() < invitation.expires_at) ||
      this.runtime.now() <
        (invitation.decided_at || invitation.expires_at) +
          this.runtime.config.homeSocial.retentionDays * 86400000
    );
  }
  /** @param {any} row */
  invitationMeta(row) {
    return {
      id: row.id,
      revision: row.revision,
      owner: {
        agentId: row.host_agent_id,
        identityGeneration: row.host_generation,
        name:
          this.runtime.config.agents.find(
            (/** @type {any} */ a) => a.id === row.host_agent_id,
          )?.name || "已移除角色",
      },
      visitor: {
        agentId: row.guest_agent_id,
        identityGeneration: row.guest_generation,
        name:
          this.runtime.config.agents.find(
            (/** @type {any} */ a) => a.id === row.guest_agent_id,
          )?.name || "已移除角色",
      },
      invitationRevision: row.revision,
      hostIdentity: {
        agentId: row.host_agent_id,
        generation: row.host_generation,
      },
      guestIdentity: {
        agentId: row.guest_agent_id,
        generation: row.guest_generation,
      },
      initiatorGeneration: row.initiator_generation,
      recipientGeneration: row.recipient_generation,
      recipientViewedAt: row.recipient_viewed_at,
      roomId: row.room_id,
      state:
        row.status === "pending" && this.runtime.now() >= row.expires_at
          ? "expired"
          : row.status,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      requestedScope: parse(row.requested_scope).scope,
      effectiveScope: row.effective_scope
        ? parse(row.effective_scope).scope
        : null,
    };
  }
  /** @param {any} row */
  visitMeta(row) {
    return {
      id: row.id,
      revision: row.revision,
      owner: {
        agentId: row.host_agent_id,
        identityGeneration: row.host_generation,
        name:
          this.runtime.config.agents.find(
            (/** @type {any} */ a) => a.id === row.host_agent_id,
          )?.name || "已移除角色",
      },
      visitor: {
        agentId: row.guest_agent_id,
        identityGeneration: row.guest_generation,
        name:
          this.runtime.config.agents.find(
            (/** @type {any} */ a) => a.id === row.guest_agent_id,
          )?.name || "已移除角色",
      },
      visitId: row.id,
      invitationId: row.invitation_id,
      hostIdentity: {
        agentId: row.host_agent_id,
        generation: row.host_generation,
      },
      guestIdentity: {
        agentId: row.guest_agent_id,
        generation: row.guest_generation,
      },
      roomId: row.room_id,
      state:
        row.status === "active" && this.runtime.now() >= row.expires_at
          ? "expired"
          : row.status,
      visitRevision: row.revision,
      startedAt: row.started_at,
      expiresAt: row.expires_at,
      endedAt: row.ended_at,
      closedReason: row.closed_reason,
    };
  }
  /** @param {any} ctx @param {any} args */
  capabilities(ctx, args = {}) {
    socialToolSchemas.home_social_capabilities.parse(args);
    const identity = this.assertBinding(ctx),
      now = this.runtime.now(),
      p = this.runtime.config.homeSocial;
    return {
      identity,
      policyRevision: this.policy().revision,
      enabled: true,
      exchangeEnabled: p.exchangeEnabled,
      limits: p,
      remainingInvitations: Math.max(
        0,
        p.maxInvitationsPerDay -
          this.usage(identity.generation, "instance", "invitation", now),
      ),
      targets: this.runtime.config.agents
        .filter(
          (/** @type {any} */ a) =>
            a.id !== identity.agentId &&
            a.home?.enabled &&
            a.home?.social?.enabled,
        )
        .map((/** @type {any} */ a) => ({
          agentId: a.id,
          name: a.name,
          identityGeneration: this.home.generation(a.id),
        })),
    };
  }
  /** @param {any} ctx @param {string} kind @param {any} input @param {(gate:any)=>any} apply @param {(identity:any)=>void} [extra] @param {boolean} [allowExpired] @param {boolean} [endConvergence] */
  execute(
    ctx,
    kind,
    input,
    apply,
    extra = () => {},
    allowExpired = false,
    endConvergence = false,
  ) {
    const identity = this.assertBinding(ctx, { allowExpired });
    return this.store.execute({
      actorIdentity: identity,
      requestId: input.requestId,
      kind,
      payload: input,
      authorize: (gate) => {
        this.assertBinding(ctx, {
          allowExpired,
          allowClosedEnd: endConvergence,
        });
        // Terminal invitation contexts expose safe state and receipts, never a new write.
        // Derive this from current rows, since queued bindings may predate the decision.
        if (
          ctx.socialBinding.target.kind === "invitation" &&
          !gate.replay &&
          this.invitationReadOnly(
            this.assertInvitation(identity, ctx.socialBinding.target.id),
            gate.now,
          )
        )
          throw Error("AUDIENCE_DENIED");
        extra(identity);
      },
      apply: (gate) => ({
        ...apply(gate),
        resultReference: {
          target: ctx.socialBinding.target,
          hostGeneration: ctx.socialBinding.targetHostGeneration,
          guestGeneration: ctx.socialBinding.targetGuestGeneration,
        },
      }),
    });
  }
  /** @param {any} ctx @param {any} input */
  invite(ctx, input) {
    const a = socialToolSchemas.home_visit_invite.parse(input),
      identity = this.bound(ctx, "compose", ctx.socialBinding?.target.id);
    return this.execute(ctx, "invite", a, ({ now }) => {
      const other = this.identity(a.targetAgentId),
        b = ctx.socialBinding;
      if (
        ![b.targetHostGeneration, b.targetGuestGeneration].includes(
          other.generation,
        ) ||
        other.generation === identity.generation ||
        ![identity.agentId, other.agentId].includes(a.roomOwnerAgentId)
      )
        throw Error("AUDIENCE_DENIED");
      this.assertPair(identity.generation, other.generation);
      this.share(ctx, b.target, a.purpose);
      const cfg = this.runtime.config.homeSocial;
      if (
        this.usage(identity.generation, "instance", "invitation", now) >=
        cfg.maxInvitationsPerDay
      )
        throw Error("RATE_LIMITED");
      const prior = this.db
        .prepare(
          "SELECT * FROM home_social_invitations WHERE initiator_generation=? AND recipient_generation=? ORDER BY created_at DESC LIMIT 1",
        )
        .get(identity.generation, other.generation);
      if (prior?.status === "pending" && now >= prior.expires_at)
        this.db
          .prepare(
            "UPDATE home_social_invitations SET status='expired',revision=revision+1,decided_at=?,closed_reason='expired' WHERE id=?",
          )
          .run(prior.expires_at, prior.id);
      const latest =
        prior?.status === "pending" && now >= prior.expires_at
          ? { ...prior, status: "expired", decided_at: prior.expires_at }
          : prior;
      if (
        latest?.status === "pending" ||
        (latest &&
          ["declined", "expired"].includes(latest.status) &&
          now <
            (latest.decided_at || latest.expires_at) + cfg.cooldownHours * HOUR)
      )
        throw Error("RATE_LIMITED");
      const host = a.roomOwnerAgentId === identity.agentId ? identity : other,
        guest = host === identity ? other : identity;
      const selection = this.validateScope(
        ctx,
        host,
        a.scope,
        a.selectedItems,
        host.generation === identity.generation,
      );
      const id = randomUUID(),
        expiresAt = now + cfg.invitationTtlHours * HOUR;
      this.db
        .prepare(
          "INSERT INTO home_social_invitations(id,host_agent_id,host_generation,guest_agent_id,guest_generation,initiator_generation,recipient_generation,room_id,purpose,source_labels,audience,requested_scope,effective_scope,status,policy_revision,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?)",
        )
        .run(
          id,
          host.agentId,
          host.generation,
          guest.agentId,
          guest.generation,
          identity.generation,
          other.generation,
          "room:" + host.generation,
          a.purpose,
          JSON.stringify([...(ctx.protectedSocialSources || [])]),
          JSON.stringify([host.generation, guest.generation]),
          JSON.stringify({ scope: a.scope, selectedItems: selection }),
          null,
          this.policy().revision,
          now,
          expiresAt,
        );
      this.charge(identity.generation, "instance", "invitation", now);
      this.event("invited", id, identity.generation, now);
      return {
        invitationId: id,
        invitationRevision: 1,
        state: "pending",
        expiresAt,
        requestedScope: a.scope,
        selectedItemRevisions: selection,
      };
    });
  }
  /** @param {any} ctx @param {any} host @param {string[]} scope @param {any[]} selected @param {boolean} ownerConsent */
  validateScope(ctx, host, scope, selected, ownerConsent) {
    if (!ownerConsent) {
      if (selected.length) throw Error("AUDIENCE_DENIED");
      return [];
    }
    if (
      selected.length !== scope.filter((s) => s !== "layout").length ||
      selected.some((i) => !scope.includes(i.slot))
    )
      throw Error("AUDIENCE_DENIED");
    for (const item of selected) {
      const row = this.home.rooms.store.item(host.generation, item.slot);
      if (
        !row ||
        row.state !== "published" ||
        row.item_id !== item.itemId ||
        row.revision !== item.itemRevision ||
        !this.runtime.agent(host.agentId).home.publishing
      )
        throw Error("AUDIENCE_DENIED");
      const proof =
        this.sources.assertRoomItem ||
        this.runtime.homeSocialSources?.assertRoomItem;
      if (!proof) throw Error("SOURCE_RESTRICTED");
      proof(this.runtime, ctx, {
        hostGeneration: host.generation,
        slot: item.slot,
        itemId: item.itemId,
        itemRevision: item.itemRevision,
      });
    }
    return selected;
  }
  /** @param {any} ctx @param {any} input */
  inbox(ctx, input = {}) {
    const a = socialToolSchemas.home_visit_inbox.parse(input),
      identity = this.assertBinding(ctx),
      binding = {
        kind: "inbox",
        reader: identity.generation,
        policy: this.policy().revision,
      };
    const after = this.inboxAfter(a.cursor, binding),
      scanLimit = 200;
    const rows = this.db
      .prepare(
        "SELECT rowid AS cursor_key,id,host_agent_id,host_generation,guest_agent_id,guest_generation,initiator_generation,recipient_generation,room_id,status,revision,created_at,expires_at,recipient_viewed_at,requested_scope,effective_scope FROM home_social_invitations WHERE (host_generation=? OR guest_generation=?) AND rowid>? ORDER BY rowid LIMIT ?",
      )
      .all(identity.generation, identity.generation, after, scanLimit + 1);
    const items = [];
    let scanned = 0,
      position = after;
    // Advance over denied candidates as well as visible ones; a full denied scan may yield an empty continuation page.
    while (
      scanned < Math.min(scanLimit, rows.length) &&
      items.length < a.limit
    ) {
      const row = rows[scanned++];
      position = row.cursor_key;
      try {
        this.assertPair(row.host_generation, row.guest_generation);
      } catch {
        continue;
      }
      items.push(this.invitationMeta(row));
    }
    return {
      items,
      nextCursor:
        scanned < rows.length ? this.inboxCursor(binding, position) : null,
      policyRevision: this.policy().revision,
    };
  }
  /** @param {any} ctx @param {any} guard @param {string[]|null} [sourceIds] */
  lease(ctx, guard, sourceIds = null) {
    if (sourceIds) {
      guard.socialHistoryLease = true;
      guard.socialHistoryDelivered = false;
      guard.socialSourceIds = [...sourceIds];
    }
    ctx.socialInputLeases ||= new Set();
    ctx.socialInputLeases.add(guard);
  }
  /** @param {any} ctx @param {any} input */
  invitationRead(ctx, input) {
    const a = socialToolSchemas.home_visit_invitation_read.parse(input),
      identity = this.bound(ctx, "invitation", a.invitationId),
      row = this.assertInvitation(identity, a.invitationId);
    if (this.invitationReadOnly(row)) {
      ctx.socialPendingInvitations?.delete(row.id);
      const visit =
        row.status === "accepted"
          ? this.db
              .prepare(
                "SELECT id FROM home_social_visits WHERE invitation_id=?",
              )
              .get(row.id)
          : null;
      return {
        ...this.invitationMeta(row),
        ...(visit ? { visitId: visit.id } : {}),
        readOnly: true,
        operationStatusOnly: true,
        policyRevision: this.policy().revision,
        lease: { expiresAt: this.runtime.now() + 15000 },
        permittedActions: ["operation-read"],
      };
    }
    if (!this.invitationRetained(row)) throw Error("AUDIENCE_DENIED");
    this.track(ctx, [
      `social-invitation:${row.id}:${row.revision}`,
      ...parse(row.source_labels),
    ]);
    // Page DTO expiry is separate from a model input revalidated on every use.
    this.lease(ctx, () => {
      this.assertBinding(ctx);
      const current = this.assertInvitation(identity, row.id);
      if (
        this.runtime.now() >= current.expires_at ||
        current.status !== "pending" ||
        !this.invitationRetained(current) ||
        current.revision !== row.revision ||
        current.body_cleared_at
      )
        throw Error("AUDIENCE_DENIED");
      return true;
    });
    ctx.socialPendingInvitations ||= new Map();
    ctx.socialPendingInvitations.set(row.id, {
      revision: row.revision,
      recipientGeneration: row.recipient_generation,
    });
    return {
      ...this.invitationMeta(row),
      purpose: row.purpose,
      ...(row.reason ? { reason: row.reason } : {}),
      policyRevision: this.policy().revision,
      lease: {
        expiresAt: Math.min(this.runtime.now() + 15000, row.expires_at),
      },
      permittedActions:
        row.status === "pending"
          ? [
              row.recipient_generation === identity.generation
                ? "decide"
                : "cancel",
            ]
          : [],
    };
  }
  /** Internal HTTP preflight snapshot; model tools cannot confirm their own reads.
   * @param {any} ctx */
  captureInputConsumption(ctx) {
    this.assertBinding(ctx);
    const invitations = [
      ...(ctx.socialPendingInvitations || new Map()).entries(),
    ].map(([id, value]) =>
      Object.freeze({
        id,
        revision: value.revision,
        recipientGeneration: value.recipientGeneration,
      }),
    );
    return Object.freeze({ invitations: Object.freeze(invitations) });
  }
  /** Commit only server-captured input acknowledged by a successful, still-authorized inference.
   * @param {any} ctx @param {any} ticket */
  confirmInputConsumed(ctx, ticket) {
    const identity = this.assertBinding(ctx),
      pending = ctx.socialPendingInvitations;
    if (!ticket || !Array.isArray(ticket.invitations))
      throw Error("AUDIENCE_DENIED");
    const matched = ticket.invitations.filter((/** @type {any} */ item) => {
      const current = pending?.get(item.id);
      return (
        current &&
        current.revision === item.revision &&
        current.recipientGeneration === item.recipientGeneration
      );
    });
    if (!matched.length) return { confirmed: 0 };
    const result = this.store.transaction((now) => {
      this.assertBinding(ctx);
      for (const lease of ctx.socialInputLeases || [])
        if (!socialInputLeaseAllowed(this.runtime, ctx, lease))
          throw Error("AUDIENCE_DENIED");
      const sources =
          this.sources.sources || this.runtime.homeSocialSources?.sources,
        allowed =
          this.sources.allowed || this.runtime.homeSocialSources?.allowed;
      if (
        !sources ||
        !allowed ||
        !allowed(this.runtime, ctx, sources(this.runtime, ctx))
      )
        throw Error("SOURCE_RESTRICTED");
      let confirmed = 0;
      for (const item of matched) {
        this.bound(ctx, "invitation", item.id);
        const row = this.assertInvitation(identity, item.id);
        if (
          row.revision !== item.revision ||
          row.recipient_generation !== item.recipientGeneration ||
          !this.invitationRetained(row)
        )
          throw Error("AUDIENCE_DENIED");
        if (identity.generation !== row.recipient_generation) continue;
        this.db
          .prepare(
            "UPDATE home_social_invitations SET recipient_viewed_at=coalesce(recipient_viewed_at,?) WHERE id=? AND revision=? AND recipient_generation=?",
          )
          .run(now, item.id, item.revision, identity.generation);
        if (row.recipient_viewed_at === null) confirmed++;
      }
      return { confirmed };
    });
    for (const item of matched) {
      const current = pending.get(item.id);
      if (
        current?.revision === item.revision &&
        current.recipientGeneration === item.recipientGeneration
      )
        pending.delete(item.id);
    }
    return result;
  }
  /** @param {any} ctx @param {any} input */
  decide(ctx, input) {
    const a = socialToolSchemas.home_visit_decide.parse(input),
      identity = this.bound(ctx, "invitation", a.invitationId);
    return this.execute(ctx, "decide", a, ({ now }) => {
      const row = this.assertInvitation(identity, a.invitationId);
      if (row.status !== "pending") throw Error("REVISION_CONFLICT");
      if (now >= row.expires_at) throw Error("INVITATION_EXPIRED");
      if (row.revision !== a.expectedInvitationRevision)
        throw Error("REVISION_CONFLICT");
      if (
        (a.decision === "cancel"
          ? row.initiator_generation
          : row.recipient_generation) !== identity.generation
      )
        throw Error("AUDIENCE_DENIED");
      this.share(ctx, ctx.socialBinding.target, a.reason);
      if (a.decision === "defer") {
        this.db
          .prepare(
            "UPDATE home_social_invitations SET next_eligible_at=? WHERE id=?",
          )
          .run(Math.min(row.expires_at, now + HOUR), row.id);
        return {
          invitationId: row.id,
          invitationRevision: row.revision,
          state: "pending",
          deferred: true,
          expiresAt: row.expires_at,
        };
      }
      if (a.decision !== "accept") {
        const state = a.decision === "decline" ? "declined" : "cancelled";
        this.db
          .prepare(
            "UPDATE home_social_invitations SET status=?,revision=revision+1,decided_at=?,reason=?,closed_reason=? WHERE id=?",
          )
          .run(state, now, a.reasonVisible ? a.reason : "", state, row.id);
        this.event(state, row.id, identity.generation, now);
        return {
          invitationId: row.id,
          invitationRevision: row.revision + 1,
          state,
          expiresAt: row.expires_at,
        };
      }
      const proposal = parse(row.requested_scope),
        scope = a.scope ?? proposal.scope,
        selected =
          a.selectedItems ??
          proposal.selectedItems.filter((/** @type {any} */ i) =>
            scope.includes(i.slot),
          );
      if (scope.some((/** @type {string} */ s) => !proposal.scope.includes(s)))
        throw Error("AUDIENCE_DENIED");
      const host = {
        agentId: row.host_agent_id,
        generation: row.host_generation,
      };
      if (identity.generation !== row.host_generation) {
        if (
          selected.some(
            (/** @type {any} */ i) =>
              !proposal.selectedItems.some((/** @type {any} */ original) =>
                same(i, original),
              ),
          )
        )
          throw Error("AUDIENCE_DENIED");
      }
      this.validateScope(ctx, host, scope, selected, true);
      const pair = [row.host_generation, row.guest_generation].sort().join(":"),
        existing = this.db
          .prepare(
            "SELECT * FROM home_social_visits WHERE pair_key=? AND status='active'",
          )
          .get(pair);
      if (existing) {
        if (now >= existing.expires_at)
          this.closeVisit(existing, now, "expired", null);
        else throw Error("REVISION_CONFLICT");
      }
      const id = randomUUID(),
        expiresAt = now + this.runtime.config.homeSocial.visitTtlHours * HOUR;
      this.db
        .prepare(
          "INSERT INTO home_social_visits(id,invitation_id,host_agent_id,host_generation,guest_agent_id,guest_generation,room_id,pair_key,status,policy_revision,started_at,expires_at) VALUES(?,?,?,?,?,?,?,?,'active',?,?,?)",
        )
        .run(
          id,
          row.id,
          row.host_agent_id,
          row.host_generation,
          row.guest_agent_id,
          row.guest_generation,
          row.room_id,
          pair,
          this.policy().revision,
          now,
          expiresAt,
        );
      this.db
        .prepare(
          "INSERT INTO home_social_grants(visit_id,invitation_id,room_id,host_generation,guest_generation,scope,selected_item_revisions,policy_revision,expires_at) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          row.id,
          row.room_id,
          row.host_generation,
          row.guest_generation,
          JSON.stringify(scope),
          JSON.stringify(selected),
          this.policy().revision,
          expiresAt,
        );
      this.db
        .prepare(
          "UPDATE home_social_invitations SET status='accepted',revision=revision+1,decided_at=?,effective_scope=? WHERE id=?",
        )
        .run(now, JSON.stringify({ scope, selectedItems: selected }), row.id);
      this.event("accepted", id, identity.generation, now, {
        invitationId: row.id,
      });
      return {
        invitationId: row.id,
        invitationRevision: row.revision + 1,
        visitId: id,
        visitRevision: 1,
        state: "active",
        expiresAt,
        requestedScope: proposal.scope,
        effectiveScope: scope,
        selectedItemRevisions: selected,
        grantRevision: 1,
        grantExpiresAt: expiresAt,
      };
    });
  }
  /** Background-only materialization; reads never invoke this or create events. */
  maintain() {
    const result = this.store.transaction((now) => {
      const invitations = this.db
        .prepare(
          "SELECT * FROM home_social_invitations WHERE status='pending' AND expires_at<=?",
        )
        .all(now);
      for (const row of invitations) {
        this.db
          .prepare(
            "UPDATE home_social_invitations SET status='expired',revision=revision+1,decided_at=expires_at,closed_reason='expired' WHERE id=?",
          )
          .run(row.id);
        this.event("invitation_expired", row.id, "system", now);
      }
      const visits = this.db
        .prepare(
          "SELECT * FROM home_social_visits WHERE status='active' AND expires_at<=?",
        )
        .all(now);
      for (const visit of visits) this.closeVisit(visit, now, "expired", null);
      for (const window of this.db
        .prepare(
          "SELECT * FROM home_social_windows WHERE (status='proposed' AND expires_at<=?) OR (status='active' AND deadline<=?)",
        )
        .all(now, now))
        this.store.closeWindow(window, now, "expired");
      return { invitations: invitations.length, visits: visits.length };
    });
    const cleared = this.store.pruneBodies({
      before:
        this.runtime.now() -
        this.runtime.config.homeSocial.retentionDays * 86400000,
    });
    return { ...result, cleared };
  }
  /** @param {any} row @param {number} now @param {string} state @param {string|null} actor */
  closeVisit(row, now, state, actor) {
    if (row.status !== "active") return false;
    this.db
      .prepare(
        "UPDATE home_social_visits SET status=?,revision=revision+1,fence=fence+1,ended_at=?,ended_by=?,closed_reason=? WHERE id=? AND status='active'",
      )
      .run(state, Math.min(now, row.expires_at), actor, state, row.id);
    this.db
      .prepare(
        "UPDATE home_social_grants SET revoked_at=?,revision=revision+1,fence=fence+1 WHERE visit_id=? AND revoked_at IS NULL",
      )
      .run(now, row.id);
    const scope = { visitId: row.id };
    this.store.transitionWindows(now, scope, state, "closed");
    this.store.stopWork(now, scope, {
      reason: ["ended", "expired"].includes(state)
        ? "VISIT_CLOSED"
        : "AUDIENCE_DENIED",
    });
    this.event(state, row.id, actor || "system", now);
    return true;
  }
  /** @param {any} visit @param {string|null} viewer @param {any} [window] */
  usageDTO(visit, viewer, window = null) {
    const now = this.runtime.now(),
      cfg = this.runtime.config.homeSocial,
      limits = window ? parse(window.effective_limits) : cfg;
    const rows = this.db
      .prepare(
        "SELECT actor_generation,mode,resources_used,resources_reserved,started_at,(SELECT count(*) FROM home_social_inference_reservations i WHERE i.turn_id=home_social_turns.id) AS metered FROM home_social_turns WHERE visit_id=?",
      )
      .all(visit.id);
    const sum = (/** @type {string} */ key, /** @type {string} */ mode) =>
      rows
        .filter(
          (/** @type {any} */ row) =>
            row.mode === mode && (!viewer || row.actor_generation === viewer),
        )
        .reduce(
          (/** @type {number} */ n, /** @type {any} */ row) =>
            n + (parse(row[key]).tokens || 0),
          0,
        );
    const unmeteredAsync = rows.some(
      (/** @type {any} */ row) =>
        row.mode === "async" &&
        (!viewer || row.actor_generation === viewer) &&
        row.started_at !== null &&
        !row.metered,
    );
    const unmeteredWindow =
      window &&
      this.db
        .prepare(
          "SELECT count(*) n FROM home_social_turns t WHERE t.window_id=? AND t.started_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM home_social_inference_reservations i WHERE i.turn_id=t.id)",
        )
        .get(window.id).n > 0;
    const participants = viewer
      ? [viewer]
      : [visit.host_generation, visit.guest_generation];
    const daily = participants.map((generation) => ({
      identityGeneration: generation,
      committed: this.usage(generation, visit.id, "message", now),
      limit: cfg.maxMessagesPerVisitPerDay,
    }));
    return {
      windowTurns: {
        used: window?.turns_used || 0,
        reserved: window?.turns_reserved || 0,
        limit: limits.maxTurns,
      },
      windowResources: {
        usageAvailable: !!limits.resourceBudget && !unmeteredWindow,
        used: window ? parse(window.resources_used).tokens || 0 : 0,
        reserved: window ? parse(window.resources_reserved).tokens || 0 : 0,
        limit: limits.resourceBudget?.maxTokensPerWindow ?? null,
        unit: "tokens",
      },
      asyncResources: {
        usageAvailable: !!cfg.resourceBudget && !unmeteredAsync,
        used: sum("resources_used", "async"),
        reserved: sum("resources_reserved", "async"),
        limit: null,
        limits: {
          perTurn: cfg.resourceBudget?.maxTokensPerTurn ?? null,
          perDay: cfg.resourceBudget?.maxTokensPerDay ?? null,
        },
        unit: "tokens",
      },
      dailyMessages: {
        committed: daily.reduce((n, row) => n + row.committed, 0),
        limit: daily.reduce((n, row) => n + row.limit, 0),
        byParticipant: daily,
        resetsAt: Date.parse(day(now)) + 86400000,
      },
    };
  }
  /** @param {any} ctx @param {any} input */
  visitRead(ctx, input) {
    const a = socialToolSchemas.home_visit_read.parse(input),
      identity = this.bound(ctx, "visit", a.visitId),
      row = this.assertVisit(identity, a.visitId);
    const binding = {
        kind: "messages",
        reader: identity.generation,
        visitId: row.id,
        policy: this.policy().revision,
        revision: row.revision,
      },
      after = this.after(a.cursor, binding);
    const rows = this.db
        .prepare(
          "SELECT * FROM home_social_messages WHERE visit_id=? AND sequence>? ORDER BY sequence LIMIT ?",
        )
        .all(row.id, after, a.limit + 1),
      items = rows
        .slice(0, a.limit)
        .map((/** @type {any} */ m) =>
          this.retained(row)
            ? m
            : { ...m, body: "", body_cleared_at: this.runtime.now() },
        );
    const labels = [];
    for (const message of items) {
      if (
        !message.body ||
        message.retracted_at ||
        message.hidden_at ||
        message.body_cleared_at
      )
        continue;
      const messageLabels = [
        `social:${row.id}:${message.id}`,
        ...parse(message.source_labels),
      ];
      const historical = admitSocialWindowMessage(this.runtime, ctx, message);
      this.track(ctx, messageLabels, historical);
      labels.push(...messageLabels);
    }
    this.lease(
      ctx,
      () => {
        this.assertBinding(ctx);
        const currentVisit = this.assertVisit(identity, row.id);
        // Recheck actual retention and versions instead of expiring unchanged input.
        if (
          !this.retained(currentVisit) &&
          items.some(
            (/** @type {any} */ m) =>
              m.body && !m.retracted_at && !m.hidden_at && !m.body_cleared_at,
          )
        )
          throw Error("AUDIENCE_DENIED");
        for (const old of items) {
          if (old.retracted_at || old.hidden_at || old.body_cleared_at)
            continue;
          const current = this.db
            .prepare(
              "SELECT revision,retracted_at,hidden_at,body_cleared_at FROM home_social_messages WHERE id=? AND visit_id=?",
            )
            .get(old.id, row.id);
          if (
            !current ||
            current.revision !== old.revision ||
            current.retracted_at !== old.retracted_at ||
            current.hidden_at !== old.hidden_at ||
            current.body_cleared_at !== old.body_cleared_at
          )
            throw Error("AUDIENCE_DENIED");
        }
        return true;
      },
      labels,
    );
    const max = items.at(-1)?.sequence || after;
    ctx.socialDisplayedMessages ||= new Map();
    const displayed = ctx.socialDisplayedMessages.get(row.id) || new Map();
    for (const message of items)
      if (
        message.body &&
        !message.retracted_at &&
        !message.hidden_at &&
        !message.body_cleared_at
      )
        displayed.set(message.sequence, {
          id: message.id,
          revision: message.revision,
        });
    ctx.socialDisplayedMessages.set(row.id, displayed);
    ctx.socialDisplayed ||= new Map();
    ctx.socialDisplayed.set(
      row.id,
      Math.max(ctx.socialDisplayed.get(row.id) || 0, max),
    );
    const grant = this.db
        .prepare("SELECT * FROM home_social_grants WHERE visit_id=?")
        .get(row.id),
      now = this.runtime.now();
    return {
      ...this.visitMeta(row),
      messages: items.map((/** @type {any} */ m) => ({
        messageId: m.id,
        sequence: m.sequence,
        authorIdentity: {
          agentId: m.author_agent_id,
          generation: m.author_generation,
        },
        messageRevision: m.revision,
        committedAt: m.created_at,
        state: m.hidden_at
          ? "hidden"
          : m.retracted_at
            ? "retracted"
            : m.body_cleared_at
              ? "expired"
              : "committed",
        ...(!m.hidden_at && !m.retracted_at && !m.body_cleared_at
          ? { body: m.body }
          : {}),
      })),
      nextCursor: rows.length > a.limit ? this.cursor(binding, max) : null,
      policyRevision: this.policy().revision,
      grantRevision: grant?.revision,
      grantExpiresAt: grant?.expires_at,
      effectiveScope: grant && !grant.revoked_at ? parse(grant.scope) : [],
      lease: {
        expiresAt: Math.min(
          now + 15000,
          row.status === "active" ? row.expires_at : now + 15000,
        ),
      },
      permittedActions:
        row.status === "active" && now < row.expires_at
          ? ["send", "end", "retract"]
          : ["retract"],
      usage: this.usageDTO(
        row,
        identity.generation,
        this.db
          .prepare(
            "SELECT * FROM home_social_windows WHERE visit_id=? ORDER BY created_at DESC LIMIT 1",
          )
          .get(row.id),
      ),
    };
  }
  /** @param {any} ctx @param {any} input */
  messagesRead(ctx, input) {
    return this.visitRead(ctx, input);
  }
  /** @param {any} ctx @param {any} input */
  markRead(ctx, input) {
    const a = socialToolSchemas.home_visit_mark_read.parse(input),
      identity = this.bound(ctx, "visit", a.visitId);
    return this.execute(ctx, "mark_read", a, ({ now }) => {
      const row = this.assertVisit(identity, a.visitId);
      if (a.lastDisplayedSequence > (ctx.socialDisplayed?.get(row.id) || 0))
        throw Error("AUDIENCE_DENIED");
      const shown = ctx.socialDisplayedMessages
        ?.get(row.id)
        ?.get(a.lastDisplayedSequence);
      const current =
        shown &&
        this.db
          .prepare(
            "SELECT id,revision,retracted_at,hidden_at,body_cleared_at FROM home_social_messages WHERE visit_id=? AND sequence=?",
          )
          .get(row.id, a.lastDisplayedSequence);
      if (
        !shown ||
        !current ||
        current.id !== shown.id ||
        current.revision !== shown.revision ||
        current.retracted_at ||
        current.hidden_at ||
        current.body_cleared_at ||
        !this.retained(row)
      )
        throw Error("AUDIENCE_DENIED");
      this.db
        .prepare(
          "INSERT INTO home_social_read_cursors VALUES(?,?,?,?) ON CONFLICT(viewer_generation,visit_id) DO UPDATE SET last_read_sequence=max(last_read_sequence,excluded.last_read_sequence),updated_at=excluded.updated_at",
        )
        .run(identity.generation, row.id, a.lastDisplayedSequence, now);
      return {
        visitId: row.id,
        lastReadSequence: this.db
          .prepare(
            "SELECT last_read_sequence FROM home_social_read_cursors WHERE viewer_generation=? AND visit_id=?",
          )
          .get(identity.generation, row.id).last_read_sequence,
      };
    });
  }
  /** @param {any} ctx @param {any} input */
  send(ctx, input) {
    const a = socialToolSchemas.home_visit_send.parse(input),
      identity = this.bound(ctx, "visit", a.visitId, true);
    try {
      return this.execute(ctx, "send", a, ({ now, nextSequence }) => {
        const row = this.assertVisit(identity, a.visitId, {
            active: true,
            now,
          }),
          turn = this.db
            .prepare("SELECT * FROM home_social_turns WHERE id=?")
            .get(ctx.socialBinding.turnId),
          cfg = this.runtime.config.homeSocial;
        if (row.revision !== a.expectedVisitRevision)
          throw Error("REVISION_CONFLICT");
        if (turn.batch_sealed || turn.message_count >= cfg.maxMessagesPerTurn)
          throw Error("SOCIAL_TURN_CLOSED");
        if (turn.mode === "window") {
          const window = this.db
            .prepare("SELECT * FROM home_social_windows WHERE id=?")
            .get(turn.window_id);
          if (
            !window ||
            window.status !== "active" ||
            now >= window.deadline ||
            window.fence !== ctx.socialBinding.windowFence ||
            turn.message_count >=
              Math.min(
                cfg.maxMessagesPerTurn,
                parse(window.effective_limits).maxMessagesPerTurn,
              )
          )
            throw Error("SOCIAL_TURN_CLOSED");
        }
        const labels = this.share(ctx, ctx.socialBinding.target, a.body);
        if (
          this.usage(identity.generation, row.id, "message", now) >=
          cfg.maxMessagesPerVisitPerDay
        )
          throw Error("RATE_LIMITED");
        const messageId = randomUUID(),
          sequence = nextSequence(row.id);
        this.db
          .prepare(
            "INSERT INTO home_social_messages(id,visit_id,author_agent_id,author_generation,sequence,body,source_labels,audience,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
          )
          .run(
            messageId,
            row.id,
            identity.agentId,
            identity.generation,
            sequence,
            a.body,
            JSON.stringify(labels),
            JSON.stringify([row.host_generation, row.guest_generation]),
            now,
          );
        this.db
          .prepare(
            "UPDATE home_social_visits SET revision=revision+1 WHERE id=?",
          )
          .run(row.id);
        this.db
          .prepare(
            "UPDATE home_social_turns SET message_count=message_count+1 WHERE id=?",
          )
          .run(turn.id);
        this.charge(identity.generation, row.id, "message", now);
        this.event("message_committed", row.id, identity.generation, now, {
          messageId,
          sequence,
          turnId: ctx.socialBinding.turnId,
        });
        return {
          messageId,
          sequence,
          visitId: row.id,
          visitRevision: row.revision + 1,
          messageRevision: 1,
        };
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : "RESULT_UNKNOWN";
      if (!safeFailures.has(code)) throw error;
      const receipt = this.store.recordNotSent({
        actorIdentity: identity,
        requestId: a.requestId,
        kind: "send",
        payload: a,
        safeReason: code,
        resultReference: {
          target: { kind: "visit", id: a.visitId },
          hostGeneration: ctx.socialBinding.targetHostGeneration,
          guestGeneration: ctx.socialBinding.targetGuestGeneration,
        },
        authorize: () => {
          this.store.assertIdentity(identity);
          this.assertVisit(identity, a.visitId);
        },
      });
      return {
        ...receipt,
        ...(ctx.socialSendingClosed
          ? { notice: "本轮发送能力已关闭，尚未提交的内容未发送。" }
          : {}),
      };
    }
  }
  /** @param {any} ctx @param {any} input */
  end(ctx, input) {
    const a = socialToolSchemas.home_visit_end.parse(input),
      identity = this.bound(ctx, "visit", a.visitId, true);
    return this.execute(
      ctx,
      "end",
      a,
      ({ now }) => {
        const row = this.assertVisit(identity, a.visitId);
        if (row.status !== "active")
          return {
            ok: true,
            changed: false,
            alreadyClosed: true,
            ...this.visitMeta(row),
          };
        if (now >= row.expires_at) {
          this.closeVisit(row, now, "expired", null);
          return {
            ok: true,
            changed: false,
            alreadyClosed: true,
            state: "expired",
            visitId: row.id,
            visitRevision: row.revision + 1,
          };
        }
        if (row.revision !== a.expectedVisitRevision)
          throw Error("REVISION_CONFLICT");
        this.closeVisit(row, now, "ended", identity.generation);
        return {
          ok: true,
          changed: true,
          alreadyClosed: false,
          state: "ended",
          visitId: row.id,
          visitRevision: row.revision + 1,
        };
      },
      () => {},
      true,
      true,
    );
  }
  /** @param {any} ctx @param {any} input */
  retract(ctx, input) {
    const a = socialToolSchemas.home_visit_retract.parse(input),
      identity = this.assertBinding(ctx),
      message = this.db
        .prepare(
          "SELECT * FROM home_social_messages WHERE id=? AND author_generation=?",
        )
        .get(a.messageId, identity.generation);
    if (!message) throw Error("AUDIENCE_DENIED");
    this.bound(ctx, "visit", message.visit_id);
    return this.execute(ctx, "retract", a, ({ now }) => {
      this.assertVisit(identity, message.visit_id);
      const row = this.db
        .prepare("SELECT * FROM home_social_messages WHERE id=?")
        .get(message.id);
      if (row.revision !== a.expectedMessageRevision)
        throw Error("REVISION_CONFLICT");
      if (row.retracted_at || row.hidden_at)
        return {
          messageId: row.id,
          messageRevision: row.revision,
          changed: false,
        };
      this.db
        .prepare(
          "UPDATE home_social_messages SET body='',revision=revision+1,retracted_at=?,body_cleared_at=? WHERE id=?",
        )
        .run(now, now, row.id);
      this.event("message_retracted", row.visit_id, identity.generation, now, {
        messageId: row.id,
      });
      return {
        messageId: row.id,
        messageRevision: row.revision + 1,
        changed: true,
      };
    });
  }
  /** @param {any} identity @param {string} visitId @param {number} now */
  assertGrant(identity, visitId, now) {
    const visit = this.assertVisit(identity, visitId, { active: true, now }),
      grant = this.db
        .prepare("SELECT * FROM home_social_grants WHERE visit_id=?")
        .get(visitId);
    if (
      !grant ||
      grant.revoked_at ||
      now >= grant.expires_at ||
      grant.host_generation !== visit.host_generation ||
      grant.guest_generation !== visit.guest_generation ||
      grant.room_id !== "room:" + visit.host_generation ||
      grant.room_id !== visit.room_id
    )
      throw Error("AUDIENCE_DENIED");
    const host = this.identityGeneration(grant.host_generation),
      scope = parse(grant.scope),
      selected = parse(grant.selected_item_revisions);
    if (!scope.length) throw Error("AUDIENCE_DENIED");
    for (const i of selected) {
      const current = this.home.rooms.store.item(host.generation, i.slot);
      if (
        !scope.includes(i.slot) ||
        !current ||
        current.state !== "published" ||
        current.item_id !== i.itemId ||
        current.revision !== i.itemRevision ||
        !this.runtime.agent(host.agentId).home.publishing
      )
        throw Error("AUDIENCE_DENIED");
    }
    if (
      selected.length !==
      scope.filter((/** @type {string} */ s) => s !== "layout").length
    )
      throw Error("AUDIENCE_DENIED");
    return { visit, grant, scope, selected, host };
  }
  /** @param {any} ctx @param {any} input */
  roomRead(ctx, input) {
    const a = socialToolSchemas.home_visit_room_read.parse(input),
      identity = this.bound(ctx, "visit", a.visitId),
      now = this.runtime.now(),
      { visit, grant, scope, selected, host } = this.assertGrant(
        identity,
        a.visitId,
        now,
      );
    const binding = {
        kind: "grant",
        visitId: visit.id,
        reader: identity.generation,
        grant: grant.revision,
        policy: this.policy().revision,
      },
      after = this.after(a.cursor, binding),
      items = selected.slice(after, after + a.limit);
    const proof =
      this.sources.assertRoomItem ||
      this.runtime.homeSocialSources?.assertRoomItem;
    for (const item of selected) {
      if (!proof) throw Error("SOURCE_RESTRICTED");
      proof(this.runtime, ctx, {
        hostGeneration: host.generation,
        slot: item.slot,
        itemId: item.itemId,
        itemRevision: item.itemRevision,
      });
    }
    this.lease(ctx, () => {
      this.assertBinding(ctx);
      const current = this.assertGrant(identity, visit.id, this.runtime.now());
      if (current.grant.revision !== grant.revision)
        throw Error("AUDIENCE_DENIED");
      for (const item of selected) {
        if (!proof) throw Error("SOURCE_RESTRICTED");
        proof(
          this.runtime,
          ctx,
          {
            hostGeneration: host.generation,
            slot: item.slot,
            itemId: item.itemId,
            itemRevision: item.itemRevision,
          },
          [`social-grant:${visit.id}:${grant.revision}`],
        );
      }
      return true;
    }, [`social-grant:${visit.id}:${grant.revision}`]);
    this.track(ctx, [`social-grant:${visit.id}:${grant.revision}`]);
    const result = {
      visitId: visit.id,
      roomId: grant.room_id,
      identityGeneration: host.generation,
      grantRevision: grant.revision,
      policyRevision: this.policy().revision,
      effectiveScope: scope,
      selectedItemRevisions: selected,
      ...(scope.includes("layout")
        ? {
            layout: this.home.rooms.store.layout(host.generation),
            template: homeTemplate("room"),
          }
        : {}),
      items: items.map((/** @type {any} */ i) => {
        const row = this.home.rooms.store.item(host.generation, i.slot);
        return { ...i, title: row.title, body: row.body };
      }),
      nextCursor:
        after + items.length < selected.length
          ? this.cursor(binding, after + items.length)
          : null,
      lease: {
        expiresAt: Math.min(now + 15000, grant.expires_at, visit.expires_at),
      },
      permittedActions: ["read"],
    };
    this.assertGrant(identity, a.visitId, this.runtime.now());
    return result;
  }
  /** @param {any} ctx @param {any} input */
  grantReduce(ctx, input) {
    const a = socialToolSchemas.home_visit_grant_reduce.parse(input),
      identity = this.bound(ctx, "visit", a.visitId);
    return this.execute(ctx, "grant_reduce", a, ({ now }) => {
      const visit = this.assertVisit(identity, a.visitId, {
          active: true,
          now,
        }),
        grant = this.db
          .prepare("SELECT * FROM home_social_grants WHERE visit_id=?")
          .get(visit.id);
      if (
        identity.generation !== visit.host_generation ||
        !grant ||
        grant.revoked_at
      )
        throw Error("AUDIENCE_DENIED");
      if (grant.revision !== a.expectedGrantRevision)
        throw Error("REVISION_CONFLICT");
      const scope = parse(grant.scope),
        selected = parse(grant.selected_item_revisions);
      if (
        a.expiresAt > Math.min(grant.expires_at, visit.expires_at) ||
        a.scope.some((s) => !scope.includes(s)) ||
        a.selectedItems.some(
          (i) =>
            !selected.some((/** @type {any} */ previous) => same(i, previous)),
        ) ||
        a.selectedItems.length !==
          a.scope.filter((s) => s !== "layout").length ||
        a.selectedItems.some((i) => !a.scope.includes(i.slot))
      )
        throw Error("AUDIENCE_DENIED");
      this.db
        .prepare(
          "UPDATE home_social_grants SET scope=?,selected_item_revisions=?,revision=revision+1,fence=fence+1,expires_at=? WHERE visit_id=?",
        )
        .run(
          JSON.stringify(a.scope),
          JSON.stringify(a.selectedItems),
          a.expiresAt,
          visit.id,
        );
      this.event("grant_reduced", visit.id, identity.generation, now);
      return {
        visitId: visit.id,
        effectiveScope: a.scope,
        selectedItemRevisions: a.selectedItems,
        grantRevision: grant.revision + 1,
        grantExpiresAt: a.expiresAt,
      };
    });
  }
  /** @param {any} ctx @param {any} input */
  block(ctx, input) {
    const a = socialToolSchemas.home_social_block.parse(input),
      identity = this.assertBinding(ctx);
    return this.execute(ctx, "block", a, ({ now }) => {
      const other = this.identity(a.targetAgentId),
        p = this.policy();
      if (
        other.generation === identity.generation ||
        ![
          ctx.socialBinding.targetHostGeneration,
          ctx.socialBinding.targetGuestGeneration,
        ].includes(other.generation)
      )
        throw Error("AUDIENCE_DENIED");
      if (p.revision !== a.expectedPolicyRevision)
        throw Error("REVISION_CONFLICT");
      this.db
        .prepare(
          "INSERT INTO home_social_blocks VALUES(?,?,1,?,?) ON CONFLICT(actor_generation,target_generation) DO UPDATE SET active=excluded.active,revision=revision+1",
        )
        .run(identity.generation, other.generation, a.blocked ? 1 : 0, now);
      if (a.blocked) {
        const visits = this.db
          .prepare(
            "SELECT * FROM home_social_visits WHERE status='active' AND ((host_generation=? AND guest_generation=?) OR (host_generation=? AND guest_generation=?))",
          )
          .all(
            identity.generation,
            other.generation,
            other.generation,
            identity.generation,
          );
        for (const visit of visits)
          this.closeVisit(visit, now, "invalidated", identity.generation);
        this.db
          .prepare(
            "UPDATE home_social_invitations SET status='invalidated',revision=revision+1,decided_at=?,closed_reason='permission_changed' WHERE status='pending' AND ((host_generation=? AND guest_generation=?) OR (host_generation=? AND guest_generation=?))",
          )
          .run(
            now,
            identity.generation,
            other.generation,
            other.generation,
            identity.generation,
          );
      }
      this.db
        .prepare(
          "UPDATE home_social_policy SET revision=revision+1 WHERE singleton=1",
        )
        .run();
      return { blocked: a.blocked, policyRevision: p.revision + 1 };
    });
  }
  /** @param {any} ctx @param {any} input */
  operationRead(ctx, input) {
    const a = socialToolSchemas.home_social_operation_read.parse(input),
      identity = this.assertBinding(ctx);
    const receipt = this.store.operationRead(identity, a.requestId);
    if (!("result" in receipt) || receipt.status === "unknown")
      return {
        requestId: a.requestId,
        status: "unknown",
        historicalReplay: true,
      };
    const result = receipt.result,
      binding = ctx.socialBinding;
    let reference = result.resultReference;
    if (!reference && result.turnId) {
      const turn = this.db
        .prepare(
          "SELECT * FROM home_social_turns WHERE id=? AND actor_generation=?",
        )
        .get(result.turnId, identity.generation);
      if (turn)
        reference = {
          target: { kind: turn.target_kind, id: turn.target_id },
          hostGeneration: turn.target_host_generation,
          guestGeneration: turn.target_guest_generation,
        };
    }
    let current;
    let visitId = result.visitId,
      invitationId = result.invitationId;
    if (result.messageId)
      visitId = this.db
        .prepare("SELECT visit_id FROM home_social_messages WHERE id=?")
        .get(result.messageId)?.visit_id;
    if (!visitId && result.windowId)
      visitId = this.db
        .prepare("SELECT visit_id FROM home_social_windows WHERE id=?")
        .get(result.windowId)?.visit_id;
    if (!visitId && reference?.target.kind === "visit")
      visitId = reference.target.id;
    if (!invitationId && reference?.target.kind === "invitation")
      invitationId = reference.target.id;
    const pairMatches = (
      /** @type {string} */ host,
      /** @type {string} */ guest,
    ) =>
      same(
        [host, guest].sort(),
        [binding.targetHostGeneration, binding.targetGuestGeneration].sort(),
      );
    if (visitId) {
      const visit = this.assertVisit(identity, visitId);
      current = {
        kind: "visit",
        id: visit.id,
        state: this.visitMeta(visit).state,
        revision: visit.revision,
      };
      if (
        visit.status === "invalidated" ||
        !(
          (binding.target.kind === "visit" && binding.target.id === visit.id) ||
          (binding.target.kind === "invitation" &&
            binding.target.id === visit.invitation_id) ||
          (binding.target.kind === "compose" &&
            pairMatches(visit.host_generation, visit.guest_generation))
        )
      )
        throw Error("AUDIENCE_DENIED");
    } else if (invitationId) {
      const invitation = this.assertInvitation(identity, invitationId);
      current = {
        kind: "invitation",
        id: invitation.id,
        state: this.invitationMeta(invitation).state,
        revision: invitation.revision,
      };
      if (invitation.status === "invalidated") throw Error("AUDIENCE_DENIED");
      const visit =
        binding.target.kind === "visit"
          ? this.assertVisit(identity, binding.target.id)
          : null;
      if (!(
        (binding.target.kind === "invitation" &&
          binding.target.id === invitation.id) ||
        visit?.invitation_id === invitation.id ||
        (binding.target.kind === "compose" &&
          pairMatches(invitation.host_generation, invitation.guest_generation))
      ))
        throw Error("AUDIENCE_DENIED");
    } else if (
      reference?.target.kind === "compose" &&
      binding.target.kind === "compose" &&
      pairMatches(reference.hostGeneration, reference.guestGeneration)
    ) {
      current = {
        kind: "compose",
        id: binding.target.id,
        policyRevision: this.policy().revision,
      };
      if (receipt.kind !== "block")
        this.assertPair(reference.hostGeneration, reference.guestGeneration);
    } else throw Error("AUDIENCE_DENIED");
    return { ...receipt, current };
  }
  /** @param {any} principal */
  assertAdmin(principal) {
    if (principal !== SOCIAL_ADMIN_PRINCIPAL) throw Error("IDENTITY_DENIED");
  }
  /** This accepts metadata only, so middleware can audit rejected requests without opening private records.
   * @param {{principal:string,targetKind:string,targetId:string,action:string,authorized:boolean,outcome:string,safeError?:string}} input */
  auditAdminAccess({
    principal,
    targetKind,
    targetId,
    action,
    authorized,
    outcome,
    safeError,
  }) {
    const id = randomUUID(),
      safe = (/** @type {string} */ value) =>
        /^[A-Za-z0-9:_-]{1,100}$/.test(value) ? value : "unknown";
    this.store.transaction((now) => {
      this.db
        .prepare(
          "INSERT INTO home_social_admin_access_audit VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          principal === SOCIAL_ADMIN_PRINCIPAL ? principal : "unauthenticated",
          safe(targetKind),
          safe(targetId),
          safe(action),
          authorized ? 1 : 0,
          safe(outcome),
          safeError ? safe(safeError) : null,
          now,
        );
    });
    return id;
  }
  /** @param {any} principal @param {any} input */
  adminOverview(principal, input = {}) {
    this.assertAdmin(principal);
    const a = adminOverviewSchema.parse(input),
      binding = {
        kind: "admin-overview",
        policy: this.policy().revision,
        agentId: a.agentId || null,
        roomOwnerAgentId: a.roomOwnerAgentId || null,
        recordKind: a.kind || null,
      },
      after = this.after(a.cursor, binding);
    const filters = [],
      args = [];
    if (a.agentId) {
      filters.push("(host_agent_id=? OR guest_agent_id=?)");
      args.push(a.agentId, a.agentId);
    }
    if (a.roomOwnerAgentId) {
      filters.push("host_agent_id=?");
      args.push(a.roomOwnerAgentId);
    }
    if (a.kind) {
      filters.push("kind=?");
      args.push(a.kind);
    }
    if (a.kind === "visit" && after) {
      filters.push("(created_at<? OR (created_at=? AND id>?))");
      args.push(after.createdAt, after.createdAt, after.id);
    }
    const filter = filters.length ? " WHERE " + filters.join(" AND ") : "",
      order = a.kind === "visit" ? "created_at DESC,id" : "kind,id";
    // List pages select metadata only; neither invitation prose nor message bodies enter memory.
    const from = `WITH overview AS (
      SELECT 'invitation' AS kind,id,revision,host_agent_id,host_generation,guest_agent_id,guest_generation,room_id,status,created_at,expires_at,requested_scope,effective_scope,initiator_generation,recipient_generation,NULL AS invitation_id,NULL AS started_at,NULL AS ended_at,NULL AS closed_reason FROM home_social_invitations
      UNION ALL
      SELECT 'visit',id,revision,host_agent_id,host_generation,guest_agent_id,guest_generation,room_id,status,started_at,expires_at,NULL,NULL,NULL,NULL,invitation_id,started_at,ended_at,closed_reason FROM home_social_visits
    ) SELECT * FROM overview`;
    const rows = this.db
        .prepare(from + filter + " ORDER BY " + order + " LIMIT ? OFFSET ?")
        .all(...args, a.limit + 1, a.kind === "visit" ? 0 : after),
      items = rows.slice(0, a.limit);
    return {
      items: items.map((/** @type {any} */ row) => ({
        kind: row.kind,
        ...(row.kind === "invitation"
          ? this.invitationMeta(row)
          : this.visitMeta(row)),
      })),
      nextCursor:
        rows.length > a.limit
          ? this.cursor(
              binding,
              a.kind === "visit"
                ? { createdAt: items.at(-1).created_at, id: items.at(-1).id }
                : after + items.length,
            )
          : null,
      policyRevision: this.policy().revision,
      serverNow: this.runtime.now(),
    };
  }
  /** Each page audits before returning any body; parse and authorization failures are audited too.
   * @param {any} principal @param {any} input */
  adminRead(principal, input) {
    let a, output;
    try {
      this.assertAdmin(principal);
      a = adminReadSchema.parse(input);
      const now = this.runtime.now();
      if (a.kind === "invitation") {
        const row = this.db
          .prepare("SELECT * FROM home_social_invitations WHERE id=?")
          .get(a.id);
        if (!row || !this.invitationRetained(row))
          throw Error("AUDIENCE_DENIED");
        output = {
          ...this.invitationMeta(row),
          purpose: row.purpose,
          ...(row.reason ? { reason: row.reason } : {}),
          lease: { expiresAt: now + 15000 },
          permittedActions: [],
        };
      } else {
        const row = this.db
          .prepare("SELECT * FROM home_social_visits WHERE id=?")
          .get(a.id);
        if (!row) throw Error("AUDIENCE_DENIED");
        const binding = {
            kind: "admin-messages",
            visitId: a.id,
            revision: row.revision,
            policy: this.policy().revision,
          },
          after = this.after(a.cursor, binding),
          rows = this.db
            .prepare(
              "SELECT * FROM home_social_messages WHERE visit_id=? AND sequence>? ORDER BY sequence LIMIT ?",
            )
            .all(a.id, after, a.limit + 1),
          items = rows
            .slice(0, a.limit)
            .map((/** @type {any} */ m) =>
              this.retained(row) ? m : { ...m, body: "", body_cleared_at: now },
            );
        const grant = this.db
            .prepare("SELECT * FROM home_social_grants WHERE visit_id=?")
            .get(a.id),
          window = this.db
            .prepare(
              "SELECT * FROM home_social_windows WHERE visit_id=? ORDER BY created_at DESC LIMIT 1",
            )
            .get(a.id);
        output = {
          ...this.visitMeta(row),
          messages: items.map((/** @type {any} */ m) => ({
            messageId: m.id,
            sequence: m.sequence,
            messageRevision: m.revision,
            author: {
              agentId: m.author_agent_id,
              identityGeneration: m.author_generation,
              name:
                this.runtime.config.agents.find(
                  (/** @type {any} */ a) => a.id === m.author_agent_id,
                )?.name || "已移除角色",
            },
            authorIdentity: {
              agentId: m.author_agent_id,
              generation: m.author_generation,
            },
            committedAt: m.created_at,
            state: m.hidden_at
              ? "hidden"
              : m.retracted_at
                ? "retracted"
                : m.body_cleared_at
                  ? "expired"
                  : "committed",
            ...(!m.hidden_at && !m.retracted_at && !m.body_cleared_at
              ? { body: m.body }
              : {}),
          })),
          requestedScope: parse(
            this.db
              .prepare(
                "SELECT requested_scope FROM home_social_invitations WHERE id=?",
              )
              .get(row.invitation_id).requested_scope,
          ).scope,
          grantRevision: grant?.revision,
          effectiveScope: grant && !grant.revoked_at ? parse(grant.scope) : [],
          grantExpiresAt: grant?.expires_at,
          usage: this.usageDTO(row, null, window),
          window: window
            ? {
                id: window.id,
                revision: window.revision,
                state: window.status,
                termsRevision: window.terms_revision,
                effectiveLimits: parse(window.effective_limits),
                deadline: window.deadline,
                closeReason: window.closed_reason,
              }
            : null,
          nextCursor:
            rows.length > a.limit
              ? this.cursor(binding, items.at(-1).sequence)
              : null,
          lease: { expiresAt: now + 15000 },
          permittedActions:
            row.status === "active"
              ? ["terminate-visit", "hide-message", "close-window"]
              : ["hide-message"],
        };
      }
    } catch (error) {
      this.auditAdminAccess({
        principal,
        targetKind: a?.kind || "unknown",
        targetId: a?.id || "unknown",
        action: "read",
        authorized: principal === SOCIAL_ADMIN_PRINCIPAL,
        outcome: "denied",
        safeError:
          error instanceof Error && /^[A-Z_]+$/.test(error.message)
            ? error.message
            : "INVALID_REQUEST",
      });
      throw error;
    }
    const auditId = this.auditAdminAccess({
      principal,
      targetKind: a.kind,
      targetId: a.id,
      action: "read",
      authorized: true,
      outcome: "success",
    });
    return { ...output, auditId, policyRevision: this.policy().revision };
  }
  /** @param {any} principal @param {any} input */
  moderate(principal, input) {
    let parsed;
    try {
      this.assertAdmin(principal);
      parsed = moderateSchema.parse(input);
      return this.moderateInternal(principal, parsed);
    } catch (error) {
      this.auditAdminAccess({
        principal,
        targetKind: parsed ? "moderation" : "unknown",
        targetId: parsed?.targetId || "unknown",
        action: parsed?.action || "moderate",
        authorized: principal === SOCIAL_ADMIN_PRINCIPAL,
        outcome: "denied",
        safeError:
          error instanceof Error && /^[A-Z_]+$/.test(error.message)
            ? error.message
            : "INVALID_REQUEST",
      });
      throw error;
    }
  }
  /** @param {any} principal @param {any} input */
  moderateInternal(principal, input) {
    this.assertAdmin(principal);
    const a = moderateSchema.parse(input);
    const admin = {
      agentId: "instance-administrator",
      generation: "instance-administrator",
    };
    // Administrator authority has a separate ledger namespace and never impersonates a participant.
    return this.adminExecute(admin, a, ({ now }) => {
      if (a.policyRevision !== this.policy().revision)
        throw Error("REVISION_CONFLICT");
      if (a.action === "hide-message") {
        const row = this.db
          .prepare("SELECT * FROM home_social_messages WHERE id=?")
          .get(a.targetId);
        if (!row) throw Error("AUDIENCE_DENIED");
        if (row.revision !== a.expectedRevision)
          throw Error("REVISION_CONFLICT");
        if (row.hidden_at)
          return {
            changed: false,
            messageId: row.id,
            messageRevision: row.revision,
          };
        this.db
          .prepare(
            "UPDATE home_social_messages SET body='',hidden_at=?,body_cleared_at=?,revision=revision+1 WHERE id=?",
          )
          .run(now, now, row.id);
        this.event("message_hidden", row.visit_id, admin.generation, now, {
          messageId: row.id,
        });
        return {
          changed: true,
          messageId: row.id,
          messageRevision: row.revision + 1,
        };
      }
      if (a.action === "terminate-visit") {
        const row = this.db
          .prepare("SELECT * FROM home_social_visits WHERE id=?")
          .get(a.targetId);
        if (!row) throw Error("AUDIENCE_DENIED");
        if (row.status !== "active")
          return {
            changed: false,
            alreadyClosed: true,
            state: row.status,
            visitRevision: row.revision,
          };
        if (row.revision !== a.expectedRevision)
          throw Error("REVISION_CONFLICT");
        this.closeVisit(
          row,
          now,
          now >= row.expires_at ? "expired" : "invalidated",
          admin.generation,
        );
        return {
          changed: true,
          visitId: row.id,
          visitRevision: row.revision + 1,
        };
      }
      const row = this.db
        .prepare("SELECT * FROM home_social_windows WHERE id=?")
        .get(a.targetId);
      if (!row) throw Error("AUDIENCE_DENIED");
      if (!["proposed", "active"].includes(row.status))
        return {
          changed: false,
          alreadyClosed: true,
          state: row.status,
          revision: row.revision,
        };
      if (row.revision !== a.expectedRevision) throw Error("REVISION_CONFLICT");
      this.store.closeWindow(row, now, "administrator");
      return { changed: true, windowId: row.id, revision: row.revision + 1 };
    });
  }
  /** @param {any} identity @param {any} input @param {(gate:any)=>any} apply */
  adminExecute(identity, input, apply) {
    // The synthetic administrator principal is not a home resident. Its authority is checked above.
    return this.store.transaction((now) => {
      const hash = createHash("sha256")
          .update(JSON.stringify(input))
          .digest("hex"),
        prior = this.db
          .prepare(
            "SELECT * FROM home_social_operations WHERE actor_generation=? AND request_id=?",
          )
          .get(identity.generation, input.requestId);
      const audit = () =>
        this.db
          .prepare(
            "INSERT INTO home_social_admin_access_audit VALUES(?,?,?,?,?,?,?,?,?)",
          )
          .run(
            randomUUID(),
            SOCIAL_ADMIN_PRINCIPAL,
            "moderation",
            input.targetId,
            input.action,
            1,
            "success",
            null,
            now,
          );
      if (prior) {
        if (prior.payload_hash !== hash) throw Error("IDEMPOTENCY_MISMATCH");
        audit();
        return this.store.receipt(prior, true);
      }
      const result = apply({ now }),
        operationId = randomUUID();
      audit();
      this.db
        .prepare("INSERT INTO home_social_operations VALUES(?,?,?,?,?,?,?,?,?)")
        .run(
          identity.generation,
          identity.agentId,
          input.requestId,
          "moderate",
          hash,
          operationId,
          "committed",
          JSON.stringify(result),
          now,
        );
      return {
        operationId,
        requestId: input.requestId,
        kind: "moderate",
        status: "committed",
        committedAt: new Date(now).toISOString(),
        historicalReplay: false,
        result,
      };
    });
  }
  /** Called in the same transaction as home identity synchronization.
   * @param {number} now */
  syncPolicyInTransaction(now) {
    if (!this.db.isTransaction) throw Error("SOCIAL_TRANSACTION_REQUIRED");
    const r = this.runtime,
      p = this.policy(),
      previous = parse(p.value),
      cfg = r.config.homeSocial;
    const permission = {
      enabled: cfg.enabled,
      exchangeEnabled: cfg.exchangeEnabled,
      mode: r.config.mode,
      globalPaused: r.config.globalPaused,
      participants: participantPolicies(
        r.config.agents.map((/** @type {any} */ a) => ({
          id: a.id,
          paused: a.paused,
          subjectEnabled: a.subject.enabled,
          proactiveEnabled: a.behavior.proactive.enabled,
          offlineReview: a.subject.offlineReview,
          reviewInSilence: a.subject.reviewInSilence,
          enabled: a.home?.enabled,
          social: a.home?.social?.enabled,
          publishing: a.home?.publishing,
          snapshots: a.home?.projectSnapshots?.enabled,
          backendId: a.backendId,
          model: a.model,
        })),
        r.config.backends,
      ),
    };
    const prior = previous.permission;
    const previousParticipants =
      prior?.participants ??
      participantPolicies(prior?.agents ?? [], prior?.backends ?? []);
    const changedParticipants = Object.entries(permission.participants)
      .filter(([id, policy]) => !same(previousParticipants[id], policy))
      .map(([id]) => id);
    const instanceChanged =
      !prior ||
      prior.enabled !== permission.enabled ||
      prior.mode !== permission.mode ||
      prior.globalPaused !== permission.globalPaused;
    const exchangeChanged =
      prior?.exchangeEnabled !== permission.exchangeEnabled;
    const rightsChanged =
      instanceChanged ||
      exchangeChanged ||
      changedParticipants.length > 0 ||
      Object.keys(previousParticipants).length !==
        Object.keys(permission.participants).length;
    const recoveryBlocked =
      !!p.recovery_epoch &&
      !p.enabled &&
      previous.permission?.enabled &&
      cfg.enabled;
    const enabled = !!cfg.enabled && !recoveryBlocked;
    for (const a of r.config.agents) {
      if (!enabled || !a.home?.enabled || !a.home?.social?.enabled) {
        const row = this.db
          .prepare(
            "SELECT generation FROM home_identities WHERE agent_id=? AND active=1",
          )
          .get(a.id);
        if (row)
          this.store.invalidateIdentityInTransaction(
            { agentId: a.id, generation: row.generation },
            "permission_changed",
            now,
          );
      }
    }
    if (prior && instanceChanged) {
      const scope = /** @type {const} */ ({ all: true });
      this.store.transitionWindows(now, scope, "permission_changed", "closed");
      this.store.stopWork(now, scope);
    } else if (prior) {
      if (exchangeChanged)
        for (const window of this.db
          .prepare(
            "SELECT * FROM home_social_windows WHERE status IN ('proposed','active')",
          )
          .all())
          this.store.closeWindow(window, now, "permission_changed");
      for (const agentId of changedParticipants) {
        const row = this.db
          .prepare(
            "SELECT generation FROM home_identities WHERE agent_id=? AND active=1",
          )
          .get(agentId);
        if (!row) continue;
        const scope = { generation: String(row.generation) };
        this.store.transitionWindows(
          now,
          scope,
          "permission_changed",
          "closed",
        );
        this.store.stopWork(now, scope);
      }
    }
    // Accepted limits never grow; tightening remains effective without revoking unrelated authority.
    for (const window of this.db
      .prepare(
        "SELECT * FROM home_social_windows WHERE status IN ('proposed','active')",
      )
      .all()) {
      const old = parse(window.effective_limits),
        limits = { ...old };
      for (const key of ["durationMinutes", "maxTurns", "maxMessagesPerTurn"])
        limits[key] = Math.min(old[key], cfg[key]);
      limits.resourceBudget = effectiveSocialResourceBudget(
        old.resourceBudget,
        cfg.resourceBudget,
      );
      const deadline =
        window.deadline === null
          ? null
          : Math.min(
              window.deadline,
              window.started_at + limits.durationMinutes * 60000,
            );
      const resources = parse(window.resources_used).tokens || 0,
        reserved = parse(window.resources_reserved).tokens || 0;
      const exhausted =
        (deadline !== null && now >= deadline) ||
        window.turns_used + window.turns_reserved > limits.maxTurns ||
        (limits.resourceBudget &&
          resources + reserved > limits.resourceBudget.maxTokensPerWindow);
      this.db
        .prepare(
          "UPDATE home_social_windows SET effective_limits=?,deadline=? WHERE id=?",
        )
        .run(JSON.stringify(limits), deadline, window.id);
      if (exhausted) this.store.closeWindow(window, now, "limits_reduced");
    }
    this.db
      .prepare(
        "UPDATE home_social_policy SET revision=revision+?,enabled=?,exchange_enabled=?,recovery_epoch=?,value=? WHERE singleton=1",
      )
      .run(
        rightsChanged ? 1 : 0,
        enabled ? 1 : 0,
        enabled && cfg.exchangeEnabled ? 1 : 0,
        cfg.enabled ? p.recovery_epoch : "",
        JSON.stringify({
          permission,
          limits: cfg,
          configRevision: r.configStore.revision,
        }),
      );
  }
}
