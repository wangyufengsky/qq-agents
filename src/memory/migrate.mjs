// @ts-check
export { inspectLegacy, importLegacy } from "./legacy-import.mjs";
import { validateExport } from "./export-format.mjs";
import {
  validateRestoredAliases,
  validateRestoredObservations,
} from "./message-ids.mjs";
/** @param {any} memory Bound AgentMemory. @param {any} data Parsed export file. */
export function restoreExport(memory, data) {
  if (![1, 2].includes(data.version) || data.agentId !== memory.agentId)
    throw Error("EXPORT_IDENTITY_MISMATCH");
  validateExport(data);
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
  };
  // An empty target identity can be restored beside other identities. Remap only local seq watermarks.
  if (
    Object.entries(columns).some(
      ([table, cols]) =>
        cols.includes("agent_id") &&
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
        const row = { ...original };
        if (cols.includes("agent_id") && row.agent_id !== memory.agentId)
          throw Error("EXPORT_FOREIGN_AGENT");
        if (
          table === "diary_revisions" &&
          !memory.db
            .prepare("SELECT id FROM diaries WHERE id=? AND agent_id=?")
            .get(row.id, memory.agentId)
        )
          throw Error("EXPORT_FOREIGN_DIARY");
        if (table === "runtime" && !empty) {
          const state = JSON.parse(row.value);
          for (const key of [
            "readThroughSeq",
            "lastReceivedSeq",
            "seenThroughSeq",
            "activityCursor",
            "lastActivitySeq",
            "feedThroughSeq",
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
    validateRestoredAliases(memory);
    validateRestoredObservations(memory);
  });
}
