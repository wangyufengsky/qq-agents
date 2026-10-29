import fs from "node:fs";
import { ConversationDue } from "./conversation-due.mjs";
import {
  isConversation,
  readConversationState,
  writeConversationState,
} from "./conversation-state.mjs";
import { IdentityMemory, migrateIdentity } from "./identity.mjs";
import {
  provenance,
  sceneForMatch,
  fitScene,
  deduplicateScenes,
} from "./scenes.mjs";
import { migrateSearch, related } from "./search.mjs";
import { migrateTimeline } from "./timeline.mjs";
import { around } from "./around.mjs";
import { migrateMessageIds, observeKnownMessage } from "./message-ids.mjs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";

const json = JSON.stringify;
const parse = (s) => JSON.parse(s);
const now = () => new Date().toISOString();
const hash = (s) => createHash("sha256").update(s).digest("hex");
const text = (s, max = 2 * 1024 * 1024) => {
  if (typeof s !== "string" || s.length > max) throw Error("INVALID_TEXT");
  return s;
};
const num = (x, def, min, max) => {
  if (x === undefined) return def;
  if (!Number.isSafeInteger(x) || x < min || x > max)
    throw Error("INVALID_BUDGET");
  return x;
};
const disclosure = (source, current) =>
  source === current ? "current-conversation" : "agent-judged-recollection";
function budget(items, maxChars) {
  let used = 2;
  const out = [];
  for (const item of items) {
    const deduped = deduplicateScenes([...out, item]).at(-1);
    let entry = !out.length ? fitScene(deduped, maxChars) : deduped,
      size = json(entry).length + 1;
    if (size + 2 > maxChars && out.length === 0) {
      entry = {
        id: item.id,
        type: item.type,
        seq: item.seq,
        conversation: item.conversation,
        disclosure: item.disclosure,
        ...(item.updatedAt ? { updatedAt: item.updatedAt } : {}),
        summaryOmitted: true,
        ...(item.protectedOperations ? { protectedOperations: true } : {}),
        ...(item.protectedRepositories?.length
          ? { protectedRepositories: item.protectedRepositories }
          : {}),
        hint: "Use memory_read for bounded expansion",
      };
      size = json(entry).length + 1;
    }
    if (used + size > maxChars) break;
    out.push(entry);
    used += size;
  }
  return out;
}

export class MemoryStore {
  constructor(file) {
    this.file = file === ":memory:" ? file : path.resolve(file);
    if (file !== ":memory:")
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    const version = this.db.prepare("PRAGMA user_version").get().user_version;
    if (version > 6) {
      this.db.close();
      throw Error("MEMORY_SCHEMA_NEWER_THAN_CODE");
    }
    if (file !== ":memory:") fs.chmodSync(file, 0o600);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,agent_id TEXT NOT NULL,dedupe TEXT NOT NULL,connection_id TEXT NOT NULL,conversation TEXT NOT NULL,kind TEXT NOT NULL,direction TEXT NOT NULL,status TEXT NOT NULL,message_id TEXT,sender_id TEXT,occurred_at TEXT NOT NULL,observed_at TEXT NOT NULL,body TEXT NOT NULL,payload TEXT NOT NULL,origin TEXT NOT NULL,UNIQUE(agent_id,dedupe));
      CREATE INDEX IF NOT EXISTS events_scope ON events(agent_id,conversation,seq);
      CREATE INDEX IF NOT EXISTS events_scene ON events(agent_id,connection_id,conversation,seq);
      CREATE INDEX IF NOT EXISTS events_message_ref ON events(agent_id,connection_id,conversation,message_id);
      CREATE INDEX IF NOT EXISTS events_people ON events(agent_id,sender_id,occurred_at);
      CREATE TABLE IF NOT EXISTS diaries(id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,revision INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,metadata TEXT NOT NULL,origin TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS diaries_agent ON diaries(agent_id,updated_at);
      CREATE TABLE IF NOT EXISTS diary_revisions(id TEXT NOT NULL,revision INTEGER NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,metadata TEXT NOT NULL,written_at TEXT NOT NULL,PRIMARY KEY(id,revision),FOREIGN KEY(id) REFERENCES diaries(id));
      CREATE TABLE IF NOT EXISTS people(agent_id TEXT NOT NULL,qq TEXT NOT NULL,names TEXT NOT NULL,PRIMARY KEY(agent_id,qq));
      CREATE TABLE IF NOT EXISTS deliveries(agent_id TEXT NOT NULL,request_id TEXT NOT NULL,conversation TEXT NOT NULL,payload_hash TEXT NOT NULL,status TEXT NOT NULL,message_id TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(agent_id,request_id));
      CREATE INDEX IF NOT EXISTS deliveries_message ON deliveries(agent_id,conversation,message_id);
      CREATE INDEX IF NOT EXISTS deliveries_status ON deliveries(agent_id,status);
      CREATE TABLE IF NOT EXISTS runtime(agent_id TEXT NOT NULL,conversation TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(agent_id,conversation));
      CREATE TABLE IF NOT EXISTS migrations(agent_id TEXT NOT NULL,source TEXT NOT NULL,digest TEXT NOT NULL,imported_at TEXT NOT NULL,PRIMARY KEY(agent_id,source,digest));
      CREATE TABLE IF NOT EXISTS person_notes(agent_id TEXT NOT NULL,person_id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(agent_id,person_id));
      CREATE TABLE IF NOT EXISTS moods(agent_id TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(agent_id,id));
      `);
    try {
      migrateSearch(this.db, version);
      migrateIdentity(this.db);
      migrateTimeline(this.db, version);
      migrateMessageIds(this.db, version);
      this.due = new ConversationDue(this.db);
      this.due.initialize();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  close() {
    this.db.close();
  }
  interruptDeliveries() {
    // Called only at the process exit boundary; confirmed receipts never regress.
    return this.db
      .prepare(
        "UPDATE deliveries SET status='unknown',updated_at=? WHERE status='pending'",
      )
      .run(now());
  }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  bind(agentId) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(agentId)) throw Error("INVALID_AGENT");
    return new AgentMemory(this, agentId);
  }
}
class AgentMemory {
  constructor(store, agentId) {
    this.store = store;
    this.db = store.db;
    this.agentId = agentId;
    this.identity = new IdentityMemory(this);
  }
  append(e) {
    if (!e.dedupe || !e.conversation || !e.kind)
      throw Error("EVENT_IDENTITY_REQUIRED");
    const observedMessage = observeKnownMessage(this, e);
    if (observedMessage) return observedMessage;
    const id = randomUUID(),
      observed = e.observedAt || now();
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO events(id,agent_id,dedupe,connection_id,conversation,kind,direction,status,message_id,sender_id,occurred_at,observed_at,body,payload,origin) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        this.agentId,
        text(e.dedupe, 1000),
        e.connectionId || "",
        text(e.conversation, 100),
        e.kind,
        e.direction || "in",
        e.status || "observed",
        e.messageId ?? null,
        e.senderId ?? null,
        e.occurredAt || observed,
        observed,
        text(e.body || ""),
        json(e.payload || {}),
        e.origin || "live",
      );
    return {
      inserted: !!result.changes,
      ...this.db
        .prepare("SELECT id,seq FROM events WHERE agent_id=? AND dedupe=?")
        .get(this.agentId, e.dedupe),
    };
  }
  person(qq, name) {
    if (!qq) return;
    const row = this.db
      .prepare("SELECT names FROM people WHERE agent_id=? AND qq=?")
      .get(this.agentId, qq);
    const names = [
      ...new Set(
        [...(row ? parse(row.names) : []), String(name || "")].filter(Boolean),
      ),
    ].slice(-30);
    this.db
      .prepare("INSERT OR REPLACE INTO people VALUES(?,?,?)")
      .run(this.agentId, qq, json(names));
  }
  // A send is archived as an attempt and then its outcome, both carrying the
  // full text. Returns the outcome once one exists.
  sendOutcome(row) {
    const request =
      row.kind === "message.send-attempt" &&
      /^send:(.+):pending$/.exec(row.dedupe || "")?.[1];
    if (!request) return null;
    return (
      this.db
        .prepare(
          "SELECT id,seq,kind,status FROM events WHERE agent_id=? AND dedupe IN (?,?,?)",
        )
        .get(
          this.agentId,
          `send:${request}:sent`,
          `send:${request}:failed`,
          `send:${request}:unknown`,
        ) || null
    );
  }
  // Feed entry for the model. A resolved attempt keeps its place, so read
  // progress still covers every seq, but its text is only on the outcome.
  feedEvent(row, current) {
    const outcome = this.sendOutcome(row);
    if (!outcome) return this.event(row, current, true);
    const payload = parse(row.payload);
    return {
      id: row.id,
      seq: row.seq,
      type: row.kind,
      conversation: row.conversation,
      direction: row.direction,
      status: row.status,
      outcome: {
        id: outcome.id,
        seq: outcome.seq,
        type: outcome.kind,
        status: outcome.status,
      },
      notice: "发送尝试；正文和发送结果只在 outcome 这条记录里出现一次。",
      protectedRepositories: payload.protectedRepositories || [],
      ...(payload.protectedOperations === true
        ? { protectedOperations: true }
        : {}),
    };
  }
  event(row, current, summary = false) {
    return {
      id: row.id,
      seq: row.seq,
      type: row.kind,
      conversation: row.conversation,
      connectionId: row.connection_id,
      senderId: row.sender_id,
      messageId: row.message_id,
      occurredAt: row.occurred_at,
      observedAt: row.observed_at,
      status: row.status,
      direction: row.direction,
      origin: row.origin,
      disclosure: disclosure(row.conversation, current),
      protectedRepositories: parse(row.payload).protectedRepositories || [],
      ...(parse(row.payload).protectedOperations === true
        ? { protectedOperations: true }
        : {}),
      privacy: row.conversation.startsWith("private:")
        ? "private-conversation"
        : row.conversation.startsWith("group:")
          ? "group-conversation"
          : "internal",
      epistemic: "Observed speech/event; not independently verified fact",
      body: summary ? row.body.slice(0, 200) : row.body,
      bodyTruncated: summary && row.body.length > 200,
      ...provenance(row),
      ...(!summary ? { payload: parse(row.payload) } : {}),
    };
  }
  diary(row, summary = false) {
    return {
      id: row.id,
      type: "diary",
      epistemic:
        "AI diary/opinion, not verified event; evidence links do not prove every sentence",
      title: row.title,
      body: summary ? row.body.slice(0, 200) : row.body,
      ...(summary ? { bodyTruncated: row.body.length > 200 } : {}),
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      origin: row.origin,
      metadata: parse(row.metadata),
      disclosure: "agent-judged-diary",
      privacy: "personal-diary",
      protectedOperations: parse(row.metadata).protectedOperations === true,
      protectedRepositories: parse(row.metadata).protectedRepositories || [],
    };
  }
  search(q = {}, current = "") {
    const limit = num(q.limit, 10, 1, 50),
      offset = num(q.cursor?.eventOffset ?? q.offset, 0, 0, 10000000),
      maxChars = num(q.maxChars, 6000, 512, 16000);
    const sceneOptions = {
      before: num(q.contextBefore, 2, 0, 5),
      after: num(q.contextAfter, 2, 0, 5),
      seconds: num(q.contextSeconds, 600, 1, 3600),
    };
    const types = q.type || "all";
    if (!["all", "event", "diary"].includes(types))
      throw Error("INVALID_RECORD_TYPE");
    const literals = text(q.query || "", 200)
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const terms = literals.map(
      (s) => "%" + s.replace(/[\\%_]/g, (c) => "\\" + c) + "%",
    );
    const where = ["agent_id=?"],
      args = [this.agentId];
    const eventCeiling = num(
      q.cursor?.eventCeiling,
      this.db
        .prepare(
          "SELECT COALESCE(MAX(seq),0) AS n FROM events WHERE agent_id=?",
        )
        .get(this.agentId).n,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    where.push("seq<=?");
    args.push(eventCeiling);
    if (q.cursor?.beforeSeq != null) {
      where.push("seq<?");
      args.push(num(q.cursor.beforeSeq, 0, 1, Number.MAX_SAFE_INTEGER));
    }
    const indexed = literals.filter(
      (s) => [...s].length >= 3 && !s.includes("\0"),
    );
    if (indexed.length) {
      where.push(
        "seq IN (SELECT rowid FROM events_fts WHERE events_fts MATCH ?)",
      );
      args.push(
        indexed.map((s) => '"' + s.replaceAll('"', '""') + '"').join(" AND "),
      );
    }
    for (const [field, key] of [
      ["connection_id", "connectionId"],
      ["conversation", "conversation"],
      ["sender_id", "person"],
      ["kind", "kind"],
    ])
      if (q[key]) {
        where.push(field + "=?");
        args.push(text(q[key], 100));
      }
    for (const [key, op] of [
      ["from", ">="],
      ["to", "<="],
    ])
      if (q[key]) {
        where.push("occurred_at" + op + "?");
        args.push(q[key]);
      }
    for (const term of terms) {
      where.push("body LIKE ? ESCAPE '\\'");
      args.push(term);
    }
    const rows =
      types === "diary" || q.cursor?.eventsDone
        ? []
        : this.db
            .prepare(
              `SELECT * FROM events WHERE ${where.join(" AND ")} ORDER BY seq DESC LIMIT ? OFFSET ?`,
            )
            .all(...args, limit + 1, q.cursor?.beforeSeq != null ? 0 : offset)
            .map((r) => ({
              ...this.event(r, current, true),
              scene: sceneForMatch(this.db, this.agentId, r, sceneOptions),
            }));
    // Separate pagination lanes prevent diary offsets from hiding message rows.
    let diaries = [];
    const diaryCeiling = q.cursor?.diaryCeiling || now();
    const diaryOffset = num(
      q.cursor?.diaryOffset ?? q.diaryOffset,
      0,
      0,
      10000000,
    );
    if (
      types !== "event" &&
      !q.conversation &&
      !q.connectionId &&
      !q.kind &&
      !q.cursor?.diariesDone
    ) {
      const dw = ["agent_id=?"],
        da = [this.agentId];
      for (const t of terms) {
        dw.push("(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')");
        da.push(t, t);
      }
      if (q.person) {
        dw.push(
          "EXISTS (SELECT 1 FROM json_each(diaries.metadata,'$.people') WHERE value=?)",
        );
        da.push(q.person);
      }
      for (const [key, op] of [
        ["from", ">="],
        ["to", "<="],
      ])
        if (q[key]) {
          dw.push("updated_at" + op + "?");
          da.push(q[key]);
        }
      // Pin to the newest creation time on the first page; use a tuple seek so
      // inserting new diaries does not shift later pages. Revisions are live.
      dw.push("created_at<=?");
      da.push(diaryCeiling);
      if (q.cursor?.diaryBefore) {
        dw.push("(updated_at<? OR (updated_at=? AND id<?))");
        da.push(
          q.cursor.diaryBefore.time,
          q.cursor.diaryBefore.time,
          q.cursor.diaryBefore.id,
        );
      }
      diaries = this.db
        .prepare(
          `SELECT * FROM diaries WHERE ${dw.join(" AND ")} ORDER BY updated_at DESC,id DESC LIMIT ? OFFSET ?`,
        )
        .all(...da, limit + 1, q.cursor?.diaryBefore ? 0 : diaryOffset)
        .map((r) => this.diary(r, true));
    }
    const items = budget(
        rows.slice(0, limit),
        diaries.length ? Math.floor(maxChars / 2) : maxChars,
      ),
      left = maxChars - json(items).length;
    const diaryItems = budget(diaries.slice(0, limit), Math.max(0, left));
    const moreEvents = rows.length > items.length,
      moreDiaries = diaries.length > diaryItems.length;
    return {
      items,
      diaries: diaryItems,
      nextOffset: rows.length > items.length ? offset + items.length : null,
      nextDiaryOffset:
        diaries.length > diaryItems.length
          ? diaryOffset + diaryItems.length
          : null,
      nextCursor:
        moreEvents || moreDiaries
          ? {
              eventCeiling,
              beforeSeq: items.at(-1)?.seq ?? q.cursor?.beforeSeq,
              diaryCeiling,
              diaryBefore: diaryItems.length
                ? {
                    time: diaryItems.at(-1).updatedAt,
                    id: diaryItems.at(-1).id,
                  }
                : q.cursor?.diaryBefore,
              eventOffset: offset + items.length,
              diaryOffset: diaryOffset + diaryItems.length,
              eventsDone: !moreEvents,
              diariesDone: !moreDiaries,
            }
          : null,
      truncated:
        items.length < Math.min(rows.length, limit) ||
        diaryItems.length < Math.min(diaries.length, limit),
      notice:
        "Use source, participants and reply links to judge context. Neighboring messages are not necessarily one topic. You decide what is appropriate to say from your own recollections and diaries; no per-send recall approval is required.",
    };
  }
  related(q, current = "") {
    return related(this, q, current);
  }
  readRecord({ id, revision }, current = "") {
    let row = this.db
        .prepare("SELECT * FROM events WHERE agent_id=? AND id=?")
        .get(this.agentId, id),
      item;
    if (row) item = this.event(row, current);
    else {
      row = this.db
        .prepare("SELECT * FROM diaries WHERE agent_id=? AND id=?")
        .get(this.agentId, id);
      if (!row) throw Error("RECORD_NOT_FOUND");
      item = this.diary(row);
      if (revision !== undefined) {
        const r = this.db
          .prepare("SELECT * FROM diary_revisions WHERE id=? AND revision=?")
          .get(id, revision);
        if (!r) throw Error("REVISION_NOT_FOUND");
        item = {
          ...item,
          title: r.title,
          body: r.body,
          metadata: parse(r.metadata),
          revision: r.revision,
          writtenAt: r.written_at,
        };
      }
    }
    return item;
  }
  view({ id, offset = 0, maxChars = 8000, revision }, current = "") {
    num(offset, 0, 0, 10000000);
    num(maxChars, 8000, 512, 16000);
    if (revision !== undefined) num(revision, 1, 1, Number.MAX_SAFE_INTEGER);
    const item = this.readRecord({ id, revision }, current);
    const body = item.body || "";
    const latestRevision =
      item.type === "diary"
        ? this.db
            .prepare("SELECT revision FROM diaries WHERE agent_id=? AND id=?")
            .get(this.agentId, id).revision
        : undefined;
    return {
      id,
      type: item.type,
      title: item.title,
      body: body.slice(offset, offset + maxChars),
      offset,
      nextOffset: offset + maxChars < body.length ? offset + maxChars : null,
      totalChars: body.length,
      revision: item.revision,
      latestRevision,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      writtenAt: item.writtenAt,
      occurredAt: item.occurredAt,
      conversation: item.conversation,
      senderId: item.senderId,
      senderName: item.senderName,
      origin: item.origin,
    };
  }
  read({ id, offset = 0, maxChars = 8000, revision }, current = "") {
    num(offset, 0, 0, 10000000);
    num(maxChars, 8000, 512, 16000);
    const item = this.readRecord({ id, revision }, current);
    const complete = json(item),
      chunk = complete.slice(offset, offset + maxChars);
    return {
      id,
      format: "json-text-chunk",
      chunk,
      offset,
      nextOffset:
        offset + maxChars < complete.length ? offset + maxChars : null,
      totalChars: complete.length,
      disclosure: item.disclosure,
      conversation: item.conversation,
      protectedOperations: item.protectedOperations === true,
      protectedRepositories: item.protectedRepositories || [],
    };
  }
  conversation(
    {
      conversation,
      connectionId,
      aroundId,
      aroundCursor,
      contextSeconds,
      afterSeq = 0,
      beforeSeq,
      limit = 20,
      maxChars = 12000,
    },
    current = "",
  ) {
    num(limit, 20, 1, 50);
    num(maxChars, 12000, 512, 16000);
    num(afterSeq, 0, 0, Number.MAX_SAFE_INTEGER);
    if (aroundCursor && !aroundId)
      throw Error("TIMELINE_CURSOR_REQUIRES_ANCHOR");
    let rows;
    if (aroundId) {
      return around(
        this,
        { aroundId, aroundCursor, contextSeconds, limit, maxChars },
        current,
        budget,
      );
    } else if (beforeSeq !== undefined) {
      num(beforeSeq, 0, 1, Number.MAX_SAFE_INTEGER);
      rows = this.db
        .prepare(
          "SELECT * FROM events WHERE agent_id=? AND conversation=? AND (? IS NULL OR connection_id=?) AND seq<? ORDER BY seq DESC LIMIT ?",
        )
        .all(
          this.agentId,
          conversation,
          connectionId ?? null,
          connectionId ?? null,
          beforeSeq,
          limit,
        )
        .reverse();
    } else
      rows = this.db
        .prepare(
          "SELECT * FROM events WHERE agent_id=? AND conversation=? AND (? IS NULL OR connection_id=?) AND seq>? ORDER BY seq LIMIT ?",
        )
        .all(
          this.agentId,
          conversation,
          connectionId ?? null,
          connectionId ?? null,
          afterSeq,
          limit,
        );
    // A reader in its own conversation (the model) sees each outgoing text
    // once; the console reads the plain archive.
    const items = budget(
      rows.map((r) =>
        current ? this.feedEvent(r, current) : this.event(r, current, true),
      ),
      maxChars,
    );
    return {
      items,
      nextAfterSeq: items.at(-1)?.seq ?? afterSeq,
      readThroughSeq: items.at(-1)?.seq ?? afterSeq,
      markReadEligible: conversation === current,
      previousBeforeSeq: items.at(0)?.seq ?? null,
      source: rows.length ? provenance(rows[0]).source : null,
      notice:
        "Archive order only; adjacency is not a reply or causal relationship. Use memory_related for explicit replies/recalls across time.",
      truncated: items.length < rows.length,
    };
  }
  diaryWrite(
    { title, body, people = [], tags = [], evidence = [] },
    origin = "ai-diary",
    writtenIn = null,
    protectedOperations = false,
    protectedRepositories = [],
  ) {
    text(title, 300);
    text(body, 32000);
    if (!title.trim() || !body.trim()) throw Error("EMPTY_DIARY");
    const metadata = {
        ...this.metadata({ people, tags, evidence }),
        writtenIn,
        ...(protectedOperations ? { protectedOperations: true } : {}),
        ...(protectedRepositories.length
          ? { protectedRepositories: [...new Set(protectedRepositories)] }
          : {}),
      },
      id = randomUUID(),
      time = now();
    return this.store.transaction(() => {
      this.db
        .prepare("INSERT INTO diaries VALUES(?,?,?,?,?,?,?,?,?)")
        .run(
          id,
          this.agentId,
          title,
          body,
          1,
          time,
          time,
          json(metadata),
          origin,
        );
      this.db
        .prepare("INSERT INTO diary_revisions VALUES(?,?,?,?,?,?)")
        .run(id, 1, title, body, json(metadata), time);
      return { id, revision: 1 };
    });
  }
  metadata({ people = [], tags = [], evidence = [] }) {
    for (const list of [people, tags, evidence])
      if (
        !Array.isArray(list) ||
        list.length > 50 ||
        list.some((s) => typeof s !== "string" || s.length > 200)
      )
        throw Error("INVALID_METADATA");
    for (const id of evidence)
      if (
        !this.db
          .prepare(
            "SELECT id FROM events WHERE agent_id=? AND id=? UNION SELECT id FROM diaries WHERE agent_id=? AND id=?",
          )
          .get(this.agentId, id, this.agentId, id)
      )
        throw Error("EVIDENCE_NOT_OWNED");
    return { people, tags, evidence };
  }
  diaryRevise(
    { id, expectedRevision, title, body, people, tags, evidence },
    protectedOperations = false,
    protectedRepositories = [],
  ) {
    text(title, 300);
    text(body, 32000);
    if (!title.trim() || !body.trim()) throw Error("EMPTY_DIARY");
    return this.store.transaction(() => {
      const old = this.db
        .prepare("SELECT * FROM diaries WHERE id=? AND agent_id=?")
        .get(id, this.agentId);
      if (!old) throw Error("RECORD_NOT_FOUND");
      if (old.revision !== expectedRevision) throw Error("REVISION_CONFLICT");
      const previous = parse(old.metadata),
        metadata = {
          ...this.metadata({
            people: people ?? previous.people,
            tags: tags ?? previous.tags,
            evidence: evidence ?? previous.evidence,
          }),
          ...(previous.writtenIn ? { writtenIn: previous.writtenIn } : {}),
          ...(previous.protectedRepositories?.length ||
          protectedRepositories.length
            ? {
                protectedRepositories: [
                  ...new Set([
                    ...(previous.protectedRepositories || []),
                    ...protectedRepositories,
                  ]),
                ],
              }
            : {}),
          ...(previous.protectedOperations || protectedOperations
            ? { protectedOperations: true }
            : {}),
        };
      const revision = old.revision + 1,
        time = now();
      this.db
        .prepare(
          "UPDATE diaries SET title=?,body=?,revision=?,updated_at=?,metadata=? WHERE id=? AND agent_id=?",
        )
        .run(title, body, revision, time, json(metadata), id, this.agentId);
      this.db
        .prepare("INSERT INTO diary_revisions VALUES(?,?,?,?,?,?)")
        .run(id, revision, title, body, json(metadata), time);
      return { id, revision };
    });
  }
  reserveDelivery(requestId, conversation, payload) {
    text(requestId, 200);
    if (!requestId) throw Error("REQUEST_ID_REQUIRED");
    const digest = hash(json(payload)),
      time = now();
    this.db
      .prepare("INSERT OR IGNORE INTO deliveries VALUES(?,?,?,?,?,?,?,?)")
      .run(
        this.agentId,
        requestId,
        conversation,
        digest,
        "pending",
        null,
        time,
        time,
      );
    const row = this.db
      .prepare("SELECT * FROM deliveries WHERE agent_id=? AND request_id=?")
      .get(this.agentId, requestId);
    if (row.payload_hash !== digest || row.conversation !== conversation)
      throw Error("IDEMPOTENCY_CONFLICT");
    return row;
  }
  delivery(requestId) {
    return this.db
      .prepare("SELECT * FROM deliveries WHERE agent_id=? AND request_id=?")
      .get(this.agentId, requestId);
  }
  completeDelivery(requestId, status, messageId = null) {
    this.db
      .prepare(
        "UPDATE deliveries SET status=?,message_id=?,updated_at=? WHERE agent_id=? AND request_id=?",
      )
      .run(status, messageId, now(), this.agentId, requestId);
  }
  unresolvedDeliveryCount() {
    return this.db
      .prepare(
        "SELECT count(*) AS total FROM deliveries WHERE agent_id=? AND status='unknown'",
      )
      .get(this.agentId).total;
  }
  unresolvedDeliveries({ offset = 0, limit = 20 } = {}) {
    const items = this.db
      .prepare(
        "SELECT d.request_id AS requestId,d.conversation,d.created_at AS createdAt,d.updated_at AS updatedAt,substr(e.body,1,200) AS preview,json_extract(e.payload,'$.mediaId') AS mediaId FROM deliveries d LEFT JOIN events e ON e.agent_id=d.agent_id AND e.dedupe='send:'||d.request_id||':pending' WHERE d.agent_id=? AND d.status='unknown' ORDER BY d.updated_at DESC,d.request_id LIMIT ? OFFSET ?",
      )
      .all(this.agentId, limit, offset);
    return { total: this.unresolvedDeliveryCount(), offset, items };
  }
  // Administrator verdict on an unknown receipt. Settled receipts never change,
  // and neither verdict resends: the same requestId stays fenced afterwards.
  reconcileDelivery(
    requestId,
    resolution,
    { by = "administrator", messageId = null } = {},
  ) {
    return this.store.transaction(() => {
      const row = this.delivery(requestId);
      if (!row) throw Error("DELIVERY_NOT_FOUND");
      if (row.status !== "unknown") throw Error("DELIVERY_ALREADY_SETTLED");
      this.completeDelivery(requestId, resolution, messageId);
      const attempt = this.db
        .prepare(
          "SELECT connection_id,sender_id,body,payload FROM events WHERE agent_id=? AND dedupe=?",
        )
        .get(this.agentId, "send:" + requestId + ":pending");
      this.append({
        dedupe: "send:" + requestId + ":reconciled",
        connectionId: attempt?.connection_id || "",
        conversation: row.conversation,
        senderId: attempt?.sender_id ?? null,
        kind: "message.send-result",
        direction: "out",
        status: resolution === "sent" ? "confirmed" : "failed",
        body: attempt?.body || "",
        // Inherit the attempt's payload so repository/operations protection
        // follows the copied body, as the delivery's own send-result does.
        payload: {
          ...(attempt ? parse(attempt.payload) : {}),
          requestId,
          reconciledBy: by,
          previousStatus: "unknown",
          resolution,
          ...(messageId ? { messageId } : {}),
        },
      });
      return { requestId, status: resolution };
    });
  }
  // QQ's own copy of a send the gateway could not confirm settles it: same
  // conversation, the same text, within ten minutes, and only one candidate.
  // An image-only send has no text to match and stays for the administrator.
  reconcileFromEcho({ conversation, text, messageId }) {
    const squash = (s) => String(s || "").replace(/\s+/g, "");
    const want = squash(text);
    if (!want || !messageId) return null;
    // A replayed echo is one QQ message, not a new one: it must not settle a
    // later send with the same text. Skip a message id already archived
    // here or already given to a delivery.
    const id = String(messageId);
    if (
      this.db
        .prepare(
          "SELECT 1 FROM events WHERE agent_id=? AND conversation=? AND message_id=? UNION ALL SELECT 1 FROM deliveries WHERE agent_id=? AND conversation=? AND message_id=? LIMIT 1",
        )
        .get(this.agentId, conversation, id, this.agentId, conversation, id)
    )
      return null;
    const since = new Date(Date.now() - 10 * 60000).toISOString();
    const candidates = this.db
      .prepare(
        "SELECT d.request_id AS requestId, e.body FROM deliveries d JOIN events e ON e.agent_id=d.agent_id AND e.dedupe='send:' || d.request_id || ':pending' WHERE d.agent_id=? AND d.conversation=? AND d.status='unknown' AND d.created_at>=?",
      )
      .all(this.agentId, conversation, since)
      .filter((row) => squash(row.body) === want);
    if (candidates.length !== 1) return null;
    return this.reconcileDelivery(candidates[0].requestId, "sent", {
      by: "gateway-echo",
      messageId: id,
    });
  }
  state(conversation) {
    const row = this.db
      .prepare("SELECT value FROM runtime WHERE agent_id=? AND conversation=?")
      .get(this.agentId, conversation);
    const value = row ? parse(row.value) : { readThroughSeq: 0, paused: false };
    return isConversation(conversation) ? readConversationState(value) : value;
  }
  setState(conversation, value) {
    this.db
      .prepare("INSERT OR REPLACE INTO runtime VALUES(?,?,?)")
      .run(
        this.agentId,
        conversation,
        json(
          isConversation(conversation) ? writeConversationState(value) : value,
        ),
      );
  }
  export() {
    const tables = {};
    // Restore reassigns seq in export order; keep it ascending so equal-time order survives.
    for (const name of [
      "events",
      "diaries",
      "people",
      "deliveries",
      "runtime",
      "migrations",
      "self_versions",
      "self_candidates",
      "intentions",
      "work_notes",
      "model_turns",
      "session_history",
      "message_progress",
      "message_aliases",
      "message_observations",
      "person_notes",
      "moods",
    ])
      tables[name] = this.db
        .prepare(
          `SELECT * FROM ${name} WHERE agent_id=?${name === "events" ? " ORDER BY seq" : name === "moods" ? " ORDER BY rowid" : ""}`,
        )
        .all(this.agentId);
    tables.diary_revisions = this.db
      .prepare(
        "SELECT r.* FROM diary_revisions r JOIN diaries d ON d.id=r.id WHERE d.agent_id=?",
      )
      .all(this.agentId);
    return { version: 1, agentId: this.agentId, exportedAt: now(), tables };
  }
}
