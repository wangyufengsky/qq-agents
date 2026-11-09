import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { validateConfig } from "../src/core/config.mjs";
import { acquireProcessLock } from "../src/core/process-lifecycle.mjs";
import {
  confirmInputBaseline,
  INPUT_EVENT_KINDS,
  INPUT_SCHEMA_VERSION,
  INPUT_VERSION_ALGORITHM,
  inputBelongsToScope,
  semanticInputVersion,
} from "../src/memory/input-state.mjs";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    data: { type: "string" },
    manifest: { type: "string" },
    confirm: { type: "string" },
  },
});
const [action] = positionals;
if (
  positionals.length !== 1 ||
  !["preview", "apply"].includes(action) ||
  !values.data ||
  !values.manifest ||
  (action === "apply" ? !values.confirm : values.confirm)
)
  throw Error(
    "Usage: input-state-preflight.mjs preview --data DATA --manifest NEW_JSON | apply --data STOPPED_DATA --manifest JSON --confirm APPROVAL_JSON",
  );

const root = fs.realpathSync(values.data);
const database = path.join(root, "memory.sqlite");
if (!fs.lstatSync(database).isFile())
  throw Error("INPUT_BASELINE_DATABASE_REQUIRED");
const readJSON = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const lock = action === "apply" ? acquireProcessLock(root) : null;

function hashJSON(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function configuredScopes() {
  let config;
  try {
    config = validateConfig(readJSON(path.join(root, "config.json")));
  } catch {
    throw Error("INPUT_BASELINE_CONFIG_INVALID");
  }
  return new Map(
    config.agents.map(({ id, connectionId }) => {
      const c = config.connections.find((item) => item.id === connectionId);
      return [
        id,
        [id, connectionId, c.accountId, c.messageIdNamespace || "onebot"],
      ];
    }),
  );
}

function scopeFor(scopes, row) {
  const identity = scopes.get(row.agent_id);
  if (!identity) return null;
  const [agent, connection, account, namespace] = identity;
  return [agent, connection, account, row.conversation, namespace];
}

function legacyRows(db) {
  return db
    .prepare("SELECT * FROM input_legacy_scopes ORDER BY agent_id,conversation")
    .all();
}

function needsConfirmation(db, legacy, parts) {
  if (!parts || legacy.closed_through === null) return true;
  const key = JSON.stringify(parts);
  const state = db
    .prepare("SELECT history_required FROM input_scopes WHERE scope=?")
    .get(key);
  return (
    Boolean(state?.history_required) ||
    (legacy.confirmed_scope !== null && legacy.confirmed_scope !== key)
  );
}

function inspectHistory(db, legacy, parts, choice = 0) {
  const key = JSON.stringify(parts);
  const [agent, connection, , conversation] = parts;
  const hash = createHash("sha256");
  let historicalInputs = 0,
    legacyGaps = 0,
    explicitUnresolved = 0,
    lastInputSeq = 0;
  let choiceInScope = choice === 0;
  for (const row of db
    .prepare(
      `
    SELECT e.*, max(coalesce(p.summary_only,0),coalesce(v.legacy_gap,0)) AS gap,
      l.version AS legacy_version,v.original,v.processed,v.legacy_processed,v.no_reply_turn,v.reviewed_deliveries
    FROM events e LEFT JOIN message_progress p USING(agent_id,conversation,seq)
    LEFT JOIN input_legacy_refs l ON l.id=e.id
    LEFT JOIN input_versions v ON v.scope=? AND v.id=e.id AND v.current=1
    WHERE e.agent_id=? AND e.connection_id=? AND e.conversation=? AND e.seq<=?
      AND e.kind IN ${INPUT_EVENT_KINDS} ORDER BY e.seq
  `,
    )
    .iterate(key, agent, connection, conversation, legacy.historical_through)) {
    if (!inputBelongsToScope(row, parts, db)) continue;
    historicalInputs++;
    lastInputSeq = row.seq;
    if (row.seq === choice) choiceInScope = true;
    const version = semanticInputVersion(row);
    if (row.gap) legacyGaps++;
    if (row.gap || row.original === 0 || row.legacy_version !== version)
      explicitUnresolved++;
    hash.update(
      JSON.stringify([
        row.id,
        row.seq,
        version,
        row.legacy_version,
        row.gap,
        row.original,
        row.processed,
        row.legacy_processed,
        row.no_reply_turn,
        row.reviewed_deliveries,
      ]) + "\n",
    );
  }
  return {
    historicalInputs,
    legacyGaps,
    explicitUnresolved,
    lastInputSeq,
    choiceInScope,
    fingerprint: hashJSON([parts, legacy, hash.digest("hex")]),
  };
}

function counts(db, parts) {
  const args = parts.slice(0, 4);
  const openDrafts = db
    .prepare(
      `
    SELECT count(*) AS n FROM qq_drafts g WHERE
      g.agent_id=? AND g.connection_id=? AND g.account_id=? AND g.conversation=?
      AND EXISTS(SELECT 1 FROM qq_draft_items i
        LEFT JOIN deliveries d ON d.agent_id=i.agent_id AND d.request_id=i.delivery_request_id
        WHERE i.draft_id=g.id AND (
          (i.delivery_request_id IS NOT NULL AND (d.status IS NULL OR d.status IN ('pending','unknown'))) OR
          (i.delivery_request_id IS NULL AND i.abandoned=0 AND g.imported=0 AND g.expires_at>?)
        ))
  `,
    )
    .get(...args, Date.now()).n;
  const unknownDeliveries = db
    .prepare(
      `
    SELECT count(*) AS n FROM deliveries d JOIN events e
      ON e.agent_id=d.agent_id AND e.dedupe='send:'||d.request_id||':pending'
    WHERE e.agent_id=? AND e.connection_id=? AND e.sender_id=? AND e.conversation=?
      AND d.conversation=e.conversation AND d.status='unknown'
  `,
    )
    .get(...args).n;
  return { openDrafts, unknownDeliveries };
}

function preview(db, scopes) {
  const rows = legacyRows(db).map((legacy) => {
    const scope = scopeFor(scopes, legacy);
    const required = needsConfirmation(db, legacy, scope);
    const base = {
      agentId: legacy.agent_id,
      conversation: legacy.conversation,
      scope,
      source: legacy.source,
      candidateClosedThrough: required ? null : legacy.closed_through,
      historicalThrough: legacy.historical_through,
      needsConfirmation: required,
    };
    if (!scope) return { ...base, reason: "scope_unbound" };
    const { choiceInScope: _, ...history } = inspectHistory(db, legacy, scope);
    return { ...base, ...history, ...counts(db, scope) };
  });
  const body = {
    version: 1,
    schema: INPUT_SCHEMA_VERSION,
    algorithm: INPUT_VERSION_ALGORITHM,
    scopes: rows,
  };
  return { ...body, digest: hashJSON(body) };
}

function apply(db, scopes, manifest, approval) {
  const { digest, ...body } = manifest;
  if (
    manifest.version !== 1 ||
    manifest.schema !== INPUT_SCHEMA_VERSION ||
    manifest.algorithm !== INPUT_VERSION_ALGORITHM ||
    !Array.isArray(manifest.scopes) ||
    digest !== hashJSON(body) ||
    approval.manifestDigest !== digest ||
    !Array.isArray(approval.choices) ||
    (approval.allowPartial !== undefined &&
      typeof approval.allowPartial !== "boolean")
  )
    throw Error("INPUT_BASELINE_MANIFEST_INVALID");

  const listed = new Map(
    manifest.scopes
      .filter((row) => row.scope)
      .map((row) => [JSON.stringify(row.scope), row]),
  );
  const current = new Map();
  let unbound = 0;
  for (const row of legacyRows(db)) {
    const scope = scopeFor(scopes, row);
    if (scope) current.set(JSON.stringify(scope), row);
    else unbound++;
  }

  const selected = new Set();
  for (const choice of approval.choices) {
    const key = JSON.stringify(choice.scope);
    const old = listed.get(key);
    const row = current.get(key);
    if (
      selected.has(key) ||
      !old?.needsConfirmation ||
      !row ||
      !needsConfirmation(db, row, choice.scope) ||
      !Number.isSafeInteger(choice.closedThrough) ||
      choice.closedThrough < 0 ||
      typeof choice.reason !== "string" ||
      !choice.reason.trim()
    )
      throw Error("INPUT_BASELINE_CHOICE_INVALID");
    if (row.historical_through < old.historicalThrough)
      throw Error("INPUT_BASELINE_STALE");
    const history = inspectHistory(
      db,
      { ...row, historical_through: old.historicalThrough },
      choice.scope,
      choice.closedThrough,
    );
    if (history.fingerprint !== old.fingerprint)
      throw Error("INPUT_BASELINE_STALE");
    if (!history.choiceInScope) throw Error("INPUT_BASELINE_CHOICE_INVALID");
    selected.add(key);
  }
  const outstanding =
    unbound +
    [...current].filter(
      ([key, row]) =>
        !selected.has(key) && needsConfirmation(db, row, JSON.parse(key)),
    ).length;
  if (outstanding && approval.allowPartial !== true)
    throw Error("INPUT_BASELINE_SELECTION_REQUIRED");
  for (const choice of approval.choices) {
    const row = current.get(JSON.stringify(choice.scope));
    confirmInputBaseline(db, JSON.stringify(choice.scope), {
      historicalThrough: row.historical_through,
      closedThrough: choice.closedThrough,
      manifestDigest: digest,
    });
  }
  return { applied: selected.size, outstanding, manifestDigest: digest };
}

let db;
try {
  const scopes = configuredScopes();
  db = new DatabaseSync(database, { readOnly: action === "preview" });
  if (
    db.prepare("PRAGMA user_version").get().user_version !==
    INPUT_SCHEMA_VERSION
  )
    throw Error("INPUT_BASELINE_UPGRADED_COPY_REQUIRED");
  db.exec(
    action === "preview"
      ? "BEGIN"
      : "PRAGMA busy_timeout=5000; BEGIN IMMEDIATE",
  );
  const result =
    action === "preview"
      ? preview(db, scopes)
      : apply(db, scopes, readJSON(values.manifest), readJSON(values.confirm));
  db.exec("COMMIT");
  if (action === "preview")
    fs.writeFileSync(values.manifest, JSON.stringify(result, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
  console.log(
    JSON.stringify(
      action === "preview"
        ? {
            scopes: result.scopes.length,
            needsConfirmation: result.scopes.filter(
              (row) => row.needsConfirmation,
            ).length,
            manifestDigest: result.digest,
          }
        : result,
    ),
  );
} finally {
  db?.close();
  lock?.release();
}
