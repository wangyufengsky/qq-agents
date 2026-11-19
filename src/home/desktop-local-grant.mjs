import { z } from "zod";
import { DesktopGrantLease } from "./desktop-grant-lease.mjs";
import { DESKTOP_CONVERSATION } from "./desktop-decision.mjs";

const uuid = z.string().uuid();
export const localRevokeSchema = z
  .object({ roomEpoch: uuid, grantId: uuid })
  .strict();
export const localGrantSchema = localRevokeSchema
  .extend({ agentId: z.string().min(1).max(64) })
  .strict();

export class DesktopLocalGrant {
  constructor(host, tool, unavailable) {
    this.host = host;
    this.tool = tool;
    this.unavailable = unavailable;
    this.lease = new DesktopGrantLease(host, unavailable);
  }

  eligible() {
    const { live, runtime } = this.host;
    return (live?.here() ?? []).filter(({ id }) =>
      runtime
        .toolsFor(runtime.agent(id), DESKTOP_CONVERSATION)
        .includes(this.tool),
    );
  }

  grantFor() {
    return this.grant;
  }

  current(grant) {
    return (
      grant &&
      this.grantFor(grant.agentId) === grant &&
      this.lease.valid(grant) &&
      this.host.connected() &&
      this.host.live.room.epoch === grant.roomEpoch &&
      this.host.live.visits.get(grant.agentId) === grant.visit &&
      this.eligible().some(({ id }) => id === grant.agentId)
    );
  }

  state() {
    if (this.grant && !this.current(this.grant)) {
      this.lease.expired(this.grant);
      this.clear();
    }
    return {
      eligible: this.eligible().map(({ id }) => id),
      grantedAgentId: this.grant?.agentId ?? null,
      ...(this.grant?.expiresAt && { expiresAt: this.grant.expiresAt }),
    };
  }

  clear() {
    this.lease.clear(this.grant);
    this.grant = null;
  }

  change(revoking, value) {
    const { live } = this.host;
    if (value.roomEpoch !== live.room.epoch) throw Error(this.unavailable);
    if (revoking) {
      if (this.grant?.grantId === value.grantId) this.clear();
      return;
    }
    if (!this.eligible().some(({ id }) => id === value.agentId))
      throw Error(this.unavailable);
    const grant = { ...value, visit: live.visits.get(value.agentId) };
    this.lease.attach(grant, () => {
      if (this.grant === grant) {
        this.lease.expired(grant);
        this.clear();
        this.host.notify();
      }
    });
    this.clear();
    this.grant = grant;
  }

  activeGrant(ctx, agent) {
    const { runtime } = this.host;
    const grant = this.grantFor(agent.id);
    const epoch = ctx.inputEpoch;
    const current = () => {
      try {
        runtime.assertActive(ctx);
        return (
          ctx.inputEpoch === epoch &&
          ctx.runtimeKind === "desktop" &&
          grant?.agentId === agent.id &&
          (!ctx.desktopGrantBindings ||
            ctx.desktopGrantBindings.get(this.tool) === grant) &&
          (!ctx.desktopWindowTask ||
            (ctx.desktopWindowTaskReady &&
              ctx.desktopWindowTask.grantId === grant.grantId &&
              ctx.desktopWindowTask.current())) &&
          this.current(grant)
        );
      } catch {
        return false;
      }
    };
    if (!current()) throw Error(this.unavailable);
    return { grant, current };
  }
}

export const localControlTargetId = z.string().uuid();

export class DesktopControlGrants {
  constructor(owner) {
    this.owner = owner;
    this.records = new Map();
    this.revoked = new Set();
    this.db = owner.host.runtime.memory?.db;
    this.db?.exec(`
      CREATE TABLE IF NOT EXISTS desktop_control_grants (
        tool TEXT NOT NULL,
        grant_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        origin TEXT,
        revoked INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (tool, grant_id)
      )
    `);
    for (const { grantId, revoked, ...grant } of this.db
      ?.prepare(
        `SELECT grant_id AS grantId, agent_id AS agentId,
        target_id AS targetId, origin, revoked FROM desktop_control_grants
        WHERE tool=?`,
      )
      .all(owner.tool) ?? []) {
      if (revoked) this.revoked.add(grantId);
      else
        this.records.set(grantId, {
          ...grant,
          grantId,
          origin: grant.origin ?? undefined,
          unified: true,
        });
    }
  }

  state() {
    return this.records.size || this.revoked.size
      ? { grants: this.list() }
      : {};
  }

  view(grant) {
    const { grantId, agentId, targetId, origin } = grant;
    return { grantId, agentId, targetId, ...(origin && { origin }) };
  }

  eligible() {
    const { host } = this.owner;
    const { live, runtime } = host;
    if (!host.connected()) return [];
    return (live?.here() ?? [])
      .filter(
        ({ id }) =>
          live.visits.has(id) &&
          (runtime.writable?.(runtime.agent(id), DESKTOP_CONVERSATION) ?? true),
      )
      .map(({ id }) => id);
  }

  current(grant) {
    const { host } = this.owner;
    return Boolean(
      grant &&
      this.records.get(grant.grantId) === grant &&
      host.connected() &&
      host.live?.visits.has(grant.agentId) &&
      this.eligible().includes(grant.agentId),
    );
  }

  list(agentId) {
    return Array.from(this.records.values())
      .filter((grant) => agentId === undefined || grant.agentId === agentId)
      .map((grant) => this.view(grant));
  }

  change(value) {
    const { host, unavailable } = this.owner;
    if (
      !host.connected() ||
      value.roomEpoch !== host.live?.room.epoch ||
      !this.eligible().includes(value.agentId)
    )
      throw Error(unavailable);
    const { grantId, targetId, agentId, origin } = value;
    const existing = this.records.get(grantId);
    if (existing) {
      if (
        existing.targetId !== targetId ||
        existing.agentId !== agentId ||
        existing.origin !== origin
      )
        throw Error(unavailable);
      return;
    }
    if (
      this.revoked.has(grantId) ||
      this.list(agentId).some((grant) => grant.targetId === targetId)
    )
      throw Error(unavailable);
    this.db
      ?.prepare(
        `INSERT INTO desktop_control_grants
        (tool, grant_id, agent_id, target_id, origin) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(this.owner.tool, grantId, agentId, targetId, origin ?? null);
    this.records.set(grantId, {
      grantId,
      targetId,
      agentId,
      origin,
      unified: true,
    });
  }

  get(grantId, agentId) {
    if (!grantId) {
      const grants = this.list(agentId);
      if (grants.length !== 1) return;
      grantId = grants[0].grantId;
    }
    const grant = this.records.get(grantId);
    if (grant?.agentId === agentId) return grant;
  }

  remove(grantId, agentId) {
    const grant = this.records.get(grantId);
    if (!grant || (agentId !== undefined && grant.agentId !== agentId)) return;
    this.db
      ?.prepare(
        "UPDATE desktop_control_grants SET revoked=1 WHERE tool=? AND grant_id=?",
      )
      .run(this.owner.tool, grantId);
    this.records.delete(grantId);
    this.revoked.add(grantId);
    return grant;
  }
}
