// @ts-check

export const DREAM_SCHEMA_VERSION = 10;
export const DREAM_TABLES = [
  "cognitions",
  "cognition_evidence",
  "cognition_links",
  "cognition_revisions",
  "dream_runs",
  "dream_checkpoints",
  "imaginative_dreams",
  "awakening_contexts",
];

/** @param {import("node:sqlite").DatabaseSync} db */
export function initializeDreamTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cognitions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      category TEXT NOT NULL,
      subject_key TEXT NOT NULL,
      content TEXT NOT NULL,
      epistemic_status TEXT NOT NULL,
      importance REAL NOT NULL,
      confidence REAL NOT NULL,
      status TEXT NOT NULL,
      version INTEGER NOT NULL,
      from_private INTEGER NOT NULL DEFAULT 0,
      source_scopes_json TEXT NOT NULL,
      merged_into TEXT,
      valid_from TEXT NOT NULL,
      valid_to TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS cognitions_agent_active
      ON cognitions(agent_id, status, scope_id, importance DESC, updated_at DESC);
    CREATE INDEX IF NOT EXISTS cognitions_subject_lookup
      ON cognitions(agent_id, scope_id, subject_key, status);


    CREATE TABLE IF NOT EXISTS cognition_evidence (
      agent_id TEXT NOT NULL,
      cognition_id TEXT NOT NULL,
      cognition_version INTEGER NOT NULL,
      source_id TEXT NOT NULL,
      source_type TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      created_at TEXT NOT NULL,
      source_revision INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (agent_id, cognition_id, cognition_version, source_id,source_revision)
    );
    CREATE INDEX IF NOT EXISTS cognition_evidence_source
      ON cognition_evidence(agent_id, source_id);


    CREATE TABLE IF NOT EXISTS cognition_links (
      agent_id TEXT NOT NULL,
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (agent_id, from_id, to_id, relation)
    );


    CREATE TABLE IF NOT EXISTS cognition_revisions (
      agent_id TEXT NOT NULL,
      cognition_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      op TEXT NOT NULL,
      before_json TEXT,
      after_json TEXT NOT NULL,
      run_id TEXT,
      actor TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (agent_id, cognition_id, version)
    );


    CREATE TABLE IF NOT EXISTS dream_runs (
      run_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      trigger TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      status TEXT NOT NULL,
      snapshot_version INTEGER NOT NULL,
      cursor_start INTEGER NOT NULL,
      cursor_end INTEGER NOT NULL,
      backend_id TEXT,
      model TEXT,
      prompt_version TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      changes_count INTEGER NOT NULL DEFAULT 0,
      usage_json TEXT,
      error_code TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      UNIQUE (agent_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS dream_runs_agent_recent
      ON dream_runs(agent_id, created_at DESC);


    CREATE TABLE IF NOT EXISTS dream_checkpoints (
      agent_id TEXT NOT NULL,
      source_partition TEXT NOT NULL,
      last_event_seq INTEGER NOT NULL,
      last_cursor_token TEXT,
      cognition_version INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (agent_id, source_partition)
    );


    CREATE TABLE IF NOT EXISTS imaginative_dreams (
      dream_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      fictional INTEGER NOT NULL DEFAULT 1 CHECK (fictional = 1),
      title TEXT NOT NULL,
      narrative TEXT NOT NULL,
      reflection TEXT NOT NULL,
      themes_json TEXT NOT NULL,
      inspirations_json TEXT NOT NULL,
      inspiration_consumed_at TEXT,
      published_room_slot TEXT,
      published_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS imaginative_dreams_agent_recent
      ON imaginative_dreams(agent_id, created_at DESC);


    CREATE TABLE IF NOT EXISTS awakening_contexts (
      agent_id TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      cognition_version INTEGER NOT NULL,
      summary TEXT NOT NULL,
      source_refs_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (agent_id, scope_id)
    );
  `);
}

/** @param {import("node:sqlite").DatabaseSync} db */
export function upgradeDreamProvenance(db) {
  // Remove views referencing the old tables before replacing them in this transaction.
  for (const name of [
    "purge_apply",
    "diary_revision_delete",
    "event_delete",
    "diary_delete",
    "correction_delete",
    "cognition_delete",
  ])
    db.exec("DROP TRIGGER IF EXISTS dream_privacy_" + name);
  db.exec(
    "DROP VIEW IF EXISTS dream_privacy_purge; DROP VIEW IF EXISTS dream_source_dependencies; DROP VIEW IF EXISTS dream_event_parents",
  );
  const hasColumn = (
    /** @type {string} */ table,
    /** @type {string} */ column,
  ) =>
    db
      .prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name=?`)
      .get(table, column);
  for (const [table, partition, definition, columns] of [
    [
      "diary_revisions",
      "diaries",
      "id TEXT NOT NULL REFERENCES diaries(id),revision INTEGER NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,metadata TEXT NOT NULL,written_at TEXT NOT NULL,UNIQUE(id,revision)",
      "id,revision,title,body,metadata,written_at",
    ],
    [
      "memory_corrections",
      "corrections",
      "agent_id TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,UNIQUE(agent_id,id)",
      "agent_id,id,value",
    ],
  ]) {
    if (hasColumn(table, "seq")) continue;
    db.exec(`CREATE TABLE ${table}_new(seq INTEGER PRIMARY KEY AUTOINCREMENT,${definition});
      INSERT INTO ${table}_new SELECT rowid,${columns} FROM ${table};
      DROP TABLE ${table}; ALTER TABLE ${table}_new RENAME TO ${table};`);
    // A previous deletion may already have left a consumed position above MAX(rowid).
    db.prepare(
      "UPDATE sqlite_sequence SET seq=max(seq,coalesce((SELECT max(last_event_seq) FROM dream_checkpoints WHERE source_partition=?),0)) WHERE name=?",
    ).run(partition, table);
  }
  if (!hasColumn("cognition_evidence", "source_revision")) {
    db.exec(
      "ALTER TABLE cognition_evidence RENAME TO legacy_cognition_evidence; DROP INDEX cognition_evidence_source",
    );
    initializeDreamTables(db);
    db.exec(
      "INSERT INTO cognition_evidence SELECT *,0 FROM legacy_cognition_evidence; DROP TABLE legacy_cognition_evidence",
    );
  }
}

// Role exports preserve source order and translate SQLite rowids into positions.
export const DREAM_PORTABLE_CURSOR = "role-source-position-v1";

/** @param {import("node:sqlite").DatabaseSync} db @param {any} row */
export function exportDreamCheckpoint(db, row) {
  const partition = row.source_partition;
  if (partition !== "diaries" && partition !== "corrections") return row;
  const from =
    partition === "diaries"
      ? "diary_revisions r JOIN diaries d ON d.id=r.id WHERE d.agent_id=?"
      : "memory_corrections r WHERE r.agent_id=?";
  return {
    ...row,
    last_event_seq: Number(
      db
        .prepare(`SELECT count(*) AS n FROM ${from} AND r.rowid<=?`)
        .get(row.agent_id, row.last_event_seq)?.n,
    ),
    last_cursor_token: DREAM_PORTABLE_CURSOR,
  };
}
