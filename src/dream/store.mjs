// @ts-check
import { randomUUID } from "node:crypto";
import { prepared } from "../core/recall-boundary.mjs";
import {
  SOURCE_PARTITIONS,
  SOURCES,
  dreamSources,
  sourceRoleColumn,
} from "./source-filter.mjs";
import { parsePatch, validateEvidence } from "./validator.mjs";

/** @typedef {import("./source-filter.mjs").Watermarks} Watermarks */
/** @typedef {import("./source-filter.mjs").DreamSource} Source */
/** @typedef {{runId:string,agentId:string,cursorStart:Watermarks,cursorEnd:Watermarks,snapshotVersion:number,items:Source[]}} Snapshot */
/** @typedef {{id:string,agent_id:string,scope_id:string,category:string,subject_key:string,content:string,epistemic_status:string,importance:number,confidence:number,status:string,version:number,from_private:number,source_scopes_json:string,merged_into:string|null,valid_from:string,valid_to:string|null,created_at:string,updated_at:string}} Cognition */
/** @typedef {{runtime:any,agentId:string,conversation:string}} Scope */
/** @typedef {import("node:sqlite").DatabaseSync} Database */

/** @param {Database} db @param {string} agentId */
function checkpoint(db, agentId) {
  const starts = { events: 0, diaries: 0, corrections: 0 };
  let version = 0;
  const rows = prepared(
    db,
    "SELECT source_partition,last_event_seq,cognition_version FROM dream_checkpoints WHERE agent_id=?",
  ).all(agentId);
  for (const { source_partition, last_event_seq, cognition_version } of rows) {
    const partition = SOURCE_PARTITIONS.find(
      (name) => name === source_partition,
    );
    if (partition) starts[partition] = Number(last_event_seq);
    version = Math.max(version, Number(cognition_version));
  }
  return { starts, version };
}

/** @param {any} runtime @param {string} agentId @param {{backendId:string,model:string,batchSize:number,idempotencyKey?:string}} options */
export function startDream(
  runtime,
  agentId,
  { backendId, model, batchSize, idempotencyKey = randomUUID() },
) {
  const store = runtime.memory,
    db = store.db;
  return store.transaction(() => {
    if (
      prepared(
        db,
        "SELECT 1 FROM dream_runs WHERE agent_id=? AND status IN ('RUNNING','VALIDATING')",
      ).get(agentId)
    )
      throw Error("DREAM_ALREADY_RUNNING");
    const previous = prepared(
      db,
      "SELECT run_id,status FROM dream_runs WHERE agent_id=? AND idempotency_key=?",
    ).get(agentId, idempotencyKey);
    if (previous) return { previous };
    const { starts, version } = checkpoint(db, agentId);
    const limits = { ...starts };
    for (const partition of SOURCE_PARTITIONS) {
      const { from, cursor } = SOURCES[partition];
      const last = prepared(
        db,
        `SELECT max(seq) AS last FROM (
        SELECT ${cursor} AS seq FROM ${from} WHERE ${sourceRoleColumn(partition)}=? AND ${cursor}>?
        ORDER BY ${cursor} LIMIT ?
      )`,
      ).get(agentId, starts[partition], batchSize);
      limits[partition] = Math.max(starts[partition], Number(last?.last));
    }
    const cursorEnd = { ...starts },
      items = [];
    const sources = dreamSources(
      runtime,
      { agentId, conversation: "@dream" },
      limits,
    );
    for (const partition of SOURCE_PARTITIONS) {
      for (const row of sources.scan(partition, starts[partition], batchSize)) {
        cursorEnd[partition] = row.seq;
        if (row.item) items.push(row.item);
      }
    }
    const runId = randomUUID(),
      time = new Date(runtime.now()).toISOString();
    prepared(
      db,
      `INSERT INTO dream_runs (
      run_id,agent_id,mode,trigger,idempotency_key,status,snapshot_version,cursor_start,cursor_end,
      backend_id,model,prompt_version,attempts,created_at,started_at
    ) VALUES(?,?,'nap','manual',?,'RUNNING',?,?,?,?,?,'1',1,?,?)`,
    ).run(
      runId,
      agentId,
      idempotencyKey,
      version,
      starts.events,
      cursorEnd.events,
      backendId,
      model,
      time,
      time,
    );
    const snapshot = {
      runId,
      agentId,
      cursorStart: starts,
      cursorEnd,
      snapshotVersion: version,
      items,
    };
    return { snapshot };
  });
}

/** @param {Database} db @param {string} agentId @param {{scopeId?:string,category?:string,status?:string,query?:string,offset?:number,limit?:number}} [filters] */
export function listCognitions(
  db,
  agentId,
  { scopeId, category, status = "active", query, offset = 0, limit = 20 } = {},
) {
  const where = ["agent_id=?", "status=?"];
  const params = [agentId, status];
  if (scopeId) {
    where.push("scope_id=?");
    params.push(scopeId);
  }
  if (category) {
    where.push("category=?");
    params.push(category);
  }
  if (query) {
    where.push(
      "(instr(lower(subject_key),lower(?))>0 OR instr(lower(content),lower(?))>0)",
    );
    params.push(query, query);
  }
  return /** @type {Cognition[]} */ (
    prepared(
      db,
      `SELECT * FROM cognitions WHERE ${where.join(" AND ")}
    ORDER BY importance DESC, updated_at DESC, id LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset)
  );
}

/** @param {Database} db @param {Cognition} row @param {(id:string) => Source|null|undefined} read */
export function visibleCognitionEvidence(db, row, read) {
  const evidence = /** @type {string[]} */ (
    prepared(
      db,
      "SELECT source_id FROM cognition_evidence WHERE agent_id=? AND cognition_id=? AND cognition_version=?",
    )
      .all(row.agent_id, row.id, row.version)
      .map((/** @type {{source_id:string}} */ { source_id }) => source_id)
  );
  return evidence.length && evidence.every((id) => read(id)) ? evidence : null;
}

/** @param {Scope["runtime"]} runtime @param {Snapshot} snapshot @param {unknown} input @param {{privateRead:Set<string>, fingerprints:Map<string,string>, maxOps:number}} access */
export function planDreamPatch(runtime, snapshot, input, access) {
  const patch = parsePatch(input, access.maxOps);
  const { agentId, cursorEnd } = snapshot;
  const db = runtime.memory.db,
    { read } = dreamSources(
      runtime,
      { agentId, conversation: "@dream" },
      cursorEnd,
    );
  const changes = [],
    keys = new Set(),
    targets = new Set();
  const time = new Date(runtime.now()).toISOString();
  for (const op of patch.operations) {
    const before =
      op.op === "UPDATE"
        ? /** @type {Cognition|undefined} */ (
            prepared(
              db,
              "SELECT * FROM cognitions WHERE agent_id=? AND id=? AND status<>'archived'",
            ).get(agentId, op.targetId)
          )
        : undefined;
    if (
      op.op === "UPDATE" &&
      (!before ||
        before.version !== op.expectedVersion ||
        targets.has(op.targetId))
    )
      throw Error("DREAM_VERSION_CONFLICT");
    if (before) targets.add(before.id);
    const scope = op.op === "ADD" ? op.scopeId : before?.scope_id;
    const category = op.op === "ADD" ? op.category : before?.category;
    if (!scope || !category) throw Error("DREAM_INVALID_PATCH");
    if (op.op === "ADD") {
      const key = JSON.stringify([op.scopeId, op.subjectKey]);
      if (
        keys.has(key) ||
        prepared(
          db,
          "SELECT 1 FROM cognitions WHERE agent_id=? AND scope_id=? AND subject_key=? AND status='active'",
        ).get(agentId, op.scopeId, op.subjectKey)
      )
        throw Error("DREAM_DUPLICATE_SUBJECT_KEY");
      keys.add(key);
    }
    const { sources, scopes } = validateEvidence(
      op,
      scope,
      category,
      read,
      access.privateRead,
      access.fingerprints,
    );
    if (before)
      for (const sourceScope of JSON.parse(before.source_scopes_json))
        scopes.add(sourceScope);
    const fromPrivate = Number(
      Boolean(before?.from_private) ||
        [...scopes].some((s) => s.startsWith("private:")),
    );
    /** @type {Cognition} */
    const after = {
      id: before?.id ?? randomUUID(),
      agent_id: agentId,
      scope_id: scope,
      category,
      subject_key:
        op.op === "ADD" ? op.subjectKey : (before?.subject_key ?? ""),
      content: op.content,
      epistemic_status: op.epistemicStatus,
      importance: op.importance ?? before?.importance ?? 0,
      confidence: op.confidence ?? before?.confidence ?? 0,
      status: "active",
      version: (before?.version ?? 0) + 1,
      from_private: fromPrivate,
      source_scopes_json: JSON.stringify([...scopes].sort()),
      merged_into: null,
      valid_from: before?.valid_from ?? time,
      valid_to: null,
      created_at: before?.created_at ?? time,
      updated_at: time,
    };
    changes.push({ op, before, after, sources });
  }
  return { changes, time };
}

/** @param {Scope["runtime"]} runtime @param {Snapshot} snapshot @param {unknown} input @param {Parameters<typeof planDreamPatch>[3]} access */
export function commitDream(runtime, snapshot, input, access) {
  const store = runtime.memory,
    db = store.db;
  return store.transaction(() => {
    const { runId, agentId, snapshotVersion, cursorStart, cursorEnd } =
      snapshot;
    const cp = checkpoint(db, agentId);
    if (
      cp.version !== snapshotVersion ||
      SOURCE_PARTITIONS.some((name) => cp.starts[name] !== cursorStart[name])
    )
      throw Error("DREAM_VERSION_CONFLICT");
    const run = prepared(
      db,
      "SELECT 1 FROM dream_runs WHERE run_id=? AND agent_id=? AND status='RUNNING'",
    ).get(runId, agentId);
    if (!run) throw Error("DREAM_INTERRUPTED");
    const { changes, time } = planDreamPatch(runtime, snapshot, input, access);
    for (const { op, before, after, sources } of changes) {
      if (before) {
        const result = prepared(
          db,
          `UPDATE cognitions SET content=?,epistemic_status=?,importance=?,confidence=?,
          status=?,version=?,from_private=?,source_scopes_json=?,updated_at=? WHERE agent_id=? AND id=? AND version=?`,
        ).run(
          after.content,
          after.epistemic_status,
          after.importance,
          after.confidence,
          after.status,
          after.version,
          after.from_private,
          after.source_scopes_json,
          after.updated_at,
          agentId,
          after.id,
          before.version,
        );
        if (result.changes !== 1) throw Error("DREAM_VERSION_CONFLICT");
      } else {
        prepared(
          db,
          `INSERT INTO cognitions
          (id,agent_id,scope_id,category,subject_key,content,epistemic_status,importance,confidence,
          status,version,from_private,source_scopes_json,merged_into,valid_from,valid_to,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          after.id,
          agentId,
          after.scope_id,
          after.category,
          after.subject_key,
          after.content,
          after.epistemic_status,
          after.importance,
          after.confidence,
          after.status,
          after.version,
          after.from_private,
          after.source_scopes_json,
          after.merged_into,
          after.valid_from,
          after.valid_to,
          after.created_at,
          after.updated_at,
        );
      }
      prepared(
        db,
        "INSERT INTO cognition_revisions VALUES(?,?,?,?,?,?,?,?,?,?)",
      ).run(
        agentId,
        after.id,
        after.version,
        op.op,
        before ? JSON.stringify(before) : null,
        JSON.stringify(after),
        runId,
        "dream-cognitive",
        op.reason,
        time,
      );
      for (const source of sources)
        prepared(
          db,
          "INSERT INTO cognition_evidence VALUES(?,?,?,?,?,?,?,?)",
        ).run(
          agentId,
          after.id,
          after.version,
          source.id,
          source.type,
          source.scopeId,
          source.type === "correction" && op.op === "UPDATE"
            ? "supersedes"
            : "supports",
          time,
        );
    }
    for (const partition of SOURCE_PARTITIONS)
      prepared(
        db,
        `INSERT INTO dream_checkpoints (agent_id,source_partition,last_event_seq,cognition_version,updated_at)
        VALUES(?,?,?,?,?) ON CONFLICT(agent_id,source_partition) DO UPDATE SET
        last_event_seq=excluded.last_event_seq,cognition_version=excluded.cognition_version,updated_at=excluded.updated_at`,
      ).run(
        agentId,
        partition,
        cursorEnd[partition],
        snapshotVersion + Number(changes.length > 0),
        time,
      );
    prepared(
      db,
      "UPDATE dream_runs SET status='COMMITTED',changes_count=?,finished_at=? WHERE run_id=?",
    ).run(changes.length, time, runId);
    return { status: "COMMITTED", runId, changesCount: changes.length };
  });
}

/** @param {Database} db @param {string} runId @param {"FAILED"|"CANCELLED"} status @param {string} code @param {number} now */
export function failDream(db, runId, status, code, now) {
  prepared(
    db,
    "UPDATE dream_runs SET status=?,error_code=?,finished_at=? WHERE run_id=? AND status IN ('RUNNING','VALIDATING')",
  ).run(status, code, new Date(now).toISOString(), runId);
}

/** @param {Database} db @param {number} now */
export function recoverDreamRuns(db, now) {
  prepared(
    db,
    "UPDATE dream_runs SET status='FAILED',error_code='DREAM_INTERRUPTED',finished_at=? WHERE status IN ('RUNNING','VALIDATING')",
  ).run(new Date(now).toISOString());
}
