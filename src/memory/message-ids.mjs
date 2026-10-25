import fs from "node:fs";
import { createHash } from "node:crypto";

const kinds =
  "('message.received','message.sent','legacy.message-observation')";
const namespaceSql = (e) =>
  `COALESCE(json_extract(${e}.payload,'$.messageNamespace'),CASE WHEN ${e}.kind='legacy.message-observation' THEN 'archive' ELSE 'onebot' END)`;
export const referenceNamespaceSql = (e) =>
  `COALESCE(json_extract(${e}.payload,'$.referenceNamespace'),json_extract(${e}.payload,'$.messageNamespace'),CASE WHEN ${e}.kind='legacy.message-observation' THEN 'archive' END)`;
const hash = (v) => createHash("sha256").update(v).digest("hex");
export const messageNamespace = (row) =>
  JSON.parse(row.payload || "{}").messageNamespace ||
  (row.kind === "legacy.message-observation" ? "archive" : "onebot");
export const referenceNamespace = (row) => {
  const p = JSON.parse(row.payload || "{}");
  return (
    p.referenceNamespace ||
    p.messageNamespace ||
    (row.kind === "legacy.message-observation" ? "archive" : undefined)
  );
};
const validNamespace = (x) =>
  typeof x === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(x);
const identifier = (x) =>
  typeof x === "string" &&
  x.length > 0 &&
  x.length <= 128 &&
  !/[\s\x00-\x1f]/.test(x);
const hex = (x) => typeof x === "string" && /^[0-9a-f]{64}$/.test(x);
export function assertMessageAccount(memory, connectionId, accountId) {
  const binding = memory.state("@migration-binding");
  if (binding.connectionId === connectionId && binding.accountId !== accountId)
    throw Error("ALIAS_ACCOUNT_MISMATCH");
}

export function migrateMessageIds(db, version) {
  if (version >= 6) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE message_aliases(agent_id TEXT NOT NULL,connection_id TEXT NOT NULL,conversation TEXT NOT NULL,namespace TEXT NOT NULL,message_id TEXT NOT NULL,event_id TEXT NOT NULL REFERENCES events(id),account_id TEXT NOT NULL,evidence TEXT NOT NULL,PRIMARY KEY(agent_id,connection_id,conversation,namespace,message_id),UNIQUE(event_id,namespace));
      CREATE INDEX message_aliases_event ON message_aliases(agent_id,event_id);
      CREATE TABLE message_observations(agent_id TEXT NOT NULL,event_id TEXT NOT NULL REFERENCES events(id),digest TEXT NOT NULL,observation TEXT NOT NULL,PRIMARY KEY(agent_id,event_id,digest));
      CREATE TRIGGER message_alias_scope BEFORE INSERT ON message_aliases BEGIN
        SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM events WHERE id=new.event_id AND agent_id=new.agent_id AND connection_id=new.connection_id AND conversation=new.conversation AND kind IN ${kinds}) THEN RAISE(ABORT,'ALIAS_SCOPE_MISMATCH') END;
      END;
      CREATE TRIGGER message_observation_scope BEFORE INSERT ON message_observations BEGIN
        SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM events WHERE id=new.event_id AND agent_id=new.agent_id AND kind IN ${kinds}) THEN RAISE(ABORT,'OBSERVATION_SCOPE_MISMATCH') END;
      END;
      CREATE VIEW message_identities AS
        SELECT agent_id,connection_id,conversation,${namespaceSql("events")} AS namespace,message_id,id AS event_id FROM events WHERE kind IN ${kinds} AND message_id IS NOT NULL
        UNION SELECT agent_id,connection_id,conversation,'archive',message_id,id FROM events WHERE kind IN ('message.received','message.sent') AND message_id IS NOT NULL AND json_extract(payload,'$.messageNamespace') IS NULL
        UNION SELECT agent_id,connection_id,conversation,namespace,message_id,event_id FROM message_aliases;
      PRAGMA user_version=6;
      COMMIT;
    `);
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// Every caller supplies the full source. Unknown namespace is only for explicit
// user/tool input; if two backends reused the same number it is ambiguous.
export function resolveMessage(
  db,
  { agentId, connectionId, conversation, namespace },
  messageId,
) {
  const rows = db
    .prepare(
      `SELECT DISTINCT e.* FROM message_identities i JOIN events e ON e.id=i.event_id WHERE i.agent_id=? AND i.connection_id=? AND i.conversation=? AND i.message_id=? AND (? IS NULL OR i.namespace=?)`,
    )
    .all(
      agentId,
      connectionId,
      conversation,
      String(messageId),
      namespace ?? null,
      namespace ?? null,
    );
  if (rows.length > 1) throw Error("AMBIGUOUS_MESSAGE_ID");
  return rows[0];
}
export const scopeFor = (row) => ({
  agentId: row.agent_id,
  connectionId: row.connection_id,
  conversation: row.conversation,
  namespace: referenceNamespace(row),
});

export function gatewayMessageId(db, scope, target, namespace, accountId) {
  const alias = db
    .prepare(
      "SELECT * FROM message_aliases WHERE agent_id=? AND event_id=? AND namespace=?",
    )
    .get(scope.agentId, target.id, namespace);
  if (alias && alias.account_id !== accountId)
    throw Error("ALIAS_ACCOUNT_MISMATCH");
  const id =
    alias?.message_id ||
    (messageNamespace(target) === namespace ? target.message_id : null);
  if (!id) throw Error("REPLY_ID_NOT_AVAILABLE_FOR_GATEWAY");
  // A caller holding an exact original event UUID already has its wire number.
  // Old databases may also retain a separate confirmed-send/echo observation.
  if (!alias) {
    const conflict = db
      .prepare(
        "SELECT event_id FROM message_aliases WHERE agent_id=? AND connection_id=? AND conversation=? AND namespace=? AND message_id=?",
      )
      .get(
        scope.agentId,
        scope.connectionId,
        scope.conversation,
        namespace,
        id,
      );
    if (conflict && conflict.event_id !== target.id)
      throw Error("MESSAGE_ALIAS_CONFLICT");
    return id;
  }
  if (resolveMessage(db, { ...scope, namespace }, id)?.id !== target.id)
    throw Error("AMBIGUOUS_MESSAGE_ID");
  return id;
}

export function readAliasManifest(
  file,
  binding,
  agentId,
  connectionMap,
  sourceFiles = [],
) {
  const bytes = fs.readFileSync(file),
    data = JSON.parse(bytes);
  const sources = new Set(
    sourceFiles.map((file) => hash(fs.readFileSync(file))),
  );
  if (
    !data ||
    data.version !== 1 ||
    !Array.isArray(data.aliases) ||
    Object.keys(data).some((k) => !["version", "aliases"].includes(k))
  )
    throw Error("INVALID_ALIAS_MANIFEST");
  if (!binding) throw Error("EXPLICIT_ACCOUNT_CONNECTION_REQUIRED");
  const aliases = [];
  for (const a of data.aliases) {
    validateAlias(a);
    if (!sources.has(a.evidence.sourceDigest))
      throw Error("ALIAS_SOURCE_DIGEST_NOT_VERIFIED");
    const selected = connectionMap[a.accountId];
    if (!selected) throw Error("UNMAPPED_ALIAS_ACCOUNT");
    if (selected.agentId !== agentId) continue;
    if (
      a.accountId !== binding.accountId ||
      selected.connectionId !== binding.connectionId
    )
      throw Error("ALIAS_ACCOUNT_MISMATCH");
    aliases.push(a);
  }
  return {
    aliases,
    file: { name: "message-aliases:" + hash(bytes), digest: hash(bytes) },
  };
}
function validateAlias(a) {
  if (
    !a ||
    Object.keys(a).some(
      (k) =>
        ![
          "accountId",
          "conversation",
          "archiveMessageId",
          "namespace",
          "messageId",
          "evidence",
        ].includes(k),
    ) ||
    !/^\d+$/.test(a.accountId) ||
    !/^(group|private):\d+$/.test(a.conversation) ||
    !identifier(a.archiveMessageId) ||
    !identifier(a.messageId) ||
    !validNamespace(a.namespace) ||
    a.namespace === "archive"
  )
    throw Error("INVALID_MESSAGE_ALIAS");
  const e = a.evidence;
  if (
    !e ||
    Object.keys(e).some(
      (k) => !["sourceId", "sourceDigest", "targetDigest", "basis"].includes(k),
    ) ||
    !identifier(e.sourceId) ||
    !hex(e.sourceDigest) ||
    !hex(e.targetDigest) ||
    !["verified-sequence", "verified-observation", "native-record"].includes(
      e.basis,
    )
  )
    throw Error("INCOMPLETE_ALIAS_EVIDENCE");
}

// Apply after canonical events, in the import transaction. Only exact supplied
// evidence links are accepted; there is no content/time similarity matching.
export function importAliases(memory, aliases, binding) {
  let inserted = 0;
  for (const a of aliases || []) {
    validateAlias(a);
    if (a.accountId !== binding?.accountId)
      throw Error("ALIAS_ACCOUNT_MISMATCH");
    const scope = {
      agentId: memory.agentId,
      connectionId: binding.connectionId,
      conversation: a.conversation,
    };
    const target = resolveMessage(
      memory.db,
      { ...scope, namespace: "archive" },
      a.archiveMessageId,
    );
    if (!target) throw Error("ALIAS_TARGET_NOT_FOUND");
    const p = JSON.parse(target.payload);
    if (
      !p.migration?.sources?.some(
        (s) =>
          s.digest === a.evidence.targetDigest &&
          String(s.observation?.accountId || s.observation?.robotQQ) ===
            a.accountId,
      )
    )
      throw Error("ALIAS_TARGET_EVIDENCE_MISMATCH");
    const existing = resolveMessage(
      memory.db,
      { ...scope, namespace: a.namespace },
      a.messageId,
    );
    if (existing && existing.id !== target.id)
      throw Error("MESSAGE_ALIAS_CONFLICT");
    const old = memory.db
      .prepare(
        "SELECT * FROM message_aliases WHERE agent_id=? AND event_id=? AND namespace=?",
      )
      .get(memory.agentId, target.id, a.namespace);
    if (
      old &&
      (old.message_id !== a.messageId || old.account_id !== a.accountId)
    )
      throw Error("MESSAGE_ALIAS_CONFLICT");
    const evidence = old ? JSON.parse(old.evidence) : [];
    if (!evidence.some((e) => JSON.stringify(e) === JSON.stringify(a.evidence)))
      evidence.push(a.evidence);
    if (old)
      memory.db
        .prepare(
          "UPDATE message_aliases SET evidence=? WHERE agent_id=? AND event_id=? AND namespace=?",
        )
        .run(JSON.stringify(evidence), memory.agentId, target.id, a.namespace);
    else {
      memory.db
        .prepare("INSERT INTO message_aliases VALUES(?,?,?,?,?,?,?,?)")
        .run(
          memory.agentId,
          binding.connectionId,
          a.conversation,
          a.namespace,
          a.messageId,
          target.id,
          a.accountId,
          JSON.stringify(evidence),
        );
      inserted++;
    }
  }
  return inserted;
}

export function observeKnownMessage(memory, e) {
  if (e.payload?.raw?.self_id != null)
    assertMessageAccount(memory, e.connectionId, String(e.payload.raw.self_id));
  if (
    e.kind !== "message.received" ||
    e.messageId == null ||
    !e.payload?.messageNamespace
  )
    return null;
  const scope = {
    agentId: memory.agentId,
    connectionId: e.connectionId || "",
    conversation: e.conversation,
    namespace: e.payload?.messageNamespace || "onebot",
  };
  const target = resolveMessage(memory.db, scope, e.messageId);
  if (!target) return null;
  if (
    (target.sender_id && e.senderId && target.sender_id !== e.senderId) ||
    (target.direction !== "unknown" &&
      e.direction &&
      target.direction !== e.direction)
  )
    throw Error("CONFLICTING_MESSAGE_IDENTITY");
  const alias = memory.db
    .prepare(
      "SELECT account_id FROM message_aliases WHERE agent_id=? AND event_id=? AND namespace=?",
    )
    .get(memory.agentId, target.id, scope.namespace);
  if (alias && String(e.payload?.raw?.self_id) !== alias.account_id)
    throw Error("ALIAS_ACCOUNT_MISMATCH");
  const observation = JSON.stringify(e);
  memory.db
    .prepare("INSERT OR IGNORE INTO message_observations VALUES(?,?,?,?)")
    .run(memory.agentId, target.id, hash(observation), observation);
  return { inserted: false, id: target.id, seq: target.seq };
}

export function validateRestoredAliases(memory) {
  const rows = memory.db
    .prepare(
      "SELECT a.*,e.message_id AS archive_id FROM message_aliases a JOIN events e ON e.id=a.event_id WHERE a.agent_id=?",
    )
    .all(memory.agentId);
  for (const r of rows) {
    const evidence = JSON.parse(r.evidence);
    if (!Array.isArray(evidence) || !evidence.length)
      throw Error("INCOMPLETE_ALIAS_EVIDENCE");
    const binding = memory.state("@migration-binding");
    if (
      binding.connectionId !== r.connection_id ||
      binding.accountId !== r.account_id
    )
      throw Error("ALIAS_ACCOUNT_MISMATCH");
    for (const e of evidence)
      importAliases(
        memory,
        [
          {
            accountId: r.account_id,
            conversation: r.conversation,
            archiveMessageId: r.archive_id,
            namespace: r.namespace,
            messageId: r.message_id,
            evidence: e,
          },
        ],
        binding,
      );
  }
}
