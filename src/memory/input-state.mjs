// @ts-check
import { createHash } from "node:crypto";
import { messageNamespace } from "./message-ids.mjs";

export const INPUT_SCHEMA_VERSION = 8;
export const INPUT_VERSION_ALGORITHM = "1";
export const INPUT_EVENT_KINDS =
  "('message.received','message.recalled','notice.file','notice.poke','voice.transcript')";
/** @typedef {import("node:sqlite").DatabaseSync} DB */
/** @typedef {import("node:sqlite").StatementSync} Statement */
/** @typedef {import("./store.mjs").MemoryStore} MemoryStore */
/** @typedef {{id:string,agent_id:string,connection_id:string,conversation:string,kind:string,origin:string,direction:string,status:string,sender_id:string|null,message_id:string|null,body:string,payload:string,seq:number}} EventRow */
/** @typedef {EventRow & {legacy_version?:string,legacy_gap?:number,dirty_id?:string}} DirtyEvent */
/** @typedef {EventRow & {version:string,revision:number}} InputRow */
/** @typedef {{scope:string,revision:number,closed_through:number,processed_through:number,history_required:number}} ScopeRow */
/** @typedef {{closed_through:number|null,processed_through:number,historical_through:number,source:string,confirmed_scope:string|null}} LegacyRow */
/** @typedef {{id:string,version:string,seq:number,request_seen:number}} VersionRow */
/** @typedef {{id:string,version:string}} Ref */
/** @type {WeakMap<DB,Map<string,Statement>>} */
const statements = new WeakMap();

/** @param {DB} db @param {string} sql */
function prepare(db, sql) {
  let cache = statements.get(db);
  if (!cache) statements.set(db, (cache = new Map()));
  let statement = cache.get(sql);
  if (!statement) cache.set(sql, (statement = db.prepare(sql)));
  return statement;
}

/** @param {EventRow} row */
export function semanticInputVersion(row) {
  const payload = JSON.parse(row.payload);
  const stableSegments = (payload.segments || []).map(
    (
      /** @type {{type:string,data:Record<string,unknown>}} */ { type, data },
    ) => [
      type,
      type === "text"
        ? data?.text
        : type === "at"
          ? data?.qq
          : type === "reply" || type === "face" || type === "forward"
            ? data?.id
            : (data?.file_id ?? data?.file ?? data?.id ?? data?.url),
    ],
  );
  const raw = payload.raw;
  const file = raw?.file;
  const semantic = [
    row.kind,
    row.status,
    row.sender_id,
    row.message_id,
    row.body,
    stableSegments,
    payload.sourceEventId,
    raw?.target_id == null ? null : String(raw.target_id),
    file ? [file.id, file.name, file.size] : null,
  ];
  return (
    INPUT_VERSION_ALGORITHM +
    ":" +
    createHash("sha256").update(JSON.stringify(semantic)).digest("hex")
  );
}

/** @param {import("../core/runtime.mjs").Runtime} runtime @param {{agentId:string,conversation:string}} ctx */
export function inputScope(runtime, ctx) {
  const agent = runtime.agent(ctx.agentId);
  const connection = runtime.connection(agent.connectionId);
  return JSON.stringify([
    agent.id,
    agent.connectionId,
    connection.accountId,
    ctx.conversation,
    connection.messageIdNamespace || "onebot",
  ]);
}

/** @param {{accountId?:string|number,raw?:{self_id?:string|number}}} payload */
function accountOf(payload) {
  const account = payload.accountId ?? payload.raw?.self_id;
  return account == null ? null : String(account);
}

/** @param {EventRow} row @param {string[]} parts @param {DB} db @returns {boolean} */
export function inputBelongsToScope(row, parts, db) {
  const [agentId, connectionId, accountId, conversation, namespace] = parts;
  if (
    row.agent_id !== agentId ||
    row.connection_id !== connectionId ||
    row.conversation !== conversation ||
    row.origin !== "live"
  )
    return false;
  const payload = JSON.parse(row.payload);
  const account = accountOf(payload);
  if (account !== null && account !== accountId) return false;
  if (row.kind === "voice.transcript") {
    if (
      row.direction !== "internal" ||
      typeof payload.sourceEventId !== "string"
    )
      return false;
    const source = /** @type {EventRow|undefined} */ (
      prepare(
        db,
        "SELECT * FROM events WHERE id=? AND kind='message.received'",
      ).get(payload.sourceEventId)
    );
    return (
      !!source &&
      source.seq < row.seq &&
      source.sender_id === row.sender_id &&
      inputBelongsToScope(source, parts, db)
    );
  }
  if (
    row.direction !== "in" ||
    payload.trustedInput !== true ||
    messageNamespace(row) !== namespace
  )
    return false;
  if (row.kind === "message.recalled") return true;
  if (row.kind === "notice.poke")
    return String(payload.raw?.target_id) === accountId;
  return (
    ["message.received", "notice.file"].includes(row.kind) &&
    row.sender_id !== accountId
  );
}

/** @param {DB} db */
export function initializeInputTables(db) {
  db.exec(`
    DROP TRIGGER IF EXISTS event_presentation_changed;
    CREATE TABLE IF NOT EXISTS input_legacy_scopes(
      agent_id TEXT NOT NULL, conversation TEXT NOT NULL,
      closed_through INTEGER, processed_through INTEGER NOT NULL,
      historical_through INTEGER NOT NULL, source TEXT NOT NULL, confirmed_scope TEXT,
      PRIMARY KEY(agent_id,conversation)
    );
    CREATE TABLE IF NOT EXISTS input_legacy_refs(
      id TEXT PRIMARY KEY, version TEXT NOT NULL, source TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS input_scopes(
      scope TEXT PRIMARY KEY, agent_id TEXT NOT NULL, conversation TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      closed_through INTEGER NOT NULL, processed_through INTEGER NOT NULL,
      history_required INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS input_scopes_chat ON input_scopes(agent_id,conversation);
    CREATE TABLE IF NOT EXISTS input_versions(
      scope TEXT NOT NULL, agent_id TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL,
      version TEXT NOT NULL, kind TEXT NOT NULL, revision INTEGER NOT NULL,
      current INTEGER NOT NULL, processed INTEGER NOT NULL DEFAULT 0,
      no_reply_turn TEXT, reviewed_deliveries TEXT NOT NULL DEFAULT '[]',
      legacy_closed INTEGER NOT NULL DEFAULT 0, legacy_processed INTEGER NOT NULL DEFAULT 0,
      legacy_gap INTEGER NOT NULL DEFAULT 0, original INTEGER NOT NULL,
      request_seen INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(scope,id,version)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS input_current ON input_versions(scope,id) WHERE current=1;
    CREATE INDEX IF NOT EXISTS input_processing ON input_versions(scope,seq)
      WHERE current=1 AND processed=0 AND legacy_processed=0;
    CREATE INDEX IF NOT EXISTS input_review_pending ON input_versions(scope,seq)
      WHERE current=1 AND legacy_closed=0 AND no_reply_turn IS NULL AND json_array_length(reviewed_deliveries)=0;
    CREATE INDEX IF NOT EXISTS input_no_reply ON input_versions(scope,no_reply_turn,seq)
      WHERE current=1 AND no_reply_turn IS NOT NULL;
    CREATE INDEX IF NOT EXISTS input_revisions ON input_versions(scope,revision) WHERE current=1;
    CREATE TABLE IF NOT EXISTS input_dirty(
      agent_id TEXT NOT NULL, conversation TEXT NOT NULL, id TEXT NOT NULL,
      PRIMARY KEY(agent_id,conversation,id)
    );
    CREATE INDEX IF NOT EXISTS input_transcript_source ON events(json_extract(payload,'$.sourceEventId'))
      WHERE kind='voice.transcript';
    CREATE TRIGGER IF NOT EXISTS input_inserted AFTER INSERT ON events
    WHEN NEW.kind IN ${INPUT_EVENT_KINDS} BEGIN
      INSERT OR IGNORE INTO input_dirty VALUES(NEW.agent_id,NEW.conversation,NEW.id);
    END;
    CREATE TRIGGER IF NOT EXISTS input_changed
    AFTER UPDATE OF agent_id,conversation,kind,connection_id,direction,origin,status,sender_id,message_id,body,payload ON events
    WHEN NEW.kind IN ${INPUT_EVENT_KINDS} OR OLD.kind IN ${INPUT_EVENT_KINDS} BEGIN
      INSERT OR IGNORE INTO input_dirty VALUES(OLD.agent_id,OLD.conversation,OLD.id);
      INSERT OR IGNORE INTO input_dirty VALUES(NEW.agent_id,NEW.conversation,NEW.id);
      INSERT OR IGNORE INTO input_dirty
        SELECT agent_id,conversation,id FROM events WHERE kind='voice.transcript'
        AND json_extract(payload,'$.sourceEventId')=OLD.id;
    END;
    CREATE TRIGGER IF NOT EXISTS input_removed AFTER DELETE ON events
    WHEN OLD.kind IN ${INPUT_EVENT_KINDS} BEGIN
      INSERT OR IGNORE INTO input_dirty VALUES(OLD.agent_id,OLD.conversation,OLD.id);
      INSERT OR IGNORE INTO input_dirty
        SELECT agent_id,conversation,id FROM events WHERE kind='voice.transcript'
        AND json_extract(payload,'$.sourceEventId')=OLD.id;
    END;
  `);
}

/** @param {DB} db @param {string|null} [agentId] @param {"local"|"import"} [source] */
export function migrateInputBaselines(db, agentId = null, source = "local") {
  db.prepare(
    `
    INSERT INTO input_legacy_scopes
    SELECT e.agent_id,e.conversation,
      CASE WHEN ?<>'local' THEN NULL
           WHEN json_type(r.value,'$.inputReviewFromSeq') IS NOT NULL OR json_type(r.value,'$.inputReviewThroughSeq') IS NOT NULL
             THEN MAX(COALESCE(json_extract(r.value,'$.inputReviewFromSeq'),0),COALESCE(json_extract(r.value,'$.inputReviewThroughSeq'),0))
           ELSE json_extract(r.value,'$.readThroughSeq') END,
      CASE WHEN ?='local' THEN COALESCE(json_extract(r.value,'$.readThroughSeq'),0) ELSE 0 END,MAX(e.seq),?,NULL
    FROM events e LEFT JOIN runtime r USING(agent_id,conversation)
    WHERE (? IS NULL OR e.agent_id=?) AND e.origin='live'
      AND (e.kind='voice.transcript' OR (
        e.direction='in' AND e.kind IN ${INPUT_EVENT_KINDS}
        AND json_extract(e.payload,'$.trustedInput')=1
      ))
      AND (e.conversation GLOB 'group:*' OR e.conversation GLOB 'private:*')
    GROUP BY e.agent_id,e.conversation
    ON CONFLICT(agent_id,conversation) DO NOTHING
  `,
  ).run(source, source, source, agentId, agentId);
  const rows = /** @type {Iterable<EventRow>} */ (
    db
      .prepare(
        `
    SELECT e.* FROM input_legacy_scopes l JOIN events e USING(agent_id,conversation)
    WHERE (? IS NULL OR l.agent_id=?) AND e.seq<=l.historical_through
      AND e.origin='live' AND e.kind IN ${INPUT_EVENT_KINDS}
  `,
      )
      .iterate(agentId, agentId)
  );
  const save = db.prepare(
    "INSERT OR IGNORE INTO input_legacy_refs VALUES(?,?,?)",
  );
  const bindings = new Map();
  const binding = db.prepare(
    "SELECT value FROM runtime WHERE agent_id=? AND conversation='@migration-binding'",
  );
  /** @type {Map<string,Set<string|null>>} */
  const sourceScopes = new Map();
  for (const row of rows) {
    save.run(row.id, semanticInputVersion(row), source);
    if (
      source !== "local" ||
      row.kind === "voice.transcript" ||
      row.direction !== "in"
    )
      continue;
    const payload = JSON.parse(row.payload);
    if (payload.trustedInput !== true) continue;
    if (!bindings.has(row.agent_id)) {
      const prior = binding.get(row.agent_id);
      bindings.set(
        row.agent_id,
        prior ? JSON.parse(String(prior.value)) : null,
      );
    }
    const bound = bindings.get(row.agent_id);
    const account =
      accountOf(payload) ??
      (bound?.connectionId === row.connection_id ? bound.accountId : null);
    const key = JSON.stringify([row.agent_id, row.conversation]);
    let scopes = sourceScopes.get(key);
    if (!scopes) sourceScopes.set(key, (scopes = new Set()));
    const scope =
      row.connection_id && account
        ? JSON.stringify([
            row.agent_id,
            row.connection_id,
            account,
            row.conversation,
            messageNamespace(row),
          ])
        : null;
    scopes.add(scope);
  }
  if (source === "local") {
    const approve = db.prepare(
      "UPDATE input_legacy_scopes SET confirmed_scope=? WHERE agent_id=? AND conversation=? AND source='local' AND confirmed_scope IS NULL",
    );
    const require = db.prepare(
      "UPDATE input_legacy_scopes SET closed_through=NULL,processed_through=0 WHERE agent_id=? AND conversation=? AND source='local' AND confirmed_scope IS NULL",
    );
    for (const [key, scopes] of sourceScopes) {
      const parts = JSON.parse(key);
      const [scope] = scopes;
      if (scopes.size === 1 && scope) approve.run(scope, ...parts);
      else require.run(...parts);
    }
  }
}

/** @param {DB} db @param {string} scope @param {DirtyEvent|null} row @param {string} id @param {LegacyRow|null} history */
function change(db, scope, row, id, history) {
  const old = /** @type {VersionRow|undefined} */ (
    prepare(
      db,
      "SELECT * FROM input_versions WHERE scope=? AND id=? AND current=1",
    ).get(scope, id)
  );
  const version = row && semanticInputVersion(row);
  if ((old?.version ?? null) === (version ?? null)) return;
  const updated = prepare(
    db,
    "UPDATE input_scopes SET revision=revision+1 WHERE scope=? RETURNING revision",
  ).get(scope);
  if (!updated) throw Error("INPUT_SCOPE_MISSING");
  if (old)
    prepare(
      db,
      "UPDATE input_versions SET current=0 WHERE scope=? AND id=? AND current=1",
    ).run(scope, id);
  if (!row) return;
  prepare(
    db,
    `
    INSERT INTO input_versions(scope,agent_id,id,seq,version,kind,revision,current,legacy_closed,legacy_processed,legacy_gap,original,request_seen)
    VALUES(?,?,?,?,?,?,?,1,?,?,?,?,?)
    ON CONFLICT(scope,id,version) DO UPDATE SET current=1,revision=excluded.revision
  `,
  ).run(
    scope,
    row.agent_id,
    id,
    row.seq,
    version,
    row.kind,
    updated.revision,
    history &&
      history.closed_through !== null &&
      row.seq <= history.closed_through &&
      !row.legacy_gap
      ? 1
      : 0,
    history && row.seq <= history.processed_through && !row.legacy_gap ? 1 : 0,
    history && row.legacy_gap ? 1 : 0,
    old ? 0 : 1,
    isHistoricalInput(db, id) ? 1 : 0,
  );
}

/** @param {{db:DB,store:MemoryStore}} memory @param {string} scope */
export function refreshInput(memory, scope) {
  const db = memory.db;
  const parts = JSON.parse(scope);
  const [agentId, connectionId, , conversation] = parts;
  const refresh = () => {
    let state = scopeState(db, scope);
    if (!state) {
      const legacy = /** @type {LegacyRow|undefined} */ (
        prepare(
          db,
          "SELECT * FROM input_legacy_scopes WHERE agent_id=? AND conversation=?",
        ).get(agentId, conversation)
      );
      const history = legacy
        ? {
            ...legacy,
            closed_through:
              legacy.confirmed_scope === scope ? legacy.closed_through : null,
            processed_through:
              legacy.confirmed_scope === scope ? legacy.processed_through : 0,
          }
        : null;
      prepare(
        db,
        "INSERT INTO input_scopes(scope,agent_id,conversation,closed_through,processed_through,history_required) VALUES(?,?,?,?,?,?)",
      ).run(
        scope,
        agentId,
        conversation,
        history?.closed_through ?? 0,
        history?.processed_through ?? 0,
        history && history.closed_through == null ? 1 : 0,
      );
      const rows = /** @type {Iterable<DirtyEvent>} */ (
        prepare(
          db,
          `
        SELECT e.*,l.version AS legacy_version,COALESCE(p.summary_only,0) AS legacy_gap FROM events e
        LEFT JOIN input_legacy_refs l USING(id)
        LEFT JOIN message_progress p USING(agent_id,conversation,seq)
        WHERE e.agent_id=? AND e.connection_id=? AND e.conversation=? AND e.kind IN ${INPUT_EVENT_KINDS} ORDER BY e.seq
      `,
        ).iterate(agentId, connectionId, conversation)
      );
      for (const row of rows)
        if (inputBelongsToScope(row, parts, db))
          change(
            db,
            scope,
            row,
            row.id,
            history && row.legacy_version === semanticInputVersion(row)
              ? history
              : null,
          );
      state = scopeState(db, scope);
    }
    const dirty = /** @type {(DirtyEvent & {dirty_id:string})[]} */ (
      prepare(
        db,
        `
      SELECT d.id AS dirty_id,e.* FROM input_dirty d LEFT JOIN events e ON e.id=d.id
      WHERE d.agent_id=? AND d.conversation=?
    `,
      ).all(agentId, conversation)
    );
    if (!dirty.length) return state;
    const scopes = prepare(
      db,
      "SELECT scope FROM input_scopes WHERE agent_id=? AND conversation=?",
    ).all(agentId, conversation);
    for (const { scope: key } of scopes) {
      const bound = JSON.parse(String(key));
      for (const row of dirty)
        change(
          db,
          String(key),
          row.id && inputBelongsToScope(row, bound, db) ? row : null,
          row.dirty_id,
          null,
        );
    }
    prepare(
      db,
      "DELETE FROM input_dirty WHERE agent_id=? AND conversation=?",
    ).run(agentId, conversation);
    return scopeState(db, scope);
  };
  if (db.isTransaction) {
    const current = refresh();
    if (!current) throw Error("INPUT_SCOPE_MISSING");
    return current;
  }
  const state = scopeState(db, scope);
  const dirty = prepare(
    db,
    "SELECT 1 FROM input_dirty WHERE agent_id=? AND conversation=? LIMIT 1",
  ).get(agentId, conversation);
  const current = state && !dirty ? state : memory.store.transaction(refresh);
  if (!current) throw Error("INPUT_SCOPE_MISSING");
  return current;
}

/** @param {DB} db @param {string} scope */
function scopeState(db, scope) {
  return /** @type {ScopeRow|undefined} */ (
    prepare(db, "SELECT * FROM input_scopes WHERE scope=?").get(scope)
  );
}

/** @param {DB} db @param {string} scope @param {string} id */
export function findInput(db, scope, id) {
  return /** @type {VersionRow|undefined} */ (
    prepare(
      db,
      "SELECT * FROM input_versions WHERE scope=? AND id=? AND current=1",
    ).get(scope, id)
  );
}

/** @param {DB} db @param {string} id */
export function isLogicalImportInput(db, id) {
  return !!prepare(
    db,
    "SELECT 1 FROM input_legacy_refs WHERE id=? AND source='import'",
  ).get(id);
}

/** @param {DB} db @param {string} id */
export function isHistoricalInput(db, id) {
  return !!prepare(db, "SELECT 1 FROM input_legacy_refs WHERE id=?").get(id);
}

/** @param {DB} db @param {string} scope @param {number} [through] @returns {Iterable<InputRow>} */
export function processingInputRows(
  db,
  scope,
  through = Number.MAX_SAFE_INTEGER,
) {
  return /** @type {Iterable<InputRow>} */ (
    prepare(
      db,
      `
    SELECT e.*,v.version,v.revision FROM input_versions v JOIN events e ON e.id=v.id
    WHERE v.scope=? AND v.current=1 AND v.processed=0 AND v.legacy_processed=0 AND v.seq<=?
    ORDER BY v.seq
  `,
    ).iterate(scope, through)
  );
}

/** @param {DB} db @param {string} scope @param {string[]} keep @param {string} currentTurn @param {number} [since] */
export function reviewInputRows(
  db,
  scope,
  keep,
  currentTurn,
  since = Number.MAX_SAFE_INTEGER,
) {
  return /** @type {InputRow[]} */ (
    prepare(
      db,
      `
    SELECT e.*,v.version,v.revision FROM input_versions v JOIN events e ON e.id=v.id
    WHERE v.scope=? AND v.current=1 AND v.legacy_closed=0 AND json_array_length(v.reviewed_deliveries)=0
      AND v.no_reply_turn IS NULL
    UNION
    SELECT e.*,v.version,v.revision FROM input_versions v JOIN events e ON e.id=v.id
    WHERE v.scope=? AND v.current=1 AND v.no_reply_turn=? AND v.legacy_closed=0
      AND json_array_length(v.reviewed_deliveries)=0
    UNION
    SELECT e.*,v.version,v.revision FROM json_each(?) k
    CROSS JOIN input_versions v INDEXED BY input_current ON v.id=k.value
    JOIN events e ON e.id=v.id
    WHERE v.scope=? AND v.current=1
    UNION
    SELECT e.*,v.version,v.revision FROM input_versions v JOIN events e ON e.id=v.id
    WHERE v.scope=? AND v.current=1 AND v.revision>?
    ORDER BY seq
  `,
    ).all(scope, scope, currentTurn, JSON.stringify(keep), scope, scope, since)
  );
}

/** @param {DB} db @param {string} scope @param {Ref} ref @param {string|null} [noReplyTurn] */
export function writeProcessed(db, scope, { id, version }, noReplyTurn = null) {
  return prepare(
    db,
    `
    UPDATE input_versions SET processed=1,no_reply_turn=COALESCE(?,no_reply_turn)
    WHERE scope=? AND id=? AND version=? AND current=1
  `,
  ).run(noReplyTurn, scope, id, version);
}

/** @param {DB} db @param {string} scope @param {Ref} ref */
export function admitRequest(db, scope, { id, version }) {
  return prepare(
    db,
    `
    UPDATE input_versions SET request_seen=1
    WHERE scope=? AND id=? AND version=? AND current=1 AND request_seen=0
  `,
  ).run(scope, id, version).changes;
}

/** @param {DB} db @param {string} scope @param {string} deliveryId @param {Ref} ref */
export function writeReviewed(db, scope, deliveryId, { id, version }) {
  prepare(
    db,
    `
    UPDATE input_versions SET reviewed_deliveries=json_insert(reviewed_deliveries,'$[#]',?)
    WHERE scope=? AND id=? AND version=? AND NOT EXISTS(
      SELECT 1 FROM json_each(reviewed_deliveries) WHERE value=?
    )
  `,
  ).run(deliveryId, scope, id, version, deliveryId);
}

/** @param {DB} db @param {string} scope @param {Ref} ref */
export function readInputDisposition(db, scope, { id, version }) {
  const row = prepare(
    db,
    "SELECT processed,no_reply_turn,reviewed_deliveries FROM input_versions WHERE scope=? AND id=? AND version=?",
  ).get(scope, id, version);
  return (
    row && {
      processed: !!row.processed,
      noReply: row.no_reply_turn !== null,
      deliveryIds: JSON.parse(String(row.reviewed_deliveries)),
    }
  );
}

/** @param {DB} db @param {string} scope @param {{historicalThrough:number,closedThrough:number,manifestDigest:string}} approval */
export function confirmInputBaseline(
  db,
  scope,
  { historicalThrough, closedThrough, manifestDigest },
) {
  if (!db.isTransaction) throw Error("INPUT_BASELINE_TRANSACTION_REQUIRED");
  const [agentId, , , conversation] = JSON.parse(scope);
  const prior = prepare(
    db,
    "SELECT * FROM input_legacy_scopes WHERE agent_id=? AND conversation=?",
  ).get(agentId, conversation);
  if (
    !prior ||
    historicalThrough !== prior.historical_through ||
    (prior.closed_through !== null && prior.confirmed_scope === scope) ||
    !Number.isSafeInteger(closedThrough) ||
    closedThrough < 0 ||
    closedThrough > historicalThrough ||
    !/^[a-f0-9]{64}$/.test(manifestDigest)
  )
    throw Error("INPUT_BASELINE_CHANGED");
  prepare(
    db,
    `
    UPDATE input_legacy_scopes SET closed_through=?,
      processed_through=CASE WHEN confirmed_scope=? THEN processed_through ELSE 0 END,
      confirmed_scope=?,source=?
    WHERE agent_id=? AND conversation=?
  `,
  ).run(
    closedThrough,
    scope,
    scope,
    "operator-confirmed:" + manifestDigest,
    agentId,
    conversation,
  );
  prepare(
    db,
    "UPDATE input_scopes SET closed_through=?,history_required=0 WHERE scope=?",
  ).run(closedThrough, scope);
  prepare(
    db,
    `
    UPDATE input_versions SET legacy_closed=1 WHERE scope=? AND current=1 AND original=1
      AND legacy_gap=0 AND seq<=? AND EXISTS (
        SELECT 1 FROM input_legacy_refs l WHERE l.id=input_versions.id AND l.version=input_versions.version
      )
  `,
  ).run(scope, closedThrough);
}
