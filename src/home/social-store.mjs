// @ts-check
import { createHash, randomUUID } from "node:crypto";
import { migrateHomeSocial } from "./social-schema.mjs";

/** @typedef {{agentId:string,generation:string}} SocialIdentity */
/** @param {any} value @returns {any} */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
/** This blacklist is only a backstop: services must construct explicit allowlisted receipts.
 * It cannot infer whether an arbitrary string contains sensitive prose.
 * @param {any} value */
function safeResult(value) {
  if (!value || typeof value !== "object" || "then" in value)
    throw Error("SOCIAL_RECEIPT_INVALID");
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    for (const [key, entry] of Object.entries(item)) {
      if (
        /^(body|purpose|purposeText|reason|draft|text|title|sourceLabels|sourceText|content)$/i.test(
          key,
        )
      )
        throw Error("SOCIAL_RECEIPT_INVALID");
      if (entry && typeof entry === "object") pending.push(entry);
    }
  }
  return JSON.parse(JSON.stringify(value));
}

/** Internal domain storage. Services supply current authorization before any DTO leaves the process. */
export class SocialStore {
  /** @param {import("node:sqlite").DatabaseSync} db
   * @param {{clock?:()=>number,uuid?:()=>string}} [options] */
  constructor(db, { clock = Date.now, uuid = randomUUID } = {}) {
    this.db = db;
    this.clock = clock;
    this.uuid = uuid;
    migrateHomeSocial(db);
  }
  /** @param {SocialIdentity} identity */
  assertIdentity(identity) {
    const row = this.db
      .prepare("SELECT generation,active FROM home_identities WHERE agent_id=?")
      .get(identity.agentId);
    if (!row?.active || row.generation !== identity.generation)
      throw Error("IDENTITY_DENIED");
  }
  /** @template T @param {(now:number)=>T} apply @returns {T} */
  transaction(apply) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // The clock is read after acquiring the write lock, never before queueing.
      const now = this.clock();
      if (!Number.isSafeInteger(now) || now < 0)
        throw Error("SOCIAL_CLOCK_INVALID");
      const result = apply(now);
      if (result && typeof result === "object" && "then" in result)
        throw Error("SOCIAL_ASYNC_TRANSACTION_DENIED");
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }
  /** @param {{actorIdentity:SocialIdentity,requestId:string,kind:string,payload:any,authorize?:(gate:any)=>void,apply:(gate:any)=>any}} input */
  execute({ actorIdentity, requestId, kind, payload, authorize, apply }) {
    if (
      !/^[A-Za-z0-9_-]{8,80}$/.test(requestId) ||
      !/^[a-z][a-z0-9_-]{0,79}$/.test(kind)
    )
      throw Error("SOCIAL_OPERATION_INVALID");
    const hash = createHash("sha256")
      .update(JSON.stringify(canonical({ kind, payload })))
      .digest("hex");
    return this.transaction((now) => {
      this.assertIdentity(actorIdentity);
      const gate = { db: this.db, now, actorIdentity };
      const prior = this.db
        .prepare(
          "SELECT * FROM home_social_operations WHERE actor_generation=? AND request_id=?",
        )
        .get(actorIdentity.generation, requestId);
      if (prior && prior.payload_hash !== hash)
        throw Error("IDEMPOTENCY_MISMATCH");
      authorize?.({ ...gate, replay: !!prior });
      if (prior) return this.receipt(prior, true);
      const operationId = this.uuid();
      const result = safeResult(
        apply({
          ...gate,
          operationId,
          nextSequence: (/** @type {string} */ visitId) =>
            this.nextSequence(visitId),
        }),
      );
      const record = {
        actor_generation: actorIdentity.generation,
        actor_agent_id: actorIdentity.agentId,
        request_id: requestId,
        kind,
        payload_hash: hash,
        operation_id: operationId,
        status: "committed",
        result: JSON.stringify(result),
        created_at: now,
      };
      this.db
        .prepare("INSERT INTO home_social_operations VALUES(?,?,?,?,?,?,?,?,?)")
        .run(
          record.actor_generation,
          record.actor_agent_id,
          requestId,
          kind,
          hash,
          operationId,
          record.status,
          record.result,
          now,
        );
      return this.receipt(record, false);
    });
  }
  /** @param {any} row @param {boolean} historicalReplay */
  receipt(row, historicalReplay) {
    return {
      operationId: row.operation_id,
      requestId: row.request_id,
      kind: row.kind,
      status: row.status,
      committedAt: new Date(row.created_at).toISOString(),
      historicalReplay,
      result: JSON.parse(row.result),
    };
  }
  /** @param {SocialIdentity} identity @param {string} requestId */
  operationRead(identity, requestId) {
    this.assertIdentity(identity);
    const row = this.db
      .prepare(
        "SELECT * FROM home_social_operations WHERE actor_generation=? AND request_id=?",
      )
      .get(identity.generation, requestId);
    return row
      ? this.receipt(row, true)
      : { requestId, status: "unknown", historicalReplay: true };
  }
  /** Must be called within execute's transaction after the service's visit gates.
   * @param {string} visitId */
  nextSequence(visitId) {
    if (!this.db.isTransaction) throw Error("SOCIAL_TRANSACTION_REQUIRED");
    const row = this.db
      .prepare(
        "UPDATE home_social_visits SET next_sequence=next_sequence+1 WHERE id=? RETURNING next_sequence-1 AS sequence",
      )
      .get(visitId);
    if (!row) throw Error("VISIT_CLOSED");
    return row.sequence;
  }
  /** @param {SocialIdentity} identity @param {string} [reasonCode] */
  invalidateIdentity(identity, reasonCode = "identity_invalidated") {
    return this.transaction((now) => {
      const generation = identity.generation;
      this.db
        .prepare(
          "UPDATE home_social_invitations SET status='invalidated',revision=revision+1,decided_at=?,closed_reason=? WHERE status='pending' AND (host_generation=? OR guest_generation=?)",
        )
        .run(now, reasonCode, generation, generation);
      this.db
        .prepare(
          "UPDATE home_social_visits SET status='invalidated',revision=revision+1,fence=fence+1,ended_at=?,closed_reason=? WHERE status='active' AND (host_generation=? OR guest_generation=?)",
        )
        .run(now, reasonCode, generation, generation);
      this.db
        .prepare(
          "UPDATE home_social_grants SET revoked_at=?,revision=revision+1,fence=fence+1 WHERE revoked_at IS NULL AND (host_generation=? OR guest_generation=?)",
        )
        .run(now, generation, generation);
      const visits =
        "SELECT id FROM home_social_visits WHERE host_generation=? OR guest_generation=?";
      this.db
        .prepare(
          `UPDATE home_social_windows SET status='invalidated',revision=revision+1,fence=fence+1,closed_at=?,closed_reason=? WHERE status IN ('proposed','active') AND visit_id IN (${visits})`,
        )
        .run(now, reasonCode, generation, generation);
      this.db
        .prepare(
          `UPDATE home_social_turns SET status='cancelled',fence=fence+1,finished_at=? WHERE status IN ('queued','running','reserved') AND (target_host_generation=? OR target_guest_generation=?)`,
        )
        .run(now, generation, generation);
      this.db
        .prepare(
          `UPDATE home_social_dispatches SET status='cancelled',fence=fence+1,finished_at=? WHERE status IN ('queued','claimed') AND (target_host_generation=? OR target_guest_generation=?)`,
        )
        .run(now, generation, generation);
      this.db
        .prepare(
          `UPDATE home_social_contexts SET status='invalidated',epoch=epoch+1,fence=fence+1,updated_at=? WHERE status<>'invalidated' AND (target_host_generation=? OR target_guest_generation=?)`,
        )
        .run(now, generation, generation);
      this.db
        .prepare(
          `UPDATE home_social_outbox SET status='cancelled',fence=fence+1,finished_at=? WHERE status IN ('pending','claimed') AND (entity_id IN (${visits}) OR entity_id IN (SELECT id FROM home_social_invitations WHERE host_generation=? OR guest_generation=?) OR entity_id IN (SELECT id FROM home_social_contexts WHERE target_host_generation=? OR target_guest_generation=?))`,
        )
        .run(
          now,
          generation,
          generation,
          generation,
          generation,
          generation,
          generation,
        );
      return { invalidated: true };
    });
  }
  /** Ordinary restarts preserve logical visits and conservative resource reservations.
   * @param {string} runtimeEpoch */
  interruptRuntime(runtimeEpoch) {
    return this.transaction((now) => {
      this.interrupt(now, "interrupted");
      this.db
        .prepare(
          "UPDATE home_social_recovery_state SET runtime_epoch=? WHERE singleton=1",
        )
        .run(runtimeEpoch);
      return { interrupted: true };
    });
  }
  /** @param {number} now @param {string} reason */
  interrupt(now, reason) {
    this.db
      .prepare(
        "UPDATE home_social_windows SET status='interrupted',revision=revision+1,fence=fence+1,closed_at=?,closed_reason=? WHERE status='active'",
      )
      .run(now, reason);
    this.db
      .prepare(
        "UPDATE home_social_turns SET status='interrupted',fence=fence+1,finished_at=? WHERE status IN ('queued','running','reserved')",
      )
      .run(now);
    this.db
      .prepare(
        "UPDATE home_social_dispatches SET status='interrupted',fence=fence+1,finished_at=? WHERE status IN ('queued','claimed')",
      )
      .run(now);
    this.db
      .prepare(
        "UPDATE home_social_outbox SET status='cancelled',fence=fence+1,finished_at=? WHERE status IN ('pending','claimed')",
      )
      .run(now);
    this.db
      .prepare(
        "UPDATE home_social_contexts SET status='invalidated',epoch=epoch+1,fence=fence+1,updated_at=? WHERE status<>'invalidated'",
      )
      .run(now);
  }
  /** Explicit offline recovery barrier; never inferred from an ordinary restart.
   * @param {{recoveryEpoch:string}} options */
  invalidateRestoredAuthority({ recoveryEpoch }) {
    if (!recoveryEpoch) throw Error("SOCIAL_RECOVERY_EPOCH_REQUIRED");
    return this.transaction((now) => {
      const prior = this.db
        .prepare(
          "SELECT recovery_epoch FROM home_social_recovery_state WHERE singleton=1",
        )
        .get();
      if (prior?.recovery_epoch === recoveryEpoch)
        return {
          invalidated: true,
          socialEnabled: false,
          historicalReplay: true,
        };
      this.interrupt(now, "recovery_invalidated");
      this.db
        .prepare(
          "UPDATE home_social_policy SET enabled=0,exchange_enabled=0,revision=revision+1,recovery_epoch=? WHERE singleton=1",
        )
        .run(recoveryEpoch);
      this.db
        .prepare(
          "UPDATE home_social_invitations SET status='invalidated',revision=revision+1,decided_at=?,closed_reason='recovery_invalidated' WHERE status='pending'",
        )
        .run(now);
      this.db
        .prepare(
          "UPDATE home_social_visits SET status='invalidated',revision=revision+1,fence=fence+1,ended_at=?,closed_reason='recovery_invalidated' WHERE status='active'",
        )
        .run(now);
      this.db
        .prepare(
          "UPDATE home_social_grants SET revoked_at=?,revision=revision+1,fence=fence+1 WHERE revoked_at IS NULL",
        )
        .run(now);
      this.db
        .prepare(
          "UPDATE home_social_windows SET status='invalidated',revision=revision+1,fence=fence+1,closed_at=?,closed_reason='recovery_invalidated' WHERE status='proposed'",
        )
        .run(now);
      this.db
        .prepare(
          "UPDATE home_social_recovery_state SET recovery_epoch=?,runtime_epoch=?,restored_at=? WHERE singleton=1",
        )
        .run(recoveryEpoch, recoveryEpoch, now);
      return { invalidated: true, socialEnabled: false };
    });
  }
  /** Clears terminal bodies only, preserving identifiers, revisions, sources and receipts.
   * @param {{before:number}} options */
  pruneBodies({ before }) {
    if (!Number.isSafeInteger(before) || before < 0)
      throw Error("SOCIAL_RETENTION_INVALID");
    return this.transaction((now) => {
      const messages = this.db
        .prepare(
          "UPDATE home_social_messages SET body='',body_cleared_at=? WHERE body_cleared_at IS NULL AND visit_id IN (SELECT id FROM home_social_visits WHERE status<>'active' AND ended_at<=?)",
        )
        .run(now, before).changes;
      const invitations = this.db
        .prepare(
          "UPDATE home_social_invitations SET purpose='',reason='',body_cleared_at=? WHERE body_cleared_at IS NULL AND ((status IN ('declined','cancelled','expired','invalidated') AND decided_at<=?) OR (status='accepted' AND id IN (SELECT invitation_id FROM home_social_visits WHERE status<>'active' AND ended_at<=?)))",
        )
        .run(now, before, before).changes;
      return { messages, invitations };
    });
  }
}
