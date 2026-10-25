import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const timestamp = (value) => {
  const date = new Date(
    typeof value === "number" && value < 1e12 ? value * 1000 : value,
  );
  return Number.isFinite(date.getTime())
    ? date.toISOString()
    : new Date().toISOString();
};

const knownTime = (value) =>
  value !== undefined &&
  value !== null &&
  value !== "" &&
  Number.isFinite(
    new Date(
      typeof value === "number" && value < 1e12 ? value * 1000 : value,
    ).getTime(),
  );

/** Read only known message/state surfaces. Never import config tokens or model credentials. */
export function inspectLegacy(source, { legacyDb, legacyAgentId } = {}) {
  const files = [],
    events = [],
    notes = [],
    states = [],
    warnings = [];
  const stateFile = path.join(source, "state", "social-v2.json");
  if (fs.existsSync(stateFile)) {
    const bytes = fs.readFileSync(stateFile);
    files.push({ name: "state/social-v2.json", digest: hash(bytes) });
    const data = JSON.parse(bytes);
    for (const [conversation, st] of Object.entries(data.conversations || {})) {
      if (!/^(group|private):\d+$/.test(conversation)) continue;
      const messages = [...(st.recentMessages || []), ...(st.unread || [])];
      for (const m of messages) {
        const body = String(m.plain ?? m.text ?? m.content ?? "");
        const messageId = m.messageId ?? m.message_id ?? null;
        events.push({
          conversation,
          kind: "legacy.message-observation",
          direction: m.isSelf ? "out" : "in",
          status: "legacy-unverified",
          messageId: messageId == null ? null : String(messageId),
          senderId: String(m.userId ?? m.user_id ?? ""),
          body,
          occurredAt: timestamp(m.time ?? m.timestamp ?? Date.now()),
          dedupe:
            "legacy-message:" +
            hash(
              JSON.stringify([
                conversation,
                messageId ?? m.seq ?? null,
                m.userId ?? m.user_id ?? "",
                body,
              ]),
            ),
          payload: {
            legacySeq: m.seq ?? null,
            timeKnown: knownTime(m.time ?? m.timestamp),
            media: m.media || [],
            source: "social-v2",
            completeness: "bounded-window; original may have been truncated",
          },
          origin: "legacy-chat-window",
        });
      }
      for (const category of ["activeTopics", "pendingThoughts"])
        for (const n of st[category] || [])
          if (n?.text) notes.push({ conversation, category, body: n.text });
      for (const [person, n] of Object.entries(st.memberImpressions || {}))
        notes.push({
          conversation,
          category: "memberImpression",
          body: JSON.stringify({ person, ...n }),
        });
      states.push({
        conversation,
        value: {
          paused: true,
          readThroughSeq: 0,
          pendingWake: (st.unread || []).length > 0,
          legacy: {
            globalPaused: data.paused,
            unreadCount: (st.unread || []).length,
            lastReadThroughSeq: st.lastReadThroughSeq || 0,
            lastUnreadSeq: st.lastUnreadSeq || 0,
            wakeConfig: st.wakeConfig || {},
            lastAiReplyAt: st.lastAiReplyAt || 0,
          },
        },
      });
    }
    warnings.push(
      "social-v2 only contains a bounded window; absent messages cannot be reconstructed. Legacy sent text is not a verified delivery receipt.",
    );
  }
  const history = path.join(source, "history");
  if (fs.existsSync(history)) {
    for (const name of fs
      .readdirSync(history)
      .filter((n) => n.endsWith(".jsonl"))) {
      const file = path.join(history, name);
      if (fs.lstatSync(file).isSymbolicLink())
        throw Error("LEGACY_SYMLINK_REFUSED");
      const bytes = fs.readFileSync(file);
      files.push({ name: "history/" + name, digest: hash(bytes) });
      for (const [index, line] of bytes
        .toString("utf8")
        .split("\n")
        .entries()) {
        if (!line.trim()) continue;
        const e = JSON.parse(line);
        const conversation = e.conversation || e.key;
        if (!/^(group|private):\d+$/.test(conversation)) {
          warnings.push(
            `Unrecognized history schema at line ${index + 1}; record not imported.`,
          );
          continue;
        }
        events.push({
          conversation,
          kind: "legacy.message-observation",
          body: String(e.body ?? e.text ?? e.message ?? ""),
          senderId: String(e.senderId ?? e.userId ?? ""),
          messageId: e.messageId == null ? null : String(e.messageId),
          occurredAt: timestamp(e.occurredAt ?? e.time ?? Date.now()),
          dedupe:
            "legacy-history:" +
            hash(
              JSON.stringify([
                conversation,
                e.messageId ?? index,
                e.senderId ?? e.userId,
                e.body ?? e.text ?? e.message,
              ]),
            ),
          payload: {
            source: name,
            timeKnown: knownTime(e.occurredAt ?? e.time),
            line: index + 1,
            attachments: e.attachments || [],
            completeness: "as-exported",
          },
          origin: "legacy-history",
          status: "legacy-unverified",
          direction: e.direction || "in",
        });
      }
    }
  }
  if (legacyDb) {
    if (!legacyAgentId) throw Error("LEGACY_AGENT_ID_REQUIRED");
    const db = new DatabaseSync(legacyDb, { readOnly: true });
    try {
      for (const r of db
        .prepare("SELECT * FROM memories WHERE agent_id=?")
        .all(legacyAgentId))
        notes.push({
          conversation: r.conversation,
          category: r.kind,
          body: r.text,
          legacyId: r.id,
          legacySource: r.source_type,
          legacyTime: r.created_at,
        });
    } finally {
      db.close();
    }
    files.push({
      name: "legacy-memory-database",
      digest: hash(JSON.stringify(notes)),
    });
  }
  if (!files.length) warnings.push("No recognized source data found.");
  return { files, events, notes, states, warnings };
}
export function importLegacy(memory, plan) {
  const seen = new Set();
  let inserted = 0;
  memory.store.transaction(() => {
    for (const e of plan.events) {
      if (seen.has(e.dedupe)) continue;
      seen.add(e.dedupe);
      if (memory.append(e).inserted) inserted++;
    }
    // Old notes remain labelled legacy observations. They are never backdated AI diaries.
    for (const note of plan.notes)
      if (
        memory.append({
          conversation: note.conversation || "legacy:unknown",
          kind: "legacy.note",
          direction: "internal",
          status: "legacy-unverified",
          body: note.body,
          dedupe: "legacy-note:" + hash(JSON.stringify(note)),
          payload: {
            category: note.category,
            legacyId: note.legacyId,
            legacySource: note.legacySource,
            legacyTime: note.legacyTime,
          },
          origin: "legacy-note",
        }).inserted
      )
        inserted++;
    for (const s of plan.states) {
      const old = memory.state(s.conversation);
      if (!old.migrationImported)
        memory.setState(s.conversation, {
          ...s.value,
          migrationImported: true,
        });
    }
    for (const file of plan.files)
      memory.db
        .prepare("INSERT OR IGNORE INTO migrations VALUES(?,?,?,?)")
        .run(memory.agentId, file.name, file.digest, new Date().toISOString());
  });
  return { inserted, warnings: plan.warnings, sourceFiles: plan.files.length };
}
export function restoreExport(memory, data) {
  if (data.version !== 1 || data.agentId !== memory.agentId)
    throw Error("EXPORT_IDENTITY_MISMATCH");
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
  };
  // An empty target identity can be restored beside other identities. Remap only local seq watermarks.
  if (
    memory.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE agent_id=?")
      .get(memory.agentId).n ||
    memory.db
      .prepare("SELECT COUNT(*) AS n FROM diaries WHERE agent_id=?")
      .get(memory.agentId).n
  )
    throw Error("RESTORE_REQUIRES_EMPTY_DATABASE_FOR_AGENT");
  const empty =
      memory.db.prepare("SELECT COUNT(*) AS n FROM events").get().n === 0,
    seqs = new Map([[0, 0]]);
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
            "feedThroughSeq",
          ])
            if (state[key] !== undefined)
              state[key] = seqs.get(state[key]) ?? 0;
          row.value = JSON.stringify(state);
        }
        if (table === "message_progress" && !empty) row.seq = seqs.get(row.seq);
        if (table === "intentions" && !empty) {
          const value = JSON.parse(row.value);
          if (value.handoffSeq)
            value.handoffSeq = seqs.get(value.handoffSeq) ?? 0;
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
  });
}
