// @ts-check
import { sampleStoryMaterial, storyWatermarks } from "./story.mjs";
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
export function checkpoint(db, agentId) {
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

/** @param {any} runtime @param {string} agentId @param {{backendId:string,model:string,batchSize:number,idempotencyKey?:string,mode?:string,trigger?:string,queuedId?:string}} options */
export function startDream(
  runtime,
  agentId,
  {
    backendId,
    model,
    batchSize,
    idempotencyKey = randomUUID(),
    mode = "nap",
    trigger = "manual",
    queuedId,
  },
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
    if (mode !== "imaginative")
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
    if (mode !== "imaginative")
      for (const partition of SOURCE_PARTITIONS) {
        for (const row of sources.scan(
          partition,
          starts[partition],
          batchSize,
        )) {
          cursorEnd[partition] = row.seq;
          if (row.item) items.push(row.item);
        }
      }
    if (mode === "imaginative")
      items.push(
        ...sampleStoryMaterial(runtime, { agentId, conversation: "@dream" }),
      );
    const runId = queuedId ?? randomUUID(),
      time = new Date(runtime.now()).toISOString();
    if (queuedId) {
      const result = prepared(
        db,
        `UPDATE dream_runs SET status='RUNNING',snapshot_version=?,cursor_start=?,cursor_end=?,
        backend_id=?,model=?,attempts=1,started_at=? WHERE run_id=? AND agent_id=? AND status='QUEUED'`,
      ).run(
        version,
        starts.events,
        cursorEnd.events,
        backendId,
        model,
        time,
        runId,
        agentId,
      );
      if (result.changes !== 1) throw Error("DREAM_INTERRUPTED");
    } else {
      prepared(
        db,
        `INSERT INTO dream_runs (run_id,agent_id,mode,trigger,idempotency_key,status,snapshot_version,cursor_start,cursor_end,
        backend_id,model,prompt_version,attempts,created_at,started_at) VALUES(?,?,?,?,?,'RUNNING',?,?,?,?,?,'1',1,?,?)`,
      ).run(
        runId,
        agentId,
        mode,
        trigger,
        idempotencyKey,
        version,
        starts.events,
        cursorEnd.events,
        backendId,
        model,
        time,
        time,
      );
    }
    const snapshot = {
      runId,
      agentId,
      cursorStart: starts,
      cursorEnd: mode === "imaginative" ? storyWatermarks : cursorEnd,
      snapshotVersion: version,
      items: items.sort(
        (a, b) =>
          Number(b.type === "correction") - Number(a.type === "correction"),
      ),
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

/** @param {Database} db @param {Cognition} row @param {(id:string,revision?:number) => Source|null|undefined} read */
export function visibleCognitionEvidence(db, row, read) {
  const evidence = storedEvidence(db, row);
  if (!evidence.length) return null;
  const scopes = new Set(
    /** @type {string[]} */ (JSON.parse(row.source_scopes_json)),
  );
  for (const ref of evidence) {
    if (ref.source_type === "diary" && !ref.source_revision) return null;
    const source = read(ref.source_id, ref.source_revision || undefined);
    if (!source) return null;
    for (const scope of source.sourceScopes) scopes.add(scope);
  }
  // Upgrade the in-memory projection too: historical rows can predate transitive scope tracking.
  row.source_scopes_json = JSON.stringify([...scopes].sort());
  if ([...scopes].some((scope) => scope.startsWith("private:")))
    row.from_private = 1;
  return evidence.map((ref) => ref.source_id);
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
    links = [],
    keys = new Set(),
    targets = new Set();
  const time = new Date(runtime.now()).toISOString();
  const lookup = (/** @type {string} */ id) => {
    const row = /** @type {Cognition|undefined} */ (
      prepared(
        db,
        "SELECT * FROM cognitions WHERE agent_id=? AND id=? AND status<>'archived'",
      ).get(agentId, id)
    );
    if (!row) throw Error("DREAM_VERSION_CONFLICT");
    return row;
  };
  const reserve = (/** @type {Cognition} */ row) => {
    if (targets.has(row.id)) throw Error("DREAM_VERSION_CONFLICT");
    targets.add(row.id);
  };
  for (const op of patch.operations) {
    if (op.op === "LINK") {
      const from = lookup(op.fromId),
        to = lookup(op.toId);
      if (from.id === to.id || !compatible(from, to))
        throw Error("DREAM_SCOPE_VIOLATION");
      if (
        !visibleCognitionEvidence(db, from, read) ||
        !visibleCognitionEvidence(db, to, read)
      )
        throw Error("RECALL_SOURCE_NOT_ALLOWED");
      links.push({
        ...op,
        scope: from.scope_id === "global" ? to.scope_id : from.scope_id,
      });
      continue;
    }
    const before = op.op === "ADD" ? undefined : lookup(op.targetId);
    if (
      before &&
      "expectedVersion" in op &&
      before.version !== op.expectedVersion
    )
      throw Error("DREAM_VERSION_CONFLICT");
    if (before) reserve(before);
    if (op.op === "ARCHIVE" && before) {
      if (!visibleCognitionEvidence(db, before, read))
        throw Error("RECALL_SOURCE_NOT_ALLOWED");
      changes.push({
        op: op.op,
        reason: op.reason,
        before,
        after: archived(before, time),
        evidence: storedEvidence(db, before),
      });
      continue;
    }
    const scope = op.op === "ADD" ? op.scopeId : before?.scope_id;
    const category = op.op === "ADD" ? op.category : before?.category;
    if (!scope || !category || !("evidenceIds" in op))
      throw Error("DREAM_INVALID_PATCH");
    if (op.op === "ADD") {
      const key = JSON.stringify([scope, op.subjectKey]);
      if (keys.has(key) || duplicate(db, agentId, scope, op.subjectKey))
        throw Error("DREAM_DUPLICATE_SUBJECT_KEY");
      keys.add(key);
    }
    if (
      op.op === "MERGE" &&
      before &&
      !visibleCognitionEvidence(db, before, read)
    )
      throw Error("RECALL_SOURCE_NOT_ALLOWED");
    const merged =
      op.op === "MERGE" ? [...new Set(op.sourceIds)].map(lookup) : [];
    for (const item of merged) {
      if (!before || !compatible(before, item))
        throw Error("DREAM_SCOPE_VIOLATION");
      reserve(item);
      if (!visibleCognitionEvidence(db, item, read))
        throw Error("RECALL_SOURCE_NOT_ALLOWED");
      changes.push({
        op: op.op,
        reason: op.reason,
        before: item,
        after: archived(item, time, before.id),
        evidence: storedEvidence(db, item),
      });
    }
    const changedStatus =
      "epistemicStatus" in op ? op.epistemicStatus : undefined;
    const status =
      op.op === "WEAKEN"
        ? "disputed"
        : (changedStatus ?? before?.epistemic_status ?? "reported");
    const { sources, scopes } = validateEvidence(
      {
        evidenceIds: op.evidenceIds,
        epistemicStatus: changedStatus ?? "reported",
      },
      scope,
      category,
      read,
      access.privateRead,
      access.fingerprints,
    );
    const predecessors = before ? [before, ...merged] : merged;
    for (const item of predecessors)
      for (const priorScope of JSON.parse(item.source_scopes_json))
        scopes.add(priorScope);
    let importance =
      ("importance" in op ? op.importance : undefined) ??
      before?.importance ??
      0;
    let confidence =
      ("confidence" in op ? op.confidence : undefined) ??
      before?.confidence ??
      0;
    if (before && (op.op === "REINFORCE" || op.op === "WEAKEN")) {
      const direction = op.op === "REINFORCE" ? 1 : -1;
      if (!visibleCognitionEvidence(db, before, read))
        throw Error("RECALL_SOURCE_NOT_ALLOWED");
      importance = adjust(op.importance, before.importance, direction);
      confidence = adjust(op.confidence, before.confidence, direction);
    }
    /** @type {Cognition} */
    const after = {
      id: before?.id ?? randomUUID(),
      agent_id: agentId,
      scope_id: scope,
      category,
      subject_key:
        op.op === "ADD" ? op.subjectKey : (before?.subject_key ?? ""),
      content: "content" in op ? op.content : (before?.content ?? ""),
      epistemic_status: status,
      importance,
      confidence,
      status: status === "disputed" ? "disputed" : "active",
      version: (before?.version ?? 0) + 1,
      from_private: Number(
        predecessors.some((item) => item.from_private) ||
          [...scopes].some((item) => item.startsWith("private:")),
      ),
      source_scopes_json: JSON.stringify([...scopes].sort()),
      merged_into: null,
      valid_from: before?.valid_from ?? time,
      valid_to: null,
      created_at: before?.created_at ?? time,
      updated_at: time,
    };
    /** @type {Map<string, Evidence>} */
    const evidence = new Map();
    if (["REINFORCE", "WEAKEN", "MERGE"].includes(op.op))
      for (const item of predecessors)
        for (const source of storedEvidence(db, item))
          evidence.set(
            JSON.stringify([source.source_id, source.source_revision]),
            source,
          );
    for (const source of sources)
      evidence.set(JSON.stringify([source.id, source.revision ?? 0]), {
        source_revision: source.revision ?? 0,
        source_id: source.id,
        source_type: source.type,
        scope_id: source.scopeId,
        relation:
          op.op === "WEAKEN"
            ? "contradicts"
            : source.type === "correction" && op.op === "UPDATE"
              ? "supersedes"
              : "supports",
      });
    if (
      before &&
      before.status !== "active" &&
      after.status === "active" &&
      (keys.has(JSON.stringify([scope, after.subject_key])) ||
        duplicate(db, agentId, scope, after.subject_key))
    )
      throw Error("DREAM_DUPLICATE_SUBJECT_KEY");
    keys.add(JSON.stringify([scope, after.subject_key]));
    changes.push({
      op: op.op,
      reason: op.reason,
      before,
      after,
      evidence: [...evidence.values()],
    });
  }
  return { changes, links, time };
}

/** @param {Cognition} a @param {Cognition} b */
function compatible(a, b) {
  return (
    a.scope_id === b.scope_id ||
    a.scope_id === "global" ||
    b.scope_id === "global"
  );
}

/** @param {number|undefined} requested @param {number} previous @param {number} direction */
function adjust(requested, previous, direction) {
  const wanted = requested ?? previous + direction * 0.1;
  return direction > 0
    ? Math.max(previous, Math.min(1, previous + 0.2, wanted))
    : Math.min(previous, Math.max(0, previous - 0.2, wanted));
}

/** @param {Database} db @param {string} agentId @param {string} scope @param {string} key */
function duplicate(db, agentId, scope, key) {
  return prepared(
    db,
    "SELECT 1 FROM cognitions WHERE agent_id=? AND scope_id=? AND subject_key=? AND status='active'",
  ).get(agentId, scope, key);
}

/** @param {Cognition} row @param {string} time @param {string|null} [mergedInto] @returns {Cognition} */
function archived(row, time, mergedInto = null) {
  return {
    ...row,
    status: "archived",
    version: row.version + 1,
    merged_into: mergedInto,
    valid_to: time,
    updated_at: time,
  };
}

/** @typedef {{source_id:string,source_type:string,scope_id:string,relation:string,source_revision:number}} Evidence */
/** @param {Database} db @param {Cognition} row */
function storedEvidence(db, row) {
  return /** @type {Evidence[]} */ (
    prepared(
      db,
      "SELECT source_id,source_type,scope_id,relation,source_revision FROM cognition_evidence WHERE agent_id=? AND cognition_id=? AND cognition_version=? ORDER BY source_id",
    ).all(row.agent_id, row.id, row.version)
  );
}

/** @param {Database} db @param {{op:string,reason:string,before?:Cognition,after:Cognition,evidence:Evidence[]}} change @param {string} time @param {string|null} runId */
function writeCognition(
  db,
  { op, reason, before, after, evidence },
  time,
  runId,
) {
  const { agent_id: agentId, id, version } = after;
  if (before) {
    const result = prepared(
      db,
      `UPDATE cognitions SET subject_key=?,content=?,epistemic_status=?,importance=?,confidence=?,status=?,version=?,from_private=?,source_scopes_json=?,merged_into=?,valid_to=?,updated_at=? WHERE agent_id=? AND id=? AND version=?`,
    ).run(
      after.subject_key,
      after.content,
      after.epistemic_status,
      after.importance,
      after.confidence,
      after.status,
      version,
      after.from_private,
      after.source_scopes_json,
      after.merged_into,
      after.valid_to,
      time,
      agentId,
      id,
      before.version,
    );
    if (result.changes !== 1) throw Error("DREAM_VERSION_CONFLICT");
  } else {
    prepared(
      db,
      "INSERT INTO cognitions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      id,
      agentId,
      after.scope_id,
      after.category,
      after.subject_key,
      after.content,
      after.epistemic_status,
      after.importance,
      after.confidence,
      after.status,
      version,
      after.from_private,
      after.source_scopes_json,
      after.merged_into,
      after.valid_from,
      after.valid_to,
      after.created_at,
      time,
    );
  }
  prepared(
    db,
    "INSERT INTO cognition_revisions VALUES(?,?,?,?,?,?,?,?,?,?)",
  ).run(
    agentId,
    id,
    version,
    op,
    before ? JSON.stringify(before) : null,
    JSON.stringify(after),
    runId,
    runId
      ? "dream-cognitive"
      : op === "ROLLBACK"
        ? "admin"
        : "system-provenance",
    reason,
    time,
  );
  for (const source of evidence)
    prepared(
      db,
      "INSERT INTO cognition_evidence VALUES(?,?,?,?,?,?,?,?,?)",
    ).run(
      agentId,
      id,
      version,
      source.source_id,
      source.source_type,
      source.scope_id,
      source.relation,
      time,
      source.source_revision,
    );
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
    const { changes, links, time } = planDreamPatch(
      runtime,
      snapshot,
      input,
      access,
    );
    for (const change of changes) writeCognition(db, change, time, runId);
    let changesCount = changes.length;
    for (const link of links)
      changesCount += Number(
        prepared(
          db,
          "INSERT OR IGNORE INTO cognition_links VALUES(?,?,?,?,?,?)",
        ).run(agentId, link.fromId, link.toId, link.relation, link.scope, time)
          .changes,
      );
    const version = snapshotVersion + Number(changesCount > 0);
    if (changesCount) rebuildAwakening(runtime, agentId, version, time);
    for (const partition of SOURCE_PARTITIONS)
      prepared(
        db,
        `INSERT INTO dream_checkpoints (agent_id,source_partition,last_event_seq,cognition_version,updated_at)
        VALUES(?,?,?,?,?) ON CONFLICT(agent_id,source_partition) DO UPDATE SET
        last_event_seq=excluded.last_event_seq,cognition_version=excluded.cognition_version,updated_at=excluded.updated_at`,
      ).run(agentId, partition, cursorEnd[partition], version, time);
    prepared(
      db,
      "UPDATE dream_runs SET status='COMMITTED',changes_count=?,finished_at=? WHERE run_id=?",
    ).run(changesCount, time, runId);
    return { status: "COMMITTED", runId, changesCount };
  });
}

/** @param {Database} db @param {string} runId @param {"FAILED"|"CANCELLED"} status @param {string} code @param {number} now */
export function failDream(db, runId, status, code, now) {
  prepared(
    db,
    "UPDATE dream_runs SET status=?,error_code=?,finished_at=? WHERE run_id=? AND status IN ('QUEUED','RUNNING','VALIDATING')",
  ).run(status, code, new Date(now).toISOString(), runId);
}

/** @param {Database} db @param {number} now */
export function recoverDreamRuns(db, now) {
  prepared(
    db,
    "UPDATE dream_runs SET status='FAILED',error_code='DREAM_INTERRUPTED',finished_at=? WHERE status IN ('QUEUED','RUNNING','VALIDATING')",
  ).run(new Date(now).toISOString());
}

/** @param {Database} db @param {string} agentId @param {string} correctionId */
export function disputeSupersededCorrection(db, agentId, correctionId) {
  const rows = /** @type {Cognition[]} */ (
    prepared(
      db,
      `SELECT c.* FROM cognitions c JOIN cognition_evidence e ON
    c.id=e.cognition_id AND c.agent_id=e.agent_id AND c.version=e.cognition_version
    WHERE c.agent_id=? AND c.status='active' AND e.source_type='correction' AND e.source_id=?`,
    ).all(agentId, correctionId)
  );
  for (const before of rows)
    reviseSourceState(db, before, "CORRECTION_SUPERSEDED");
}

/** @param {Database} db @param {Cognition} before @param {string} op @param {Cognition} [projection] */
function reviseSourceState(db, before, op, projection) {
  const time = new Date().toISOString();
  const after = {
    ...(projection ?? {
      ...before,
      content: "",
      status: "disputed",
      epistemic_status: "disputed",
    }),
    version: before.version + 1,
    updated_at: time,
  };
  writeCognition(
    db,
    { op, before, after, reason: op, evidence: storedEvidence(db, before) },
    time,
    null,
  );
  prepared(
    db,
    "UPDATE dream_checkpoints SET cognition_version=cognition_version+1,updated_at=? WHERE agent_id=?",
  ).run(time, before.agent_id);
  prepared(
    db,
    `DELETE FROM awakening_contexts WHERE agent_id=? AND EXISTS (
    SELECT 1 FROM json_each(source_refs_json) WHERE json_extract(value,'$.id')=?)`,
  ).run(before.agent_id, before.id);
}

/** @param {any} memory */
export function reconcileCognitionProvenance(memory) {
  const { db, agentId } = memory;
  const rows = /** @type {Cognition[]} */ (
    prepared(
      db,
      "SELECT * FROM cognitions WHERE agent_id=? AND status='active'",
    ).all(agentId)
  );
  const { read } = dreamSources(
    { memory: memory.store },
    { agentId, conversation: "@dream" },
    allSources,
  );
  for (const before of rows) {
    const refs = storedEvidence(db, before);
    if (
      refs.some((ref) => ref.source_type === "diary" && !ref.source_revision)
    ) {
      reviseSourceState(db, before, "EVIDENCE_REVISION_UNKNOWN");
      continue;
    }
    const projection = { ...before };
    if (
      visibleCognitionEvidence(db, projection, read) &&
      (projection.from_private !== before.from_private ||
        projection.source_scopes_json !== before.source_scopes_json)
    )
      reviseSourceState(db, before, "SOURCE_SCOPES_UPDATED", projection);
  }
}

const allSources = {
  events: Number.MAX_SAFE_INTEGER,
  diaries: Number.MAX_SAFE_INTEGER,
  corrections: Number.MAX_SAFE_INTEGER,
};

/** @param {any} runtime @param {string} agentId @param {number} version @param {string} time */
function rebuildAwakening(runtime, agentId, version, time) {
  const db = runtime.memory.db,
    max = runtime.agent(agentId).dream.budget.awakeningSummaryChars;
  prepared(db, "DELETE FROM awakening_contexts WHERE agent_id=?").run(agentId);
  if (!max) return;
  const { read } = dreamSources(
    runtime,
    { agentId, conversation: "@dream" },
    allSources,
  );
  const rows = /** @type {Iterable<Cognition>} */ (
    prepared(
      db,
      "SELECT * FROM cognitions WHERE agent_id=? AND status='active' ORDER BY importance DESC,updated_at DESC,id",
    ).iterate(agentId)
  );
  /** @type {Map<string,{summary:string,refs:{id:string,version:number}[]}>} */
  const summaries = new Map();
  for (const row of rows) {
    if (!visibleCognitionEvidence(db, row, read)) continue;
    const entry = summaries.get(row.scope_id) ?? { summary: "", refs: [] };
    const line = (entry.summary ? "\n" : "") + row.content;
    if (entry.summary.length + line.length > max) continue;
    entry.summary += line;
    entry.refs.push({ id: row.id, version: row.version });
    summaries.set(row.scope_id, entry);
  }
  for (const [scope, entry] of summaries)
    prepared(db, "INSERT INTO awakening_contexts VALUES(?,?,?,?,?,?)").run(
      agentId,
      scope,
      version,
      entry.summary,
      JSON.stringify(entry.refs),
      time,
    );
}

/** @param {any} runtime @param {string} agentId @param {string} id @param {{version:number,expectedVersion:number}} args */
export function rollbackCognition(
  runtime,
  agentId,
  id,
  { version, expectedVersion },
) {
  const { db } = runtime.memory;
  return runtime.memory.transaction(() => {
    const before = /** @type {Cognition|undefined} */ (
      prepared(db, "SELECT * FROM cognitions WHERE agent_id=? AND id=?").get(
        agentId,
        id,
      )
    );
    if (!before || before.version !== expectedVersion)
      throw Error("DREAM_VERSION_CONFLICT");
    const historical = prepared(
      db,
      "SELECT after_json FROM cognition_revisions WHERE agent_id=? AND cognition_id=? AND version=? AND op<>'PURGE_REBUILD'",
    ).get(agentId, id, version);
    if (!historical) throw Error("DREAM_ROLLBACK_FAILED");
    const original = /** @type {Cognition} */ (
      JSON.parse(String(historical.after_json))
    );
    const { read } = dreamSources(
      runtime,
      { agentId, conversation: "@dream" },
      allSources,
    );
    if (!visibleCognitionEvidence(db, original, read))
      throw Error("DREAM_ROLLBACK_FAILED");
    if (
      (before.status !== "active" ||
        before.subject_key !== original.subject_key) &&
      original.status === "active" &&
      duplicate(db, agentId, original.scope_id, original.subject_key)
    )
      throw Error("DREAM_DUPLICATE_SUBJECT_KEY");
    const time = new Date(runtime.now()).toISOString();
    const after = {
      ...original,
      id,
      agent_id: agentId,
      version: expectedVersion + 1,
      updated_at: time,
      from_private: Number(
        Boolean(before.from_private || original.from_private),
      ),
      source_scopes_json: JSON.stringify(
        [
          ...new Set([
            ...JSON.parse(before.source_scopes_json),
            ...JSON.parse(original.source_scopes_json),
          ]),
        ].sort(),
      ),
    };
    writeCognition(
      db,
      {
        op: "ROLLBACK",
        reason: `Rollback to version ${version}`,
        before,
        after,
        evidence: storedEvidence(db, original),
      },
      time,
      null,
    );
    refreshAfterAdminChange(runtime, agentId, time);
    return after;
  });
}

/** @param {any} runtime @param {string} agentId @param {string} id @param {number} expectedVersion */
export function deleteCognition(runtime, agentId, id, expectedVersion) {
  const { db } = runtime.memory;
  return runtime.memory.transaction(() => {
    if (
      prepared(
        db,
        "DELETE FROM cognitions WHERE agent_id=? AND id=? AND version=?",
      ).run(agentId, id, expectedVersion).changes !== 1
    )
      throw Error("DREAM_VERSION_CONFLICT");
    rebuildAwakening(
      runtime,
      agentId,
      checkpoint(db, agentId).version,
      new Date(runtime.now()).toISOString(),
    );
    return { id, deleted: true };
  });
}

/** @param {any} runtime @param {string} agentId @param {string} time */
function refreshAfterAdminChange(runtime, agentId, time) {
  const { db } = runtime.memory,
    { version, starts } = checkpoint(db, agentId);
  for (const partition of SOURCE_PARTITIONS)
    prepared(
      db,
      `INSERT INTO dream_checkpoints(agent_id,source_partition,last_event_seq,cognition_version,updated_at)
    VALUES(?,?,?,?,?) ON CONFLICT(agent_id,source_partition) DO UPDATE SET cognition_version=excluded.cognition_version,updated_at=excluded.updated_at`,
    ).run(agentId, partition, starts[partition], version + 1, time);
  rebuildAwakening(runtime, agentId, version + 1, time);
}
