// @ts-check
import { socialSafeExportRow } from "./protection.mjs";
import { QQDraftStore } from "./qq-drafts.mjs";
import { withoutClosenessCache } from "../core/closeness.mjs";
export { inspectLegacy, importLegacy } from "./legacy-import.mjs";
import { INPUT_EXPORT_TABLES, validateExport } from "./export-format.mjs";
import {
  inputBelongsToScope,
  migrateInputBaselines,
  semanticInputVersion,
} from "./input-state.mjs";
import {
  validateRestoredAliases,
  validateRestoredObservations,
} from "./message-ids.mjs";
/** @param {any} memory Bound AgentMemory. @param {any} data Parsed export file. */
export function restoreExport(memory, data) {
  if (![1, 2, 3].includes(data.version) || data.agentId !== memory.agentId)
    throw Error("EXPORT_IDENTITY_MISMATCH");
  validateExport(data);
  const archivedScopes = validateArchivedInputScopes(data);
  if (
    Object.hasOwn(data.tables, "qq_drafts") !==
    Object.hasOwn(data.tables, "qq_draft_items")
  )
    throw Error("EXPORT_INTEGRITY_FAILED");
  const columns = {
    events: [
      "seq",
      "id",
      "agent_id",
      "dedupe",
      "connection_id",
      "conversation",
      "kind",
      "direction",
      "status",
      "message_id",
      "sender_id",
      "occurred_at",
      "observed_at",
      "body",
      "payload",
      "origin",
    ],
    diaries: [
      "id",
      "agent_id",
      "title",
      "body",
      "revision",
      "created_at",
      "updated_at",
      "metadata",
      "origin",
    ],
    diary_revisions: [
      "id",
      "revision",
      "title",
      "body",
      "metadata",
      "written_at",
    ],
    people: ["agent_id", "qq", "names"],
    deliveries: [
      "agent_id",
      "request_id",
      "conversation",
      "payload_hash",
      "status",
      "message_id",
      "created_at",
      "updated_at",
    ],
    runtime: ["agent_id", "conversation", "value"],
    migrations: ["agent_id", "source", "digest", "imported_at"],
    self_versions: ["agent_id", "version", "value"],
    self_candidates: ["agent_id", "id", "value"],
    intentions: ["agent_id", "id", "value"],
    work_notes: ["agent_id", "conversation", "id", "value"],
    model_turns: ["agent_id", "id", "value"],
    session_history: ["agent_id", "id", "value"],
    message_progress: ["agent_id", "conversation", "seq", "summary_only"],
    message_aliases: [
      "agent_id",
      "connection_id",
      "conversation",
      "namespace",
      "message_id",
      "event_id",
      "account_id",
      "evidence",
    ],
    message_observations: ["agent_id", "event_id", "digest", "observation"],
    person_notes: ["agent_id", "person_id", "value"],
    moods: ["agent_id", "id", "value"],
    person_items: ["agent_id", "id", "value"],
    projects: ["agent_id", "id", "value"],
    memory_corrections: ["agent_id", "id", "value"],
    activity_history: ["agent_id", "project_id", "revision", "value"],
    qq_drafts: [
      "id",
      "agent_id",
      "connection_id",
      "account_id",
      "conversation",
      "tool_name",
      "request_id",
      "request_hash",
      "revision",
      "created_at",
      "expires_at",
      "imported",
      "value",
    ],
    qq_draft_items: [
      "agent_id",
      "draft_id",
      "position",
      "revision",
      "request_id",
      "value",
      "abandoned",
      "delivery_request_id",
      "confirmation",
      "archive_record_id",
    ],
    qzone_approvals: [
      "id",
      "agent_id",
      "request_id",
      "state",
      "created_at",
      "expires_at",
      "value",
    ],
  };
  // An empty target identity can be restored beside other identities. Remap only local seq watermarks.
  if (
    [
      ...INPUT_EXPORT_TABLES,
      ...Object.entries(columns)
        .filter(([, cols]) => cols.includes("agent_id"))
        .map(([table]) => table),
    ].some(
      (table) =>
        memory.db
          .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE agent_id=?`)
          .get(memory.agentId).n,
    )
  )
    throw Error("RESTORE_REQUIRES_EMPTY_DATABASE_FOR_AGENT");
  const empty =
      memory.db.prepare("SELECT COUNT(*) AS n FROM events").get().n === 0,
    seqs = new Map([[0, 0]]);
  const remapBoundary = (/** @type {number} */ boundary) => {
    let mapped = 0;
    for (const [oldSeq, newSeq] of seqs)
      if (oldSeq <= boundary && newSeq > mapped) mapped = newSeq;
    return mapped;
  };
  memory.store.transaction(() => {
    for (const [table, cols] of Object.entries(columns)) {
      for (const original of data.tables[table] || []) {
        const row = socialSafeExportRow(table, original);
        // Portable role data preserves evidence and unresolved locks, but does
        // not authorize running an old draft on this instance.
        if (table === "qq_drafts") {
          row.imported = 1;
          const {
            basis,
            baseline: _baseline,
            origin: _origin,
            checkpointIntent: _checkpointIntent,
            observation: _observation,
            ...metadata
          } = JSON.parse(row.value);
          row.value = JSON.stringify({
            ...metadata,
            ...(basis
              ? {
                  historicalBasis: (basis.items || []).map(
                    (/** @type {{id:string,kind:string}} */ { id, kind }) => ({
                      id,
                      kind,
                    }),
                  ),
                }
              : {}),
          });
        }
        if (table === "deliveries" && row.status === "pending")
          row.status = "unknown";
        // An agent export transports history, not authority to publish from this instance.
        if (
          table === "qzone_approvals" &&
          ["awaiting_approval", "submitting"].includes(row.state)
        )
          row.state = "cancelled";
        // Imported role data is not an attestation by this instance. Keep drafts, discard display authority.
        if (table === "projects" || table === "activity_history")
          row.value = JSON.stringify(
            JSON.parse(row.value, (key, value) =>
              key === "homeSnapshotProvenance" ? null : value,
            ),
          );
        if (table === "person_notes")
          row.value = JSON.stringify(
            withoutClosenessCache(JSON.parse(row.value)),
          );
        if (cols.includes("agent_id") && row.agent_id !== memory.agentId)
          throw Error("EXPORT_FOREIGN_AGENT");
        if (
          table === "diary_revisions" &&
          !memory.db
            .prepare("SELECT id FROM diaries WHERE id=? AND agent_id=?")
            .get(row.id, memory.agentId)
        )
          throw Error("EXPORT_FOREIGN_DIARY");
        if (table === "runtime") {
          const state = JSON.parse(row.value);
          // Local acknowledgement/repair credentials belong to the original installation.
          delete state.readCheckpointReceipts;
          if (
            /^(group|private):/.test(row.conversation) &&
            (state.inputReviewFromSeq !== undefined ||
              state.inputReviewThroughSeq !== undefined)
          ) {
            // Restored content is not proof that this runtime presented it or
            // approved it for delivery. A local backup still preserves events.
            state.inputReviewFromSeq = 0;
            delete state.inputReviewThroughSeq;
          }
          if (!empty)
            for (const key of [
              "readThroughSeq",
              "lastReceivedSeq",
              "seenThroughSeq",
              "activityCursor",
              "lastActivitySeq",
              "feedThroughSeq",
              "imageInputThroughSeq",
            ])
              if (state[key] !== undefined)
                state[key] = seqs.get(state[key]) ?? 0;
          row.value = JSON.stringify(state);
        }
        if (table === "message_progress" && !empty) row.seq = seqs.get(row.seq);
        // The strong-mood and closing guards compare evidence seqs against
        // this boundary.
        if ((table === "moods" || table === "person_items") && !empty) {
          const value = JSON.parse(row.value);
          if (value.sinceSeq !== undefined)
            value.sinceSeq = remapBoundary(value.sinceSeq);
          row.value = JSON.stringify(value);
        }
        if (table === "intentions" && !empty) {
          const value = JSON.parse(row.value);
          for (const key of ["handoffSeq", "createdAfterSeq"])
            if (value[key] !== undefined)
              value[key] = remapBoundary(value[key]);
          row.value = JSON.stringify(value);
        }
        const fields =
          table === "events" && !empty ? cols.filter((c) => c !== "seq") : cols;
        const result = memory.db
          .prepare(
            `INSERT INTO ${table}(${fields.join(",")}) VALUES(${fields.map(() => "?").join(",")})`,
          )
          .run(...fields.map((c) => row[c] ?? null));
        if (table === "events")
          seqs.set(row.seq, Number(result.lastInsertRowid));
      }
    }
    if (
      memory.db
        .prepare(
          `SELECT 1 FROM qq_draft_items i
      JOIN qq_drafts g ON g.id=i.draft_id
      JOIN deliveries d ON d.agent_id=i.agent_id AND d.request_id=i.delivery_request_id
      LEFT JOIN events a ON a.agent_id=i.agent_id AND a.dedupe='send:'||i.delivery_request_id||':pending'
      WHERE i.agent_id=? AND (d.conversation<>g.conversation OR a.id IS NULL
        OR a.connection_id<>g.connection_id OR a.conversation<>g.conversation OR a.sender_id IS NOT g.account_id
        OR a.kind<>'message.send-attempt' OR a.direction<>'out'
        OR json_extract(a.payload,'$.requestId') IS NOT i.delivery_request_id
        OR (i.confirmation IS NOT NULL AND (d.status<>'sent' OR NOT json_valid(i.confirmation)
          OR coalesce(json_type(i.confirmation,'$.action'),'') NOT IN ('true','false')
          OR json_type(i.confirmation,'$.messageNamespace') IS NOT 'text')))
      LIMIT 1`,
        )
        .get(memory.agentId)
    )
      throw Error("QQ_DRAFT_DELIVERY_MISMATCH");
    if (
      memory.db
        .prepare(
          `SELECT g.id FROM qq_drafts g LEFT JOIN qq_draft_items i ON i.draft_id=g.id
      WHERE g.agent_id=? GROUP BY g.id
      HAVING count(i.position)<1 OR count(i.position)>10
        OR min(i.position)<>0 OR max(i.position)<>count(i.position)-1 LIMIT 1`,
        )
        .get(memory.agentId)
    )
      throw Error("QQ_DRAFT_INVALID");
    const drafts = new QQDraftStore(memory.store);
    for (const item of memory.db
      .prepare(
        `SELECT delivery_request_id,archive_record_id
      FROM qq_draft_items WHERE agent_id=? AND archive_record_id IS NOT NULL`,
      )
      .all(memory.agentId))
      drafts.verifyArchive(
        memory.agentId,
        item.delivery_request_id,
        item.archive_record_id,
      );
    validateRestoredAliases(memory);
    validateRestoredObservations(memory);
    if (archivedScopes)
      preserveArchivedInputGaps(memory.db, data, archivedScopes);
    // The manifest detects corruption. It does not authenticate input dispositions
    // or a history floor. Rebuild the candidates from the restored events and
    // require an explicit local baseline selection before activating a floor.
    migrateInputBaselines(memory.db, memory.agentId, "import");
  });
}

/** @param {any} data */
function validateArchivedInputScopes(data) {
  if (data.version !== 3) return;
  /** @type {Map<string, [string, string, string, string, string]>} */
  const scopes = new Map();
  for (const row of data.tables.input_scopes) {
    let scope;
    try {
      scope = JSON.parse(row.scope);
    } catch {
      throw Error("EXPORT_INTEGRITY_FAILED");
    }
    if (
      !Array.isArray(scope) ||
      scope.length !== 5 ||
      scope.some((value) => typeof value !== "string" || !value) ||
      scope[0] !== data.agentId ||
      scope[3] !== row.conversation ||
      row.agent_id !== data.agentId ||
      JSON.stringify(scope) !== row.scope ||
      scopes.has(row.scope)
    )
      throw Error("EXPORT_INTEGRITY_FAILED");
    scopes.set(row.scope, [scope[0], scope[1], scope[2], scope[3], scope[4]]);
  }
  for (const row of data.tables.input_versions)
    if (row.agent_id !== data.agentId || !scopes.has(row.scope))
      throw Error("EXPORT_INTEGRITY_FAILED");
  for (const row of data.tables.input_legacy_scopes)
    if (row.agent_id !== data.agentId) throw Error("EXPORT_INTEGRITY_FAILED");
  return scopes;
}

/** @param {import("node:sqlite").DatabaseSync} db @param {any} data @param {Map<string, [string, string, string, string, string]>} scopes */
function preserveArchivedInputGaps(db, data, scopes) {
  const event = db.prepare("SELECT * FROM events WHERE id=? AND agent_id=?");
  const gap = db.prepare(`
    INSERT INTO message_progress VALUES(?,?,?,1)
    ON CONFLICT(agent_id,conversation,seq) DO UPDATE SET summary_only=1
  `);
  for (const version of data.tables.input_versions) {
    if (version.current !== 1) continue;
    const scope = scopes.get(version.scope);
    const row = /** @type {import("./input-state.mjs").EventRow|undefined} */ (
      event.get(version.id, data.agentId)
    );
    if (!row || !scope || !inputBelongsToScope(row, scope, db)) continue;
    // Only conservative holds travel. Account/version mismatches and
    // altered projections never inherit closed or processed dispositions.
    if (
      version.legacy_gap === 1 ||
      version.original === 0 ||
      (!version.processed && !version.legacy_processed) ||
      (!version.legacy_closed && version.reviewed_deliveries === "[]") ||
      semanticInputVersion(row) !== version.version
    )
      gap.run(data.agentId, row.conversation, row.seq);
  }
}
