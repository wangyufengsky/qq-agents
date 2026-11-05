// @ts-check
import { createHash } from "node:crypto";
import { resolveProjectSnapshot } from "../home/project-snapshots.mjs";
import { sourceClass } from "./outbound-policy.mjs";
// Markers name server-owned records; no caller-supplied audience grants authority.
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const messagePattern = new RegExp(`^social:(${uuid}):(${uuid})$`, "i");
const versionPattern = new RegExp(
  `^social-(grant|invitation):(${uuid}):([1-9]\\d*)$`,
  "i",
);
/** @param {any} value @returns {{kind:string,id:string,messageId?:string,revision?:number}|null} */
export function parseSocialMarker(value) {
  if (typeof value !== "string") return null;
  const message = value.match(messagePattern);
  if (message)
    return {
      kind: "message",
      id: message[1].toLowerCase(),
      messageId: message[2].toLowerCase(),
    };
  const version = value.match(versionPattern);
  if (!version || !Number.isSafeInteger(Number(version[3]))) return null;
  return {
    kind: version[1].toLowerCase(),
    id: version[2].toLowerCase(),
    revision: Number(version[3]),
  };
}
/** @param {string} value */
function checkedMarker(value) {
  if (!parseSocialMarker(value)) throw Error("INVALID_PROTECTION_METADATA");
  return value;
}
/** @param {string} visitId @param {string} messageId */
export const socialMarker = (visitId, messageId) =>
  checkedMarker(`social:${visitId}:${messageId}`);
/** @param {string} visitId @param {number} revision */
export const socialGrantMarker = (visitId, revision) =>
  checkedMarker(`social-grant:${visitId}:${revision}`);
/** @param {string} invitationId @param {number} revision */
export const socialInvitationMarker = (invitationId, revision) =>
  checkedMarker(`social-invitation:${invitationId}:${revision}`);
/** @param {any} record @returns {string[]} */
export function socialRecordSources(record) {
  const values = record?.protectedSocialSources;
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.some((v) => !parseSocialMarker(v)))
    throw Error("INVALID_PROTECTION_METADATA");
  return [...new Set(values)].sort();
}
// Cache statements, never resolved metadata: revocation and source changes stay live.
/** @type {WeakMap<object, any>} */
const sourceLookups = new WeakMap();
/** @param {any} runtime @param {any} ctx @param {Iterable<string>} [ids] @returns {string[]} */
export function socialSources(runtime, ctx, ids = ctx.privateRead || []) {
  const sources = new Set();
  const pending = [...ids],
    seen = new Set();
  const db = runtime.memory.db;
  let lookup = sourceLookups.get(db);
  if (!lookup) {
    lookup = db.prepare(
      "SELECT payload AS metadata FROM events WHERE agent_id=?1 AND id=?2 UNION ALL SELECT metadata FROM diaries WHERE agent_id=?1 AND id=?2 UNION ALL SELECT value FROM work_notes WHERE agent_id=?1 AND id=?2 UNION ALL SELECT value FROM intentions WHERE agent_id=?1 AND id=?2 UNION ALL SELECT value FROM self_candidates WHERE agent_id=?1 AND id=?2",
    );
    sourceLookups.set(db, lookup);
  }
  // Ordinary conversations accumulate durable taint across turns. Traverse the
  // complete finite graph; visited IDs bound cycles without discarding sources.
  while (pending.length) {
    const id = pending.pop();
    if (typeof id !== "string" || seen.has(id)) continue;
    seen.add(id);
    if (/^social(?::|-grant:|-invitation:)/.test(id)) {
      if (!parseSocialMarker(id)) throw Error("INVALID_PROTECTION_METADATA");
      sources.add(id);
    }
    for (const row of lookup.all(ctx.agentId, id)) {
      const value = JSON.parse(row.metadata);
      for (const source of socialRecordSources(value)) sources.add(source);
      for (const ref of [
        ...(value.evidence || []),
        ...(value.counterEvidence || []),
      ])
        pending.push(ref);
    }
  }
  return [...sources].sort();
}
/** @param {any} ctx @param {any} record */
export function trackSocial(ctx, record) {
  for (const marker of socialRecordSources(record)) ctx.privateRead.add(marker);
}
/** Validate current authority even for durable history, never a stored audience claim.
 * @param {any} runtime @param {any} ctx @param {string[]} sources */
export function socialContextAllowed(runtime, ctx, sources) {
  if (!sources.length) return true;
  const binding = ctx.socialBinding;
  if (
    ctx.runtimeKind !== "subject-social" ||
    !["visit", "invitation"].includes(binding?.target?.kind) ||
    binding.actorIdentity?.agentId !== ctx.agentId ||
    !binding.actorIdentity?.generation ||
    runtime.config.homeSocial?.enabled !== true
  )
    return false;
  try {
    const db = runtime.memory.db;
    const now = runtime.now();
    const retention = runtime.config.homeSocial.retentionDays;
    if (!Number.isInteger(retention) || retention < 1 || retention > 365)
      return false;
    const retained = (/** @type {any} */ row, invitation = false) => {
      const terminalAt = invitation
        ? ["pending", "accepted"].includes(row.status)
          ? null
          : (row.decided_at ?? row.expires_at)
        : row.status === "active" && row.expires_at > now
          ? null
          : Math.min(row.ended_at ?? row.expires_at, row.expires_at);
      return (
        terminalAt === null ||
        (Number.isSafeInteger(terminalAt) &&
          now < terminalAt + retention * 86400000)
      );
    };
    if (
      !db
        .prepare("SELECT enabled FROM home_social_policy WHERE singleton=1")
        .get()?.enabled
    )
      return false;
    const target = db
      .prepare(
        `SELECT * FROM home_social_${binding.target.kind === "visit" ? "visits" : "invitations"} WHERE id=?`,
      )
      .get(binding.target.id);
    if (!target) return false;
    const participants = [
      [target.host_agent_id, target.host_generation],
      [target.guest_agent_id, target.guest_generation],
    ];
    if (
      !participants.some(
        ([id, gen]) =>
          id === ctx.agentId && gen === binding.actorIdentity.generation,
      )
    )
      return false;
    for (const [id, gen] of participants) {
      if (
        !runtime.config.agents.some(
          (/** @type {any} */ a) =>
            a.id === id && a.home?.social?.enabled === true,
        )
      )
        return false;
      const current = db
        .prepare(
          "SELECT generation,active FROM home_identities WHERE agent_id=?",
        )
        .get(id);
      if (!current?.active || current.generation !== gen) return false;
    }
    if (
      db
        .prepare(
          "SELECT 1 FROM home_social_blocks WHERE active=1 AND ((actor_generation=? AND target_generation=?) OR (actor_generation=? AND target_generation=?))",
        )
        .get(
          target.host_generation,
          target.guest_generation,
          target.guest_generation,
          target.host_generation,
        )
    )
      return false;
    const visit = binding.target.kind === "visit" ? target : null;
    if (
      visit &&
      (!["active", "ended", "expired"].includes(visit.status) ||
        !retained(visit))
    )
      return false;
    return sources.every((marker) => {
      const source = parseSocialMarker(marker);
      if (!source) return false;
      if (source.kind === "invitation") {
        const invitation = db
          .prepare("SELECT * FROM home_social_invitations WHERE id=?")
          .get(source.id);
        if (
          !invitation ||
          invitation.revision !== source.revision ||
          !retained(invitation, true) ||
          invitation.body_cleared_at ||
          invitation.hidden_at ||
          invitation.retracted_at ||
          !["pending", "accepted", "declined"].includes(invitation.status) ||
          (invitation.status === "pending" && invitation.expires_at <= now) ||
          invitation.host_generation !== target.host_generation ||
          invitation.guest_generation !== target.guest_generation
        )
          return false;
        if (visit)
          return (
            invitation.status === "accepted" &&
            visit.invitation_id === invitation.id
          );
        if (invitation.status === "accepted") {
          const acceptedVisit = db
            .prepare("SELECT * FROM home_social_visits WHERE invitation_id=?")
            .get(invitation.id);
          if (
            !acceptedVisit ||
            !["active", "ended", "expired"].includes(acceptedVisit.status) ||
            !retained(acceptedVisit)
          )
            return false;
        }
        return invitation.id === binding.target.id;
      }
      if (!visit || source.id !== visit.id) return false;
      if (source.kind === "message") {
        const message = db
          .prepare(
            "SELECT * FROM home_social_messages WHERE id=? AND visit_id=?",
          )
          .get(source.messageId, visit.id);
        return (
          !!message &&
          !message.retracted_at &&
          !message.hidden_at &&
          !message.body_cleared_at
        );
      }
      if (visit.status !== "active" || visit.expires_at <= now) return false;
      const grant = db
        .prepare("SELECT * FROM home_social_grants WHERE visit_id=?")
        .get(visit.id);
      if (
        !grant ||
        grant.revision !== source.revision ||
        grant.revoked_at ||
        grant.expires_at <= now ||
        grant.host_generation !== visit.host_generation ||
        grant.guest_generation !== visit.guest_generation ||
        grant.room_id !== visit.room_id ||
        grant.room_id !== "room:" + visit.host_generation ||
        grant.invitation_id !== visit.invitation_id
      )
        return false;
      const host = runtime.config.agents.find(
        (/** @type {any} */ a) => a.id === visit.host_agent_id,
      );
      if (!host?.home?.enabled) return false;
      const selected = JSON.parse(grant.selected_item_revisions);
      const scope = JSON.parse(grant.scope);
      const slots = ["intro", "tagline", "work-1", "work-2", "work-3"];
      if (
        !Array.isArray(selected) ||
        !Array.isArray(scope) ||
        !scope.length ||
        new Set(scope).size !== scope.length ||
        scope.some((slot) => slot !== "layout" && !slots.includes(slot)) ||
        selected.length !== scope.filter((slot) => slot !== "layout").length ||
        new Set(selected.map((item) => item?.slot)).size !== selected.length ||
        scope.some(
          (slot) =>
            slot !== "layout" && !selected.some((item) => item?.slot === slot),
        )
      )
        return false;
      return selected.every((item) => {
        if (
          !item ||
          !slots.includes(item.slot) ||
          !scope.includes(item.slot) ||
          typeof item.itemId !== "string" ||
          !Number.isSafeInteger(item.itemRevision) ||
          item.itemRevision < 1 ||
          !host.home.publishing
        )
          return false;
        assertRoomItemShareable(runtime, ctx, {
          hostGeneration: visit.host_generation,
          slot: item.slot,
          itemId: item.itemId,
          itemRevision: item.itemRevision,
        });
        return true;
      });
    });
  } catch {
    return false;
  }
}
/** No general disclosure grant can widen the audience of social private material.
 * @param {any} runtime @param {any} ctx */
export function assertNoSocialDisclosure(runtime, ctx) {
  if (socialSources(runtime, ctx).length) throw Error("SOCIAL_SOURCE_DENIED");
}

/** Cross-role sending keeps all source protections, including nested evidence.
 * The target is supplied by the service after its own operation authorization.
 * @param {any} runtime @param {any} ctx @param {{kind:string,id?:string}} target */
export function assertSocialSend(runtime, ctx, target) {
  try {
    if (
      ctx.socialSendingClosed ||
      ctx.runtimeKind !== "subject-social" ||
      ctx.socialBinding?.actorIdentity?.agentId !== ctx.agentId ||
      ctx.socialBinding?.target?.kind !== target.kind ||
      ctx.socialBinding?.target?.id !== target.id
    )
      throw Error("SOCIAL_SOURCE_DENIED");
    const sources = socialSources(runtime, ctx);
    if (!socialContextAllowed(runtime, ctx, sources))
      throw Error("SOCIAL_SOURCE_DENIED");
    const pending = [...(ctx.privateRead || [])],
      seen = new Set();
    const lookup = runtime.memory.db.prepare(
      "SELECT conversation AS origin_conversation,payload AS value FROM events WHERE agent_id=?1 AND id=?2 UNION ALL SELECT NULL,metadata AS value FROM diaries WHERE agent_id=?1 AND id=?2 UNION ALL SELECT conversation,value FROM work_notes WHERE agent_id=?1 AND id=?2 UNION ALL SELECT NULL,value FROM intentions WHERE agent_id=?1 AND id=?2 UNION ALL SELECT NULL,value FROM self_candidates WHERE agent_id=?1 AND id=?2",
    );
    while (pending.length) {
      const id = pending.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      if (
        seen.size > 1000 ||
        [
          "operations",
          "private-repository",
          "peer-qzone",
          "private-conversation",
          "group-conversation",
          "unknown-legacy",
        ].includes(sourceClass(runtime, ctx, id))
      )
        throw Error("SOCIAL_SOURCE_DENIED");
      for (const row of lookup.all(ctx.agentId, id)) {
        const value = JSON.parse(row.value);
        // Social provenance supplements existing source audiences. It never
        // replaces the original QQ scope or a frozen derivative's lineage.
        const scopes = [
          row.origin_conversation,
          value.conversation,
          value.writtenIn?.conversation,
          value.createdIn?.conversation,
          value.app?.source?.conversation,
          value.source?.conversation,
          ...(value.sources || []).map(
            (/** @type {any} */ source) => source.conversation,
          ),
        ];
        if (
          scopes.some(
            (scope) =>
              typeof scope === "string" && /^(private|group):/.test(scope),
          )
        )
          throw Error("SOCIAL_SOURCE_DENIED");
        if (
          value.protectedOperations ||
          value.protectedRepositories?.length ||
          value.protectedPeerQzoneTargets?.length
        )
          throw Error("SOCIAL_SOURCE_DENIED");
        pending.push(
          ...(value.evidence || []),
          ...(value.counterEvidence || []),
          ...[
            value.rootEventId,
            value.sourceEventId,
            value.source?.eventId,
          ].filter((/** @type {any} */ id) => typeof id === "string"),
          ...(value.sources || [])
            .flatMap((/** @type {any} */ source) => [
              source.eventId,
              source.sourceEventId,
              source.recordId,
            ])
            .filter((/** @type {any} */ id) => typeof id === "string"),
          ...(value.evidenceSnapshot?.references || [])
            .map((/** @type {any} */ reference) => reference.id)
            .filter((/** @type {any} */ id) => typeof id === "string"),
        );
      }
    }
  } catch {
    ctx.socialSendingClosed = true;
    throw Error("SOCIAL_SOURCE_DENIED");
  }
}

/** Read-only verification of server-owned fixed drafts; legacy absence is not provenance.
 * @param {any} runtime @param {any} ctx
 * @param {{hostGeneration:string,slot:string,itemId:string,itemRevision:number}} selected */
export function assertRoomItemShareable(runtime, ctx, selected) {
  try {
    const db = runtime.memory.db;
    const identity = db
      .prepare(
        "SELECT agent_id FROM home_identities WHERE generation=? AND active=1",
      )
      .get(selected.hostGeneration);
    const host = runtime.config.agents.find(
      (/** @type {any} */ a) => a.id === identity?.agent_id,
    );
    if (!host?.home?.enabled || !host.home.publishing)
      throw Error("SOCIAL_SOURCE_DENIED");
    const item = db
      .prepare("SELECT * FROM home_items WHERE generation=? AND slot=?")
      .get(selected.hostGeneration, selected.slot);
    if (
      !item ||
      item.item_id !== selected.itemId ||
      item.revision !== selected.itemRevision ||
      item.state !== "published"
    )
      throw Error("SOCIAL_SOURCE_DENIED");
    const record = db
      .prepare(
        "SELECT value FROM home_item_sources WHERE generation=? AND slot=?",
      )
      .get(selected.hostGeneration, selected.slot);
    const source = record && JSON.parse(record.value);
    // This context only rechecks host-owned stored proof. It never creates a turn.
    const proofContext = {
      ...ctx,
      agentId: host.id,
      conversation: "@subject",
      privateRead: new Set(),
    };
    if (source) {
      if (
        !host.home.projectSnapshots?.enabled ||
        source.type !== "project-draft" ||
        typeof source.id !== "string" ||
        !Number.isSafeInteger(source.revision) ||
        source.revision < 1
      )
        throw Error("SOCIAL_SOURCE_DENIED");
      const proof = resolveProjectSnapshot(
        runtime.home.rooms,
        proofContext,
        source,
      );
      if (proof.title !== item.title || proof.body !== item.body)
        throw Error("SOCIAL_SOURCE_DENIED");
      return;
    }
    const original = db
      .prepare(
        "SELECT * FROM home_social_item_proofs WHERE generation=? AND slot=? AND item_id=? AND item_revision=?",
      )
      .get(
        selected.hostGeneration,
        selected.slot,
        selected.itemId,
        selected.itemRevision,
      );
    if (
      !original ||
      original.proof_version !== 1 ||
      original.content_hash !== itemHash(item.title, item.body)
    )
      throw Error("SOCIAL_SOURCE_DENIED");
    const evidence = JSON.parse(original.source_ids);
    if (
      !Array.isArray(evidence) ||
      evidence.some((id) => typeof id !== "string")
    )
      throw Error("SOCIAL_SOURCE_DENIED");
    proofContext.privateRead = new Set(evidence);
    runtime.home.rooms.shareable(proofContext);
    runtime.assertSafeOutput(
      proofContext,
      JSON.stringify({ title: item.title, body: item.body }),
    );
  } catch {
    throw Error("SOCIAL_SOURCE_DENIED");
  }
}

/** Additive private proof storage is separate from project-snapshot attribution.
 * @param {any} db */
export function migrateSocialItemProofs(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS home_social_item_proofs(
    generation TEXT NOT NULL, slot TEXT NOT NULL, item_id TEXT NOT NULL,
    item_revision INTEGER NOT NULL, proof_version INTEGER NOT NULL,
    content_hash TEXT NOT NULL, source_ids TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY(generation,item_id,item_revision), UNIQUE(generation,slot))`);
}
/** @param {string} title @param {string} body */
function itemHash(title, body) {
  return createHash("sha256")
    .update(JSON.stringify([title, body]))
    .digest("hex");
}
/** Called only after shareable succeeds, inside the actual item write transaction.
 * @param {any} db @param {any} value */
export function recordSocialItemProof(db, value) {
  db.prepare(
    "INSERT INTO home_social_item_proofs(generation,slot,item_id,item_revision,proof_version,content_hash,source_ids,created_at) VALUES(?,?,?,?,1,?,?,?)",
  ).run(
    value.generation,
    value.slot,
    value.itemId,
    value.itemRevision,
    itemHash(value.title, value.body),
    JSON.stringify([...value.sourceIds].sort()),
    value.now,
  );
}
