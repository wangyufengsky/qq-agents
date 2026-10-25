import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readAliasManifest, importAliases } from "./message-ids.mjs";
import {
  validateConnections,
  mappedConnection,
  bindLegacyConnections,
} from "./legacy-connections.mjs";
import {
  adaptMessage,
  digest,
  originalTime,
  mergeObservations,
} from "./legacy-adapters.mjs";

const validAgent = (x) =>
  typeof x === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(x);
function readFile(file) {
  if (fs.lstatSync(file).isSymbolicLink())
    throw Error("LEGACY_SYMLINK_REFUSED");
  return fs.readFileSync(file);
}
export function inspectLegacy(source, options = {}) {
  const {
    agentId,
    accountId,
    legacyDb,
    legacyAgentId,
    subjectMap = {},
    connectionMap = {},
    exportFiles = [],
  } = options;
  if (!validAgent(agentId)) throw Error("EXPLICIT_TARGET_AGENT_REQUIRED");
  validateConnections(connectionMap, subjectMap);
  for (const [qq, b] of Object.entries(subjectMap))
    if (!/^\d+$/.test(qq) || !validAgent(b.agentId))
      throw Error("INVALID_SUBJECT_MAP");
  if (
    accountId &&
    (!/^\d+$/.test(accountId) ||
      (subjectMap[accountId] && subjectMap[accountId].agentId !== agentId))
  )
    throw Error("CONTRADICTORY_SUBJECT_MAP");
  const mappedAccounts = Object.entries(subjectMap)
    .filter(([, b]) => b.agentId === agentId)
    .map(([qq]) => qq);
  if (
    mappedAccounts.length > 1 ||
    (accountId && mappedAccounts.length && !mappedAccounts.includes(accountId))
  )
    throw Error("AMBIGUOUS_SUBJECT_MAP");
  const binding = {
    ...options,
    accountId: accountId || mappedAccounts[0],
    subjectMap,
    connectionMap,
  };
  const connectionBinding =
    binding.accountId && connectionMap[binding.accountId]
      ? {
          accountId: binding.accountId,
          connectionId: mappedConnection(binding, binding.accountId, agentId),
        }
      : undefined;
  const plan = {
    version: 2,
    agentId,
    connectionBinding,
    files: [],
    events: [],
    notes: [],
    states: [],
    people: [],
    warnings: [],
    rejected: [],
    coverage: {
      candidates: 0,
      otherSubjects: 0,
      excludedDrafts: 0,
      unknownTime: 0,
      unknownDirection: 0,
      idless: 0,
      sqlite: {},
    },
  };
  const sourceId = options.sourceId || digest(fs.realpathSync(source));
  const accept = (row, format, ref) => {
    plan.coverage.candidates++;
    try {
      const e = adaptMessage(row, format, binding, ref);
      if (e.agentId !== agentId) {
        plan.coverage.otherSubjects++;
        return;
      }
      if (!e.payload.timeKnown) plan.coverage.unknownTime++;
      if (e.direction === "unknown") plan.coverage.unknownDirection++;
      if (!e.messageId) plan.coverage.idless++;
      plan.connectionBinding = {
        accountId: e.accountId,
        connectionId: e.connectionId,
      };
      plan.events.push(e);
    } catch (error) {
      plan.rejected.push({
        sourceId: ref.sourceId,
        locator: ref.locator,
        reason: error.message,
      });
    }
  };
  const stateFile = path.join(source, "state/social-v2.json");
  if (fs.existsSync(stateFile)) {
    const bytes = readFile(stateFile),
      data = JSON.parse(bytes);
    plan.files.push({ name: sourceId + ":social-v2", digest: digest(bytes) });
    if (!data.conversations || typeof data.conversations !== "object")
      throw Error("UNRECOGNIZED_SOCIAL_SCHEMA");
    for (const [conversation, st] of Object.entries(data.conversations)) {
      if (!/^(group|private):\d+$/.test(conversation)) {
        plan.rejected.push({
          sourceId,
          locator: conversation,
          reason: "INVALID_CONVERSATION",
        });
        continue;
      }
      for (const lane of ["recentMessages", "unread"])
        for (const [i, row] of (st[lane] || []).entries())
          accept(
            {
              ...row,
              conversation,
              key: row.key ?? row.conversation ?? conversation,
            },
            "social-v2",
            {
              sourceId,
              locator: `social-v2:${conversation}:${lane}:${i}`,
            },
          );
      // pendingThoughts are unfinished model drafts, not observed speech or notes.
      plan.coverage.excludedDrafts += (st.pendingThoughts || []).length;
      for (const n of st.activeTopics || [])
        if (typeof n?.text === "string")
          plan.notes.push({
            conversation,
            category: "activeTopic",
            body: n.text,
            sourceId,
            metadata: {
              source: "social-v2",
              epistemic: "legacy-subjective-note",
            },
          });
      for (const [person, n] of Object.entries(st.memberImpressions || {}))
        plan.notes.push({
          conversation,
          category: "memberImpression",
          body: JSON.stringify(n),
          sourceId,
          metadata: {
            subjectQQ: person,
            source: "social-v2",
            epistemic: "legacy-subjective-note",
          },
        });
      plan.states.push({
        conversation,
        value: {
          paused: true,
          readThroughSeq: 0,
          pendingWake: (st.unread || []).length > 0,
          legacy: {
            globalPaused: data.paused ?? null,
            unreadCount: (st.unread || []).length,
            lastReadThroughSeq: st.lastReadThroughSeq ?? null,
            lastUnreadSeq: st.lastUnreadSeq ?? null,
            wakeConfig: st.wakeConfig ?? {},
            lastAiReplyAt: st.lastAiReplyAt ?? null,
          },
        },
      });
    }
    plan.warnings.push(
      "social-v2 is a bounded window; missing history cannot be reconstructed. Cache time is an observed cache timestamp, not necessarily the QQ send timestamp. Sends remain unverified.",
    );
  }
  const history = path.join(source, "history");
  const readLines = (file, format, id) => {
    const bytes = readFile(file);
    plan.files.push({ name: id, digest: digest(bytes) });
    for (const [i, line] of bytes.toString("utf8").split("\n").entries()) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        plan.rejected.push({
          sourceId: id,
          locator: String(i + 1),
          reason: "INVALID_JSON",
        });
        continue;
      }
      accept(row, format, { sourceId: id, locator: String(i + 1) });
    }
  };
  if (fs.existsSync(history))
    for (const name of fs
      .readdirSync(history)
      .filter((n) => n.endsWith(".jsonl"))
      .sort())
      readLines(
        path.join(history, name),
        "camel-history-v1",
        sourceId + ":history/" + name,
      );
  for (const file of [...new Set(exportFiles.map((p) => fs.realpathSync(p)))])
    readLines(file, "qq-export-v1", options.exportSourceId || digest(file));
  if (legacyDb) {
    if (!legacyAgentId) throw Error("LEGACY_AGENT_ID_REQUIRED");
    const db = new DatabaseSync(legacyDb, { readOnly: true });
    const dbSource =
      options.legacySourceId || digest(fs.realpathSync(legacyDb));
    try {
      db.exec("BEGIN");
      const required = {
        memories: [
          "id",
          "agent_id",
          "conversation",
          "kind",
          "text",
          "subject_qq",
          "source_type",
          "source_ref",
          "certainty",
          "visibility",
          "pinned",
          "superseded_by",
          "created_at",
          "updated_at",
        ],
        people: ["agent_id", "qq", "nickname", "updated_at"],
        sightings: [
          "agent_id",
          "qq",
          "conversation",
          "display_name",
          "updated_at",
        ],
        events: ["agent_id", "action", "memory_id", "at"],
      };
      for (const [table, columns] of Object.entries(required)) {
        const actual = db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .map((c) => c.name);
        if (columns.some((c) => !actual.includes(c)))
          throw Error("UNSUPPORTED_LEGACY_SQLITE_SCHEMA:" + table);
        const rows = db
          .prepare(`SELECT * FROM ${table} WHERE agent_id=?`)
          .all(legacyAgentId);
        plan.coverage.sqlite[table] = {
          selected: rows.length,
          total: db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,
        };
        plan.files.push({
          name: dbSource + ":" + table + ":" + legacyAgentId,
          digest: digest(rows),
        });
        for (const row of rows) {
          const { agent_id: oldAgent, ...metadata } = row;
          if (table === "memories") {
            if (
              [
                "draft",
                "pendingThought",
                "reasoning",
                "model-thought",
              ].includes(row.kind)
            ) {
              plan.coverage.excludedDrafts++;
              continue;
            }
            plan.notes.push({
              conversation: row.conversation,
              category: row.kind,
              body: row.text,
              sourceId: dbSource,
              legacyId: row.id,
              metadata: {
                ...metadata,
                legacyAgentId: oldAgent,
                epistemic:
                  "legacy-subjective-note; source and certainty preserved",
              },
            });
          } else {
            const kind =
              table === "events"
                ? "legacy.note-revision"
                : table === "people"
                  ? "legacy.person-observation"
                  : "legacy.sighting";
            const time = originalTime(row.updated_at ?? row.at);
            plan.events.push({
              agentId,
              conversation: row.conversation || "legacy:people",
              kind,
              direction: "internal",
              status: "legacy-unverified",
              senderId: row.qq ?? null,
              body: row.nickname ?? row.display_name ?? row.action,
              occurredAt: time || "unknown",
              dedupe: "legacy-record:" + digest([dbSource, table, row]),
              origin: "legacy-import-v2",
              payload: {
                ...metadata,
                legacyAgentId: oldAgent,
                sourceId: dbSource,
                timeKnown: !!time,
              },
            });
            if (table !== "events")
              plan.people.push({
                qq: row.qq,
                name: row.nickname ?? row.display_name,
              });
          }
        }
      }
      db.exec("ROLLBACK");
    } finally {
      db.close();
    }
  }
  if (!plan.files.length)
    plan.warnings.push("No recognized source data found.");
  if (plan.coverage.idless)
    plan.warnings.push(
      "ID-less observations use conservative source-scoped identities; ambiguous cross-source duplicates are retained, never matched by text alone.",
    );
  if (plan.coverage.unknownTime || plan.coverage.unknownDirection)
    plan.warnings.push(
      "Missing original time/direction remains unknown; import time is observation time only.",
    );
  for (const e of plan.events)
    if (e.payload.senderName && e.senderId)
      plan.people.push({ qq: e.senderId, name: e.payload.senderName });
  if (options.aliasFile) {
    const manifest = readAliasManifest(
      options.aliasFile,
      plan.connectionBinding,
      agentId,
      connectionMap,
      options.aliasSourceFiles,
    );
    plan.aliases = manifest.aliases;
    plan.files.push(manifest.file);
  }
  return plan;
}

export function importLegacy(memory, plan) {
  if (
    plan.version !== 2 ||
    plan.agentId !== memory.agentId ||
    plan.events.some((e) => e.agentId !== memory.agentId)
  )
    throw Error("MIGRATION_IDENTITY_MISMATCH");
  if (plan.rejected.length) throw Error("MIGRATION_REJECTED_RECORDS");
  for (const e of plan.events.filter(
    (e) => e.kind === "legacy.message-observation",
  ))
    if (
      !plan.connectionBinding ||
      e.connectionId !== plan.connectionBinding.connectionId ||
      e.accountId !== plan.connectionBinding.accountId
    )
      throw Error("MIGRATION_CONNECTION_MISMATCH");
  let inserted = 0,
    duplicates = 0,
    enriched = 0,
    rebound = 0,
    aliasesInserted = 0;
  memory.store.transaction(() => {
    rebound = bindLegacyConnections(memory, plan);
    for (const event of plan.events) {
      let existing = memory.db
        .prepare("SELECT * FROM events WHERE agent_id=? AND dedupe=?")
        .get(memory.agentId, event.dedupe);
      if (!existing && event.legacyDedupe)
        existing = memory.db
          .prepare(
            "SELECT * FROM events WHERE agent_id=? AND dedupe=? AND connection_id=?",
          )
          .get(memory.agentId, event.legacyDedupe, event.connectionId);
      if (
        !existing &&
        event.messageId &&
        event.kind === "legacy.message-observation"
      ) {
        const candidates = memory.db
          .prepare(
            "SELECT * FROM events WHERE agent_id=? AND conversation=? AND message_id=? AND connection_id=? AND kind='legacy.message-observation'",
          )
          .all(
            memory.agentId,
            event.conversation,
            event.messageId,
            event.connectionId,
          );
        if (candidates.length > 1)
          throw Error("EXISTING_DUPLICATE_MESSAGE_ID_REQUIRES_RECONCILIATION");
        existing = candidates[0];
      }
      if (existing && event.kind === "legacy.message-observation") {
        duplicates++;
        const old = {
          ...event,
          body: existing.body,
          senderId: existing.sender_id,
          direction: existing.direction,
          occurredAt: existing.occurred_at,
          payload: JSON.parse(existing.payload),
        };
        if (!old.payload.migration) {
          const observation = {
            agentId: memory.agentId,
            conversation: existing.conversation,
            messageId: existing.message_id,
            senderId: existing.sender_id,
            direction: existing.direction,
            body: existing.body,
            occurredAt:
              old.payload.timeKnown === true ? existing.occurred_at : "unknown",
            source: "previous-import",
            senderName: old.payload.senderName || null,
            segments: old.payload.segments || [],
            possibleTextTruncation: "unknown",
            previousPayload: old.payload,
          };
          old.payload = {
            ...old.payload,
            migration: {
              version: 2,
              identity: "message-id",
              sources: [
                {
                  sourceId: "previous-import:" + existing.id,
                  locator: existing.id,
                  format: "previous-import",
                  digest: digest(observation),
                  observation,
                },
              ],
            },
          };
        }
        const merged = mergeObservations(old, event);
        if (digest(old) !== digest(merged)) {
          memory.db
            .prepare(
              "UPDATE events SET body=?,sender_id=?,direction=?,occurred_at=?,payload=? WHERE seq=?",
            )
            .run(
              merged.body,
              merged.senderId,
              merged.direction,
              merged.occurredAt,
              JSON.stringify(merged.payload),
              existing.seq,
            );
          enriched++;
        }
      } else if (memory.append(event).inserted) inserted++;
      else duplicates++;
    }
    aliasesInserted = importAliases(
      memory,
      plan.aliases,
      plan.connectionBinding,
    );
    for (const note of plan.notes) {
      const e = {
        conversation: note.conversation || "legacy:unknown",
        kind: "legacy.note",
        direction: "internal",
        status: "legacy-unverified",
        body: note.body,
        dedupe: "legacy-note-v2:" + digest(note),
        occurredAt: originalTime(note.metadata.created_at) || "unknown",
        payload: {
          ...note.metadata,
          category: note.category,
          sourceId: note.sourceId,
          legacyId: note.legacyId ?? null,
          timeKnown: !!originalTime(note.metadata.created_at),
        },
        origin: "legacy-import-v2",
      };
      if (memory.append(e).inserted) inserted++;
      else duplicates++;
    }
    for (const person of plan.people) memory.person(person.qq, person.name);
    for (const s of plan.states) {
      const old = memory.state(s.conversation);
      if (!old.migrationImported)
        memory.setState(s.conversation, {
          ...s.value,
          ...old,
          paused: true,
          legacy: { ...s.value.legacy, ...old.legacy },
          migrationImported: true,
        });
      else memory.setState(s.conversation, { ...old, paused: true });
    }
    // Explicit exports can contain conversations absent from the bounded cache.
    for (const conversation of new Set(
      plan.events
        .filter((e) => e.kind === "legacy.message-observation")
        .map((e) => e.conversation),
    ))
      memory.setState(conversation, {
        ...memory.state(conversation),
        paused: true,
        readThroughSeq: memory.state(conversation).readThroughSeq || 0,
        migrationImported: true,
      });
    for (const file of plan.files)
      memory.db
        .prepare("INSERT OR IGNORE INTO migrations VALUES(?,?,?,?)")
        .run(memory.agentId, file.name, file.digest, new Date().toISOString());
  });
  return {
    inserted,
    duplicates,
    enriched,
    rebound,
    aliasesInserted,
    rejected: plan.rejected.length,
    warnings: plan.warnings,
    sourceFiles: plan.files.length,
  };
}
